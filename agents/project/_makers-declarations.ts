/**
 * The platform declarations an `agents/` project cannot run without, written
 * when that directory first appears rather than reported at the preview gate.
 *
 * Neither file is a decision the model makes: the gateway keys are fixed names
 * the platform injects, and the framework is a fact about the dependencies the
 * project already declares. Discovering them at the gate costs the user a
 * failed preview for something nothing had to decide.
 */

import type { ProjectState } from '../_types.ts';
import {
  loadMakersFrameworkProfiles,
  SUPPORTED_MAKERS_AGENT_FRAMEWORKS,
  type MakersFrameworkProfile,
} from './_makers-compat.ts';
import { runSandboxCommand } from './_commands.ts';
import { readFileFromSandbox } from './_fs.ts';

export type MakersAgentFramework = (typeof SUPPORTED_MAKERS_AGENT_FRAMEWORKS)[number];

/** The keys the makers-agents routes require `.env.example` to declare. */
export const AGENT_ENV_KEYS = ['AI_GATEWAY_API_KEY', 'AI_GATEWAY_BASE_URL'] as const;

/**
 * Which framework a declared dependency proves.
 *
 * Taken from the vendored makers-agents routes rather than derived from the
 * framework names: the Node route installs `@openai/agents` while the Python
 * one installs `openai-agents`, and neither spelling follows from the value
 * `edgeone.json` expects.
 */
const FRAMEWORK_PACKAGES: Readonly<Record<string, MakersAgentFramework>> = {
  '@anthropic-ai/claude-agent-sdk': 'claude-agent-sdk',
  'claude-agent-sdk': 'claude-agent-sdk',
  '@openai/agents': 'openai-agents-sdk',
  'openai-agents': 'openai-agents-sdk',
  '@langchain/langgraph': 'langgraph',
  langgraph: 'langgraph',
  deepagents: 'deepagents',
  crewai: 'crewai',
};

/**
 * A file as read from the project. Absent is a file to create; unreadable is a
 * file to leave alone, because writing over content that exists but did not
 * come back would destroy it.
 */
export type ProjectFileRead =
  | { status: 'present'; content: string }
  | { status: 'absent' }
  | { status: 'unreadable' };

function declaredNodePackages(file: ProjectFileRead) {
  if (file.status !== 'present') return [];
  try {
    const parsed = JSON.parse(file.content) as {
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
    };
    return [
      ...Object.keys(parsed?.dependencies || {}),
      ...Object.keys(parsed?.devDependencies || {}),
    ];
  } catch {
    return [];
  }
}

/** Names only, out of lines like `crewai>=1.14.5` or `langchain-core >= 0.3.0`. */
function declaredPythonPackages(file: ProjectFileRead) {
  if (file.status !== 'present') return [];
  return file.content
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, '').trim())
    // `-r base.txt` and `--index-url ...` are options, not requirements.
    .filter((line) => line && !line.startsWith('-'))
    .map((line) => line.split(/[<>=!~[;\s]/)[0].trim().toLowerCase().replaceAll('_', '-'))
    .filter(Boolean);
}

function escapeForRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whether the agent code actually pulls in `packageName`.
 *
 * A dependency is not evidence that the code uses it. One generated project
 * declared `deepagents`, imported nothing from it, and drove its model through
 * `@langchain/openai` instead; `edgeone.json` was then written to name a
 * framework that appeared nowhere in the code. The platform reads that value to
 * shape `context.tools`, so it has to follow the imports rather than the
 * manifest.
 */
function importsPackage(agentSources: string[], packageName: string) {
  const specifier = `${escapeForRegExp(packageName)}(?:/[^'"\`\\s]+)?`;
  // Python spells the same distribution with dashes and imports it with
  // underscores, and `crewai.flow` is still the crewai package.
  const moduleName = escapeForRegExp(packageName.replaceAll('-', '_'));
  const patterns = [
    new RegExp(`(?:from|import|require\\(|import\\()\\s*['"\`]${specifier}['"\`]`),
    new RegExp(`^\\s*(?:import|from)\\s+${moduleName}(?:[.\\s]|$)`, 'm'),
  ];
  return agentSources.some((source) => patterns.some((pattern) => pattern.test(source)));
}

