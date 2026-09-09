import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { buildPrompt, buildTurnPrompt } from '../agents/_prompt.ts';
import {
  MAKERS_DEV_PORT,
  PREVIEW_ASSET_PREFIX_ENV,
  PREVIEW_PATH_PREFIX,
  PREVIEW_PUBLIC_PORT,
  PREVIEW_SERVER_PORT,
} from '../agents/_constants.ts';
import { MAKERS_REFERENCE_SKILL_NAMES } from '../agents/tools/_makers-skills.ts';
import { projectState } from './helpers/fixtures.ts';

// Platform contracts that the vendored skills own. Restating any of these in
// the system prompt creates a second source of truth that drifts silently when
// the platform ships new skills, so the prompt must stay clear of them.
const PLATFORM_OWNED_IDENTIFIERS = [
  'onRequestGet',
  'onRequestPost',
  'Response.json()',
  'my_kv',
  'context.env.KV',
  'context.request.body',
  'export function middleware',
  'export const config',
  'context.rewrite(',
  'makers-conversation-id',
  'text/event-stream',
  'data: [DONE]',
  'agents.framework',
  '@makers/hy3-preview',
  '@edgeone/pages-blob',
];

const state = projectState();
const makersProjectName = 'vibe-coding-playground';

function renderPrompt(isNewProject = true, modelLabel = 'Kimi K2.6', webSearchAvailable = false) {
  return buildPrompt(
    state,
    isNewProject,
    'edgeone-sandbox',
    makersProjectName,
    modelLabel,
    webSearchAvailable,
  );
}

async function readAllVendoredSkills() {
  const root = '.claude/skills';
  const chunks: string[] = [];

  async function walk(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.name.endsWith('.md')) {
        chunks.push(await readFile(full, 'utf8'));
      }
    }
  }

  await walk(root);
  return chunks.join('\n');
}

test('the system prompt does not restate platform contracts owned by the skills', () => {
  const prompt = renderPrompt();
  const leaked = PLATFORM_OWNED_IDENTIFIERS.filter((identifier) => prompt.includes(identifier));
  assert.deepEqual(
    leaked,
    [],
    `these belong in the vendored skills, not the prompt: ${leaked.join(', ')}`,
  );
});

test('everything the prompt refuses to restate is actually documented in a skill', async () => {
  const skills = await readAllVendoredSkills();
  const undocumented = PLATFORM_OWNED_IDENTIFIERS.filter(
    (identifier) => !skills.includes(identifier),
  );
  assert.deepEqual(
    undocumented,
    [],
    `the prompt was stripped of knowledge no skill provides: ${undocumented.join(', ')}`,
  );
});

test('the prompt routes the model to the right reference before it writes code', () => {
  const prompt = renderPrompt();
  assert.match(prompt, /load_makers_skill/);
  assert.match(prompt, /load the reference first, then write/i);
  for (const skill of [
    'makers-recipes',
    'makers-cloud-functions',
    'makers-edge-functions',
    'makers-agents',
    'makers-storage',
    'makers-middleware',
    'makers-migration',
  ]) {
    assert.ok(prompt.includes(skill), `prompt should route to ${skill}`);
  }
  assert.match(prompt, /passing ref/);
  assert.match(prompt, /no file-reading tool can open them/);
});

// A routing hint that names a skill which does not exist would send the model
// after a reference load_makers_skill can never satisfy.
test('every skill the prompt names is one the loader can actually serve', () => {
  const named = new Set(renderPrompt().match(/(?<![\w-])makers-[a-z]+(?:-[a-z]+)*/g) ?? []);
  assert.ok(named.size >= 7, `expected the prompt to route to several skills, found ${named.size}`);
  for (const name of named) {
    assert.ok(
      (MAKERS_REFERENCE_SKILL_NAMES as readonly string[]).includes(name),
      `prompt routes to "${name}", which is not a vendored skill`,
    );
  }
});

