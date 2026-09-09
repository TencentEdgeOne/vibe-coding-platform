import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readdir, readFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import {
  applyProjectTemplate,
  listProjectTemplates,
  resolveProjectTemplate,
  withPreviewAssetPrefix,
} from '../agents/project/_templates.ts';
import { describeScaffold } from '../agents/tools/_project-tools.ts';
import { PREVIEW_ASSET_PREFIX_ENV } from '../agents/_constants.ts';
import { NPM_WARMUP_BASE } from '../shared/npm-install.ts';
import { projectState } from './helpers/fixtures.ts';

const execFileAsync = promisify(execFile);

const SKILLS_DIR = '.claude/skills/edgeone-makers-tools/references';
const REFERENCES_DIR = `${SKILLS_DIR}/makers-frameworks/references`;

/**
 * A ref names a file in the framework references, or a path from the skills
 * root when the framework is documented under a different skill — the agent
 * frameworks belong to makers-agents, which has no scaffolders to describe.
 */
function referenceFile(ref: string) {
  return ref.includes('/') ? path.join(SKILLS_DIR, ref) : path.join(REFERENCES_DIR, ref);
}

/** Files only: a recursive readdir counts the directories it walks as entries. */
async function committedFiles(id: string) {
  const entries = await readdir(path.join('templates', id), {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(
      path.join('templates', id),
      path.join(entry.parentPath, entry.name),
    ));
}

/**
 * A sandbox whose paths are relative to one root, matching what the platform
 * presents — and whose commands.run raises on a non-zero exit rather than
 * reporting one, which is what the real one does.
 *
 * /tmp is the exception it has to model: the extractor is written there and run
 * from appDir, so the fake maps absolute paths to a scratch directory of its
 * own instead of under the project root.
 */
async function templateFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'makers-template-'));
  const state = projectState('projects/demo');
  const abs = (target: string) => (
    path.isAbsolute(target) ? path.join(root, '__abs__', target) : path.join(root, target)
  );

  // The warmup this exercises ends in `nohup npm install &`, and with the real
  // npm on PATH that is what these tests were running: a background install
  // into a temp directory, still writing to it while the fixture tore it down.
  // Stubbing npm keeps the script itself real — the guards, the pid file, the
  // stamp all still run — while the one command that must not is inert.
  const stubBin = path.join(root, '__bin__');
  await mkdir(stubBin, { recursive: true });
  await writeFile(path.join(stubBin, 'npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

  const calls = { writes: [] as string[], commands: [] as string[] };
  const context = {
    sandbox: {
      files: {
        makeDir: async (target: string) => { await mkdir(abs(target), { recursive: true }); },
        exists: async (target: string) => existsSync(abs(target)),
        write: async (target: string, content: string) => {
          calls.writes.push(target);
          await mkdir(path.dirname(abs(target)), { recursive: true });
          await writeFile(abs(target), content);
        },
      },
      commands: {
        run: async (command: string, options: { cwd?: string } = {}) => {
          calls.commands.push(command);
          const cwd = abs(options.cwd || '.');
          await mkdir(cwd, { recursive: true });
          // The script is addressed by its absolute /tmp path, which this
          // fixture relocates; rewrite it the same way the fake write did.
          const rewritten = command.replaceAll(/(?<=^|\s)\/tmp\/\S+/g, (match) => abs(match));
          const { stdout, stderr } = await execFileAsync('sh', ['-c', rewritten], {
            cwd,
            env: { ...process.env, PATH: `${stubBin}:${process.env.PATH}` },
          });
          return { exitCode: 0, stdout, stderr };
        },
      },
    },
  };

  return {
    context,
    state,
    calls,
    readBytes: (relative: string) => readFile(path.join(root, relative)),
    exists: (relative: string) => existsSync(path.join(root, relative)),
    // The warmup detaches, so its last few writes can still land after the
    // command returns; retries are cheaper than reaching into it to wait.
    cleanup: () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }),
  };
}

