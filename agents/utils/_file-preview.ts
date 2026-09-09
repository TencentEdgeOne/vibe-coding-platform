export type PreviewReadResult = {
  ok: boolean;
  content?: string;
  size?: number;
  truncated?: boolean;
  error?: string;
};

export function truncateUtf8(content: string, maxBytes: number) {
  const encoded = new TextEncoder().encode(content);
  const size = encoded.byteLength;
  if (size <= maxBytes) {
    return { content, size, truncated: false };
  }

  const decoder = new TextDecoder('utf-8', { fatal: true });
  let end = maxBytes;
  while (end > Math.max(0, maxBytes - 4)) {
    try {
      return {
        content: decoder.decode(encoded.subarray(0, end)),
        size,
        truncated: true,
      };
    } catch {
      end -= 1;
    }
  }

  return { content: '', size, truncated: true };
}

export function capBatchReadResults(
  results: Array<PreviewReadResult & { path: string }>,
  maxBytes: number,
) {
  const encoder = new TextEncoder();
  let responseBytes = 0;
  return results.map((result) => {
    if (!result.ok) return result;
    const bytes = typeof result.content === 'string'
      ? encoder.encode(result.content).byteLength
      : 0;
    if (responseBytes + bytes > maxBytes) {
      return {
        path: result.path,
        ok: false,
        error: 'Batch response byte limit exceeded; request this file separately.',
      };
    }
    responseBytes += bytes;
    return result;
  });
}