// The official skills describe a normal developer machine. Dropping these
// corrections would send the model down documented-but-unavailable paths.
test('the prompt keeps the sandbox corrections the skills cannot know about', () => {
  const prompt = renderPrompt();
  assert.match(prompt, /target sandbox image is expected to provide the EdgeOne CLI/);
  assert.match(prompt, /Run it directly with the commands tool/);
  assert.match(
    prompt,
    new RegExp(`edgeone makers dev --port ${MAKERS_DEV_PORT} --skip-env-sync`),
  );
  assert.match(prompt, new RegExp(`path adapter on port ${PREVIEW_SERVER_PORT}`));
  assert.match(
    prompt,
    new RegExp(`sandbox\\.getHost\\(${PREVIEW_PUBLIC_PORT}\\).*${PREVIEW_PATH_PREFIX}`),
  );
  // The host owns the deploy project name, so the prompt must not hand the
  // model a -n to copy, edit, or replace after a name conflict.
  assert.match(prompt, /edgeone makers deploy --json once/);
  assert.match(prompt, /Never pass -n, invent a project name/);
  assert.match(prompt, /one read-only edgeone --version check is allowed/);
  assert.match(prompt, /errorCode=MAKERS_CLI_UNAVAILABLE, stop immediately/);
  assert.match(prompt, /Do not inspect PATH or installation directories/);
  assert.match(prompt, /host injects a short-lived tenant credential/i);
  assert.ok(prompt.includes(makersProjectName));
  assert.match(prompt, /Normalize it to end in exactly \/v1/);
  assert.match(
    prompt,
    new RegExp(`public development preview starts under ${PREVIEW_PATH_PREFIX}`),
  );
  // The deployed form is now the only form, because the host restores the
  // prefix and the token in the browser. The project therefore contains no
  // code that exists solely to survive the preview.
  assert.match(prompt, /fetch\('\/api\/example'\)/);
  assert.match(prompt, /write no code for the sandbox at all/);
  assert.match(prompt, /nothing in the project reads, stores, or forwards a token/);
  // And nothing may reintroduce the sessionStorage dance the host replaced.
  assert.doesNotMatch(prompt, /sessionStorage/);
  // The 401 body nests its message, and assigning it straight into new Error()
  // prints "[object Object]" — which reads as a generated-code bug rather than
  // as the authentication failure it is.
  assert.match(prompt, /renders "\[object Object\]" and hides the real message/);
  assert.match(prompt, /never hand a non-string to new Error\(\)/);
  assert.match(prompt, /cannot vary the visitor region, client IP, or device/);
  assert.match(prompt, /must re-render from content the page already holds/);
  // Whether the prefix is stripped depends on what the framework does with it,
  // so the prompt no longer promises either way. What stays a sandbox-only fact
  // is where the prefix comes from: an environment variable, never a literal.
  assert.match(prompt, /reading it is the only way a project may know about one/);
  // Framework-emitted URLs are the half of this the fetch rule cannot reach:
  // they are written at request time, so no source convention can move them
  // under the prefix and only the framework's own option can. Which option that
  // is per framework is pinned in its own test below.
  assert.match(prompt, new RegExp(`process\\.env\\.${PREVIEW_ASSET_PREFIX_ENV}`));
  assert.match(prompt, /written by the framework at request time/);
  assert.match(prompt, /Omit the option entirely when the variable is unset/);
  // basePath looks like the obvious fix and breaks every route, so the reason
  // has to travel with the rule.
  assert.match(prompt, /it makes the framework expect a prefix, and the routes 404 instead of the assets/);
  // And the case with no option to set at all. A plain index.html is served
  // byte for byte, so the URL in the markup is the URL the browser requests,
  // and the shim two rules down never gets the chance the parser takes first.
  assert.match(prompt, /before any script on the page has run/);
  assert.match(prompt, /href="style\.css" and src="script\.js" for files beside it/);
  // The boundary matters as much as the rule: widened to links and fetch it
  // would contradict the next rule, which the retired MKR011 and MKR014 already
  // proved is the more expensive mistake of the two.
  assert.match(prompt, /covers only URLs the markup loads/);
  // Links are the deploy-correct form, and the host puts the prefix back. The
  // previous rule — count ../ steps by the page's depth in the route tree —
  // was correct and unusable, and the home link every page carries is the one
  // it got wrong.
  assert.match(prompt, /root-absolute, as <a href="\/"> for the home page/);
  assert.match(prompt, /restores \/preview\/ in front of them/);
  assert.doesNotMatch(prompt, /<a href="\.\.\/\.\.">/);
  // Deriving a path at runtime stays banned either way: the framework reports
  // it with the prefix already stripped, so anything measured from it is short
  // by that segment.
  assert.match(prompt, /do not compute a path at runtime from usePathname\(\)/);
  // next/link is the half the host cannot correct, because it never leaves the
  // client for a document the proxy would see.
  assert.match(prompt, /use a plain anchor for cross-page navigation rather than next\/link/);
  assert.match(prompt, /echo EXIT:\$\?/);
});

