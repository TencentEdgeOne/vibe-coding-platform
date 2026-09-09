/**
 * Serialize a vibe-coding conversation into JSONL (one event per line).
 * Runtime-agnostic so tests can cover the format without the browser.
 *
 * Flatten the UI's {messages, activities} dump into a readable transcript:
 *   session → user → assistant (narration) → tool → assistant → …
 */

export type ConversationExportActivity = {
  kind: 'text' | 'tool' | string;
  content?: string;
  toolUseId?: string;
  name?: string;
  status?: string;
  inputSummary?: string;
  outputSummary?: string;
  startedAt?: number;
  endedAt?: number;
};

export type ConversationExportMessage = {
  id?: string;
  role: 'user' | 'assistant';
  content: string;
  status?: string;
  activities?: ConversationExportActivity[];
};

export type ConversationExportInput = {
  conversationId?: string | null;
  exportedAt?: string;
  taskStatus?: string | null;
  messages: ConversationExportMessage[];
};

export type ExportTaskStatus = 'idle' | 'queued' | 'running' | 'completed' | 'failed' | 'stopped';

export function resolveExportTaskStatus(task?: { status?: string } | null): ExportTaskStatus {
  const status = task?.status;
  if (
    status === 'queued'
    || status === 'running'
    || status === 'completed'
    || status === 'failed'
    || status === 'stopped'
  ) {
    return status;
  }
  return 'idle';
}

export function isExportTaskDone(status: ExportTaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'stopped';
}

export type ConversationExportTurn = {
  id?: string;
  user: string;
  assistant: string;
  status?: string;
  activities?: ConversationExportActivity[];
};

export function mapExportTurnStatus(status?: string) {
  if (!status) return undefined;
  if (status === 'completed' || status === 'done') return 'done';
  if (status === 'failed' || status === 'error') return 'error';
  if (status === 'stopped' || status === 'running') return status;
  return status;
}

export function turnsToExportMessages(turns: ConversationExportTurn[]): ConversationExportMessage[] {
  return turns.flatMap((turn) => [
    {
      ...(turn.id ? { id: `${turn.id}-user` } : {}),
      role: 'user' as const,
      content: turn.user,
    },
    {
      ...(turn.id ? { id: `${turn.id}-assistant` } : {}),
      role: 'assistant' as const,
      content: turn.assistant,
      status: mapExportTurnStatus(turn.status),
      activities: turn.activities,
    },
  ]);
}

export function mergeInFlightExportTask(
  messages: ConversationExportMessage[],
  task?: { id?: string; message?: string; status?: string } | null,
): ConversationExportMessage[] {
  if (!task?.id || !task.message?.trim()) return messages;
  if (task.status === 'completed' || task.status === 'failed' || task.status === 'stopped') {
    return messages;
  }
  if (messages.some((message) => message.id === `${task.id}-user` || message.id === task.id)) {
    return messages;
  }
  return [
    ...messages,
    { id: `${task.id}-user`, role: 'user', content: task.message },
    { id: `${task.id}-assistant`, role: 'assistant', content: '', status: 'running' },
  ];
}

export function buildTranscriptJsonl(options: {
  conversationId: string;
  exportedAt?: string;
  turns?: ConversationExportTurn[];
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  task?: { id?: string; message?: string; status?: string } | null;
}): string {
  const messages = mergeInFlightExportTask(
    (options.turns?.length ?? 0) > 0
      ? turnsToExportMessages(options.turns!)
      : (options.history || []),
    options.task,
  );
  return conversationToJsonl({
    conversationId: options.conversationId,
    exportedAt: options.exportedAt,
    taskStatus: options.task?.status,
    messages,
  });
}

export function redactExportText(value: string): string {
  return value
    .replace(/\x1b\[[0-9;?]*[~A-Za-z]/g, '')
    .replace(/(-t|--token)\s+(['"]?)[^\s'"]+\2/gi, '$1 $2[REDACTED]$2')
    .replace(/(eo_token=)[^&\s"']+/gi, '$1[REDACTED]')
    .replace(/(authorization\s*:\s*)(?:bearer\s+)?[^"'\s]+(?:\s+[^"'\s]+)?/gi, '$1[REDACTED]')
    .replace(
      /((?:authorization|cookie|password|passwd|secret|token|api[_-]?key|private[_-]?key)\s*[:=]\s*)([^\s,;"']+)/gi,
      '$1[REDACTED]',
    )
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9]{16,}/g, '[REDACTED]')
    .replace(/\bTOKEN=[^\s;]+/g, 'TOKEN=[REDACTED]');
}

export function conversationToJsonl(input: ConversationExportInput): string {
  const exportedAt = input.exportedAt || new Date().toISOString();
  const conversationId = input.conversationId?.trim() || null;
  const events: Record<string, unknown>[] = [];

  for (const message of input.messages) {
    if (message.role === 'user') {
      events.push(compact({
        type: 'user',
        content: redactExportText(message.content),
      }));
      continue;
    }

    const activities = message.activities ?? [];
    let lastAssistantText = '';

    for (const activity of activities) {
      if (activity.kind === 'text' && activity.content?.trim()) {
        lastAssistantText = activity.content;
        events.push(compact({
          type: 'assistant',
          content: redactExportText(activity.content),
        }));
        continue;
      }

      if (activity.kind === 'tool') {
        events.push(compact({
          type: 'tool',
          id: activity.toolUseId,
          name: shortenToolName(activity.name || 'tool'),
          status: activity.status,
          input: maybeJson(activity.inputSummary),
          output: maybeJson(activity.outputSummary),
          started_at: isoFromMs(activity.startedAt),
          ended_at: isoFromMs(activity.endedAt),
        }));
      }
    }

    const finalContent = message.content?.trim();
    const alreadyEmitted = finalContent && lastAssistantText
      && normalizeText(finalContent) === normalizeText(lastAssistantText);
    if (finalContent && !alreadyEmitted) {
      events.push(compact({
        type: 'assistant',
        content: redactExportText(finalContent),
        status: message.status && message.status !== 'done' ? message.status : undefined,
      }));
    }
  }

  const lines = [
    JSON.stringify({
      type: 'session',
      conversation_id: conversationId,
      exported_at: exportedAt,
      event_count: events.length,
      task_status: resolveExportTaskStatus(
        input.taskStatus ? { status: input.taskStatus } : null,
      ),
    }),
    ...events.map((event) => JSON.stringify(event)),
  ];

  return `${lines.join('\n')}\n`;
}

export function conversationExportFilename(conversationId?: string | null, now = new Date()) {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const shortId = conversationId?.trim().slice(0, 8) || 'session';
  return `vibe-coding-conversation-${shortId}-${stamp}.jsonl`;
}

function shortenToolName(name: string) {
  const parts = name.split('__');
  return parts[parts.length - 1] || name;
}

function maybeJson(value?: string): unknown {
  if (!value?.trim()) return undefined;
  const redacted = redactExportText(value);
  const trimmed = redacted.trim();
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}'))
    || (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return redacted;
    }
  }
  return redacted;
}

function isoFromMs(ms?: number) {
  if (!ms || !Number.isFinite(ms)) return undefined;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function normalizeText(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

function compact(record: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined && value !== null && value !== ''),
  );
}
