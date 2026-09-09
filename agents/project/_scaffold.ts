import type { BuildResult, BuildStatus, ProjectState, ScaffoldLog } from '../_types.ts';
import { detectFatalToolError } from '../utils/_text.ts';
import { runCommandCapturingExit, runSandboxCommand } from './_commands.ts';
import { loadMakersFrameworkProfiles, runMakersCompatibilityCheck } from './_makers-compat.ts';
import { withFrameworkAdapter } from './_makers-declarations.ts';
import { applyProjectTemplate, listProjectTemplates, resolveProjectTemplate } from './_templates.ts';
import type { AppliedTemplate } from './_templates.ts';
import { shellQuote } from '../../shared/shell.ts';

// Models used to pass `${appDir}/file` into write_project_file, which joined
// appDir again and created appDir/appDir/... . Lift that nested tree back to
// the real project root when we detect the classic nesting marker.
export async function repairNestedAppDirLayout(
  context: any,
  state: ProjectState,
  onLog?: (log: ScaffoldLog) => void,
): Promise<boolean> {
  const nestedRel = state.appDir;
  // Probe before running the repair, even though the script's first line is the
  // same test. The probe is not what this costs — running the script is, on
  // every turn, for a legacy bug that almost no project has. Skipping the probe
  // to save a round trip put a command that had barely ever run in production
  // in front of the first tool of every conversation.
  try {
    if (!(await context.sandbox.files.exists(`${state.appDir}/${nestedRel}`))) {
      return false;
    }
  } catch {
    return false;
  }

  let result;
  try {
    result = await runSandboxCommand(
      context,
      [
        'set -e',
        `NESTED=${shellQuote(nestedRel)}`,
        'if [ ! -d "$NESTED" ]; then exit 0; fi',
        // Classic bug shape: real project under appDir/appDir, root missing package.json.
        'if [ ! -f "$NESTED/package.json" ] && [ ! -f "$NESTED/index.html" ]; then exit 0; fi',
        'if [ -f ./package.json ]; then exit 0; fi',
        'for item in "$NESTED"/*; do',
        '  [ -e "$item" ] || continue',
        '  name=$(basename "$item")',
        '  [ "$name" = "projects" ] && continue',
        '  rm -rf "./$name"',
        '  mv "$item" "./$name"',
        'done',
        'rm -rf ./projects',
        'echo REPAIRED',
      ].join('\n'),
      {
        cwd: state.appDir,
        timeout: 60,
      },
    );
  } catch {
    // The sandbox raises on a failed command instead of returning its exit
    // code, so the check below never sees one and this is the only place a
    // failure can be absorbed. Absorbing it is the point: repairing a layout
    // almost no project has must not cost a turn to every project that does
    // not, and the scaffold that follows reports anything genuinely wrong.
    return false;
  }

  if (result.exitCode !== 0) {
    return false;
  }

  const repaired = result.stdout.includes('REPAIRED');
  if (repaired) {
    onLog?.({
      stream: 'status',
      content: 'Fixed nested project paths and restored files to the workspace root.',
    });
  }
  return repaired;
}

/**
 * What the workspace probe answers, beyond "is anything here".
 *
 * Whether the dependencies are installed is the second question, and it used to
 * have no answer at all: the listing prunes node_modules, because a populated
 * tree is hundreds of thousands of paths, and nothing else reported it. So a
 * workspace that arrived with its dependencies already installed looked
 * identical to one that did not, and the model did the only safe-looking thing
 * and ran `npm install` — which on a 1.1G sandbox does not fit beside a tree
 * that is already there. One session spent four minutes that way: the install
 * filled the disk, died halfway, took the working tree with it, and ended with
 * the project less runnable than when it started.
 */
export type ScaffoldOutcome = {
  created: boolean;
  dependenciesInstalled: boolean;
  /** Present only when this call filled an empty workspace from a baked tree. */
  template?: AppliedTemplate;
  /**
   * The baked tree ids, carried back only when this call left the workspace
   * empty. The miss is worth reporting because the caller cannot see it: an
   * empty workspace and an empty workspace that could have been a baked chat
   * agent read identically from the outside, and the model reads the first one
   * as licence to write the tree by hand.
   */
  available?: readonly string[];
};

