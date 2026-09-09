import type {
  PersistedActivityTurn,
  ResumeData,
} from '../../../shared/protocol';
import type { ModelOption } from '../../../shared/models';

function conversationHeaders(conversationId: string): HeadersInit {
  return {
    'content-type': 'application/json',
    conversationId,
    'makers-conversation-id': conversationId,
  };
}

async function readJson<T>(response: Response): Promise<T | null> {
  return response.json().catch(() => null) as Promise<T | null>;
}

function fetchResumeStage(
  conversationId: string,
  stage: 'preview',
  signal?: AbortSignal,
) {
  return fetch(`/resume?stage=${stage}`, {
    method: 'POST',
    headers: conversationHeaders(conversationId),
    body: JSON.stringify({ stage }),
    signal,
  }).then((response) => readJson<ResumeData>(response));
}

export function openResumeStream(conversationId: string, signal?: AbortSignal) {
  return fetch('/resume', {
    method: 'GET',
    headers: conversationHeaders(conversationId),
    signal,
  });
}

// Cold resume can reinstall the EdgeOne CLI (420s ceiling) and project
// dependencies before makers-dev starts.
const RESUME_CLIENT_TIMEOUT_MS = 620_000;

function fetchTimedResumeStage(conversationId: string, stage: 'preview') {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RESUME_CLIENT_TIMEOUT_MS);
  return fetchResumeStage(conversationId, stage, controller.signal)
    .catch(() => null)
    .finally(() => clearTimeout(timer));
}

export function fetchResumePreview(conversationId: string) {
  return fetchTimedResumeStage(conversationId, 'preview');
}

/**
 * The models this deployment offers. Fetched rather than bundled: the list is
 * assembled from server environment the browser cannot read, and the server
 * validates against the same list, so building one here could only drift.
 *
 * Takes a conversation ID because the runtime rejects every agent route without
 * one, not because the answer depends on the conversation — it does not.
 */
export function fetchModelCatalog(conversationId: string, signal?: AbortSignal) {
  return fetch('/models', {
    method: 'GET',
    headers: conversationHeaders(conversationId),
    signal,
  })
    .then((response) => readJson<{
      ok?: boolean;
      models?: ModelOption[];
      defaultModel?: string;
    }>(response))
    .catch(() => null);
}

export function startChatTask(options: {
  conversationId: string;
  message: string;
  turnId: string;
  resetProject: boolean;
  /** 'deploy' publishes the current project instead of running the model. */
  intent?: 'deploy';
  /** Omitted runs the deployment default; the server drops anything it does not offer. */
  model?: string;
  signal?: AbortSignal;
}) {
  return fetch('/chat', {
    method: 'POST',
    headers: conversationHeaders(options.conversationId),
    body: JSON.stringify({
      message: options.message,
      turnId: options.turnId,
      ...(options.resetProject ? { resetProject: true } : {}),
      ...(options.intent ? { intent: options.intent } : {}),
      ...(options.model ? { model: options.model } : {}),
    }),
    signal: options.signal,
  });
}

export function fetchChatTaskStream(streamUrl: string, conversationId: string, signal: AbortSignal) {
  return fetch(streamUrl, {
    method: 'GET',
    headers: conversationHeaders(conversationId),
    signal,
  });
}

export async function stopChatTask(
  conversationId: string,
  turn: PersistedActivityTurn,
  options: { discardProject?: boolean } = {},
) {
  const request = (headers: HeadersInit) => fetch('/stop', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      conversation_id: conversationId,
      turn,
      ...(options.discardProject ? { discardProject: true } : {}),
    }),
  });

  const response = await request({ 'content-type': 'application/json' });
  if (response.status !== 400) return response;
  const error = await readJson<{ code?: string }>(response.clone());
  if (error?.code !== 'AGENT_CONVERSATION_ID_REQUIRED') return response;

  // Compatibility only: current runtimes require body-only /stop so sticky
  // routing cannot pin cancellation to the busy chat instance.
  return request({
    'content-type': 'application/json',
    'makers-conversation-id': conversationId,
  });
}

export function fetchProjectArchive(url: string, conversationId: string) {
  return fetch(url, {
    method: 'GET',
    headers: conversationId
      ? {
          conversationId,
          'makers-conversation-id': conversationId,
        }
      : {},
  });
}

export function fetchConversationTranscript(conversationId: string) {
  return fetch(`/transcript?conversationId=${encodeURIComponent(conversationId)}`, {
    method: 'GET',
    headers: {
      conversationId,
      'makers-conversation-id': conversationId,
    },
  });
}
