import assert from 'node:assert/strict';
import test from 'node:test';
import { consumeEventStream } from '../app/features/workspace/sse.ts';
import type { ChatStreamEvent } from '../shared/protocol.ts';

function responseFromChunks(chunks: string[]) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
}

test('SSE parser handles split frames and stops at DONE', async () => {
  const events: ChatStreamEvent[] = [];
  const response = responseFromChunks([
    'data: {"type":"status","message":"run',
    'ning"}\n\ndata: {"type":"ping","ts":1}\n\n',
    'data: [DONE]\n\ndata: {"type":"error","error":"ignored"}\n\n',
  ]);

  await consumeEventStream<ChatStreamEvent>(response, (event) => events.push(event));
  assert.deepEqual(events, [
    { type: 'status', message: 'running' },
    { type: 'ping', ts: 1 },
  ]);
});

test('SSE parser consumes an unseparated final frame', async () => {
  const events: ChatStreamEvent[] = [];
  await consumeEventStream<ChatStreamEvent>(
    responseFromChunks(['data: {"type":"error","error":"failed"}']),
    (event) => events.push(event),
  );
  assert.deepEqual(events, [{ type: 'error', error: 'failed' }]);
});

test('SSE parser cancels an open response after DONE', async () => {
  const encoder = new TextEncoder();
  let cancelled = false;
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      // Deliberately leave the server side open.
    },
    cancel() {
      cancelled = true;
    },
  }), { headers: { 'content-type': 'text/event-stream' } });

  await consumeEventStream<ChatStreamEvent>(response, () => {});
  assert.equal(cancelled, true);
});
