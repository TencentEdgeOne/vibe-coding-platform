/**
 * Runtime-agnostic helpers for sandbox preview via the preinstalled Makers CLI.
 *
 * The sandbox gateway only publishes :9000/preview/, forwarding that path to
 * :3000. Makers dev serves the deploy-equivalent application at / on :8088, so
 * a small proxy on :3000 strips /preview before forwarding HTTP and WebSockets.
 */

import { createHash } from 'node:crypto';

import { buildNpmWarmupWaitScript } from './npm-install.ts';
import { shellQuote } from './shell.ts';

export const PREVIEW_PROXY_SCRIPT_PATH = '/tmp/edgeone-preview-proxy.cjs';

/** Where the launcher records the dev server, so a later build can stop it. */
export const MAKERS_DEV_PID_PATH = '/tmp/makers-dev.pid';

/**
 * Where the dev server's own output goes.
 *
 * The launcher tails this only when the server fails to come up, which leaves
 * nothing for the failure that comes later: a server that starts fine and then
 * cannot mount a route writes its reason here and nowhere else. The route gate
 * reads it at the moment that reason is the whole answer.
 */
export const MAKERS_DEV_LOG_PATH = '/tmp/makers-dev.log';

/**
 * The CLI came up on a port other than the one it was asked for.
 *
 * Chosen well clear of 124 (the readiness timeout) and the 125..129 band the
 * proxy's own exit folds into, so the caller can tell a drifted port from a
 * server that simply never answered. The two need different advice: this one
 * is recoverable by launching again, now that the launcher clears the port.
 */
export const MAKERS_DEV_PORT_DRIFT_EXIT = 60;

/**
 * The dev server is up and throws the same error on every request.
 *
 * Distinct from 124 because the two mean opposite things to the caller: 124 is
 * "nothing answered yet, maybe it needs longer", this one is "it answered, and
 * it will answer the same way for every second of the poll that is left". Only
 * the project's own code can clear it, so a relaunch is the wrong move.
 */
export const MAKERS_DEV_APP_ERROR_EXIT = 61;

/**
 * Lines that mean a request reached the app and the app threw.
 *
 * Deliberately narrow. Anything matched here ends the poll early, so a pattern
 * that also matches startup chatter would turn a slow boot into a failure. The
 * two shapes below are what a request-time throw looks like on the Vite-based
 * templates and on the frameworks that log a bare `Error:` with a stack; a
 * server whose error is worded differently just falls through to the ordinary
 * timeout, which is what happens today.
 */
const MAKERS_DEV_APP_ERROR_PATTERN = 'Internal server error|^Error: ';

/**
 * How many such lines end the poll.
 *
 * Each iteration makes one request through the proxy, so a throw on every
 * request writes roughly one line per second and this is a five-second floor.
 * It is a floor and not a trigger on the first line because Vite can throw once
 * while it optimizes deps and recover — and a server that recovers passes the
 * readiness check at the top of the loop before this is ever consulted.
 */
const MAKERS_DEV_APP_ERROR_THRESHOLD = 5;

/**
 * How long the launcher waits for the proxy and the dev server to both answer.
 *
 * Ninety seconds, which this used to be, covers every launch that reuses an
 * already-linked project, and falls short of what the first one needs. A first
 * launch
 * creates the project remotely, links it, pulls environment variables and KV
 * bindings, writes .env, boots the framework, boots the agent-node worker, and
 * only then does the CLI run its own `Installing observability dependencies`.
 * That install starts after this poll is already counting, so no amount of
 * waiting for the host's warmup beforehand covers it — a real session spent 98
 * seconds here and was killed mid-install, then came up in 8 seconds on the
 * retry that found all of it done.
 *
 * Affordable because the poll does not spend this budget on a project that is
 * actually broken: a dead dev process, a drifted port and a route that throws on
 * every request each break out of the loop within seconds of being detectable.
 * What is left to spend it on is a launch that is merely slow, which is the case
 * this number exists for.
 */
export const MAKERS_DEV_READY_POLL_SECONDS = 200;

/**
 * Host-side budget for one makers-dev launch.
 *
 * Derived rather than written down, because the two drifted once already: the
 * outer number was raised to four minutes while the poll inside it still gave
 * up at ninety seconds, so the launch that motivated the raise went on failing
 * at the same moment it always had. The headroom is for what happens after the
 * poll gives up — tailing the log and signalling the processes — not for more
 * waiting.
 */
export const MAKERS_DEV_LAUNCH_TIMEOUT_SECONDS = MAKERS_DEV_READY_POLL_SECONDS + 40;

/**
 * Stop the framework dev server, for a command that is about to build in the
 * same directory.
 *
 * `next build` and `next dev` share .next, and the build loses that race: it
 * writes a manifest, the dev server rewrites the directory underneath it, and
 * the build then fails copying a file that no longer exists. Nothing about the
 * failure points at the dev server — it surfaces as a bare ENOENT on whichever
 * file happened to lose — so this runs unconditionally rather than in response
 * to anything.
 *
 * Two ways of finding it, because neither is reliable alone: the recorded PID
 * misses a framework server that outlived the CLI which spawned it, and the
 * port misses nothing but depends on tools the image may not ship. Only the
 * first works on an image with neither fuser nor lsof, which is why the pid is
 * recorded on every launch rather than only before a deploy.
 *
 * `announce` is printed when a recorded server was actually signalled, for
 * callers whose own output is all the model will read.
 */
export function buildMakersDevStopScript(makersPort: number, announce = '') {
  return [
    `stop_announce=${shellQuote(announce)}`,
    'stop_makers_dev() {',
    `  if [ -f ${shellQuote(MAKERS_DEV_PID_PATH)} ]; then`,
    `    stop_pid=$(cat ${shellQuote(MAKERS_DEV_PID_PATH)} 2>/dev/null)`,
    '    if [ -n "$stop_pid" ]; then',
    '      if command -v pkill >/dev/null 2>&1; then',
    '        pkill -TERM -P "$stop_pid" >/dev/null 2>&1 || true',
    '      fi',
    '      kill -TERM "$stop_pid" >/dev/null 2>&1 || true',
    // Said out loud because the caller is usually a build or an install the
    // model issued, and a preview that stopped without a word is a preview it
    // goes on describing as running.
    '      if [ -n "$stop_announce" ]; then echo "$stop_announce" >&2; fi',
    '    fi',
    `    rm -f ${shellQuote(MAKERS_DEV_PID_PATH)}`,
    '  fi',
    '  if command -v fuser >/dev/null 2>&1; then',
    `    fuser -k ${makersPort}/tcp >/dev/null 2>&1 || true`,
    '  elif command -v lsof >/dev/null 2>&1; then',
    `    lsof -ti tcp:${makersPort} | xargs kill -TERM >/dev/null 2>&1 || true`,
    '  fi',
    // A dev server that has stopped answering can still be flushing into .next,
    // and starting the build in that window loses the race it just avoided.
    '  for _ in 1 2 3 4 5; do',
    `    curl --noproxy '*' -fsS -o /dev/null http://127.0.0.1:${makersPort}/ >/dev/null 2>&1 || break`,
    '    sleep 1',
    '  done',
    '  sleep 1',
    '}',
    'stop_makers_dev',
  ].join('\n');
}