export type ScaffoldOptions = {
  /**
   * The framework the request named, if it named one. Only ever a hint: an
   * unknown name, a framework with no baked template, and an omitted value all
   * leave the workspace empty for the scaffolder path to fill.
   */
  framework?: string;
};

const DEPENDENCIES_INSTALLED = 'DEPENDENCIES_INSTALLED';

export async function ensureProjectScaffold(
  context: any,
  state: ProjectState,
  onLog?: (log: ScaffoldLog) => void,
  options: ScaffoldOptions = {},
): Promise<ScaffoldOutcome> {
  const sandbox = context.sandbox;
  onLog?.({ stream: 'status', content: `Preparing the project workspace ${state.appDir}` });

  // appDir is sessionDir plus one segment and the create is recursive, so the
  // second call only ever remade a directory the first had already made.
  await sandbox.files.makeDir(state.appDir);

  await repairNestedAppDirLayout(context, state, onLog);

  const existing = await runSandboxCommand(
    context,
    [
      // .bin is the tell, not node_modules itself: an install that died partway
      // leaves the directory standing with its executables gone, which is the
      // state that has to read as "not installed" so the retry happens.
      `if [ -n "$(ls -A node_modules/.bin 2>/dev/null)" ]; then echo ${DEPENDENCIES_INSTALLED}; fi`,
      [
        'find . -mindepth 1 -maxdepth 2',
        "\\( -path './node_modules' -o -path './.next' -o -path './.git' -o -path './dist' -o -path './build' \\) -prune",
        '-o -print',
      ].join(' '),
    ].join('\n'),
    {
      cwd: state.appDir,
      timeout: 60,
    },
  );
  if (existing.exitCode !== 0) {
    throw new Error(existing.stderr || existing.stdout || 'Workspace inspection failed.');
  }
  const lines = existing.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  const dependenciesInstalled = lines.includes(DEPENDENCIES_INSTALLED);
  const files = lines.filter((line) => line !== DEPENDENCIES_INSTALLED);

  // One conversation_id maps to one long-lived project. Reuse existing business
  // files without overwriting them.
  if (files.length) {
    onLog?.({
      stream: 'status',
      content: dependenciesInstalled
        ? 'Existing project workspace detected, dependencies already installed; skipping initialization.'
        : 'Existing project workspace detected; skipping initialization.',
    });
    return { created: false, dependenciesInstalled };
  }

  const { template, available } = await applyTemplateIfBaked(
    context,
    state,
    options.framework,
    onLog,
  );
  if (template) {
    return { created: true, dependenciesInstalled, template };
  }

  onLog?.({ stream: 'status', content: 'Prepared an empty project workspace. Waiting for the agent to generate project files.' });

  return {
    created: true,
    dependenciesInstalled,
    ...(available?.length ? { available } : {}),
  };
}

/**
 * Fill the empty workspace from a baked tree, or leave it empty.
 *
 * Best effort in every direction, because the scaffolder path it replaces is
 * still there: a framework nobody baked, a manifest that will not parse, a
 * sandbox that refuses the write — each of them returns nothing, and the run
 * goes on to load the reference and run the scaffolder exactly as before. The
 * one thing this must not do is fail the first tool call of the conversation
 * for an optimisation.
 */
