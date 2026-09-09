import {
  createChatTaskAndStreamResponse,
  createChatTaskStreamResponse,
} from './_chat-tasks.ts';
import { DEFAULT_DEPLOY_REQUEST } from './_pipelines.ts';
import { resolveRequestedModel } from './_models.ts';

/** Create a durable task and stream it over the same HTTP request. */
export async function onRequestPost(context: any) {
  const body = context?.request?.body || {};
  // Publishing runs in the same slot and streams over the same connection as a
  // generation, so a GET reconnect after refresh needs no separate route.
  const intent = body?.intent === 'deploy' ? 'deploy' as const : 'chat' as const;
  const message = String(body?.message || '').trim()
    || (intent === 'deploy' ? DEFAULT_DEPLOY_REQUEST : '');
  if (!message) {
    return new Response(JSON.stringify({
      ok: false,
      error: 'Please describe the page or feature you want to build first.',
    }), {
      status: 400,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  try {
    return await createChatTaskAndStreamResponse(context, message, {
      intent,
      resetProject: body?.resetProject === true,
      turnId: String(body?.turnId || '').trim() || undefined,
      // Anything this deployment does not offer resolves to '', so a client
      // cannot name an arbitrary model and have it billed through the gateway.
      model: resolveRequestedModel(context, body?.model),
    });
  } catch (error) {
    return new Response(JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to start the chat task.',
    }), {
      status: 500,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
}

/** Reconnect to an existing task after refresh or transport interruption. */
export async function onRequestGet(context: any) {
  try {
    return await createChatTaskStreamResponse(context);
  } catch (error) {
    return new Response(JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to open the chat stream.',
    }), {
      status: 500,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
}