const PROXY_REVISION_PLACEHOLDER = '__PREVIEW_PROXY_REVISION__';

function normalizePreviewPrefix(value: string) {
  const normalized = `/${value}`.replace(/\/+/g, '/').replace(/\/+$/, '');
  return normalized === '/' ? '' : normalized;
}

export function rewritePreviewProxyPath(url: string | undefined, prefix = '/preview') {
  if (!url) return '/';
  const normalizedPrefix = normalizePreviewPrefix(prefix);
  if (!normalizedPrefix) return url;
  if (
    url === normalizedPrefix
    || url.startsWith(`${normalizedPrefix}/`)
    || url.startsWith(`${normalizedPrefix}?`)
  ) {
    const next = url.slice(normalizedPrefix.length);
    if (!next || next === '/') return '/';
    return next.startsWith('/') ? next : `/${next}`;
  }
  return url;
}

/**
 * Whether the upstream just said it serves the application under the prefix.
 *
 * Some frameworks have no asset-only prefix knob. Vite's `base` is the whole of
 * what it offers, and it moves the served paths along with the asset URLs — set
 * it and a request for the stripped path is answered with a redirect back into
 * the base, while every asset exists only under it. Leave it unset and the
 * assets are emitted root-absolute, which the gateway does not publish, so a
 * stylesheet 404s while the document still answers 200.
 *
 * That redirect is the signal. An upstream that sends one is asking to be
 * addressed with the prefix, so the proxy stops stripping for the rest of its
 * life and both halves line up: the framework emits prefixed URLs and receives
 * prefixed requests.
 */
export function previewUpstreamClaimsPrefix(
  statusCode: number | undefined,
  location: unknown,
  prefix = '/preview',
) {
  const normalizedPrefix = normalizePreviewPrefix(prefix);
  if (!normalizedPrefix) return false;
  if (!statusCode || statusCode < 300 || statusCode >= 400) return false;
  if (typeof location !== 'string' || !location) return false;
  // The header may be absolute or relative, and only its path matters here.
  let path = location;
  const schemeEnd = location.indexOf('://');
  if (schemeEnd !== -1) {
    const afterHost = location.indexOf('/', schemeEnd + 3);
    path = afterHost === -1 ? '/' : location.slice(afterHost);
  } else if (!location.startsWith('/')) {
    return false;
  }
  path = path.split('?')[0];
  return path === normalizedPrefix || path.startsWith(`${normalizedPrefix}/`);
}

/**
 * The same claim as above, from a framework that states it with a 404.
 *
 * `previewUpstreamClaimsPrefix` reads a redirect, which is what Vite sends. It
 * is not what every framework sends: Astro with `base` set treats a request
 * outside the base as a route it does not have and answers 404, so nothing in
 * the response points at the base at all. The two behaviours are identical in
 * intent and only the status separates them.
 *
 * That gap is not hypothetical. The runtime writes `base` into astro.config.mjs
 * for the preview prefix, so it is self-inflicted and it lands on every Astro
 * project: the readiness poll asks for the prefix, the proxy strips it, Astro
 * 404s on the root, and the launch spends its whole budget polling a server
 * that is up and answering — reported as a preview that never came up.
 *
 * A 404 is weaker evidence than a redirect, though, because it is also what a
 * genuinely missing page returns. So this only proposes the retry; what settles
 * it is the retry's own status. Anything but a second 404 means the prefixed
 * path is a route the upstream knows and the stripped one was not, and the
 * proxy stops stripping. Two 404s mean the page is simply absent, the second
 * answer is served, and nothing is remembered.
 *
 * Returns the path to re-request, or undefined when this is not that case —
 * including when nothing was stripped, where the retry would be the same
 * request a second time.
 */
export function previewPrefixProbe(
  requestUrl: string | undefined,
  forwardedPath: string | undefined,
  statusCode: number | undefined,
  prefix = '/preview',
) {
  const normalizedPrefix = normalizePreviewPrefix(prefix);
  if (!normalizedPrefix || !requestUrl || !forwardedPath) return undefined;
  if (statusCode !== 404) return undefined;
  if (forwardedPath === requestUrl) return undefined;
  const path = requestUrl.split('?')[0];
  if (path !== normalizedPrefix && !path.startsWith(`${normalizedPrefix}/`)) return undefined;
  return requestUrl;
}

/**
 * The path to re-request when the upstream's redirect only adds or removes a
 * trailing slash, or undefined when the redirect says anything else.
 *
 * Next normalizes a trailing slash away before it matches a route, so it
 * answers /articles/ with a 308 to /articles whether or not that route exists.
 * The gateway in front of this proxy does the opposite to an extension-less
 * path, reading it as a directory and sending it to the slash form. Passed on,
 * the two undo each other: the browser bounces between /preview/articles and
 * /preview/articles/ until the gateway gives up and serves its own loop page,
 * and the project never renders at all.
 *
 * Neither side is wrong on its own, so the proxy settles it instead of picking
 * a winner — it follows the normalization itself and answers with the result,
 * which takes the redirect off the wire and leaves the browser on the URL it
 * asked for. Same reasoning as the prefix retry: a redirect whose target this
 * proxy will only send back is not one the browser can make progress on.
 *
 * Everything else is left alone, so a project's own redirects() and an auth
 * bounce still reach the browser as redirects.
 */
export function previewTrailingSlashFollow(
  forwardedPath: string | undefined,
  statusCode: number | undefined,
  location: unknown,
) {
  if (!forwardedPath) return undefined;
  if (!statusCode || statusCode < 300 || statusCode >= 400) return undefined;
  // Only a same-origin path. An absolute URL is a move off this server, which
  // is the browser's to make even when the paths happen to line up.
  if (typeof location !== 'string' || !location.startsWith('/')) return undefined;
  const from = forwardedPath.split('?')[0];
  const to = location.split('?')[0];
  if (from === to) return undefined;
  return withoutTrailingSlash(from) === withoutTrailingSlash(to) ? location : undefined;
}

// '/' keeps its slash: against '' it is a move to the root, not a normalization.
function withoutTrailingSlash(value: string) {
  return value.length > 1 && value.endsWith('/') ? value.slice(0, -1) : value;
}

/**
 * Redirect target that puts the trailing slash back on the prefix root, or
 * undefined when the request is already canonical.
 *
 * Served at /preview the application looks fine, but the browser now treats
 * the host root as the base for every relative URL on the page: stylesheets,
 * scripts, and API calls all resolve one level too high and the gateway, which
 * publishes nothing outside the prefix, answers none of them. The query string
 * has to survive the redirect because it carries the sandbox access token.
 */
