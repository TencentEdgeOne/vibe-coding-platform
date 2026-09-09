/**
 * The scaffolder's output, already on disk here, so a new project does not wait
 * for it to be produced again.
 *
 * What a run used to spend before its first project file existed: a round trip
 * to load the framework reference, then `npx create-next-app@latest`, which
 * fetches the create package, fetches a template, and installs as it goes. The
 * tree it produces is the same every time and depends on nothing about the
 * request, so `npm run bake:templates` produces it once and commits it.
 *
 * Two things follow from that, and the second is the larger one:
 *
 * The install starts at the scaffold instead of two minutes into the turn. It
 * needs only package.json, which arrives here in the first tool call rather
 * than after the model has written a dozen files — the gap a measured session
 * lost 73 seconds to, on top of the scaffolder's own install.
 *
 * And a scaffolder that cannot reach its template stops being the run's
 * problem. Several of them — the ones built on giget — fetch from GitHub at run
 * time rather than shipping a template in their npm package, so they fail
 * wherever the sandbox's egress does not reach it, and the run degrades to
 * writing a framework's boilerplate by hand. A baked template needs the
 * network only on the machine that baked it.
 *
 * A framework with no baked template resolves to nothing and the run takes the
 * old path, which is why this stays an accelerator rather than an allowlist.
 */

import { gzipSync } from 'node:zlib';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { PREVIEW_ASSET_PREFIX_ENV } from '../_constants.ts';
import type { ProjectState, ScaffoldLog } from '../_types.ts';
import { safeSegment } from '../utils/_paths.ts';
import { buildNpmWarmupCommand } from '../../shared/npm-install.ts';
import { runSandboxCommand } from './_commands.ts';

export type ProjectTemplate = {
  id: string;
  /** The framework reference whose Scaffold command produced this tree. */
  ref: string;
  /** That command, recorded so a skill sync that changes it fails a test. */
  command: string;
  bakedAt: string;
  files: number;
  bytes: number;
};

/**
 * Spellings of a framework that should reach the same template.
 *
 * Only for names that do not survive normalization into a template id — the ids
 * themselves are matched without being listed. `react` maps to the Vite
 * template because that is what the prompt already asks for when a request
 * names React without a framework around it; `vue` deliberately maps to
 * nothing, since the baked Vite tree is the React one and handing a Vue request
 * a React app is worse than scaffolding it the slow way.
 */
const TEMPLATE_ALIASES: Readonly<Record<string, string>> = {
  next: 'nextjs',
  nextapp: 'nextjs',
  vite: 'vite-spa',
  vitereact: 'vite-spa',
  react: 'vite-spa',
  reactts: 'vite-spa',
  reacttypescript: 'vite-spa',
  svelte: 'sveltekit',
  remix: 'react-router',
  reactrouterv7: 'react-router',
  tanstack: 'tanstack-start',
  nuxtjs: 'nuxt',
  nuxt3: 'nuxt',
  nuxt4: 'nuxt',
  astrojs: 'astro',
  // The agent side, where a request names the app it wants and not a framework.
  // "Make an AI chat assistant" offers nothing an id can match, so without
  // these the baked chat tree is reachable only by a model that already knows
  // the id `deepagents` — and nothing tells it that. It went unused for
  // exactly the prompts it was baked for, while the model hand-wrote a
  // package.json beside it.
  //
  // Between the two baked agent trees deepagents is the general
  // streaming-chat one, so a bare `agent` or `chat` lands there; the scaffold
  // result names the tree it got, which is what lets a model that wanted the
  // other one change course.
  //
  // The agent frameworks nobody baked — crewai, openai-agents-sdk,
  // claude-agent-sdk — deliberately stay out. Handing one of those a
  // deepagents tree is the `vue` mistake above: their own reference is a
  // better start than the wrong template.
  chat: 'deepagents',
  chatbot: 'deepagents',
  aichat: 'deepagents',
  assistant: 'deepagents',
  aiassistant: 'deepagents',
  chatassistant: 'deepagents',
  aichatassistant: 'deepagents',
  agent: 'deepagents',
  aiagent: 'deepagents',
  deepagent: 'deepagents',
  langgraphjs: 'langgraph',
};

