import assert from 'node:assert/strict';
import test from 'node:test';
import { TRANSLATIONS } from '../app/i18n.ts';
import { presentToolActivity } from '../app/lib/tool-activity.ts';
import type { ClaudeMcpTool } from '../agents/_types.ts';
import { wrapWebSearchTool } from '../agents/tools/_web-search-wrap.ts';
import {
  WEB_SEARCH_API_KEY_ENV,
  isWebSearchConfigured,
  isWebSearchToolName,
  isWebSearchUnconfigured,
} from '../shared/web-search.ts';

/** What the toolkit answers with when the runtime has no key. */
const UNCONFIGURED_REPLY = `web_search requires the ${WEB_SEARCH_API_KEY_ENV} environment `
  + `variable. Set it to a valid Tencent Cloud Web Search (WSA) API key before calling web_search.`;

function searchTool(replies: string[]) {
  const calls: unknown[] = [];
  const tool = {
    name: 'mcp__edgeone-sandbox__web_search',
    description: 'Search the web',
    inputSchema: {},
    handler: async (args: unknown) => {
      calls.push(args);
      const reply = replies[calls.length - 1] ?? replies[replies.length - 1] ?? '';
      return { content: [{ type: 'text' as const, text: reply }] };
    },
  } as unknown as ClaudeMcpTool;
  const [wrapped] = wrapWebSearchTool([tool]);
  return { calls, search: (query: string) => wrapped.handler({ query }, {} as never) };
}

function replyText(result: { content?: unknown }) {
  const [first] = (result.content || []) as { text?: string }[];
  return first?.text || '';
}

// Withholding the tool is what makes the count zero rather than one. The
// filter in the runtime is two predicates over these, so they carry the logic.
test('a keyless deployment withholds the tool instead of offering it', () => {
  assert.equal(isWebSearchConfigured(undefined), false);
  assert.equal(isWebSearchConfigured(''), false);
  // A key set to whitespace is the same as no key, and reads as configured to
  // anything that only checks for presence.
  assert.equal(isWebSearchConfigured('   '), false);
  assert.equal(isWebSearchConfigured('sk-live-abc'), true);

  // Both forms have to match: the tool list carries the qualified name and the
  // allowlist can carry either, and a miss on one leaves the lists disagreeing.
  assert.equal(isWebSearchToolName('web_search'), true);
  assert.equal(isWebSearchToolName('mcp__edgeone-sandbox__web_search'), true);
  assert.equal(isWebSearchToolName('commands'), false);
  assert.equal(isWebSearchToolName('mcp__edgeone-sandbox__files_read'), false);
});

test('a missing key is a verdict, not a failure to retry', async () => {
  const { calls, search } = searchTool([UNCONFIGURED_REPLY]);

  const first = await search('edgeone project layout');
  const verdict = JSON.parse(replyText(first));

  assert.equal(first.isError, true);
  assert.equal(verdict.retryable, false);
  // The instruction has to send the model somewhere, or it stops mid-task.
  assert.match(verdict.instruction, /load_makers_skill/);
  assert.equal(calls.length, 1);
});

test('the second search of a keyless turn never leaves the process', async () => {
  const { calls, search } = searchTool([UNCONFIGURED_REPLY]);

  await search('first');
  const second = await search('rephrased');

  assert.equal(second.isError, true);
  assert.equal(calls.length, 1, 'the repeat should be answered without a round trip');
});

test('a configured search is passed through untouched', async () => {
  const { calls, search } = searchTool(['[{"title":"2026 World Cup","url":"https://example.com"}]']);

  const result = await search('2026 world cup hosts');

  assert.equal(result.isError, undefined);
  assert.match(replyText(result), /World Cup/);
  assert.equal(calls.length, 1);
});

test('a page that merely mentions the variable is still a search result', () => {
  assert.equal(isWebSearchUnconfigured(UNCONFIGURED_REPLY), true);
  assert.equal(
    isWebSearchUnconfigured('Blog: how we rotate WSA_API_KEY across regions'),
    false,
  );
  assert.equal(isWebSearchUnconfigured(''), false);
});

test('a search is labelled as one, not as the command its query resembles', () => {
  const search = presentToolActivity({
    name: 'mcp__edgeone-sandbox__web_search',
    inputSummary: 'npm run build changelog',
  });

  assert.equal(search.action, 'Search web');
  assert.equal(search.target, 'npm run build changelog');
  assert.equal(TRANSLATIONS.zh.workspace.toolActions['Search web'], '搜索网页');
});