async function applyTemplateIfBaked(
  context: any,
  state: ProjectState,
  framework: string | undefined,
  onLog?: (log: ScaffoldLog) => void,
): Promise<{ template?: AppliedTemplate; available?: readonly string[] }> {
  try {
    const template = await resolveProjectTemplate(framework);
    if (!template) {
      // Said out loud, and said differently for the three causes. A framework
      // nobody baked is the expected miss. A build holding no baked trees at
      // all is a packaging fault — it went unnoticed through every deployed
      // conversation because falling back to the scaffolder looks like the
      // model choosing to, and nothing here disagreed with that reading.
      //
      // The third is a request that names no framework: it arrives with nothing
      // to resolve, and the log used to be gated on having a name to print, so
      // the miss went out silent. The alias table in ./_templates.ts records
      // what that silence cost.
      const baked = await listProjectTemplates();
      const available = baked.map((item) => item.id);
      onLog?.({
        stream: 'status',
        content: available.length === 0
          ? `This build carries no baked templates, so ${framework?.trim() || 'this project'} falls back to its own scaffolder.`
          : framework?.trim()
            ? `No baked template for ${framework}; using its own scaffolder.`
            : `The request named no framework, so no baked template was applied. Baked: ${available.join(', ')}.`,
      });
      return { available };
    }
    const profiles = await loadMakersFrameworkProfiles();

    const applied = await applyProjectTemplate(context, state, template, {
      onLog,
      // The adapter injection is hooked to write_project_file, and a template's
      // package.json does not come through it. Without this, a framework whose
      // platform adapter is unconditional would reach the preview gate missing
      // the one dependency the install about to start could have picked up.
      adaptPackageJson: (content) => withFrameworkAdapter(
        { status: 'present', content },
        profiles,
      ),
    });

    return { template: applied };
  } catch (error) {
    onLog?.({
      stream: 'status',
      content: `Could not use the baked ${framework?.trim() || 'project'} template (${
        error instanceof Error ? error.message : String(error)
      }); falling back to the framework's own scaffolder.`,
    });
    return {};
  }
}

/**
 * What the production build is still for once a preview has come up.
 *
 * The dev server compiles the project and the smoke gates exercise its routes,
 * so a healthy preview already answers "does this code run". What it does not
 * answer is "does the production build succeed" — prerendering, static
 * generation and bundling only happen there. Paying up to ten minutes for that
 * answer on every turn is what made iteration slow, and it is not the last
 * chance to get it: `edgeone makers deploy` runs the real build, and a failure
 * there comes back as a failed deployment carrying the CLI's own log.
 *
 * So the build stays a gate and stops being a toll. It runs when the preview
 * did not run or did not come up, which is exactly when nothing else has shown
 * that the project assembles.
 */
export type VerificationOptions = {
  previewVerified?: boolean;
};

/**
 * The build command a project declares in `edgeone.json`, if any.
 *
 * Read rather than inferred: for a generator there is no manifest to infer it
 * from, and this is the same value the deployment will run. A command spanning
 * lines is refused instead of run — nothing legitimate needs one, and the value
 * reaches a shell.
 */
async function readDeclaredBuildCommand(context: any, state: ProjectState) {
  const probe = await runSandboxCommand(
    context,
    'node -e "try { const c=require(\'./edgeone.json\'); process.stdout.write(typeof c.buildCommand === \'string\' ? c.buildCommand : \'\'); } catch (e) { process.stdout.write(\'\'); }"',
    { cwd: state.appDir, timeout: 30 },
  );
  if (probe.exitCode !== 0) return '';
  const declared = (probe.stdout || '').trim();
  return declared.includes('\n') ? '' : declared;
}

export const PRODUCTION_BUILD_DEFERRED =
  'Skipped the production build: the preview server compiled this project and passed its smoke tests in this turn, which is the same evidence the build would produce for everything except bundling and prerendering. Publishing runs the real build and reports any production-only failure with its own log.';

