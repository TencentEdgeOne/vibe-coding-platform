import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeAssistantText } from '../shared/sanitize-assistant-text.ts';

// Every assistant reply is persisted and streamed through this function, so a
// gap here reaches the user as terminal garbage, leaked reasoning, or raw tool
// JSON in the middle of a sentence.

test('terminal control sequences never reach the reply', () => {
  assert.equal(
    sanitizeAssistantText('\x1b[32mThe page is ready.\x1b[0m'),
    'The page is ready.',
  );
  // Bracketed paste markers arrive without the escape byte once the colour
  // codes above have been stripped, so they need their own pass.
  assert.equal(sanitizeAssistantText('[200~pasted[201~'), 'pasted');
  // OSC sequences (window titles) run to a BEL rather than to a letter.
  assert.equal(sanitizeAssistantText('\x1b]0;claude\x07Done.'), 'Done.');
  assert.equal(sanitizeAssistantText('Line\x00one\x08.'), 'Lineone.');
});

test('reasoning blocks are dropped, closed or not', () => {
  assert.equal(
    sanitizeAssistantText('<think>weigh the options</think>Built the page.'),
    'Built the page.',
  );
  assert.equal(sanitizeAssistantText('<think class="x">hidden</think>Kept.'), 'Kept.');
  // A stream cut mid-thought leaves no closing tag; keeping the tail would
  // publish the reasoning verbatim.
  assert.equal(sanitizeAssistantText('Kept.<think>still thinking'), 'Kept.');
});

test('tool blocks are removed whole, and only tool blocks', () => {
  const withToolUse = 'Before {"type":"tool_use","input":{"path":"a.ts"}} after';
  assert.equal(sanitizeAssistantText(withToolUse), 'Before  after');

  // Nested braces and braces inside strings must not end the block early.
  const nested = 'A {"type":"tool_result","content":{"a":{"b":"}"}}} B';
  assert.equal(sanitizeAssistantText(nested), 'A  B');

  // An escaped quote does not close the string it sits in.
  const escaped = 'A {"type":"tool_use","input":{"q":"say \\" }"}} B';
  assert.equal(sanitizeAssistantText(escaped), 'A  B');

  // JSON the user asked for is content, not protocol noise.
  const userJson = 'Here is the config: {"name":"demo","version":1}';
  assert.equal(sanitizeAssistantText(userJson), userJson);
});

test('an unterminated tool block takes the rest of the text with it', () => {
  assert.equal(
    sanitizeAssistantText('Done. {"type":"tool_use","input":{"path":'),
    'Done.',
  );
});

test('blank runs collapse and the reply is trimmed', () => {
  assert.equal(sanitizeAssistantText('  A\n\n\n\n\nB  '), 'A\n\nB');
  assert.equal(sanitizeAssistantText(''), '');
  // A reply that was nothing but reasoning has no user-facing content left.
  assert.equal(sanitizeAssistantText('<think>only this</think>'), '');
});