export function previewCanonicalRedirect(url: string | undefined, prefix = '/preview') {
  const normalizedPrefix = normalizePreviewPrefix(prefix);
  if (!normalizedPrefix || !url) return undefined;
  const queryStart = url.indexOf('?');
  const path = queryStart === -1 ? url : url.slice(0, queryStart);
  if (path !== normalizedPrefix) return undefined;
  return `${normalizedPrefix}/${queryStart === -1 ? '' : url.slice(queryStart)}`;
}

/**
 * Where an in-app URL has to point for the preview to reach it.
 *
 * The deployed site lives at /, so `href="/"` and `fetch('/api/x')` are the
 * correct code — and in preview they are the one form that cannot work: the
 * gateway forwards nothing but the prefix, so a root-absolute path leaves the
 * application and lands on the sandbox's own page, which answers 200 and looks
 * like the project rendered nothing. Restoring the prefix here is the same
 * decision `rewriteLocation` already makes for redirects, moved to the two
 * places a browser goes without asking the server first.
 *
 * The token is carried for the same reason: preview opens with it in the query
 * string and no in-app URL has a query of its own, so the first navigation used
 * to drop it and every later request went out unauthenticated.
 *
 * Returns undefined when the URL is already correct, which is most of them.
 */
export function previewRestoredUrl(
  rawUrl: string,
  pageUrl: string,
  prefix = '/preview',
  token = '',
) {
  const normalizedPrefix = normalizePreviewPrefix(prefix);
  if (!rawUrl || !normalizedPrefix) return undefined;
  let target: URL;
  let page: URL;
  try {
    page = new URL(pageUrl);
    target = new URL(rawUrl, pageUrl);
  } catch {
    return undefined;
  }
  // Another origin is not this application's to rewrite, and a scheme like
  // mailto: or javascript: has no path to prefix in the first place.
  if (target.origin !== page.origin || !/^https?:$/.test(target.protocol)) {
    return undefined;
  }
  const inside = target.pathname === normalizedPrefix
    || target.pathname.startsWith(`${normalizedPrefix}/`);
  const needsToken = Boolean(token) && !target.searchParams.has('access_token');
  if (inside && !needsToken) return undefined;
  if (!inside) target.pathname = `${normalizedPrefix}${target.pathname}`;
  if (needsToken) target.searchParams.set('access_token', token);
  return target.toString();
}

export function buildMakersDevLaunchCommand(port: number, projectName: string) {
  return `edgeone makers dev --port ${port} --skip-env-sync --name ${shellQuote(projectName)}`;
}

export function buildPreviewProxyScript(
  listenPort: number,
  targetPort: number,
  prefix = '/preview',
) {
  return buildPreviewProxy(listenPort, targetPort, prefix).script;
}

/**
 * Content hash the running proxy reports on its health endpoint.
 *
 * A proxy that is merely alive is not necessarily the proxy this agent would
 * write: it can predate a fix and still answer every health probe, and the warm
 * path reuses it precisely because it is healthy. Comparing revisions is what
 * makes a change to the script above reach sandboxes that are already running.
 */
export function previewProxyRevision(
  listenPort: number,
  targetPort: number,
  prefix = '/preview',
) {
  return buildPreviewProxy(listenPort, targetPort, prefix).revision;
}

function buildPreviewProxy(listenPort: number, targetPort: number, prefix: string) {
  const template = buildPreviewProxyTemplate(listenPort, targetPort, prefix);
  const revision = createHash('sha256').update(template).digest('hex').slice(0, 12);
  return { script: template.replace(PROXY_REVISION_PLACEHOLDER, revision), revision };
}

