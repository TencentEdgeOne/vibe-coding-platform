import { runChatPipeline, runDeployPipeline } from './_pipelines.ts';
import {
  appendTurn,
  getChatTask,
  getModelPreference,
  saveChatTask,
  saveModelPreference,
} from './_memory.ts';
import type { ChatTask, ChatTaskIntent, ChatTaskStatus, StreamSend } from './_types.ts';
import { createSSEResponse, sseEvent } from './_shared.ts';
import { resolveConversationId } from './utils/_request.ts';

type TaskEvent = Record<string, unknown>;

type SequencedEvent = {
  sequence: number;
  event: TaskEvent;
};

type TaskListener = (event: SequencedEvent) => void;

type LiveChatTask = {
  conversationId: string;
  task: ChatTask;
  events: SequencedEvent[];
  nextSequence: number;
  listeners: Set<TaskListener>;
  // Detached from the SSE HTTP request: a browser refresh/disconnect must not
  // stop generation. Only /stop (via abortLiveChatTask) should abort this.
  abortController: AbortController;
  runPromise?: Promise<void>;
};

const liveTasks = new Map<string, LiveChatTask>();

/** Abort in-process chat generation for a conversation (used by /stop). */
export function abortLiveChatTask(conversationId: string) {
  const trimmed = conversationId.trim();
  if (!trimmed) return;
  for (const liveTask of liveTasks.values()) {
    if (liveTask.conversationId === trimmed && !liveTask.abortController.signal.aborted) {
      liveTask.abortController.abort();
      // Mark stopped immediately so a refresh mid-unwind does not treat this as
      // an in-flight task (resume only reconnects queued/running).
      if (liveTask.task.status === 'queued' || liveTask.task.status === 'running') {
        liveTask.task = {
          ...liveTask.task,
          status: 'stopped',
          finishedAt: Date.now(),
        };
      }
    }
  }
}

/** Persist chatTask as stopped so resume history does not reattach activeTask. */
export async function markChatTaskStopped(context: any, conversationId: string) {
  const trimmed = conversationId.trim();
  if (!trimmed) return;
  try {
    const existing = await getChatTask(context, trimmed);
    if (!existing) return;
    if (existing.status !== 'queued' && existing.status !== 'running') return;
    await saveChatTask(context, trimmed, {
      ...existing,
      status: 'stopped',
      finishedAt: Date.now(),
    });
  } catch (error) {
    console.warn('[chat-task] failed to mark task stopped', error);
  }
}

function taskKey(conversationId: string, taskId: string) {
  return `${conversationId}:${taskId}`;
}

function createTaskId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function getConversationId(context: any): string {
  return resolveConversationId(context).conversationId.trim();
}

function isTerminalEvent(event: TaskEvent) {
  return event.type === 'result' || event.type === 'error';
}

function statusFromResult(event: TaskEvent): ChatTaskStatus {
  const data = event.data && typeof event.data === 'object'
    ? event.data as Record<string, unknown>
    : {};
  if (data.stopped === true) return 'stopped';
  return data.ok === false ? 'failed' : 'completed';
}

function getOrCreateLiveTask(conversationId: string, task: ChatTask): LiveChatTask {
  const key = taskKey(conversationId, task.id);
  const existing = liveTasks.get(key);
  if (existing) {
    return existing;
  }

  const liveTask: LiveChatTask = {
    conversationId,
    task,
    events: task.finalEvent
      ? [{ sequence: 1, event: task.finalEvent }]
      : [],
    nextSequence: task.finalEvent ? 1 : 0,
    listeners: new Set(),
    abortController: new AbortController(),
  };
  liveTasks.set(key, liveTask);
  return liveTask;
}

// file_content events carry whole files. Only the newest version of a path is
// worth replaying to a client that reconnects mid-run, so repeated writes to the
// same file must not pile up in the buffer.
function filePushPath(event: TaskEvent): string {
  if (event.type !== 'file_content') return '';
  const data = event.data && typeof event.data === 'object'
    ? event.data as Record<string, unknown>
    : {};
  return typeof data.path === 'string' ? data.path : '';
}

function publish(liveTask: LiveChatTask, event: TaskEvent) {
  const supersededPath = filePushPath(event);
  if (supersededPath) {
    const previousIndex = liveTask.events.findIndex(
      (record) => filePushPath(record.event) === supersededPath,
    );
    if (previousIndex >= 0) {
      liveTask.events.splice(previousIndex, 1);
    }
  }

  const record = {
    sequence: ++liveTask.nextSequence,
    event,
  };
  liveTask.events.push(record);
  // The event log is only a short-lived in-process replay buffer. Durable task
  // state and the final result live in context.store, so a cold start does not
  // turn this Map into the source of truth.
  if (liveTask.events.length > 2_000) {
    liveTask.events.splice(0, liveTask.events.length - 2_000);
  }
  for (const listener of liveTask.listeners) {
    listener(record);
  }
}

