import type { ProjectState } from '../_types.ts';
import { safeSegment } from '../utils/_paths.ts';
import { runSandboxCommand } from './_commands.ts';
import { isMakersDeployUrl } from '../../shared/makers-deploy.ts';

export function createProjectState(conversationId: string): ProjectState {
  const sessionDir = `projects/${safeSegment(conversationId)}`;
  return {
    created: false,
    sessionDir,
    appDir: `${sessionDir}/app`,
  };
}

/** Migrate persisted state from versions that rendered a deployment as preview. */
export function separateLegacyMakersDeployment(state: ProjectState) {
  const legacyUrl = state.previewUrl;
  if (
    !legacyUrl
    || (state.previewKind !== 'makers' && !isMakersDeployUrl(legacyUrl))
  ) {
    return state;
  }

  state.deployment ??= {
    status: 'success',
    startedAt: 0,
    finishedAt: 0,
    url: legacyUrl,
  };
  state.previewUrl = undefined;
  state.sandboxDebugUrl = undefined;
  state.previewPublished = undefined;
  state.previewKind = undefined;
  return state;
}

export async function resetProjectWorkspace(
  context: any,
  state: ProjectState,
) {
  assertResettableProjectPath(state);

  const sandbox = context.sandbox;

  await sandbox.files.makeDir(state.sessionDir);

  const appDirExists = await sandbox.files.exists(state.appDir);
  if (appDirExists) {
    if (typeof sandbox.files.remove === 'function') {
      await sandbox.files.remove(state.appDir);
    } else {
      const result = await runSandboxCommand(context, 'rm -rf app', {
        cwd: state.sessionDir,
        timeout: 60,
      });
      if (result.exitCode !== 0) {
        throw new Error(result.stderr || result.stdout || 'Failed to initialize the project workspace.');
      }
    }
  }

  await sandbox.files.makeDir(state.appDir);
  state.created = false;
  state.previewUrl = undefined;
  state.sandboxDebugUrl = undefined;
  state.previewPublished = undefined;
  state.previewKind = undefined;
  state.deployment = undefined;
  return appDirExists;
}

export function assertResettableProjectPath(state: ProjectState) {
  if (state.appDir !== `${state.sessionDir}/app`) {
    throw new Error(`Refusing to operate on an unexpected project path: ${state.appDir}`);
  }
  if (!/^projects\/[a-zA-Z0-9_-]+$/.test(state.sessionDir)) {
    throw new Error(`Refusing to operate on an unexpected session path: ${state.sessionDir}`);
  }
  if (!/^projects\/[a-zA-Z0-9_-]+\/app$/.test(state.appDir)) {
    throw new Error(`Refusing to operate on an unexpected project path: ${state.appDir}`);
  }
}