/** Punctuation and case are what separate "Next.js" from the id "nextjs". */
function normalizeFrameworkName(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Where the baked trees are, which is not one place.
 *
 * Locally the agent runs with cwd at the repository root, so `templates/` is
 * right there. Deployed, it runs from the bundle the CLI uploads, and the
 * builder puts everything named in `agents.includeFiles` under an
 * `included_files/` namespace of its own — the tree keeps its shape and moves
 * one level down. Only `.claude/skills` arrives at the root, and only because
 * the builder copies that one by name.
 *
 * Naming both is what keeps a deployed run from silently taking the scaffolder
 * path while the same checkout works on a laptop.
 */
const TEMPLATE_ROOTS = ['templates', path.join('included_files', 'templates')] as const;

const NO_TEMPLATES: readonly ProjectTemplate[] = Object.freeze([]);

type BakedTemplates = { root: string; templates: readonly ProjectTemplate[] };

let bakedCache: BakedTemplates | undefined;

/**
 * The manifest and the directory it was found in, resolved together so a later
 * file read cannot go looking in the other candidate.
 *
 * Nothing is remembered until a manifest parses. Memoising the miss is what
 * turned one unreadable manifest into a process that never used a baked
 * template again, and the deployed runtime is exactly where that miss happens.
 */
async function loadBakedTemplates(): Promise<BakedTemplates | undefined> {
  if (bakedCache) return bakedCache;

  for (const candidate of TEMPLATE_ROOTS) {
    const root = path.join(process.cwd(), candidate);
    try {
      const raw = await readFile(path.join(root, 'manifest.json'), 'utf8');
      const parsed = JSON.parse(raw) as { templates?: ProjectTemplate[] };
      bakedCache = { root, templates: Object.freeze(parsed.templates ?? []) };
      return bakedCache;
    } catch {
      // The other candidate, and then nothing: a build carrying no baked trees
      // is a working build, and every caller treats "no template" as the old
      // scaffolder path.
    }
  }
  return undefined;
}

export async function listProjectTemplates(): Promise<readonly ProjectTemplate[]> {
  return (await loadBakedTemplates())?.templates ?? NO_TEMPLATES;
}

export async function resolveProjectTemplate(
  framework: string | undefined,
): Promise<ProjectTemplate | undefined> {
  if (!framework?.trim()) return undefined;
  const normalized = normalizeFrameworkName(framework);
  if (!normalized) return undefined;

  const templates = await listProjectTemplates();
  const wanted = TEMPLATE_ALIASES[normalized] ?? normalized;
  return templates.find((template) => (
    template.id === wanted || normalizeFrameworkName(template.id) === wanted
  ));
}

type TemplateFile = { p: string; t?: string; d?: string };

/**
 * The name a template's `.gitignore` is committed under.
 *
 * It cannot be committed as one: inside templates/ it would be a live ignore
 * file for its own directory, and the Next.js tree's copy lists next-env.d.ts —
 * so the template was a file short of what it was baked from, on a fresh clone
 * only. The bake script renames it; this puts the name back on the way in.
 */
const GITIGNORE_STORED_AS = '_gitignore';

async function readTemplateFiles(id: string): Promise<TemplateFile[]> {
  const baked = await loadBakedTemplates();
  if (!baked) {
    throw new Error('the baked trees are not in this build');
  }
  const root = path.join(baked.root, id);
  const files: TemplateFile[] = [];

  async function walk(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(target);
        continue;
      }
      const relative = path
        .relative(root, entry.name === GITIGNORE_STORED_AS
          ? path.join(dir, '.gitignore')
          : target)
        .replaceAll(path.sep, '/');
      const bytes = await readFile(target);
      // Text as text, so the payload gzips against the whole tree rather than
      // against base64 of it — the difference on a lockfile is most of the
      // transfer. Binary is real here and not a hypothetical: the Next.js tree
      // carries a favicon and the Vite one a PNG.
      const asText = bytes.toString('utf8');
      files.push(Buffer.from(asText, 'utf8').equals(bytes)
        ? { p: relative, t: asText }
        : { p: relative, d: bytes.toString('base64') });
    }
  }

  await walk(root);
  files.sort((a, b) => a.p.localeCompare(b.p));
  return files;
}

export const TEMPLATE_FILES_MARKER = 'TEMPLATE_FILES:';

/**
 * A self-contained extractor, rather than a payload plus a script to read it.
 *
 * Two round trips is the budget — one write, one command — and inlining the
 * payload spends neither on quoting: base64 is already shell-safe and
 * JS-string-safe, so nothing here has to be escaped on the way through.
 *
 * `.cjs` because the tree being written may declare `"type": "module"`, and a
 * plain `.js` extractor would then be parsed as ESM and fail on its own
 * requires.
 */