/**
 * The framework the agent code proves it uses, or nothing when the evidence
 * points at more than one — or at none.
 *
 * Ambiguity has to come back empty rather than pick a side. The platform reads
 * this value to shape `context.tools`, so a wrong one does not fail the lint —
 * it hands the generated agent a tool set of the wrong shape, which is why the
 * makers-agents skill lists the default as a mistake of its own. The CrewAI
 * route documents exactly that overlap: a crew nested under LangGraph declares
 * both packages, and either answer is defensible, so only the model can say.
 *
 * Withholding a value is the safe direction: the lint then asks the model for
 * one by name, which is a question it can answer, rather than the runtime
 * silently building the wrong tool set around a guess.
 */
export function inferMakersAgentFramework(sources: {
  packageJson: ProjectFileRead;
  requirements: ProjectFileRead;
  agentSources: string[];
}): MakersAgentFramework | undefined {
  const declared = [
    ...declaredNodePackages(sources.packageJson),
    ...declaredPythonPackages(sources.requirements),
  ];
  const frameworks = new Set(
    declared
      .filter((name) => importsPackage(sources.agentSources, name))
      .map((name) => FRAMEWORK_PACKAGES[name])
      .filter(Boolean),
  );
  return frameworks.size === 1 ? [...frameworks][0] : undefined;
}

/**
 * `edgeone.json` with `agents.framework` filled in, or nothing when there is
 * nothing to add or no safe way to add it.
 */
