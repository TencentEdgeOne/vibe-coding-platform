export function sseEvent(data: Record<string, unknown>): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

export function createSSEResponse(
  generator: (signal?: AbortSignal) => AsyncGenerator<string>,
  signal?: AbortSignal,
) {
  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream({
    async start(controller) {
      const enqueue = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };

      const heartbeat = setInterval(() => {
        enqueue(sseEvent({ type: 'ping', ts: Date.now() }));
      }, 5_000);

      try {
        for await (const chunk of generator(signal)) {
          if (signal?.aborted) break;
          enqueue(chunk);
        }
        if (!signal?.aborted) {
          enqueue('data: [DONE]\n\n');
        }
      } catch (error) {
        if (!signal?.aborted && !(error instanceof Error && error.name === 'AbortError')) {
          enqueue(sseEvent({
            type: 'error',
            error: error instanceof Error ? error.message : 'Request processing failed.',
          }));
          enqueue('data: [DONE]\n\n');
        }
      } finally {
        clearInterval(heartbeat);
        closed = true;
        try {
          controller.close();
        } catch {
          // The client may already have disconnected.
        }
      }
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}