test('the prompt keeps its tool contracts and workspace boundary', () => {
  const prompt = renderPrompt();
  assert.ok(prompt.includes(state.appDir), 'prompt must name the writable project directory');
  assert.match(prompt, /ensure_project_scaffold as the first tool/);
  assert.match(prompt, /write_project_file accepts exactly one file per call/);
  assert.match(prompt, /When the command result reports a successful preview URL, stop/);
  assert.match(prompt, /Run edgeone makers deploy only when the user explicitly asks/);
  assert.doesNotMatch(prompt, /publish_preview|deploy_to_makers|get_preview_link/);
  assert.match(prompt, /I can only help create or modify web projects/);
});

test('the prompt reflects whether the workspace already exists', () => {
  assert.match(renderPrompt(true), /workspace may not have been prepared yet/);
  assert.match(renderPrompt(false), /already prepared a project workspace/);
});

test('recent conversation history is included when present', () => {
  const withHistory = buildTurnPrompt('再加一个深色模式', [
    { role: 'user', content: '做一个待办列表' },
    { role: 'assistant', content: '已完成，右侧可以预览。' },
  ]);
  assert.match(withHistory, /Recent conversation:/);
  assert.match(withHistory, /User: 做一个待办列表/);
  assert.match(withHistory, /Current user request: 再加一个深色模式/);
  assert.doesNotMatch(buildTurnPrompt('再加一个深色模式', []), /Recent conversation:/);
});

// The rules are a ~20k-character prefix. Anything turn-specific in here makes
// that prefix new on every turn, so the provider re-reads all of it instead of
// reusing it, and the request would arrive twice with no way to say which copy
// is authoritative.
test('the system prompt is the same on every turn of a conversation', () => {
  const request = '做一个带留言板的网站';
  const prompt = renderPrompt();

  assert.equal(prompt, renderPrompt(), 'the rules must not vary between two identical calls');
  assert.ok(
    !prompt.includes(request),
    'the request belongs to buildTurnPrompt; a copy here changes the cached prefix every turn',
  );
  assert.doesNotMatch(prompt, /Recent conversation:/);
  assert.doesNotMatch(prompt, /Current user request:/);
});

