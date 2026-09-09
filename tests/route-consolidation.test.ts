import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

test('chat uses one route for direct POST streaming and GET reconnect', async () => {
  const route = await readFile('agents/chat.ts', 'utf8');
  const client = await readFile('app/features/workspace/workspace-api.ts', 'utf8');

  assert.match(route, /onRequestPost/);
  assert.match(route, /createChatTaskAndStreamResponse/);
  assert.match(route, /onRequestGet/);
  assert.match(route, /createChatTaskStreamResponse/);
  assert.match(client, /return fetch\('\/chat'/);
  await assert.rejects(access('agents/chat/index.ts'));
});

test('initial resume is one progressive SSE request', async () => {
  const route = await readFile('agents/resume.ts', 'utf8');
  const pipeline = await readFile('agents/pipelines/_resume.ts', 'utf8');
  const client = await readFile('app/features/workspace/workspace-api.ts', 'utf8');

  assert.match(route, /onRequestGet/);
  assert.match(route, /createProjectResumeStreamResponse/);
  assert.match(pipeline, /type: 'resume_history'/);
  assert.match(pipeline, /type: 'resume_workspace'/);
  assert.match(client, /fetch\('\/resume',[\s\S]*?method: 'GET'/);
});

test('file panel performs no automatic or hover prefetch', async () => {
  const source = await readFile('app/components/files-panel.tsx', 'utf8');
  assert.doesNotMatch(source, /prefetch/i);
  assert.doesNotMatch(source, /onMouseEnter/);
  assert.match(source, /fetch\(`\/file\?path=/);
});

test('an untouched new project does not persist an empty conversation', async () => {
  const screen = await readFile('app/features/workspace/workspace-screen.tsx', 'utf8');
  const start = screen.indexOf('function startNewProject()');
  const end = screen.indexOf('function handleNewProject()', start);
  const startBlock = screen.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(startBlock, /clearCachedConversationId\(\)/);
  assert.match(startBlock, /setConversationId\(null\)/);
  assert.doesNotMatch(startBlock, /cacheConversationId\(/);
  assert.doesNotMatch(startBlock, /createConversationId\(/);
});

test('starting a new project does not wait for the old stop request', async () => {
  const screen = await readFile('app/features/workspace/workspace-screen.tsx', 'utf8');
  const client = await readFile('app/features/workspace/workspace-api.ts', 'utf8');
  const stopRoute = await readFile('agents/stop.ts', 'utf8');
  const start = screen.indexOf('function confirmNewProject()');
  const end = screen.indexOf('// Hold the first paint', start);
  const confirmBlock = screen.slice(start, end);
  const abortIndex = stopRoute.indexOf('abortActiveRun');
  const snapshotIndex = stopRoute.indexOf('if (!discardProject)');

  assert.ok(start >= 0 && end > start);
  assert.match(confirmBlock, /void stopCurrentTask\(\{ discardProject: true \}\)/);
  assert.match(confirmBlock, /startNewProject\(\)/);
  assert.doesNotMatch(confirmBlock, /await/);
  assert.match(client, /options\.discardProject \? \{ discardProject: true \} : \{\}/);
  assert.ok(abortIndex >= 0 && snapshotIndex > abortIndex);
  assert.match(stopRoute, /if \(!discardProject\) \{[\s\S]*?persistProjectSnapshot/);
});

test('transcript export is a GET route keyed by conversationId query', async () => {
  const route = await readFile('agents/transcript.ts', 'utf8');
  const pipeline = await readFile('agents/pipelines/_transcript.ts', 'utf8');
  const client = await readFile('app/features/workspace/workspace-api.ts', 'utf8');

  assert.match(route, /onRequestGet/);
  assert.match(route, /runTranscriptPipeline/);
  assert.match(pipeline, /resolveConversationIdPreferQuery/);
  assert.match(pipeline, /application\/x-ndjson/);
  assert.match(client, /fetch\(`?\/transcript\?conversationId=/);
});

// /status is a surface for adopters, not for this app: the workspace learns a
// task's state by reconnecting to GET /chat, so nothing here polls it. Only the
// route contract is pinned.
test('chat task status is a GET route keyed by conversationId query', async () => {
  const route = await readFile('agents/status.ts', 'utf8');
  const pipeline = await readFile('agents/pipelines/_status.ts', 'utf8');

  assert.match(route, /onRequestGet/);
  assert.match(route, /runStatusPipeline/);
  assert.match(pipeline, /resolveConversationIdPreferQuery/);
  assert.match(pipeline, /done: isExportTaskDone\(status\)/);
});

test('workspace persistence uses the sandbox SDK and metadata snapshots are read-only migration data', async () => {
  const helpers = await readFile('agents/pipelines/_helpers.ts', 'utf8');
  const persistence = await readFile('agents/project/_persistence.ts', 'utf8');
  const memory = await readFile('agents/_memory.ts', 'utf8');

  assert.match(helpers, /context\.sandbox\.persist\(\{ path: state\.appDir \}\)/);
  assert.match(persistence, /context\.sandbox\.restore\(\{ path: state\.appDir \}\)/);
  assert.match(persistence, /getLegacyProjectSnapshot/);
  assert.match(persistence, /clearLegacyProjectSnapshot/);
  assert.doesNotMatch(memory, /saveProjectSnapshot/);
  assert.doesNotMatch(memory, /listConversations/);
  assert.doesNotMatch(memory, /deleteConversation/);
});
