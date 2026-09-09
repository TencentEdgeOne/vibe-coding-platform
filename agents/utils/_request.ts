// Request helpers for agent pipelines. Mirrors the query/header resolution the rest
// of the app relies on for the EdgeOne request shape.

export function getRequestHeader(context: any, name: string): string {
  const headers = context?.request?.headers;
  if (!headers) return '';

  // Headers / Map-like (case-insensitive get).
  if (typeof headers.get === 'function') {
    return String(headers.get(name) || '');
  }

  // Plain objects: try exact / lower-case keys, then a case-insensitive scan
  // (some runtimes normalize header names inconsistently).
  const lowerName = name.toLowerCase();
  const directValue = headers[name] ?? headers[lowerName];
  const value = directValue
    ?? Object.entries(headers).find(([key]) => key.toLowerCase() === lowerName)?.[1];
  return typeof value === 'string' ? value : String(value || '');
}

function queryValueToString(value: unknown): string {
  if (Array.isArray(value)) {
    return queryValueToString(value[0]);
  }
  if (value === undefined || value === null) {
    return '';
  }
  return typeof value === 'string' ? value : String(value);
}

function getSearchParamFromString(rawValue: unknown, name: string): string {
  if (typeof rawValue !== 'string' || !rawValue.trim()) {
    return '';
  }

  const raw = rawValue.trim();
  try {
    if (raw.startsWith('?')) {
      return new URLSearchParams(raw.slice(1)).get(name) || '';
    }
    if (raw.includes('?') || raw.startsWith('/') || /^https?:\/\//i.test(raw)) {
      return new URL(raw, 'http://local').searchParams.get(name) || '';
    }
    if (raw.includes('=')) {
      return new URLSearchParams(raw).get(name) || '';
    }
  } catch {
    return '';
  }

  return '';
}

export function getRequestQueryParam(context: any, name: string): {
  value: string;
  source: string;
} {
  const request = context?.request || {};
  const stringFields = [
    'url',
    'path',
    'pathname',
    'search',
    'queryString',
    'rawUrl',
    'originalUrl',
  ];
  for (const field of stringFields) {
    const value = getSearchParamFromString(request[field], name);
    if (value) {
      return { value, source: `request.${field}` };
    }
  }

  const queryObjects = [
    { source: 'request.query', value: request.query },
    { source: 'request.params', value: request.params },
    { source: 'request.searchParams', value: request.searchParams },
    { source: 'context.query', value: context?.query },
    { source: 'context.params', value: context?.params },
  ];
  for (const query of queryObjects) {
    if (query.value && typeof query.value.get === 'function') {
      const value = query.value.get(name);
      if (value) {
        return { value: queryValueToString(value), source: query.source };
      }
      continue;
    }
    if (!query || typeof query !== 'object') continue;
    const value = query.value?.[name];
    const normalized = queryValueToString(value);
    if (normalized) {
      return { value: normalized, source: query.source };
    }
  }

  return { value: '', source: 'none' };
}

/**
 * Resolve conversation id from the dual-channel routing shape used by Makers:
 * context.conversation_id → makers-conversation-id → conversationId header,
 * optionally falling back to query cid / conversationId (for plain navigations).
 */
export function resolveConversationId(
  context: any,
  options?: { allowQuery?: boolean },
): { conversationId: string; source: string } {
  const contextConversationId = String(context?.conversation_id || '');
  if (contextConversationId) {
    return { conversationId: contextConversationId, source: 'context.conversation_id' };
  }

  const pagesHeaderConversationId = getRequestHeader(context, 'makers-conversation-id');
  if (pagesHeaderConversationId) {
    return { conversationId: pagesHeaderConversationId, source: 'makers-conversation-id' };
  }

  const headerConversationId = getRequestHeader(context, 'conversationId');
  if (headerConversationId) {
    return { conversationId: headerConversationId, source: 'conversationId' };
  }

  if (options?.allowQuery) {
    // Query-param fallback so a plain navigation can still target the right
    // sandbox; the frontend prefers the headers.
    const cid = getRequestQueryParam(context, 'cid');
    if (cid.value) {
      return { conversationId: cid.value, source: cid.source };
    }
    const conversationIdQuery = getRequestQueryParam(context, 'conversationId');
    if (conversationIdQuery.value) {
      return { conversationId: conversationIdQuery.value, source: conversationIdQuery.source };
    }
  }

  return { conversationId: '', source: 'none' };
}

/** Query `conversationId` wins so curl loops are not pinned to a sticky header. */
export function resolveConversationIdPreferQuery(context: any): {
  conversationId: string;
  source: string;
} {
  const queryId = getRequestQueryParam(context, 'conversationId').value.trim();
  if (queryId) {
    return { conversationId: queryId, source: 'query.conversationId' };
  }
  return resolveConversationId(context, { allowQuery: true });
}
