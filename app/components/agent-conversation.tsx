'use client';

import { FormEvent, ReactNode, memo, useEffect, useMemo, useRef, useState } from 'react';
import {
  AppWindow,
  ArrowUp,
  BookOpen,
  Check,
  ChevronRight,
  CircleAlert,
  Copy,
  FilePenLine,
  FilePlus2,
  FolderPlus,
  FolderSearch,
  Monitor,
  Rocket,
  Search,
  Square,
  SquareTerminal,
  Trash2,
  X,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  buildAssistantTimeline,
  lastTimelineText,
  trailingTimelineContent,
  type AssistantTimelineToolItem,
} from '../lib/assistant-timeline';
import {
  presentToolActivity,
  toolActionTier,
  type ReferenceTopic,
  type ToolAction,
  type ToolPresentation,
} from '../lib/tool-activity';
import { withoutPlatformName } from '../../shared/platform-name';
import { ModelPicker } from './model-picker';
import type {
  ActivityStatus,
  AssistantActivity,
} from '../../shared/protocol';
import type { ModelOption } from '../../shared/models';

export type ConversationMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  activities?: AssistantActivity[];
  status?: 'running' | 'done' | 'error' | 'stopped';
};

type ConversationCopy = {
  running: string;
  completed: string;
  failed: string;
  stopped: string;
  input: string;
  output: string;
  placeholder: string;
  send: string;
  stop: string;
  modelLabel: string;
  toolActions: Record<ToolAction, string>;
  referenceTopics: Record<ReferenceTopic, string>;
  referenceDetail: string;
  copyLink: string;
  linkCopied: string;
};

export type DeployOfferCopy = {
  prompt: string;
  deploy: string;
  dismiss: string;
};

function actionLabel(action: ToolAction, copy: ConversationCopy) {
  return copy.toolActions[action];
}

/** What the row names: a topic for reference loads, a path or command otherwise. */
function targetLabel(presentation: ToolPresentation, copy: ConversationCopy) {
  if (!presentation.topic) return withoutPlatformName(presentation.target || '');
  const topic = copy.referenceTopics[presentation.topic];
  return presentation.detailed ? `${topic} · ${copy.referenceDetail}` : topic;
}

function ActionIcon({ action }: { action: ToolAction }) {
  const props = { className: 'tool-activity-action-icon', 'aria-hidden': true } as const;
  if (action === 'Environment Preparing') return <Monitor {...props} />;
  if (action === 'Glob') return <FolderSearch {...props} />;
  if (action === 'Read file') return <Search {...props} />;
  if (action === 'Write file') return <FilePlus2 {...props} />;
  if (action === 'Edit file') return <FilePenLine {...props} />;
  if (action === 'Create folder') return <FolderPlus {...props} />;
  if (action === 'Delete file') return <Trash2 {...props} />;
  if (action === 'Create preview') return <AppWindow {...props} />;
  if (action === 'Deploy project') return <Rocket {...props} />;
  if (action === 'Load skill') return <BookOpen {...props} />;
  return <SquareTerminal {...props} />;
}

function ActivityIcon({ status, action }: { status: ActivityStatus; action: ToolAction }) {
  if (status === 'running') {
    return <span className="tool-activity-spinner" />;
  }
  if (status === 'failed') return <X className="size-3.5" />;
  if (status === 'stopped') return <Square className="size-3" />;
  return <ActionIcon action={action} />;
}

/**
 * One status for a row that stands for several calls: a run still going says so
 * until its last step lands, and a step that broke outranks the ones that did
 * not, because the row is the only place it can be reported.
 */
function rowStatus(steps: readonly Extract<AssistantActivity, { kind: 'tool' }>[]): ActivityStatus {
  for (const status of ['running', 'failed', 'stopped'] as const) {
    if (steps.some((step) => step.status === status)) return status;
  }
  return 'completed';
}