function buildPreviewProxyTemplate(
  listenPort: number,
  targetPort: number,
  prefix: string,
) {
  const normalizedPrefix = normalizePreviewPrefix(prefix);
  return `const http = require('node:http');
const net = require('node:net');

const LISTEN_PORT = ${listenPort};
const TARGET_PORT = ${targetPort};
const PREFIX = ${JSON.stringify(normalizedPrefix)};
const HEALTH_PATH = '/__edgeone_preview_proxy_health';

// Set once the upstream asks to be addressed with the prefix — see
// previewUpstreamClaimsPrefix in shared/makers-dev.ts. Until then the prefix is
// stripped, which is what makers dev and every framework with an asset-only
// prefix knob expect.
let prefixAware = false;

// The 404-shaped form of the same claim, tried once per proxy — see
// previewPrefixProbe. Once, because an upstream that really does serve at the
// root answers a genuinely missing page with a 404 too, and re-asking on every
// one of those would double the requests to re-learn what the first probe
// already established.
let prefixProbed = false;

function rewritePath(url) {
  if (!url) return '/';
  if (prefixAware) return url;
  if (
    PREFIX
    && (url === PREFIX || url.startsWith(PREFIX + '/') || url.startsWith(PREFIX + '?'))
  ) {
    const next = url.slice(PREFIX.length);
    if (!next || next === '/') return '/';
    return next.startsWith('/') ? next : '/' + next;
  }
  return url;
}

// Mirrors previewCanonicalRedirect in shared/makers-dev.ts.
function canonicalRedirect(url) {
  if (!PREFIX || !url) return null;
  const queryStart = url.indexOf('?');
  const path = queryStart === -1 ? url : url.slice(0, queryStart);
  if (path !== PREFIX) return null;
  return PREFIX + '/' + (queryStart === -1 ? '' : url.slice(queryStart));
}

function rewriteLocation(value) {
  if (!PREFIX || typeof value !== 'string' || !value.startsWith('/')) return value;
  if (value === PREFIX || value.startsWith(PREFIX + '/')) return value;
  return PREFIX + value;
}

// Mirrors previewUpstreamClaimsPrefix in shared/makers-dev.ts.
function claimsPrefix(statusCode, location) {
  if (!PREFIX) return false;
  if (!statusCode || statusCode < 300 || statusCode >= 400) return false;
  if (typeof location !== 'string' || !location) return false;
  let path = location;
  const schemeEnd = location.indexOf('://');
  if (schemeEnd !== -1) {
    const afterHost = location.indexOf('/', schemeEnd + 3);
    path = afterHost === -1 ? '/' : location.slice(afterHost);
  } else if (location.charAt(0) !== '/') {
    return false;
  }
  path = path.split('?')[0];
  return path === PREFIX || path.indexOf(PREFIX + '/') === 0;
}

// Mirrors previewPrefixProbe in shared/makers-dev.ts.
function prefixProbe(requestUrl, forwardedPath, statusCode) {
  if (!PREFIX || !requestUrl || !forwardedPath) return null;
  if (statusCode !== 404) return null;
  if (forwardedPath === requestUrl) return null;
  const probePath = requestUrl.split('?')[0];
  if (probePath !== PREFIX && probePath.indexOf(PREFIX + '/') !== 0) return null;
  return requestUrl;
}

// Mirrors previewTrailingSlashFollow in shared/makers-dev.ts.
function trailingSlashFollow(forwardedPath, statusCode, location) {
  if (!forwardedPath) return null;
  if (!statusCode || statusCode < 300 || statusCode >= 400) return null;
  if (typeof location !== 'string' || location.charAt(0) !== '/') return null;
  const from = forwardedPath.split('?')[0];
  const to = location.split('?')[0];
  if (from === to) return null;
  return withoutTrailingSlash(from) === withoutTrailingSlash(to) ? location : null;
}

function withoutTrailingSlash(value) {
  return value.length > 1 && value.charAt(value.length - 1) === '/'
    ? value.slice(0, -1)
    : value;
}

function rewriteSetCookie(value) {
  if (!PREFIX || typeof value !== 'string') return value;
  return value.replace(/;\\s*Path=\\//gi, '; Path=' + PREFIX + '/');
}

// makers dev reaches its function runtime through http-proxy with xfwd
// enabled, and xfwd APPENDS to x-forwarded-proto rather than replacing it. A
// value from the sandbox gateway therefore arrives at the runtime as
// "http,http", which it concatenates into a request URL and hands to new
// Request(): ERR_INVALID_URL. The failure is then swallowed by an error
// handler that throws on its own, so nothing ever writes a response and the
// browser spins until the user gives up. Dropping the header here leaves xfwd
// setting the single value it would have set anyway, which is also what makes
// a direct curl to the CLI work today.
// The parent workspace frames this preview cross-origin, so it cannot read the
// iframe's location to fill its address bar. Nothing else can report the route
// either: makers dev serves the application, and a proxy is the only layer left
// that sees every document. This posts the real path — prefix included, which is
// what the parent strips for display and reuses when deep-linking a copied URL.
const TRACKER = '<script data-edgeone-preview-tracker>'
  + '(function(){'
  + 'if(window.parent===window)return;'
  + 'var last="";'
  + 'function report(){'
  + 'var path=location.pathname+location.search+location.hash;'
  + 'if(path===last)return;'
  + 'last=path;'
  + 'try{window.parent.postMessage({__edgeonePreviewPath:path},"*");}catch(e){}'
  + '}'
  // Client-side routing changes the URL without any event of its own.
  + 'function wrap(name){'
  + 'var original=history[name];'
  + 'if(typeof original!=="function")return;'
  + 'history[name]=function(){var r=original.apply(this,arguments);report();return r;};'
  + '}'
  + 'wrap("pushState");wrap("replaceState");'
  + 'addEventListener("popstate",report);'
  + 'addEventListener("hashchange",report);'
  + 'report();'
  + '})();'
  // Everything below restores what the prefix takes away, so the generated
  // project can be written the way the deployed site needs it. Mirrors
  // previewRestoredUrl in shared/makers-dev.ts; the tests pin both.
  + '(function(){'
  + 'var PREFIX=' + JSON.stringify(PREFIX) + ';'
  + 'if(!PREFIX)return;'
  + 'var KEY="__edgeone_preview_token";'
  + 'function token(){'
  + 'try{'
  + 'var found=new URLSearchParams(location.search).get("access_token");'
  + 'if(found){sessionStorage.setItem(KEY,found);return found;}'
  + 'return sessionStorage.getItem(KEY)||"";'
  + '}catch(e){return "";}'
  + '}'
  + 'function restore(raw){'
  + 'try{'
  + 'var page=new URL(location.href);'
  + 'var target=new URL(raw,location.href);'
  + 'if(target.origin!==page.origin)return null;'
  + 'if(!/^https?:$/.test(target.protocol))return null;'
  + 'var inside=target.pathname===PREFIX||target.pathname.indexOf(PREFIX+"/")===0;'
  + 'var t=token();'
  + 'var needsToken=!!t&&!target.searchParams.has("access_token");'
  + 'if(inside&&!needsToken)return null;'
  + 'if(!inside)target.pathname=PREFIX+target.pathname;'
  + 'if(needsToken)target.searchParams.set("access_token",t);'
  + 'return target.toString();'
  + '}catch(e){return null;}'
  + '}'
  // Bubble, not capture, and only if nothing has claimed the event. A client
  // router calls preventDefault on its own links, and hijacking those would
  // turn every in-app navigation into a full document load — which for a SPA
  // with no server-side routes is a 404 where the router had been working.
  // So this only rescues links the page left to the browser.
  + 'addEventListener("click",function(event){'
  + 'if(event.defaultPrevented||event.button!==0)return;'
  + 'if(event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;'
  + 'var anchor=event.target&&event.target.closest&&event.target.closest("a[href]");'
  + 'if(!anchor||anchor.target&&anchor.target!=="_self"||anchor.hasAttribute("download"))return;'
  + 'var fixed=restore(anchor.getAttribute("href"));'
  + 'if(!fixed)return;'
  + 'event.preventDefault();'
  + 'location.assign(fixed);'
  + '},false);'
  + 'addEventListener("submit",function(event){'
  + 'if(event.defaultPrevented)return;'
  + 'var form=event.target;'
  + 'if(!form||!form.getAttribute)return;'
  + 'var fixed=restore(form.getAttribute("action")||location.href);'
  + 'if(fixed)form.setAttribute("action",fixed);'
  + '},false);'
  // The other half of a client router: it pushes the path it believes it is on,
  // which is root-absolute and therefore outside the prefix. The app keeps
  // rendering from its own state, so nothing looks wrong until the reload that
  // asks the sandbox host for a path it does not publish.
  + 'function keepInside(name){'
  + 'var original=history[name];'
  + 'if(typeof original!=="function")return;'
  + 'history[name]=function(state,title,url){'
  + 'var args=[].slice.call(arguments);'
  + 'if(typeof url==="string"){'
  + 'var fixed=restore(url);'
  + 'if(fixed)args[2]=fixed;'
  + '}'
  + 'return original.apply(this,args);'
  + '};'
  + '}'
  + 'keepInside("pushState");keepInside("replaceState");'
  // Wrapped in <head> so this runs before app code can hold its own reference.
  + 'var nativeFetch=window.fetch;'
  + 'if(typeof nativeFetch==="function"){'
  + 'window.fetch=function(input,init){'
  + 'try{'
  + 'if(typeof input==="string"){'
  + 'var fixed=restore(input);'
  + 'if(fixed)input=fixed;'
  + '}else if(input&&typeof input.url==="string"){'
  + 'var fixedRequest=restore(input.url);'
  + 'if(fixedRequest)input=new Request(fixedRequest,input);'
  + '}'
  + '}catch(e){}'
  + 'return nativeFetch.call(this,input,init);'
  + '};'
  + '}'
  + 'var open=window.XMLHttpRequest&&window.XMLHttpRequest.prototype.open;'
  + 'if(typeof open==="function"){'
  + 'window.XMLHttpRequest.prototype.open=function(method,url){'
  + 'var args=[].slice.call(arguments);'
  + 'try{var fixed=restore(url);if(fixed)args[1]=fixed;}catch(e){}'
  + 'return open.apply(this,args);'
  + '};'
  + '}'
  + '})();'
  + '</script>';

// Scanned as latin1 so one character is one byte and the match offset can index
// the buffer directly.
//
// <head> is only the preferred landing place. A hand-written index.html may not
// have one, and the script above is now what makes in-app navigation work, so
// skipping those pages would leave exactly the simplest generated sites broken.
// The fallbacks stay below the doctype: above it the page drops into quirks
// mode, which changes how the whole document lays out.
function headInsertionPoint(buffer) {
  const text = buffer.toString('latin1');
  for (const pattern of [/<head[^>]*>/i, /<html[^>]*>/i, /<!doctype[^>]*>/i]) {
    const match = pattern.exec(text);
    if (match) return match.index + match[0].length;
  }
  return -1;
}

function acceptsHtml(req) {
  const accept = req.headers.accept;
  return typeof accept === 'string' && accept.includes('text/html');
}

function isHtmlResponse(headers) {
  const type = headers['content-type'];
  return typeof type === 'string' && type.toLowerCase().includes('text/html');
}

function forwardHeaders(req) {
  const headers = {
    ...req.headers,
    host: '127.0.0.1:' + TARGET_PORT,
    'x-forwarded-prefix': PREFIX,
  };
  delete headers['x-forwarded-proto'];
  // TRACKER can only be spliced into an unencoded body. Asking for identity on
  // navigations alone costs nothing on a loopback hop and leaves compression in
  // place for the assets, which are what the encoding is actually worth.
  if (acceptsHtml(req)) headers['accept-encoding'] = 'identity';
  return headers;
}

// Buffer only up to the opening <head>, then release and stream the rest
// untouched: a page that streams its body from a Suspense boundary has to keep
// arriving in pieces, and the shell carrying <head> is already in the first one.
function injectTracker(upstream, res) {
  const SCAN_LIMIT = 65536;
  let pending = [];
  let scanned = 0;
  let injected = false;

  function splice(buffer) {
    const at = headInsertionPoint(buffer);
    // No <head> to splice after. Prepending would land the script above the
    // doctype and drop the page into quirks mode, so leave the body alone and
    // let the address bar stay where it is.
    if (at === -1) {
      res.write(buffer);
      return;
    }
    res.write(buffer.subarray(0, at));
    res.write(TRACKER);
    res.write(buffer.subarray(at));
  }

  upstream.on('data', (chunk) => {
    if (injected) {
      res.write(chunk);
      return;
    }
    pending.push(chunk);
    scanned += chunk.length;
    const buffer = Buffer.concat(pending);
    if (headInsertionPoint(buffer) === -1 && scanned <= SCAN_LIMIT) return;
    injected = true;
    pending = [];
    splice(buffer);
  });
  upstream.on('end', () => {
    if (!injected && pending.length) splice(Buffer.concat(pending));
    res.end();
  });
  upstream.on('error', () => res.end());
}

const server = http.createServer((req, res) => {
  if ((req.url || '').split('?')[0] === HEALTH_PATH) {
    res.writeHead(200, {
      'content-type': 'text/plain',
      'x-edgeone-preview-proxy': '${PROXY_REVISION_PLACEHOLDER}',
    });
    res.end('ok');
    return;
  }

  const canonical = canonicalRedirect(req.url);
  if (canonical) {
    res.writeHead(308, { location: canonical });
    res.end();
    return;
  }

  forward(req, res, rewritePath(req.url), true, true, false);
});

function forward(req, res, path, mayRetry, mayFollow, probing) {
  const headers = forwardHeaders(req);
  const proxy = http.request({
    hostname: '127.0.0.1',
    port: TARGET_PORT,
    path,
    method: req.method,
    headers,
  }, (upstream) => {
    // The probe's answer, which is the half of previewPrefixProbe that decides.
    // Anything but a second 404 means the prefixed path is a route the upstream
    // knows, so it keeps the prefix from here on. Read before the branches
    // below so a probe answered with a redirect still counts as knowing it.
    if (probing && upstream.statusCode !== 404) prefixAware = true;
    // The one response that means the prefix should not have been stripped.
    // Retried rather than passed on, because handing the browser a redirect to
    // a path this proxy still strips is the same request again: it would bounce
    // between the two until the browser gave up.
    if (
      mayRetry
      && !prefixAware
      && (req.method === 'GET' || req.method === 'HEAD')
      && claimsPrefix(upstream.statusCode, upstream.headers.location)
    ) {
      prefixAware = true;
      upstream.resume();
      forward(req, res, req.url || '/', false, true, false);
      return;
    }
    // The same claim made as a 404, which is how Astro states it. Asked rather
    // than concluded: the retry's status is what tells a base-mounted app apart
    // from a page that is simply not there.
    if (
      mayRetry
      && !prefixAware
      && !prefixProbed
      && (req.method === 'GET' || req.method === 'HEAD')
      && prefixProbe(req.url, path, upstream.statusCode)
    ) {
      prefixProbed = true;
      upstream.resume();
      forward(req, res, req.url, false, true, true);
      return;
    }
    // A redirect that only normalizes a trailing slash, settled here for the
    // same reason — see previewTrailingSlashFollow. Once, and never from a
    // follow of its own: an upstream that keeps normalizing is a loop this
    // proxy would be holding open instead of the browser.
    if (mayFollow && (req.method === 'GET' || req.method === 'HEAD')) {
      const follow = trailingSlashFollow(
        path,
        upstream.statusCode,
        upstream.headers.location,
      );
      if (follow) {
        upstream.resume();
        forward(req, res, follow, false, false, false);
        return;
      }
    }
    const responseHeaders = { ...upstream.headers };
    if (responseHeaders.location) {
      responseHeaders.location = rewriteLocation(responseHeaders.location);
    }
    if (Array.isArray(responseHeaders['set-cookie'])) {
      responseHeaders['set-cookie'] = responseHeaders['set-cookie'].map(rewriteSetCookie);
    }
    const injectable = isHtmlResponse(responseHeaders)
      && !responseHeaders['content-encoding'];
    // The body grows by TRACKER, so the declared length no longer holds.
    // Dropping it hands the response to chunked encoding.
    if (injectable) delete responseHeaders['content-length'];
    res.writeHead(upstream.statusCode || 502, responseHeaders);
    if (injectable) injectTracker(upstream, res);
    else upstream.pipe(res);
  });
  proxy.on('error', () => {
    if (!res.headersSent) res.writeHead(502);
    res.end('preview proxy error');
  });
  // Neither a retry nor a follow has a body left to send: both are reached
  // only for a GET or a HEAD, and the request stream is already consumed.
  if (mayRetry) req.pipe(proxy);
  else proxy.end();
}

server.on('upgrade', (req, socket, head) => {
  const path = rewritePath(req.url);
  const headers = forwardHeaders(req);
  const target = net.connect(TARGET_PORT, '127.0.0.1', () => {
    const headerLines = Object.entries(headers).flatMap(([key, value]) => {
      if (value == null) return [];
      return [key + ': ' + (Array.isArray(value) ? value.join(', ') : value)];
    });
    target.write([
      (req.method || 'GET') + ' ' + path + ' HTTP/1.1',
      ...headerLines,
      '',
      '',
    ].join('\\r\\n'));
    if (head && head.length) target.write(head);
    target.pipe(socket);
    socket.pipe(target);
  });
  target.on('error', () => socket.destroy());
  socket.on('error', () => target.destroy());
});

server.listen(LISTEN_PORT, '0.0.0.0');
`;
}