function buildExtractorScript(payload: string) {
  return [
    "const zlib = require('node:zlib');",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    `const files = JSON.parse(zlib.gunzipSync(Buffer.from('${payload}', 'base64')).toString('utf8'));`,
    'for (const file of files) {',
    '  const target = path.resolve(process.cwd(), file.p);',
    '  fs.mkdirSync(path.dirname(target), { recursive: true });',
    "  fs.writeFileSync(target, file.d === undefined ? file.t : Buffer.from(file.d, 'base64'));",
    '}',
    `process.stdout.write('${TEMPLATE_FILES_MARKER}' + files.length + '\\n');`,
  ].join('\n');
}

const fileCache = new Map<string, Promise<readonly TemplateFile[]>>();

function cachedTemplateFiles(id: string) {
  const cached = fileCache.get(id);
  if (cached) return cached;
  const reading = readTemplateFiles(id).then((files) => Object.freeze(files));
  fileCache.set(id, reading);
  return reading;
}

export type AppliedTemplate = {
  id: string;
  files: number;
  /** Whether adaptPackageJson changed the manifest before it was written. */
  adapted: boolean;
};

/**
 * Put the preview prefix option into a framework config that does not have it.
 *
 * The official scaffolder output never mentions the environment variable the
 * host exports, so without this the model has to load makers-frameworks just
 * to rewrite one line — and often rewrites the rest of the file with it.
 * Returning undefined means the file is already correct or is not a config
 * this function knows how to touch.
 */
