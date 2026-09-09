import assert from 'node:assert/strict';
import test from 'node:test';
import {
  appendTrimmedActivityTurn,
  dedupeActivityTurns,
  summarizeToolInput,
  summarizeToolOutput,
} from '../agents/utils/_activity.ts';
import type { PersistedActivityTurn } from '../agents/_types.ts';

test('tool summaries redact secrets and project paths', () => {
  const summary = summarizeToolInput('mcp__edgeone__commands', {
    command: 'curl -H "Authorization: Bearer top-secret" /tmp/project/api?token=abc',
    apiKey: 'secret-key',
  }, '/tmp/project');

  assert.doesNotMatch(summary, /top-secret|secret-key|token=abc/);
  assert.match(summary, /\[REDACTED\]/);
  assert.match(summary, /<project>/);
});

test('activity history collapses immediate retry duplicates', () => {
  const base: PersistedActivityTurn = {
    id: 'first',
    user: 'stop this',
    assistant: 'stopped',
    status: 'stopped',
    createdAt: 100,
    activities: [],
  };
  const deduped = dedupeActivityTurns([
    base,
    { ...base, id: 'retry', createdAt: 200, activities: [{ kind: 'text', content: 'partial' }] },
  ]);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].id, 'retry');
});

test('file writes expose paths and sizes without source contents', () => {
  const summary = summarizeToolInput('write_project_file', {
    path: 'src/app.tsx',
    content: 'const privateValue = 42;',
  });

  assert.match(summary, /src\/app\.tsx/);
  assert.match(summary, /24 chars/);
  assert.doesNotMatch(summary, /privateValue/);
});

test('a streamed single-file call stays blank until its path arrives', () => {
  assert.equal(summarizeToolInput('write_project_file', {}), '');
});

test('directory tools summarize as a path, not JSON', () => {
  assert.equal(summarizeToolInput('mcp__edgeone-sandbox__files_make_dir', { path: 'src/lib' }), 'src/lib');
});

test('Skill activity shows the skill name and drops the echoed launch line', () => {
  assert.equal(summarizeToolInput('Skill', { skill: 'edgeone-makers-tools' }), 'edgeone-makers-tools');
  assert.equal(summarizeToolOutput('Launching skill: edgeone-makers-tools', '', 'Skill'), '');
  assert.match(summarizeToolOutput('Skill not found: nope', '', 'Skill'), /Skill not found/);
});

test('specific Makers skill activity shows its reference and hides the document body', () => {
  const name = 'mcp__edgeone-sandbox__load_makers_skill';
  assert.equal(summarizeToolInput(name, { skill: 'makers-agents' }), 'makers-agents');
  assert.equal(summarizeToolOutput('---\nname: edgeone-makers-agents\n---\nGuide', '', name), '');
  assert.match(summarizeToolOutput('Unable to load Makers skill: missing', '', name), /Unable to load/);
});

test('tool output is capped at two kilobytes', () => {
  const summary = summarizeToolOutput('x'.repeat(3_000));
  assert.ok(summary.length < 2_100);
  assert.match(summary, /truncated$/);
});

test('activity history replaces duplicate turns and applies both caps', () => {
  const makeTurn = (id: string, count = 1): PersistedActivityTurn => ({
    id,
    user: id,
    assistant: id,
    status: 'completed',
    createdAt: 1,
    activities: Array.from({ length: count }, (_, index) => ({
      kind: 'text' as const,
      content: `${id}-${index}`,
    })),
  });
  const current = [makeTurn('one'), makeTurn('two')];
  const next = appendTrimmedActivityTurn(current, makeTurn('two', 4), 2, 3);

  assert.deepEqual(next.map((turn) => turn.id), ['one', 'two']);
  assert.equal(next[1].activities.length, 3);
  assert.equal(next[1].activities[0].kind === 'text' && next[1].activities[0].content, 'two-1');
});
