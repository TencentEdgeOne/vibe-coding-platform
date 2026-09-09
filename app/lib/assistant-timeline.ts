import type { AssistantActivity } from '../../shared/protocol';
import { presentToolActivity } from './tool-activity.ts';

type ToolActivity = Extract<AssistantActivity, { kind: 'tool' }>;

export type AssistantTimelineTextBlock = {
  kind: 'text';
  index: number;
  content: string;
};

export type AssistantTimelineToolItem = {
  index: number;
  activity: ToolActivity;
  /**
   * Later calls that would have printed this row's label a second time. They
   * stay on the row — it holds their status and their detail — so only the
   * duplicate line is gone, not the work it stood for.
   */
  repeats: ToolActivity[];
};

export type AssistantTimelineToolBlock = {
  kind: 'tools';
  items: AssistantTimelineToolItem[];
};

export type AssistantTimelineBlock = AssistantTimelineTextBlock | AssistantTimelineToolBlock;

export function normalizeTimelineText(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * The row a reference load belongs to, or nothing for a tool whose label names
 * what it touched and so cannot repeat by itself.
 *
 * A topic and the documents beneath it are separate loads that print the same
 * label, and the agent takes several in a row, so the label is the row's
 * identity: the second load joins the row already saying it. Reading up on a
 * subject is one step of the run however many files it took.
 */
function referenceRowKey(activity: ToolActivity) {
  const { topic, detailed } = presentToolActivity(activity);
  return topic ? `${topic}:${detailed ? 'detail' : 'overview'}` : '';
}

/**
 * Collapse consecutive tool calls into one chain-log block so the stream is
 * text → tools → text → tools, matching the persisted activity order.
 */
export function buildAssistantTimeline(activities: AssistantActivity[]): AssistantTimelineBlock[] {
  const blocks: AssistantTimelineBlock[] = [];
  // Reference rows of the open chain only. Narration between two loads is the
  // agent saying what it turns to next, so a load after it opens a row of its
  // own — folding across the sentence would hide the step it announced.
  const referenceRows = new Map<string, AssistantTimelineToolItem>();

  for (let index = 0; index < activities.length; index += 1) {
    const activity = activities[index];
    if (activity.kind === 'text') {
      if (!activity.content.trim()) continue;
      blocks.push({ kind: 'text', index, content: activity.content });
      continue;
    }

    let chain = blocks.at(-1);
    if (chain?.kind !== 'tools') {
      const opened: AssistantTimelineToolBlock = { kind: 'tools', items: [] };
      blocks.push(opened);
      referenceRows.clear();
      chain = opened;
    }

    const key = referenceRowKey(activity);
    const open = key ? referenceRows.get(key) : undefined;
    if (open) {
      open.repeats.push(activity);
      continue;
    }

    const item: AssistantTimelineToolItem = { index, activity, repeats: [] };
    if (key) referenceRows.set(key, item);
    chain.items.push(item);
  }
  return blocks;
}

export function lastTimelineText(blocks: AssistantTimelineBlock[]) {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block.kind === 'text') return block;
  }
  return undefined;
}

/**
 * Text that still needs to render after the activity timeline. If the finalized
 * reply only extends the last streamed narration, keep the narration in place
 * and return just the leftover so it stays after later tool calls.
 */
export function trailingTimelineContent(
  lastText: string | undefined,
  finalContent: string,
  status?: 'running' | 'done' | 'error' | 'stopped',
) {
  const trailing = finalContent.trim();
  if (!trailing || status === 'running') return '';
  if (status === 'error' || !lastText?.trim()) return trailing;

  const left = normalizeTimelineText(lastText);
  const right = normalizeTimelineText(trailing);
  if (left === right) return '';
  if (right.startsWith(left)) return right.slice(left.length).trimStart();
  return trailing;
}
