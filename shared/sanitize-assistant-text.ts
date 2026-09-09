/** Remove terminal controls, leaked reasoning, and raw tool blocks from model text. */
export function sanitizeAssistantText(input: string): string {
  if (!input) return '';
  let text = input;

  text = text.replace(/\x1b\[[0-9;?]*[~A-Za-z]/g, '');
  text = text.replace(/\[20[01]~/g, '');
  text = text.replace(/\x1b\][^\x07]*\x07/g, '');
  text = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
  text = stripThinkBlocks(text);
  text = stripJsonBlocksMatching(text, /\{\s*"type"\s*:\s*"(?:tool_use|tool_result)"/);
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

function stripThinkBlocks(text: string): string {
  return text
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '')
    .replace(/<think\b[^>]*>[\s\S]*$/i, '');
}

function stripJsonBlocksMatching(text: string, startPattern: RegExp): string {
  let out = '';
  let index = 0;
  while (index < text.length) {
    const rest = text.slice(index);
    const match = rest.match(startPattern);
    if (!match || match.index === undefined) {
      out += rest;
      break;
    }
    out += rest.slice(0, match.index);
    const start = index + match.index;
    const end = findJsonObjectEnd(text, start);
    if (end < 0) {
      // The block never closes, which means the stream was cut inside it. Keeping
      // the tail would print `{"type":"tool_use","input":{"path":` into the chat,
      // and nothing after an unclosed brace is readable prose anyway — the same
      // call stripThinkBlocks makes for an unterminated <think>.
      break;
    }
    index = end + 1;
  }
  return out;
}

function findJsonObjectEnd(text: string, start: number): number {
  if (text[start] !== '{') return -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === '\\') {
        escaped = true;
        continue;
      }
      if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === '{') depth += 1;
    if (character === '}' && --depth === 0) return index;
  }
  return -1;
}
