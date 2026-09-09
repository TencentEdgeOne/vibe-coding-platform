import {
  MAKERS_DEV_PORT,
  PREVIEW_ASSET_PREFIX_ENV,
  PREVIEW_PATH_PREFIX,
  PREVIEW_PUBLIC_PORT,
  PREVIEW_SERVER_PORT,
} from '../_constants.ts';
import type { ProjectState } from '../_types.ts';
import {
  GENERATED_API_SMOKE,
  GENERATED_CHAT_SMOKE,
  MAKERS_DEV_LAUNCH_TIMEOUT_SECONDS,
  MAKERS_DEV_LOG_PATH,
  SMOKE_EXIT,
  buildGeneratedApiSmokeScript,
  buildGeneratedChatSmokeScript,
  buildMakersDevBackgroundCommand,
  buildMakersDevLaunchCommand,
  parseMakersDevExitCode,
} from '../../shared/makers-dev.ts';
import { makersFileSemantic } from '../../shared/makers-file-semantics.ts';
import { redactSecret } from '../../shared/makers-deploy.ts';
import { shellQuote } from '../../shared/shell.ts';
import {
  MAKERS_CLI_UNAVAILABLE_ERROR_CODE,
  MAKERS_CLI_UNAVAILABLE_MESSAGE,
  isEdgeoneCliUnavailable,
} from '../../shared/tool-phase.ts';
import { runCommandCapturingExit, runSandboxCommand } from './_commands.ts';
import { assertMakersProjectCompatible } from './_makers-compat.ts';
import { resolveMakersProjectName } from './_makers-deploy.ts';
import {
  buildSandboxMakersEnv,
  resolveMakersMasterToken,
  resolveSandboxMakersToken,
} from './_makers-token.ts';

// Where Makers mounts generated HTTP handlers; both are optional in a project.
const CLOUD_FUNCTION_DIRECTORIES = ['cloud-functions', 'edge-functions'];

export async function resolvePublicLinks(context: any) {
  const previewHost = context.sandbox.getHost(PREVIEW_PUBLIC_PORT);
  const accessToken = context.sandbox.envdAccessToken;
  const previewBaseUrl = normalizePublicUrl(previewHost);
  const sandboxDebugUrl = normalizePublicUrl(context.sandbox.browser?.liveUrl);

  const previewUrl = (previewBaseUrl && accessToken)
    ? buildPublicPreviewUrl(previewBaseUrl, accessToken)
    : undefined;

  return {
    previewUrl,
    sandboxDebugUrl,
  };
}

