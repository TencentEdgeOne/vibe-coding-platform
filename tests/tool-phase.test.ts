import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildEdgeoneVersionCheckCommand,
  forbiddenSandboxCommandReason,
  isEdgeoneCliUnavailable,
  isEdgeoneVersionCommand,
  isInstallCommand,
  isMakersDeployCommand,
  isMakersDevCommand,
  isPreviewCommand,
  isVerificationCommand,
  parseEdgeoneVersionExitCode,
  parseEchoedExitCode,
  shortenToolName,
  stripEchoedExit,
  withExitCodeEcho,
} from '../agents/utils/_tool-phase.ts';

test('shortens MCP tool names', () => {
  assert.equal(shortenToolName('mcp__edgeone-sandbox__files_write'), 'files_write');
  assert.equal(shortenToolName('write_project_file'), 'write_project_file');
});

test('detects install, preview, and verification commands', () => {
  assert.equal(isInstallCommand('npm install'), true);
  assert.equal(isInstallCommand('pnpm install --frozen-lockfile'), true);
  assert.equal(isInstallCommand('cd app && npm install'), true);
  assert.equal(isInstallCommand('npm run build'), false);
  // Quoted text names the install; it is not one. The command that produced
  // this case was probing whether the warmup was still running, and being
  // classified as an install stopped the preview it was trying to recover.
  assert.equal(isInstallCommand('pgrep -af "npm install|npm ci"'), false);
  assert.equal(isInstallCommand("pgrep -af 'npm install'"), false);
  assert.equal(isPreviewCommand('npm run dev'), true);
  assert.equal(isPreviewCommand('vite dev --host'), true);
  assert.equal(isPreviewCommand('edgeone makers dev --skip-env-sync'), true);
  assert.equal(isPreviewCommand('npm run lint'), false);
  assert.equal(isPreviewCommand('npm run build'), false);
  assert.equal(isVerificationCommand('npm run build'), true);
  assert.equal(isVerificationCommand('npx tsc -b'), true);
  assert.equal(isVerificationCommand('python -m compileall .'), true);
  assert.equal(isVerificationCommand('npm install'), false);
  assert.equal(isVerificationCommand('npm run dev'), false);
});

test('a command that names the launcher in order to kill it is not a launch', () => {
  // The wrapper replaces a launch command with its own launcher script. Reading
  // `pkill -f "edgeone makers dev"` as a launch answered a stop request with
  // "already-running" and dropped the pkill, so the dev server could not be
  // restarted at all once its dependencies changed under it.
  assert.equal(isMakersDevCommand('pkill -f "edgeone makers dev"'), false);
  assert.equal(isMakersDevCommand("pgrep -f 'edgeone makers dev'"), false);
  assert.equal(isMakersDeployCommand('pkill -f "edgeone makers deploy"'), false);
  assert.equal(isPreviewCommand('pkill -f "npm run dev"'), false);
  // Still a launch wherever it is actually invoked, including behind a wrapper
  // or after a directory change: losing these would let the model start a dev
  // server the host knows nothing about.
  assert.equal(isMakersDevCommand('edgeone makers dev --port 8088'), true);
  assert.equal(isMakersDevCommand('cd app && edgeone makers dev'), true);
  assert.equal(isMakersDevCommand('nohup edgeone makers dev &'), true);
  assert.equal(
    isMakersDevCommand('edgeone makers dev --name "edgeone makers deploy"'),
    true,
  );
  assert.equal(isMakersDeployCommand('edgeone makers deploy -n \'demo\''), true);
});

test('appends EXIT echo to install and verification commands once', () => {
  assert.equal(withExitCodeEcho('npm run build'), 'npm run build; echo EXIT:$?');
  assert.equal(
    withExitCodeEcho('npx tsc -b 2>&1; echo "EXIT:$?"'),
    'npx tsc -b 2>&1; echo "EXIT:$?"',
  );
  assert.equal(withExitCodeEcho('npm install'), 'npm install; echo EXIT:$?');
  assert.equal(
    withExitCodeEcho('cd app && npm install'),
    'cd app && npm install; echo EXIT:$?',
  );
  assert.equal(withExitCodeEcho('npm run dev'), 'npm run dev');
  assert.equal(parseEchoedExitCode('error TS6133\nEXIT:1\n'), 1);
  assert.equal(parseEchoedExitCode('{"stdout":"built\\nEXIT:0\\n","exitCode":0}'), 0);
  assert.equal(stripEchoedExit('error TS6133\nEXIT:1\n'), 'error TS6133');
});

test('allows direct Makers CLI lifecycle commands but blocks unsafe CLI operations', () => {
  assert.equal(forbiddenSandboxCommandReason('edgeone makers deploy --json'), null);
  assert.equal(
    forbiddenSandboxCommandReason('edgeone makers dev --port 8088 --skip-env-sync'),
    null,
  );
  assert.equal(forbiddenSandboxCommandReason('edgeone --version'), null);
  assert.equal(forbiddenSandboxCommandReason('edgeone -v; echo "EXIT:$?"'), null);
  assert.equal(isEdgeoneVersionCommand('edgeone --version'), true);
  assert.match(buildEdgeoneVersionCheckCommand(), /EDGEONE_VERSION_EXIT:\$version_status/);
  assert.equal(
    parseEdgeoneVersionExitCode('edgeone: not found\nEDGEONE_VERSION_EXIT:127\n'),
    127,
  );
  assert.equal(
    isEdgeoneCliUnavailable(
      "nohup: failed to run command 'edgeone': No such file or directory",
    ),
    true,
  );
  assert.equal(
    isEdgeoneCliUnavailable('/bin/sh: 2: edgeone: not found'),
    true,
  );
  assert.equal(
    isEdgeoneCliUnavailable('zsh: command not found: edgeone'),
    true,
  );
  assert.equal(
    isEdgeoneCliUnavailable('Makers project not found for edgeone deployment'),
    false,
  );
  assert.match(
    forbiddenSandboxCommandReason('edgeone --version; rm -rf /tmp/project') || '',
    /Only use the sandbox EdgeOne CLI/,
  );
  assert.match(
    forbiddenSandboxCommandReason('edgeone makers deploy -t secret --json') || '',
    /Do not pass a token/,
  );
  assert.match(
    forbiddenSandboxCommandReason('edgeone login --site china') || '',
    /Only use the sandbox EdgeOne CLI/,
  );
  assert.match(
    forbiddenSandboxCommandReason('curl https://pages-api.cloud.tencent.com/v1') || '',
    /Pages APIs/,
  );
  assert.match(
    forbiddenSandboxCommandReason('cat > ~/.curlrc <<EOF') || '',
    /curl defaults/,
  );
  assert.equal(forbiddenSandboxCommandReason('npm run build'), null);
  assert.equal(forbiddenSandboxCommandReason('npm view @edgeone/pages-blob versions --json'), null);
  assert.equal(forbiddenSandboxCommandReason('ls -R node_modules/@edgeone/pages-blob'), null);
  assert.equal(forbiddenSandboxCommandReason('npm install @edgeone/pages-blob'), null);
  assert.match(
    forbiddenSandboxCommandReason('npx edgeone makers deploy --json') || '',
    /Do not invoke EdgeOne through npx/,
  );
  assert.match(
    forbiddenSandboxCommandReason('curl https://ai-gateway.edgeone.link/v1/models') || '',
    /Do not probe the AI Gateway/,
  );
  assert.match(
    forbiddenSandboxCommandReason('rg model .edgeone/agent-node/server.mjs') || '',
    /Do not inspect or modify generated .edgeone/,
  );
});