function isTaskActive(task: ChatTask | null) {
  return task?.status === 'queued' || task?.status === 'running';
}

type ChatTaskOptions = {
  resetProject?: boolean;
  turnId?: string;
  intent?: ChatTaskIntent;
  /** Already validated against this deployment's catalogue; '' means no choice. */
  model?: string;
};

async function createChatTask(
  context: any,
  message: string,
  options: ChatTaskOptions = {},
) {
  const conversationId = getConversationId(context);
  if (!conversationId) {
    return {
      ok: false as const,
      status: 400,
      error: 'Missing conversationId. The project workspace cannot be prepared.',
    };
  }

  const taskId = options.turnId || createTaskId();
  const existing = await getChatTask(context, conversationId);
  if (existing && existing.id === taskId && existing.message === message) {
    return { ok: true as const, conversationId, task: existing };
  }
  if (existing && isTaskActive(existing)) {
    return {
      ok: false as const,
      status: 409,
      error: 'Another generation is already running for this conversation.',
    };
  }

  // Appending the user message creates a brand-new conversation, which makes
  // updateConversation available for the durable task record below. The stream
  // pipeline knows this message is already persisted and will not append it a
  // second time.
  await appendTurn(context, conversationId, 'user', message);

  // A request without a choice inherits the conversation's, so the model only
  // changes when someone changes it. Recording it on the task is what makes a
  // reconnect replay the run that actually happened.
  const requestedModel = (options.model || '').trim();
  const model = requestedModel || await getModelPreference(context, conversationId);

  const task: ChatTask = {
    id: taskId,
    message,
    ...(options.intent === 'deploy' ? { intent: 'deploy' as const } : {}),
    ...(model ? { model } : {}),
    resetProject: options.resetProject === true,
    status: 'queued',
    createdAt: Date.now(),
  };
  await saveChatTask(context, conversationId, task);
  if (requestedModel) {
    await saveModelPreference(context, conversationId, requestedModel);
  }
  return { ok: true as const, conversationId, task };
}

function withTaskAbortSignal(context: any, signal: AbortSignal) {
  // Keep the same runtime context (sandbox / store / tools) but replace the HTTP
  // request signal so SSE client disconnect does not cancel the agent run.
  const request = context?.request && typeof context.request === 'object'
    ? { ...context.request, signal }
    : { signal };
  return { ...context, request };
}

async function executeLiveTask(context: any, liveTask: LiveChatTask) {
  const runningTask: ChatTask = {
    ...liveTask.task,
    status: 'running',
    startedAt: liveTask.task.startedAt || Date.now(),
    error: undefined,
    finalEvent: undefined,
  };
  liveTask.task = runningTask;
  let finalEvent: TaskEvent | undefined;
  let error: string | undefined;
  const send: StreamSend = (event) => {
    publish(liveTask, event);
    if (isTerminalEvent(event)) {
      finalEvent = event;
    }
  };
  const taskContext = withTaskAbortSignal(context, liveTask.abortController.signal);

  try {
    await saveChatTask(taskContext, liveTask.conversationId, runningTask);
    publish(liveTask, { type: 'status', message: 'Starting the chat task' });
    if (liveTask.task.intent === 'deploy') {
      await runDeployPipeline(taskContext, liveTask.task.message, send, {
        turnId: liveTask.task.id,
        userMessagePersisted: true,
      });
    } else {
      await runChatPipeline(taskContext, liveTask.task.message, send, {
        resetProject: liveTask.task.resetProject,
        turnId: liveTask.task.id,
        userMessagePersisted: true,
        model: liveTask.task.model,
      });
    }
  } catch (runError) {
    error = runError instanceof Error ? runError.message : 'Request processing failed.';
    if (!finalEvent) {
      publish(liveTask, { type: 'error', error });
      finalEvent = { type: 'error', error };
    }
  }

  const current = liveTask.task;
  const nextStatus = finalEvent?.type === 'result'
    ? statusFromResult(finalEvent)
    : error
      ? 'failed'
      : current.status === 'running' ? 'completed' : current.status;
  const nextTask: ChatTask = {
    ...current,
    status: nextStatus,
    finishedAt: Date.now(),
    ...(finalEvent ? { finalEvent } : {}),
    ...(error ? { error } : {}),
  };
  liveTask.task = nextTask;
  try {
    await saveChatTask(taskContext, liveTask.conversationId, nextTask);
  } catch (persistError) {
    console.error('[chat-task] failed to persist final task state', persistError);
  }

  const key = taskKey(liveTask.conversationId, liveTask.task.id);
  setTimeout(() => {
    if (liveTask.listeners.size === 0 && !isTaskActive(liveTask.task) && liveTasks.get(key) === liveTask) {
      liveTasks.delete(key);
    }
  }, 5 * 60 * 1_000);
}