export async function runVerification(
  context: any,
  state: ProjectState,
  options: VerificationOptions = {},
): Promise<BuildResult> {
  try {
    const compatibility = await runMakersCompatibilityCheck(context, state);
    if (compatibility.exitCode !== 0) {
      return {
        status: 'failed',
        stdout: compatibility.stdout,
        stderr: [
          'Makers compatibility check failed.',
          compatibility.stderr || compatibility.stdout,
        ].filter(Boolean).join('\n'),
      };
    }
    const withCompatibilityOutput = (stdout = '') => (
      [compatibility.stdout.trim(), stdout.trim()].filter(Boolean).join('\n')
    );

    const packageExists = await context.sandbox.files.exists(`${state.appDir}/package.json`);
    if (packageExists) {
      const hasBuildScript = await runSandboxCommand(
        context,
        'node -e "try { const p=require(\'./package.json\'); process.stdout.write((p.scripts && p.scripts.build) ? \'yes\' : \'no\'); } catch (e) { process.stdout.write(\'error\'); }"',
        {
          cwd: state.appDir,
          timeout: 30,
        },
      );

      if (hasBuildScript.exitCode !== 0) {
        return {
          status: 'failed',
          stdout: withCompatibilityOutput(hasBuildScript.stdout),
          stderr: hasBuildScript.stderr || 'Failed to read package.json; unable to determine whether a build script exists.',
        };
      }

      const buildFlag = hasBuildScript.stdout.trim();
      if (buildFlag === 'error') {
        return {
          status: 'failed',
          stdout: withCompatibilityOutput(hasBuildScript.stdout),
          stderr: 'Failed to parse package.json; unable to determine whether a build script exists.',
        };
      }

      if (buildFlag === 'yes') {
        if (options.previewVerified) {
          return {
            status: 'success',
            stdout: withCompatibilityOutput(PRODUCTION_BUILD_DEFERRED),
          };
        }
        const result = await runCommandCapturingExit(context, 'npm run build', {
          cwd: state.appDir,
          timeout: 600,
        });

        return {
          status: result.exitCode === 0 ? ('success' as BuildStatus) : ('failed' as BuildStatus),
          stdout: withCompatibilityOutput(result.stdout),
          stderr: result.stderr,
        };
      }

      if (buildFlag !== 'no') {
        return {
          status: 'failed',
          stdout: withCompatibilityOutput(hasBuildScript.stdout),
          stderr: hasBuildScript.stderr || 'Failed to parse package.json; unable to determine whether a build script exists.',
        };
      }
    }

    // A site generator has no npm build script and often no package.json at
    // all — Hugo is a Go binary, Jekyll a Ruby one — so it declares its build in
    // edgeone.json instead. Without this branch such a project reached the end
    // of verification with nothing checked and passed for having nothing to
    // check, which is the one shape where a green turn meant least.
    const declaredBuild = await readDeclaredBuildCommand(context, state);
    if (declaredBuild) {
      if (options.previewVerified) {
        return {
          status: 'success',
          stdout: withCompatibilityOutput(PRODUCTION_BUILD_DEFERRED),
        };
      }
      const result = await runCommandCapturingExit(context, declaredBuild, {
        cwd: state.appDir,
        timeout: 600,
      });

      return {
        status: result.exitCode === 0 ? ('success' as BuildStatus) : ('failed' as BuildStatus),
        stdout: withCompatibilityOutput(result.stdout),
        stderr: result.stderr,
      };
    }

    const pythonFiles = await runSandboxCommand(
      context,
      [
        'find .',
        "\\( -path './node_modules' -o -path './.next' -o -path './.git' -o -path './dist' -o -path './build' -o -path './.venv' -o -path './venv' \\) -prune",
        "-o -name '*.py' -print -quit",
      ].join(' '),
      {
        cwd: state.appDir,
        timeout: 30,
      },
    );

    if (pythonFiles.exitCode !== 0) {
      return {
        status: 'failed',
        stdout: withCompatibilityOutput(pythonFiles.stdout),
        stderr: pythonFiles.stderr || 'Python file inspection failed.',
      };
    }

    if (pythonFiles.stdout.trim()) {
      const result = await runCommandCapturingExit(context, 'python -m compileall .', {
        cwd: state.appDir,
        timeout: 300,
      });

      return {
        status: result.exitCode === 0 ? ('success' as BuildStatus) : ('failed' as BuildStatus),
        stdout: withCompatibilityOutput(result.stdout),
        stderr: result.stderr,
      };
    }

    return {
      status: 'success',
      stdout: withCompatibilityOutput(
        'Nothing declared a build: no package.json build script, no buildCommand in edgeone.json, and no Python sources. Makers compatibility lint passed. If this project needs a build step, declare buildCommand and outputDirectory in edgeone.json — publishing runs what is declared there and nothing else.',
      ),
    };
  } catch (error) {
    const commandError = error as { stdout?: unknown; stderr?: unknown; message?: unknown };
    const stdout = typeof commandError.stdout === 'string' ? commandError.stdout : '';
    const stderr = typeof commandError.stderr === 'string' ? commandError.stderr : '';
    const message = error instanceof Error ? error.message : String(error);
    const fatal = detectFatalToolError([stdout, stderr, message].filter(Boolean).join('\n'));
    return {
      status: 'failed',
      stdout,
      stderr: fatal || stderr || message || 'Verification failed.',
      ...(fatal ? { fatal: true } : {}),
    };
  }
}
