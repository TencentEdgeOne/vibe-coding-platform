import { HISTORY_FETCH_LIMIT } from './_constants.ts';
import { createProjectState } from './_project.ts';
import type {
  ChatTask,
  ConversationMessage,
  PersistedActivityTurn,
  LegacyProjectSnapshot,
  ProjectState,
} from './_types.ts';
import { sanitizeAssistantText } from './utils/_text.ts';
import { appendTrimmedActivityTurn, dedupeActivityTurns } from './utils/_activity.ts';

export async function getHistory(
  context: any,
  conversationId: string,
  options: { excludeLatestUserMessage?: string } = {},
): Promise<ConversationMessage[]> {
  // context.store only exposes conversation-scoped message APIs, not a generic KV store.
  // Read this conversation's messages and filter them into user/assistant text pairs.
  try {
    const messages = await context.store.getMessages({
      conversationId,
      limit: HISTORY_FETCH_LIMIT,
      order: 'asc',
    });
    const items = Array.isArray(messages) ? messages : (messages?.items || []);
    const history = items
      .filter((item: any) => item.role === 'user' || item.role === 'assistant')
      .map((item: any) => ({
        role: item.role as 'user' | 'assistant',
        content: typeof item.content === 'string'
          ? item.content
          : JSON.stringify(item.content ?? ''),
      }));

    // /chat persists the submitted user message before the detached task starts.
    // Remove that one record from the prompt history; the pipeline passes
    // it separately as the current user turn.
    const currentMessage = options.excludeLatestUserMessage;
    if (currentMessage && history.at(-1)?.role === 'user' && history.at(-1)?.content === currentMessage) {
      history.pop();
    }
    return history;
  } catch (error: any) {
    if (error?.code === 'MemoryNotFoundError') {
      return [];
    }
    throw error;
  }
}

export async function getChatTask(context: any, conversationId: string): Promise<ChatTask | null> {
  try {
    const conversation = await context.store.getConversation({ conversationId });
    const task = conversation?.metadata?.chatTask;
    return task && typeof task === 'object' && typeof task.id === 'string'
      ? task as ChatTask
      : null;
  } catch (error: any) {
    if (error?.code === 'MemoryNotFoundError') {
      return null;
    }
    throw error;
  }
}

export async function saveChatTask(context: any, conversationId: string, task: ChatTask) {
  await context.store.updateConversation({
    conversationId,
    metadata: { chatTask: task },
  });
}

/**
 * The model this conversation last ran on. Persisted so a refresh can restore
 * the picker, and so a turn that arrives without an explicit choice still runs
 * on the model the conversation has been using rather than silently reverting
 * to the deployment default.
 */
export async function getModelPreference(
  context: any,
  conversationId: string,
): Promise<string> {
  try {
    const conversation = await context.store.getConversation({ conversationId });
    const stored = conversation?.metadata?.modelPreference;
    return typeof stored === 'string' ? stored.trim() : '';
  } catch (error: any) {
    if (error?.code !== 'MemoryNotFoundError') {
      throw error;
    }
    return '';
  }
}

export async function saveModelPreference(
  context: any,
  conversationId: string,
  model: string,
) {
  try {
    await context.store.updateConversation({
      conversationId,
      metadata: { modelPreference: model },
    });
  } catch (error: any) {
    // Same first-turn race as saveProjectState: until appendMessage creates the
    // conversation, updateConversation has nothing to merge into.
    if (error?.code !== 'MemoryNotFoundError') {
      throw error;
    }
  }
}

export async function appendTurn(
  context: any,
  conversationId: string,
  role: 'user' | 'assistant',
  content: string,
) {
  // Sanitize assistant content before writing history so control sequences or raw JSON
  // from new concatenation paths do not pollute the next prompt.
  const safeContent = role === 'assistant' ? sanitizeAssistantText(content) : content;
  await context.store.appendMessage({
    conversationId,
    role,
    content: safeContent,
  });
}

export async function getProjectState(context: any, conversationId: string): Promise<ProjectState> {
  // Project state is conversation metadata, not a chat message. On first access,
  // the conversation may not exist yet, so fall back to the default state.
  try {
    const conversation = await context.store.getConversation({ conversationId });
    const stored = conversation?.metadata?.projectState as ProjectState | undefined;
    if (stored && typeof stored === 'object') {
      return stored;
    }
  } catch (error: any) {
    if (error?.code !== 'MemoryNotFoundError') {
      throw error;
    }
  }
  return createProjectState(conversationId);
}

export async function saveProjectState(
  context: any,
  conversationId: string,
  state: ProjectState,
) {
  // updateConversation shallow-merges metadata; replace projectState as a whole.
  try {
    await context.store.updateConversation({
      conversationId,
      metadata: { projectState: state },
    });
  } catch (error: any) {
    // If no messages have been written, the conversation does not exist yet and
    // updateConversation throws MemoryNotFoundError. appendMessage will create it
    // later in this turn, and the next saveProjectState call can write normally.
    if (error?.code !== 'MemoryNotFoundError') {
      throw error;
    }
  }
}

// Read-only compatibility for snapshots written by template versions that stored
// the archive in conversation metadata. New writes use context.sandbox.persist().
export async function getLegacyProjectSnapshot(
  context: any,
  conversationId: string,
): Promise<LegacyProjectSnapshot | null> {
  try {
    const conversation = await context.store.getConversation({ conversationId });
    const stored = conversation?.metadata?.projectSnapshot as LegacyProjectSnapshot | undefined;
    if (stored && typeof stored === 'object' && typeof stored.base64 === 'string' && stored.base64) {
      return stored;
    }
  } catch (error: any) {
    if (error?.code !== 'MemoryNotFoundError') {
      throw error;
    }
  }
  return null;
}

export async function clearLegacyProjectSnapshot(context: any, conversationId: string) {
  try {
    await context.store.updateConversation({
      conversationId,
      metadata: { projectSnapshot: null },
    });
  } catch (error: any) {
    if (error?.code !== 'MemoryNotFoundError') {
      throw error;
    }
  }
}

const ACTIVITY_TURN_LIMIT = 25;
const ACTIVITY_ITEM_LIMIT = 50;

export async function getActivityHistory(
  context: any,
  conversationId: string,
): Promise<PersistedActivityTurn[]> {
  try {
    const conversation = await context.store.getConversation({ conversationId });
    const stored = conversation?.metadata?.activityHistory;
    return Array.isArray(stored)
      ? dedupeActivityTurns(stored.slice(-ACTIVITY_TURN_LIMIT))
      : [];
  } catch (error: any) {
    if (error?.code !== 'MemoryNotFoundError') throw error;
    return [];
  }
}

export async function saveActivityTurn(
  context: any,
  conversationId: string,
  turn: PersistedActivityTurn,
) {
  const current = await getActivityHistory(context, conversationId);
  const next = appendTrimmedActivityTurn(
    current,
    turn,
    ACTIVITY_TURN_LIMIT,
    ACTIVITY_ITEM_LIMIT,
  );
  try {
    await context.store.updateConversation({
      conversationId,
      metadata: { activityHistory: next },
    });
  } catch (error: any) {
    if (error?.code !== 'MemoryNotFoundError') throw error;
  }
}
