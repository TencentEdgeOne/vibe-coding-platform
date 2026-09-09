import { getFileTree, runSandboxCommand } from '../_project.ts';
import type { FileTreeItem, ProjectState, StreamSend } from '../_types.ts';
export {
  compactUserFacingReply,
  replyLocaleFor,
  resolveFinishedTurn,
  STOPPED_TURN_REPLY,
  withLiveDeploymentUrl,
} from '../../shared/user-facing-reply.ts';

/** The preview link as the frontend expects it, or nothing when none is live. */
export function previewLinkFromState(state: ProjectState) {
  if (!state.previewUrl) {
    return {};
  }
  return {
    url: state.previewUrl,
    sandboxDebugUrl: state.sandboxDebugUrl,
    kind: state.previewKind,
  };
}

/**
 * Install only when the sandbox actually came back empty. A restored snapshot
 * carries source without node_modules, and both the preview server and the
 * Makers build need dependencies on disk.
 */
export async function ensureProjectDependencies(context: any, state: ProjectState) {
  const hasPackageJson = await context.sandbox.files.exists(`${state.appDir}/package.json`);
  if (!hasPackageJson) {
    return false;
  }
  const hasNodeModules = await context.sandbox.files.exists(`${state.appDir}/node_modules`);
  if (hasNodeModules) {
    return true;
  }
  const installed = await runSandboxCommand(context, 'npm install --no-audit --no-fund', {
    cwd: state.appDir,
    timeout: 300,
  });
  return installed.exitCode === 0;
}

const SANDBOX_EXTENSION_SECONDS = 1800;

// Caps for streaming generated file contents to the frontend (see
// handleProjectFilesChanged). Per-file keeps a single large asset off the stream;
// the per-turn budget bounds how much the replay buffer can hold.
export const FILE_PUSH_MAX_BYTES = 96 * 1024;
export const FILE_PUSH_TURN_BUDGET_BYTES = 2 * 1024 * 1024;

const utf8Encoder = new TextEncoder();

export function utf8ByteLength(value: string) {
  return utf8Encoder.encode(value).length;
}

/** Reject if `promise` does not settle within `ms`. Clears the timer on settle. */
export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`));
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type SandboxWithTimeoutExtension = {
  extendTimeout?: (seconds: number) => unknown;
};

export function stripReturnedPreviewLinks(text: string, previewUrl?: string) {
  if (!text || !previewUrl) {
    return text;
  }
  const escapedUrl = escapeRegExp(previewUrl);
  return text
    .replace(new RegExp(`\\s*\\[[^\\]]*(?:打开预览|预览|preview)[^\\]]*\\]\\(${escapedUrl}\\)`, 'gi'), '')
    .replace(new RegExp(`\\s*${escapedUrl}`, 'g'), '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildRequirementConclusionFallback(
  request: string,
  status: 'pending' | 'ready' | 'generated',
) {
  const summary = summarizeUserRequest(request);
  const isEnglish = !/[\u3400-\u9fff]/.test(request);

  if (isEnglish) {
    if (status === 'ready') {
      return `Built this for your request: ${summary}. The preview is ready in the right preview panel.`;
    }
    if (status === 'generated') {
      return `Generated the project for your request: ${summary}.`;
    }
    return `Handled your request: ${summary}. Verification and preview results are being prepared.`;
  }

  if (status === 'ready') {
    return `已按你的需求完成：${summary}。右侧预览已就绪。`;
  }
  if (status === 'generated') {
    return `已按你的需求生成项目：${summary}。`;
  }
  return `正在完成你的需求：${summary}。预览准备中。`;
}

function summarizeUserRequest(request: string) {
  const normalized = request.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return 'your web project';
  }
  const maxLength = 80;
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength).trimEnd()}...`
    : normalized;
}

export function isGenericCompletionReply(text: string) {
  const normalized = text.replace(/\s+/g, '').replace(/[。.!！]+$/g, '');
  return normalized === '已编写完成，请查看结果'
    || normalized === '已完成，请查看结果'
    || /^theagentdidnotreturnanythingdisplayable$/i.test(normalized);
}

export async function extendExistingSandboxTimeout(context: any) {
  const sandbox = context?.sandbox as SandboxWithTimeoutExtension | undefined;
  if (!sandbox || typeof sandbox.extendTimeout !== 'function') {
    return;
  }

  try {
    await sandbox.extendTimeout(SANDBOX_EXTENSION_SECONDS);
  } catch (error) {
    console.warn('[sandbox]', {
      stage: 'extend-timeout-failed',
      seconds: SANDBOX_EXTENSION_SECONDS,
      error: error instanceof Error ? error.message : String(error || ''),
    });
  }
}

