import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ProjectState } from '../_types.ts';
import { runCommandCapturingExit } from './_commands.ts';

export type MakersValidationRule = {
  skill: string;
  pathPatterns: string[];
  pattern: string;
  message: string;
};

/**
 * Where a framework's platform adapter goes and whether this project needs one.
 *
 * `serverOutput` is deliberately separate from `adapter`: the file that decides
 * whether the app renders on a server is often not the file the adapter is
 * wired into. React Router declares `ssr` in react-router.config.ts and takes
 * its adapter as a vite.config.ts plugin, so one field cannot serve both.
 */
export type MakersFrameworkProfile = {
  id: string;
  label: string;
  detect: string[];
  adapter: {
    package: string;
    /**
     * The range to declare when this agent adds the adapter itself. Optional
     * because it is the platform's to state, not this repo's: absent, the
     * declaration falls back to `latest`, which resolves but pins nothing.
     */
    version?: string;
    configFiles: string[];
    /**
     * A config file that, in a shape only it can be in, silences the others.
     *
     * SvelteKit is why this exists. It reads exactly one config and prefers the
     * Vite one, so a single option passed to `sveltekit()` discards the whole of
     * a sibling `svelte.config.js` — adapter included, with no warning from the
     * build. Checking the first config file that happens to exist calls that
     * project correct; checking `vite.config.ts` unconditionally calls a project
     * that legitimately keeps its config in `svelte.config.js` broken.
     */
    configOverride?: {
      files: string[];
      pattern: string;
      /** Appended to the error, because "wire it in here" is baffling on its own. */
      reason: string;
    };
    required: 'always' | 'server-output';
  } | null;
  serverOutput?: {
    files: string[];
    default: 'server' | 'static';
    serverPattern?: string;
    staticPattern?: string;
  };
  outputDirectory: string;
  unsupported: string[];
};

const FRAMEWORK_PROFILE_SKILL = 'makers-frameworks';

// The profiles live in a fenced block inside the vendored skill rather than in
// its frontmatter: they are nested objects, and the frontmatter reader here is a
// line-oriented approximation of YAML that cannot represent them.
const FRAMEWORK_PROFILE_BLOCK =
  /<!--\s*makers-framework-profiles:start\s*-->\s*```json\s*\r?\n([\s\S]*?)\r?\n```/;

export function parseMakersFrameworkProfiles(source: string): MakersFrameworkProfile[] {
  const block = source.match(FRAMEWORK_PROFILE_BLOCK)?.[1];
  if (!block) return [];
  const parsed = JSON.parse(block) as MakersFrameworkProfile[];
  if (!Array.isArray(parsed)) {
    throw new Error('makers-framework-profiles must be a JSON array');
  }
  for (const profile of parsed) {
    if (!profile.id || !Array.isArray(profile.detect) || profile.detect.length === 0) {
      throw new Error(`framework profile ${profile.id || '(unnamed)'} needs an id and a detect list`);
    }
    // Compile every pattern at load time so a malformed vendored profile fails
    // here, where the message names the profile, rather than inside the sandbox
    // script as a syntax error with no attribution.
    for (const pattern of [
      profile.serverOutput?.serverPattern,
      profile.serverOutput?.staticPattern,
      profile.adapter?.configOverride?.pattern,
    ]) {
      if (pattern) new RegExp(pattern);
    }
  }
  return parsed;
}

const VALIDATION_SKILLS = [
  'makers-agents',
  'makers-cloud-functions',
  'makers-deploy',
  'makers-edge-functions',
  'makers-env-adaption',
  'makers-frameworks',
  'makers-middleware',
  'makers-storage',
] as const;

export const SUPPORTED_MAKERS_AGENT_FRAMEWORKS = [
  'claude-agent-sdk',
  'openai-agents-sdk',
  'langgraph',
  'crewai',
  'deepagents',
] as const;

function parseFrontmatterScalar(value: string) {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    // A double-quoted YAML scalar is close enough to JSON to reuse the parser,
    // but not close enough to trust it: one stray backslash in a vendored skill
    // would otherwise take down every compatibility check with a SyntaxError.
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  return trimmed;
}

