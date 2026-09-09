import { ChatOpenAI } from '@langchain/openai';
import { createDeepAgent } from 'deepagents';

type ChatMessage = { role: 'user' | 'assistant'; content: string };

const MODEL_NAME = '@makers/deepseek-v4-flash';

// Module-level, so a warm invocation reuses the client instead of rebuilding it
// and its connection pool on every turn.
let model: ChatOpenAI | undefined;
let agent: ReturnType<typeof createDeepAgent> | undefined;

function getAgent(env: Record<string, string>) {
  model ??= new ChatOpenAI({
    model: MODEL_NAME,
    apiKey: env.AI_GATEWAY_API_KEY,
    configuration: { baseURL: env.AI_GATEWAY_BASE_URL },
    temperature: 0,
    timeout: 300_000,
  });
  agent ??= createDeepAgent({
    model,
    systemPrompt: 'You are a helpful assistant. Answer in the language you were asked in.',
    tools: [],
  });
  return agent;
}

function sseEvent(payload: unknown) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

async function* eventStream(
  messages: ChatMessage[],
  conversationId: string,
  env: Record<string, string>,
  signal?: AbortSignal,
) {
  try {
    const stream = await getAgent(env).stream(
      { messages },
      {
        streamMode: 'messages',
        signal,
        // Caps the agent loop. An execution-time option, not a constructor one:
        // `maxTurns` on createDeepAgent stopped existing and does not error,
        // it just is not read.
        recursionLimit: 30,
        configurable: { thread_id: conversationId },
      },
    );
    for await (const chunk of stream) {
      if (signal?.aborted) break;
      const [msg] = chunk as any[];
      if (msg?.tool_call_chunks?.length) {
        for (const call of msg.tool_call_chunks) {
          if (call.name) yield sseEvent({ type: 'tool_call', name: call.name });
        }
      } else if (msg?.type === 'tool') {
        yield sseEvent({ type: 'tool_result', name: msg.name, content: msg.text?.slice(0, 500) ?? '' });
      } else if (msg?.text) {
        yield sseEvent({ type: 'ai_response', content: msg.text });
      }
    }
  } catch (error) {
    // An abort is the user pressing stop, not a failure to report.
    if ((error as Error).name !== 'AbortError' && !signal?.aborted) {
      yield sseEvent({ type: 'error_message', content: (error as Error).message });
    }
  }
  yield 'data: [DONE]\n\n';
}

export async function onRequest(context: any) {
  const { request, env, conversation_id: conversationId } = context;

  // `messages` and nothing else. A singular `message` branch is a second shape
  // no client sends and the preview probe never exercises, so a mistake in it
  // ships — see makers-agents/references/platform/conversation-id.md.
  const messages: ChatMessage[] = (Array.isArray(request?.body?.messages) ? request.body.messages : [])
    .filter((m: any) => (m?.role === 'user' || m?.role === 'assistant')
      && typeof m?.content === 'string'
      && m.content.trim());
  if (messages.length === 0) {
    return new Response(JSON.stringify({ error: "'messages' is required" }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const signal = request?.signal as AbortSignal | undefined;
  const stream = eventStream(messages, conversationId, env ?? {}, signal);

  return new Response(
    new ReadableStream({
      async pull(controller) {
        const { value, done } = await stream.next();
        if (done) return controller.close();
        controller.enqueue(new TextEncoder().encode(value));
      },
      cancel: () => void stream.return(undefined),
    }),
    {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      },
    },
  );
}
