import { abortLiveChatTask, markChatTaskStopped } from './_chat-tasks.ts';
import { getProjectState, saveActivityTurn, saveProjectState } from './_memory.ts';
import { persistProjectSnapshot } from './pipelines/_helpers.ts';
import type { PersistedActivity } from './_types.ts';
import { replyLocaleFor, STOPPED_TURN_REPLY } from '../shared/user-facing-reply.ts';

export async function onRequest(context: any) {
  const conversationId = String(context?.request?.body?.conversation_id || '').trim();
  if (!conversationId) {
    return new Response(JSON.stringify({ ok: false, error: 'missing conversation_id' }), {
      status: 400,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }

  try {
    const discardProject = context?.request?.body?.discardProject === true;
    // Stop the detached in-process run first (SSE disconnect no longer aborts it).
    abortLiveChatTask(conversationId);
    // Persist stopped before unwind finishes so refresh/resume does not see an
    // activeTask and duplicate the activityHistory user/assistant rows.
    await markChatTaskStopped(context, conversationId);
    // Cancel the platform run before touching the sandbox. A long-running install
    // or build can otherwise make the snapshot command queue behind the very work
    // this endpoint is trying to stop.
    const result = await context.utils?.abortActiveRun?.(conversationId);
    // "Stop and start new" intentionally abandons this conversation, so avoid a
    // full zip -> base64 -> store round trip that the new workspace will never use.
    // A normal Stop still snapshots immediately for same-conversation resume.
    let persisted: boolean | undefined;
    if (!discardProject) {
      try {
        const state = await getProjectState(context, conversationId);
        const saved = await persistProjectSnapshot(context, conversationId, state);
        persisted = saved;
        if (saved && !state.created) {
          state.created = true;
          await saveProjectState(context, conversationId, state);
        }
      } catch (error) {
        console.warn('[stop] project snapshot failed', error);
      }
    }
    const rawTurn = context?.request?.body?.turn;
    if (rawTurn && typeof rawTurn === 'object') {
      const turn = rawTurn as Record<string, unknown>;
      const user = String(turn.user || '').slice(0, 20_000);
      const assistant = STOPPED_TURN_REPLY[replyLocaleFor(user)];
      const activities = (Array.isArray(turn.activities) ? turn.activities : [])
        .slice(-50)
        .filter((activity): activity is PersistedActivity => Boolean(activity) && typeof activity === 'object')
        .map((activity) => activity.kind === 'tool' && activity.status === 'running'
          ? { ...activity, status: 'stopped' as const, endedAt: Date.now() }
          : activity);
      if (user) {
        await saveActivityTurn(context, conversationId, {
          id: String(turn.id || context.run_id || Date.now()),
          user,
          assistant,
          status: 'stopped',
          createdAt: Number(turn.createdAt) || Date.now(),
          activities,
        });
      }
    }
    return new Response(JSON.stringify({
      ok: true,
      conversation_id: conversationId,
      aborted: result?.aborted === true,
      ...(persisted !== undefined ? { persisted } : {}),
    }), {
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  } catch (error) {
    return new Response(JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to stop the active run.',
    }), {
      status: 500,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
}
