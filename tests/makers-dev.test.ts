import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  MAKERS_DEV_APP_ERROR_EXIT,
  MAKERS_DEV_LAUNCH_TIMEOUT_SECONDS,
  MAKERS_DEV_LOG_PATH,
  MAKERS_DEV_PID_PATH,
  MAKERS_DEV_PORT_DRIFT_EXIT,
  MAKERS_DEV_READY_POLL_SECONDS,
  buildMakersDevBackgroundCommand,
  buildMakersDevLaunchCommand,
  buildMakersDevStopScript,
  buildPreviewProxyScript,
  parseMakersDevExitCode,
  previewCanonicalRedirect,
  previewPrefixProbe,
  previewProxyRevision,
  previewRestoredUrl,
  previewTrailingSlashFollow,
  previewUpstreamClaimsPrefix,
  rewritePreviewProxyPath,
} from '../shared/makers-dev.ts';
import {
  MAKERS_DEV_PORT,
  PREVIEW_ASSET_PREFIX_ENV,
  PREVIEW_PATH_PREFIX,
  PREVIEW_PUBLIC_PORT,
  PREVIEW_SERVER_PORT,
} from '../agents/_constants.ts';

test('rewrites the public preview prefix onto Makers dev root paths', () => {
  assert.equal(rewritePreviewProxyPath('/preview/'), '/');
  assert.equal(rewritePreviewProxyPath('/preview'), '/');
  assert.equal(rewritePreviewProxyPath('/preview/api/hello'), '/api/hello');
  assert.equal(rewritePreviewProxyPath('/preview/?q=1'), '/?q=1');
  assert.equal(rewritePreviewProxyPath('/preview?q=1'), '/?q=1');
  assert.equal(rewritePreviewProxyPath('/api/hello'), '/api/hello');
});