function normalizePublicUrl(value: unknown) {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function buildPublicPreviewUrl(baseUrl: string, token: string) {
  try {
    const parsed = new URL(baseUrl);
    parsed.pathname = PREVIEW_PATH_PREFIX;
    parsed.search = '';
    parsed.hash = '';
    return appendAccessToken(parsed.toString(), token);
  } catch {
    const trimmedBase = baseUrl.replace(/\/+$/, '');
    return appendAccessToken(`${trimmedBase}${PREVIEW_PATH_PREFIX}`, token);
  }
}

function appendAccessToken(url: string, token: string) {
  try {
    const parsed = new URL(url);
    if (!parsed.searchParams.has('access_token')) {
      parsed.searchParams.set('access_token', token);
    }
    return parsed.toString();
  } catch {
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}access_token=${encodeURIComponent(token)}`;
  }
}

/** Rotate envdAccessToken on an already-published preview URL (same host/path). */
export function rewritePreviewAccessToken(existingUrl: string, token: string) {
  try {
    const parsed = new URL(existingUrl);
    parsed.searchParams.set('access_token', token);
    return parsed.toString();
  } catch {
    return undefined;
  }
}

/**
 * `verifyRoutes: false` is for bringing a preview back after a deploy stopped
 * it. The functional gates cost a real model call against the generated agent,
 * and nothing about the project changed between the run that passed them and
 * the restart, so re-running them buys a second opinion on the same code.
 */
export async function startPreviewServer(
  context: any,
  state: ProjectState,
  options: { verifyRoutes?: boolean } = {},
) {
  const verifyRoutes = options.verifyRoutes !== false;
  await assertMakersProjectCompatible(context, state);
  const masterToken = resolveMakersMasterToken(context);
  const projectName = resolveMakersProjectName(context, state);
  const launchCommand = buildMakersDevLaunchCommand(MAKERS_DEV_PORT, projectName);
  let forceRestart = false;

  // makers-dev watches project files. On resume, keep a healthy process rather
  // than starting a second CLI instance on the same port.
  const warm = await runCommandCapturingExit(
    context,
    probePreviewReadyCommand(),
    { timeout: 5 },
  );
  if (warm.exitCode === 0) {
    try {
      if (verifyRoutes) {
        await assertGeneratedRoutesReady(context, state);
      }
      return previewServerInfo(launchCommand);
    } catch (error) {
      // A warm port that fails to answer is a stale server, not a preview. One
      // that answers wrongly is a code bug the restart would only delay.
      if (!previewFailureWarrantsRestart(error)) throw error;
      forceRestart = true;
    }
  }

  // Scoped to this conversation, and redacted out of CLI output before the
  // model or the UI sees it.
  const sandboxToken = await resolveSandboxMakersToken(state, masterToken);

  const startResult = await runSandboxCommand(
    context,
    buildMakersDevBackgroundCommand({
      makersPort: MAKERS_DEV_PORT,
      previewPort: PREVIEW_SERVER_PORT,
      previewPath: PREVIEW_PATH_PREFIX,
      projectName,
      assetPrefixEnvName: PREVIEW_ASSET_PREFIX_ENV,
      forceRestart,
    }),
    {
      cwd: state.appDir,
      timeout: MAKERS_DEV_LAUNCH_TIMEOUT_SECONDS,
      env: buildSandboxMakersEnv(sandboxToken),
    },
  );
  const startOutput = [startResult.stdout, startResult.stderr].filter(Boolean).join('\n');
  const capturedExitCode = parseMakersDevExitCode(startOutput);
  if (
    startResult.exitCode !== 0
    || (capturedExitCode != null && capturedExitCode !== 0)
  ) {
    const failure = isEdgeoneCliUnavailable(startOutput)
      ? `${MAKERS_CLI_UNAVAILABLE_ERROR_CODE}: ${MAKERS_CLI_UNAVAILABLE_MESSAGE}`
      : startOutput || 'Failed to start edgeone makers dev.';
    throw new Error(
      redactSecret(
        failure,
        sandboxToken,
      ),
    );
  }

  if (verifyRoutes) {
    await assertGeneratedRoutesReady(context, state);
  }

  return previewServerInfo(launchCommand);
}

function previewServerInfo(launchCommand: string) {
  return {
    port: PREVIEW_SERVER_PORT,
    publicPort: PREVIEW_PUBLIC_PORT,
    makersDevPort: MAKERS_DEV_PORT,
    proxyPath: PREVIEW_PATH_PREFIX,
    framework: 'makers-dev',
    command: launchCommand,
    readyPath: PREVIEW_PATH_PREFIX,
    ready: true,
  };
}

class GeneratedChatSmokeError extends Error {
  readonly kind: 'transport' | 'application' | 'route';

  constructor(message: string, kind: 'transport' | 'application' | 'route') {
    super(message);
    this.name = 'GeneratedChatSmokeError';
    this.kind = kind;
  }
}

/**
 * Restarting makers dev only helps when nothing answered, or answered wrong at
 * the transport level. Unknown failures keep the old behaviour and restart.
 *
 * An unmounted route restarts too, and it is the one case where the restart is
 * the whole fix: the handler is missing from a running server, which is what a
 * dependency change under it leaves behind.
 */
export function previewFailureWarrantsRestart(error: unknown) {
  return !(error instanceof GeneratedChatSmokeError)
    || error.kind === 'transport'
    || error.kind === 'route';
}

/**
 * One listing for both gates, in one round trip.
 *
 * Two separate `find` calls asked the sandbox the same kind of question twice,
 * on every preview publish, including for a static site that has neither
 * directory. The per-group limits are kept rather than merged into a single
 * find: a project with fifty cloud functions must not push its agent routes
 * past the cut and skip the gate that covers them.
 */
const ROUTE_LISTING_COMMAND = [
  `find ${CLOUD_FUNCTION_DIRECTORIES.join(' ')} -type f 2>/dev/null | head -50`,
  'find agents -type f 2>/dev/null | head -50',
  'true',
].join('\n');

/**
 * Both functional gates for a generated preview, cheapest first: a route that
 * 500s fails before the chat probe spends a model call on the same server.
 *
 * A project with nothing to probe leaves after the listing. That is most static
 * sites, and it is why neither gate needs a project-shape flag passed in from
 * outside — the routes a project declares are the shape.
 */
async function assertGeneratedRoutesReady(context: any, state: ProjectState) {
  const listing = await runSandboxCommand(
    context,
    ROUTE_LISTING_COMMAND,
    { cwd: state.appDir, timeout: 10 },
  );
  const { functionRoutes, agentRoutes } = generatedRoutesFromListing(listing.stdout || '');
  if (functionRoutes.length === 0 && !agentRoutes.has('/chat')) return;

  await assertGeneratedApiRoutesReady(context, state, functionRoutes);
  await assertGeneratedAgentChatReady(context, state, agentRoutes);
}

/** The probeable routes of both kinds, read off one combined listing. */
export function generatedRoutesFromListing(stdout: string) {
  const semantics = stdout
    .split('\n')
    .map((line) => line.trim().replace(/^\.\//, ''))
    .filter(Boolean)
    .map((path) => makersFileSemantic({ path, type: 'file' }));

  const functionRoutes = [...new Set(
    semantics
      .filter((semantic) => semantic?.capability === 'cloud-function'
        || semantic?.capability === 'edge-function')
      .map((semantic) => semantic?.route)
      // Dynamic and catch-all routes have no probeable form: there is no id to
      // invent for /api/:id, and a wildcard says nothing about what is mounted.
      .filter((route): route is string => typeof route === 'string'
        && route.length > 0
        && !route.includes(':')
        && !route.includes('*')),
  )];

  return { functionRoutes, agentRoutes: agentRoutesFromListing(stdout) };
}

function smokeFailure(exitCode: number | undefined, detail: string, guidance: string) {
  if (exitCode === SMOKE_EXIT.application) {
    return new GeneratedChatSmokeError(`${detail}\n${guidance}`, 'application');
  }
  if (exitCode === SMOKE_EXIT.route) {
    return new GeneratedChatSmokeError(
      `${detail}\nmakers dev is being restarted so it can mount the route again. If it is still unmounted after that, the cause is in the project rather than the server: check that every package the agent code imports is installed, and that edgeone.json declares the framework the code actually uses.`,
      'route',
    );
  }
  return new GeneratedChatSmokeError(detail, 'transport');
}

/**
 * Probe the routes the generated project actually declares. Cloud functions get
 * no other functional gate: assertPreviewServerReady only proves the proxy and
 * the home page answer, so without this a project whose API throws on every
 * request still publishes a preview that looks fine until the user clicks.
 */
async function assertGeneratedApiRoutesReady(
  context: any,
  state: ProjectState,
  routes: string[],
) {
  if (routes.length === 0) return;

  const smoke = await runSandboxCommand(
    context,
    buildGeneratedApiSmokeScript({
      baseUrl: `http://127.0.0.1:${PREVIEW_SERVER_PORT}${PREVIEW_PATH_PREFIX}`.replace(/\/$/, ''),
      routes,
    }),
    { cwd: state.appDir, timeout: GENERATED_API_SMOKE.commandTimeoutSeconds },
  );
  if (smoke.exitCode === 0) return;

  throw smokeFailure(
    smoke.exitCode,
    smoke.stderr || smoke.stdout || 'Generated API route smoke test failed.',
    "The preview server itself is healthy: the route answered with a server error or never answered at all, so fix the generated function. Only 5xx and hangs are treated as failures — 401, 403, 404 and 405 all pass. Do not probe external gateways or runtime internals.",
  );
}

