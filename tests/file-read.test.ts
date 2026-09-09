import assert from 'node:assert/strict';
import test from 'node:test';
import { PREVIEW_MAX_BYTES } from '../agents/_constants.ts';
import {
  capBatchReadResults,
  truncateUtf8,
} from '../agents/utils/_file-preview.ts';

test('file preview truncates on a UTF-8 boundary', () => {
  const result = truncateUtf8(`${'a'.repeat(PREVIEW_MAX_BYTES - 1)}你`, PREVIEW_MAX_BYTES);
  assert.equal(result.size, PREVIEW_MAX_BYTES + 2);
  assert.equal(result.truncated, true);
  assert.equal(result.content, 'a'.repeat(PREVIEW_MAX_BYTES - 1));
});

test('batch file preview applies a total response cap', () => {
  const files = capBatchReadResults([
    { ok: true, path: 'a.ts', content: '1234', size: 4 },
    { ok: true, path: 'b.ts', content: '5678', size: 4 },
  ], 6);

  assert.equal(files[0].ok, true);
  assert.equal(files[1].ok, false);
  assert.match(files[1].error || '', /byte limit/i);
});