// Without the trailing slash the browser resolves every relative URL on the
// page against the host root, which the gateway does not publish: stylesheets,
// scripts, and API calls all 404 at once, and the page looks like it silently
// stopped working.
test('the preview root keeps its trailing slash, and its access token', () => {
  assert.equal(previewCanonicalRedirect('/preview'), '/preview/');
  assert.equal(
    previewCanonicalRedirect('/preview?access_token=abc'),
    '/preview/?access_token=abc',
  );
  // Already canonical, or not the prefix root at all: nothing to redirect.
  assert.equal(previewCanonicalRedirect('/preview/'), undefined);
  assert.equal(previewCanonicalRedirect('/preview/api/hello'), undefined);
  assert.equal(previewCanonicalRedirect('/previewing'), undefined);
  assert.equal(previewCanonicalRedirect('/api/hello'), undefined);
  assert.equal(previewCanonicalRedirect('/preview', '/'), undefined);

  const script = buildPreviewProxyScript(
    PREVIEW_SERVER_PORT,
    MAKERS_DEV_PORT,
    PREVIEW_PATH_PREFIX,
  );
  assert.match(script, /canonicalRedirect/);
  assert.match(script, /writeHead\(308/);
});

test('makers-dev launch is non-interactive and does not pass a token flag', () => {
  const command = buildMakersDevLaunchCommand(MAKERS_DEV_PORT, 'vibe-coding-playground');
  assert.match(command, new RegExp(`edgeone makers dev --port ${MAKERS_DEV_PORT}`));
  assert.match(command, /--skip-env-sync/);
  assert.match(command, /--name 'vibe-coding-playground'/);
  assert.doesNotMatch(command, / -t /);
  assert.doesNotMatch(command, /makers deploy/);
});

test('preview topology keeps CLI, path adapter, and public gateway separate', () => {
  assert.equal(MAKERS_DEV_PORT, 8088);
  assert.equal(PREVIEW_SERVER_PORT, 3000);
  assert.equal(PREVIEW_PUBLIC_PORT, 9000);
  assert.equal(PREVIEW_PATH_PREFIX, '/preview/');
});

test('preview proxy strips the prefix and forwards HTTP and WebSocket upgrades', () => {
  const script = buildPreviewProxyScript(
    PREVIEW_SERVER_PORT,
    MAKERS_DEV_PORT,
    PREVIEW_PATH_PREFIX,
  );
  assert.match(script, /LISTEN_PORT = 3000/);
  assert.match(script, /TARGET_PORT = 8088/);
  assert.match(script, /server\.on\('upgrade'/);
  assert.match(script, /function rewritePath/);
  assert.match(script, /x-edgeone-preview-proxy/);
  assert.doesNotThrow(() => new Function(script));
});

// makers dev forwards to its function runtime through http-proxy with xfwd,
// which appends to x-forwarded-proto instead of replacing it. Passing the
// gateway's value through makes the runtime build "http,http://host/path",
// throw ERR_INVALID_URL, and then fail again inside its own error handler, so
// no response is ever written: the preview hangs while a direct curl (which
// sends no such header) still answers 200.
test('the preview proxy does not forward the gateway x-forwarded-proto', () => {
  const script = buildPreviewProxyScript(
    PREVIEW_SERVER_PORT,
    MAKERS_DEV_PORT,
    PREVIEW_PATH_PREFIX,
  );
  assert.match(script, /delete headers\['x-forwarded-proto'\]/);
  // Both the HTTP and the WebSocket upgrade path have to be sanitized.
  assert.equal(script.match(/const headers = forwardHeaders\(req\);/g)?.length, 2);
  assert.doesNotThrow(() => new Function(script));
});

// Nothing else notices a stale proxy: it passes every health probe while still
// mangling requests, and the warm path reuses it because it is healthy. Without
// this the fix above would never reach a sandbox that is already running one.
test('a preview proxy from an older agent is replaced rather than reused', () => {
  const revision = previewProxyRevision(
    PREVIEW_SERVER_PORT,
    MAKERS_DEV_PORT,
    PREVIEW_PATH_PREFIX,
  );
  const script = buildPreviewProxyScript(
    PREVIEW_SERVER_PORT,
    MAKERS_DEV_PORT,
    PREVIEW_PATH_PREFIX,
  );
  assert.match(script, new RegExp(`'x-edgeone-preview-proxy': '${revision}'`));

  const command = buildMakersDevBackgroundCommand({
    makersPort: MAKERS_DEV_PORT,
    previewPort: PREVIEW_SERVER_PORT,
    previewPath: PREVIEW_PATH_PREFIX,
    projectName: 'vibe-coding-playground',
    assetPrefixEnvName: PREVIEW_ASSET_PREFIX_ENV,
  });
  assert.match(command, new RegExp(`x-edgeone-preview-proxy: ${revision}`));

  // The revision has to follow the script, or the check passes on a proxy the
  // agent would no longer write.
  const changed = previewProxyRevision(PREVIEW_SERVER_PORT, MAKERS_DEV_PORT, '/other');
  assert.notEqual(changed, revision);
});

test('makers-dev runs behind the prefix-stripping preview proxy', () => {
  const command = buildMakersDevBackgroundCommand({
    makersPort: MAKERS_DEV_PORT,
    previewPort: PREVIEW_SERVER_PORT,
    previewPath: PREVIEW_PATH_PREFIX,
    projectName: 'vibe-coding-playground',
    assetPrefixEnvName: PREVIEW_ASSET_PREFIX_ENV,
  });
  assert.match(command, new RegExp(`nohup edgeone makers dev --port ${MAKERS_DEV_PORT}`));
  assert.match(command, /edgeone-preview-proxy\.cjs/);
  assert.match(
    command,
    new RegExp(`http://127\\.0\\.0\\.1:${PREVIEW_SERVER_PORT}/preview/`),
  );
  assert.match(command, /MAKERS_DEV_READY=started/);
  assert.match(command, /MAKERS_DEV_EXIT:\$dev_status/);
  assert.match(command, /exit 0/);
});

// The shape a refresh actually lands on: the sandbox recycled the dev server
// but the proxy survived. Nothing here can be relied on to free that port —
// the image may ship neither fuser nor lsof — so a second proxy loses the bind
// and dies. The exit accounting then reads a dead proxy as a failed start and
// kills the dev server that had just come up, which is how a refresh turns a
// recoverable preview into an empty panel.
test('a surviving preview proxy is reused instead of replaced', () => {
  const command = buildMakersDevBackgroundCommand({
    makersPort: MAKERS_DEV_PORT,
    previewPort: PREVIEW_SERVER_PORT,
    previewPath: PREVIEW_PATH_PREFIX,
    projectName: 'vibe-coding-playground',
    assetPrefixEnvName: PREVIEW_ASSET_PREFIX_ENV,
  });

  // The application port is always cleared; the preview port only when the
  // proxy on it is not the one about to be reused.
  assert.match(command, /^stop_makers_dev$/m);
  assert.match(
    command,
    new RegExp(`^if \\[ "\\$reuse_proxy" -ne 1 \\]; then free_port ${PREVIEW_SERVER_PORT}; fi$`, 'm'),
  );
  assert.match(command, /^if \[ "\$reuse_proxy" -ne 1 \]; then$\n\s+nohup node /m);

  // A proxy this run never started leaves an empty pid, and both the readiness
  // loop and the exit accounting have to skip it: kill -0 on an empty pid fails,
  // which would report the same false failure the reuse is there to avoid.
  assert.match(command, /\[ -n "\$proxy_pid" \] && ! kill -0 "\$proxy_pid"/);
  assert.doesNotMatch(command, /^\s*if ! kill -0 "\$proxy_pid"/m);
});

// Next.js writes its asset URLs as root-absolute /_next/... paths, and the
// gateway publishes nothing above the prefix, so without this the stylesheets
// and client chunks 404 while the HTML still answers 200 — a preview that looks
// like a styling bug and passes every existing gate.
test('makers-dev is told the prefix its framework must put in front of assets', () => {
  const command = buildMakersDevBackgroundCommand({
    makersPort: MAKERS_DEV_PORT,
    previewPort: PREVIEW_SERVER_PORT,
    previewPath: PREVIEW_PATH_PREFIX,
    projectName: 'vibe-coding-playground',
    assetPrefixEnvName: PREVIEW_ASSET_PREFIX_ENV,
  });

  // On the launch line itself, so the CLI and the framework it spawns inherit
  // it. Exported anywhere else and makers dev would never see it.
  assert.match(
    command,
    new RegExp(`${PREVIEW_ASSET_PREFIX_ENV}='/preview' nohup edgeone makers dev`),
  );
  // No trailing slash: assetPrefix is concatenated with /_next/..., so /preview/
  // would resolve assets at //_next and miss the gateway route entirely.
  assert.doesNotMatch(command, new RegExp(`${PREVIEW_ASSET_PREFIX_ENV}='/preview/'`));
});

// A Next.js turn started makers-dev 88 seconds after the template landed, while
// the warmup was still writing node_modules. The CLI's own proxy then spent the
// whole readiness budget connecting to a Next child that was never spawned —
// reported as a preview timeout, recovered only because the next command
// happened to wait for the warmup for a different reason.
test('makers-dev drains the npm warmup before it starts the framework', () => {
  const command = buildMakersDevBackgroundCommand({
    makersPort: MAKERS_DEV_PORT,
    previewPort: PREVIEW_SERVER_PORT,
    previewPath: PREVIEW_PATH_PREFIX,
    projectName: 'vibe-coding-playground',
    assetPrefixEnvName: PREVIEW_ASSET_PREFIX_ENV,
  });

  const alreadyRunning = command.indexOf('MAKERS_DEV_READY=already-running');
  const wait = command.indexOf('__warmup_pid');
  const launch = command.indexOf('nohup edgeone makers dev');
  assert.ok(wait !== -1, 'the warmup is never waited for');
  // A preview that is already answering must not stall on an unrelated install.
  assert.ok(alreadyRunning !== -1 && alreadyRunning < wait, 'reuse must not wait');
  assert.ok(wait < launch, 'the framework must not start while the warmup is writing');
});

/**
 * The two numbers drifted apart once, and a launch cannot survive it: the outer
 * timeout was raised to four minutes for a first-run install while the poll
 * inside it still gave up at ninety seconds, so the launch went on failing at
 * ninety with three quarters of its budget unspent. Whichever is smaller
 * decides, and it has to be the poll — that is the one that can report why.
 */
test('the readiness poll fits inside the launch timeout it is spent under', () => {
  assert.ok(
    MAKERS_DEV_READY_POLL_SECONDS < MAKERS_DEV_LAUNCH_TIMEOUT_SECONDS,
    'the poll outlasts its own timeout, so the launcher is killed before it can report',
  );

  const command = buildMakersDevBackgroundCommand({
    makersPort: MAKERS_DEV_PORT,
    previewPort: PREVIEW_SERVER_PORT,
    previewPath: PREVIEW_PATH_PREFIX,
    projectName: 'vibe-coding-playground',
    assetPrefixEnvName: PREVIEW_ASSET_PREFIX_ENV,
  });

  // The budget the script actually polls with, rather than a second copy of it.
  assert.match(command, new RegExp(`seq 1 ${MAKERS_DEV_READY_POLL_SECONDS}\\b`));
  // A first launch creates the project, pulls its env, and then waits on the
  // CLI's own observability install; a real session was killed at 98 seconds.
  assert.ok(
    MAKERS_DEV_READY_POLL_SECONDS >= 180,
    'a first-ever launch does not fit in the poll',
  );
});

// The launch that cannot be recovered by launching again. A dev server left on
// the application port does not make the CLI fail — it takes the next port,
// reports itself ready there, and leaves the proxy polling a port nothing will
// answer. Relaunching hits the same holder and drifts the same way, so a run
// obeying the restart rule spent two 90-second timeouts on it.
test('the previous dev server is killed by recorded pid, not by a port tool', () => {
  const command = buildMakersDevBackgroundCommand({
    makersPort: MAKERS_DEV_PORT,
    previewPort: PREVIEW_SERVER_PORT,
    previewPath: PREVIEW_PATH_PREFIX,
    projectName: 'vibe-coding-playground',
    assetPrefixEnvName: PREVIEW_ASSET_PREFIX_ENV,
  });

  // The pid is the only handle that works on an image with neither fuser nor
  // lsof, which is the image this failed on.
  assert.match(command, new RegExp(`cat '${MAKERS_DEV_PID_PATH}'`));
  assert.match(command, /kill -TERM "\$stop_pid"/);
  assert.match(command, /pkill -TERM -P "\$stop_pid"/);
  // And it has to happen after the already-running fast path, or a healthy
  // preview would be torn down and rebuilt on every launch request.
  assert.ok(
    command.indexOf('MAKERS_DEV_READY=already-running') < command.indexOf('stop_makers_dev'),
    'the reuse check must come before the teardown',
  );

  // Writing the pid is what makes the next launch able to do any of this.
  assert.match(command, new RegExp(`echo "\\$dev_pid" > '${MAKERS_DEV_PID_PATH}'`));
});

test('a drifted port is reported as itself instead of as a slow start', () => {
  const command = buildMakersDevBackgroundCommand({
    makersPort: MAKERS_DEV_PORT,
    previewPort: PREVIEW_SERVER_PORT,
    previewPath: PREVIEW_PATH_PREFIX,
    projectName: 'vibe-coding-playground',
    assetPrefixEnvName: PREVIEW_ASSET_PREFIX_ENV,
  });

  // Read from the CLI's own announcement. Next's port appears in that log too,
  // on a "- Local:" line, and must not be mistaken for the CLI's.
  assert.match(command, /grep -o 'Running at: http:\/\/localhost:\[0-9\]\*'/);
  assert.doesNotMatch(command, /Local: http/);
  // Breaking out of the poll is the point: every remaining second is spent
  // waiting on a port the server never bound.
  assert.match(
    command,
    new RegExp(`if \\[ -n "\\$bound_port" \\] && \\[ "\\$bound_port" != "${MAKERS_DEV_PORT}" \\]; then break; fi`),
  );
  assert.match(command, new RegExp(`MAKERS_DEV_EXIT:${MAKERS_DEV_PORT_DRIFT_EXIT}`));
  // Distinct from the readiness timeout and from the band the proxy's own exit
  // status folds into, so the caller can tell the two apart. Widened past the
  // literal type on purpose: the point is to fail if the value ever moves.
  const drift: number = MAKERS_DEV_PORT_DRIFT_EXIT;
  assert.ok(drift !== 124 && (drift < 125 || drift > 129), `${drift} collides`);
});

// A React Router page imported `defer`, which v7 removed. The dev server came
// up and threw that on every request, and the poll spent its full ninety
// seconds rediscovering it once a second — then reported all eighty copies, so
// the one fact that mattered arrived buried in its own repetitions.
test('a dev server that throws on every request ends the poll instead of timing out', () => {
  const command = buildMakersDevBackgroundCommand({
    makersPort: MAKERS_DEV_PORT,
    previewPort: PREVIEW_SERVER_PORT,
    previewPath: PREVIEW_PATH_PREFIX,
    projectName: 'vibe-coding-playground',
    assetPrefixEnvName: PREVIEW_ASSET_PREFIX_ENV,
  });

  // Counted inside the loop and acted on after it, the same shape the drifted
  // port uses: the poll cannot succeed, so stop paying for it.
  assert.match(command, /app_errors=\$\(grep -cE /);
  assert.match(command, /if \[ "\$\{app_errors:-0\}" -ge \d+ \]; then break; fi/);
  assert.match(command, new RegExp(`MAKERS_DEV_EXIT:${MAKERS_DEV_APP_ERROR_EXIT}`));

  // Same reasoning as the drift code: the caller tells "it answered wrong" from
  // "nothing answered" by the number alone.
  const appError: number = MAKERS_DEV_APP_ERROR_EXIT;
  assert.ok(
    appError !== 124
      && appError !== MAKERS_DEV_PORT_DRIFT_EXIT
      && (appError < 125 || appError > 129),
    `${appError} collides`,
  );
});

// The report is worth as much as its signal-to-noise, and the raw log's is
// near zero: one cause, repeated once per poll, each copy carrying a different
// timestamp so nothing collapses on its own.
test('the repeated throw is reported as its distinct causes', async () => {
  const command = buildMakersDevBackgroundCommand({
    makersPort: MAKERS_DEV_PORT,
    previewPort: PREVIEW_SERVER_PORT,
    previewPath: PREVIEW_PATH_PREFIX,
    projectName: 'vibe-coding-playground',
    assetPrefixEnvName: PREVIEW_ASSET_PREFIX_ENV,
  });

  // Run the pipeline the launcher actually ships rather than a copy of it, so
  // this fails if the shipped one stops deduplicating.
  const pipeline = command
    .split('\n')
    .find((line) => line.includes("awk '!seen[$0]++'"));
  assert.ok(pipeline, 'the error report no longer deduplicates');

  const dir = await mkdtemp(path.join(tmpdir(), 'makers-dev-errors-'));
  try {
    const logPath = path.join(dir, 'makers-dev.log');
    const thrown = "[vite] Internal server error: [vite] The requested module "
      + "'react-router' does not provide an export named 'defer'";
    await writeFile(
      logPath,
      [
        'Running at: http://localhost:8088',
        // Thirty seconds of the same throw, timestamped the way Vite writes it.
        ...Array.from({ length: 30 }, (_, i) => `11:56:${23 + i} AM ${thrown}`),
        '      at analyzeImportedModDifference (file:///app/node_modules/vite/dist/x.js:459:36)',
        'Error: No route matches URL "/preview/favicon.ico"',
      ].join('\n') + '\n',
    );

    const reported = await runShell(
      pipeline.trim().replace(new RegExp(MAKERS_DEV_LOG_PATH, 'g'), logPath),
    );
    const lines = reported.split('\n').filter(Boolean);

    // Thirty-one matching lines, two causes. Both survive: a project can be
    // broken in more than one way, and hiding the second only buys a re-run.
    assert.equal(lines.length, 2);
    assert.ok(lines[0].endsWith(thrown.slice(-40)), lines[0]);
    assert.match(lines[1], /No route matches URL/);
    // The timestamp is what kept the copies distinct, so it has to be gone.
    assert.doesNotMatch(reported, /11:56:/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The counter must not fire on a server that recovers. Vite can throw once
// while it optimizes deps, and the readiness check at the top of the loop is
// what protects that case — but only while the threshold stays above the
// number of throws a recovering server produces.
test('one transient throw does not end the poll', async () => {
  const command = buildMakersDevBackgroundCommand({
    makersPort: MAKERS_DEV_PORT,
    previewPort: PREVIEW_SERVER_PORT,
    previewPath: PREVIEW_PATH_PREFIX,
    projectName: 'vibe-coding-playground',
    assetPrefixEnvName: PREVIEW_ASSET_PREFIX_ENV,
  });
  const threshold = Number(
    /-ge (\d+) \]; then break; fi/.exec(command)?.[1],
  );
  assert.ok(threshold >= 3, `${threshold} is too eager`);

  const counter = command
    .split('\n')
    .find((line) => line.includes('app_errors=$(grep -cE '));
  assert.ok(counter);

  const dir = await mkdtemp(path.join(tmpdir(), 'makers-dev-transient-'));
  try {
    const logPath = path.join(dir, 'makers-dev.log');
    await writeFile(
      logPath,
      [
        'Pre-transform error: Failed to load url /@react-refresh',
        '11:56:23 AM [vite] Internal server error: dep optimization stumbled',
        '11:56:24 AM [vite] ✨ new dependencies optimized: react-router',
        'Running at: http://localhost:8088',
      ].join('\n') + '\n',
    );
    const count = await runShell(
      `${counter.trim().replace(new RegExp(MAKERS_DEV_LOG_PATH, 'g'), logPath)}
echo "$app_errors"`,
    );
    assert.ok(Number(count.trim()) < threshold, `counted ${count.trim()}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function runShell(script: string) {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn('sh', ['-c', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    // The report writes to stderr, the counter echoes to stdout.
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { out += chunk.toString(); });
    child.on('error', reject);
    child.on('exit', () => resolve(out));
  });
}

// A build or an install that runs beside the dev server loses to it over .next
// and node_modules, and the loss names neither: the build reported a Pages
// Router page the project did not have, and npm reported ENOTEMPTY renaming a
// package the server held open.
test('stopping the dev server can announce itself to whoever asked', () => {
  const silent = buildMakersDevStopScript(MAKERS_DEV_PORT);
  const announced = buildMakersDevStopScript(MAKERS_DEV_PORT, 'the preview was stopped');

  assert.match(announced, /stop_announce='the preview was stopped'/);
  assert.match(announced, /if \[ -n "\$stop_announce" \]; then echo "\$stop_announce" >&2; fi/);
  // Only when a recorded server was actually signalled: a build with no preview
  // running must not claim to have stopped one.
  assert.ok(
    announced.indexOf('kill -TERM "$stop_pid"') < announced.indexOf('echo "$stop_announce"'),
  );
  assert.match(silent, /stop_announce=''/);
});

// The deployed site is at /, so `href="/"` and `fetch('/api/x')` are the code
// the project should contain — and the one form the preview cannot serve, since
// the gateway forwards nothing but the prefix. A root-absolute link therefore
// left the application for the sandbox's own page, which answers 200 and reads
// as the project having rendered nothing at all.
test('a root-absolute in-app URL is put back inside the prefix', () => {
  const page = 'https://sandbox.example.com/preview/about';

  assert.equal(
    previewRestoredUrl('/', page),
    'https://sandbox.example.com/preview/',
  );
  assert.equal(
    previewRestoredUrl('/api/ping', page),
    'https://sandbox.example.com/preview/api/ping',
  );
  // Already inside, so nothing to do: this is every relative link, and
  // rewriting one would prefix it twice.
  assert.equal(previewRestoredUrl('.', page), undefined);
  assert.equal(previewRestoredUrl('ssr', page), undefined);
  assert.equal(previewRestoredUrl('/preview/ssr', page), undefined);
  // Not this application's URL to touch.
  assert.equal(previewRestoredUrl('https://example.com/', page), undefined);
  assert.equal(previewRestoredUrl('mailto:a@b.c', page), undefined);
  assert.equal(previewRestoredUrl('javascript:void 0', page), undefined);
  assert.equal(previewRestoredUrl('', page), undefined);
  // No prefix to restore means no rewriting at all.
  assert.equal(previewRestoredUrl('/', page, '/'), undefined);
});

// Relative links keep working untouched, and the one that used to be a silent
// trap now recovers: a route carries no trailing slash, so a page one level
// deep is already at the application root and `..` climbs out of the prefix
// onto the sandbox's own page. Getting that count right per page was the rule
// this replaced.
test('a relative link is left alone unless it climbed out of the application', () => {
  const deep = 'https://sandbox.example.com/preview/blog/post-1';

  // Correct for its depth: resolves inside the prefix, nothing to restore.
  assert.equal(new URL('..', deep).pathname, '/preview/');
  assert.equal(previewRestoredUrl('..', deep), undefined);
  assert.equal(previewRestoredUrl('other', deep), undefined);

  // One step too many. This is the shape that reads as working, because the
  // home page has nothing to climb and keeps behaving.
  const shallow = 'https://sandbox.example.com/preview/about';
  assert.equal(new URL('..', shallow).pathname, '/');
  assert.equal(
    previewRestoredUrl('..', shallow),
    'https://sandbox.example.com/preview/',
  );
});

// Preview opens with the token in the query string and no in-app URL carries a
// query of its own, so the first navigation dropped it and everything after
// went out unauthenticated — failing only on the pages reached through a link.
test('the access token is carried onto in-app URLs that lack one', () => {
  const page = 'https://sandbox.example.com/preview/?access_token=sit_abc';

  assert.equal(
    previewRestoredUrl('/ssr', page, '/preview', 'sit_abc'),
    'https://sandbox.example.com/preview/ssr?access_token=sit_abc',
  );
  // A relative link needs no prefixing but still needs the token, so "already
  // inside" cannot short-circuit the whole function.
  assert.equal(
    previewRestoredUrl('ssr', page, '/preview', 'sit_abc'),
    'https://sandbox.example.com/preview/ssr?access_token=sit_abc',
  );
  // One the project set itself is left alone.
  assert.equal(
    previewRestoredUrl('ssr?access_token=other', page, '/preview', 'sit_abc'),
    undefined,
  );
});

/**
 * Run the script the proxy actually injects, against a fake browser.
 *
 * The shim is a copy of previewRestoredUrl, written in the string the proxy
 * splices into <head>, and a copy is only as good as what stops it drifting.
 * So this drives the real injected source rather than asserting on its text.
 */
function runInjectedShim(href: string, topLevel = false) {
  const script = buildPreviewProxyScript(
    PREVIEW_SERVER_PORT,
    MAKERS_DEV_PORT,
    PREVIEW_PATH_PREFIX,
  );
  const expression = /const TRACKER = ([\s\S]*?<\/script>';)/.exec(script);
  assert.ok(expression, 'the injected script should still be built as TRACKER');
  // Bound because the expression below is the proxy's own source, which builds
  // the tracker string out of its PREFIX constant at request time.
  const PREFIX = '/preview';
  const tracker = eval(expression[1]) as string;
  const source = tracker.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '');

  const store = new Map<string, string>();
  const listeners = new Map<string, { handler: (event: unknown) => void; capture: unknown }>();
  const fetched: string[] = [];
  const assigned: string[] = [];
  const pushed: unknown[] = [];
  const url = new URL(href);
  const location = {
    href,
    search: url.search,
    pathname: url.pathname,
    hash: url.hash,
    assign: (value: string) => assigned.push(value),
  };
  const window: Record<string, unknown> = {
    fetch: (input: unknown) => {
      fetched.push(String(input));
      return Promise.resolve();
    },
    XMLHttpRequest: undefined,
  };
  // The tracker reports to a parent frame and returns early without one. The
  // navigation fix must not: the user opens this link in a real tab too, which
  // is the case that produced the sandbox's own page instead of the project.
  window.parent = topLevel ? window : { postMessage: () => {} };

  const history = {
    pushState: (_state: unknown, _title: unknown, url: unknown) => pushed.push(url),
    replaceState: (_state: unknown, _title: unknown, url: unknown) => pushed.push(url),
  };

  new Function(
    'window', 'location', 'sessionStorage', 'addEventListener', 'history',
    source,
  )(
    window,
    location,
    {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
    },
    (type: string, handler: (event: unknown) => void, capture: unknown) =>
      listeners.set(type, { handler, capture }),
    history,
  );

  return {
    fetched,
    assigned,
    pushed,
    listeners,
    pushState: (url: string) => history.pushState(null, '', url),
    // Read back off the fake window, which is where the shim installed its
    // wrapper: calling it is the only way to exercise the real replacement.
    fetch: (input: string) => (window.fetch as (value: unknown) => unknown)(input),
    click(
      anchorHref: string,
      attributes: Record<string, string> = {},
      defaultPrevented = false,
    ) {
      let prevented = false;
      listeners.get('click')?.handler({
        button: 0,
        defaultPrevented,
        preventDefault: () => { prevented = true; },
        target: {
          closest: () => ({
            getAttribute: (name: string) =>
              (name === 'href' ? anchorHref : attributes[name] ?? null),
            hasAttribute: (name: string) => name in attributes,
            target: attributes.target,
          }),
        },
      });
      return prevented;
    },
  };
}

test('the injected shim reaches the same verdict as the function it mirrors', () => {
  const shim = runInjectedShim('https://sandbox.example.com/preview/about?access_token=sit_abc');

  assert.equal(shim.click('/'), true);
  assert.deepEqual(shim.assigned, ['https://sandbox.example.com/preview/?access_token=sit_abc']);

  // A link that is already correct must fall through to the browser, or the
  // shim becomes the thing that handles every navigation in the preview.
  assert.equal(shim.click('/preview/about?access_token=sit_abc'), false);
  assert.equal(shim.click('https://example.com/'), false);
  // Opening in a new tab or downloading is not this shim's navigation.
  assert.equal(shim.click('/', { target: '_blank' }), false);
  assert.equal(shim.click('/', { download: '' }), false);
  assert.equal(shim.assigned.length, 1);
});

// The shim has to lose to a client router, or it converts that router's
// navigations into full document loads — and a SPA with no server-side routes
// answers those with a 404 on a path the router was handling fine.
test('the navigation fix runs in a directly opened tab, not only in the iframe', () => {
  const shim = runInjectedShim('https://sandbox.example.com/preview/about', true);

  assert.equal(shim.click('/'), true);
  assert.deepEqual(shim.assigned, ['https://sandbox.example.com/preview/']);
});

test('a link a client router has already claimed is left to it', () => {
  const shim = runInjectedShim('https://sandbox.example.com/preview/about');

  assert.equal(shim.listeners.get('click')?.capture, false);
  assert.equal(shim.click('/ssr', {}, true), false);
  assert.deepEqual(shim.assigned, []);
});

// The other half of that router: it pushes the path it believes it is on, which
// is outside the prefix. Nothing looks wrong — the app renders from its own
// state — until a reload asks the sandbox host for a path it does not publish.
test('a client route pushed to the address bar is kept inside the prefix', () => {
  const shim = runInjectedShim('https://sandbox.example.com/preview/?access_token=sit_abc');

  shim.pushState('/ssr');
  shim.pushState('ssr');

  assert.deepEqual(shim.pushed, [
    'https://sandbox.example.com/preview/ssr?access_token=sit_abc',
    'https://sandbox.example.com/preview/ssr?access_token=sit_abc',
  ]);
});

test('the injected shim prefixes a root-absolute fetch before it leaves', () => {
  const shim = runInjectedShim('https://sandbox.example.com/preview/about?access_token=sit_abc');

  shim.fetch('/api/ping');
  shim.fetch('api/ping');
  shim.fetch('https://example.com/api/ping');

  assert.deepEqual(shim.fetched, [
    // Restored into the prefix, and given the token the page was opened with.
    'https://sandbox.example.com/preview/api/ping?access_token=sit_abc',
    // Already inside the prefix, so only the token is added.
    'https://sandbox.example.com/preview/api/ping?access_token=sit_abc',
    // Someone else's origin, passed through exactly as written.
    'https://example.com/api/ping',
  ]);
});

// Measured against the sandbox that produced the report: every asset answered
// 200 under the prefix and 404 at the root, because the gateway publishes
// nothing above it. Vite has no asset-only prefix knob — `base` moves the
// served paths too, so with it set the stripped path is answered with a
// redirect back into the base and the assets exist only under it.
test('an upstream that asks for the prefix stops having it stripped', () => {
  const prefix = PREVIEW_PATH_PREFIX;

  assert.equal(previewUpstreamClaimsPrefix(302, '/preview/', prefix), true);
  assert.equal(previewUpstreamClaimsPrefix(301, '/preview', prefix), true);
  // Absolute forms carry the same claim.
  assert.equal(
    previewUpstreamClaimsPrefix(302, 'http://127.0.0.1:3000/preview/', prefix),
    true,
  );
  // A redirect anywhere else is the application's own business.
  assert.equal(previewUpstreamClaimsPrefix(302, '/login', prefix), false);
  assert.equal(previewUpstreamClaimsPrefix(302, '/previewer/', prefix), false);
  // And a redirect is the only thing that carries it.
  assert.equal(previewUpstreamClaimsPrefix(200, '/preview/', prefix), false);
  assert.equal(previewUpstreamClaimsPrefix(302, undefined, prefix), false);
  assert.equal(previewUpstreamClaimsPrefix(302, '/preview/', '/'), false);
});

// The same claim without a redirect to carry it. Astro mounted at `base` treats
// the stripped path as a route it does not have, so the launch that produced
// this spent its whole budget polling a server that was up and answering 404.
test('a 404 on the stripped path asks whether the prefixed one exists', () => {
  const prefix = PREVIEW_PATH_PREFIX;

  assert.equal(previewPrefixProbe('/preview/', '/', 404, prefix), '/preview/');
  // The query carries the sandbox access token, so it is re-asked intact.
  assert.equal(
    previewPrefixProbe('/preview/blog?access_token=x', '/blog?access_token=x', 404, prefix),
    '/preview/blog?access_token=x',
  );

  // Only a 404 raises the question — a redirect is previewUpstreamClaimsPrefix's
  // to answer, and anything else means the stripped path worked.
  assert.equal(previewPrefixProbe('/preview/', '/', 200, prefix), undefined);
  assert.equal(previewPrefixProbe('/preview/', '/', 302, prefix), undefined);
  assert.equal(previewPrefixProbe('/preview/', '/', 500, prefix), undefined);

  // Nothing was stripped, so re-asking would be the identical request.
  assert.equal(previewPrefixProbe('/elsewhere', '/elsewhere', 404, prefix), undefined);
  // And a path that never carried the prefix cannot be re-asked with it.
  assert.equal(previewPrefixProbe('/elsewhere', '/other', 404, prefix), undefined);
  assert.equal(previewPrefixProbe('/preview/', '/', 404, '/'), undefined);
});

/**
 * Run the real proxy script against an upstream that behaves like Vite with
 * `base` set, which is the case no framework config can fix.
 *
 * Spawned rather than asserted on as text: the retry has to actually happen,
 * and what makes it necessary is that passing the redirect on to the browser
 * would send back a path this proxy strips again — the same request, bouncing
 * until the browser gives up.
 */
async function withProxiedUpstream(
  handler: (url: string) => { status: number; body?: string; location?: string; type?: string },
  run: (proxyPort: number) => Promise<void>,
) {
  const seen: string[] = [];
  const upstream = createServer((req, res) => {
    const url = req.url || '/';
    seen.push(url);
    const reply = handler(url);
    res.writeHead(reply.status, {
      ...(reply.location ? { location: reply.location } : {}),
      ...(reply.body ? { 'content-type': reply.type || 'text/html' } : {}),
    });
    res.end(reply.body || '');
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = (upstream.address() as AddressInfo).port;

  // Port 0 lets the OS choose, so the test never collides with a real preview
  // — and the script does not announce its port, so the test asks for it.
  const script = `${buildPreviewProxyScript(0, upstreamPort, PREVIEW_PATH_PREFIX)}
server.on('listening', () => console.log('listening on ' + server.address().port));
`;
  const dir = await mkdtemp(path.join(tmpdir(), 'preview-proxy-'));
  const scriptPath = path.join(dir, 'proxy.cjs');
  await writeFile(scriptPath, script);

  const proxy = spawn(process.execPath, [scriptPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('proxy did not report a port')), 10_000);
      proxy.stdout.on('data', (chunk: Buffer) => {
        const match = /listening on (\d+)/.exec(chunk.toString());
        if (match) {
          clearTimeout(timer);
          resolve(Number(match[1]));
        }
      });
      proxy.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`proxy exited with ${code}`));
      });
    });
    await run(port);
  } finally {
    proxy.kill();
    upstream.close();
    await rm(dir, { recursive: true, force: true });
  }
  return seen;
}

const PREFIX = PREVIEW_PATH_PREFIX.replace(/\/$/, '');

/** Vite with `base` set: serves only under the base, redirects everything else. */
function viteWithBase(url: string) {
  if (url === PREFIX || url.startsWith(`${PREFIX}/`)) {
    return url.endsWith('.css')
      ? { status: 200, body: 'body{color:red}', type: 'text/css' }
      : { status: 200, body: '<html><head></head><body>ok</body></html>' };
  }
  if (url === '/' || url === '') return { status: 302, location: `${PREFIX}/` };
  return { status: 404, body: 'not found' };
}

/** makers dev, and every framework with an asset-only prefix knob: serves at /. */
function servedAtRoot(url: string) {
  if (url.startsWith(PREFIX)) return { status: 404, body: 'prefix was not stripped' };
  return url.endsWith('.css')
    ? { status: 200, body: 'body{color:blue}', type: 'text/css' }
    : { status: 200, body: '<html><head></head><body>root</body></html>' };
}

test('the proxy serves a Vite-style upstream that owns the prefix itself', async () => {
  const seen = await withProxiedUpstream(viteWithBase, async (port) => {
    const base = `http://127.0.0.1:${port}`;
    // The document. Stripped first, which the upstream answers with a redirect
    // into the base; the proxy retries unstripped rather than passing it on.
    const document = await fetch(`${base}${PREVIEW_PATH_PREFIX}`, { redirect: 'manual' });
    assert.equal(document.status, 200);
    assert.match(await document.text(), /ok/);

    // The asset that used to 404: reachable only under the prefix, and the
    // proxy no longer strips it away.
    const asset = await fetch(`${base}${PREVIEW_PATH_PREFIX}src/styles/app.css`);
    assert.equal(asset.status, 200);
    assert.equal(await asset.text(), 'body{color:red}');
  });

  // The stripped attempt happens once. After it, the prefix is left alone.
  assert.deepEqual(seen, ['/', `${PREFIX}/`, `${PREFIX}/src/styles/app.css`]);
});

// The path almost every project takes, and the one the retry must not disturb:
// an upstream serving at / never sends that redirect, so nothing flips.
test('an upstream serving at the root still has the prefix stripped', async () => {
  const seen = await withProxiedUpstream(servedAtRoot, async (port) => {
    const base = `http://127.0.0.1:${port}`;
    const document = await fetch(`${base}${PREVIEW_PATH_PREFIX}`);
    assert.equal(document.status, 200);
    assert.match(await document.text(), /root/);

    const asset = await fetch(`${base}${PREVIEW_PATH_PREFIX}assets/app.css`);
    assert.equal(asset.status, 200);
    assert.equal(await asset.text(), 'body{color:blue}');
  });

  assert.deepEqual(seen, ['/', '/assets/app.css']);
});

/** Astro with `base` set: serves under the base and 404s everything else. */
function astroWithBase(url: string) {
  if (url === PREFIX || url.startsWith(`${PREFIX}/`)) {
    return url.endsWith('.css')
      ? { status: 200, body: 'body{color:green}', type: 'text/css' }
      : { status: 200, body: '<html><head></head><body>astro</body></html>' };
  }
  return { status: 404, body: 'not found' };
}

/** Serves at the root and has no /missing: the 404 that must not flip anything. */
function servedAtRootWithGaps(url: string) {
  if (url.startsWith(PREFIX)) return { status: 404, body: 'prefix was not stripped' };
  if (url.startsWith('/missing')) return { status: 404, body: 'no such page' };
  return { status: 200, body: '<html><head></head><body>root</body></html>' };
}

// The failure this exists for: the runtime writes `base` into astro.config.mjs
// for the preview prefix, Astro then answers the stripped path with a 404
// rather than Vite's redirect, and the readiness poll times out against a
// server that is up. Nothing in the log named Astro, the base, or the proxy.
test('the proxy serves an upstream that claims the prefix with a 404', async () => {
  const seen = await withProxiedUpstream(astroWithBase, async (port) => {
    const base = `http://127.0.0.1:${port}`;
    const document = await fetch(`${base}${PREVIEW_PATH_PREFIX}`, { redirect: 'manual' });
    assert.equal(document.status, 200);
    assert.match(await document.text(), /astro/);

    const asset = await fetch(`${base}${PREVIEW_PATH_PREFIX}_astro/index.css`);
    assert.equal(asset.status, 200);
    assert.equal(await asset.text(), 'body{color:green}');
  });

  // Stripped once, probed once, and left alone from there.
  assert.deepEqual(seen, ['/', `${PREFIX}/`, `${PREFIX}/_astro/index.css`]);
});

// The other side of the same weaker signal: a 404 is what a missing page
// returns too, so the probe has to be able to come back empty-handed without
// leaving the proxy convinced of anything.
test('a genuinely missing page is probed once and changes nothing', async () => {
  const seen = await withProxiedUpstream(servedAtRootWithGaps, async (port) => {
    const base = `http://127.0.0.1:${port}`;
    const missing = await fetch(`${base}${PREVIEW_PATH_PREFIX}missing`);
    assert.equal(missing.status, 404);

    // Still stripping, because the probe was answered with a second 404.
    const page = await fetch(`${base}${PREVIEW_PATH_PREFIX}`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /root/);

    // And the question is not asked twice.
    const again = await fetch(`${base}${PREVIEW_PATH_PREFIX}missing/two`);
    assert.equal(again.status, 404);
  });

  assert.deepEqual(seen, ['/missing', `${PREFIX}/missing`, '/', '/missing/two']);
});

// Measured against the sandbox that produced the report: /preview/articles came
// back as the gateway's own loop page. Next drops a trailing slash before it
// matches a route, so it answers /articles/ with a 308 to /articles whether or
// not the route exists; the gateway reads the extension-less result as a
// directory and sends it back to /articles/. Passed on, the two trade the
// request until the gateway gives up and the project never renders.
test('a redirect that only normalizes a trailing slash is followed, not passed on', () => {
  // Both directions: the framework that drops the slash, and the one that adds
  // it. Either way the browser is being sent to the page it already asked for.
  assert.equal(previewTrailingSlashFollow('/articles/', 308, '/articles'), '/articles');
  assert.equal(previewTrailingSlashFollow('/articles', 308, '/articles/'), '/articles/');
  // The query carries the sandbox access token, so the target is followed as
  // the upstream wrote it rather than rebuilt from the request.
  assert.equal(
    previewTrailingSlashFollow('/a/?access_token=x', 308, '/a?access_token=x'),
    '/a?access_token=x',
  );

  // Everything else stays a redirect the browser gets to see.
  assert.equal(previewTrailingSlashFollow('/articles/', 308, '/login'), undefined);
  assert.equal(previewTrailingSlashFollow('/articles/', 200, '/articles'), undefined);
  assert.equal(previewTrailingSlashFollow('/articles', 308, '/articles'), undefined);
  // An absolute target is a move off this server, which is the browser's to make.
  assert.equal(
    previewTrailingSlashFollow('/articles/', 308, 'https://example.com/articles'),
    undefined,
  );
  // '/' against '' is a move to the root, not a normalization.
  assert.equal(previewTrailingSlashFollow('/', 308, ''), undefined);
});

/** Next: a trailing slash is normalized away before any route is matched. */
function normalizesTrailingSlash(url: string) {
  const [path, query] = url.split('?');
  if (path.length > 1 && path.endsWith('/')) {
    return { status: 308, location: path.slice(0, -1) + (query ? `?${query}` : '') };
  }
  if (path.startsWith(PREFIX)) return { status: 404, body: 'prefix was not stripped' };
  return { status: 200, body: '<html><head></head><body>article</body></html>' };
}

test('the proxy settles the trailing slash instead of bouncing the browser', async () => {
  const seen = await withProxiedUpstream(normalizesTrailingSlash, async (port) => {
    const base = `http://127.0.0.1:${port}`;
    // What the gateway forwards once it has decided the path is a directory.
    const page = await fetch(`${base}${PREVIEW_PATH_PREFIX}articles/`, {
      redirect: 'manual',
    });
    // A 308 here is the loop: the gateway would put the slash straight back.
    assert.equal(page.status, 200);
    assert.match(await page.text(), /article/);
  });

  // Followed inside the proxy, and only once.
  assert.deepEqual(seen, ['/articles/', '/articles']);
});

test('makers-dev captured exit markers preserve CLI failures', () => {
  assert.equal(parseMakersDevExitCode('log\nMAKERS_DEV_EXIT:127\n'), 127);
  assert.equal(parseMakersDevExitCode('MAKERS_DEV_EXIT:0\n'), 0);
  assert.equal(parseMakersDevExitCode('no marker'), undefined);
});

test('sandbox preview publishes the fixed gateway path through a local adapter', async () => {
  const preview = await readFile('agents/project/_preview.ts', 'utf8');
  assert.doesNotMatch(preview, /ensureEdgeoneCli|npm install -g edgeone/);
  assert.match(preview, /buildMakersDevLaunchCommand/);
  assert.match(preview, /buildMakersDevBackgroundCommand/);
  assert.match(preview, /getHost\(PREVIEW_PUBLIC_PORT\)/);
  assert.match(
    preview,
    /127\.0\.0\.1:\$\{PREVIEW_SERVER_PORT\}\$\{PREVIEW_PATH_PREFIX\}chat/,
  );
  assert.match(preview, /proxyPath: PREVIEW_PATH_PREFIX/);
  assert.doesNotMatch(preview, /makers deploy/);
});
