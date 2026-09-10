import assert from 'node:assert/strict';
import test from 'node:test';
import { wrapSandboxTools } from '../agents/tools/_commands-wrap.ts';
import { resolveMakersProjectName } from '../agents/project/_makers-deploy.ts';
import {
  MAKERS_DEV_PORT,
  PREVIEW_PATH_PREFIX,
  PREVIEW_PUBLIC_PORT,
  PREVIEW_SERVER_PORT,
} from '../agents/_constants.ts';
import { MAKERS_DEV_LAUNCH_TIMEOUT_SECONDS } from '../shared/makers-dev.ts';
import type {
  ClaudeMcpTool,
  DeploymentInfo,
} from '../agents/_types.ts';
import { projectState } from './helpers/fixtures.ts';

test('wraps verification commands with EXIT echo without marking protocol error', async () => {
  let received = '';
  const commandsTool = {
    name: 'commands',
    description: 'run',
    inputSchema: {},
    handler: async (args: { command?: string }) => {
      received = args.command || '';
      return {
        content: [{ type: 'text', text: JSON.stringify({ stdout: 'error TS6133\nEXIT:1\n', exitCode: 0 }) }],
      };
    },
  } as unknown as ClaudeMcpTool;

  const [wrapped] = wrapSandboxTools([commandsTool]);
  const result = await wrapped.handler({ command: 'npm run build' }, {});

  assert.ok(received.endsWith('npm run build; echo EXIT:$?'), received);
  assert.equal(result.isError, undefined);
});

test('wraps install commands so a failed resolve keeps its output', async () => {
  let received = '';
  const commandsTool = {
    name: 'commands',
    description: 'run',
    inputSchema: {},
    handler: async (args: { command?: string }) => {
      received = args.command || '';
      return { content: [{ type: 'text', text: 'ok' }] };
    },
  } as unknown as ClaudeMcpTool;

  const [wrapped] = wrapSandboxTools([commandsTool]);
  const result = await wrapped.handler({ command: 'npm install' }, {});

  assert.ok(received.includes('npm install; echo EXIT:$?'), received);
  assert.equal(result.isError, undefined);

  // The cache reclaim follows the install, and it has to follow the echo too:
  // the sandbox reads the exit code from that marker and throws the output away
  // whenever the script ends non-zero, which a cache clean on a full disk does.
  // lastIndexOf, because the handoff carries a cache clean of its own for the
  // warmup that died of ENOSPC, and that one runs before the install.
  const echoed = received.indexOf('npm install; echo EXIT:$?');
  const reclaimed = received.lastIndexOf('npm cache clean --force');
  assert.ok(reclaimed > echoed, `the reclaim must come after the exit marker: ${received}`);
});

// Both of the above also stop the dev server first, and that is not incidental:
// `next build` and `next dev` share .next, and npm renames inside node_modules
// while the server holds files open there. Neither failure names the dev
// server — one run read every file it had written looking for a `<Html>` import
// that was never there, and another got ENOTEMPTY on node_modules/next.
test('an install or a build stops the dev server before it runs', async () => {
  const seen: string[] = [];
  const commandsTool = {
    name: 'commands',
    description: 'run',
    inputSchema: {},
    handler: async (args: { command?: string }) => {
      seen.push(args.command || '');
      return { content: [{ type: 'text', text: 'ok' }] };
    },
  } as unknown as ClaudeMcpTool;

  const [wrapped] = wrapSandboxTools([commandsTool]);
  await wrapped.handler({ command: 'npm install next@15' }, {});
  await wrapped.handler({ command: 'npm run build' }, {});
  await wrapped.handler({ command: 'ls -la' }, {});

  const [install, build, listing] = seen;
  for (const command of [install, build]) {
    assert.match(command, /^stop_announce=/);
    assert.match(command, /stop_makers_dev/);
    // Said out loud, or the model goes on describing a preview that is down.
    assert.match(command, /edgeone makers dev/);
  }
  // Everything else is left alone: reading a file or listing a directory does
  // not contend with the server, and tearing down a working preview to run one
  // would make the preview the least reliable thing in the session.
  assert.equal(listing, 'ls -la');
});

