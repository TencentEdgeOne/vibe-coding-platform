import type { AssistantActivity } from '../../shared/protocol';
import { WEB_SEARCH_TOOL_NAME } from '../../shared/web-search.ts';

export type ToolAction =
  | 'Environment Preparing'
  | 'Glob'
  | 'Read file'
  | 'Write file'
  | 'Edit file'
  | 'Create folder'
  | 'Delete file'
  | 'Create preview'
  | 'Deploy project'
  | 'Load skill'
  | 'Search web'
  | 'Run command';

/**
 * What a reference load is actually about, in the user's terms. The tool takes a
 * document id such as `makers-storage`, which is internal naming on two counts —
 * it carries the platform tier and it names a file nobody outside the agent can
 * open — so the id is resolved to one of these before it reaches a label, and the
 * locale table supplies the words.
 */
export type ReferenceTopic =
  | 'platform'
  | 'structure'
  | 'serverApi'
  | 'edgeApi'
  | 'aiEndpoint'
  | 'storage'
  | 'middleware'
  | 'migration'
  | 'cli'
  | 'deployment'
  | 'environment'
  | 'framework';

/** Keyed by the ids `load_makers_skill` accepts, plus the router skill. */
export const REFERENCE_TOPICS: Readonly<Record<string, ReferenceTopic>> = {
  'edgeone-makers-tools': 'platform',
  'makers-recipes': 'structure',
  'makers-cloud-functions': 'serverApi',
  'makers-edge-functions': 'edgeApi',
  'makers-agents': 'aiEndpoint',
  'makers-storage': 'storage',
  'makers-middleware': 'middleware',
  'makers-migration': 'migration',
  'makers-cli': 'cli',
  'makers-deploy': 'deployment',
  'makers-env-adaption': 'environment',
  'makers-frameworks': 'framework',
};

export type ToolPresentation = {
  action: ToolAction;
  target?: string;
  /**
   * Set instead of `target` for reference loads. An unrecognised id still
   * resolves to a topic, because falling back to the id would put the one string
   * this indirection exists to hide back on screen.
   */
  topic?: ReferenceTopic;
  /**
   * A deeper document rather than the topic overview. The agent reaches for one
   * right after the overview it belongs to, so without this the second row is a
   * word-for-word copy of the first and the timeline looks stuck.
   */
  detailed?: boolean;
};

/**
 * Actions that only exist because the project runs on Makers. They are the one
 * tier of the activity stream that carries the platform accent, so plain file
 * work stays visually quiet.
 */
const PLATFORM_ACTIONS = new Set<ToolAction>([
  'Load skill',
  'Create preview',
  'Deploy project',
]);

export function toolActionTier(action: ToolAction): 'platform' | 'file' {
  return PLATFORM_ACTIONS.has(action) ? 'platform' : 'file';
}

/**
 * Shortest chunk that may be skipped as an already-rendered replay. Narration
 * streams in token-sized pieces, so "the text already ends with this chunk" is
 * the normal case for a repeated character and says nothing about a replay.
 * Skipping one silently corrupts what it belonged to: a URL that loses a
 * character is still shaped like a URL, and the reader has no way to tell.
 */
const MIN_REPLAY_CHUNK = 24;

/**
 * Append a streamed narration chunk to an assistant message's activities.
 *
 * A resumed turn replays what the browser already rendered, so a chunk big
 * enough to be unmistakable is dropped when it is already present.
 */
export function appendNarrationChunk(
  activities: readonly AssistantActivity[],
  text: string,
): AssistantActivity[] {
  const list = [...activities];
  const last = list.at(-1);
  if (last?.kind !== 'text') {
    list.push({ kind: 'text', content: text });
    return list;
  }

  const trimmed = text.trim();
  if (trimmed.length >= MIN_REPLAY_CHUNK && last.content.includes(trimmed)) {
    return list;
  }
  list[list.length - 1] = { ...last, content: `${last.content}${text}` };
  return list;
}

