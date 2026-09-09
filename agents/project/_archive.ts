import {
  ARCHIVE_EXCLUDED_DIRECTORIES,
  DOWNLOAD_ARCHIVE_MAX_BYTES,
} from '../_constants.ts';
import type { LegacyProjectSnapshot, ProjectState } from '../_types.ts';
import { safeSegment } from '../utils/_paths.ts';
import { runSandboxCommand } from './_commands.ts';
import { assertResettableProjectPath } from './_state.ts';
import { shellQuote } from '../../shared/shell.ts';

type ProjectArchiveResult =
  | {
      // base64, because the Makers proxy only transports text reliably.
      ok: true;
      base64: string;
      filename: string;
      contentType: string;
      size: number;
    }
  | { ok: false; error: string };

// Decoded byte length of a newline-free base64 string, without decoding it.
function base64ByteLength(base64: string): number {
  if (!base64) return 0;
  let padding = 0;
  if (base64.endsWith('==')) padding = 2;
  else if (base64.endsWith('=')) padding = 1;
  return Math.floor((base64.length * 3) / 4) - padding;
}

// Validate the base64 archive by size + magic bytes, without a full decode.
function isArchiveBase64Valid(
  base64: string,
  expectedSize: number,
  format: 'zip' | 'tar.gz',
): boolean {
  if (expectedSize === 0 || base64ByteLength(base64) !== expectedSize) {
    return false;
  }
  const head = Buffer.from(base64.slice(0, 4), 'base64');
  if (head.length < 2) return false;
  if (format === 'zip') {
    return head[0] === 0x50 && head[1] === 0x4b;
  }
  return head[0] === 0x1f && head[1] === 0x8b;
}

