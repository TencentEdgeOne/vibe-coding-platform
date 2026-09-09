import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import {
  buildMakersCompatibilityScript,
  loadMakersValidationRules,
} from '../agents/project/_makers-compat.ts';
import {
  ensureMakersAgentDeclarations,
  inferMakersAgentFramework,
  withAgentEnvKeys,
  withAgentFramework,
  withFrameworkAdapter,
  type ProjectFileRead,
} from '../agents/project/_makers-declarations.ts';
import { loadMakersFrameworkProfiles } from '../agents/project/_makers-compat.ts';
import { buildWriteProjectFileTool } from '../agents/tools/_project-tools.ts';
import { projectState } from './helpers/fixtures.ts';

const execFileAsync = promisify(execFile);

const present = (content: string): ProjectFileRead => ({ status: 'present', content });
const absent: ProjectFileRead = { status: 'absent' };
const unreadable: ProjectFileRead = { status: 'unreadable' };

const packageWith = (...names: string[]) => present(JSON.stringify({
  dependencies: Object.fromEntries(names.map((name) => [name, 'latest'])),
}));

/** A project directory, reached through the sandbox file API the agent uses. */
async function projectFixture(files: Record<string, string> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'makers-decl-'));
  const state = projectState(root);
  await mkdir(state.appDir, { recursive: true });
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(state.appDir, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  const context = {
    sandbox: {
      files: {
        read: (target: string) => readFile(target, 'utf8'),
        write: async (target: string, content: string) => {
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(target, content);
        },
        makeDir: (target: string) => mkdir(target, { recursive: true }),
      },
      // A real shell against the fixture directory: the framework is inferred
      // from a grep over the agent sources, and stubbing that out would leave
      // the one step that reads the code untested.
      commands: {
        run: async (command: string, options: { cwd?: string } = {}) => {
          try {
            const { stdout, stderr } = await execFileAsync('sh', ['-c', command], {
              cwd: options.cwd || state.appDir,
            });
            return { exitCode: 0, stdout, stderr };
          } catch (error) {
            const failure = error as { code?: number; stdout?: string; stderr?: string };
            return {
              exitCode: typeof failure.code === 'number' ? failure.code : 1,
              stdout: failure.stdout || '',
              stderr: failure.stderr || '',
            };
          }
        },
      },
    },
  };
  return {
    context,
    state,
    read: (relative: string) => readFile(path.join(state.appDir, relative), 'utf8'),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

// The route docs are the only place the package names live, and the value
// edgeone.json wants does not follow from them: the Node route installs
// @openai/agents where the Python one installs openai-agents.
test('each documented route is recognised from the dependencies it installs', () => {
  const cases: Array<[ProjectFileRead, ProjectFileRead, string[], string]> = [
    [
      packageWith('@anthropic-ai/claude-agent-sdk', 'zod'),
      absent,
      ["import { query } from '@anthropic-ai/claude-agent-sdk';"],
      'claude-agent-sdk',
    ],
    [
      packageWith('@openai/agents', 'openai', 'zod'),
      absent,
      ["import { Agent, run } from '@openai/agents';"],
      'openai-agents-sdk',
    ],
    [
      packageWith('@langchain/langgraph', '@langchain/core'),
      absent,
      // A submodule specifier is still the package.
      ["import { createReactAgent } from '@langchain/langgraph/prebuilt';"],
      'langgraph',
    ],
    [
      packageWith('deepagents', '@langchain/core'),
      absent,
      ["const { createDeepAgent } = await import('deepagents');"],
      'deepagents',
    ],
    [
      absent,
      present('claude-agent-sdk>=0.1.0\n'),
      ['from claude_agent_sdk import query'],
      'claude-agent-sdk',
    ],
    [
      absent,
      present('openai-agents>=0.1.0\nopenai>=1.50.0\n'),
      ['from agents import Agent\nimport openai_agents'],
      'openai-agents-sdk',
    ],
    [
      absent,
      present('# core\nlanggraph>=1.0.0\npydantic>=2.0.0\n'),
      ['from langgraph.graph import StateGraph'],
      'langgraph',
    ],
    [
      absent,
      present('crewai>=1.14.5\n'),
      ['import crewai'],
      'crewai',
    ],
  ];
  for (const [packageJson, requirements, agentSources, expected] of cases) {
    assert.equal(
      inferMakersAgentFramework({ packageJson, requirements, agentSources }),
      expected,
    );
  }
});

// A wrong framework does not fail the lint — the platform reads it to shape
// context.tools, so it silently hands the generated agent the wrong tool set.
// Anything short of proof therefore has to come back empty.
test('a framework the dependencies do not settle is left to the model', () => {
  // The CrewAI route documents this overlap: a crew nested under LangGraph
  // declares both, and either value is defensible.
  assert.equal(
    inferMakersAgentFramework({
      packageJson: absent,
      requirements: present('crewai>=1.14.5\nlanggraph>=1.0.0\n'),
      agentSources: ['import crewai\nfrom langgraph.graph import StateGraph'],
    }),
    undefined,
  );
  assert.equal(
    inferMakersAgentFramework({ packageJson: absent, requirements: absent, agentSources: [] }),
    undefined,
  );
  assert.equal(
    inferMakersAgentFramework({
      packageJson: packageWith('react', 'next'),
      requirements: absent,
      agentSources: ["import React from 'react';"],
    }),
    undefined,
  );
  assert.equal(
    inferMakersAgentFramework({
      packageJson: present('{ not json'),
      requirements: absent,
      agentSources: [],
    }),
    undefined,
  );
});

// A generated project declared deepagents, imported nothing from it, and drove
// its model through @langchain/openai. edgeone.json was written to say
// deepagents anyway, which is the value the platform reads to shape
// context.tools — so the manifest alone cannot decide this.
test('a dependency the code never imports proves nothing', () => {
  assert.equal(
    inferMakersAgentFramework({
      packageJson: packageWith('deepagents', '@langchain/openai', '@langchain/core'),
      requirements: absent,
      agentSources: [[
        "import { ChatOpenAI } from '@langchain/openai';",
        "import { createSSEResponse } from '../_shared';",
      ].join('\n')],
    }),
    undefined,
  );
  // The same manifest with the import present is the project that really does
  // run on deepagents, and it still resolves.
  assert.equal(
    inferMakersAgentFramework({
      packageJson: packageWith('deepagents', '@langchain/openai', '@langchain/core'),
      requirements: absent,
      agentSources: ["import { createDeepAgent } from 'deepagents';"],
    }),
    'deepagents',
  );
  // A name mentioned in prose is not an import.
  assert.equal(
    inferMakersAgentFramework({
      packageJson: packageWith('deepagents'),
      requirements: absent,
      agentSources: ['// deepagents was considered and dropped'],
    }),
    undefined,
  );
});

test('edgeone.json gains a framework without losing what it already declared', () => {
  assert.equal(
    withAgentFramework(absent, 'claude-agent-sdk'),
    `${JSON.stringify({ agents: { framework: 'claude-agent-sdk' } }, null, 2)}\n`,
  );

  const merged = withAgentFramework(
    present(JSON.stringify({ agents: { memory: true }, build: { command: 'npm run build' } })),
    'langgraph',
  );
  assert.deepEqual(JSON.parse(merged || ''), {
    agents: { memory: true, framework: 'langgraph' },
    build: { command: 'npm run build' },
  });

  // Nothing to add, or no safe way to add it: a declared framework is the
  // model's, invalid JSON is a lint error that names itself better than a
  // rewrite would, and a file that exists but did not read back must not be
  // replaced with content that would drop it.
  for (const file of [
    present(JSON.stringify({ agents: { framework: 'crewai' } })),
    present('{ not json'),
    present(JSON.stringify({ agents: ['claude-agent-sdk'] })),
    unreadable,
  ]) {
    assert.equal(withAgentFramework(file, 'deepagents'), undefined);
  }
});

test('.env.example gains only the keys it is missing', () => {
  assert.equal(withAgentEnvKeys(absent), 'AI_GATEWAY_API_KEY=\nAI_GATEWAY_BASE_URL=\n');
  assert.equal(
    withAgentEnvKeys(present('APP_TITLE=Demo\nAI_GATEWAY_API_KEY=\n')),
    'APP_TITLE=Demo\nAI_GATEWAY_API_KEY=\nAI_GATEWAY_BASE_URL=\n',
  );
  assert.equal(
    withAgentEnvKeys(present('AI_GATEWAY_BASE_URL=\nAI_GATEWAY_API_KEY=\n')),
    undefined,
  );
  assert.equal(withAgentEnvKeys(unreadable), undefined);
});

// The two sides are edited in different files, so the only assertion that keeps
// them honest is running the real lint over what the repair wrote.
test('what the declarations write is what the lint asks for', async () => {
  const fixture = await projectFixture({
    'package.json': JSON.stringify({
      dependencies: { '@anthropic-ai/claude-agent-sdk': 'latest' },
    }),
    'agents/chat.ts': [
      "import { query } from '@anthropic-ai/claude-agent-sdk';",
      'export async function onRequest() { return new Response("ok"); }',
    ].join('\n'),
  });
  try {
    const written = await ensureMakersAgentDeclarations(fixture.context, fixture.state);
    assert.deepEqual(written.map((file) => file.path).sort(), ['.env.example', 'edgeone.json']);

    const rules = await loadMakersValidationRules();
    const scriptPath = path.join(fixture.state.appDir, '.makers-compat-check.cjs');
    await writeFile(scriptPath, buildMakersCompatibilityScript(rules));
    const lint = await execFileAsync(process.execPath, [scriptPath], {
      cwd: fixture.state.appDir,
    });
    assert.match(lint.stdout, /Makers compatibility lint passed/);
  } finally {
    await fixture.cleanup();
  }
});

// Writing the first agent file is the moment the requirement starts to apply,
// and the run that prompted this discovered it a preview later.
test('writing an agent file brings the declarations with it', async () => {
  const fixture = await projectFixture({
    'package.json': JSON.stringify({ dependencies: { '@openai/agents': 'latest' } }),
  });
  const streamed: string[] = [];
  try {
    const tool = buildWriteProjectFileTool(
      fixture.context,
      fixture.state,
      ({ written }) => { streamed.push(written); },
    );

    const result = await tool.handler({
      path: 'agents/chat.ts',
      content: [
        "import { Agent, run } from '@openai/agents';",
        'export async function onRequest() { return new Response("ok"); }',
      ].join('\n'),
    }, {});

    assert.equal(result.isError, undefined);
    assert.deepEqual(streamed, ['agents/chat.ts', 'edgeone.json', '.env.example']);
    assert.deepEqual(
      JSON.parse(await fixture.read('edgeone.json')),
      { agents: { framework: 'openai-agents-sdk' } },
    );
    assert.match(await fixture.read('.env.example'), /^AI_GATEWAY_API_KEY=$/m);

    // A second agent file has nothing left to declare, so it stays a plain
    // write and the Files panel is not told about the same two files again.
    streamed.length = 0;
    await tool.handler({
      path: 'agents/summarize.ts',
      content: 'export async function onRequest() { return new Response("ok"); }\n',
    }, {});
    assert.deepEqual(streamed, ['agents/summarize.ts']);
  } finally {
    await fixture.cleanup();
  }
});

test('a file outside agents/ is written without touching the declarations', async () => {
  const fixture = await projectFixture({
    'package.json': JSON.stringify({ dependencies: { deepagents: 'latest' } }),
  });
  try {
    const tool = buildWriteProjectFileTool(fixture.context, fixture.state);
    await tool.handler({ path: 'src/App.tsx', content: 'export default () => null;\n' }, {});
    await assert.rejects(() => fixture.read('edgeone.json'));
  } finally {
    await fixture.cleanup();
  }
});

const frameworkProfiles = await loadMakersFrameworkProfiles();

function adapterFor(manifest: unknown) {
  const content = withFrameworkAdapter(
    { status: 'present', content: JSON.stringify(manifest) },
    frameworkProfiles,
  );
  return content ? JSON.parse(content) as { dependencies?: Record<string, string> } : undefined;
}

// The adapter has to reach the sandbox in the install that is already about to
// run. Discovered at the lint instead, it costs a second install of the whole
// dependency tree for one package.
test('a framework that cannot build without an adapter gets it before the install', () => {
  const result = adapterFor({ dependencies: { '@sveltejs/kit': '^2.4.0' } });

  // A range from the profile rather than `latest`, which re-resolves against
  // the registry on every install and dates whatever lockfile sits beside it.
  assert.match(result?.dependencies?.['@edgeone/sveltekit'] ?? '', /^\^\d+\.\d+\.\d+$/);
  assert.equal(result?.dependencies?.['@sveltejs/kit'], '^2.4.0', 'the declared tree is preserved');
});

// Every adapter the profiles name is one this agent may have to declare, and a
// profile that forgot its range would quietly fall back to the floating tag.
test('every framework profile states the range to declare its adapter at', () => {
  for (const profile of frameworkProfiles) {
    if (!profile.adapter) continue;
    assert.match(
      profile.adapter.version ?? '',
      /^\^\d+\.\d+\.\d+$/,
      `${profile.id} adapter has no version range`,
    );
  }
});

test('an adapter already declared is left exactly as the model wrote it', () => {
  assert.equal(
    withFrameworkAdapter(
      {
        status: 'present',
        content: JSON.stringify({
          dependencies: { '@sveltejs/kit': '^2.4.0', '@edgeone/sveltekit': '^1.2.0' },
        }),
      },
      frameworkProfiles,
    ),
    undefined,
  );
});

test('a devDependency counts as declared', () => {
  assert.equal(
    withFrameworkAdapter(
      {
        status: 'present',
        content: JSON.stringify({
          dependencies: { '@sveltejs/kit': '^2.4.0' },
          devDependencies: { '@edgeone/sveltekit': '^1.2.0' },
        }),
      },
      frameworkProfiles,
    ),
    undefined,
  );
});

// The restraint that keeps this from installing packages projects do not need:
// whether an Astro site renders on a server is declared in astro.config.mjs,
// which usually does not exist yet when package.json lands.
test('a conditional adapter is left to the lint, which can see the rendering mode', () => {
  assert.equal(adapterFor({ dependencies: { astro: '^5.0.0' } }), undefined);
  assert.equal(adapterFor({ dependencies: { '@react-router/dev': '^7.0.0' } }), undefined);
});

test('a framework the builder supports directly gets no adapter', () => {
  assert.equal(adapterFor({ dependencies: { next: '^15.0.0' } }), undefined);
  assert.equal(adapterFor({ dependencies: { nuxt: '^3.0.0' } }), undefined);
});

test('a manifest that is absent or unparseable is never rewritten', () => {
  assert.equal(withFrameworkAdapter({ status: 'absent' }, frameworkProfiles), undefined);
  assert.equal(withFrameworkAdapter({ status: 'unreadable' }, frameworkProfiles), undefined);
  assert.equal(
    withFrameworkAdapter({ status: 'present', content: '{ not json' }, frameworkProfiles),
    undefined,
    'the lint reports invalid JSON far better than a rewrite that discarded it',
  );
});

// Four agent files can now arrive in one assistant message, so this runs four
// times at once over the same two files. Interleaved, the second write lands on
// content the first had already changed and a key goes missing.
test('concurrent agent writes converge on declarations the lint accepts', async () => {
  const fixture = await projectFixture({
    'package.json': JSON.stringify({
      dependencies: { '@anthropic-ai/claude-agent-sdk': 'latest' },
    }),
    '.env.example': 'APP_TITLE=Demo\n',
    'agents/chat.ts': [
      "import { query } from '@anthropic-ai/claude-agent-sdk';",
      'export async function onRequest() { return new Response("ok"); }',
    ].join('\n'),
  });
  try {
    await Promise.all([
      ensureMakersAgentDeclarations(fixture.context, fixture.state),
      ensureMakersAgentDeclarations(fixture.context, fixture.state),
      ensureMakersAgentDeclarations(fixture.context, fixture.state),
      ensureMakersAgentDeclarations(fixture.context, fixture.state),
    ]);

    const env = await fixture.read('.env.example');
    assert.match(env, /^AI_GATEWAY_API_KEY=$/m);
    assert.match(env, /^AI_GATEWAY_BASE_URL=$/m);
    // The project's own key survives, and neither platform key is duplicated by
    // a run that appended what another run had already appended.
    assert.match(env, /^APP_TITLE=Demo$/m);
    assert.equal(env.match(/AI_GATEWAY_API_KEY=/g)?.length, 1);
    assert.equal(env.match(/AI_GATEWAY_BASE_URL=/g)?.length, 1);

    const config = JSON.parse(await fixture.read('edgeone.json')) as {
      agents?: { framework?: string };
    };
    assert.equal(config.agents?.framework, 'claude-agent-sdk');
  } finally {
    await fixture.cleanup();
  }
});

// A failed run must not strand the writes queued behind it for the rest of the
// session, which is what a plain promise chain does.
test('a failed declaration run does not block the writes behind it', async () => {
  const fixture = await projectFixture({
    'package.json': JSON.stringify({
      dependencies: { '@anthropic-ai/claude-agent-sdk': 'latest' },
    }),
    'agents/chat.ts': [
      "import { query } from '@anthropic-ai/claude-agent-sdk';",
      'export async function onRequest() { return new Response("ok"); }',
    ].join('\n'),
  });
  try {
    // Reads still work, so this run decides it has files to write; the write is
    // what fails. A read that fails is absorbed by design and writes nothing.
    const broken = {
      sandbox: {
        ...fixture.context.sandbox,
        files: {
          ...fixture.context.sandbox.files,
          write: async () => { throw new Error('sandbox recycled'); },
        },
      },
    };
    await assert.rejects(ensureMakersAgentDeclarations(broken, fixture.state));

    const written = await ensureMakersAgentDeclarations(fixture.context, fixture.state);
    assert.deepEqual(written.map((file) => file.path).sort(), ['.env.example', 'edgeone.json']);
  } finally {
    await fixture.cleanup();
  }
});