function ToolActivityRow({ item, copy, previouslyReadPaths }: {
  item: AssistantTimelineToolItem;
  copy: ConversationCopy;
  previouslyReadPaths: ReadonlySet<string>;
}) {
  const [open, setOpen] = useState(false);
  const steps = [item.activity, ...item.repeats];
  const status = rowStatus(steps);
  const presentation = presentToolActivity(item.activity, previouslyReadPaths);
  const target = targetLabel(presentation, copy);
  const label = status === 'running'
    ? copy.running
    : status === 'completed'
      ? copy.completed
      : status === 'failed'
        ? copy.failed
        : copy.stopped;
  // Every folded call keeps its own input and output, so the panel reads as one
  // section per call and the row hides a line rather than the work behind it.
  const details = steps.filter((step) => step.inputSummary || step.outputSummary);

  return (
    <div className="tool-activity-row">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        data-tier={toolActionTier(presentation.action)}
        className={`tool-activity-trigger tool-activity-${status}`}
      >
        <span className="tool-activity-status"><ActivityIcon status={status} action={presentation.action} /></span>
        <span className="tool-activity-copy">
          <span>{actionLabel(presentation.action, copy)}{target ? ' ' : ''}</span>
          {target && <strong>{target}</strong>}
        </span>
        {details.length > 0 && (
          <ChevronRight className={`tool-activity-chevron ${open ? 'rotate-90' : ''}`} />
        )}
        <span className="sr-only">{label}</span>
      </button>
      {open && (
        <div className="tool-activity-detail">
          {details.length === 0 ? (
            <p className="tool-activity-empty">{label}</p>
          ) : details.map((step, position) => (
            <div className="tool-activity-step" key={step.toolUseId || position}>
              {step.inputSummary && (
                <div>
                  <span>{copy.input}</span>
                  <pre>{withoutPlatformName(step.inputSummary)}</pre>
                </div>
              )}
              {step.outputSummary && (
                <div>
                  <span>{copy.output}</span>
                  <pre>{withoutPlatformName(step.outputSummary)}</pre>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function plainText(node: ReactNode): string {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(plainText).join('');
  return '';
}

function ConversationLink({ href, copy, children }: {
  href?: string;
  copy: ConversationCopy;
  children?: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const url = href || '';
  // An address spelled out in full is something the user takes elsewhere. A link
  // behind words is meant to be followed, and a button beside it would only
  // crowd the sentence it sits in.
  const isAddress = Boolean(url) && plainText(children).trim() === url;

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const anchor = (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      dir={isAddress ? 'ltr' : undefined}
    >
      {children}
    </a>
  );

  if (!isAddress) {
    return anchor;
  }

  const label = copied ? copy.linkCopied : copy.copyLink;
  const handleCopy = async () => {
    if (!navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <span className="conversation-link">
      {anchor}
      <button
        type="button"
        onClick={() => void handleCopy()}
        className="conversation-link-copy"
        aria-label={label}
        title={label}
      >
        {copied ? <Check /> : <Copy />}
      </button>
    </span>
  );
}

function Markdown({ content, copy }: { content: string; copy: ConversationCopy }) {
  return (
    <div className="agent-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <ConversationLink href={href} copy={copy}>{children}</ConversationLink>
          ),
        }}
      >
        {withoutPlatformName(content)}
      </ReactMarkdown>
    </div>
  );
}

// Memoized because the streaming turn is the only one that changes: the chat
// reducer hands back every other message unchanged, so without this each token
// rebuilt the timeline and the read-path scan for the whole conversation.
const AssistantTurn = memo(function AssistantTurn({ message, copy }: {
  message: ConversationMessage;
  copy: ConversationCopy;
}) {
  const activities = message.activities ?? [];
  const blocks = useMemo(() => buildAssistantTimeline(activities), [activities]);
  // What each tool row may treat as already-read, so a repeated Read of the same
  // file can render as a revisit. Built as a running prefix, hence one snapshot
  // per activity rather than one shared set.
  const previouslyReadPaths = useMemo(() => {
    const readPaths = new Set<string>();
    return activities.map((activity) => {
      const snapshot = new Set(readPaths);
      if (activity.kind === 'tool') {
        const presentation = presentToolActivity(activity);
        if (presentation.action === 'Read file' && presentation.target) {
          readPaths.add(presentation.target);
        }
      }
      return snapshot;
    });
  }, [activities]);
  const lastText = lastTimelineText(blocks);
  const trailing = trailingTimelineContent(lastText?.content, message.content, message.status);
  const hasRunningTool = activities.some(
    (activity) => activity.kind === 'tool' && activity.status === 'running',
  );

  return (
    <section className="conversation-turn conversation-assistant-turn">
      <div className="conversation-body">
        {blocks.map((block) => {
          if (block.kind === 'text') {
            return <Markdown key={`text-${block.index}`} content={block.content} copy={copy} />;
          }

          return (
            <div key={`tools-${block.items[0]?.index ?? 0}`} className="conversation-tool-chain">
              {block.items.map((item) => (
                <ToolActivityRow
                  key={item.activity.toolUseId || `tool-${item.index}`}
                  item={item}
                  copy={copy}
                  previouslyReadPaths={previouslyReadPaths[item.index] ?? new Set()}
                />
              ))}
            </div>
          );
        })}
        {trailing && (
          message.status === 'error' ? (
            <div className="assistant-error-message" role="status">
              <CircleAlert aria-hidden="true" />
              <span>{withoutPlatformName(trailing)}</span>
            </div>
          ) : (
            <Markdown content={trailing} copy={copy} />
          )
        )}
        {message.status === 'running' && !hasRunningTool && (
          <div className="agent-waiting" aria-label={copy.running}>
            <span />
            <span />
            <span />
          </div>
        )}
      </div>
    </section>
  );
});

export function AgentConversation({
  messages,
  input,
  loading,
  canSend,
  compact,
  copy,
  models,
  model,
  onModelChange,
  onInputChange,
  onSubmit,
  onStop,
  deployOffer,
  onDeployOffer,
  onDismissDeployOffer,
}: {
  messages: ConversationMessage[];
  input: string;
  loading: boolean;
  canSend: boolean;
  compact: boolean;
  copy: ConversationCopy;
  models: readonly ModelOption[];
  model: string;
  onModelChange: (model: string) => void;
  onInputChange: (value: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  deployOffer?: DeployOfferCopy | null;
  onDeployOffer?: () => void;
  onDismissDeployOffer?: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const followOutputRef = useRef(true);
  const signature = messages.map((message) => [
    message.id,
    message.status,
    message.content,
    message.activities?.map((activity) => activity.kind === 'text'
      ? activity.content
      : `${activity.toolUseId}:${activity.status}:${activity.outputSummary || ''}`).join('|'),
  ].join(':')).join('\n');

  useEffect(() => {
    const node = scrollRef.current;
    if (node && followOutputRef.current) node.scrollTop = node.scrollHeight;
  }, [signature]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit();
  };

  return (
    <div className={`agent-conversation min-w-0 w-full overflow-hidden ${compact ? 'agent-conversation-compact' : ''}`}>
      <div
        ref={scrollRef}
        className="conversation-scroll scroll-quiet"
        onScroll={(event) => {
          const node = event.currentTarget;
          followOutputRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 72;
        }}
      >
        <div className="conversation-stream">
          {messages.map((message) => message.role === 'user' ? (
            <section key={message.id} className="conversation-turn conversation-user-turn">
              <div className="conversation-body whitespace-pre-wrap">{message.content}</div>
            </section>
          ) : (
            <AssistantTurn key={message.id} message={message} copy={copy} />
          ))}
        </div>
      </div>
      <div className="conversation-composer-dock">
        {deployOffer && (
          <div className="deploy-offer" role="status">
            <span className="deploy-offer-copy">{deployOffer.prompt}</span>
            <div className="deploy-offer-actions">
              <button
                type="button"
                className="deploy-offer-dismiss"
                onClick={onDismissDeployOffer}
              >
                {deployOffer.dismiss}
              </button>
              <button
                type="button"
                className="deploy-offer-accept"
                onClick={onDeployOffer}
              >
                {deployOffer.deploy}
              </button>
            </div>
          </div>
        )}
      <form onSubmit={submit} className="conversation-composer">
        <textarea
          value={input}
          onChange={(event) => onInputChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (!loading && canSend) onSubmit();
            }
          }}
          placeholder={copy.placeholder}
          rows={1}
        />
        {/* Locked mid-run: the turn already went out on a model, and letting the
            control move would show one name while another was answering. */}
        <ModelPicker
          models={models}
          value={model}
          ariaLabel={copy.modelLabel}
          disabled={loading}
          onChange={onModelChange}
        />
        {loading ? (
          <button type="button" className="composer-stop" onClick={onStop} title={copy.stop} aria-label={copy.stop}>
            <Square className="size-3" fill="currentColor" />
          </button>
        ) : (
          <button type="submit" className="composer-send" disabled={!canSend} title={copy.send} aria-label={copy.send}>
            <ArrowUp className="size-4" />
          </button>
        )}
      </form>
      </div>
    </div>
  );
}
