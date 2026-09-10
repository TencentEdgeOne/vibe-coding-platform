import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  buildTranscriptJsonl,
  conversationExportFilename,
  conversationToJsonl,
  isExportTaskDone,
  mergeInFlightExportTask,
  redactExportText,
  resolveExportTaskStatus,
  turnsToExportMessages,
} from '../shared/conversation-export.ts';

test('conversationToJsonl flattens UI messages into one event per line', () => {
  const jsonl = conversationToJsonl({
    conversationId: 'conv-abc',
    exportedAt: '2026-08-17T12:00:00.000Z',
    messages: [
      { id: 'u1', role: 'user', content: 'Build a landing page', status: 'done' },
      {
        id: 'a1',
        role: 'assistant',
        content: 'Done.',
        status: 'done',
        activities: [
          { kind: 'text', content: 'Writing files' },
          {
            kind: 'tool',
            name: 'mcp__edgeone-sandbox__write_project_file',
            status: 'completed',
            toolUseId: 't1',
            inputSummary: 'package.json (145 chars)',
            outputSummary: '{\n  "written": "package.json"\n}',
            startedAt: Date.parse('2026-08-17T12:00:01.000Z'),
            endedAt: Date.parse('2026-08-17T12:00:02.000Z'),
          },
          { kind: 'text', content: 'Done.' },
        ],
      },
    ],
  });

  const lines = jsonl.trimEnd().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(lines, [
    {
      type: 'session',
      conversation_id: 'conv-abc',
      exported_at: '2026-08-17T12:00:00.000Z',
      event_count: 4,
      task_status: 'idle',
    },
    { type: 'user', content: 'Build a landing page' },
    { type: 'assistant', content: 'Writing files' },
    {
      type: 'tool',
      id: 't1',
      name: 'write_project_file',
      status: 'completed',
      input: 'package.json (145 chars)',
      output: { written: 'package.json' },
      started_at: '2026-08-17T12:00:01.000Z',
      ended_at: '2026-08-17T12:00:02.000Z',
    },
    { type: 'assistant', content: 'Done.' },
  ]);
  assert.match(jsonl, /\n$/);
});

test('conversationToJsonl does not duplicate the final assistant reply already in activities', () => {
  const jsonl = conversationToJsonl({
    conversationId: 'c1',
    exportedAt: '2026-08-17T12:00:00.000Z',
    messages: [{
      role: 'assistant',
      content: 'All set.',
      activities: [{ kind: 'text', content: 'All set.' }],
    }],
  });
  const types = jsonl.trimEnd().split('\n').slice(1).map((line) => JSON.parse(line).type);
  assert.deepEqual(types, ['assistant']);
});

test('conversationToJsonl preserves multiline content as a single JSONL record', () => {
  const jsonl = conversationToJsonl({
    conversationId: 'c1',
    exportedAt: '2026-08-17T12:00:00.000Z',
    messages: [{ role: 'user', content: 'line 1\nline 2' }],
  });
  const lines = jsonl.trimEnd().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[1]).content, 'line 1\nline 2');
});

test('redactExportText strips tokens and preview query params', () => {
  const raw = [
    "edgeone makers deploy -n demo -t 'super-secret-token=' --json",
    'https://demo.edgeone.cool?eo_token=abc123',
    'Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz',
    'TOKEN=abc TOKEN=xyz',
  ].join('\n');
  const redacted = redactExportText(raw);
  assert.doesNotMatch(redacted, /super-secret-token/);
  assert.doesNotMatch(redacted, /abc123/);
  assert.doesNotMatch(redacted, /sk-abcdefghijklmnopqrstuvwxyz/);
  assert.match(redacted, /\[REDACTED\]/);
});

