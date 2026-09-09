/**
 * Shareable addresses for the running sandbox preview.
 *
 * Both ends read this file: the workspace builds the link its copy and open
 * controls hand out, and the tests below it pin the shape. Keep it
 * runtime-agnostic — no React, Next.js, or EdgeOne imports.
 */

/**
 * The address of the route the preview iframe is currently showing.
 *
 * `trackedPath` comes from the injected tracker, which reports a whole relative
 * URL — `location.pathname + location.search + location.hash`. That is why this
 * cannot be an assignment to `pathname`: a pathname may not hold a `?`, so the
 * URL API percent-encodes it into the path, and the base's own query stays
 * where it was. The result carries the access token twice and points at a path
 * that can never match a route. Resolving the tracked value as a reference
 * against the base keeps each part where it belongs.
 */
export function previewDeepLink(baseUrl: string, trackedPath: string): string {
  if (!baseUrl) return baseUrl;
  try {
    const base = new URL(baseUrl);
    if (!trackedPath) return base.toString();
    const target = new URL(trackedPath, base);
    // Only the same host: a tracked value is a postMessage payload, so an
    // absolute one could otherwise redirect this link off the sandbox.
    if (target.origin !== base.origin) return base.toString();
    // The iframe's route usually carries no token of its own — the preview
    // opens with one and the first in-app navigation drops it — so the base's
    // token is what keeps a copied link authenticating.
    for (const [key, value] of base.searchParams) {
      if (!target.searchParams.has(key)) target.searchParams.set(key, value);
    }
    return target.toString();
  } catch {
    return baseUrl;
  }
}
