import assert from 'node:assert/strict';
import test from 'node:test';
import {
  lastFinishedAssistant,
  resolveDeployOffer,
  type DeployOfferMessage,
} from '../app/lib/tool-activity.ts';

const writeTurn: DeployOfferMessage = {
  id: 'a1',
  role: 'assistant',
  status: 'done',
  activities: [
    { kind: 'tool', name: 'files_write', inputSummary: 'app/page.tsx', status: 'completed' },
  ],
};

const deployTurn = (status: 'completed' | 'failed'): DeployOfferMessage => ({
  id: 'a-deploy',
  role: 'assistant',
  status: 'done',
  activities: [
    {
      kind: 'tool',
      name: 'commands',
      inputSummary: 'edgeone makers deploy --json',
      status,
    },
  ],
});

test('a finished project turn offers the first deploy', () => {
  assert.equal(resolveDeployOffer([writeTurn], { canDownload: true, loading: false }), 'first');
});

test('the offer waits until the project exists and the agent is idle', () => {
  assert.equal(resolveDeployOffer([writeTurn], { canDownload: false, loading: false }), null);
  assert.equal(resolveDeployOffer([writeTurn], { canDownload: true, loading: true }), null);
  assert.equal(
    resolveDeployOffer([{ ...writeTurn, status: 'running' }], { canDownload: true, loading: false }),
    null,
  );
});

test('a later edit after a live site offers republish', () => {
  const messages: DeployOfferMessage[] = [
    deployTurn('completed'),
    { ...writeTurn, id: 'a2' },
  ];
  assert.equal(resolveDeployOffer(messages, { canDownload: true, loading: false }), 'again');
});

test('a live deployment without a deploy row still offers republish', () => {
  assert.equal(
    resolveDeployOffer([writeTurn], {
      canDownload: true,
      loading: false,
      hasLiveDeployment: true,
    }),
    'again',
  );
});

test('a successful deploy turn does not ask again', () => {
  assert.equal(
    resolveDeployOffer([deployTurn('completed')], { canDownload: true, loading: false }),
    null,
  );
});

test('a failed deploy turn does not offer again — the stream already has the failure', () => {
  assert.equal(
    resolveDeployOffer([deployTurn('failed')], { canDownload: true, loading: false }),
    null,
  );
});

test('a finished Q&A turn does not nag after the project already has tools', () => {
  assert.equal(
    resolveDeployOffer([
      writeTurn,
      { id: 'a4', role: 'assistant', status: 'done', activities: [{ kind: 'text' }] },
    ], { canDownload: true, loading: false }),
    null,
  );
});

test('a restored workspace with no tool history still offers the first deploy', () => {
  assert.equal(
    resolveDeployOffer([
      { id: 'u1', role: 'user', status: 'done' },
      { id: 'a5', role: 'assistant', status: 'done', activities: [] },
    ], { canDownload: true, loading: false }),
    'first',
  );
});

test('lastFinishedAssistant skips a still-running turn', () => {
  const last = lastFinishedAssistant([
    writeTurn,
    { id: 'a6', role: 'assistant', status: 'running', activities: [] },
  ]);
  assert.equal(last?.id, 'a1');
});
