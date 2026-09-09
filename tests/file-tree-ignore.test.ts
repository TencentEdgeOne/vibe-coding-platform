import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ARCHIVE_EXCLUDED_DIRECTORIES,
  FILE_TREE_IGNORED_DIRECTORIES,
  isIgnoredFileTreePath,
} from '../agents/_constants.ts';

test('file tree hides .edgeone created by makers deploy', () => {
  assert.ok(FILE_TREE_IGNORED_DIRECTORIES.includes('.edgeone'));
  assert.equal(isIgnoredFileTreePath('.edgeone'), true);
  assert.equal(isIgnoredFileTreePath('./.edgeone'), true);
  assert.equal(isIgnoredFileTreePath('.edgeone/project.json'), true);
  assert.equal(isIgnoredFileTreePath('./.edgeone/logs/deploy.log'), true);
  assert.equal(isIgnoredFileTreePath('edgeone.json'), false);
  assert.equal(isIgnoredFileTreePath('src/app.ts'), false);
});

test('source archive also excludes .edgeone', () => {
  assert.ok(ARCHIVE_EXCLUDED_DIRECTORIES.includes('.edgeone'));
});