export type MakersDevBackgroundOptions = {
  makersPort: number;
  previewPort: number;
  previewPath: string;
  projectName: string;
  /** Name only; the launcher owns the value, which is always the live prefix. */
  assetPrefixEnvName: string;
  forceRestart?: boolean;
};

export function buildMakersDevBackgroundCommand({
  makersPort,
  previewPort,
  previewPath,
  projectName,
  assetPrefixEnvName,
  forceRestart = false,
}: MakersDevBackgroundOptions) {
  const prefix = normalizePreviewPrefix(previewPath);
  const readyUrl = `http://127.0.0.1:${previewPort}${prefix}/`;
  const proxyHealthUrl = `http://127.0.0.1:${previewPort}/__edgeone_preview_proxy_health`;
  const launch = buildMakersDevLaunchCommand(makersPort, projectName);
  const proxyScript = buildPreviewProxyScript(previewPort, makersPort, prefix);
  const proxyRevision = previewProxyRevision(previewPort, makersPort, prefix);
  const writeProxyScript = `require('node:fs').writeFileSync(${
    JSON.stringify(PREVIEW_PROXY_SCRIPT_PATH)
  }, ${JSON.stringify(proxyScript)})`;
  return [
    'set +e',
    // Reuse only a proxy this agent would have written itself. An older one
    // answers every probe here while still mangling requests downstream.
    'preview_proxy_matches() {',
    '  rm -f /tmp/preview-proxy-health',
    `  curl --noproxy '*' -fsS -o /dev/null -D /tmp/preview-proxy-health \\`,
    `    ${shellQuote(proxyHealthUrl)} >/dev/null 2>&1 \\`,
    `    && grep -qi ${shellQuote(`x-edgeone-preview-proxy: ${proxyRevision}`)} \\`,
    '      /tmp/preview-proxy-health',
    '}',
    // fuser and lsof are the only way to name the holder of an arbitrary port,
    // and the image may ship neither, so every failure here is silenced. That
    // is survivable for the proxy port, which is why the proxy is reused rather
    // than replaced. The application port does not depend on this — see below.
    'free_port() {',
    '  if command -v fuser >/dev/null 2>&1; then fuser -k "$1/tcp" >/dev/null 2>&1 || true',
    '  elif command -v lsof >/dev/null 2>&1; then lsof -ti "tcp:$1" | xargs kill -9 >/dev/null 2>&1 || true',
    '  fi',
    '}',
    ...(!forceRestart ? [
      `if preview_proxy_matches && curl --noproxy '*' -fsS ${shellQuote(readyUrl)} >/dev/null 2>&1; then`,
      '  echo "MAKERS_DEV_READY=already-running"',
      '  echo "MAKERS_DEV_EXIT:0"',
      '  exit 0',
      'fi',
    ] : []),
    // The proxy is stateless and the revision proves it forwards the way this
    // agent expects, so a live one is kept even when the application behind it
    // has died. Starting a second one instead only wins the port when the first
    // is gone: otherwise it exits EADDRINUSE, and the failure accounting below
    // then tears down the application that had just come up healthy.
    'if preview_proxy_matches; then reuse_proxy=1; else reuse_proxy=0; fi',
    // The previous server has to be gone before the CLI starts, and this is the
    // one way to be sure of it: the launcher recorded that pid itself, so no
    // port-inspection tool has to exist for the kill to land. Leaving it alive
    // does not fail loudly — the CLI takes the next free port instead, comes up
    // healthy on it, and reports itself ready while the proxy goes on polling a
    // port nothing will ever answer. That is a launch which cannot be recovered
    // by launching again, because the second attempt is held by the same
    // process and drifts to the same wrong port.
    buildMakersDevStopScript(makersPort),
    `if [ "$reuse_proxy" -ne 1 ]; then free_port ${previewPort}; fi`,
    'sleep 1',
    // After the stop, not before: a healthy preview that is already answering
    // exits above without waiting. A launch that reaches here is about to
    // start the framework, and starting it against a node_modules the warmup
    // is still writing is the 90-second ECONNREFUSED that used to be reported
    // as a preview timeout.
    buildNpmWarmupWaitScript(),
    `if ! node -e ${shellQuote(writeProxyScript)}; then`,
    '  echo "Failed to write the preview proxy script." >&2',
    '  echo "MAKERS_DEV_EXIT:125"',
    '  exit 0',
    'fi',
    `rm -f ${shellQuote(MAKERS_DEV_LOG_PATH)} /tmp/preview-proxy.log`,
    // Exported into the CLI so a framework that emits its own asset URLs can
    // prefix them. Nothing downstream is required to read it: a project that
    // ignores it behaves exactly as before.
    `${assetPrefixEnvName}=${shellQuote(prefix)} nohup ${launch} > ${shellQuote(MAKERS_DEV_LOG_PATH)} 2>&1 &`,
    'dev_pid=$!',
    // Recorded so a later deploy can stop this server before building in the
    // same directory; nothing here reads it back.
    `echo "$dev_pid" > ${shellQuote(MAKERS_DEV_PID_PATH)}`,
    "proxy_pid=''",
    'if [ "$reuse_proxy" -ne 1 ]; then',
    `  nohup node ${shellQuote(PREVIEW_PROXY_SCRIPT_PATH)} > /tmp/preview-proxy.log 2>&1 &`,
    '  proxy_pid=$!',
    'fi',
    "bound_port=''",
    `for i in $(seq 1 ${MAKERS_DEV_READY_POLL_SECONDS}); do`,
    `  if curl --noproxy '*' -fsS ${shellQuote(proxyHealthUrl)} >/dev/null 2>&1 \\`,
    `    && curl --noproxy '*' -fsS ${shellQuote(readyUrl)} >/dev/null 2>&1; then`,
    '    echo "MAKERS_DEV_READY=started"',
    '    echo "MAKERS_DEV_EXIT:0"',
    '    exit 0',
    '  fi',
    '  if ! kill -0 "$dev_pid" >/dev/null 2>&1; then break; fi',
    '  if [ -n "$proxy_pid" ] && ! kill -0 "$proxy_pid" >/dev/null 2>&1; then break; fi',
    // The CLI announces the port it took. Reading it turns the one failure that
    // looks like a slow start into a fact, and stops the polling that cannot
    // succeed: on a drifted port every second of the poll below is spent
    // waiting for an answer from a port the server never bound.
    '  if [ -z "$bound_port" ]; then',
    `    bound_port=$(grep -o 'Running at: http://localhost:[0-9]*' ${
      shellQuote(MAKERS_DEV_LOG_PATH)
    } 2>/dev/null | head -n 1 | tr -dc '0-9')`,
    '  fi',
    `  if [ -n "$bound_port" ] && [ "$bound_port" != "${makersPort}" ]; then break; fi`,
    // The poll's own request is what makes the app throw, so the error count
    // climbs once per second for as long as we keep asking. Reading it turns
    // the second failure that looks like a slow start into a fact: the server
    // answered, and it will answer the same way until the code changes.
    `  app_errors=$(grep -cE ${shellQuote(MAKERS_DEV_APP_ERROR_PATTERN)} ${
      shellQuote(MAKERS_DEV_LOG_PATH)
    } 2>/dev/null || true)`,
    `  if [ "\${app_errors:-0}" -ge ${MAKERS_DEV_APP_ERROR_THRESHOLD} ]; then break; fi`,
    '  sleep 1',
    'done',
    `if [ -n "$bound_port" ] && [ "$bound_port" != "${makersPort}" ]; then`,
    `  echo "edgeone makers dev bound port $bound_port instead of the requested ${makersPort}, so the preview proxy has nothing to forward to. Port ${makersPort} was still held when the CLI started." >&2`,
    '  echo "--- makers-dev log ---" >&2',
    `  tail -n 60 ${shellQuote(MAKERS_DEV_LOG_PATH)} >&2 2>/dev/null || true`,
    '  kill $proxy_pid "$dev_pid" >/dev/null 2>&1 || true',
    `  echo "MAKERS_DEV_EXIT:${MAKERS_DEV_PORT_DRIFT_EXIT}"`,
    '  exit 0',
    'fi',
    `if [ "\${app_errors:-0}" -ge ${MAKERS_DEV_APP_ERROR_THRESHOLD} ]; then`,
    `  echo "edgeone makers dev is serving on port ${makersPort}, but the project throws on every request, so the preview cannot become ready. Fix what the error below names and start the preview again; relaunching on its own changes nothing." >&2`,
    // One throw repeated eighty times used to be the whole of this report, and
    // the cause was as hard to find as it would have been in silence. Dropping
    // the per-line timestamp makes the repeats identical so they collapse to
    // the handful of distinct errors the project actually has.
    '  echo "--- makers-dev errors ---" >&2',
    `  grep -E ${shellQuote(MAKERS_DEV_APP_ERROR_PATTERN)} ${
      shellQuote(MAKERS_DEV_LOG_PATH)
    } 2>/dev/null | sed -E "s/^[0-9]{1,2}:[0-9]{2}:[0-9]{2}( (AM|PM))? //" | awk '!seen[$0]++' | head -n 5 >&2 || true`,
    '  echo "--- makers-dev log ---" >&2',
    `  tail -n 40 ${shellQuote(MAKERS_DEV_LOG_PATH)} >&2 2>/dev/null || true`,
    '  kill $proxy_pid "$dev_pid" >/dev/null 2>&1 || true',
    `  echo "MAKERS_DEV_EXIT:${MAKERS_DEV_APP_ERROR_EXIT}"`,
    '  exit 0',
    'fi',
    `echo "edgeone makers dev did not become ready on port ${makersPort} (proxied via ${previewPort}${prefix}/)." >&2`,
    'echo "--- makers-dev log ---" >&2',
    `tail -n 160 ${shellQuote(MAKERS_DEV_LOG_PATH)} >&2 2>/dev/null || true`,
    'echo "--- preview proxy log ---" >&2',
    'tail -n 80 /tmp/preview-proxy.log >&2 2>/dev/null || true',
    'dev_status=124',
    'if ! kill -0 "$dev_pid" >/dev/null 2>&1; then',
    '  wait "$dev_pid" >/dev/null 2>&1',
    '  dev_status=$?',
    'fi',
    'if [ -n "$proxy_pid" ] && ! kill -0 "$proxy_pid" >/dev/null 2>&1; then',
    '  wait "$proxy_pid" >/dev/null 2>&1',
    '  proxy_status=$?',
    '  if [ "$dev_status" -eq 124 ]; then dev_status=$((125 + proxy_status)); fi',
    'fi',
    'kill $proxy_pid "$dev_pid" >/dev/null 2>&1 || true',
    'echo "MAKERS_DEV_EXIT:$dev_status"',
    // Keep the shell successful so the sandbox MCP layer returns captured
    // stdout/stderr instead of collapsing the CLI failure into UNKNOWN_ERROR.
    'exit 0',
  ].join('\n');
}

