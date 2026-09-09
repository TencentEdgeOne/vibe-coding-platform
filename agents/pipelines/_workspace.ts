import { clearLegacyProjectSnapshot, getProjectState } from '../_memory.ts';
import {
  createProjectState,
  getFileTree,
  resetProjectWorkspace,
  restorePersistedProject,
  separateLegacyMakersDeployment,
} from '../_project.ts';
import type { ProjectState, StreamSend } from '../_types.ts';

/** Restore or reset the volatile sandbox before an agent turn starts. */
export async function prepareProjectWorkspace(
  context: any,
  conversationId: string,
  resetProject: boolean,
  send: StreamSend,
): Promise<ProjectState> {
  const state = resetProject
    ? createProjectState(conversationId)
    : separateLegacyMakersDeployment(await getProjectState(context, conversationId));

  if (resetProject) {
    await resetProjectWorkspace(context, state);
    await clearLegacyProjectSnapshot(context, conversationId);
    // The snapshot only speeds up later sessions, so a failure here (backend
    // unavailable, size cap, quota) must not abort the turn the user asked for.
    try {
      await context.sandbox.persist({ path: state.appDir });
    } catch (error) {
      send({
        type: 'log',
        phase: 'scaffold',
        stream: 'stderr',
        message: error instanceof Error ? error.message : 'Snapshot save failed.',
      });
    }
    return state;
  }

  try {
    let hasProjectFiles = false;
    try {
      if (await context.sandbox.files.exists(state.appDir)) {
        const tree = await getFileTree(context, state);
        hasProjectFiles = tree.some((item) => item.type === 'file');
      }
    } catch {
      hasProjectFiles = false;
    }

    if (!hasProjectFiles) {
      send({ type: 'status', message: 'Restoring project from snapshot' });
      const restored = await restorePersistedProject(context, conversationId, state);
      if (!restored.restored) {
        if (restored.error) {
          send({
            type: 'log',
            phase: 'scaffold',
            stream: 'stderr',
            message: restored.error,
          });
        }
      } else {
        hasProjectFiles = true;
      }
    }

    await ensureWorkspaceDirectories(context, state);
    if (hasProjectFiles) state.created = true;
  } catch (error) {
    send({
      type: 'log',
      phase: 'scaffold',
      stream: 'stderr',
      message: error instanceof Error ? error.message : 'Snapshot restore check failed.',
    });
    try {
      await ensureWorkspaceDirectories(context, state);
    } catch {
      // Scaffold reports the actionable error if directory creation still fails.
    }
  }

  return state;
}

async function ensureWorkspaceDirectories(context: any, state: ProjectState) {
  await context.sandbox.files.makeDir(state.sessionDir);
  await context.sandbox.files.makeDir(state.appDir);
}
