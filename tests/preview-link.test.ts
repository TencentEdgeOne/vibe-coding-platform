import assert from 'node:assert/strict';
import test from 'node:test';
import { previewDeepLink } from '../shared/preview-link.ts';

const base = 'https://9000-sandbox.example.com/preview/?access_token=sit_live';

test('the tracked route keeps its query out of the path', () => {
  // What the tracker actually reports for the preview root: a whole relative
  // URL, query included. Assigning it to `pathname` produced
  // /preview/%3Faccess_token=... plus a second copy of the token, which is a
  // path no route can match.
  const link = previewDeepLink(base, '/preview/?access_token=sit_live');
  assert.equal(link, base);
  assert.ok(!link.includes('%3F'));
  assert.equal(link.match(/access_token/g)?.length, 1);
});

test('a deep route carries the base token forward', () => {
  // An in-app navigation drops the token from the iframe's own URL, so a link
  // built from the tracked route alone would land on the gateway's auth wall.
  assert.equal(
    previewDeepLink(base, '/preview/blog/first-post'),
    'https://9000-sandbox.example.com/preview/blog/first-post?access_token=sit_live',
  );
});

test('the route\u2019s own query and hash survive alongside the token', () => {
  assert.equal(
    previewDeepLink(base, '/preview/search?q=makers#results'),
    'https://9000-sandbox.example.com/preview/search?q=makers&access_token=sit_live#results',
  );
});

test('a route that carries its own token is not given a second one', () => {
  assert.equal(
    previewDeepLink(base, '/preview/?access_token=sit_rotated'),
    'https://9000-sandbox.example.com/preview/?access_token=sit_rotated',
  );
});

test('an empty tracked path falls back to the shareable URL', () => {
  assert.equal(previewDeepLink(base, ''), base);
});

test('a tracked path pointing off the sandbox is refused', () => {
  // The value arrives by postMessage, so it is not trusted to choose the host.
  assert.equal(previewDeepLink(base, 'https://attacker.example.com/steal'), base);
});

test('an unparseable base is handed back untouched', () => {
  assert.equal(previewDeepLink('not a url', '/preview/'), 'not a url');
  assert.equal(previewDeepLink('', '/preview/'), '');
});
