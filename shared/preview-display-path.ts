// Mirror of the sandbox preview base path. Kept here so the address chip can
// hide the gateway prefix without the frontend importing agents/_constants.
export const PREVIEW_PATH_PREFIX = '/preview/';

// Render a mirrored preview route (pathname[+search][+hash]) as the address-bar
// display value: the /preview/ base (and any other leading slashes) is stripped
// so only the route relative to the app root is shown, with a leading '/'.
// The sandbox access_token stays on the real preview URL; it is never shown.
export function previewDisplayPathFromPath(path: string) {
  if (!path) return '/';
  const hashIndex = path.indexOf('#');
  const hash = hashIndex >= 0 ? path.slice(hashIndex) : '';
  const beforeHash = hashIndex >= 0 ? path.slice(0, hashIndex) : path;
  const queryIndex = beforeHash.indexOf('?');
  const rawPath = queryIndex >= 0 ? beforeHash.slice(0, queryIndex) : beforeHash;
  const search = queryIndex >= 0 ? beforeHash.slice(queryIndex + 1) : '';
  const stripped = rawPath.startsWith(PREVIEW_PATH_PREFIX)
    ? rawPath.slice(PREVIEW_PATH_PREFIX.length)
    : rawPath.replace(/^\/+/, '');
  const pathname = stripped === '' ? '/' : `/${stripped}`;
  if (!search) return `${pathname}${hash}`;
  const params = new URLSearchParams(search);
  params.delete('access_token');
  const nextSearch = params.toString();
  return `${pathname}${nextSearch ? `?${nextSearch}` : ''}${hash}`;
}
