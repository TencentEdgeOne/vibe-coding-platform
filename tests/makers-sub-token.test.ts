import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  buildSandboxMakersEnv,
  ensureMakersTenantId,
  resolveMakersMasterToken,
  resolveSandboxMakersToken,
} from '../agents/project/_makers-token.ts';
import { projectState } from './helpers/fixtures.ts';

test('sandbox Makers tenant IDs are generated server-side and remain stable', () => {
  const first = projectState();
  const second = projectState();
  const firstId = ensureMakersTenantId(first);

  assert.match(firstId, /^vibe-[a-f0-9]{32}$/);
  assert.equal(ensureMakersTenantId(first), firstId);
  assert.notEqual(ensureMakersTenantId(second), firstId);
  assert.ok(firstId.length <= 64);
});

// A generated store reaches production through a credential baked into the
// deployed artifact, but reaches preview through a live exchange scoped to
// PAGES_BLOB_STS_ENV. Left to the sandbox CLI's compiled default, that is what
// makes a guestbook read fine on the live site and fail in preview with
// "credential exchange failed (code=-1): Invalid credential".
test('the sandbox is handed the credential and the storage environment, nothing else', () => {
  assert.deepEqual(buildSandboxMakersEnv('tenant-token'), {
    PAGES_SOURCE: 'skills',
    EDGEONE_PAGES_API_TOKEN: 'tenant-token',
    PAGES_BLOB_STS_ENV: 'prod',
  });
  assert.deepEqual(buildSandboxMakersEnv(), {
    PAGES_SOURCE: 'skills',
    PAGES_BLOB_STS_ENV: 'prod',
  });
});

test('the runtime credential is read from API_TOKEN', () => {
  assert.equal(resolveMakersMasterToken({ env: { API_TOKEN: '  abc  ' } }), 'abc');
  // The CLI still consumes EDGEONE_PAGES_API_TOKEN inside the sandbox. That is
  // a different name on a different process, not an alias for the runtime key.
  assert.equal(resolveMakersMasterToken({ env: { EDGEONE_PAGES_API_TOKEN: 'old' } }), '');
  assert.equal(resolveMakersMasterToken({ env: {} }), '');
});

// The token issuer and the sandbox CLI verify against separate hosts, and a
// switch that moves only one of them surfaces as a bare "Your token is not
// valid" with nothing pointing at the split. Both ends default to production,
// so the way to keep them together is to leave nothing to configure.
test('no environment switch is left for a deployment to get wrong', async () => {
  const tokenSource = await readFile('agents/project/_makers-token.ts', 'utf8');

  for (const name of [
    'MAKERS_API_ENV',
    'MAKERS_API_REGION',
    'EDGEONE_PAGES_API_REGION',
    'MAKERS_SUB_TOKEN_TTL_SECONDS',
  ]) {
    assert.doesNotMatch(tokenSource, new RegExp(name), `${name} must not come back`);
  }
  // No host either: the SDK probes China first and caches whichever answers.
  assert.doesNotMatch(tokenSource, /baseUrl/);
});

// "…tenant token: Automatic region detection failed." trips the activity
// scrubber, which blanks whatever follows a "token:" label and leaves the
// operator staring at "[REDACTED] region detection failed."
test('token issue failures survive the activity scrubber', async () => {
  const tokenSource = await readFile('agents/project/_makers-token.ts', 'utf8');
  const messages = tokenSource.match(/Failed to issue a temporary Makers[^`]*/g) || [];

  assert.equal(messages.length, 2);
  for (const message of messages) {
    assert.doesNotMatch(message, /token\s*[:=]/i);
  }
});

// The master credential is the one thing the sandbox must never hold: it is
// account-wide and long-lived, while a CLI process is neither.
test('the master credential is exchanged, never handed to the sandbox', async () => {
  const tokenSource = await readFile('agents/project/_makers-token.ts', 'utf8');
  const resolver = tokenSource.match(
    /export async function resolveSandboxMakersToken[\s\S]*?\n}/,
  )?.[0] || '';

  assert.ok(resolver, 'the resolver must stay the single entry point');
  assert.match(resolver, /issueSandboxMakersSubToken\(state, masterToken\)/);
  assert.doesNotMatch(
    resolver,
    /return masterToken/,
    'no branch may pass the master credential through to the CLI',
  );
  // No opt-in left: a switch here is a switch that can be left in the wrong
  // position on a deployment nobody is watching.
  assert.doesNotMatch(tokenSource, /MAKERS_SANDBOX_TENANT_TOKEN/);

  // Nothing configured to exchange stays an empty injection, not an exchange
  // that throws: the CLI reports the missing credential better than we can.
  const state = projectState();
  assert.equal(await resolveSandboxMakersToken(state, ''), '');
  assert.equal(state.makersTenantId, undefined);
});

test('the tenant token is redacted out of CLI output', async () => {
  const [previewSource, commandSource] = await Promise.all([
    readFile('agents/project/_preview.ts', 'utf8'),
    readFile('agents/tools/_commands-wrap.ts', 'utf8'),
  ]);

  assert.match(previewSource, /redactSecret\(\s*failure,\s*sandboxToken,?\s*\)/);
  assert.match(commandSource, /redactToolResult\(result, makers\.sandboxToken\)/);
  assert.match(commandSource, /redactSecret\(/);
});

test('direct CLI calls route the runtime credential through one resolver', async () => {
  const [tokenSource, previewSource, commandSource, packageSource] = await Promise.all([
    readFile('agents/project/_makers-token.ts', 'utf8'),
    readFile('agents/project/_preview.ts', 'utf8'),
    readFile('agents/tools/_commands-wrap.ts', 'utf8'),
    readFile('package.json', 'utf8'),
  ]);

  assert.match(tokenSource, /\.tokens\.create\(\{/);
  assert.match(tokenSource, /tenantId/);
  assert.match(tokenSource, /expiresIn/);
  // Resume starts Makers dev without an LLM command, while normal preview and
  // deploy calls are intercepted on the generic sandbox commands tool. Neither
  // may reach past the resolver for a credential of its own.
  assert.match(previewSource, /resolveSandboxMakersToken\(state, masterToken\)/);
  assert.match(previewSource, /env: buildSandboxMakersEnv\(sandboxToken\)/);
  assert.match(commandSource, /resolveSandboxMakersToken\(/);
  assert.match(commandSource, /buildSandboxMakersEnv\(sandboxToken\)/);
  for (const source of [previewSource, commandSource]) {
    assert.doesNotMatch(source, /issueSandboxMakersSubToken/);
  }
  assert.doesNotMatch(commandSource, /makers deploy[^\n]* -t /);

  const packageJson = JSON.parse(packageSource);
  assert.equal(packageJson.dependencies['@edgeone/makers-sdk'], '0.1.0');
});