export function parseMakersSkillValidationRules(
  skill: string,
  source: string,
): MakersValidationRule[] {
  const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
  if (!frontmatter) return [];

  const pathPatterns: string[] = [];
  const rules: Array<{ pattern: string; message: string }> = [];
  let section: 'paths' | 'validate' | null = null;
  let pendingPattern = '';

  for (const line of frontmatter.split(/\r?\n/)) {
    if (line === 'pathPatterns:') {
      section = 'paths';
      continue;
    }
    if (line === 'validate:') {
      section = 'validate';
      continue;
    }
    if (/^\S/.test(line)) {
      section = null;
      continue;
    }
    if (section === 'paths') {
      const match = line.match(/^\s{2}-\s+(.+)$/);
      if (match?.[1]) pathPatterns.push(parseFrontmatterScalar(match[1]));
      continue;
    }
    if (section === 'validate') {
      const patternMatch = line.match(/^\s{2}-\s+pattern:\s+(.+)$/);
      if (patternMatch?.[1]) {
        pendingPattern = parseFrontmatterScalar(patternMatch[1]);
        continue;
      }
      const messageMatch = line.match(/^\s{4}message:\s+(.+)$/);
      if (messageMatch?.[1] && pendingPattern) {
        rules.push({
          pattern: pendingPattern,
          message: parseFrontmatterScalar(messageMatch[1]),
        });
        pendingPattern = '';
      }
    }
  }

  return rules.map((rule) => ({
    skill,
    pathPatterns: [...pathPatterns],
    ...rule,
  }));
}

function readVendoredSkill(skill: string) {
  return readFile(
    path.join(
      process.cwd(),
      '.claude',
      'skills',
      'edgeone-makers-tools',
      'references',
      skill,
      'SKILL.md',
    ),
    'utf8',
  );
}

let frameworkProfilesPromise: Promise<readonly MakersFrameworkProfile[]> | undefined;

export function loadMakersFrameworkProfiles(): Promise<readonly MakersFrameworkProfile[]> {
  if (!frameworkProfilesPromise) {
    const pending = readVendoredSkill(FRAMEWORK_PROFILE_SKILL).then((source) => {
      const profiles = parseMakersFrameworkProfiles(source);
      if (profiles.length === 0) {
        throw new Error(
          `${FRAMEWORK_PROFILE_SKILL} carries no framework profiles; the adapter check cannot run without them`,
        );
      }
      return profiles;
    });
    frameworkProfilesPromise = pending.catch((error) => {
      frameworkProfilesPromise = undefined;
      throw error;
    });
  }
  return frameworkProfilesPromise;
}

let validationRulesPromise: Promise<readonly MakersValidationRule[]> | undefined;

export function loadMakersValidationRules(): Promise<readonly MakersValidationRule[]> {
  if (!validationRulesPromise) {
    const pending = Promise.all(VALIDATION_SKILLS.map(async (skill) => {
      const source = await readVendoredSkill(skill);
      return parseMakersSkillValidationRules(skill, source);
    })).then((groups) => {
      const rules = groups.flat();
      for (const rule of rules) {
        // Fail at the source if an official vendored rule is malformed instead
        // of silently dropping a compatibility check.
        new RegExp(rule.pattern);
      }
      return rules;
    });
    // Cache the success, not the attempt. Holding a rejected promise here would
    // turn one unlucky read into a permanently broken compatibility check for
    // every later turn on this warm instance.
    validationRulesPromise = pending.catch((error) => {
      validationRulesPromise = undefined;
      throw error;
    });
  }
  return validationRulesPromise;
}

