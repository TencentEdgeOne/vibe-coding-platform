import { getProjectState } from '../_memory.ts';
import { createProjectArchive, restorePersistedProject } from '../_project.ts';
import { resolveConversationId } from '../utils/_request.ts';

export async function runProjectDownloadPipeline(context: any): Promise<Response> {
  const { conversationId } = resolveConversationId(context, { allowQuery: true });

  const jsonError = (error: string, status = 400) => new Response(
    JSON.stringify({ ok: false, error }),
    { status, headers: { 'content-type': 'application/json; charset=utf-8' } },
  );

  if (!conversationId) {
    return jsonError('missing conversation_id');
  }

  const state = await getProjectState(context, conversationId);

  let archive;
  try {
    archive = await createProjectArchive(context, state);
    if (!archive.ok) {
      const restored = await restorePersistedProject(context, conversationId, state, {
        installDependencies: false,
      });
      if (restored.restored) archive = await createProjectArchive(context, state);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to package the project.';
    return jsonError(message, 500);
  }

  if (!archive.ok) {
    return jsonError(archive.error, 409);
  }

  return new Response(
    JSON.stringify({
      ok: true,
      filename: archive.filename,
      contentType: archive.contentType,
      size: archive.size,
      base64: archive.base64,
    }),
    {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      },
    },
  );
}