test('a command that only mentions npm install in quotes does not stop the preview', async () => {
  let received = '';
  const commandsTool = {
    name: 'commands',
    description: 'run',
    inputSchema: {},
    handler: async (args: { command?: string }) => {
      received = args.command || '';
      return { content: [{ type: 'text', text: 'ok' }] };
    },
  } as unknown as ClaudeMcpTool;

  const [wrapped] = wrapSandboxTools([commandsTool]);
  await wrapped.handler({ command: 'pgrep -af "npm install|npm ci"' }, {});

  assert.equal(received, 'pgrep -af "npm install|npm ci"');
  assert.doesNotMatch(received, /stop_makers_dev/);
});

test('allows direct Makers CLI preview but blocks token and account-management commands', async () => {
  let received = '';
  const commandsTool = {
    name: 'commands',
    description: 'run',
    inputSchema: {},
    handler: async (args: { command?: string }) => {
      received = args.command || '';
      return { content: [{ type: 'text', text: 'ok' }] };
    },
  } as unknown as ClaudeMcpTool;

  const [wrapped] = wrapSandboxTools([commandsTool]);
  const preview = await wrapped.handler({
    command: `edgeone makers dev --port ${MAKERS_DEV_PORT} --skip-env-sync --name demo`,
  }, {});
  assert.match(received, /edgeone makers dev/);
  assert.equal(preview.isError, undefined);

  const version = await wrapped.handler({
    command: 'edgeone --version; echo "EXIT:$?"',
  }, {});
  assert.match(received, /edgeone --version/);
  assert.match(received, /EDGEONE_VERSION_EXIT/);
  assert.equal(version.isError, undefined);

  received = '';
  const token = await wrapped.handler({
    command: "edgeone makers deploy -n demo -t 'secret' --json",
  }, {});
  assert.equal(received, '');
  assert.equal(token.isError, true);
  assert.match((token.content[0] as { text: string }).text, /Do not pass a token/);

  const login = await wrapped.handler({ command: 'edgeone login --site china' }, {});
  assert.equal(login.isError, true);
  assert.match((login.content[0] as { text: string }).text, /Only use the sandbox EdgeOne CLI/);

  const api = await wrapped.handler({
    command: 'curl -s -X POST https://pages-api.cloud.tencent.com/v1 -d \'{"Action":"DeletePagesProject"}\'',
  }, {});
  assert.equal(api.isError, true);
  assert.match((api.content[0] as { text: string }).text, /Do not call Makers\/Pages APIs/);

  const scoped = await wrapped.handler({
    command: 'npm view @edgeone/pages-blob versions --json',
  }, {});
  assert.equal(received, 'npm view @edgeone/pages-blob versions --json');
  assert.equal(scoped.isError, undefined);
});

test('version check reports a terminal error when the sandbox CLI is absent', async () => {
  const commandsTool = {
    name: 'commands',
    description: 'run',
    inputSchema: {},
    handler: async () => ({
      content: [{
        type: 'text',
        text: JSON.stringify({
          stdout: 'EDGEONE_VERSION_EXIT:127\n',
          stderr: '/bin/sh: 2: edgeone: not found\n',
          exitCode: 0,
        }),
      }],
    }),
  } as unknown as ClaudeMcpTool;
  const [wrapped] = wrapSandboxTools([commandsTool]);

  const result = await wrapped.handler({ command: 'edgeone --version' }, {});
  const output = result.content.map((item) => (
    item && typeof item === 'object' && 'text' in item ? item.text : ''
  )).join('\n');

  assert.equal(result.isError, true);
  assert.match(output, /MAKERS_CLI_UNAVAILABLE/);
  assert.match(output, /"retryable":false/);
  assert.match(output, /Do not inspect PATH/);
});

