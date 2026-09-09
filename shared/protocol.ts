/**
 * Transport contracts shared by the Makers agent runtime and the browser.
 *
 * Keep this module runtime-agnostic: no React, Next.js, or EdgeOne imports.
 */

export type BuildStatus = 'success' | 'failed' | 'skipped';

export type ActivityStatus = 'running' | 'completed' | 'failed' | 'stopped';

export type AssistantActivity =
  | {
      kind: 'text';
      content: string;
    }
  | {
      kind: 'tool';
      toolUseId: string;
      name: string;
      status: ActivityStatus;
      inputSummary?: string;
      outputSummary?: string;
      startedAt?: number;
      endedAt?: number;
    };

export type PersistedActivityTurn = {
  id: string;
  user: string;
  assistant: string;
  status: 'completed' | 'failed' | 'stopped';
  createdAt: number;
  activities: AssistantActivity[];
};

export type BuildInfo = {
  status: BuildStatus;
  stdout?: string;
  stderr?: string;
  autoFixAttempts?: number;
  autoFixApplied?: boolean;
};

export type PreviewKind = 'sandbox' | 'makers';

export type DeploymentStatus = 'running' | 'success' | 'failed';

export type DeploymentInfo = {
  status: DeploymentStatus;
  startedAt: number;
  finishedAt?: number;
  url?: string;
  projectId?: string;
  deploymentId?: string;
  consoleUrl?: string;
  error?: string;
};

export type LinkInfo = {
  url?: string;
  sandboxDebugUrl?: string;
  filename?: string;
  error?: string;
  /** Preview resume restarted the server, invalidating an already loaded iframe. */
  restarted?: boolean;
  /** Makers deploy URLs skip sandbox envdAccessToken refresh. */
  kind?: PreviewKind;
};

export type FileTreeItem = {
  path: string;
  name: string;
  type: 'file' | 'directory';
  depth: number;
  mtime?: number;
  size?: number;
};

export type FileTree = {
  root: string;
  items: FileTreeItem[];
};

type ActiveChatTask = {
  id: string;
  message: string;
  status: 'queued' | 'running';
  resetProject?: boolean;
  createdAt?: number;
  startedAt?: number;
  streamUrl?: string;
};

export type ResumeData = {
  ok?: boolean;
  stage?: 'history' | 'workspace' | 'preview';
  conversation_id?: string;
  messages?: { role: 'user' | 'assistant'; content: string }[];
  hasProject?: boolean;
  hasPreview?: boolean;
  needsWorkspace?: boolean;
  preview?: LinkInfo;
  deployment?: DeploymentInfo;
  files?: FileTree;
  download?: LinkInfo;
  activityHistory?: PersistedActivityTurn[];
  activeTask?: ActiveChatTask | null;
  /** Model chosen for this conversation; '' or absent means the deployment default. */
  model?: string;
  error?: string;
};

export type ChatResponse = {
  ok?: boolean;
  reply?: string;
  conversation_id?: string;
  build?: BuildInfo;
  files?: FileTree;
  preview?: LinkInfo;
  deployment?: DeploymentInfo;
  download?: LinkInfo;
  error?: string;
  stopped?: boolean;
};

type ProgressPhase = 'scaffold' | 'modify' | 'code' | 'install' | 'preview' | 'link';

export type ChatStreamEvent =
  | {
      type: 'task_started';
      data?: {
        runId?: string;
        conversation_id?: string;
        status?: 'queued' | 'running' | 'completed' | 'failed' | 'stopped';
      };
    }
  | { type: 'status'; message?: string }
  | { type: 'result'; data?: ChatResponse }
  | { type: 'agent'; data?: Pick<ChatResponse, 'ok' | 'reply' | 'error'> }
  | { type: 'file_tree'; data?: FileTree }
  | {
      type: 'file_content';
      data?: { path?: string; content?: string; size?: number };
    }
  | {
      type: 'preview_ready';
      data?: { preview?: LinkInfo; download?: LinkInfo };
    }
  | {
      type: 'deployment_status';
      data?: DeploymentInfo;
    }
  | {
      type: 'tool_use';
      data?: {
        id?: string;
        name?: string;
        command?: string;
        phaseHint?: ProgressPhase;
        fileCount?: number;
        inputSummary?: string;
        /**
         * Output from a call that has not finished. Re-sent with the same `id`
         * as the call goes on, which patches the row in place; a publish runs
         * for minutes and this is what it shows while it does.
         */
        outputSummary?: string;
        startedAt?: number;
      };
    }
  | {
      type: 'tool_result';
      data?: {
        tool_use_id?: string;
        toolName?: string;
        command?: string;
        ok?: boolean;
        preview?: string;
        outputSummary?: string;
        status?: ActivityStatus;
        endedAt?: number;
      };
    }
  | { type: 'text_segment'; data?: { uuid?: string; text?: string } }
  | { type: 'error'; error?: string }
  | {
      type: 'log';
      phase?: 'scaffold' | 'agent';
      stream?: 'status' | 'stdout' | 'stderr';
      message?: string;
    }
  | { type: 'ping'; ts?: number };

export type ResumeStreamEvent =
  | { type: 'resume_history'; data?: ResumeData }
  | { type: 'resume_workspace'; data?: ResumeData }
  | {
      type: 'resume_file_content';
      data?: {
        path?: string;
        content?: string;
        size?: number;
        truncated?: boolean;
        mtime?: number;
      };
    }
  | { type: 'error'; error?: string }
  | { type: 'ping'; ts?: number };
