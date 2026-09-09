import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolveSandboxCommandOptions } from '../shared/sandbox-command.ts';

test('timeout in seconds is also sent as timeoutMs', () => {
  assert.deepEqual(resolveSandboxCommandOptions({ cwd: '/app', timeout: 420 }), {
    cwd: '/app',
    timeout: 420,
    timeoutMs: 420_000,
  });
});

test('explicit timeoutMs is preserved', () => {
  assert.deepEqual(resolveSandboxCommandOptions({ timeout: 30, timeoutMs: 12_000 }), {
    timeout: 30,
    timeoutMs: 12_000,
  });
});

test('runSandboxCommand forwards resolved timeoutMs to the sandbox API', async () => {
  const source = await readFile('agents/project/_commands.ts', 'utf8');
  assert.match(source, /resolveSandboxCommandOptions\(options\)/);
  assert.match(source, /context\.sandbox\.commands\.run\(command, resolved\)/);
});