/**
 * The routes a project's agent files mount, read off a `find agents` listing.
 *
 * Resolved through the same helper the file panel and the cloud-function probe
 * use, rather than by guessing filenames: `agents/chat.ts` and
 * `agents/chat/index.ts` are both valid entry forms, and the gate below used to
 * look only for the first. A project written in the directory form skipped the
 * gate outright — its preview published as healthy while POST /chat fell
 * through to index.html, which is the exact failure the gate exists to catch.
 */
export function agentRoutesFromListing(stdout: string) {
  return new Set(
    stdout
      .split('\n')
      .map((line) => line.trim().replace(/^\.\//, ''))
      .filter(Boolean)
      .map((path) => makersFileSemantic({ path, type: 'file' }))
      .filter((semantic) => semantic?.capability === 'agent')
      .map((semantic) => semantic?.route)
      .filter((route): route is string => typeof route === 'string' && route.length > 0),
  );
}

async function assertGeneratedAgentChatReady(
  context: any,
  state: ProjectState,
  routes: Set<string>,
) {
  // Only /chat. The probe costs a real model call and sends a chat payload, so
  // pointing it at every agent route would both multiply that cost and fail a
  // correct project: a sibling route like /stop answers no SSE by design.
  if (!routes.has('/chat')) return;

  const endpoint = `http://127.0.0.1:${PREVIEW_SERVER_PORT}${PREVIEW_PATH_PREFIX}chat`;
  // One shape, and the one a chat UI sends. Sending `message` and `messages`
  // together covered both conventions, but it is a body no client produces —
  // and a handler that reads the two of them wrongly passed on it anyway. A
  // measured project branched on `messages` being present and then took the
  // content from `message`, which lines up only when both arrive: the probe
  // came back a clean 200 stream, and every message a user typed came back 400.
  const payload = JSON.stringify({
    messages: [{ role: 'user', content: 'Reply with OK.' }],
  });
  // Fresh per probe: a fixed id accumulates history in the generated app's own
  // store, so every later probe pays for a longer prompt and gets a less
  // predictable reply to assert on.
  const smokeConversationId = `preview-smoke-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const smoke = await runSandboxCommand(
    context,
    buildGeneratedChatSmokeScript({
      endpoint,
      payload,
      conversationId: smokeConversationId,
    }),
    { cwd: state.appDir, timeout: GENERATED_CHAT_SMOKE.commandTimeoutSeconds },
  );
  if (smoke.exitCode === 0) return;

  let detail = smoke.stderr || smoke.stdout || 'Generated /chat endpoint smoke test failed.';
  // Only for an unmounted route: for a reply that arrived and was wrong, the
  // reply itself is the evidence and the server log has nothing to add.
  if (smoke.exitCode === SMOKE_EXIT.route) {
    const log = await readMakersDevLog(context);
    if (log) detail = `${detail}\n--- makers dev log ---\n${log}`;
  }
  throw smokeFailure(
    smoke.exitCode,
    detail,
    "The preview server itself is healthy: fix the generated agent's response, and makers dev will pick it up on save. Restarting the dev server will not change this. Do not probe external gateways or runtime internals.",
  );
}

/**
 * What makers dev said while it was building the agent worker.
 *
 * The launcher surfaces this log only when the server never comes up, so a
 * server that starts and then fails to mount a route discards the one account
 * of why — an import it cannot resolve, a framework that is not installed. At
 * the point the route gate fails, that account is the whole answer.
 */
async function readMakersDevLog(context: any) {
  try {
    const result = await runSandboxCommand(
      context,
      `tail -n 40 ${shellQuote(MAKERS_DEV_LOG_PATH)} 2>/dev/null || true`,
      { timeout: 10 },
    );
    return (result.stdout || '').trim();
  } catch {
    // Diagnostics only. The route verdict above already stands on its own.
    return '';
  }
}

export async function publishRunningPreview(
  context: any,
  state: ProjectState,
  options: { routesAlreadyVerified?: boolean } = {},
) {
  await assertPreviewServerReady(context);
  // The chat probe is a real model call against the generated agent, so skip the
  // whole gate when startPreviewServer just ran it.
  if (!options.routesAlreadyVerified) {
    await assertGeneratedRoutesReady(context, state);
  }
  const links = await resolvePublicLinks(context);
  if (!links.previewUrl) {
    throw new Error(`Makers dev is ready, but the sandbox did not return a public URL for port ${PREVIEW_PUBLIC_PORT}.`);
  }
  state.previewUrl = links.previewUrl;
  state.sandboxDebugUrl = links.sandboxDebugUrl;
  state.previewKind = 'sandbox';
  state.previewPublished = true;
  return {
    url: links.previewUrl,
    sandboxDebugUrl: links.sandboxDebugUrl,
    kind: 'sandbox' as const,
  };
}

export async function assertPreviewServerReady(
  context: any,
  readyPath = PREVIEW_PATH_PREFIX,
) {
  const result = await runCommandCapturingExit(
    context,
    probePreviewReadyCommand(readyPath),
    { timeout: 10 },
  );

  if (result.exitCode !== 0) {
    throw new Error(`Preview server is not ready on port ${PREVIEW_SERVER_PORT}${readyPath}.`);
  }
}

function probePreviewReadyCommand(readyPath = PREVIEW_PATH_PREFIX) {
  return [
    'set +e',
    `curl --noproxy '*' -fsS ${shellQuote(`http://127.0.0.1:${PREVIEW_SERVER_PORT}/__edgeone_preview_proxy_health`)} >/dev/null \\`,
    `  && curl --noproxy '*' -fsS ${shellQuote(`http://127.0.0.1:${PREVIEW_SERVER_PORT}${readyPath}`)} >/dev/null`,
    'echo EXIT:$?',
  ].join('\n');
}
