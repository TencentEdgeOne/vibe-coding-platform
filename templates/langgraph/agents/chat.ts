import { ChatOpenAI } from '@langchain/openai';
import { END, MessagesAnnotation, START, StateGraph } from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';

const MODEL_NAME = '@makers/deepseek-v4-flash';

// Module-level, so a warm invocation reuses the client instead of rebuilding it
// and its connection pool on every turn. The graph is deliberately not cached
// beside it: it compiles against the checkpointer and store this request
// carries, and a graph held across requests would pin the first one's.
let model: ChatOpenAI | undefined;

function getModel(env: Record<string, string>) {
  model ??= new ChatOpenAI({
    model: MODEL_NAME,
    apiKey: env.AI_GATEWAY_API_KEY,
    configuration: { baseURL: env.AI_GATEWAY_BASE_URL },
    temperature: 0,
    timeout: 300_000,
  });
  return model;
}

function buildGraph(llm: ChatOpenAI, tools: any[], checkpointer: any, store: any) {
  // Binding an empty list is not the same as binding none — some providers
  // reject the empty array outright.
  const modelWithTools = tools.length ? llm.bindTools(tools) : llm;

  async function agentNode(state: typeof MessagesAnnotation.State) {
    return { messages: [await modelWithTools.invoke(state.messages)] };
  }

  function shouldContinue(state: typeof MessagesAnnotation.State) {
    const last = state.messages[state.messages.length - 1] as any;
    return last?.tool_calls?.length ? 'tools' : END;
  }

  return new StateGraph(MessagesAnnotation)
    .addNode('agent', agentNode)
    .addNode('tools', new ToolNode(tools))
    .addEdge(START, 'agent')
    .addConditionalEdges('agent', shouldContinue)
    .addEdge('tools', 'agent')
    .compile({ checkpointer, store });
}

function sseEvent(payload: unknown) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

async function* eventStream(
  graph: any,
  message: string,
  conversationId: string,
  signal?: AbortSignal,
) {
  try {
    const stream = await graph.stream(
      { messages: [{ role: 'user', content: message }] },
      { streamMode: 'messages', signal, configurable: { thread_id: conversationId } },
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
  const { request, env, conversation_id: conversationId, store } = context;

  // `messages` and nothing else. A singular `message` branch is a second shape
  // no client sends and the preview probe never exercises, so a mistake in it
  // ships — see makers-agents/references/platform/conversation-id.md.
  //
  // Only the newest turn is forwarded, because the checkpointer below already
  // holds this thread's history: replaying the array would append a copy of
  // what is already stored and grow the prompt every turn.
  const incoming = Array.isArray(request?.body?.messages) ? request.body.messages : [];
  const latest = [...incoming].reverse().find(
    (m: any) => m?.role === 'user' && typeof m?.content === 'string' && m.content.trim(),
  );
  if (!latest) {
    return new Response(JSON.stringify({ error: "'messages' is required" }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // The sandbox tools as real LangChain objects. Narrow them with
  // `toLangChainTools(tool, ['web_search'])`, or pass [] to take them away.
  const { tool } = await import('@langchain/core/tools');
  const tools = typeof context.tools?.toLangChainTools === 'function'
    ? context.tools.toLangChainTools(tool)
    : [];

  const graph = buildGraph(
    getModel(env ?? {}),
    tools,
    store?.langgraphCheckpointer,
    store?.langgraphStore,
  );

  const signal = request?.signal as AbortSignal | undefined;
  const stream = eventStream(graph, latest.content.trim(), conversationId, signal);

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
