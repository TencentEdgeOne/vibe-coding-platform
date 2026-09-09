import assert from 'node:assert/strict';
import test from 'node:test';
import { TRANSLATIONS } from '../app/i18n.ts';
import { makersFileSemantic } from '../shared/makers-file-semantics.ts';

function file(path: string) {
  return makersFileSemantic({ path, type: 'file' });
}

function directory(path: string) {
  return makersFileSemantic({ path, type: 'directory' });
}

test('labels Makers capability roots and configuration files', () => {
  assert.deepEqual(directory('agents'), { capability: 'agent', badge: 'AI' });
  assert.deepEqual(directory('cloud-functions'), {
    capability: 'cloud-function',
    badge: 'API',
  });
  assert.deepEqual(directory('edge-functions'), {
    capability: 'edge-function',
    badge: 'EDGE',
  });
  assert.deepEqual(file('edgeone.json'), {
    capability: 'config',
    badge: 'CONFIG',
  });
  assert.deepEqual(file('middleware.js'), {
    capability: 'middleware',
    badge: 'MW',
    route: '/*',
  });
});

test('maps Makers function and agent files to public routes', () => {
  assert.equal(file('agents/chat.ts')?.route, '/chat');
  assert.equal(file('agents/chat/index.ts')?.route, '/chat');
  assert.equal(file('cloud-functions/api/users.js')?.route, '/api/users');
  assert.equal(file('cloud-functions/api/users/[id].js')?.route, '/api/users/:id');
  assert.equal(file('cloud-functions/api/[[default]].js')?.route, '/api/*');
  assert.equal(file('cloud-functions/api/index.py')?.route, '/api/*');
  assert.equal(file('cloud-functions/api.go')?.route, '/api/*');
  assert.equal(file('edge-functions/api/hello.js')?.route, '/api/hello');
  assert.equal(file('edge-functions/index.js')?.route, '/');
});

test('does not mislabel helpers, configs, or ordinary frontend files as routes', () => {
  assert.equal(file('agents/_shared.ts'), null);
  assert.equal(file('agents/chat/_tools.ts'), null);
  assert.equal(file('cloud-functions/requirements.txt'), null);
  assert.equal(file('edge-functions/api/README.md'), null);
  assert.equal(file('src/App.tsx'), null);
  assert.equal(directory('src'), null);
});

test('every Makers file capability has localized UI copy', () => {
  const capabilities = [
    'agent',
    'cloud-function',
    'edge-function',
    'middleware',
    'config',
  ] as const;
  for (const locale of ['zh', 'en'] as const) {
    for (const capability of capabilities) {
      assert.ok(TRANSLATIONS[locale].files.capabilities[capability]);
    }
  }
});