export function withPreviewAssetPrefix(
  relativePath: string,
  content: string,
): string | undefined {
  if (!content || content.includes(PREVIEW_ASSET_PREFIX_ENV)) return undefined;
  const file = relativePath.replaceAll('\\', '/');
  const env = `process.env.${PREVIEW_ASSET_PREFIX_ENV}`;

  // SvelteKit is the one framework here that types its prefix as a template
  // literal — `"" | \`/${string}\`` — rather than as a string, and an
  // environment variable is only ever `string`. The assignment is correct at
  // runtime and unprovable at compile time, so it needs the assertion said out
  // loud. It goes in only for a TypeScript target: `svelte.config.js` is
  // checked too, under `checkJs`, but `as` is not JavaScript.
  const kitBase = /\.ts$/.test(file) ? `${env} as \`/\${string}\`` : env;

  if (/(?:^|\/)next\.config\.(?:ts|js|mjs)$/.test(file)) {
    return injectAfterOpen(content, /=\s*\{/, `assetPrefix: ${env},`);
  }
  if (/(?:^|\/)nuxt\.config\.(?:ts|js|mjs)$/.test(file)) {
    return injectAfterOpen(content, /defineNuxtConfig\(\s*\{/, `app: { baseURL: ${env} },`);
  }
  if (/(?:^|\/)svelte\.config\.(?:ts|js|mjs)$/.test(file)) {
    return injectAfterOpen(
      content,
      /kit:\s*\{/,
      `...(${env} ? { paths: { base: ${kitBase} } } : {}),`,
    );
  }
  // The second half of React Router's prefix, and the half without which the
  // first does nothing.
  //
  // Vite's `base` moves the asset URLs and strips the prefix off the request
  // before the framework sees it — but React Router's dev adapter puts it
  // straight back (`nodeReq.url = nodeReq.originalUrl`, so that "React Router
  // is aware of the full path"). It then matches that prefixed path against a
  // basename still defaulting to '/', finds nothing, and answers every
  // navigation with `No route matches URL "/preview"`. A `base` on its own is
  // not an incomplete configuration here, it is an unusable one.
  //
  // Set in the framework's config rather than the Vite one because that is
  // where React Router reads it: the value is baked into the server build and
  // handed to the static handler, which is what makes the SSR side match. The
  // framework also refuses to start in dev unless the basename begins with the
  // base, which the shared environment variable satisfies by construction.
  if (/(?:^|\/)react-router\.config\.(?:ts|js|mjs)$/.test(file)) {
    return injectAfterOpen(content, /export default\s*\{/, `basename: ${env} ?? "/",`);
  }
  if (/(?:^|\/)(?:vite|astro)\.config\.(?:ts|js|mjs)$/.test(file)) {
    // SvelteKit's documented option is kit.paths.base. The current scaffolder
    // puts that kit object on the vite plugin, so the injection follows it
    // rather than setting Vite's `base`, which SvelteKit ignores.
    if (/\bsveltekit\s*\(/.test(content)) {
      return injectAfterOpen(
        content,
        /sveltekit\(\s*\{/,
        `...(${env} ? { paths: { base: ${kitBase} } } : {}),`,
      );
    }
    return injectAfterOpen(content, /defineConfig\(\s*\{/, `base: ${env},`);
  }
  return undefined;
}

function injectAfterOpen(content: string, opener: RegExp, property: string) {
  const match = opener.exec(content);
  if (!match) return undefined;
  const insertAt = match.index + match[0].length;
  const after = content.slice(insertAt);
  const indentMatch = /^\r?\n([ \t]+)/.exec(after);
  const indent = indentMatch?.[1] ?? '  ';
  return `${content.slice(0, insertAt)}\n${indent}${property}${
    indentMatch ? after : `\n${after}`
  }`;
}

export type ApplyTemplateOptions = {
  onLog?: (log: ScaffoldLog) => void;
  /**
   * A last chance to change package.json, taken before anything is written.
   *
   * The ordering is the whole reason this is a hook rather than a second write
   * afterwards. The install starts in the same command as the extraction, and
   * it stamps package.json as it starts; a manifest edited after that no longer
   * matches the stamp, so the handoff discards the finished install and the
   * project pays for a second one. Editing here means there is only ever one.
   */
  adaptPackageJson?: (content: string) => Promise<string | undefined> | string | undefined;
};

/**
 * Write the template into the workspace and start its install in one command.
 *
 * Chained rather than issued separately because the install is the thing being
 * raced: every round trip between the files landing and `npm install` starting
 * is time the user waits for at the end of the turn. The warmup is the existing
 * one, so a project created from a template and one written by hand converge on
 * the same install, the same handoff, and the same single-npm-process rule.
 */
export async function applyProjectTemplate(
  context: any,
  state: ProjectState,
  template: ProjectTemplate,
  options: ApplyTemplateOptions = {},
): Promise<AppliedTemplate> {
  const { onLog, adaptPackageJson } = options;
  const files = [...(await cachedTemplateFiles(template.id))];

  let adapted = false;
  const manifestIndex = files.findIndex((file) => file.p === 'package.json');
  const manifest = manifestIndex >= 0 ? files[manifestIndex].t : undefined;
  if (adaptPackageJson && manifest !== undefined) {
    const replacement = await adaptPackageJson(manifest);
    if (replacement !== undefined && replacement !== manifest) {
      files[manifestIndex] = { p: 'package.json', t: replacement };
      adapted = true;
    }
  }

  for (let i = 0; i < files.length; i += 1) {
    const file = files[i];
    if (file.t === undefined) continue;
    const next = withPreviewAssetPrefix(file.p, file.t);
    if (next !== undefined) files[i] = { p: file.p, t: next };
  }

  const payload = gzipSync(Buffer.from(JSON.stringify(files), 'utf8')).toString('base64');
  const script = buildExtractorScript(payload);
  const scriptPath = `/tmp/eo-template-${safeSegment(template.id)}-${process.pid}.cjs`;

  onLog?.({
    stream: 'status',
    content: `Writing the ${template.id} project template into ${state.appDir}`,
  });

  await context.sandbox.files.write(scriptPath, script);

  // set -e so a failed extraction never reaches the warmup: the warmup's first
  // act is to disable it again, and an install started over a half-written tree
  // is the failure this codebase already pays the most to avoid.
  const result = await runSandboxCommand(
    context,
    [
      'set -e',
      `node ${scriptPath}`,
      `rm -f ${scriptPath}`,
      buildNpmWarmupCommand(),
    ].join('\n'),
    { cwd: state.appDir, timeout: 120 },
  );

  const written = Number(
    String(result.stdout || '').match(new RegExp(`${TEMPLATE_FILES_MARKER}(\\d+)`))?.[1],
  );
  if (!written) {
    throw new Error(
      result.stderr || result.stdout || `Failed to write the ${template.id} template.`,
    );
  }

  onLog?.({
    stream: 'status',
    content: `Wrote ${written} files from the ${template.id} template and started installing its dependencies.`,
  });

  return { id: template.id, files: written, adapted };
}
