import { getChatTask } from '../_memory.ts';
import { isExportTaskDone, resolveExportTaskStatus } from '../../shared/conversation-export.ts';
import { resolveConversationIdPreferQuery } from '../utils/_request.ts';

export async function runStatusPipeline(context: any): Promise<Response> {
  const { conversationId } = resolveConversationIdPreferQuery(context);
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  };

  if (!conversationId) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: 'conversationId is required. Use GET /status?conversationId=...',
      }),
      { status: 400, headers },
    );
  }

  try {
    const task = await getChatTask(context, conversationId);
    const status = resolveExportTaskStatus(task);
    return new Response(
      JSON.stringify({
        ok: true,
        conversationId,
        status,
        done: isExportTaskDone(status),
        taskId: task?.id || null,
        startedAt: task?.startedAt || null,
        finishedAt: task?.finishedAt || null,
      }),
      { headers },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to read task status.';
    return new Response(
      JSON.stringify({ ok: false, error: message }),
      { status: 500, headers },
    );
  }
}
