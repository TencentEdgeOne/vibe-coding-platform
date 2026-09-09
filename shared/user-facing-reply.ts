const URL_PATTERN = /https?:\/\/[^\s，。、）)]+/g;
const URL_SLOT = /\u0000(\d+)\u0000/g;
// A dot inside a word is part of a filename or a dotted key, never the end of a
// sentence. One character wide so the prose budget below measures the same
// length either way.
const INNER_DOT = /(?<=[\w-])\.(?=[\w-])/g;
const INNER_DOT_SLOT = /\u0001/g;
const CJK_PATTERN = /[\u3400-\u9fff]/;

export type ReplyLocale = 'zh' | 'en';

/**
 * Which language a reply should be written in. There is no locale on the wire
 * for a turn — the agent runtime only ever sees the prompt — so the request
 * itself decides, and every reply built server-side has to ask the same way or
 * one turn answers in the wrong language.
 */
export function replyLocaleFor(text: string): ReplyLocale {
  return CJK_PATTERN.test(text) ? 'zh' : 'en';
}

/**
 * The reply a stopped turn keeps. Written on both sides of the wire — the client
 * marks the turn stopped the moment the button is pressed, /stop persists it —
 * so a single definition is what keeps the text from changing on reload.
 */
export const STOPPED_TURN_REPLY: Readonly<Record<ReplyLocale, string>> = {
  zh: '已停止本次生成，你可以继续描述下一步修改。',
  en: 'Generation stopped. You can continue with another change.',
};

export function compactUserFacingReply(text: string, fallback: string) {
  const normalized = text.replace(/\r/g, '').trim();
  if (!normalized) return fallback;

  // A live deployment URL is part of the outcome, but its dots and query string
  // read as sentence ends and its length alone can exceed the prose budget. It
  // is held aside while the prose is trimmed, then put back whole.
  const urls: string[] = [];
  const masked = normalized
    .replace(URL_PATTERN, (url) => {
      urls.push(url);
      return `\u0000${urls.length - 1}\u0000`;
    })
    // Otherwise the reply is cut mid-identifier: "缺少 agents." was the whole
    // of what one failed turn told the user it was missing.
    .replace(INNER_DOT, '\u0001');

  // The first paragraph should contain the user-facing outcome. Everything
  // after it is usually filenames, routes, model IDs, commands, or diagnostics.
  const firstParagraph = masked.split(/\n\s*\n/)[0]
    .replace(/^\s*[-*]\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!firstParagraph) return fallback;

  const sentences = firstParagraph.match(/[^。！？.!?]+[。！？.!?]?/g) || [firstParagraph];
  const concise = sentences.slice(0, 2).join('').trim();
  if (concise.length > 180) return fallback;

  return concise
    .replace(INNER_DOT_SLOT, '.')
    .replace(URL_SLOT, (_, index) => urls[Number(index)] ?? '');
}

export type FinishedTurn = {
  /**
   * Whether this turn wrote a project file. Not whether it reached the project:
   * the workflow asks for a scaffold on every turn, so a turn that only
   * answered a question arrives at the end of the build path looking built.
   */
  filesWritten: boolean;
  /** The running preview, when the turn ended with one. */
  previewUrl?: string;
  /** Whether verification failed. */
  buildFailed: boolean;
  /** The model's own reply, empty when it produced nothing usable. */
  modelReply: string;
  /** What to say instead when the model said nothing and the turn succeeded. */
  fallbackReply: string;
  /** What to say instead when the model said nothing and the turn failed. */
  failureReply: string;
};

/**
 * What a finished turn tells the user, and whether it failed.
 *
 * One function for both because they have to agree: the reply was chosen from
 * the preview URL alone and the status from the same, so a turn that stopped to
 * ask the user a question was recorded as a failed build and its question was
 * replaced by a canned line claiming a project had been generated and a preview
 * attempted. Neither was true, and the line invited a retry of a turn that was
 * waiting for an answer.
 */
export function resolveFinishedTurn(turn: FinishedTurn) {
  // Nothing was built, so there is no preview to be missing.
  const previewMissing = turn.filesWritten && !turn.previewUrl;
  const failed = turn.buildFailed || previewMissing;
  if (!turn.modelReply) {
    return {
      reply: failed ? turn.failureReply : turn.fallbackReply,
      failed,
      previewMissing,
    };
  }
  return {
    // Compaction keeps the first paragraph's first two sentences. That is right
    // for an outcome and wrong for anything the user has to act on: it cut a
    // question down to its preamble and dropped the options underneath it.
    reply: turn.filesWritten
      ? compactUserFacingReply(turn.modelReply, turn.fallbackReply)
      : turn.modelReply,
    failed,
    previewMissing,
  };
}

/**
 * A live deployment is the one link the reply must carry: unlike the sandbox
 * preview, it outlives the conversation and has nowhere else to be copied from
 * once the turn scrolls away.
 */
export function withLiveDeploymentUrl(reply: string, url?: string) {
  if (!url || reply.includes(url)) {
    return reply;
  }
  const label = replyLocaleFor(reply) === 'zh' ? '线上地址：' : 'Live URL: ';
  return `${reply.trim()}\n\n${label}${url}`;
}