test('direct makers dev is normalized, published, and reported through the lifecycle', async () => {
  let received: Record<string, unknown> = {};
  let published = '';
  const commandsTool = {
    name: 'commands',
    description: 'run',
    inputSchema: {},
    handler: async (args: Record<string, unknown>) => {
      received = args;
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            stdout: 'MAKERS_DEV_READY=started\nMAKERS_DEV_EXIT:0\n',
            stderr: '',
            exitCode: 0,
          }),
        }],
      };
    },
  } as unknown as ClaudeMcpTool;
  const state = projectState();
  const context = {
    env: {},
    sandbox: {
      envdAccessToken: 'sandbox-access',
      getHost: (port: number) => `preview-${port}.sandbox.example`,
      browser: {},
      files: {
        exists: async () => false,
        write: async () => {},
      },
      commands: {
        run: async () => ({ stdout: 'EXIT:0\n', stderr: '', exitCode: 0 }),
      },
    },
  };
  const [wrapped] = wrapSandboxTools([commandsTool], {
    context,
    state,
    onPreviewReady: ({ url }) => {
      published = url || '';
    },
  });

  const result = await wrapped.handler({ command: 'edgeone makers dev' }, {});

  assert.match(
    String(received.command),
    new RegExp(`nohup edgeone makers dev --port ${MAKERS_DEV_PORT}`),
  );
  assert.match(
    String(received.command),
    new RegExp(`http://127\\.0\\.0\\.1:${PREVIEW_SERVER_PORT}/preview/`),
  );
  assert.equal(received.cwd, state.appDir);
  assert.deepEqual(received.env, {
    PAGES_SOURCE: 'skills',
    PAGES_BLOB_STS_ENV: 'prod',
  });
  assert.equal(received.timeout, MAKERS_DEV_LAUNCH_TIMEOUT_SECONDS);
  assert.match(
    published,
    new RegExp(
      `^https://preview-${PREVIEW_PUBLIC_PORT}\\.sandbox\\.example${
        PREVIEW_PATH_PREFIX
      }\\?access_token=sandbox-access$`,
    ),
  );
  assert.match((result.content.at(-1) as { text: string }).text, /"status":"success"/);
});

test('direct makers dev returns the captured CLI log instead of an unknown sandbox error', async () => {
  let published = false;
  const commandsTool = {
    name: 'commands',
    description: 'run',
    inputSchema: {},
    handler: async () => ({
      content: [{
        type: 'text',
        text: JSON.stringify({
          stdout: 'MAKERS_DEV_EXIT:127\n',
          stderr: 'nohup: failed to run command edgeone: No such file or directory\n',
          exitCode: 0,
        }),
      }],
    }),
  } as unknown as ClaudeMcpTool;
  const state = projectState();
  const [wrapped] = wrapSandboxTools([commandsTool], {
    context: {
      env: {},
      sandbox: {
        files: { write: async () => {} },
        commands: {
          run: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
        },
      },
    },
    state,
    onPreviewReady: () => {
      published = true;
    },
  });

  const result = await wrapped.handler({ command: 'edgeone makers dev' }, {});
  const output = result.content.map((item) => (
    item && typeof item === 'object' && 'text' in item ? item.text : ''
  )).join('\n');

  assert.equal(result.isError, true);
  assert.equal(published, false);
  assert.match(output, /No such file or directory/);
  assert.match(output, /MAKERS_CLI_UNAVAILABLE/);
  assert.match(output, /"retryable":false/);
});

test('direct makers dev names the missing runtime key when the sandbox CLI cannot log in', async () => {
  const commandsTool = {
    name: 'commands',
    description: 'run',
    inputSchema: {},
    handler: async () => ({
      content: [{
        type: 'text',
        text: JSON.stringify({
          stdout: 'MAKERS_DEV_EXIT:1\n',
          stderr: [
            'You are not authenticated, and browser login is unavailable in a non-interactive environment.',
            'Please provide a token via `-t <token>` or set the EDGEONE_PAGES_API_TOKEN environment variable.',
          ].join('\n'),
          exitCode: 0,
        }),
      }],
    }),
  } as unknown as ClaudeMcpTool;
  const [wrapped] = wrapSandboxTools([commandsTool], {
    context: {
      env: {},
      sandbox: {
        files: { write: async () => {} },
        commands: {
          run: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
        },
      },
    },
    state: projectState(),
  });

  const result = await wrapped.handler({ command: 'edgeone makers dev' }, {});
  const output = result.content.map((item) => (
    item && typeof item === 'object' && 'text' in item ? item.text : ''
  )).join('\n');

  assert.equal(result.isError, true);
  assert.match(output, /Missing API_TOKEN in the Agent Runtime/);
  assert.doesNotMatch(output, /edgeone makers dev exited with code 1/);
});

