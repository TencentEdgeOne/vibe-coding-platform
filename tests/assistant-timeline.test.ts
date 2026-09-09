import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildAssistantTimeline,
  lastTimelineText,
  trailingTimelineContent,
} from '../app/lib/assistant-timeline.ts';
import type { AssistantActivity } from '../shared/protocol.ts';

const writeFile = (id: string, path: string): AssistantActivity => ({
  kind: 'tool',
  toolUseId: id,
  name: 'write_project_file',
  status: 'completed',
  inputSummary: path,
});

test('buildAssistantTimeline interleaves text with consecutive tool chains', () => {
  const blocks = buildAssistantTimeline([
    { kind: 'text', content: 'Starting the landing page.' },
    writeFile('t1', 'package.json'),
    writeFile('t2', 'index.html'),
    { kind: 'text', content: 'Preview is ready.' },
    writeFile('t3', 'styles.css'),
  ]);

  assert.equal(blocks.length, 4);
  assert.equal(blocks[0].kind, 'text');
  assert.equal(blocks[0].kind === 'text' && blocks[0].content, 'Starting the landing page.');
  assert.equal(blocks[1].kind, 'tools');
  assert.deepEqual(
    blocks[1].kind === 'tools' ? blocks[1].items.map((item) => item.activity.toolUseId) : [],
    ['t1', 't2'],
  );
  assert.equal(blocks[2].kind, 'text');
  assert.equal(blocks[2].kind === 'text' && blocks[2].content, 'Preview is ready.');
  assert.equal(blocks[3].kind, 'tools');
  assert.equal(blocks[3].kind === 'tools' && blocks[3].items[0]?.activity.toolUseId, 't3');
});

test('buildAssistantTimeline skips empty text and keeps tool order', () => {
  const blocks = buildAssistantTimeline([
    { kind: 'text', content: '   ' },
    writeFile('t1', 'a.ts'),
    { kind: 'text', content: 'Done.' },
  ]);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].kind, 'tools');
  assert.equal(blocks[1].kind, 'text');
  assert.equal(lastTimelineText(blocks)?.content, 'Done.');
});

// Reading up on a subject takes an overview and then several documents beneath
// it, and every one of those calls prints the same label — the run that
// prompted this showed "AI endpoints, in depth" three times in a row, which
// reads as a stuck timeline rather than as three steps of progress.
test('reference loads of one topic collapse into a single row', () => {
  const load = (id: string, skill: string, ref?: string): AssistantActivity => ({
    kind: 'tool',
    toolUseId: id,
    name: 'mcp__edgeone-sandbox__load_makers_skill',
    status: 'completed',
    inputSummary: ref ? JSON.stringify({ skill, ref }) : skill,
  });

  const [chain] = buildAssistantTimeline([
    load('s1', 'makers-agents'),
    load('s2', 'makers-agents', 'platform/node-entry.md'),
    load('s3', 'makers-agents', 'platform/sse-protocol.md'),
    load('s4', 'makers-recipes'),
    writeFile('t1', 'app/page.tsx'),
  ]);

  assert.equal(chain.kind, 'tools');
  const items = chain.kind === 'tools' ? chain.items : [];
  assert.deepEqual(
    items.map((item) => item.activity.toolUseId),
    ['s1', 's2', 's4', 't1'],
    'the overview, the documents under it, and a second topic are three rows',
  );
  // Nothing is dropped: the folded calls stay on the row that speaks for them,
  // which is what lets the panel list every document it read.
  assert.deepEqual(items[1].repeats.map((repeat) => repeat.toolUseId), ['s3']);
  assert.deepEqual(items.map((item) => item.repeats.length), [0, 1, 0, 0]);
  assert.deepEqual(items.map((item) => item.index), [0, 1, 3, 4]);

  // Narration says what the agent turns to next, so a load after it is a new
  // step even when it lands on a topic already read.
  const resumed = buildAssistantTimeline([
    load('s1', 'makers-agents', 'platform/node-entry.md'),
    { kind: 'text', content: 'Now the streaming protocol.' },
    load('s2', 'makers-agents', 'platform/sse-protocol.md'),
  ]);
  assert.deepEqual(resumed.map((block) => block.kind), ['tools', 'text', 'tools']);
  assert.equal(resumed[2].kind === 'tools' && resumed[2].items.length, 1);
});

test('trailingTimelineContent keeps leftover reply after the last streamed text', () => {
  assert.equal(
    trailingTimelineContent(
      'I will write the homepage files.',
      'I will write the homepage files.',
      'done',
    ),
    '',
  );
  assert.equal(
    trailingTimelineContent(
      'I will write the homepage files.',
      'I will write the homepage files. Preview is ready.',
      'done',
    ),
    'Preview is ready.',
  );
  assert.equal(
    trailingTimelineContent(
      'Writing files',
      'Generation stopped. You can continue with another change.',
      'stopped',
    ),
    'Generation stopped. You can continue with another change.',
  );
  assert.equal(trailingTimelineContent('Thinking', 'Boom', 'error'), 'Boom');
  assert.equal(trailingTimelineContent('Thinking', 'Thinking more', 'running'), '');
});
