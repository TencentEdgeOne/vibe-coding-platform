import {
  FILE_TREE_IGNORED_DIRECTORIES,
  isIgnoredFileTreePath,
  PREVIEW_BINARY_EXTENSIONS,
  PREVIEW_BATCH_MAX_BYTES,
  PREVIEW_MAX_BYTES,
} from '../_constants.ts';
import type { FileTreeItem, ProjectState } from '../_types.ts';
import {
  capBatchReadResults,
  truncateUtf8,
  type PreviewReadResult,
} from '../utils/_file-preview.ts';
import { readFileExtension } from '../utils/_paths.ts';
import { runSandboxCommand } from './_commands.ts';
import { repairNestedAppDirLayout } from './_scaffold.ts';

export async function getFileTree(context: any, state: ProjectState): Promise<FileTreeItem[]> {
  // Heal sessions that still have the mistaken appDir/appDir/... layout before
  // listing, so the Files panel shows package.json at the root.
  await repairNestedAppDirLayout(context, state);

  const ignoredDirectoryPruneExpression = FILE_TREE_IGNORED_DIRECTORIES
    .map((dir) => `-path './${dir}'`)
    .join(' -o ');
  const findExpression = `find . \\( ${ignoredDirectoryPruneExpression} \\) -prune -o -maxdepth 4`;
  // A single `find -printf` yields type, mtime and size together, which lets the
  // frontend cache file contents and skip the /file round trip while they are
  // unchanged. Busybox find has no -printf, so fall back to the portable loop and
  // emit the same four columns with zeroed metadata (the frontend then refetches
  // on every click, i.e. the previous behaviour).
  const result = await runSandboxCommand(
    context,
    [
      `{ ${findExpression} -printf '%y\\t%T@\\t%s\\t%p\\n' 2>/dev/null; }`,
      '||',
      `{ ${findExpression} -print | while IFS= read -r path; do`,
      'if [ -d "$path" ]; then printf \'d\\t0\\t0\\t%s\\n\' "$path";',
      'else printf \'f\\t0\\t0\\t%s\\n\' "$path"; fi;',
      'done; }',
    ].join(' '),
    {
      cwd: state.appDir,
      timeout: 30,
    },
  );

  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || 'Failed to read the file list.');
  }

  return result.stdout
    .split('\n')
    .map((line: string) => line.trimEnd())
    .map((line: string) => {
      const [kind = '', mtimeRaw = '', sizeRaw = '', ...pathParts] = line.split('\t');
      return {
        kind,
        mtimeRaw,
        sizeRaw,
        rawPath: pathParts.join('\t'),
      };
    })
    .filter((item) => (
      item.rawPath
      && item.rawPath !== '.'
      // 'l' (symlink) is listed as a file so a linked source file stays visible.
      && (item.kind === 'f' || item.kind === 'l' || item.kind === 'd')
    ))
    .filter((item) => !isIgnoredFileTreePath(item.rawPath))
    .slice(0, 220)
    .map((item) => {
      const path = item.rawPath.replace(/^\.\//, '');
      const name = path.split('/').pop() || path;
      // %T@ is fractional epoch seconds; keep milliseconds so a same-second
      // rewrite still invalidates the frontend cache.
      const mtimeSeconds = Number.parseFloat(item.mtimeRaw);
      const size = Number.parseInt(item.sizeRaw, 10);
      return {
        path,
        name,
        type: (item.kind === 'd' ? 'directory' : 'file') as 'file' | 'directory',
        depth: path.split('/').length - 1,
        ...(Number.isFinite(mtimeSeconds) && mtimeSeconds > 0
          ? { mtime: Math.round(mtimeSeconds * 1000) }
          : {}),
        ...(Number.isFinite(size) && size > 0 ? { size } : {}),
      };
    });
}

export type FileReadResult = PreviewReadResult;

/**
 * The sandbox files a directory read under SANDBOX_UNKNOWN_ERROR, its catch-all,
 * even though the message underneath names the cause exactly. Passed along as-is
 * it reads as an unknown failure with an instance id attached, and says nothing
 * about the one move that works: list the path instead of reading it.
 */
function describeReadFailure(message: string): string {
  if (/not[\s_-]*found|no such file|does not exist/i.test(message)) {
    return 'File does not exist.';
  }
  if (/\bis a directory\b|\bEISDIR\b/i.test(message)) {
    return 'That path is a directory, not a file. List it to see what it holds.';
  }
  return message;
}

export async function readFileFromSandbox(
  context: any,
  state: ProjectState,
  relPath: string,
): Promise<FileReadResult> {
  const ext = readFileExtension(relPath);
  if (ext && PREVIEW_BINARY_EXTENSIONS.has(ext)) {
    return { ok: false, error: `Binary files cannot be previewed (${ext}).` };
  }

  let content: string;
  try {
    const result = await context.sandbox.files.read(`${state.appDir}/${relPath}`);
    if (typeof result === 'string') {
      content = result;
    } else if (result instanceof Uint8Array) {
      content = new TextDecoder().decode(result);
    } else if (result instanceof ArrayBuffer) {
      content = new TextDecoder().decode(new Uint8Array(result));
    } else if (
      result
      && typeof result === 'object'
      && typeof (result as { content?: unknown }).content === 'string'
    ) {
      // Keep compatibility with runtimes that wrap the file body.
      content = (result as { content: string }).content;
    } else {
      return { ok: false, error: 'Unexpected sandbox file read result.' };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Read failed.';
    return { ok: false, error: describeReadFailure(message) };
  }

  const truncatedFile = truncateUtf8(content, PREVIEW_MAX_BYTES);
  content = truncatedFile.content;
  const { size, truncated } = truncatedFile;

  // Binary fallback: treat the file as binary if the first 4KB contains many
  // non-printable control characters.
  const sample = content.slice(0, 4096);
  let nonPrintable = 0;
  for (let i = 0; i < sample.length; i += 1) {
    const code = sample.charCodeAt(i);
    if (code === 9 || code === 10 || code === 13) continue;
    if (code < 32 || code === 127) nonPrintable += 1;
  }
  if (sample.length > 0 && nonPrintable / sample.length > 0.1) {
    return { ok: false, error: 'The file appears to be binary, so preview was refused.' };
  }

  return { ok: true, content, size, truncated };
}

export async function readFilesFromSandbox(
  context: any,
  state: ProjectState,
  paths: string[],
): Promise<Array<FileReadResult & { path: string }>> {
  const results = await Promise.all(paths.map(async (path) => ({
    path,
    ...await readFileFromSandbox(context, state, path),
  })));
  return capBatchReadResults(results, PREVIEW_BATCH_MAX_BYTES);
}
