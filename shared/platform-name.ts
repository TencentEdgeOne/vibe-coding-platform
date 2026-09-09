/**
 * Rewrite the platform tier out of text on its way to the conversation.
 *
 * "Makers" is the name of the tier this agent builds against, and it is written
 * all over the machinery the user never asked about: the system prompt, the CLI
 * invocations, the temp logs those commands leave behind, and the reference
 * documents the model reads. What the user came for is EdgeOne, so every one of
 * those leaks is rendered as the brand instead of the plumbing.
 *
 * This is a display filter and belongs only at the render boundary. Two things
 * downstream still match on the raw text — `presentToolActivity` recognises a
 * preview row by the `edgeone makers dev` in its summary, and resume finds the
 * same command when restoring a conversation — so rewriting a value before it is
 * stored would quietly break both. Filtering at render also keeps the
 * narration/summary echo checks comparing raw text against raw text; redacting
 * one side and not the other makes an echo look like new content, and the closing
 * sentence of a turn renders twice.
 */
export function withoutPlatformName(text: string): string {
  if (!text) return '';
  return text
    // "EdgeOne Makers" is one product name, so the tier drops and the brand stays
    // exactly as it was written: a lowercase command keeps reading like a command.
    .replace(/\b(edgeone)[ \t_-]+makers\b/gi, (_match, brand: string) => brand)
    // Error codes arrive as MAKERS_CLI_UNAVAILABLE, where the underscore is a word
    // character and hides the name from the word-boundary rule below.
    .replace(/\bMAKERS_(?=[A-Z])/g, 'EDGEONE_')
    // Anything left standing on its own, including the makers-* reference ids and
    // the /tmp/makers-*.log paths. A leading @ is the one exception: @makers/... is
    // a live model identifier, and renaming it sends the reader looking for a model
    // that does not exist. Matching the preceding character rather than looking
    // behind for it keeps this parseable everywhere: a lookbehind an engine does not
    // know is a syntax error, and this file ships to the browser.
    .replace(
      /(^|[^@\w])(makers)\b/gi,
      (_match, before: string, name: string) => `${before}${name[0] === 'M' ? 'EdgeOne' : 'edgeone'}`,
    );
}
