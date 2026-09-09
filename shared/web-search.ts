/**
 * Reading web_search results.
 *
 * The tool reaches this agent from the CLI toolkit, which injects it into the
 * agent runtime, and it works as soon as WSA_API_KEY is set in that runtime's
 * environment. Until then every call answers with the same sentence naming the
 * variable. Runtime-agnostic on purpose so the tests can pin the wording.
 */

export const WEB_SEARCH_TOOL_NAME = 'web_search';

/** The variable the toolkit reads, named here only to document the config. */
export const WEB_SEARCH_API_KEY_ENV = 'WSA_API_KEY';

export const WEB_SEARCH_UNAVAILABLE_ERROR_CODE = 'WEB_SEARCH_UNCONFIGURED';

export const WEB_SEARCH_UNAVAILABLE_MESSAGE =
  'Web search is not configured in this deployment, so no query can succeed this turn.';

/**
 * Whether a tool name is the search tool, under either the bare or the
 * MCP-qualified form the runtime hands out.
 */
export function isWebSearchToolName(name: string) {
  const normalized = name.toLowerCase();
  return normalized === WEB_SEARCH_TOOL_NAME
    || normalized.endsWith(`__${WEB_SEARCH_TOOL_NAME}`);
}

/**
 * Whether the key is present, which is the whole of what can be checked here.
 *
 * A key that is present but rejected looks identical from this side, so this
 * decides whether to offer the tool, never whether a query will work.
 */
export function isWebSearchConfigured(apiKey: string | undefined) {
  return Boolean(apiKey && apiKey.trim());
}

/**
 * Whether a result says the tool has no key, rather than no answer.
 *
 * Matched on the variable name because that is the part the toolkit owns and
 * the part that cannot be a search result: a query about WSA_API_KEY would come
 * back as pages, not as a bare sentence in the tool's own error field. Both
 * halves have to appear, so a page that merely mentions the variable is still
 * treated as a successful search.
 */
export function isWebSearchUnconfigured(output: string) {
  if (!output) return false;
  return output.includes(WEB_SEARCH_API_KEY_ENV)
    && /\brequires?\b|\bnot set\b|\bmissing\b|\bset it to\b/i.test(output);
}
