/**
 * Quote a value for a POSIX shell.
 *
 * Single quotes suppress every expansion, so they are the safe wrapper for
 * sandbox paths and user-supplied names. A single quote cannot itself be
 * escaped inside them: the closing quote wins first. The literal has to be
 * assembled instead — close the string, emit an escaped quote, reopen.
 */
export function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
