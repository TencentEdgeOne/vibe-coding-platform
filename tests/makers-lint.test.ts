import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import {
  assertMakersProjectCompatible,
  buildMakersCompatibilityScript,
  loadMakersFrameworkProfiles,
  loadMakersValidationRules,
  runMakersCompatibilityCheck,
} from '../agents/project/_makers-compat.ts';
import { projectState } from './helpers/fixtures.ts';

const execFileAsync = promisify(execFile);

async function runLintFixture(files: Record<string, string>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'makers-lint-'));
  try {
    for (const [relative, content] of Object.entries(files)) {
      const target = path.join(root, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    const [rules, profiles] = await Promise.all([
      loadMakersValidationRules(),
      loadMakersFrameworkProfiles(),
    ]);
    const scriptPath = path.join(root, '.makers-compat-check.cjs');
    await writeFile(scriptPath, buildMakersCompatibilityScript(rules, profiles));
    try {
      const result = await execFileAsync(process.execPath, [scriptPath], { cwd: root });
      return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      const failed = error as {
        code?: number;
        stdout?: string;
        stderr?: string;
      };
      return {
        exitCode: typeof failed.code === 'number' ? failed.code : 1,
        stdout: failed.stdout || '',
        stderr: failed.stderr || '',
      };
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * The lint as the pipelines run it, against the sandbox contract that made the
 * report vanish: a shell that exits non-zero comes back as an exception with no
 * exit code, no stdout, and no stderr.
 */
async function runCompatCheckThroughSandbox(files: Record<string, string>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'makers-compat-'));
  const state = projectState(root);
  try {
    await mkdir(state.appDir, { recursive: true });
    for (const [relative, content] of Object.entries(files)) {
      const target = path.join(state.appDir, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    const context = {
      sandbox: {
        files: { write: (target: string, content: string) => writeFile(target, content) },
        commands: {
          run: async (command: string, options: { cwd?: string }) => {
            try {
              const result = await execFileAsync('/bin/sh', ['-c', command], { cwd: options.cwd });
              return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
            } catch {
              throw new Error(
                'Sandbox command failed [instanceId=fake]: exit status 2 '
                  + '(code=SANDBOX_UNKNOWN_ERROR, operation=command)',
              );
            }
          },
        },
      },
    };
    return await assertMakersProjectCompatible(context, state).then(
      () => undefined,
      (error: unknown) => error as Error,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// The lint knows exactly which file is wrong and says so, and exiting non-zero
// to report it is what threw the report away: the sandbox layer collapses a
// failed shell into SANDBOX_UNKNOWN_ERROR and keeps none of its output. What
// reached the model was "exit status 2", which reads as a broken sandbox — it
// spent one turn on the CLI version and another guessing at a file before it
// landed on the one named here all along.
test('a failing compatibility check reaches the caller as its own report', async () => {
  const failure = await runCompatCheckThroughSandbox({
    'agents/chat.ts': 'export async function onRequest() { return new Response("ok"); }\n',
  });

  assert.ok(failure, 'an agents/ project without edgeone.json must not pass');
  assert.match(failure.message, /MKR002.*edgeone\.json/);
  assert.match(failure.message, /MKR005.*\.env\.example/);
  assert.match(failure.message, /Fix only the reported project files/);
  // The wrong turn this failure used to invite, ruled out in the message that
  // replaces it.
  assert.doesNotMatch(failure.message, /SANDBOX_UNKNOWN_ERROR/);
  assert.match(failure.message, /not the EdgeOne CLI/);
});

test('a passing compatibility check is silent', async () => {
  const failure = await runCompatCheckThroughSandbox({
    'edgeone.json': '{"agents":{"framework":"claude-agent-sdk"}}',
    '.env.example': 'AI_GATEWAY_API_KEY=\nAI_GATEWAY_BASE_URL=\n',
    'agents/chat.ts': 'export async function onRequest() { return new Response("ok"); }\n',
  });

  assert.equal(failure, undefined, failure?.message);
});

test('Makers lint loads validation patterns from the vendored skills', async () => {
  const rules = await loadMakersValidationRules();
  assert.ok(rules.length >= 13);
  assert.ok(rules.some((rule) => (
    rule.skill === 'makers-edge-functions'
    && rule.pattern.includes('Response')
    && rule.pathPatterns.includes('edge-functions/**')
  )));
  assert.ok(rules.some((rule) => (
    rule.skill === 'makers-agents'
    && rule.pattern.includes('process')
    && rule.pathPatterns.includes('agents/**')
  )));
  for (const skill of [
    'makers-deploy',
    'makers-env-adaption',
    'makers-storage',
  ]) {
    assert.ok(rules.some((rule) => rule.skill === skill), skill);
  }
});

test('Makers lint accepts valid agent, function, edge, and middleware shapes', async () => {
  const result = await runLintFixture({
    'package.json': '{"dependencies":{"@edgeone/pages-blob":"latest"}}',
    'edgeone.json': '{"agents":{"framework":"claude-agent-sdk"}}',
    '.env.example': 'AI_GATEWAY_API_KEY=\nAI_GATEWAY_BASE_URL=\n',
    'agents/chat.ts': `
export async function onRequest(context: any) {
  const id = context.request.headers['makers-conversation-id'];
  return new Response(String(id || context.env.AI_GATEWAY_API_KEY));
}
`,
    'cloud-functions/api/messages.js': `
export async function onRequest({ request, env }) {
  return Response.json({ method: request.method, configured: Boolean(env.API_URL) });
}
`,
    'edge-functions/api/counter.js': `
export async function onRequest() {
  const count = await my_kv.get('count');
  return new Response(JSON.stringify({ count }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
`,
    'middleware.js': `
export function middleware(context) {
  return context.next();
}
`,
    // A relative in-app link resolves under the preview prefix and at / once
    // deployed, and so does the stylesheet beside it. Nothing builds this page,
    // so its own URLs are the ones the browser requests.
    'components/Nav.tsx': `
export default function Nav() {
  return <a href="ssr">SSR</a>;
}
`,
    'index.html': '<link rel="stylesheet" href="styles.css">\n',
  });

  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /Makers compatibility lint passed/);
});

// The prompt and the gate live in different files, and this is the assertion
// that keeps them together. It has already earned its place once: the prompt
// moved to prescribing root-absolute paths, MKR011 and MKR014 still rejected
// them, and every project would have failed its first preview by doing exactly
// as it was told.
test('the link and fetch form the prompt prescribes passes the gate', async () => {
  const result = await runLintFixture({
    'package.json': '{"name":"nested","scripts":{"build":"echo skip"}}',
    'index.html': '<a href="/blog">Blog</a>\n',
    // The deploy-correct form, which the host restores the prefix in front of.
    'app/blog/page.tsx': `
export default function Blog() {
  const load = () => fetch('/api/posts');
  return <><a href="/">Home</a><a href="/blog/post-1" onClick={load}>First</a></>;
}
`,
    // Relative links are still fine, and still need no arithmetic to be right.
    'app/blog/[slug]/page.tsx': `
export default function Post() {
  return <><a href="../..">Home</a><a href="..">All posts</a></>;
}
`,
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Makers compatibility lint passed/);
});

// What is left to reject: a path that already carries the prefix. It survives
// the preview — that is the trap — and doubles it once deployed.
test('a path that carries the sandbox prefix itself is rejected', async () => {
  const result = await runLintFixture({
    'package.json': '{"name":"nested","scripts":{"build":"echo skip"}}',
    'app/page.tsx': `
export default function Home() {
  const load = () => fetch('/preview/api/posts');
  return <a href="/preview/blog">All posts</a>;
}
`,
    'next.config.js': "module.exports = { basePath: '/preview' };",
  });

  assert.notEqual(result.exitCode, 0);
  const output = result.stdout + result.stderr;
  assert.match(output, /MKR015.*hard-coded/);
  assert.match(output, /MKR016.*every route 404s/);
});

// The gap MKR011 and MKR014 left behind when they retired. The shim restores
// the prefix for links and fetch because it wraps the code that resolves them;
// a <link> or <script> URL is resolved by the parser instead, mid-parse, with
// no code to wrap. Reported as "static files 404": document 200, build green,
// page unstyled, nothing in the console naming a cause.
test('a hand-written page that loads its assets root-absolute is rejected', async () => {
  const result = await runLintFixture({
    'package.json': '{"name":"guestbook","dependencies":{"@edgeone/pages-blob":"^0.0.14"}}',
    'index.html': `
<link rel="stylesheet" href="/style.css" />
<link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22><text>x</text></svg>" />
<a href="/about">About</a>
<script src="/script.js"></script>
`,
    'script.js': "const API = '/api/messages';\n",
  });
  const output = result.stdout + result.stderr;

  assert.equal(result.exitCode, 2);
  assert.match(output, /MKR019.*"\/style\.css"/);
  assert.match(output, /MKR019.*"\/script\.js"/);
  // Naming the replacement, because the fix is a one-character deletion that
  // reads like a typo unless the message says which form is wanted.
  assert.match(output, /"style\.css" for a sibling file/);
  // A data: URL is not a path, and the anchor and the fetch path are the shim's
  // to restore — flagging those is what MKR011 and MKR014 were retired for.
  assert.doesNotMatch(output, /data:image/);
  assert.doesNotMatch(output, /\/about/);
  assert.doesNotMatch(output, /\]\s*script\.js:/);
});

// The other half of the same rule. A bundler's index.html is a build input, and
// the root-absolute entry URL is the form its own scaffolder emits — base moves
// it at serve and build time. Flagging it would fail every correct Vite project.
test('a bundled entry page keeps the root-absolute form its build step rewrites', async () => {
  const result = await runLintFixture({
    'package.json': '{"name":"spa","devDependencies":{"vite":"^5.0.0"}}',
    'vite.config.ts': 'export default { base: process.env.EDGEONE_PREVIEW_ASSET_PREFIX };\n',
    'index.html': '<script type="module" src="/src/main.tsx"></script>\n',
  });

  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
});

/**
 * The shape that shipped: an agent whose preview streamed and whose deployed
 * /chat answered nothing at all, because deepagents 1.13 lists langchain and
 * langgraph as peers and the generated package.json declared neither. npm
 * installs peers regardless, so every environment with a node_modules agreed
 * the project was fine.
 */
test('Makers lint reports a declared package whose peers are not declared', async () => {
  const result = await runLintFixture({
    'package.json': JSON.stringify({
      dependencies: { deepagents: '^1.13.3', '@langchain/core': '^1.2.9' },
    }),
    'edgeone.json': '{"agents":{"framework":"deepagents"}}',
    '.env.example': 'AI_GATEWAY_API_KEY=\nAI_GATEWAY_BASE_URL=\n',
    'agents/chat.ts': 'export async function onRequest() { return new Response("ok"); }\n',
    'node_modules/deepagents/package.json': JSON.stringify({
      name: 'deepagents',
      version: '1.13.3',
      peerDependencies: {
        '@langchain/core': '^1.2.9',
        '@langchain/langgraph': '^1.4.10',
        langchain: '^1.5.10',
        langsmith: '>=0.7.1 <0.10.0',
      },
    }),
    'node_modules/@langchain/core/package.json': '{"name":"@langchain/core","version":"1.2.9"}',
  });
  const output = `${result.stderr}\n${result.stdout}`;

  assert.equal(result.exitCode, 2);
  assert.match(output, /MKR020.*package\.json.*declares deepagents/);
  assert.match(output, /@langchain\/langgraph, langchain, langsmith/);
  // The one peer that was declared stays out of the list.
  assert.doesNotMatch(output, /@langchain\/core, @langchain\/langgraph/);
});

test('Makers lint accepts declared peers, optional peers, and an uninstalled tree', async () => {
  const manifest = (name: string, extra: Record<string, unknown>) => JSON.stringify({
    name,
    version: '1.0.0',
    ...extra,
  });
  const result = await runLintFixture({
    'package.json': JSON.stringify({
      dependencies: { deepagents: '^1.13.3', langchain: '^1.5.10', 'not-installed': '^1.0.0' },
    }),
    'edgeone.json': '{"agents":{"framework":"deepagents"}}',
    '.env.example': 'AI_GATEWAY_API_KEY=\nAI_GATEWAY_BASE_URL=\n',
    'agents/chat.ts': 'export async function onRequest() { return new Response("ok"); }\n',
    'node_modules/deepagents/package.json': manifest('deepagents', {
      peerDependencies: { langchain: '^1.5.10', langsmith: '>=0.7.1 <0.10.0' },
      peerDependenciesMeta: { langsmith: { optional: true } },
    }),
    'node_modules/langchain/package.json': manifest('langchain', {}),
  });
  const output = `${result.stderr}\n${result.stdout}`;

  assert.equal(result.exitCode, 0, output);
  assert.doesNotMatch(output, /MKR020/);
});

test('Makers lint reports actionable platform convention violations', async () => {
  const result = await runLintFixture({
    'src/api.ts': `export const send = () => fetch('/preview/chat');`,
    'next.config.js': "module.exports = { basePath: '/preview' };",
    'edgeone.json': '{"agents":{"framework":"basic"}}',
    '.env.example': 'AI_GATEWAY_API_KEY=\n',
    'agents/chat.ts': `
export async function POST(context: any) {
  const token = process.env.AI_GATEWAY_API_KEY;
  return new Response(context.request.headers.get('x-id') || token);
}
`,
    'cloud-functions/api/raw': 'export const key = process.env.API_KEY;',
    'cloud-functions/api/config.js': 'export const key = process.env.API_KEY;',
    'edge-functions/api/counter.js': `
import fs from 'fs';
export function onRequest(context) {
  const headers = new Headers();
  fs.writeFile('/tmp/count', '1', () => {});
  return Response.json({ value: context.env.KV.get('count'), headers });
}
`,
    'middleware.js': 'export function onRequest(context) { return context.next(); }',
  });
  const output = `${result.stderr}\n${result.stdout}`;

  assert.equal(result.exitCode, 2);
  assert.match(output, /MKR004.*agents\.framework must be one of/);
  assert.match(output, /MKR006.*AI_GATEWAY_BASE_URL/);
  assert.match(output, /MKR008.*agents\/chat\.ts/);
  assert.match(output, /MKR010.*cloud-functions\/api\/raw/);
  assert.match(output, /MKR015.*sandbox \/preview\/ prefix is hard-coded/);
  assert.match(output, /MKR016.*basePath/);
  assert.match(output, /context\.env.*makers-storage/);
  assert.match(output, /MKR012.*middleware\(context\)/);
  assert.match(output, /makers-agents/);
  assert.match(output, /makers-cloud-functions/);
  assert.match(output, /makers-edge-functions/);
});

test('Makers lint leaves framework-native middleware to the framework', async () => {
  const result = await runLintFixture({
    'package.json': '{"dependencies":{"next":"latest"}}',
    'middleware.ts': `
import { NextResponse, type NextRequest } from 'next/server';
export function middleware(request: NextRequest) {
  return NextResponse.next({ request });
}
`,
  });

  assert.equal(result.exitCode, 0, result.stderr);
});

test('Makers lint applies sandbox and deploy rules to matching root files', async () => {
  const result = await runLintFixture({
    'package.json': '{"scripts":{"preview":"npx serve dist"}}',
    'deploy.sh': 'edgeone whoami -t secret\n',
  });
  const output = `${result.stderr}\n${result.stdout}`;

  assert.equal(result.exitCode, 2);
  assert.match(output, /self-hosted static servers.*makers-env-adaption/);
  assert.match(output, /whoami does not accept -t.*makers-deploy/);
});

test('Makers lint ignores prose files and comment-only examples', async () => {
  const result = await runLintFixture({
    'agents/README.md': 'Never use process.env in an agent.',
    'edge-functions/api/hello.js': `
// Response.json({ documented: 'bad' })
/* process.env.API_KEY */
export function onRequest() {
  return new Response('ok');
}
`,
  });

  assert.equal(result.exitCode, 0, result.stderr);
});

// The whole reason this check exists: `edgeone makers dev` runs the framework's
// own dev server, which never loads the platform adapter, so a project missing
// one previews green and deploys broken. The lint is the only gate that sees it.
test('a server-rendered framework without its platform adapter is rejected', async () => {
  const result = await runLintFixture({
    'package.json': '{"dependencies":{"astro":"^5.0.0"}}',
    'astro.config.mjs': `
import { defineConfig } from 'astro/config';
export default defineConfig({ output: 'server' });
`,
  });
  const output = `${result.stderr}\n${result.stdout}`;

  assert.equal(result.exitCode, 2);
  assert.match(output, /MKR017.*@edgeone\/astro/);
  assert.match(output, /MKR018.*astro\.config\.mjs/);
  // The failure has to name the trap, or the fix reads as busywork against a
  // preview the agent just watched succeed.
  assert.match(output, /preview will look correct and the deployment will not/);
});

test('an installed adapter that is never wired into the config is still rejected', async () => {
  const result = await runLintFixture({
    'package.json': '{"dependencies":{"astro":"^5.0.0","@edgeone/astro":"^1.0.0"}}',
    'astro.config.mjs': `
import { defineConfig } from 'astro/config';
export default defineConfig({ output: 'server' });
`,
  });
  const output = `${result.stderr}\n${result.stdout}`;

  assert.equal(result.exitCode, 2);
  assert.doesNotMatch(output, /MKR017/);
  assert.match(output, /MKR018.*not referenced in this config/);
});

test('a static build of the same framework needs no adapter', async () => {
  const result = await runLintFixture({
    'package.json': '{"dependencies":{"astro":"^5.0.0"}}',
    'astro.config.mjs': `
import { defineConfig } from 'astro/config';
export default defineConfig({ output: 'static' });
`,
  });

  assert.equal(result.exitCode, 0, result.stderr);
});

// Astro's own default is static, so the config a scaffolder emits says nothing
// about output at all. Demanding an adapter there would fail correct projects.
test('a framework defaulting to static passes with no output declared', async () => {
  const result = await runLintFixture({
    'package.json': '{"dependencies":{"astro":"^5.0.0"}}',
    'astro.config.mjs': "import { defineConfig } from 'astro/config';\nexport default defineConfig({});\n",
  });

  assert.equal(result.exitCode, 0, result.stderr);
});

// The inverse default, and the case a single serverOutputPattern got wrong:
// React Router renders on the server unless react-router.config.ts opts out,
// and that is a different file from the vite.config.ts the adapter lives in.
test('a framework defaulting to server is flagged with no rendering config at all', async () => {
  const result = await runLintFixture({
    'package.json': '{"dependencies":{"@react-router/dev":"^7.0.0"}}',
    'vite.config.ts': "import { reactRouter } from '@react-router/dev/vite';\nexport default { plugins: [reactRouter()] };\n",
  });
  const output = `${result.stderr}\n${result.stdout}`;

  assert.equal(result.exitCode, 2);
  assert.match(output, /MKR017.*@edgeone\/react-router/);
});

test('the same framework in single-page mode opts out through its own config file', async () => {
  const result = await runLintFixture({
    'package.json': '{"dependencies":{"@react-router/dev":"^7.0.0"}}',
    'react-router.config.ts': 'export default { ssr: false };\n',
    'vite.config.ts': "import { reactRouter } from '@react-router/dev/vite';\nexport default { plugins: [reactRouter()] };\n",
  });

  assert.equal(result.exitCode, 0, result.stderr);
});

test('a framework that cannot build without an adapter is flagged unconditionally', async () => {
  const result = await runLintFixture({
    'package.json': '{"dependencies":{"@sveltejs/kit":"^2.4.0"}}',
    'svelte.config.js': "import adapter from '@sveltejs/adapter-auto';\nexport default { kit: { adapter: adapter() } };\n",
  });
  const output = `${result.stderr}\n${result.stdout}`;

  assert.equal(result.exitCode, 2);
  assert.match(output, /MKR017.*@edgeone\/sveltekit/);
  // And the frontmatter rule that explains why the adapter already there is the
  // wrong one, which the bare absence check cannot say.
  assert.match(output, /adapter-auto cannot detect this platform.*makers-frameworks/);
});

test('a correctly adapted project passes', async () => {
  const result = await runLintFixture({
    'package.json': '{"dependencies":{"@sveltejs/kit":"^2.4.0","@edgeone/sveltekit":"^1.0.0"}}',
    'svelte.config.js': "import adapter from '@edgeone/sveltekit';\nexport default { kit: { adapter: adapter() } };\n",
  });

  assert.equal(result.exitCode, 0, result.stderr);
});

// `sv create` stopped writing svelte.config.js and now passes the SvelteKit
// config to the Vite plugin, so a template with the adapter already wired had
// nothing this rule recognised and one session lost a preview to it.
test('the adapter counts when SvelteKit keeps its config in the Vite one', async () => {
  const result = await runLintFixture({
    'package.json': '{"dependencies":{"@sveltejs/kit":"^2.4.0","@edgeone/sveltekit":"^1.1.1"}}',
    'vite.config.ts': "import adapter from '@edgeone/sveltekit';\n"
      + "import { sveltekit } from '@sveltejs/kit/vite';\n"
      + 'export default { plugins: [sveltekit({ adapter: adapter() })] };\n',
  });

  assert.equal(result.exitCode, 0, result.stderr);
});

// The shape that has to keep passing: a project may still put everything in
// svelte.config.js, and then vite.config.ts is present but says nothing about
// the adapter. Reading the Vite config unconditionally would fail it.
test('a SvelteKit project that still uses svelte.config.js is read from there', async () => {
  const result = await runLintFixture({
    'package.json': '{"dependencies":{"@sveltejs/kit":"^2.4.0","@edgeone/sveltekit":"^1.1.1"}}',
    'svelte.config.js': "import adapter from '@edgeone/sveltekit';\nexport default { kit: { adapter: adapter() } };\n",
    'vite.config.ts': "import { sveltekit } from '@sveltejs/kit/vite';\n"
      + 'export default { plugins: [sveltekit()] };\n',
  });

  assert.equal(result.exitCode, 0, result.stderr);
});

// And the one worth the whole mechanism. Both files exist, the adapter is in
// svelte.config.js, and the injected preview prefix has put an option in the
// Vite call — which makes svelte.config.js unreachable in full. Every other
// gate is green here: the install succeeded, the dev server previews fine, and
// the build reports success while emitting output with no adapter behind it.
test('an adapter in svelte.config.js is rejected when the Vite call overrides it', async () => {
  const result = await runLintFixture({
    'package.json': '{"dependencies":{"@sveltejs/kit":"^2.4.0","@edgeone/sveltekit":"^1.1.1"}}',
    'svelte.config.js': "import adapter from '@edgeone/sveltekit';\nexport default { kit: { adapter: adapter() } };\n",
    'vite.config.ts': "import { sveltekit } from '@sveltejs/kit/vite';\n"
      + 'export default { plugins: [sveltekit({ paths: { base: process.env.EDGEONE_PREVIEW_ASSET_PREFIX } })] };\n',
  });
  const output = `${result.stderr}\n${result.stdout}`;

  assert.equal(result.exitCode, 2);
  assert.match(output, /MKR018.*vite\.config\.ts/);
  // Without the reason the report names the file the adapter is already in,
  // which reads as a lint that cannot see.
  assert.match(output, /svelte\.config\.js beside it is ignored whole/);
});

// A framework the builder supports directly. Demanding an adapter here would be
// a false failure with no legal fix.
test('a framework that needs no adapter is left alone', async () => {
  const result = await runLintFixture({
    'package.json': '{"dependencies":{"next":"^15.0.0"}}',
    'next.config.js': 'export default { assetPrefix: process.env.EDGEONE_PREVIEW_ASSET_PREFIX };\n',
  });

  assert.equal(result.exitCode, 0, result.stderr);
});

test('framework profiles are loaded from the vendored skill', async () => {
  const profiles = await loadMakersFrameworkProfiles();
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));

  for (const id of ['astro', 'react-router', 'sveltekit', 'tanstack-start', 'vike']) {
    assert.ok(byId.get(id)?.adapter?.package.startsWith('@edgeone/'), id);
  }
  // Supported by the builder directly; an adapter entry here would produce a
  // failure the agent could only satisfy by installing something that does not
  // exist.
  for (const id of ['nextjs', 'nuxt']) {
    assert.equal(byId.get(id)?.adapter, null, id);
  }
});

/** The lint as the pipelines invoke it, counting what reaches the sandbox. */
function countingCompatContext(options: { loseScriptAfter?: number } = {}) {
  const writes: string[] = [];
  let runs = 0;
  let scriptPresent = false;
  // A recycle happens once. Losing the script on every later run would defeat
  // the re-upload too, and the test would be asserting that retries are futile.
  let lost = false;
  const context = {
    sandbox: {
      files: {
        write: async (target: string) => {
          writes.push(target);
          scriptPresent = true;
        },
      },
      commands: {
        run: async () => {
          runs += 1;
          if (options.loseScriptAfter && runs > options.loseScriptAfter && !lost) {
            scriptPresent = false;
            lost = true;
          }
          if (!scriptPresent) {
            return {
              exitCode: 0,
              stdout: '',
              stderr: "Error: Cannot find module '../.makers-compat-check.cjs'\ncode: 'MODULE_NOT_FOUND'\nEXIT:1",
            };
          }
          return { exitCode: 0, stdout: 'Makers compatibility lint passed\nEXIT:0', stderr: '' };
        },
      },
    },
  };
  return { context, writes, runCount: () => runs };
}

// The lint runs at least twice a turn — once before the preview starts, once at
// verification — and the script body is the same every time, because it is
// built from skills that are read once per process.
test('the lint script is uploaded once per session, not once per run', async () => {
  const sandbox = countingCompatContext();
  const state = projectState('projects/upload-once');

  await runMakersCompatibilityCheck(sandbox.context, state);
  await runMakersCompatibilityCheck(sandbox.context, state);
  await runMakersCompatibilityCheck(sandbox.context, state);

  assert.equal(sandbox.writes.length, 1);
  assert.equal(sandbox.runCount(), 3);
});

// A cache that outlives the file it describes is worse than no cache: the lint
// would report a missing module as a project failure, and the model would go
// looking for a fault in code that was never examined.
test('a sandbox that lost the script gets it back instead of failing the project', async () => {
  const sandbox = countingCompatContext({ loseScriptAfter: 1 });
  const state = projectState('projects/recycled');

  const first = await runMakersCompatibilityCheck(sandbox.context, state);
  assert.equal(first.exitCode, 0);

  const second = await runMakersCompatibilityCheck(sandbox.context, state);
  assert.equal(second.exitCode, 0, 'the retry after re-upload is what has to pass');
  assert.equal(sandbox.writes.length, 2, 'the lost script was sent again');
});

test('separate sessions each get their own copy', async () => {
  const sandbox = countingCompatContext();

  await runMakersCompatibilityCheck(sandbox.context, projectState('projects/one'));
  await runMakersCompatibilityCheck(sandbox.context, projectState('projects/two'));

  assert.deepEqual(sandbox.writes, [
    'projects/one/.makers-compat-check.cjs',
    'projects/two/.makers-compat-check.cjs',
  ]);
});
