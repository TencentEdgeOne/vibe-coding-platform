export function sanitizeNarrationText(input: string) {
  if (!input) return '';
  return input
    .replace(/\x1b\[[0-9;?]*[~A-Za-z]/g, '')
    .replace(/\[20[01]~/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
    .replace(/<think\b[^>]*>/gi, '')
    .replace(/<\/think>/gi, '')
    .replace(/\n{4,}/g, '\n\n\n');
}

/**
 * Shortest accumulated block that a repeated delta can be measured against.
 * Below it, "the delta repeats everything so far" is a coincidence between two
 * short fragments rather than evidence of a re-send.
 */
const MIN_RESEND_PREFIX = 8;

export type NarrationEmitState = {
  /** Text already streamed for the current assistant text block. */
  currentTextBlock: string;
  /** All narration emitted for the whole agent turn. */
  emittedNarration: string;
};

/**
 * Resolve the next narration chunk to emit.
 *
 * Stream deltas are incremental; complete assistant snapshots may repeat the
 * already-streamed prefix. Only the missing suffix should be forwarded, and
 * dedupe is scoped to the current text block so earlier phrases like
 * "简洁好用的 Todolist" cannot swallow a later "用的 Todolist".
 */
export function resolveNarrationEmit(
  state: NarrationEmitState,
  rawText: string,
  complete = false,
): { state: NarrationEmitState; text: string | null } {
  const text = sanitizeNarrationText(rawText);
  if (!text) {
    return { state, text: null };
  }

  if (complete) {
    const trimmed = text.trim();
    if (!trimmed) {
      return { state, text: null };
    }

    const streamed = state.currentTextBlock;
    const streamedTrimmed = streamed.trimEnd();

    if (streamed.includes(trimmed) || streamedTrimmed === trimmed) {
      return { state, text: null };
    }

    let nextChunk = trimmed;
    if (streamed && trimmed.startsWith(streamed)) {
      nextChunk = trimmed.slice(streamed.length);
    } else if (streamedTrimmed && trimmed.startsWith(streamedTrimmed)) {
      nextChunk = trimmed.slice(streamedTrimmed.length);
    } else if (streamed) {
      // Stream and snapshot diverged — keep the streamed text as source of truth.
      return { state, text: null };
    } else {
      // Empty block window (e.g. after a tool call cleared it). Skip only when this
      // exact snapshot was already emitted as the trailing narration — use endsWith
      // so earlier phrases like "简洁好用的 …" cannot swallow "用的 …".
      const emittedTrimmed = state.emittedNarration.trimEnd();
      if (emittedTrimmed.endsWith(trimmed)) {
        return { state, text: null };
      }
      nextChunk = trimmed;
    }

    nextChunk = sanitizeNarrationText(nextChunk);
    if (!nextChunk.trim()) {
      return { state, text: null };
    }

    const currentTextBlock = sanitizeNarrationText(`${streamed}${nextChunk}`);
    const emittedNarration = sanitizeNarrationText(`${state.emittedNarration}${nextChunk}`);
    return {
      state: { currentTextBlock, emittedNarration },
      text: nextChunk,
    };
  }

  // Incremental delta. Some providers re-send the whole block in place of the
  // new fragment, which is only safely recognisable as an exact prefix of a
  // block long enough that a genuine fragment could not repeat it by accident.
  // Nothing here may compare against the tail: deltas are token-sized, so a
  // chunk like "a" landing after an "a" is ordinary text, and dropping it
  // quietly corrupts whatever it belonged to — a URL loses a character and
  // still looks like a URL.
  if (
    state.currentTextBlock.length >= MIN_RESEND_PREFIX
    && text.startsWith(state.currentTextBlock)
  ) {
    const remainder = text.slice(state.currentTextBlock.length);
    if (!remainder) {
      return { state, text: null };
    }
    const currentTextBlock = sanitizeNarrationText(`${state.currentTextBlock}${remainder}`);
    const emittedNarration = sanitizeNarrationText(`${state.emittedNarration}${remainder}`);
    return {
      state: { currentTextBlock, emittedNarration },
      text: remainder,
    };
  }

  const currentTextBlock = sanitizeNarrationText(`${state.currentTextBlock}${text}`);
  const emittedNarration = sanitizeNarrationText(`${state.emittedNarration}${text}`);
  return {
    state: { currentTextBlock, emittedNarration },
    text,
  };
}
