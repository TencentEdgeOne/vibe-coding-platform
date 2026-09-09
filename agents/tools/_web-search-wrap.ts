import type { ClaudeMcpTool } from '../_types.ts';
import { shortenToolName } from '../../shared/tool-phase.ts';
import {
  WEB_SEARCH_API_KEY_ENV,
  WEB_SEARCH_TOOL_NAME,
  WEB_SEARCH_UNAVAILABLE_ERROR_CODE,
  WEB_SEARCH_UNAVAILABLE_MESSAGE,
  isWebSearchUnconfigured,
} from '../../shared/web-search.ts';

function textContents(result: Awaited<ReturnType<ClaudeMcpTool['handler']>>) {
  return (result.content || [])
    .flatMap((item) => item && typeof item === 'object' && 'text' in item
      && typeof item.text === 'string' ? [item.text] : [])
    .join('\n');
}

function unconfiguredResult() {
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        status: 'error',
        errorCode: WEB_SEARCH_UNAVAILABLE_ERROR_CODE,
        retryable: false,
        error: WEB_SEARCH_UNAVAILABLE_MESSAGE,
        instruction: `Do not call web_search again this turn, and do not rephrase the query — the missing ${WEB_SEARCH_API_KEY_ENV} is deployment configuration, not a property of the search. Continue from what you already have: platform questions are answered by load_makers_skill, and for anything else say plainly in the final reply what could not be looked up.`,
      }),
    }],
    isError: true,
  };
}

/**
 * Keep a search that cannot answer from being paid for twice.
 *
 * A missing key is handled before this: the tool is withheld from the tool list
 * entirely, so the model never spends a call to discover it. What remains for
 * this wrapper is the case that cannot be checked up front — a key that is set
 * but empty after trimming, revoked, or rejected — where the toolkit answers
 * with the same sentence about WSA_API_KEY however the query is phrased. Passed
 * through as-is that reads like a transient failure, so a model that has just
 * decided to look something up rephrases and tries again. The first failure
 * becomes a verdict that says so, and the calls after it are answered here
 * without a round trip at all.
 *
 * Scoped to one turn, which is as long as the fact is safely cached: fixing the
 * key is an operator action, and the next turn asks the runtime again.
 */
export function wrapWebSearchTool(tools: ClaudeMcpTool[]): ClaudeMcpTool[] {
  let unconfigured = false;

  return tools.map((tool) => {
    if (shortenToolName(tool.name) !== WEB_SEARCH_TOOL_NAME) {
      return tool;
    }
    const originalHandler = tool.handler;
    return {
      ...tool,
      handler: async (args, extra) => {
        if (unconfigured) {
          return unconfiguredResult();
        }
        const result = await originalHandler(args, extra);
        if (!isWebSearchUnconfigured(textContents(result))) {
          return result;
        }
        unconfigured = true;
        return unconfiguredResult();
      },
    };
  });
}