test('direct makers deploy reports durable deployment state without replacing preview', async () => {
  let received: Record<string, unknown> = {};
  let previewPublished = false;
  const deploymentStates: DeploymentInfo[] = [];
  const deployUrl = 'https://demo.edgeone.cool?eo_token=keep-me&eo_time=1';
  const consoleUrl = 'https://console.example/deployments/dp-1';
  const commandsTool = {
    name: 'commands',
    description: 'run',
    inputSchema: {},
    handler: async (args: Record<string, unknown>) => {
      received = args;
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            stdout: `Deploying...\n${JSON.stringify({
              status: 'success',
              url: deployUrl,
              projectId: 'makers-1',
              deploymentId: 'dp-1',
              consoleUrl,
            })}\nMAKERS_DEPLOY_EXIT:0\n`,
            stderr: '',
            exitCode: 0,
          }),
        }],
      };
    },
  } as unknown as ClaudeMcpTool;
  const state = projectState();
  const [wrapped] = wrapSandboxTools([commandsTool], {
    context: {
      env: {},
      sandbox: {
        files: { write: async () => {} },
        commands: {
          run: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
        },
      },
    },
    state,
    onPreviewReady: () => {
      previewPublished = true;
    },
    onDeploymentStatus: (deployment) => {
      deploymentStates.push(deployment);
    },
  });

  const result = await wrapped.handler({
    command: 'edgeone makers deploy -e preview',
  }, {});

  assert.match(
    String(received.command),
    new RegExp(
      `edgeone makers deploy -n '${resolveMakersProjectName({ env: {} }, state)}' --json -e preview`,
    ),
  );
  assert.equal(received.cwd, state.appDir);
  assert.equal(received.timeout, 600);
  assert.equal(previewPublished, false);
  assert.equal(state.previewUrl, undefined);
  assert.equal(state.previewKind, undefined);
  assert.deepEqual(deploymentStates.map(({ status }) => status), ['running', 'success']);
  assert.equal(state.deployment?.url, deployUrl);
  assert.equal(state.deployment?.projectId, 'makers-1');
  assert.equal(state.deployment?.deploymentId, 'dp-1');
  assert.equal(state.deployment?.consoleUrl, consoleUrl);
  assert.match((result.content.at(-1) as { text: string }).text, /"status":"published"/);
});

test('direct makers deploy surfaces the captured CLI failure', async () => {
  let previewPublished = false;
  const deploymentStates: DeploymentInfo[] = [];
  const commandsTool = {
    name: 'commands',
    description: 'run',
    inputSchema: {},
    handler: async () => ({
      content: [{
        type: 'text',
        text: JSON.stringify({
          stdout: '{"status":"error","error":"Project name conflict"}\nMAKERS_DEPLOY_EXIT:1\n',
          stderr: '',
          exitCode: 0,
        }),
      }],
    }),
  } as unknown as ClaudeMcpTool;
  const state = projectState();
  const [wrapped] = wrapSandboxTools([commandsTool], {
    context: {
      env: {},
      sandbox: {
        files: { write: async () => {} },
        commands: {
          run: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
        },
      },
    },
    state,
    onPreviewReady: () => {
      previewPublished = true;
    },
    onDeploymentStatus: (deployment) => {
      deploymentStates.push(deployment);
    },
  });

  const result = await wrapped.handler({ command: 'edgeone makers deploy' }, {});
  const output = result.content.map((item) => (
    item && typeof item === 'object' && 'text' in item ? item.text : ''
  )).join('\n');

  assert.equal(result.isError, true);
  assert.equal(previewPublished, false);
  assert.deepEqual(deploymentStates.map(({ status }) => status), ['running', 'failed']);
  assert.equal(state.deployment?.status, 'failed');
  assert.match(state.deployment?.error || '', /Project name conflict/);
  assert.match(output, /Project name conflict/);
  assert.match(output, /"exitCode":1/);
});