/**
 * How a smoke script names who is at fault, shared by every probe so one caller
 * can classify them all.
 *
 * `transport` means nothing answered: the dev server may be stale, and a restart
 * is worth trying. `application` means something answered and the answer was
 * wrong, which proves the proxy chain and the dev server both work — restarting
 * only delays the news that the generated code is broken.
 *
 * `route` is the case that reads like `application` and behaves like
 * `transport`: the static page answered in place of the endpoint, so the server
 * is up but never mounted the handler. Nothing about the response is worth
 * reporting, and telling the model to fix its code would send it after a bug
 * that is not there.
 */
export const SMOKE_EXIT = {
  transport: 20,
  application: 30,
  route: 40,
} as const;

/**
 * Budget for the generated /chat smoke test.
 *
 * makers dev rebuilds the agent worker on save, and requests that land in that
 * window come back as 502 or a refused connection. Retrying costs a couple of
 * seconds; reporting it as a failure costs a dev-server restart plus another
 * probe, and every probe is a real model call against the generated agent.
 */
export const GENERATED_CHAT_SMOKE = {
  attempts: 3,
  retrySleepSeconds: 2,
  firstAttemptTimeoutSeconds: 40,
  retryTimeoutSeconds: 20,
  // Worst case is one long attempt plus two short ones and their sleeps.
  commandTimeoutSeconds: 95,
  // Suffixed with the shell's pid: two probes can overlap (a resume racing a
  // turn), and on one shared path each would overwrite the other's verdict.
  tmpPathPrefix: '/tmp/agent-chat-smoke',
} as const;

