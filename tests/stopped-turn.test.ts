import assert from 'node:assert/strict';
import test from 'node:test';
import { markLastTurnStopped } from '../app/lib/conversation.ts';
import { STOPPED_TURN_REPLY, replyLocaleFor } from '../shared/user-facing-reply.ts';
import type { ChatMessage } from '../app/types/workspace.ts';

const STOPPED = STOPPED_TURN_REPLY.en;

function runningTurn(): ChatMessage[] {
  return [
    { id: 'user-1', role: 'user', content: 'build a landing page' },
    {
      id: 'assistant-1',
      role: 'assistant',
      content: 'Writing the page…',
      status: 'running',
      activities: [
        { kind: 'text', content: 'Writing the page…' },
        {
          kind: 'tool',
          toolUseId: 'tool-1',
          name: 'write_project_file',
          status: 'completed',
          startedAt: 1,
          endedAt: 2,
        },
        {
          kind: 'tool',
          toolUseId: 'tool-2',
          name: 'commands',
          status: 'running',
          startedAt: 3,
        },
      ],
    },
  ];
}

// The screen and the turn persisted through /stop are the same fact derived
// once. These cover the part that used to be derived twice and could disagree.

test('the interrupted turn is stopped in the list and in the payload alike', () => {
  const stopped = markLastTurnStopped(runningTurn(), STOPPED);
  const assistant = stopped.messages[1];

  assert.equal(assistant.status, 'stopped');
  assert.equal(assistant.content, STOPPED);
  // The payload carries the same array object the screen renders, so the two
  // cannot describe different tools.
  assert.equal(assistant.activities, stopped.activities);
  assert.equal(stopped.userContent, 'build a landing page');
});

test('only the tools still running are marked stopped', () => {
  const { activities } = markLastTurnStopped(runningTurn(), STOPPED);

  assert.deepEqual(
    activities.map((activity) => (activity.kind === 'tool' ? activity.status : activity.kind)),
    ['text', 'completed', 'stopped'],
  );
  // A tool that had already finished keeps the time it actually finished at.
  const finished = activities[1];
  assert.equal(finished.kind === 'tool' && finished.endedAt, 2);
  // The interrupted one is stamped, and with a single click time rather than one
  // Date.now() per array position.
  const interrupted = activities[2];
  assert.ok(interrupted.kind === 'tool' && typeof interrupted.endedAt === 'number');
});

test('turns that are not running are left exactly as they are', () => {
  const settled: ChatMessage[] = [
    { id: 'user-1', role: 'user', content: 'first' },
    { id: 'assistant-1', role: 'assistant', content: 'done', status: 'done' },
  ];
  const stopped = markLastTurnStopped(settled, STOPPED);

  // Same array back: a stop that races the turn's own completion must not
  // rewrite a reply the agent already delivered.
  assert.equal(stopped.messages, settled);
  assert.deepEqual(stopped.activities, []);
  assert.equal(stopped.userContent, 'first');
});

test('earlier turns keep their identity so memoized turns do not re-render', () => {
  const messages: ChatMessage[] = [
    { id: 'user-1', role: 'user', content: 'first' },
    { id: 'assistant-1', role: 'assistant', content: 'done', status: 'done' },
    ...runningTurn().map((message, index) => ({ ...message, id: `${message.id}-b${index}` })),
  ];
  const stopped = markLastTurnStopped(messages, STOPPED);

  assert.equal(stopped.messages[0], messages[0]);
  assert.equal(stopped.messages[1], messages[1]);
  assert.notEqual(stopped.messages[3], messages[3]);
  // The prompt for the interrupted turn, not the first one in the conversation.
  assert.equal(stopped.userContent, 'build a landing page');
});

test('the stopped reply is one definition, in the language of the request', () => {
  assert.equal(replyLocaleFor('做一个留言板'), 'zh');
  assert.equal(replyLocaleFor('build a guestbook'), 'en');
  // Mixed input follows the CJK it contains, which is how the request reads.
  assert.equal(replyLocaleFor('给 landing page 加个表单'), 'zh');

  assert.match(STOPPED_TURN_REPLY.zh, /已停止/);
  assert.match(STOPPED_TURN_REPLY.en, /^Generation stopped\./);
});
