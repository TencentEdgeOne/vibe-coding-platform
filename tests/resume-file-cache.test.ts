import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RESUME_FILE_CACHE_MAX_BYTES,
  RESUME_FILE_CACHE_MAX_FILES,
  selectResumeCacheFiles,
} from '../shared/resume-file-cache.ts';
import type { FileTreeItem } from '../shared/protocol.ts';

function file(path: string, size: number): FileTreeItem {
  return {
    path,
    name: path.split('/').pop() || path,
    type: 'file',
    depth: path.split('/').length - 1,
    size,
  };
}

test('resume cache prioritizes app entry files and excludes binary assets', () => {
  const selected = selectResumeCacheFiles([
    file('src/z.ts', 100),
    file('public/logo.png', 100),
    file('package.json', 200),
    file('src/App.tsx', 300),
  ]);

  assert.deepEqual(selected.map((item) => item.path), [
    'package.json',
    'src/App.tsx',
    'src/z.ts',
  ]);
});

test('resume cache stays inside file count and byte budgets', () => {
  const files = Array.from({ length: RESUME_FILE_CACHE_MAX_FILES + 20 }, (_, index) =>
    file(`src/file-${index}.ts`, 64 * 1024));
  const selected = selectResumeCacheFiles(files);
  const bytes = selected.reduce((total, item) => total + (item.size || 0), 0);

  assert.ok(selected.length <= RESUME_FILE_CACHE_MAX_FILES);
  assert.ok(bytes <= RESUME_FILE_CACHE_MAX_BYTES);
});