function ensureChatTaskStarted(context: any, conversationId: string, task: ChatTask) {
  const liveTask = getOrCreateLiveTask(conversationId, task);
  if (!liveTask.runPromise && isTaskActive(liveTask.task)) {
    liveTask.runPromise = executeLiveTask(context, liveTask).catch((error) => {
      console.error('[chat-task] execution failed', error);
    });
  }
  return liveTask;
}

class AsyncEventQueue<T> {
  private values: T[] = [];
  private waiters: Array<(value: T) => void> = [];

  push(value: T) {
    const waiter = this.waiters.shift();
    if (waiter) waiter(value);
    else this.values.push(value);
  }

  next() {
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve(value);
    return new Promise<T>((resolve) => this.waiters.push(resolve));
  }
}

function parseTaskId(context: any) {
  const query = context?.request?.query;
  const fromQuery = query?.runId ?? query?.turnId ?? query?.taskId;
  if (typeof fromQuery === 'string' && fromQuery.trim()) return fromQuery.trim();

  const rawUrl = typeof context?.request?.url === 'string' ? context.request.url : '';
  try {
    const url = new URL(rawUrl, 'http://localhost');
    return url.searchParams.get('runId') || url.searchParams.get('turnId') || url.searchParams.get('taskId') || '';
  } catch {
    return '';
  }
}

function createLiveTaskStreamResponse(
  context: any,
  conversationId: string,
  task: ChatTask,
) {
  const liveTask = ensureChatTaskStarted(context, conversationId, task);

  return createSSEResponse(async function* (signal) {
    yield sseEvent({
      type: 'task_started',
      data: {
        runId: task.id,
        conversation_id: conversationId,
        status: task.status,
      },
    });
    const queue = new AsyncEventQueue<SequencedEvent>();
    const afterSequence = liveTask.nextSequence;
    const listener: TaskListener = (record) => {
      if (record.sequence > afterSequence) queue.push(record);
    };
    liveTask.listeners.add(listener);

    try {
      for (const record of liveTask.events) {
        if (record.sequence <= afterSequence) {
          yield sseEvent(record.event);
        }
      }

      if (!isTaskActive(liveTask.task)) {
        // The task may have completed after `afterSequence` was captured but
        // before replay finished. Drain that race window before closing.
        for (const record of liveTask.events) {
          if (record.sequence > afterSequence) yield sseEvent(record.event);
        }
        return;
      }

      const abortPromise = signal
        ? new Promise<typeof ABORTED>((resolve) => {
          if (signal.aborted) resolve(ABORTED);
          else signal.addEventListener('abort', () => resolve(ABORTED), { once: true });
        })
        : null;

      while (!signal?.aborted) {
        const record = await (abortPromise
          ? Promise.race([queue.next(), abortPromise])
          : queue.next());
        if (record === ABORTED) return;
        yield sseEvent(record.event);
        if (isTerminalEvent(record.event)) return;
      }
    } finally {
      liveTask.listeners.delete(listener);
    }
  }, context?.request?.signal);
}

/** Create a durable task and subscribe the same POST request to its event stream. */
export async function createChatTaskAndStreamResponse(
  context: any,
  message: string,
  options: ChatTaskOptions = {},
) {
  const result = await createChatTask(context, message, options);
  if (!result.ok) {
    return new Response(JSON.stringify(result), {
      status: result.status,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
  return createLiveTaskStreamResponse(context, result.conversationId, result.task);
}

/** Reconnect to a running or completed task without creating a second run. */
export async function createChatTaskStreamResponse(context: any) {
  const conversationId = getConversationId(context);
  const runId = parseTaskId(context);
  if (!conversationId || !runId) {
    return new Response(JSON.stringify({ ok: false, error: 'conversationId and runId are required.' }), {
      status: 400,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }

  const task = await getChatTask(context, conversationId);
  if (!task || task.id !== runId) {
    return new Response(JSON.stringify({ ok: false, error: 'Chat task not found.' }), {
      status: 404,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }

  return createLiveTaskStreamResponse(context, conversationId, task);
}

const ABORTED = Symbol('aborted');
