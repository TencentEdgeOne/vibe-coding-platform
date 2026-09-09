import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeRelPath, toAppRelPath } from '../agents/utils/_relpath.ts';

const appDir = 'projects/520e08c1-185a-4cbf-afc4-db1abfb15f14/app';

test('normalizeRelPath rejects absolute and parent segments', () => {
  assert.equal(normalizeRelPath('/tmp/x'), null);
  assert.equal(normalizeRelPath('../x'), null);
  assert.equal(normalizeRelPath('src/./App.tsx'), null);
  assert.equal(normalizeRelPath('src/App.tsx'), 'src/App.tsx');
});

test('toAppRelPath keeps already-relative project paths', () => {
  assert.equal(toAppRelPath('package.json', appDir), 'package.json');
  assert.equal(toAppRelPath('src/App.jsx', appDir), 'src/App.jsx');
});

test('toAppRelPath strips a mistaken appDir prefix', () => {
  assert.equal(
    toAppRelPath(`${appDir}/package.json`, appDir),
    'package.json',
  );
  assert.equal(
    toAppRelPath(`${appDir}/src/App.jsx`, appDir),
    'src/App.jsx',
  );
});

test('toAppRelPath strips leading slash and nested appDir prefixes', () => {
  assert.equal(
    toAppRelPath(`/${appDir}/vite.config.js`, appDir),
    'vite.config.js',
  );
  assert.equal(
    toAppRelPath(`${appDir}/${appDir}/src/main.jsx`, appDir),
    'src/main.jsx',
  );
});

test('toAppRelPath rejects the appDir itself', () => {
  assert.equal(toAppRelPath(appDir, appDir), null);
  assert.equal(toAppRelPath(`/${appDir}`, appDir), null);
});
