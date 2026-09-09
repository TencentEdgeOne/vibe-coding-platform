import type { AssistantActivity, ChatMessage } from '../types/workspace';

const CONVERSATION_STORAGE_KEY = 'vibe-coding-platform-conversation-id';

export function createConversationId() {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `conversation-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function getOrCreateCachedConversationId() {
  if (typeof window === 'undefined') {
    return createConversationId();
  }

  const stored = window.localStorage.getItem(CONVERSATION_STORAGE_KEY)?.trim();
  if (stored) {
    return stored;
  }

  const next = createConversationId();
  window.localStorage.setItem(CONVERSATION_STORAGE_KEY, next);
  return next;
}

// Read the cached conversationId without minting a new one. Returns null on a
// first visit — used to decide whether there is anything to resume at all, so a
// brand-new visitor skips the "restoring…" screen entirely.
export function getStoredConversationId() {
  if (typeof window === 'undefined') {
    return null;
  }
  return window.localStorage.getItem(CONVERSATION_STORAGE_KEY)?.trim() || null;
}

export function cacheConversationId(value: string) {
  const trimmed = value.trim();
  if (!trimmed || typeof window === 'undefined') {
    return;
  }
  window.localStorage.setItem(CONVERSATION_STORAGE_KEY, trimmed);
}

export function clearCachedConversationId() {
  if (typeof window === 'undefined') {
    return;
  }
  window.localStorage.removeItem(CONVERSATION_STORAGE_KEY);
}

export function createMessageId(role: ChatMessage['role']) {
  return `${role}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export type StoppedTurnSnapshot = {
  /** The rendered list, with the interrupted turn marked stopped. */
  messages: ChatMessage[];
  /** The same turn's activities, for the /stop payload. */
  activities: AssistantActivity[];
  /** The prompt that opened the turn, so the persisted turn stays a pair. */
  userContent: string;
};

// Stopping a turn has to land in two places: the screen and the turn persisted
// through /stop. Deriving that state twice let the two drift — one pass mapped
// the trailing message, the other reverse-searched for a running assistant —
// so both now come out of a single pass over a single snapshot.
export function markLastTurnStopped(
  messages: ChatMessage[],
  stoppedText: string,
): StoppedTurnSnapshot {
  let stoppedIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === 'assistant' && message.status === 'running') {
      stoppedIndex = index;
      break;
    }
  }

  const lastUserContentBefore = (end: number) => {
    for (let index = end - 1; index >= 0; index -= 1) {
      if (messages[index].role === 'user') return messages[index].content;
    }
    return '';
  };

  if (stoppedIndex === -1) {
    return {
      messages,
      activities: [],
      userContent: lastUserContentBefore(messages.length),
    };
  }

  // One timestamp for the whole turn: the tools all stopped at the same click,
  // and a per-activity Date.now() would order them by array position.
  const endedAt = Date.now();
  const activities = (messages[stoppedIndex].activities ?? []).map((activity) => (
    activity.kind === 'tool' && activity.status === 'running'
      ? { ...activity, status: 'stopped' as const, endedAt }
      : activity
  ));

  return {
    messages: messages.map((message, index) => (
      index === stoppedIndex
        ? { ...message, content: stoppedText, status: 'stopped' as const, activities }
        : message
    )),
    activities,
    userContent: lastUserContentBefore(stoppedIndex),
  };
}

export function sanitizeThinkingContent(value: string) {
  return value
    .replace(/\x1b\[[0-9;?]*[~A-Za-z]/g, '')
    .replace(/\[20[01]~/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
    .replace(/<think\b[^>]*>/gi, '')
    .replace(/<\/think>/gi, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .replace(/<t(?:h(?:i(?:n(?:k(?:\b[^>]*)?)?)?)?)?$/i, '');
}

export function extractProjectName() {
  if (typeof window === 'undefined') {
    return {
      projectName: '',
      domain: '',
    };
  }

  var fullUrl = window.location.href;
  var urlObject = new URL(fullUrl);
  var hostname = urlObject.hostname;
  var parts = hostname.split('.');
  return {
    projectName: parts[0].replace('-zh', ''),
    domain: parts.slice(1).join('.'),
  };
}

const EDGEONE_AI_CONTACT_URL = 'https://pages.edgeone.ai/contact?source=pages-home';
export const TENCENT_CLOUD_CONTACT_URL = 'https://cloud.tencent.com/online-service?from=connect-us';

export function getContactUrl(domain: string) {
  return domain === 'edgeone.dev' ? EDGEONE_AI_CONTACT_URL : TENCENT_CLOUD_CONTACT_URL;
}

/** Where this template's own code lives, for a reader who wants it rather than a copy. */
export const TEMPLATE_SOURCE_URL = 'https://github.com/TencentEdgeOne/vibe-coding-platform';

// Taking a copy of this template is a console flow, so the button is a link out
// rather than an action this app can finish. The query string is the one the
// README badge uses — it is what tells the console which template to open — and
// the host splits the same way the contact URL does, because the two consoles are
// separate deployments and neither can sign in the other's accounts.
const TEMPLATE_DEPLOY_QUERY = 'template=vibe-coding-agent&from=within&fromAgent=1&agentLang=typescript';
const EDGEONE_AI_TEMPLATE_DEPLOY_URL = `https://edgeone.ai/makers/new?${TEMPLATE_DEPLOY_QUERY}`;
const TENCENT_CLOUD_TEMPLATE_DEPLOY_URL = `https://console.cloud.tencent.com/edgeone/makers/new?${TEMPLATE_DEPLOY_QUERY}`;

export function getTemplateDeployUrl(domain: string) {
  return domain === 'edgeone.dev'
    ? EDGEONE_AI_TEMPLATE_DEPLOY_URL
    : TENCENT_CLOUD_TEMPLATE_DEPLOY_URL;
}

// Decode a base64 string into a Blob. The source archive arrives base64-encoded
// inside a JSON envelope (the agent proxy only transports text reliably).
export function base64ToBlob(base64: string, contentType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: contentType });
}

export function downloadTextFile(filename: string, content: string, mimeType = 'application/x-ndjson') {
  if (typeof document === 'undefined') {
    return;
  }
  const blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(objectUrl);
}
