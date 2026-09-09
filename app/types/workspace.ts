import type { AssistantActivity } from '../../shared/protocol';

export type {
  AssistantActivity,
  BuildInfo,
  ChatResponse,
  ChatStreamEvent,
  DeploymentInfo,
  FileTree,
  LinkInfo,
  ResumeData,
  ResumeStreamEvent,
} from '../../shared/protocol';

export type AssistantStatus = 'running' | 'done' | 'error' | 'stopped';

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  activities?: AssistantActivity[];
  status?: AssistantStatus;
};
