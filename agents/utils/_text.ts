export { sanitizeAssistantText } from '../../shared/sanitize-assistant-text.ts';

export function stringifyToolResult(result: unknown) {
  if (typeof result === 'string') {
    return result;
  }
  const json = JSON.stringify(result, null, 2);
  return typeof json === 'string' ? json : String(result);
}

// Detect whether tool_result text indicates a sandbox infrastructure failure:
// - "Not Found": LazySandbox's characteristic response when some routes are not initialized.
// - "Sandbox is not initialized": LazySandbox initialization failure.
// - "Running instances limit exceeded": sandbox instance quota is full; retries are not useful.
// - "Duplicate request detected": duplicate sandbox startup request; continuing would pollute context.
// Any match is fatal for the current agent run.
export function detectFatalToolError(text: string): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  // Match strictly so a literal "not found" in user files is not treated as infrastructure failure.
  if (/^Not Found\.?$/i.test(trimmed)) {
    return 'The EdgeOne sandbox API returned Not Found. Sandbox infrastructure is unavailable, so this agent run was stopped.';
  }
  if (/Sandbox is not initialized/i.test(trimmed)) {
    return 'The EdgeOne sandbox is not initialized, so this agent run was stopped.';
  }
  if (/Running instances limit exceeded(?:\s*\(max\s+\d+\))?/i.test(trimmed)) {
    return 'The EdgeOne sandbox running-instance limit has been reached, so this agent run was stopped.';
  }
  if (/Duplicate request detected\.\s*Please check your previous request result\.?/i.test(trimmed)) {
    return 'A duplicate EdgeOne sandbox startup request was detected, so this agent run was stopped.';
  }
  return null;
}

export function truncateForStream(text: string, max: number): string {
  if (typeof text !== 'string') return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…(truncated ${text.length - max}b)`;
}

export function truncateForPrompt(text: string, max: number): string {
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[Log truncated; ${text.length - max} characters were omitted]`;
}
