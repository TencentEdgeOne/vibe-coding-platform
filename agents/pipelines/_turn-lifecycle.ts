import { appendTurn, saveActivityTurn, saveProjectState } from '../_memory.ts';
import type {
  AgentProgressEvent,
  PersistedActivity,
  ProjectState,
} from '../_types.ts';
import type { ProjectCheckpointController } from './_helpers.ts';

type TurnStatus = 'completed' | 'failed' | 'stopped';

type TurnLifecycleOptions = {
  context: any;
  conversationId: string;
  message: string;
  turnId: string;
  userMessagePersisted: boolean;
  state: ProjectState;
  checkpoint: ProjectCheckpointController;
};

/** Owns progress aggregation and the durable commit order for one chat turn. */
export function createTurnLifecycle(options: TurnLifecycleOptions) {
  const activities: PersistedActivity[] = [];

  const recordProgress = (event: AgentProgressEvent) => {
    if (event.type === 'text_segment') {
      const text = event.data.text;
      if (!text) return;
      const last = activities.at(-1);
      if (last?.kind === 'text') {
        if (last.content.endsWith(text) || last.content.endsWith(text.trim())) return;
        activities[activities.length - 1] = { ...last, content: `${last.content}${text}` };
      } else {
        activities.push({ kind: 'text', content: text });
      }
      return;
    }

    if (event.type === 'tool_use') {
      const existing = activities.find(
        (item): item is Extract<PersistedActivity, { kind: 'tool' }> =>
          item.kind === 'tool' && item.toolUseId === event.data.id,
      );
      if (existing) {
        existing.name = event.data.name || existing.name;
        existing.inputSummary = event.data.inputSummary || existing.inputSummary;
        return;
      }
      activities.push({
        kind: 'tool',
        toolUseId: event.data.id,
        name: event.data.name,
        status: 'running',
        inputSummary: event.data.inputSummary,
        startedAt: event.data.startedAt || Date.now(),
      });
      return;
    }

    const existing = activities.find(
      (item): item is Extract<PersistedActivity, { kind: 'tool' }> =>
        item.kind === 'tool' && item.toolUseId === event.data.tool_use_id,
    );
    if (existing) {
      existing.status = event.data.status || (event.data.ok ? 'completed' : 'failed');
      existing.outputSummary = event.data.outputSummary || event.data.preview;
      existing.endedAt = event.data.endedAt || Date.now();
    }
  };

  const finalize = async (
    assistant: string,
    status: TurnStatus,
    finalizeOptions?: { withSnapshot?: boolean; withState?: boolean },
  ) => {
    if (status === 'stopped') {
      for (const activity of activities) {
        if (activity.kind === 'tool' && activity.status === 'running') {
          activity.status = 'stopped';
          activity.endedAt = Date.now();
        }
      }
    }

    // Commit order matters: snapshot → project metadata → conversation.
    if (finalizeOptions?.withSnapshot === true) await options.checkpoint.flush();
    if (finalizeOptions?.withState !== false) {
      await saveProjectState(options.context, options.conversationId, options.state);
    }
    if (!options.userMessagePersisted) {
      await appendTurn(options.context, options.conversationId, 'user', options.message);
    }
    await appendTurn(options.context, options.conversationId, 'assistant', assistant);
    await saveActivityTurn(options.context, options.conversationId, {
      id: options.turnId,
      user: options.message,
      assistant,
      status,
      createdAt: Date.now(),
      activities,
    });
  };

  return { recordProgress, finalize };
}