// The bug this guards shipped twice and is invisible in review: a chat route
// that reads a singular `message` streams a clean 200 for the preview probe and
// answers every real request 400, because the array is the only body a chat UI
// sends. Baking the route was the fix; asserting it here is what keeps a later
// edit from quietly undoing it.
test('every baked agent route reads the messages array and nothing else', async () => {
  const agents = [];
  for (const { id } of await listProjectTemplates()) {
    if ((await committedFiles(id)).includes(path.join('agents', 'chat.ts'))) agents.push(id);
  }
  assert.ok(agents.length >= 2, `expected the baked agent templates, found ${agents.join(', ') || 'none'}`);

  for (const id of agents) {
    const route = await readFile(path.join('templates', id, 'agents', 'chat.ts'), 'utf8');
    assert.match(route, /body\?\.messages/, `templates/${id} does not read body.messages`);
    assert.doesNotMatch(
      route.replace(/^\s*\/\/.*$/gm, ''),
      /\bbody[^\n]*\.message\b(?!s)/,
      `templates/${id} has a singular message branch no client reaches`,
    );
  }
});

test('the manifest only lists templates whose files are actually committed', async () => {
  const templates = await listProjectTemplates();
  assert.ok(templates.length > 0, 'no baked templates; run npm run bake:templates');

  for (const template of templates) {
    assert.ok(
      (await committedFiles(template.id)).includes('package.json'),
      `templates/${template.id} has no package.json, so it is not a project`,
    );
  }
});

// Baked trees only reach a deployed run because edgeone.json names them, and
// the CLI globs that list with dot:false hardcoded — so `templates/**` alone
// silently left four dotfiles, .npmrc among them, out of every bundle. The
// second pattern buys back dotfiles but not a dot-directory's contents, which
// nothing here could carry, and a template arriving short is invisible until
// something it needed at install time is missing.
test('every committed template file is one edgeone.json can carry', async () => {
  const config = JSON.parse(await readFile('edgeone.json', 'utf8'));
  assert.deepEqual(
    config.agents?.includeFiles,
    ['templates/**', 'templates/**/.*'],
    'templates reach the agent bundle through these two patterns and nothing else',
  );

  for (const template of await listProjectTemplates()) {
    for (const file of await committedFiles(template.id)) {
      const buried = file
        .split(path.sep)
        .slice(0, -1)
        .find((segment) => segment.startsWith('.'));
      assert.ok(
        !buried,
        `templates/${template.id}/${file} sits under ${buried}/, which no `
          + 'includeFiles pattern can reach; bake it to a name without the dot',
      );
    }
  }
});

// The command is the reference's to state and the manifest only records which
// one produced the tree. When a skill sync changes a scaffolder, the baked tree
// is stale and nothing else would say so — the agent would keep serving the old
// framework version from a template nobody re-baked.
test('every baked template still matches the scaffold command its reference documents', async () => {
  for (const template of await listProjectTemplates()) {
    const markdown = await readFile(referenceFile(template.ref), 'utf8');
    assert.ok(
      markdown.includes(template.command),
      `${template.ref} no longer documents "${template.command}" — re-bake with `
      + `node scripts/bake-templates.mjs ${template.id}`,
    );
  }
});

// An adapter in package.json and nowhere else is the shape that broke: the
// model has to find the config, work out the wiring, and edit the one file
// carrying the injected preview prefix. SvelteKit made the cost concrete —
// its reference described a svelte.config.js the scaffolder stopped writing,
// and adding one there while leaving the prefix in vite.config.ts resolves to
// no adapter at all, silently, with a build that still reports success.
test('an adapter a template installs is also wired into its config', async () => {
  for (const template of await listProjectTemplates()) {
    const files = await committedFiles(template.id);
    const manifest = JSON.parse(
      await readFile(path.join('templates', template.id, 'package.json'), 'utf8'),
    );
    const adapters = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })
      .filter((name) => name.startsWith('@edgeone/'));
    if (adapters.length === 0) continue;

    const sources = await Promise.all(
      files
        .filter((file) => /\.(?:ts|js|mjs|cjs|tsx)$/.test(file))
        .map((file) => readFile(path.join('templates', template.id, file), 'utf8')),
    );
    for (const adapter of adapters) {
      assert.ok(
        sources.some((source) => source.includes(adapter)),
        `templates/${template.id} installs ${adapter} but no source file imports it, `
        + 'so wiring it is left to the model — add a SOURCE_PATCHES entry and re-bake',
      );
    }
  }
});