export function buildMakersCompatibilityScript(
  sourceRules: readonly MakersValidationRule[],
  frameworkProfiles: readonly MakersFrameworkProfile[] = [],
) {
  const rulesJson = JSON.stringify(sourceRules).replaceAll('<', '\\u003c');
  const frameworksJson = JSON.stringify(SUPPORTED_MAKERS_AGENT_FRAMEWORKS);
  const profilesJson = JSON.stringify(frameworkProfiles).replaceAll('<', '\\u003c');
  return `'use strict';\nconst sourceRules = ${rulesJson};\nconst supportedAgentFrameworks = ${frameworksJson};\nconst frameworkProfiles = ${profilesJson};\n${String.raw`
const fs = require('fs');
const path = require('path');
const errors = [];
const ignored = new Set(['node_modules', '.edgeone', '.git', 'dist', 'build', '.next', '.venv', 'venv']);
const files = [];
const sourceCache = new Map();

function addError(code, file, message) {
  errors.push('[' + code + '] ' + file + ': ' + message);
}

function walk(dir, relative = '') {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const rel = relative ? relative + '/' + entry.name : entry.name;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(abs, rel);
      continue;
    }
    if (entry.isFile()) files.push(rel);
  }
}

function readSource(file) {
  if (sourceCache.has(file)) return sourceCache.get(file);
  let source = '';
  try {
    if (fs.statSync(file).size <= 1024 * 1024) {
      source = fs.readFileSync(file, 'utf8');
      if (source.includes('\0')) source = '';
    }
  } catch {}
  sourceCache.set(file, source);
  return source;
}

function readLintSource(file) {
  return readSource(file)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*#.*$/gm, '');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function matchesPathPattern(file, pattern) {
  if (pattern.endsWith('/**')) {
    return file.startsWith(pattern.slice(0, -2));
  }
  if (pattern.startsWith('*.')) {
    return !file.includes('/') && file.endsWith(pattern.slice(1));
  }
  return file === pattern;
}

function isRuleCandidate(file, rule) {
  if (
    rule.pathPatterns.some((pattern) => (
      pattern === 'agents/**'
      || pattern === 'cloud-functions/**'
      || pattern === 'edge-functions/**'
      || pattern === 'functions/**'
    ))
  ) {
    return /\.(?:js|jsx|mjs|cjs|ts|tsx|py|go)$/.test(file);
  }
  return true;
}

function isAgentSource(file) {
  return /^agents\/.+\.(?:js|jsx|mjs|cjs|ts|tsx|py)$/.test(file);
}

function isAgentEntry(file) {
  const direct = file.match(/^agents\/([^/]+)\.(?:js|jsx|mjs|cjs|ts|tsx|py)$/);
  if (direct) return !direct[1].startsWith('_');
  const nested = file.match(/^agents\/([^/]+)\/index\.(?:js|jsx|mjs|cjs|ts|tsx|py)$/);
  return Boolean(nested && !nested[1].startsWith('_'));
}