export function withAgentFramework(
  file: ProjectFileRead,
  framework: MakersAgentFramework,
): string | undefined {
  if (file.status === 'unreadable') return undefined;
  if (file.status === 'absent') {
    return `${JSON.stringify({ agents: { framework } }, null, 2)}\n`;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(file.content);
  } catch {
    // The lint reports this as invalid JSON, and it names the file and the
    // reason far better than a rewrite that discarded the contents would.
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;

  const config = parsed as Record<string, unknown>;
  const existing = config.agents;
  if (existing != null && (typeof existing !== 'object' || Array.isArray(existing))) {
    return undefined;
  }
  const agents = (existing as Record<string, unknown> | undefined) ?? {};
  if (typeof agents.framework === 'string' && agents.framework.trim()) return undefined;

  return `${JSON.stringify({ ...config, agents: { ...agents, framework } }, null, 2)}\n`;
}

/**
 * `.env.example` with the gateway keys declared, or nothing when it already
 * declares them.
 *
 * Missing keys are appended rather than replacing the file: a project may
 * declare its own keys alongside these, and the lint only asks that these two
 * are present. The test for a key is the lint's own, so this cannot write a
 * file the lint still rejects.
 */
export function withAgentEnvKeys(file: ProjectFileRead): string | undefined {
  if (file.status === 'unreadable') return undefined;
  const source = file.status === 'present' ? file.content : '';
  const missing = AGENT_ENV_KEYS.filter(
    (key) => !new RegExp(`^${key}\\s*=`, 'm').test(source),
  );
  if (missing.length === 0) return undefined;

  const declarations = missing.map((key) => `${key}=`).join('\n');
  if (!source.trim()) return `${declarations}\n`;
  return `${source.replace(/\n*$/, '')}\n${declarations}\n`;
}

/**
 * `package.json` with the framework's platform adapter declared, or nothing
 * when there is nothing to add.
 *
 * Only frameworks whose adapter is required unconditionally are handled here.
 * The conditional ones depend on whether the app renders on a server, which is
 * declared in a config file that usually does not exist yet when `package.json`
 * lands — so guessing would install a package a static project never needs. The
 * lint asks for those later, when the evidence is on disk.
 *
 * Adding the dependency, not the configuration: which import to call and where
 * to register it differs per framework, and that is what the skill is for. The
 * point of doing this half at the host is that it is the expensive half — the
 * adapter reaches the sandbox in the install that is about to run anyway,
 * instead of in a second one after the lint reports it.
 */
export function withFrameworkAdapter(
  file: ProjectFileRead,
  profiles: readonly MakersFrameworkProfile[],
): string | undefined {
  if (file.status !== 'present') return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(file.content);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;

  const manifest = parsed as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const declared = {
    ...manifest.dependencies,
    ...manifest.devDependencies,
  };

  const profile = profiles.find((candidate) => (
    candidate.adapter?.required === 'always'
    && candidate.detect.some((name) => declared[name])
  ));
  if (!profile?.adapter) return undefined;
  if (declared[profile.adapter.package]) return undefined;

  return `${JSON.stringify(
    {
      ...manifest,
      dependencies: {
        ...manifest.dependencies,
        // The range the profile states, because `latest` re-resolves against
        // the registry on every install and dates any lockfile sitting beside
        // it — including the one a baked template ships with.
        [profile.adapter.package]: profile.adapter.version || 'latest',
      },
    },
    null,
    2,
  )}\n`;
}

/**
 * Declare the adapter before the install runs, and report it so the model knows
 * the dependency is already there and only the config wiring is left.
 */
export async function ensureMakersFrameworkAdapter(
  context: any,
  state: ProjectState,
  packageJsonContent: string,
): Promise<{ path: string; content: string } | undefined> {
  const profiles = await loadMakersFrameworkProfiles();
  const content = withFrameworkAdapter(
    { status: 'present', content: packageJsonContent },
    profiles,
  );
  if (!content) return undefined;
  await context.sandbox.files.write(`${state.appDir}/package.json`, content);
  return { path: 'package.json', content };
}

async function readProjectFile(
  context: any,
  state: ProjectState,
  relPath: string,
): Promise<ProjectFileRead> {
  // Read through the one project-file reader this codebase has: sandbox
  // runtimes disagree on whether a read comes back as a string, a byte array,
  // or a wrapper object, and absorbing that twice is how the two drift.
  const result = await readFileFromSandbox(context, state, relPath);
  if (result.ok && typeof result.content === 'string') {
    return { status: 'present', content: result.content };
  }
  // Only a file proven to be missing is a file to create. Everything else —
  // a read that failed, a body that did not arrive — is content that may be
  // there, and writing over it would be the one unrecoverable move here.
  return result.error === 'File does not exist.'
    ? { status: 'absent' }
    : { status: 'unreadable' };
}

/**
 * Every line under `agents/` that could name an imported package.
 *
 * Grepping for the import forms rather than reading each file keeps this to one
 * command whatever the project's shape, and the matcher above cares only about
 * the lines that mention a specifier. A failure comes back empty, which
 * withholds the framework rather than guessing one.
 */
async function readAgentImportLines(
  context: any,
  state: ProjectState,
): Promise<string[]> {
  try {
    const result = await runSandboxCommand(
      context,
      'grep -rhE "^[[:space:]]*(import|from|const|let|var)|require\\(" agents 2>/dev/null | head -200 || true',
      { cwd: state.appDir, timeout: 10 },
    );
    const lines = (result.stdout || '').split('\n').filter(Boolean);
    return lines.length > 0 ? [lines.join('\n')] : [];
  } catch {
    return [];
  }
}

/**
 * Serializes the read-compute-write below, which is not safe to interleave.
 *
 * The model may write several `agents/` files in one message, and each write
 * runs this. Two overlapping runs both read a `.env.example` that is missing a
 * key, both append it, and the second write lands on content the first had
 * already changed. Chaining is enough — the work is short, and a queued run
 * reads what the one before it wrote, which is exactly the ordering it assumes.
 */
let declarationQueue: Promise<unknown> = Promise.resolve();

/**
 * Bring the project's platform declarations in line, and report what that took
 * so the caller can show the files it wrote.
 *
 * Run on every write under `agents/` rather than once: the first agent file can
 * land before the dependencies that name the framework, and a project already
 * in line costs four reads and no writes.
 */
export function ensureMakersAgentDeclarations(
  context: any,
  state: ProjectState,
): Promise<Array<{ path: string; content: string }>> {
  const run = declarationQueue.then(
    () => declareMakersAgentFiles(context, state),
    () => declareMakersAgentFiles(context, state),
  );
  // The queue must survive a failed run, or one rejection strands every write
  // behind it for the rest of the session.
  declarationQueue = run.catch(() => undefined);
  return run;
}

async function declareMakersAgentFiles(
  context: any,
  state: ProjectState,
): Promise<Array<{ path: string; content: string }>> {
  const [edgeoneConfig, envExample, packageJson, requirements, agentSources] = await Promise.all([
    readProjectFile(context, state, 'edgeone.json'),
    readProjectFile(context, state, '.env.example'),
    readProjectFile(context, state, 'package.json'),
    readProjectFile(context, state, 'requirements.txt'),
    readAgentImportLines(context, state),
  ]);

  const written: Array<{ path: string; content: string }> = [];
  const framework = inferMakersAgentFramework({ packageJson, requirements, agentSources });
  if (framework) {
    const content = withAgentFramework(edgeoneConfig, framework);
    if (content) written.push({ path: 'edgeone.json', content });
  }
  const envContent = withAgentEnvKeys(envExample);
  if (envContent) written.push({ path: '.env.example', content: envContent });

  for (const file of written) {
    await context.sandbox.files.write(`${state.appDir}/${file.path}`, file.content);
  }
  return written;
}