// Zip state.appDir inside the sandbox and return it base64-encoded. files.read
// is UTF-8 only and corrupts binary, so the bytes are read out via `base64`.
export async function createProjectArchive(
  context: any,
  state: ProjectState,
): Promise<ProjectArchiveResult> {
  const sandbox = context.sandbox;

  const appDirExists = await sandbox.files.exists(state.appDir);
  if (!appDirExists) {
    return { ok: false, error: 'Project workspace not found. Generate a project first.' };
  }

  // Archive into /tmp, outside the directory being zipped.
  const sessionSlug = safeSegment(state.sessionDir.replace(/^projects\//, '')) || 'project';
  const archiveBase = `/tmp/eo-download-${sessionSlug}`;

  // Exclude both "dir" and "./dir" forms since zip/tar differ on the "./".
  const zipExcludes = ARCHIVE_EXCLUDED_DIRECTORIES
    .flatMap((dir) => [
      `-x ${shellQuote(`${dir}/*`)} ${shellQuote(dir)}`,
      `-x ${shellQuote(`./${dir}/*`)} ${shellQuote(`./${dir}`)}`,
    ])
    .join(' ');
  const tarExcludes = ARCHIVE_EXCLUDED_DIRECTORIES
    .map((dir) => `--exclude=${shellQuote(`./${dir}`)} --exclude=${shellQuote(dir)}`)
    .join(' ');
  const zipPath = `${archiveBase}.zip`;
  const tarPath = `${archiveBase}.tar.gz`;

  // Mirror the excludes so the empty-check reflects what gets archived (else
  // zip exits 12 "nothing to do" when only excluded dirs exist).
  const findIgnoreExpr = ARCHIVE_EXCLUDED_DIRECTORIES
    .map((dir) => `! -name ${shellQuote(dir)}`)
    .join(' ');

  // Prefer zip, else tar.gz. Emits a "FORMAT<TAB>SIZE<TAB>PATH" marker line, or
  // "__EMPTY__" when nothing to pack. zip -y stores symlinks as links instead
  // of following the preview server's self-referential `preview -> .` symlink
  // (which would recurse forever); tar already doesn't follow symlinks.
  const buildScript = [
    'set -e;',
    `rm -f ${shellQuote(zipPath)} ${shellQuote(tarPath)};`,
    `if [ -z "$(find . -mindepth 1 -maxdepth 1 ${findIgnoreExpr} -print -quit)" ]; then echo "__EMPTY__"; exit 0; fi;`,
    'if command -v zip >/dev/null 2>&1; then',
    `  zip -r -y -q ${shellQuote(zipPath)} . ${zipExcludes};`,
    `  printf 'zip\\t%s\\t%s\\n' "$(wc -c < ${shellQuote(zipPath)} | tr -d ' ')" ${shellQuote(zipPath)};`,
    'else',
    `  tar -czf ${shellQuote(tarPath)} ${tarExcludes} .;`,
    `  printf 'tar.gz\\t%s\\t%s\\n' "$(wc -c < ${shellQuote(tarPath)} | tr -d ' ')" ${shellQuote(tarPath)};`,
    'fi',
  ].join(' ');

  const built = await runSandboxCommand(context, buildScript, {
    cwd: state.appDir,
    timeout: 120,
  });
  if (built.exitCode !== 0) {
    return { ok: false, error: built.stderr || built.stdout || 'Failed to package the project.' };
  }

  const marker = String(built.stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .pop() || '';

  if (marker === '__EMPTY__') {
    return { ok: false, error: 'The project workspace is empty; nothing to download yet.' };
  }

  const [formatRaw, sizeRaw, archivePath] = marker.split('\t');
  const format = formatRaw === 'tar.gz' ? 'tar.gz' : 'zip';
  const expectedSize = Number(sizeRaw) || 0;
  if (!archivePath || expectedSize <= 0) {
    return { ok: false, error: 'Failed to determine the packaged archive size.' };
  }
  if (expectedSize > DOWNLOAD_ARCHIVE_MAX_BYTES) {
    const mb = Math.round(DOWNLOAD_ARCHIVE_MAX_BYTES / (1024 * 1024));
    return {
      ok: false,
      error: `The packaged project exceeds the ${mb}MB download limit. Remove large assets and try again.`,
    };
  }

  const filename = `source.${format === 'tar.gz' ? 'tar.gz' : 'zip'}`;
  const contentType = format === 'tar.gz' ? 'application/gzip' : 'application/zip';

  // Remove the temp archive once read, so /tmp does not accumulate files.
  const cleanupArchive = async () => {
    try {
      await runSandboxCommand(context, `rm -f ${shellQuote(archivePath)}`, { timeout: 15 });
    } catch {
      // Non-fatal.
    }
  };

  // Read the bytes out as base64 (tr strips newlines for BSD/busybox base64).
  const encoded = await runSandboxCommand(
    context,
    `base64 ${shellQuote(archivePath)} | tr -d '\\n'`,
    { cwd: state.appDir, timeout: 120 },
  );
  if (encoded.exitCode !== 0) {
    return { ok: false, error: encoded.stderr || encoded.stdout || 'Failed to read the packaged archive.' };
  }

  const base64 = String(encoded.stdout || '').replace(/\s+/g, '');
  if (!base64) {
    return { ok: false, error: 'The packaged archive could not be read from the sandbox.' };
  }

  if (!isArchiveBase64Valid(base64, expectedSize, format)) {
    return { ok: false, error: 'The packaged archive failed integrity validation.' };
  }

  await cleanupArchive();
  return {
    ok: true,
    base64,
    filename,
    contentType,
    size: expectedSize,
  };
}

// Inverse of createProjectArchive: restore a persisted base64 archive back into
// the (empty/recycled) sandbox appDir, then reinstall dependencies. Used when the
// sandbox no longer has the code but a snapshot exists in the store (agents/
// _memory.ts). Binary must be produced inside the sandbox via `base64 -d` — the
// sandbox files.write API is UTF-8 only — so we write the base64 as text and
// decode + extract with shell, mirroring createProjectArchive's packing path.
export async function restoreProjectArchive(
  context: any,
  state: ProjectState,
  snapshot: LegacyProjectSnapshot,
  options: { installDependencies?: boolean } = {},
): Promise<{ ok: boolean; error?: string }> {
  if (!snapshot?.base64) {
    return { ok: false, error: 'Snapshot is empty; nothing to restore.' };
  }
  assertResettableProjectPath(state);

  const sandbox = context.sandbox;
  await sandbox.files.makeDir(state.sessionDir);
  await sandbox.files.makeDir(state.appDir);

  const format = snapshot.filename.endsWith('.tar.gz') || snapshot.contentType === 'application/gzip'
    ? 'tar.gz'
    : 'zip';
  const sessionSlug = safeSegment(state.sessionDir.replace(/^projects\//, '')) || 'project';
  const b64Path = `/tmp/eo-restore-${sessionSlug}.b64`;
  const archivePath = `/tmp/eo-restore-${sessionSlug}.${format === 'tar.gz' ? 'tar.gz' : 'zip'}`;

  // Write the base64 as a UTF-8 temp file, then decode to binary and extract into
  // appDir. zip entries were packed relatively from appDir, so extraction targets appDir.
  await sandbox.files.write(b64Path, snapshot.base64);

  const extractCmd = format === 'tar.gz'
    ? `tar -xzf ${shellQuote(archivePath)} -C ${shellQuote(state.appDir)}`
    : `unzip -o -q ${shellQuote(archivePath)} -d ${shellQuote(state.appDir)}`;

  const restoreScript = [
    'set -e;',
    `base64 -d ${shellQuote(b64Path)} > ${shellQuote(archivePath)};`,
    `${extractCmd};`,
    `rm -f ${shellQuote(b64Path)} ${shellQuote(archivePath)};`,
  ].join(' ');

  const restored = await runSandboxCommand(context, restoreScript, { timeout: 120 });
  if (restored.exitCode !== 0) {
    // Best-effort cleanup of the temp files on failure.
    try {
      await runSandboxCommand(context, `rm -f ${shellQuote(b64Path)} ${shellQuote(archivePath)}`, { timeout: 15 });
    } catch {
      // Non-fatal.
    }
    return { ok: false, error: restored.stderr || restored.stdout || 'Failed to restore the project from snapshot.' };
  }

  // Reinstall dependencies (the snapshot excludes node_modules). Skipped on
  // resume-after-stop (files-only); chat turns keep the default install so the
  // agent can build/preview immediately.
  const shouldInstall = options.installDependencies !== false;
  if (shouldInstall) {
    const hasPackageJson = await sandbox.files.exists(`${state.appDir}/package.json`);
    if (hasPackageJson) {
      try {
        await runSandboxCommand(context, 'npm install --no-audit --no-fund', {
          cwd: state.appDir,
          timeout: 300,
        });
      } catch {
        // Non-fatal — see comment above.
      }
    }
  }

  return { ok: true };
}
