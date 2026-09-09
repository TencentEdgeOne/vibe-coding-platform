// Path helpers with no heavy imports so unit tests can load them under node:test.

export function normalizeRelPath(rawPath: string): string | null {
  // Reject absolute paths, empty paths, and paths containing .. so callers
  // cannot escape appDir.
  const trimmed = rawPath.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('/')) return null;
  const segments = trimmed.split('/');
  for (const seg of segments) {
    if (seg === '..' || seg === '.') return null;
  }
  return segments.filter(Boolean).join('/');
}

// Models often pass `${appDir}/src/App.tsx` even though write_project_file already
// joins appDir. Strip that prefix (repeatedly) so files land at appDir/src/App.tsx
// instead of the nested appDir/appDir/src/App.tsx trap seen in production logs.
export function toAppRelPath(rawPath: string, appDir: string): string | null {
  const trimmed = rawPath.trim();
  if (!trimmed) return null;

  // Allow `/projects/.../app/foo` by dropping the leading slash, then re-validate.
  const withoutAbs = trimmed.startsWith('/') ? trimmed.replace(/^\/+/, '') : trimmed;
  let rel = normalizeRelPath(withoutAbs);
  if (!rel) return null;

  const root = normalizeRelPath(appDir.replace(/^\/+/, ''));
  if (!root) return rel;

  const prefix = `${root}/`;
  while (rel === root || rel.startsWith(prefix)) {
    if (rel === root) return null;
    rel = rel.slice(prefix.length);
  }
  return rel || null;
}