export function buildGeneratedChatSmokeScript({
  endpoint,
  payload,
  conversationId,
  // The pause between attempts is a cadence, not part of the decision this script
  // makes, so tests set it to zero and still exercise every branch.
  retrySleepSeconds = GENERATED_CHAT_SMOKE.retrySleepSeconds,
}: {
  endpoint: string;
  payload: string;
  conversationId: string;
  retrySleepSeconds?: number;
}) {
  const {
    attempts,
    firstAttemptTimeoutSeconds,
    retryTimeoutSeconds,
    tmpPathPrefix,
  } = GENERATED_CHAT_SMOKE;
  const {
    transport: transportExit,
    application: applicationExit,
    route: routeExit,
  } = SMOKE_EXIT;

  return [
    `body=${tmpPathPrefix}-$$-body`,
    `headers=${tmpPathPrefix}-$$-headers`,
    // The failing body is echoed to stderr below, so nothing is lost by cleaning
    // up: leaving one file per probe behind would just fill /tmp.
    "trap 'rm -f \"$body\" \"$headers\"' EXIT",
    'attempt=0',
    'while :; do',
    '  attempt=$((attempt + 1))',
    `  if [ "$attempt" -eq 1 ]; then maxtime=${firstAttemptTimeoutSeconds}; else maxtime=${retryTimeoutSeconds}; fi`,
    '  rm -f "$body" "$headers"',
    [
      '  curl -sS -N --max-time "$maxtime"',
      "--noproxy '*'",
      '-D "$headers"',
      '-o "$body"',
      `-X POST ${shellQuote(endpoint)}`,
      `-H ${shellQuote('Content-Type: application/json')}`,
      `-H ${shellQuote(`makers-conversation-id: ${conversationId}`)}`,
      `--data ${shellQuote(payload)}`,
    ].join(' '),
    '  status=$?',
    '  http=$(awk \'NR==1 {print $2}\' "$headers" 2>/dev/null)',
    '  if [ "$status" -eq 0 ] && [ "$http" = "200" ]; then break; fi',
    `  if [ "$attempt" -lt ${attempts} ]; then sleep ${retrySleepSeconds}; continue; fi`,
    `  echo "Generated /chat endpoint did not return HTTP 200 after ${attempts} attempts." >&2`,
    '  cat "$body" >&2 2>/dev/null || true',
    `  exit ${transportExit}`,
    'done',
    // An HTML document from a POST to an SSE endpoint is the static site
    // answering: makers dev fell through to index.html because it never mounted
    // the route. It comes back 200, so every check below would read it as a
    // malformed reply from a handler that was in fact never reached.
    'if grep -qiE \'^[[:space:]]*<(!doctype|html)\' "$body"; then',
    '  echo "POST /chat returned an HTML document, so makers dev never mounted the route and served the static page instead." >&2',
    '  head -c 400 "$body" >&2 2>/dev/null || true',
    `  exit ${routeExit}`,
    'fi',
    'if ! grep -q \'data:\' "$body" || ! grep -q \'\\[DONE\\]\' "$body"; then',
    '  echo "Generated /chat endpoint did not return a complete SSE stream." >&2',
    '  cat "$body" >&2 2>/dev/null || true',
    `  exit ${applicationExit}`,
    'fi',
    'if grep -Eq \'"(event|type)"[[:space:]]*:[[:space:]]*"(error|error_message)"\' "$body"; then',
    '  echo "Generated /chat endpoint returned an SSE error event." >&2',
    '  cat "$body" >&2 2>/dev/null || true',
    `  exit ${applicationExit}`,
    'fi',
  ].join('\n');
}

