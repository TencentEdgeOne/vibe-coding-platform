/** Consume Makers SSE framing without coupling transport parsing to React state. */
export async function consumeEventStream<T>(
  response: Response,
  onEvent: (event: T) => void,
) {
  if (!response.body) return;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let done = false;

  const consumeFrames = (flush = false) => {
    const frames = flush ? [buffer] : buffer.split('\n\n');
    buffer = flush ? '' : frames.pop() || '';
    for (const frame of frames) {
      const data = frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (!data) continue;
      if (data === '[DONE]') {
        done = true;
        break;
      }
      onEvent(JSON.parse(data) as T);
    }
  };

  try {
    while (!done) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      consumeFrames();
    }

    buffer += decoder.decode();
    if (!done && buffer.trim()) consumeFrames(true);
  } finally {
    // A server may emit [DONE] before it closes the HTTP response. Explicitly
    // cancel the reader so the keep-alive socket cannot block makers-dev SIGINT.
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