function withoutUrls(text: string) {
  return text.replace(/https?:\/\/\S+/g, '').replace(/\s+/g, '');
}

/**
 * The model's closing narration and the turn summary are the same sentence
 * emitted twice: once as streamed progress, once as the answer. Only the
 * summary is compacted and carries the live deployment URL, so the trailing
 * narration is the copy to drop.
 *
 * Neither whitespace nor links can be compared literally. Streamed chunks and
 * the final text break lines differently, and the summary moves the deployment
 * URL onto a line of its own, so the prose is what has to match.
 */
export function dropTrailingSummaryEcho<T extends { kind: string; content?: string }>(
  activities: readonly T[],
  finalContent: string,
): T[] {
  const list = [...activities];
  const last = list.at(-1);
  if (!last || last.kind !== 'text') {
    return list;
  }

  const echoes = (narration: string, summary: string) => Boolean(narration)
    && Boolean(summary)
    && (summary.includes(narration) || narration.includes(summary));
  const content = last.content || '';
  if (
    echoes(content.replace(/\s+/g, ''), finalContent.replace(/\s+/g, ''))
    || echoes(withoutUrls(content), withoutUrls(finalContent))
  ) {
    list.pop();
  }
  return list;
}

function shortToolName(name: string) {
  return name.replace(/^mcp__[^_]+__/, '').replaceAll('_', ' ');
}

function cleanSummaryTarget(summary = '') {
  const firstLine = summary.trim().split('\n')[0] || '';
  return firstLine
    .replace(/^<project>\/?/, '')
    .replace(/\s+\([\d,.]+ chars\)$/, '')
    .trim();
}

function readStructuredTarget(summary = '') {
  const trimmed = summary.trim();
  if (!trimmed.startsWith('{')) return '';
  try {
    const input = JSON.parse(trimmed) as Record<string, unknown>;
    for (const key of ['path', 'file_path', 'pattern', 'glob', 'query', 'command', 'cmd', 'skill']) {
      if (typeof input[key] === 'string') return cleanSummaryTarget(input[key]);
    }
  } catch {
    return '';
  }
  return '';
}

/** Only a reference load carries a ref, so a bare id stays a bare id. */
function readReferenceRequest(summary = '') {
  const trimmed = summary.trim();
  if (!trimmed.startsWith('{')) {
    return { skill: cleanSummaryTarget(trimmed), ref: '' };
  }
  try {
    const input = JSON.parse(trimmed) as Record<string, unknown>;
    return {
      skill: typeof input.skill === 'string' ? input.skill : '',
      ref: typeof input.ref === 'string' ? input.ref.trim() : '',
    };
  } catch {
    return { skill: '', ref: '' };
  }
}

export function presentToolActivity(
  activity: { name: string; inputSummary?: string },
  previouslyReadPaths: ReadonlySet<string> = new Set(),
): ToolPresentation {
  const name = shortToolName(activity.name).toLowerCase();
  const structuredTarget = readStructuredTarget(activity.inputSummary);
  const target = structuredTarget || cleanSummaryTarget(activity.inputSummary);

  if (name.includes('ensure project scaffold') || name.includes('environment')) {
    return { action: 'Environment Preparing' };
  }
  if (name === 'skill' || name === 'load makers skill') {
    const request = readReferenceRequest(activity.inputSummary);
    return {
      action: 'Load skill',
      topic: REFERENCE_TOPICS[request.skill] || 'platform',
      detailed: Boolean(request.ref),
    };
  }
  // Ahead of the command branches: this tool takes a `query`, which is the same
  // field a shell call's target is read from, so the fallback would otherwise
  // label a search as a command whose text happens to be the search terms.
  if (name === shortToolName(WEB_SEARCH_TOOL_NAME)) {
    return { action: 'Search web', target };
  }
  if (name.includes('glob') || name.includes('files list') || name.includes('folder search')) {
    return { action: 'Glob', target: target || '**/*' };
  }
  if (name.includes('make dir') || name.includes('mkdir')) {
    return { action: 'Create folder', target };
  }
  if (name.includes('files remove') || name.includes('files delete')) {
    return { action: 'Delete file', target };
  }
  if (name.includes('read') || name.includes('files exists')) {
    return { action: 'Read file', target };
  }
  if (name.includes('write project file') || name.includes('files write') || name.includes('write files')) {
    return { action: previouslyReadPaths.has(target) ? 'Edit file' : 'Write file', target };
  }
  if (name === 'commands' || name.includes('command')) {
    if (/\bedgeone\s+makers\s+deploy\b/i.test(target)) {
      return { action: 'Deploy project' };
    }
    if (/\bedgeone\s+makers\s+dev\b/i.test(target)) {
      return { action: 'Create preview' };
    }
    return { action: 'Run command', target };
  }
  return { action: 'Run command', target: target || shortToolName(activity.name) };
}