test('the prompt reads as sections rather than one wall of rules', () => {
  const prompt = renderPrompt();
  const headings = prompt.match(/^## .+$/gm) ?? [];
  assert.ok(headings.length >= 10, `expected named sections, found ${headings.length}`);
  // The sandbox rules were one 7.7k-character paragraph; nothing should grow
  // back to that size, because a rule buried mid-blob is a rule nobody follows.
  const longest = Math.max(...prompt.split('\n\n').map((block) => block.length));
  assert.ok(longest < 4000, `a single prompt block is ${longest} characters long`);
});

// This rule was stated three times — in the sandbox overrides, the new-project
// workflow, and the code-quality rules. Three copies are three chances for one
// of them to drift.
test('a missing CLI is explained in exactly one place', () => {
  const prompt = renderPrompt();
  const mentions = prompt.match(/MAKERS_CLI_UNAVAILABLE/g) ?? [];
  assert.equal(mentions.length, 1, `MAKERS_CLI_UNAVAILABLE is stated ${mentions.length} times`);
});

test('the identity answer names the running model and never its raw ID', () => {
  const prompt = renderPrompt(true, 'Kimi K2.6');
  assert.match(prompt, /which model you run/);
  assert.ok(prompt.includes('Kimi K2.6'), 'the agent must be able to name the selected model');
  // Every model reaching this harness reports itself as the harness's vendor,
  // so without this the agent states the wrong vendor with full confidence.
  assert.match(prompt, /own impression of which model or vendor you are is not evidence/);
  // The picker's labels are the user-facing names; the IDs carry the tier.
  assert.doesNotMatch(prompt, /@makers\//);
});

test('an unlabelled model leaves the identity answer without a name to guess from', () => {
  const prompt = renderPrompt(true, '');
  assert.ok(!prompt.includes('runs on '), 'no model should be named when none resolved');
  assert.match(prompt, /whichever one the composer shows/);
});

// The navigation rule used to ban every ../ outright, which is right for a
// top-level page and wrong for any page below one: the step count is the page's
// depth. Asserting the wording would only restate the prompt, so this resolves
// the hrefs the prompt prescribes the way a browser does, at each depth, in
// preview and once deployed.
// Nearly lost in the restructure: the host appends the echo itself now, but a
// model that adds one anyway can only put it where the host would not — after
// the preview server, which never returns.
test('the exit echo is described as the host\'s, and banned from preview commands', () => {
  const prompt = renderPrompt();
  assert.match(prompt, /`echo EXIT:\$\?` line the host appends/);
  assert.match(prompt, /never append it to a long-running, background, preview-server, or deploy command/);
});

// Each of these three came out of one run: it reverse-engineered a framework
// from the bundle in node_modules, tried to kill and relaunch the dev server
// itself, and then called the feature working on the strength of a probe that
// had returned the project's own home page four times.
test('the prompt closes the three ways a run can talk itself into a false finish', () => {
  const prompt = renderPrompt();

  // A bundled artifact describes the library's whole surface, not the usage the
  // platform supports, and reading it is many turns to reach a worse answer.
  assert.match(prompt, /An installed dependency is not a reference/);
  assert.match(prompt, /bundled dist files, \.d\.ts declarations, or version metadata/);

  // There is no restart primitive to reach for: the host restarts the server
  // when its own route probe finds an endpoint unmounted.
  assert.match(prompt, /only restart mechanism/);
  assert.match(prompt, /restarts the server when one is not mounted/);
  assert.match(prompt, /Do not kill processes or free ports/);

  // The static site answers a POST to an unmounted route with 200 and a page,
  // so an HTML body is the one reply that must never read as a success.
  assert.match(prompt, /An HTML document is not a verified endpoint/);
  assert.match(prompt, /the request never reached the handler at all/);
});

// A run searched the live web for this platform's project layout — a document
// the repo vendors verbatim. Search stays available for subject matter, but
// platform knowledge has exactly one source and the web is not a second one.
// A run refused to build TanStack Start, told the user its SSR runtime was not
// on EdgeOne's "official support list", and ended the turn asking them to pick
// another framework. The word tanstack does not appear in any vendored skill,
// and no reference carries a framework allowlist at all — the claim was recalled
// from training data, and it cost the user the whole turn.
// The asset-prefix rule used to name next.config.js and nothing else, so a
// TanStack Start project fell through it: every stylesheet and client chunk
// 404ed while the document answered 200 and the build passed. The rule has to
// reach whatever framework the request asks for, and the env var is the value
// in every case — the literal is what MKR015 rejects.
test('the asset prefix is told to the framework, whichever framework it is', () => {
  const prompt = renderPrompt();

  // Named mechanisms, not one framework's — and named without an extension,
  // the way the Vite half already was. Pinning .js sent the model to a file the
  // scaffolder did not write: create-next-app produces next.config.ts, so the
  // instruction read as "create a second config file" beside the real one.
  assert.match(prompt, /assetPrefix in next\.config for Next\.js/);
  assert.doesNotMatch(prompt, /next\.config\.(?:js|mjs|ts)\b/);
  assert.match(prompt, /base in vite\.config for Vite and everything built on it/);
  assert.match(prompt, /TanStack Start/);
  // Always the variable, never the literal.
  assert.match(prompt, new RegExp(`the value is always process\\.env\\.${PREVIEW_ASSET_PREFIX_ENV}`));
  assert.match(prompt, /Omit the option entirely when the variable is unset/);
  // And the compensating second option stays banned, because it moves routing.
  assert.match(prompt, /basePath in particular is not the fix for a 404/);
});

// Eight commands went into recovering one framework's "official template":
// npm view, tarballs unpacked in /tmp, a scaffolder's own source read to find
// where it fetches templates from, then the same again for its replacement.
// The sequence had no bottom, because every answer was "the template is
// elsewhere" — modern scaffolders fetch theirs at run time, so no published
// package contains one. Running the scaffolder ends the search in one command.
test('the official scaffolder replaces the search for an official template', () => {
  const prompt = renderPrompt();

  // The one command that holds both the structure and the version set — and
  // the reference is the only place it is written down. A copy here drifted
  // once already: the Next.js one had decayed to `. --yes` while the document
  // specifies four more flags, and dropping them is what turns a scaffolder
  // into an interactive prompt with nobody to answer it.
  assert.match(prompt, /the reference loaded in step 1 gives its scaffold command under Scaffold/);
  assert.match(prompt, /Copy that command exactly/);
  assert.doesNotMatch(prompt, /npm create vite@latest/);
  assert.doesNotMatch(prompt, /create-next-app/);
  // A framework with no documented scaffolder must not send the model looking
  // for one, which is the search this whole step exists to end.
  assert.match(prompt, /has none worth running: write its files yourself/);
  // Which means it must be exempt from the rule that all files go through
  // write_project_file, or the step contradicts itself.
  assert.match(prompt, /is the single exception/);
  assert.match(prompt, /This is the one case where a command may create project source files/);
  // A failed scaffolder must not become the next search.
  assert.match(prompt, /that is one attempt and it is over/);
  assert.match(prompt, /Do not try a second scaffolder, a different package name, or a flag variation/);
  // And what it produced is kept, not rewritten file by file.
  assert.match(prompt, /keep what it produced and use these calls to adapt it/);
});

// For a framework with a baked template the scaffolder already ran, at build
// time, and the workspace arrives holding its output. Two instructions have to
// survive that: the one that gets the framework name into the first tool call,
// which is the only moment the host can still act on it, and the one that stops
// the run putting a scaffolder into a directory no longer empty enough for it.
test('a workspace prepared from a template is not scaffolded a second time', () => {
  const prompt = renderPrompt();

  assert.match(prompt, /Pass framework to that call whenever the request names one/);
  assert.match(prompt, /Omit it for a plain HTML\/CSS\/JS page/);
  assert.match(prompt, /A templateApplied in the ensure_project_scaffold result/);
  assert.match(prompt, /Skip the rest of this step and go to step 3/);
  // The step it exempts still has to read as conditional, or the two contradict.
  assert.match(prompt, /When the request names a framework and no template was applied/);
  // Scaffold and assetPrefix are why the frameworks skill was loaded after a
  // template landed. Both are already done, so the load has to be optional.
  assert.match(prompt, /[Dd]o not load makers-frameworks just to read the Scaffold command/);
  assert.match(prompt, /the prefix option is already in the framework config/);
  assert.match(prompt, /Load makers-storage, makers-agents, or makers-cloud-functions only when/);
  // And naming a framework here would put the choice of template in the prompt
  // rather than in the manifest, which is the drift this file exists to catch.
  assert.doesNotMatch(prompt, /templateApplied[^.]*(?:Next|Vite|Nuxt|Astro)/);
});

// The failure mode of sourcing the command from the references: read as a list
// of what is permitted rather than of what is written down. The platform has no
// allowlist by design — deployment detects the framework, runs its build, and
// uploads the output — so declining an unlisted framework refuses work the
// platform would have done, and does it in the one place the user notices.
test('the references are where a framework is described, not where it is permitted', () => {
  const prompt = renderPrompt();

  assert.match(prompt, /still one this platform builds, so never decline a request for not finding it listed/);
  // Named so the derivation has somewhere to start, instead of being an
  // instruction to improvise.
  assert.match(prompt, /Derive what it needs the way makers-frameworks describes/);
  assert.match(prompt, /an adapter only if it emits a server bundle/);
});
test('excavating a package for a project layout is closed off, with a budget', () => {
  const prompt = renderPrompt();

  // The habit, named by the tools it actually reached for.
  assert.match(prompt, /A package is never opened to learn what a project should look like/);
  assert.match(prompt, /not with npm pack, not with tar, not by reading files under node_modules/);
  // And a cap that applies to probing of every kind, since the source was
  // never the problem — the missing termination condition was.
  assert.match(prompt, /One probe per question, then build/);
  assert.match(prompt, /The build reports on the project you actually have/);
});

// A TanStack Start run read "requires Node >=22" out of an install that had
// just succeeded, then spent forty seconds querying eleven releases and their
// peer ranges before building with the versions it already had — which passed.
// The evidence was one command away and it went shopping instead.
test('a preferred-Node warning sends the run to the build, not to the registry', () => {
  const prompt = renderPrompt();
  assert.match(prompt, /A warning about the Node version a package prefers is not a failure/);
  assert.match(prompt, /Run the build and read its exit code before you go looking for another version/);
});

test('an uncitable platform limit is not the agent\'s to announce', () => {
  const prompt = renderPrompt();
  assert.match(prompt, /A limit you cannot cite is not a limit/);
  assert.match(prompt, /no reference carries a framework allowlist/);
  // And the way out is evidence, not a question put back to the user.
  assert.match(prompt, /one preview attempt settles it/);
  assert.match(
    prompt,
    /Never end a turn asking the user to choose a different framework because of a restriction you have not read/,
  );
});

test('platform knowledge is closed to the live web, and search is left a purpose', () => {
  const prompt = renderPrompt(true, 'Kimi K2.6', true);

  assert.match(prompt, /Never use web_search for anything in this section/);
  assert.match(prompt, /never for how to write EdgeOne code/);
  // Without a stated legitimate use this reads as a ban, and a banned tool in
  // the allowlist is a trap the model walks into once per conversation.
  assert.match(prompt, /facts the user asked to put on a page/);

  // A key that exists but is rejected cannot be screened out in advance, so
  // the run still has to be told what that reply means.
  assert.match(prompt, /reporting that it is not configured/);
  assert.match(prompt, /Do not call it again or rephrase/);
});

// One run, one session: it upgraded Next twice to silence a warning, filled the
// sandbox disk doing it, then read every file it had written looking for a
// `<Html>` import that only existed in a stale build directory. Neither detour
// was anything the user asked for, and together they cost most of the session.
test('the prompt names the two detours that cost a session', () => {
  const prompt = renderPrompt();

  // The build directory is checked before the source, because a build naming a
  // file the project does not contain cannot be talking about the source.
  assert.match(prompt, /stale build output, not your source/);
  assert.match(prompt, /pages\/_document or <Html> in an App Router project/);
  assert.match(prompt, /delete the build directory and build again/);

  // An audit notice and an unrecognized config key are the two warnings that
  // read as work. Neither is.
  assert.match(prompt, /Do not move a framework version to satisfy a warning/);
  assert.match(prompt, /drop the unrecognized key instead/);
});

// The host now stops the server for these, so the model has to know its preview
// is gone: the run that hit this went on reporting a live preview afterwards.
test('an install or a build is described as taking the preview down', () => {
  const prompt = renderPrompt();

  assert.match(prompt, /A build or an install cannot run beside the preview/);
  assert.match(prompt, /down until you launch it again/);
  // The restart rule has to stay consistent with it: the host frees the port,
  // which is what makes relaunching work rather than repeat.
  assert.match(prompt, /terminates the previous server itself before every launch/);
  assert.match(prompt, /Do not kill processes or free ports/);
});

// When the key is absent the tool is withheld from the tool list, and a rule
// naming a withheld tool is the one thing that could still spend a call on it.
test('a withheld search tool is not named anywhere in the prompt', () => {
  const withoutSearch = renderPrompt(true, 'Kimi K2.6', false);

  assert.doesNotMatch(withoutSearch, /web_search/);
  // The rest of the section is what actually answers platform questions, so it
  // has to survive the tool going away.
  assert.match(withoutSearch, /come from the official edgeone-makers-tools skill family/);
  assert.match(withoutSearch, /never from memory/);
});

// The prompt used to justify "never refuse a framework" with the fact that
// deployment detects the framework and runs its build. Both halves are true and
// the conclusion drawn from them is not: a full-stack framework still needs its
// platform adapter, and nothing about the preview reveals that it is missing.
test('the prompt routes framework questions to the skill instead of assuring the deploy', () => {
  const prompt = renderPrompt();

  assert.doesNotMatch(
    prompt,
    /deployment detects the framework, runs its build, and uploads the output/,
    'this reads as "so there is nothing else to configure", which is how a project ships without its adapter',
  );
  assert.match(prompt, /no reference carries a framework allowlist/);
  assert.match(prompt, /makers-frameworks/);
  assert.match(
    prompt,
    /green preview is not evidence that the deployment works/,
    'the preview and the deploy exercise different paths and the prompt has to say so',
  );
  // Routing only. Which adapter a framework takes belongs to the skill, and a
  // second copy here is the drift this whole test file exists to prevent.
  assert.doesNotMatch(prompt, /@edgeone\/(?:astro|sveltekit|react-router|tanstack-start|vite)/);
});
