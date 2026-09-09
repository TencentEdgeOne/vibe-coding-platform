import assert from 'node:assert/strict';
import test from 'node:test';
import { withoutPlatformName } from '../shared/platform-name.ts';

test('the product name keeps the brand and drops the tier', () => {
  assert.equal(
    withoutPlatformName('部署成功，站点已发布到 EdgeOne Makers 线上环境。'),
    '部署成功，站点已发布到 EdgeOne 线上环境。',
  );
  assert.equal(
    withoutPlatformName('Generated apps deploy to EdgeOne Makers.'),
    'Generated apps deploy to EdgeOne.',
  );
});

// The activity detail pane shows the command verbatim, so the rewrite has to
// leave something that still reads as a command rather than as prose.
test('a CLI invocation keeps its lowercase shape', () => {
  assert.equal(
    withoutPlatformName('edgeone makers dev --port 8088 --skip-env-sync --name demo'),
    'edgeone dev --port 8088 --skip-env-sync --name demo',
  );
  assert.equal(withoutPlatformName('edgeone makers deploy --json'), 'edgeone deploy --json');
});

test('the tier standing on its own becomes the brand, in either case', () => {
  assert.equal(
    withoutPlatformName('Makers dev is ready, but makers dev returned no URL.'),
    'EdgeOne dev is ready, but edgeone dev returned no URL.',
  );
  // An underscore is a word character, so an error code hides the name from a
  // word-boundary match and needs its own rule.
  assert.equal(
    withoutPlatformName('command returned errorCode=MAKERS_CLI_UNAVAILABLE'),
    'command returned errorCode=EDGEONE_CLI_UNAVAILABLE',
  );
  // Document ids and the temp logs the CLI leaves behind.
  assert.equal(withoutPlatformName('makers-storage'), 'edgeone-storage');
  assert.equal(withoutPlatformName('tail -n 80 /tmp/makers-dev.log'), 'tail -n 80 /tmp/edgeone-dev.log');
  assert.equal(withoutPlatformName('edgeone-makers-tools'), 'edgeone-tools');
});

// A model id is a live identifier the generated project sends to the gateway.
// Renaming it in a log sends the reader looking for a model that does not exist.
test('a model identifier is left alone', () => {
  assert.equal(
    withoutPlatformName('AI_GATEWAY_MODEL=@makers/deepseek-v4-flash'),
    'AI_GATEWAY_MODEL=@makers/deepseek-v4-flash',
  );
});

test('text without the platform tier is returned unchanged', () => {
  const untouched = 'npm install && npm run build; echo EXIT:$?';
  assert.equal(withoutPlatformName(untouched), untouched);
  assert.equal(withoutPlatformName(''), '');
});