/**
 * When the composer should offer a production deploy.
 *
 * The topbar rocket can start a deploy at any idle moment. A short prompt also
 * appears above the input after a finished project turn — not while the agent
 * is busy, not after a successful or failed deploy of that same turn, and not
 * after a pure Q&A. A failed deploy already has its own row in the stream.
 */

export type DeployOfferKind = 'first' | 'again';

export type DeployOfferActivity = {
  kind?: string;
  status?: string;
  name?: string;
  inputSummary?: string;
};

export type DeployOfferMessage = {
  id?: string;
  role: string;
  status?: string;
  activities?: DeployOfferActivity[];
};

export function isDeployProjectActivity(activity: DeployOfferActivity) {
  if (activity.kind !== 'tool' || !activity.name) return false;
  return presentToolActivity({
    name: activity.name,
    inputSummary: activity.inputSummary,
  }).action === 'Deploy project';
}

export function lastFinishedAssistant<T extends DeployOfferMessage>(messages: readonly T[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const item = messages[index];
    if (item.role === 'assistant' && item.status && item.status !== 'running') {
      return item;
    }
  }
  return undefined;
}

function activitiesOf(message?: DeployOfferMessage) {
  return message?.activities ?? [];
}

function hasSuccessfulDeploy(activities: readonly DeployOfferActivity[]) {
  return activities.some((activity) => (
    isDeployProjectActivity(activity) && activity.status === 'completed'
  ));
}

function hasFailedDeploy(activities: readonly DeployOfferActivity[]) {
  return activities.some((activity) => (
    isDeployProjectActivity(activity)
    && (activity.status === 'failed' || activity.status === 'stopped')
  ));
}

function usedDeployTool(activities: readonly DeployOfferActivity[]) {
  return activities.some((activity) => isDeployProjectActivity(activity));
}

function touchedProject(activities: readonly DeployOfferActivity[]) {
  return activities.some((activity) => (
    activity.kind === 'tool' && !isDeployProjectActivity(activity)
  ));
}

export function resolveDeployOffer(
  messages: readonly DeployOfferMessage[],
  options: {
    canDownload: boolean;
    loading: boolean;
    hasLiveDeployment?: boolean;
  },
): DeployOfferKind | null {
  if (options.loading || !options.canDownload) return null;

  const last = lastFinishedAssistant(messages);
  if (!last || last.status !== 'done') return null;

  const lastActivities = activitiesOf(last);
  if (hasSuccessfulDeploy(lastActivities)) return null;
  if (hasFailedDeploy(lastActivities)) return null;
  if (usedDeployTool(lastActivities)) return null;

  const everPublished = Boolean(options.hasLiveDeployment)
    || messages.some((message) => hasSuccessfulDeploy(activitiesOf(message)));
  if (touchedProject(lastActivities)) return everPublished ? 'again' : 'first';

  const anyTools = messages.some((message) => (
    activitiesOf(message).some((activity) => activity.kind === 'tool')
  ));
  if (!everPublished && !anyTools) return 'first';
  return null;
}
