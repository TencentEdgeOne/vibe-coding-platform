import type { PersistedActivityTurn } from '../_types.ts';

const SUMMARY_LIMIT = 2_000;
const SENSITIVE_KEY = /(authorization|cookie|password|passwd|secret|token|api[_-]?key|private[_-]?key|credential)/i;

function truncate(value: string, limit = SUMMARY_LIMIT) {
  const normalized = value.replace(/\x1b\[[0-9;?]*[~A-Za-z]/g, '').trim();
  return normalized.length > limit ? `${normalized.slice(0, limit)}\n... truncated` : normalized;
}

function redactInlineSecrets(value: string) {
  return value
    .replace(/(authorization\s*:\s*)(?:bearer\s+)?[^"'\s]+(?:\s+[^"'\s]+)?/gi, '$1[REDACTED]')
    .replace(/((?:authorization|cookie|password|passwd|secret|token|api[_-]?key|private[_-]?key)\s*[:=]\s*)([^\s,;]+)/gi, '$1[REDACTED]')
    .replace(/(bearer\s+)[A-Za-z0-9._~+\/-]+/gi, '$1[REDACTED]');
}

function safeValue(value: unknown, projectDir: string, depth = 0): unknown {
  if (depth > 4) return '[nested value omitted]';
  if (typeof value === 'string') {
    const withoutProjectPath = projectDir ? value.split(projectDir).join('<project>') : value;
    return truncate(redactInlineSecrets(withoutProjectPath), 600);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value == null) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => safeValue(item, projectDir, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 30)
        .map(([key, child]) => [
          key,
          SENSITIVE_KEY.test(key) ? '[REDACTED]' : safeValue(child, projectDir, depth + 1),
        ]),
    );
  }
  return String(value);
}

function summarizeFileWrites(input: Record<string, unknown>) {
  const files = Array.isArray(input.files) ? input.files : [];
  if (files.length === 0) return '';
  return files.slice(0, 30).map((file) => {
    const record = file && typeof file === 'object' ? file as Record<string, unknown> : {};
    const path = typeof record.path === 'string' ? record.path : '<unknown>';
    const length = typeof record.content === 'string' ? record.content.length : 0;
    return `${path} (${length.toLocaleString('en-US')} chars)`;
  }).join('\n');
}

export function summarizeToolInput(name: string, input: unknown, projectDir = '') {
  const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const shortName = name.replace(/^mcp__[^_]+__/, '');

  if (shortName === 'Skill' || shortName === 'load_makers_skill') {
    const skill = typeof record.skill === 'string' ? record.skill : '';
    const ref = typeof record.ref === 'string' ? record.ref.trim() : '';
    // A deeper document is a second load of a reference already on screen, so
    // without the ref the two rows are indistinguishable and the timeline looks
    // like it is repeating itself. Kept plain when there is no ref, which is
    // every row persisted before this and every load of an overview.
    return truncate(ref ? JSON.stringify({ skill, ref }) : skill, 200);
  }
  if (shortName === 'write_project_files') {
    return truncate(summarizeFileWrites(record) || 'Project files');
  }
  if (shortName === 'write_project_file' || shortName === 'files_write' || shortName === 'write_files') {
    if (typeof record.path !== 'string' && typeof record.content !== 'string') return '';
    const path = typeof record.path === 'string' ? record.path : '<pending path>';
    const length = typeof record.content === 'string' ? record.content.length : 0;
    return `${path} (${length.toLocaleString('en-US')} chars)`;
  }
  if (shortName === 'commands') {
    const command = typeof record.command === 'string'
      ? record.command
      : typeof record.cmd === 'string'
        ? record.cmd
        : '';
    return truncate(redactInlineSecrets(projectDir ? command.split(projectDir).join('<project>') : command));
  }
  if (
    shortName === 'files_make_dir'
    || shortName === 'files_remove'
    || shortName === 'files_exists'
    || shortName === 'files_read'
    || shortName === 'files_list'
  ) {
    const path = typeof record.path === 'string'
      ? record.path
      : typeof record.file_path === 'string'
        ? record.file_path
        : '';
    return path ? truncate(projectDir ? path.split(projectDir).join('<project>') : path) : '';
  }

  return truncate(JSON.stringify(safeValue(record, projectDir), null, 2));
}

export function summarizeToolOutput(value: string, projectDir = '', name = '') {
  // The SDK answers a successful Skill call with "Launching skill: <name>",
  // which only repeats the row header. Keep real failures.
  if (name.replace(/^mcp__[^_]+__/, '') === 'Skill' && /^launching skill:/i.test(value.trim())) {
    return '';
  }
  if (
    name.replace(/^mcp__[^_]+__/, '') === 'load_makers_skill'
    && /^---\s*\nname:/i.test(value.trim())
  ) {
    return '';
  }
  const withoutProjectPath = projectDir ? value.split(projectDir).join('<project>') : value;
  return truncate(redactInlineSecrets(withoutProjectPath));
}

export function appendTrimmedActivityTurn(
  current: PersistedActivityTurn[],
  turn: PersistedActivityTurn,
  turnLimit = 25,
  itemLimit = 50,
) {
  const nextTurn = { ...turn, activities: turn.activities.slice(-itemLimit) };
  return [...current.filter((item) => item.id !== turn.id), nextTurn].slice(-turnLimit);
}

export function dedupeActivityTurns(turns: PersistedActivityTurn[]) {
  const result: PersistedActivityTurn[] = [];
  for (const turn of turns) {
    const previous = result.at(-1);
    const isRetryDuplicate = previous
      && previous.user === turn.user
      && previous.assistant === turn.assistant
      && previous.status === turn.status
      && Math.abs(previous.createdAt - turn.createdAt) < 30_000;
    if (!isRetryDuplicate) {
      result.push(turn);
      continue;
    }
    if (turn.activities.length >= previous.activities.length) {
      result[result.length - 1] = turn;
    }
  }
  return result;
}
