/**
 * Sandbox command option helpers. Keep this free of sandbox / React imports
 * so tests can share it.
 */

export type SandboxCommandTimeoutOptions = {
  timeout?: number;
  timeoutMs?: number;
  [key: string]: unknown;
};

/** Sandbox APIs honor `timeoutMs`; callers historically pass `timeout` in seconds. */
export function resolveSandboxCommandOptions<T extends SandboxCommandTimeoutOptions>(
  options: T,
): T & { timeoutMs?: number } {
  const timeoutSeconds = typeof options.timeout === 'number' ? options.timeout : undefined;
  const timeoutMs = typeof options.timeoutMs === 'number'
    ? options.timeoutMs
    : timeoutSeconds != null
      ? timeoutSeconds * 1000
      : undefined;
  return {
    ...options,
    ...(timeoutSeconds != null ? { timeout: timeoutSeconds } : {}),
    ...(timeoutMs != null ? { timeoutMs } : {}),
  };
}