/**
 * Budget for the generated API route probe.
 *
 * Deliberately narrow: a generated route may legitimately answer 401, 403, 404 or
 * 405 to an unauthenticated GET, so only a 5xx or a request that never completes
 * counts as broken. That is exactly the shape of the failures worth catching —
 * a function that throws, one that cannot exchange storage credentials, or one
 * that hangs forever.
 */
export const GENERATED_API_SMOKE = {
  attempts: 3,
  retrySleepSeconds: 2,
  timeoutSeconds: 15,
  // Enough to cover a generated project's handful of endpoints without turning
  // preview publication into a test suite.
  maxRoutes: 4,
  commandTimeoutSeconds: 90,
  tmpPathPrefix: '/tmp/agent-api-smoke',
} as const;

export function buildGeneratedApiSmokeScript({
  baseUrl,
  routes,
  retrySleepSeconds = GENERATED_API_SMOKE.retrySleepSeconds,
}: {
  baseUrl: string;
  routes: string[];
  retrySleepSeconds?: number;
}) {
  const {
    attempts,
    timeoutSeconds,
    maxRoutes,
    tmpPathPrefix,
  } = GENERATED_API_SMOKE;
  const { transport: transportExit, application: applicationExit } = SMOKE_EXIT;
  const probed = routes.slice(0, maxRoutes);

  return [
    `body=${tmpPathPrefix}-$$-body`,
    "trap 'rm -f \"$body\"' EXIT",
    `base=${shellQuote(baseUrl.replace(/\/$/, ''))}`,
    `for route in ${probed.map((route) => shellQuote(route)).join(' ')}; do`,
    '  attempt=0',
    '  while :; do',
    '    attempt=$((attempt + 1))',
    '    rm -f "$body"',
    [
      '    http=$(curl -sS --noproxy \'*\'',
      `--max-time ${timeoutSeconds}`,
      // The sandbox gateway sets this, so send it too: probing without it would
      // miss anything that only breaks on a forwarded request.
      "-H 'x-forwarded-proto: http'",
      '-o "$body" -w \'%{http_code}\' "$base$route" 2>/dev/null)',
    ].join(' '),
    '    status=$?',
    '    if [ "$status" -eq 0 ]; then',
    '      case "$http" in',
    // Anything that is not a server error is a real answer, whatever it says.
    '        5??) ;;',
    '        *) break ;;',
    '      esac',
    '    fi',
    `    if [ "$attempt" -lt ${attempts} ]; then sleep ${retrySleepSeconds}; continue; fi`,
    '    echo "Generated route $route is not serving: http=$http curl=$status" >&2',
    '    cat "$body" >&2 2>/dev/null || true',
    // curl 6/7 mean nothing was listening, so the server itself is suspect. A
    // timeout means it accepted the request and never answered, which is the
    // function hanging rather than the server being down.
    '    case "$status" in',
    `      6|7) exit ${transportExit} ;;`,
    `      0|28) exit ${applicationExit} ;;`,
    `      *) exit ${transportExit} ;;`,
    '    esac',
    '  done',
    'done',
  ].join('\n');
}

export function parseMakersDevExitCode(output: string) {
  const matches = [...output.matchAll(/(?:^|\n)MAKERS_DEV_EXIT:(\d+)(?=\s|$)/g)];
  if (matches.length === 0) return undefined;
  const value = Number(matches.at(-1)?.[1]);
  return Number.isInteger(value) ? value : undefined;
}
