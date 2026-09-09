import {
  getActivityHistory,
  getChatTask,
  getHistory,
} from '../_memory.ts';
import {
  conversationExportFilename,
  buildTranscriptJsonl,
} from '../../shared/conversation-export.ts';
import { resolveConversationIdPreferQuery } from '../utils/_request.ts';

export async function runTranscriptPipeline(context: any): Promise<Response> {
  const { conversationId } = resolveConversationIdPreferQuery(context);

  const jsonError = (error: string, status = 400) => new Response(
    JSON.stringify({ ok: false, error }),
    { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } },
  );

  if (!conversationId) {
    return jsonError('conversationId is required. Use GET /transcript?conversationId=...');
  }

  try {
    const [turns, history, task] = await Promise.all([
      getActivityHistory(context, conversationId),
      getHistory(context, conversationId),
      getChatTask(context, conversationId),
    ]);

    const jsonl = buildTranscriptJsonl({
      conversationId,
      turns,
      history,
      task,
    });
    const filename = conversationExportFilename(conversationId);
    return new Response(jsonl, {
      headers: {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'content-disposition': `attachment; filename="${filename}"`,
        'cache-control': 'no-store',
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to export transcript.';
    return jsonError(message, 500);
  }
}