// The other half of the same rule. SvelteKit reads exactly one config, and it
// prefers the Vite one: any option passed to sveltekit() makes a sibling
// svelte.config.js unreachable in full. A template shipping both would leave
// whichever one lost as a decoy for the next model to edit.
test('the sveltekit template keeps its config in one place', async () => {
  const files = await committedFiles('sveltekit');
  assert.ok(
    !files.some((file) => /^svelte\.config\.(?:js|ts|mjs)$/.test(file)),
    'templates/sveltekit commits a svelte.config.js that its vite.config.ts already overrides',
  );
  const config = await readFile('templates/sveltekit/vite.config.ts', 'utf8');
  assert.match(config, /sveltekit\(\{/, 'sveltekit() takes no options, so the adapter cannot be here');
  assert.doesNotMatch(config, /@sveltejs\/adapter-auto/);
});

// A demo that renders by calling out to the internet is a demo that throws in
// a sandbox with no route to it, on the one route the template ships to teach
// data fetching. Vike had the only one: both star-wars +data.ts files pulled
// from brillout.github.io on every server render, and a measured session read
// all 18 source files and then spent four of its seven edits replacing that
// with a local array before writing any of what was actually asked for.
//
// Source files only. A README example is read, not run.
test('no baked template renders by reaching off the machine', async () => {
  for (const template of await listProjectTemplates()) {
    for (const file of await committedFiles(template.id)) {
      if (!/\.(?:ts|tsx|js|jsx|mjs|cjs|vue|svelte|astro)$/.test(file)) continue;
      const source = await readFile(path.join('templates', template.id, file), 'utf8');
      const reached = source.match(/fetch\(\s*['"`]https?:\/\/[^'"`]*/);
      assert.ok(
        !reached,
        `templates/${template.id}/${file} renders by calling ${reached?.[0]}…`,
      );
    }
  }
});

test('a framework resolves to its template however the user spelled it', async () => {
  for (const spelling of ['nextjs', 'Next.js', 'NEXT', 'next js']) {
    assert.equal(
      (await resolveProjectTemplate(spelling))?.id,
      'nextjs',
      `"${spelling}" should reach the Next.js template`,
    );
  }
  assert.equal((await resolveProjectTemplate('vite'))?.id, 'vite-spa');
  assert.equal((await resolveProjectTemplate('React'))?.id, 'vite-spa');
  for (const spelling of ['TanStack Start', 'tanstack-start', 'tanstack']) {
    assert.equal((await resolveProjectTemplate(spelling))?.id, 'tanstack-start', spelling);
  }
  assert.equal((await resolveProjectTemplate('Vike'))?.id, 'vike');
  for (const spelling of ['Nuxt', 'nuxt.js', 'Nuxt 4']) {
    assert.equal((await resolveProjectTemplate(spelling))?.id, 'nuxt', spelling);
  }
  for (const spelling of ['Astro', 'astro.js']) {
    assert.equal((await resolveProjectTemplate(spelling))?.id, 'astro', spelling);
  }
  for (const spelling of ['SvelteKit', 'svelte-kit', 'Svelte']) {
    assert.equal((await resolveProjectTemplate(spelling))?.id, 'sveltekit', spelling);
  }
  for (const spelling of ['React Router', 'react-router', 'Remix']) {
    assert.equal((await resolveProjectTemplate(spelling))?.id, 'react-router', spelling);
  }
  for (const spelling of ['DeepAgents', 'deep-agents', 'deep agents']) {
    assert.equal((await resolveProjectTemplate(spelling))?.id, 'deepagents', spelling);
  }
  for (const spelling of ['LangGraph', 'lang-graph', 'langgraph']) {
    assert.equal((await resolveProjectTemplate(spelling))?.id, 'langgraph', spelling);
  }
});

// Scaffolders increasingly write agent and editor config, and under templates/
// it stops describing the generated project and becomes live configuration for
// this repository — the AGENTS.md create-next-app writes is the same rule block
// this repo carries at its root. `.agents` also sits in this repo's .gitignore,
// so a template holding one arrives at a fresh clone short of its manifest,
// which is what makes this a correctness rule and not a tidiness one.
test('no template carries agent or editor configuration into this repo', async () => {
  const live = ['.agents', '.claude', '.cursor', '.vscode', '.idea', 'AGENTS.md', 'CLAUDE.md'];

  for (const template of await listProjectTemplates()) {
    for (const file of await committedFiles(template.id)) {
      const offending = file.split(path.sep).find((segment) => live.includes(segment));
      assert.equal(
        offending,
        undefined,
        `templates/${template.id}/${file} ships ${offending}, which this repo would act on`,
      );
    }
  }
});

// Resolution is an accelerator, never an allowlist: everything it cannot place
// has to fall through to the scaffolder path rather than be refused or, worse,
// be handed the nearest template.
test('an unknown, unbaked, or absent framework resolves to nothing', async () => {
  for (const framework of [undefined, '', '   ', 'cobol', 'jquery']) {
    assert.equal(await resolveProjectTemplate(framework), undefined, String(framework));
  }
  // Vue is the trap this guards: the baked Vite tree is the React one, so a Vue
  // request must reach its own scaffolder instead of a React app.
  assert.equal(await resolveProjectTemplate('vue'), undefined);
});

// Every template in the manifest rather than one of them, so a framework baked
// later is covered by having been baked rather than by someone remembering to
// add it here.
test('applying a template writes its files and starts the install in one command', async () => {
  for (const template of await listProjectTemplates()) {
    const fixture = await templateFixture();
    try {
      const applied = await applyProjectTemplate(fixture.context, fixture.state, template);

      assert.equal(applied.id, template.id);
      assert.equal(applied.files, template.files, `${template.id} wrote the wrong file count`);
      assert.equal(
        fixture.exists('projects/demo/app/package.json'),
        true,
        `${template.id} arrived without a package.json`,
      );

      // One write and one command, whatever the file count: the scaffold is the
      // first tool of every turn and the install is what the turn is waiting on.
      assert.equal(fixture.calls.writes.length, 1, template.id);
      assert.equal(fixture.calls.commands.length, 1, template.id);
      assert.match(fixture.calls.commands[0], new RegExp(NPM_WARMUP_BASE.replace('/', '\\/')));
    } finally {
      await fixture.cleanup();
    }
  }
});

// The tree carries a favicon and a PNG, and a payload that stored everything as
// a UTF-8 string would deliver them re-encoded and silently corrupt.
test('binary files survive the trip into the workspace byte for byte', async () => {
  const binaries = [
    ['vite-spa', 'src/assets/hero.png'],
    ['nextjs', 'app/favicon.ico'],
  ] as const;

  for (const [id, relative] of binaries) {
    const fixture = await templateFixture();
    try {
      await applyProjectTemplate(
        fixture.context,
        fixture.state,
        (await resolveProjectTemplate(id))!,
      );

      const source = await readFile(path.join('templates', id, relative));
      assert.ok(source.length > 0, `${id}/${relative} is empty in the baked template`);
      assert.ok(
        source.equals(await fixture.readBytes(`projects/demo/app/${relative}`)),
        `${id}/${relative} did not arrive byte for byte`,
      );
    } finally {
      await fixture.cleanup();
    }
  }
});

// A .gitignore committed inside templates/ is a live ignore file for its own
// directory: the Next.js one lists next-env.d.ts, so the template was a file
// short of the manifest — but only on a fresh clone, where nothing untracked
// was lying around to hide it. The bake script stores it under another name and
// the runtime restores it, and this is the only thing holding those two ends
// together.
test('a template ships its .gitignore under a name git will not act on', async () => {
  for (const template of await listProjectTemplates()) {
    const committed = await committedFiles(template.id);
    assert.ok(
      !committed.some((entry) => path.basename(entry) === '.gitignore'),
      `templates/${template.id} commits a real .gitignore, which hides part of itself from git`,
    );
    assert.equal(
      committed.length,
      template.files,
      `templates/${template.id} has ${committed.length} committed files, manifest says ${template.files}`,
    );
  }

  const fixture = await templateFixture();
  try {
    await applyProjectTemplate(
      fixture.context,
      fixture.state,
      (await resolveProjectTemplate('nextjs'))!,
    );
    assert.equal(fixture.exists('projects/demo/app/.gitignore'), true, 'restored on the way in');
    assert.equal(fixture.exists('projects/demo/app/_gitignore'), false, 'and not under both names');
    // The file this whole rename exists for.
    assert.equal(fixture.exists('projects/demo/app/next-env.d.ts'), true);
  } finally {
    await fixture.cleanup();
  }
});

// The official trees never mention the host's prefix variable, so without this
// the model loads makers-frameworks just to rewrite one line of next.config —
// and often the rest of the file with it. Every baked config the function
// knows about has to come out already reading the env var, and a file that
// already does must be left alone so a second apply cannot stack the option.
test('a baked framework config is given the preview prefix before it is written', async () => {
  const env = `process.env.${PREVIEW_ASSET_PREFIX_ENV}`;
  const cases: Array<{ file: string; source: string; needle: string }> = [
    {
      file: 'next.config.ts',
      source: 'const nextConfig: NextConfig = {\n  /* config options here */\n};\n',
      needle: `assetPrefix: ${env},`,
    },
    {
      file: 'vite.config.ts',
      source: 'export default defineConfig({\n  plugins: [react()],\n})\n',
      needle: `base: ${env},`,
    },
    {
      file: 'astro.config.mjs',
      source: 'export default defineConfig({});\n',
      needle: `base: ${env},`,
    },
    {
      file: 'nuxt.config.ts',
      source: "export default defineNuxtConfig({\n  compatibilityDate: '2025-07-15',\n})\n",
      needle: `app: { baseURL: ${env} },`,
    },
    // SvelteKit types this one as `"" | \`/${string}\`` rather than as a string,
    // so the environment variable needs an assertion TypeScript can read — and
    // svelte-check reaches it, because SvelteKit's generated tsconfig puts
    // vite.config.ts in its own include list.
    {
      file: 'vite.config.ts',
      source: 'export default defineConfig({\n  plugins: [\n    sveltekit({\n      adapter: adapter(),\n    }),\n  ],\n});\n',
      needle: '...(' + env + ' ? { paths: { base: ' + env + ' as `/${string}` } } : {}),',
    },
    // The same option in a file where `as` would be a syntax error. Both are
    // still checked — the SvelteKit tsconfig turns on checkJs — so the
    // assertion has to follow the language, not the framework.
    {
      file: 'svelte.config.js',
      source: 'const config = {\n  kit: {\n    adapter: adapter(),\n  },\n};\n',
      needle: `...(${env} ? { paths: { base: ${env} } } : {}),`,
    },
    // Not an asset option at all, and the only config here that is not: React
    // Router's dev adapter restores the prefix Vite strips, so `base` alone
    // leaves every route unmatched. The basename is what the router reads.
    {
      file: 'react-router.config.ts',
      source: 'export default {\n  ssr: true,\n} satisfies Config;\n',
      needle: `basename: ${env} ?? "/",`,
    },
  ];

  for (const { file, source, needle } of cases) {
    const adapted = withPreviewAssetPrefix(file, source);
    assert.ok(adapted, `${file} was not adapted`);
    assert.match(adapted!, new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(
      withPreviewAssetPrefix(file, adapted!),
      undefined,
      `${file} must not be adapted twice`,
    );
  }

  assert.equal(withPreviewAssetPrefix('package.json', '{}\n'), undefined);
  assert.equal(
    withPreviewAssetPrefix('next.config.ts', `const nextConfig = { assetPrefix: ${env} };\n`),
    undefined,
  );

  for (const template of await listProjectTemplates()) {
    const files = await readdir(path.join('templates', template.id), {
      recursive: true,
      withFileTypes: true,
    });
    const configs = files
      .filter((entry) => (
        entry.isFile()
        && /^(?:next|vite|astro|nuxt|svelte|react-router)\.config\.(?:ts|js|mjs)$/.test(entry.name)
      ))
      .map((entry) => ({
        relative: path.relative(
          path.join('templates', template.id),
          path.join(entry.parentPath, entry.name),
        ).replaceAll(path.sep, '/'),
        absolute: path.join(entry.parentPath, entry.name),
      }));

    for (const config of configs) {
      const source = await readFile(config.absolute, 'utf8');
      const adapted = withPreviewAssetPrefix(config.relative, source);
      assert.ok(
        adapted,
        `templates/${template.id}/${config.relative} was not given a prefix option`,
      );
      assert.match(adapted!, new RegExp(PREVIEW_ASSET_PREFIX_ENV));
    }
  }

  const fixture = await templateFixture();
  try {
    await applyProjectTemplate(
      fixture.context,
      fixture.state,
      (await resolveProjectTemplate('nextjs'))!,
    );
    const written = (await fixture.readBytes('projects/demo/app/next.config.ts')).toString('utf8');
    assert.match(written, new RegExp(`assetPrefix: process\\.env\\.${PREVIEW_ASSET_PREFIX_ENV}`));
    // The rest of the scaffolder file is still there; this is an insertion.
    assert.match(written, /\/\* config options here \*\//);
  } finally {
    await fixture.cleanup();
  }
});

test('the extractor leaves nothing of itself behind in /tmp', async () => {
  const fixture = await templateFixture();
  try {
    await applyProjectTemplate(
      fixture.context,
      fixture.state,
      (await resolveProjectTemplate('nextjs'))!,
    );
    const script = fixture.calls.writes[0];
    assert.match(script, /^\/tmp\/eo-template-.*\.cjs$/);
    assert.match(fixture.calls.commands[0], new RegExp(`rm -f ${script}`));
  } finally {
    await fixture.cleanup();
  }
});

// Both branches used to set installHint in one object literal, so whichever was
// spread last silently won — and the one that lost was the only one the model
// sees on the path this change created.
test('the workspace report answers "should I install" exactly once', () => {
  const state = projectState('projects/demo');
  const fromTemplate = describeScaffold(state, {
    created: true,
    dependenciesInstalled: false,
    template: { id: 'nextjs', files: 20, adapted: false },
  });
  assert.equal(fromTemplate.templateApplied, 'nextjs');
  assert.match(String(fromTemplate.installHint), /already running/);
  assert.match(String(fromTemplate.scaffolderHint), /Do not run a scaffold command/);
  assert.match(String(fromTemplate.scaffolderHint), /already in the framework config/);

  // A populated tree outranks it: that is the case where an install does not
  // fit on the disk beside what is already there.
  const alreadyInstalled = describeScaffold(state, {
    created: true,
    dependenciesInstalled: true,
    template: { id: 'nextjs', files: 20, adapted: false },
  });
  assert.match(String(alreadyInstalled.installHint), /Do not run npm install/);

  const plain = describeScaffold(state, { created: true, dependenciesInstalled: false });
  assert.equal(plain.installHint, undefined);
  assert.equal(plain.templateApplied, undefined);
});

test('an adapted manifest is reported so the model wires it instead of installing it', () => {
  const report = describeScaffold(projectState('projects/demo'), {
    created: true,
    dependenciesInstalled: false,
    template: { id: 'astro', files: 12, adapted: true },
  });
  assert.match(String(report.adapterHint), /already on its way/);
  assert.match(String(report.adapterHint), /makers-frameworks/);
});

// The prompt that exposed this asked for an AI chat assistant, which names an
// app and no framework. Nothing matched, so the baked chat agent went unused
// for the one request it was baked for.
test('a request that names an app rather than a framework still reaches a baked tree', async () => {
  for (const named of ['chat', 'chatbot', 'agent', 'ai-agent', 'AI chat assistant']) {
    assert.equal((await resolveProjectTemplate(named))?.id, 'deepagents', named);
  }
  assert.equal((await resolveProjectTemplate('langgraph'))?.id, 'langgraph');

  // The agent frameworks nobody baked have to keep missing: their own
  // reference is a better start than a tree built around another runtime.
  for (const unbaked of ['crewai', 'openai-agents-sdk', 'claude-agent-sdk']) {
    assert.equal(await resolveProjectTemplate(unbaked), undefined, unbaked);
  }
});

test('a workspace left empty names the trees it could have been filled from', () => {
  const state = projectState('projects/demo');
  const missed = describeScaffold(state, {
    created: true,
    dependenciesInstalled: false,
    available: ['deepagents', 'nextjs'],
  });

  // Only this result reaches the model, so the recovery has to be in it. A
  // silent miss reads as "no template exists for this" rather than "you did
  // not ask for one", and the first reading is the one that hand-writes a
  // project beside a baked one.
  assert.deepEqual(missed.templatesAvailable, ['deepagents', 'nextjs']);
  assert.match(String(missed.templatesHint), /deepagents, nextjs/);
  assert.match(String(missed.templatesHint), /call ensure_project_scaffold again/);
  assert.equal(missed.templateApplied, undefined);

  // A tree that did land is still reported on its own terms, without the
  // retry advice that only applies to an empty workspace.
  const applied = describeScaffold(state, {
    created: true,
    dependenciesInstalled: false,
    template: { id: 'deepagents', files: 5, adapted: false },
  });
  assert.equal(applied.templateApplied, 'deepagents');
  assert.equal(applied.templatesAvailable, undefined);
  assert.equal(applied.templatesHint, undefined);
});