// Persist the project through the sandbox SDK. Archive bytes travel directly from
// the sandbox to project Blob storage and never enter conversation metadata.
export async function persistProjectSnapshot(
  context: any,
  conversationId: string,
  state: ProjectState,
): Promise<boolean> {
  try {
    await context.sandbox.persist({ path: state.appDir });
    return true;
  } catch (error) {
    // Losing a snapshot silently means the next resume rebuilds from an older
    // workspace with nothing to explain the gap.
    console.warn('[snapshot]', {
      stage: 'persist-failed',
      conversationIdPresent: Boolean(conversationId),
      message: error instanceof Error ? error.message : String(error),
    });
  }
  return false;
}

// Debounce window for mid-turn checkpoints. Long enough to coalesce rapid
// write_project_file calls; short enough that stop/refresh mid-generation still
// has a recent snapshot in the store before the sandbox can recycle.
const CHECKPOINT_DEBOUNCE_MS = 2_000;

export type ProjectCheckpointController = {
  /** Mark the project dirty and (re)start the debounce timer. */
  schedule: () => void;
  /** Cancel the timer and persist immediately (await until the store write finishes). */
  flush: () => Promise<boolean>;
};

// Mid-turn + exit-path persistence controller. schedule() is cheap and coalesces;
// flush() forces a final sandbox-to-Blob write on stop/fatal/success paths.
export function createProjectCheckpointController(
  context: any,
  conversationId: string,
  state: ProjectState,
  onFailure?: (message: string) => void,
): ProjectCheckpointController {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let dirty = false;
  let chain: Promise<void> = Promise.resolve();
  let lastSucceeded = true;

  const kick = () => {
    chain = chain
      .then(async () => {
        while (dirty) {
          dirty = false;
          lastSucceeded = await persistProjectSnapshot(context, conversationId, state);
          if (!lastSucceeded) onFailure?.('Project persistence failed; the current sandbox files are still available until the sandbox expires.');
        }
      })
      .catch((error) => {
        console.warn('[checkpoint]', {
          stage: 'persist-failed',
          message: error instanceof Error ? error.message : String(error),
        });
      });
    return chain;
  };

  return {
    schedule() {
      dirty = true;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        void kick();
      }, CHECKPOINT_DEBOUNCE_MS);
    },
    async flush() {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      dirty = true;
      await kick();
      return lastSucceeded;
    },
  };
}

// Shorter than the checkpoint window: the Files panel is on screen, so the tree
// should look live, and a stale listing is more noticeable than a stale backup.
const FILE_TREE_DEBOUNCE_MS = 400;

export type FileTreePushController = {
  /** Coalesce a mid-turn push; the tree is read once per quiet period. */
  schedule: () => void;
  /** Read and push now, for the callers that act on the tree's contents. */
  flush: (fallbackMessage: string) => Promise<FileTreeItem[]>;
};

// Listing the tree costs a sandbox `find`, and the agent writes files in bursts,
// so a push per write bought one round trip per file for a panel that only ever
// shows the newest listing. Bursts now collapse into a single read, and reads
// never overlap.
export function createFileTreePushController(
  context: any,
  state: ProjectState,
  send: StreamSend,
): FileTreePushController {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let chain: Promise<FileTreeItem[]> = Promise.resolve([]);

  const read = async (fallbackMessage: string) => {
    try {
      const items = await getFileTree(context, state);
      send({
        type: 'file_tree',
        data: {
          root: state.appDir,
          items,
        },
      });
      return items;
    } catch (error) {
      // Non-fatal: the turn pushes the final tree again when it completes.
      send({
        type: 'log',
        phase: 'agent',
        stream: 'stderr',
        message: error instanceof Error ? error.message : fallbackMessage,
      });
      return [];
    }
  };

  const kick = (fallbackMessage: string) => {
    chain = chain.then(
      () => read(fallbackMessage),
      () => read(fallbackMessage),
    );
    return chain;
  };

  return {
    schedule() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        void kick('Failed to read the file list.');
      }, FILE_TREE_DEBOUNCE_MS);
    },
    flush(fallbackMessage: string) {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      return kick(fallbackMessage);
    },
  };
}