test('conversationToJsonl redacts secrets inside tool payloads', () => {
  const jsonl = conversationToJsonl({
    exportedAt: '2026-08-17T12:00:00.000Z',
    messages: [{
      role: 'assistant',
      content: '',
      activities: [{
        kind: 'tool',
        name: 'commands',
        status: 'completed',
        toolUseId: 't1',
        inputSummary: "edgeone makers deploy -t 'leak-me-now' --json",
        outputSummary: 'token=leak-me-now',
      }],
    }],
  });
  assert.doesNotMatch(jsonl, /leak-me-now/);
  assert.match(jsonl, /\[REDACTED\]/);
});

test('turnsToExportMessages maps persisted activity turns the same way as the UI', () => {
  const messages = turnsToExportMessages([{
    id: 'turn-1',
    user: 'Build a landing page',
    assistant: 'Done.',
    status: 'completed',
    activities: [{ kind: 'text', content: 'Done.' }],
  }]);
  assert.deepEqual(messages.map((message) => ({ id: message.id, role: message.role, status: message.status })), [
    { id: 'turn-1-user', role: 'user', status: undefined },
    { id: 'turn-1-assistant', role: 'assistant', status: 'done' },
  ]);
});

test('buildTranscriptJsonl prefers activity turns over plain history', () => {
  const jsonl = buildTranscriptJsonl({
    conversationId: 'conv-abc',
    exportedAt: '2026-08-17T12:00:00.000Z',
    turns: [{
      id: 'turn-1',
      user: 'Build a landing page',
      assistant: 'Done.',
      status: 'completed',
      activities: [{ kind: 'text', content: 'Done.' }],
    }],
    history: [{ role: 'user', content: 'stale history' }],
  });
  assert.match(jsonl, /Build a landing page/);
  assert.doesNotMatch(jsonl, /stale history/);
  assert.equal(JSON.parse(jsonl.trimEnd().split('\n')[0]).event_count, 2);
  assert.equal(JSON.parse(jsonl.trimEnd().split('\n')[0]).task_status, 'idle');
});

test('buildTranscriptJsonl copies chat task status onto the session line', () => {
  const jsonl = buildTranscriptJsonl({
    conversationId: 'conv-abc',
    exportedAt: '2026-08-17T12:00:00.000Z',
    task: { id: 'task-9', message: 'Build a landing page', status: 'running' },
  });
  assert.equal(JSON.parse(jsonl.trimEnd().split('\n')[0]).task_status, 'running');
});

test('resolveExportTaskStatus treats missing tasks as idle and terminal statuses as done', () => {
  assert.equal(resolveExportTaskStatus(null), 'idle');
  assert.equal(resolveExportTaskStatus({ status: 'running' }), 'running');
  assert.equal(isExportTaskDone('running'), false);
  assert.equal(isExportTaskDone('idle'), false);
  assert.equal(isExportTaskDone('completed'), true);
  assert.equal(isExportTaskDone('failed'), true);
  assert.equal(isExportTaskDone('stopped'), true);
});

test('mergeInFlightExportTask appends a running turn that is not persisted yet', () => {
  const merged = mergeInFlightExportTask([], {
    id: 'task-9',
    message: 'Fix the header',
    status: 'running',
  });
  assert.equal(merged[0].content, 'Fix the header');
  assert.equal(merged[1].status, 'running');
});

test('conversationExportFilename includes a short conversation id and timestamp', () => {
  const filename = conversationExportFilename(
    'abcdefghijklmnop',
    new Date('2026-08-17T12:34:56.789Z'),
  );
  assert.equal(filename, 'vibe-coding-conversation-abcdefgh-2026-08-17T12-34-56-789Z.jsonl');
});

test('workspace topbar does not show the conversation export control', async () => {
  const workspace = await readFile('app/features/workspace/workspace-screen.tsx', 'utf8');
  const header = await readFile('app/features/workspace/components/site-header.tsx', 'utf8');
  assert.doesNotMatch(workspace, /handleExportTranscript|exportHint|exportTranscript/);
  assert.doesNotMatch(workspace, /fetchConversationTranscript|ScrollText/);
  assert.doesNotMatch(header, /exportTranscript|downloadSource/);
});