function hasValidAgentEntry(source, file) {
  if (file.endsWith('.py')) {
    return /(?:^|\n)\s*async\s+def\s+handler\s*\(/m.test(source);
  }
  return /export\s+(?:default\s+)?(?:async\s+)?function\s+onRequest(?:Get|Post|Put|Patch|Delete|Head|Options)?\s*\(/.test(source)
    || /export\s+(?:const|let|var)\s+onRequest(?:Get|Post|Put|Patch|Delete|Head|Options)?\s*=/.test(source);
}

walk('.');

const packageJson = fs.existsSync('package.json') ? readJson('package.json') : {};
const dependencies = Object.assign(
  {},
  packageJson && packageJson.dependencies,
  packageJson && packageJson.devDependencies,
);
const frameworkPackages = ['next', 'nuxt', '@nuxt/core', 'astro', '@sveltejs/kit'];
const isFrameworkProject = frameworkPackages.some((name) => dependencies && dependencies[name]);

// A page something rewrites before serving is not the asset rule's business:
// there index.html is a build input, and base or assetPrefix moves its URLs.
// What is left is the hand-written page the CLI serves byte for byte, where the
// URL in the markup is the URL the browser asks for.
const bundlerPackages = ['vite', 'webpack', 'parcel', 'rollup', 'esbuild', '@rsbuild/core', '@angular/cli'];
const hasBuildPipeline = isFrameworkProject
  || bundlerPackages.some((name) => dependencies && dependencies[name])
  || frameworkProfiles.some((profile) => profile.detect.some((name) => dependencies && dependencies[name]));

let edgeoneConfig = null;
const hasEdgeoneConfig = fs.existsSync('edgeone.json');
if (hasEdgeoneConfig) {
  edgeoneConfig = readJson('edgeone.json');
  if (!edgeoneConfig) {
    addError('MKR001', 'edgeone.json', 'invalid JSON.');
  }
}

const agentFiles = files.filter(isAgentSource);
const agentEntries = agentFiles.filter(isAgentEntry);
if (agentFiles.length > 0) {
  if (!hasEdgeoneConfig) {
    addError('MKR002', 'edgeone.json', 'required for an agents/ project and must declare agents.framework.');
  } else if (edgeoneConfig) {
    const framework = edgeoneConfig.agents && edgeoneConfig.agents.framework;
    if (!framework) {
      addError('MKR003', 'edgeone.json', 'agents.framework is required.');
    } else if (!supportedAgentFrameworks.includes(framework)) {
      addError(
        'MKR004',
        'edgeone.json',
        'agents.framework must be one of: ' + supportedAgentFrameworks.join(', ') + '.',
      );
    }
  }

  if (!fs.existsSync('.env.example')) {
    addError(
      'MKR005',
      '.env.example',
      'required for an agents/ project and must declare AI_GATEWAY_API_KEY and AI_GATEWAY_BASE_URL.',
    );
  } else {
    const envExample = readSource('.env.example');
    for (const key of ['AI_GATEWAY_API_KEY', 'AI_GATEWAY_BASE_URL']) {
      if (!new RegExp('^' + key + '\\s*=', 'm').test(envExample)) {
        addError('MKR006', '.env.example', 'missing ' + key + '= declaration.');
      }
    }
  }

  if (agentEntries.length === 0) {
    addError('MKR007', 'agents/', 'no route entry found; add agents/<name>.ts or agents/<name>/index.ts.');
  }
  for (const file of agentEntries) {
    if (!hasValidAgentEntry(readSource(file), file)) {
      addError(
        'MKR008',
        file,
        'agent route must export onRequest/onRequestGet/onRequestPost (or async def handler for Python).',
      );
    }
  }
  for (const file of agentFiles) {
    if (/gpt-4o-mini/.test(readSource(file))) {
      addError(
        'MKR009',
        file,
        'gpt-4o-mini is not a valid Makers default; use the model documented by the makers-agents skill.',
      );
    }
  }

  // The deployed runtime resolves the packages it externalizes from what
  // package.json declares, while npm 7+ installs peer dependencies whether they
  // are declared or not. An undeclared peer is therefore present everywhere
  // this project is tested and absent in production, where the import fails
  // before onRequest and the whole endpoint answers nothing until the gateway
  // times out. Preview cannot catch it: the chat probe runs against a sandbox
  // that has the peer.
  //
  // Read off the installed tree rather than a table of known frameworks. The
  // table would be the bug: deepagents 1.13 moved langchain and langgraph from
  // dependencies to peers, and a project generated against a list written for
  // 1.9 declared four packages too few. An absent node_modules skips this
  // silently, which is correct — nothing has been resolved yet to check.
  const declaredPackages = Object.keys(dependencies || {}).sort();
  for (const name of declaredPackages) {
    const manifest = readJson('node_modules/' + name + '/package.json');
    const peers = manifest && manifest.peerDependencies;
    if (!peers) continue;
    const meta = manifest.peerDependenciesMeta || {};
    const missing = Object.keys(peers)
      .filter((peer) => (
        !Object.prototype.hasOwnProperty.call(dependencies, peer)
        && !(meta[peer] && meta[peer].optional)
      ))
      .sort();
    if (missing.length > 0) {
      addError(
        'MKR020',
        'package.json',
        'declares ' + name + ' without its required peer dependencies: ' + missing.join(', ')
        + '. Add them to dependencies — the deployed agent runtime resolves externalized'
        + ' packages from package.json, so an undeclared peer imports fine in preview and'
        + ' fails at module load in production.',
      );
    }
  }
}

for (const file of files) {
  if (
    (file.startsWith('cloud-functions/') || file.startsWith('edge-functions/'))
    && path.extname(path.basename(file)) === ''
    && !path.basename(file).startsWith('.')
  ) {
    addError(
      'MKR010',
      file,
      'function files require a language extension such as .js, .py, or .go.',
    );
  }
}

for (const middlewareFile of ['middleware.js', 'middleware.ts']) {
  if (!files.includes(middlewareFile) || isFrameworkProject) continue;
  const source = readLintSource(middlewareFile);
  const exportsMiddleware =
    /export\s+(?:async\s+)?function\s+middleware\s*\(/.test(source)
    || /export\s+(?:const|let|var)\s+middleware\s*=/.test(source);
  if (/export\s+(?:async\s+)?function\s+onRequest\w*\s*\(/.test(source)) {
    addError(
      'MKR012',
      middlewareFile,
      'platform middleware must export middleware(context), not onRequest.',
    );
  } else if (!exportsMiddleware) {
    addError(
      'MKR013',
      middlewareFile,
      'platform middleware must export a middleware(context) function.',
    );
  }
}

for (const file of files) {
  if (!/\.(?:html|js|jsx|ts|tsx|vue|svelte)$/.test(file)) continue;
  if (
    file.startsWith('agents/')
    || file.startsWith('cloud-functions/')
    || file.startsWith('edge-functions/')
  ) {
    continue;
  }
  const source = readLintSource(file);
  // MKR011 and MKR014 lived here and rejected the root-absolute fetch and the
  // root-absolute link. The preview proxy now restores the prefix in the
  // browser, so those are the correct, deploy-ready forms and the rules would
  // fail every project on its first preview. The IDs stay retired rather than
  // reused, so an old report never reads as a current one.
  //
  // The trailing slash is what keeps this off a project whose own route is
  // named preview: that is written href="/preview", while the mistake this
  // catches is a prefix with a path after it.
  if (/(['"\`])\/preview\//.test(source)) {
    addError(
      'MKR015',
      file,
      'the sandbox /preview/ prefix is hard-coded. The host adds it while previewing and the deployed site is served from /, so this path doubles the prefix once deployed. Write the path the deployed site needs.',
    );
  }
  if (/\bbasePath\s*:/.test(source)) {
    addError(
      'MKR016',
      file,
      'basePath makes the framework expect a prefix the preview proxy has already stripped, so every route 404s. Remove it; assetPrefix is the only prefix the framework needs.',
    );
  }

  // The one root-absolute path the host cannot rescue. Its shim reaches links,
  // form actions, fetch, and XHR, all of which are resolved by code it has
  // already wrapped by the time they run. A subresource URL is resolved by the
  // HTML parser instead, which fetches it during the same parse that is still
  // on its way to the shim, and a <script src> cannot even be redirected after
  // the fact — assigning src again does not re-fetch. So this reads as the
  // worst kind of green: the document answers 200, the build passes, and the
  // page arrives unstyled with no script having run.
  if (!hasBuildPipeline && /\.html$/.test(file)) {
    const markup = readSource(file).replace(/<!--[\s\S]*?-->/g, '');
    const subresource = /<(?:script|link|img|source)\b[^>]*?\s(?:src|href)\s*=\s*["'](\/(?!\/)[^"']*)["']/gi;
    const reported = new Set();
    let found;
    while ((found = subresource.exec(markup))) {
      const url = found[1];
      if (reported.has(url)) continue;
      reported.add(url);
      addError(
        'MKR019',
        file,
        'this page has no build step behind it, so "' + url + '" is fetched exactly as written and resolves against the '
          + 'sandbox host root, outside the prefix the preview is published under. The gateway serves nothing above that '
          + 'prefix, so the asset 404s while the document itself still loads. Write the URL relative to this page instead '
          + '("' + url.replace(/^\/+/, '') + '" for a sibling file, "../" per directory of depth): that resolves under the '
          + 'prefix while previewing and at / once deployed. Links and fetch in this file stay root-absolute — the host '
          + 'restores those in the browser.',
      );
    }
  }
}

// The adapter check, and the reason it is worth its weight: the dev command
// starts the framework's own dev server, which does not involve the platform
// adapter at all. A project that needs one and lacks it previews perfectly and
// deploys broken, with every other gate green. Nothing else here catches it.
for (const profile of frameworkProfiles) {
  if (!profile.adapter) continue;
  if (!profile.detect.some((name) => dependencies[name])) continue;

  if (profile.adapter.required === 'server-output') {
    const rendering = profile.serverOutput;
    let mode = rendering ? rendering.default : 'server';
    if (rendering) {
      for (const candidate of rendering.files) {
        if (!files.includes(candidate)) continue;
        const source = readLintSource(candidate);
        if (rendering.serverPattern && new RegExp(rendering.serverPattern).test(source)) {
          mode = 'server';
          break;
        }
        if (rendering.staticPattern && new RegExp(rendering.staticPattern).test(source)) {
          mode = 'static';
          break;
        }
      }
    }
    // A static build has no server bundle to emit, so the adapter is genuinely
    // optional and demanding it would fail a correct project.
    if (mode === 'static') continue;
  }

  const adapterPackage = profile.adapter.package;
  if (!dependencies[adapterPackage]) {
    addError(
      'MKR017',
      'package.json',
      profile.label + ' renders on the server here, which requires the ' + adapterPackage
        + ' platform adapter. It is missing, so the preview will look correct and the deployment will not: '
        + 'the dev server never loads the adapter, and the build has nothing to emit platform output with. '
        + 'Add ' + adapterPackage + ' to dependencies.',
    );
  }

  // One config file decides, and which one is not always the first that exists.
  // An override claims that role only in the shape that earns it, so a project
  // keeping its config in the ordinary place is still read from there.
  const override = profile.adapter.configOverride;
  let configFile;
  let overrode = false;
  if (override) {
    const overridePattern = new RegExp(override.pattern);
    configFile = override.files.find(
      (candidate) => files.includes(candidate) && overridePattern.test(readLintSource(candidate)),
    );
    overrode = Boolean(configFile);
  }
  if (!configFile) {
    configFile = profile.adapter.configFiles.find((candidate) => files.includes(candidate));
  }

  if (!configFile) {
    addError(
      'MKR018',
      profile.adapter.configFiles[0],
      profile.label + ' needs ' + adapterPackage + ' wired in here, but no config file exists.',
    );
  } else if (!readLintSource(configFile).includes(adapterPackage)) {
    addError(
      'MKR018',
      configFile,
      adapterPackage + ' is not referenced in this config, so the build emits output the platform cannot serve. '
        + 'Import it and register it the way the makers-frameworks skill documents for ' + profile.label + '.'
        + (overrode ? ' ' + override.reason : ''),
    );
  }
}

sourceRules.forEach((rule, index) => {
  const matcher = new RegExp(rule.pattern);
  for (const file of files) {
    if (!rule.pathPatterns.some((pattern) => matchesPathPattern(file, pattern))) continue;
    if (!isRuleCandidate(file, rule)) continue;
    if (
      isFrameworkProject
      && (file === 'middleware.js' || file === 'middleware.ts')
    ) {
      continue;
    }
    if (matcher.test(readLintSource(file))) {
      addError(
        'MKR' + String(100 + index),
        file,
        rule.message + ' [source: ' + rule.skill + ']',
      );
    }
  }
});

if (errors.length) {
  process.stderr.write(
    'Makers compatibility lint found ' + errors.length + ' issue(s):\n'
      + errors.join('\n'),
  );
  process.exit(2);
}

process.stdout.write(
  'Makers compatibility lint passed (' + files.length + ' files, '
    + sourceRules.length + ' skill rules, ' + frameworkProfiles.length + ' framework profiles).\n',
);
`}`;
}

const COMPAT_SCRIPT_NAME = '.makers-compat-check.cjs';

/**
 * Which script body each session already has on disk.
 *
 * The body is derived from the vendored skills, which are read once per
 * process, so it is identical for every run of a session — and the lint runs at
 * least twice a turn, once before the preview starts and once at verification.
 * Re-sending it each time was a sandbox write buying nothing.
 *
 * Keyed by session because sessions do not share a sandbox, and paired with the
 * retry below because a cache that outlives the file it describes is worse than
 * no cache at all.
 */
const uploadedCompatScripts = new Map<string, string>();

function compatScriptFingerprint(script: string) {
  return createHash('sha256').update(script).digest('hex');
}

/** A sandbox recycled under us: the file is gone, so the lint never ran. */
function compatScriptMissing(result: { stdout?: string; stderr?: string }) {
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  return output.includes('MODULE_NOT_FOUND')
    || (output.includes('Cannot find module') && output.includes(COMPAT_SCRIPT_NAME));
}

/**
 * Run the lint so that a failure still arrives as a report.
 *
 * Exiting non-zero is how the lint says it found something, and it is also what
 * throws away everything it found: the sandbox layer turns a failed shell into
 * SANDBOX_UNKNOWN_ERROR and keeps neither stdout nor stderr, so the caller is
 * handed "exit status 2" and nothing else. That reads like a broken sandbox
 * rather than a project to fix — the run that prompted this spent one turn
 * checking the CLI version and another guessing at a file before it landed on
 * the one the lint had already named. Echoing the status keeps the shell
 * successful, which is what lets the report travel as text.
 */
export function buildMakersCompatibilityCommand() {
  return [
    'set +e',
    `node ../${COMPAT_SCRIPT_NAME}`,
    'echo EXIT:$?',
  ].join('\n');
}

export async function runMakersCompatibilityCheck(
  context: any,
  state: ProjectState,
) {
  const [rules, profiles] = await Promise.all([
    loadMakersValidationRules(),
    loadMakersFrameworkProfiles(),
  ]);
  const script = buildMakersCompatibilityScript(rules, profiles);
  const scriptPath = `${state.sessionDir}/${COMPAT_SCRIPT_NAME}`;
  const fingerprint = compatScriptFingerprint(script);
  const upload = async () => {
    await context.sandbox.files.write(scriptPath, script);
    uploadedCompatScripts.set(state.sessionDir, fingerprint);
  };

  if (uploadedCompatScripts.get(state.sessionDir) !== fingerprint) {
    await upload();
  }

  const run = () => runCommandCapturingExit(
    context,
    buildMakersCompatibilityCommand(),
    { cwd: state.appDir, timeout: 20 },
  );

  const result = await run();
  if (result.exitCode !== 0 && compatScriptMissing(result)) {
    // Not a project failure — the lint had nothing to run. Restore the file and
    // ask again, because reporting this as a compatibility failure would send
    // the model looking for a problem in code that was never examined.
    uploadedCompatScripts.delete(state.sessionDir);
    await upload();
    return run();
  }
  return result;
}

/**
 * Keep fast, deterministic checks that the CLI cannot explain as clearly.
 *
 * The prefix rules here are about what the project must not contain: the host
 * restores /preview/ in the browser, so root-absolute paths are correct, and
 * what breaks is a path that carries the prefix already or a framework told to
 * expect it. The exception is a subresource URL in a page nothing builds, which
 * the parser fetches before the restoring shim can exist — that one has to be
 * relative, and it is the only root-absolute path still rejected here.
 *
 * The adapter check is the exception in shape — it is about what the project
 * must contain. It earns that because it is the only failure here that no other
 * gate sees: preview, smoke test, and build all pass without the adapter, and
 * the deployment is broken anyway.
 */
export async function assertMakersProjectCompatible(
  context: any,
  state: ProjectState,
) {
  const result = await runMakersCompatibilityCheck(context, state);
  if (result.exitCode !== 0) {
    throw new Error(
      `Makers compatibility check failed:\n${result.stderr || result.stdout}\nThis is the project lint, not the EdgeOne CLI: do not check the CLI version or inspect the environment. Fix only the reported project files, then rerun the same EdgeOne CLI command.`,
    );
  }
}
