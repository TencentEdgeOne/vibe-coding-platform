import {
  BLOCKED_PROJECT_WRITE_EXTENSIONS,
  BLOCKED_PROJECT_WRITE_FILENAMES,
  BLOCKED_PROJECT_WRITE_SEGMENTS,
} from '../_constants.ts';

export { normalizeRelPath, toAppRelPath } from './_relpath.ts';

// Normalize conversation IDs before using them in sandbox paths so paths remain
// stable across runtime environments.
export function safeSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export function readFileExtension(path: string): string {
  const slash = path.lastIndexOf('/');
  const tail = slash === -1 ? path : path.slice(slash + 1);
  const dot = tail.lastIndexOf('.');
  if (dot <= 0) return '';
  return tail.slice(dot).toLowerCase();
}

export function getBlockedProjectWriteReason(path: string): string | null {
  const segments = path.split('/');
  for (const segment of segments) {
    if (BLOCKED_PROJECT_WRITE_SEGMENTS.has(segment)) {
      return `generated/cache directory "${segment}" is not writable`;
    }
  }

  const filename = segments[segments.length - 1] || '';
  if (filename === '.env') {
    return 'runtime environment files must not be generated; use .env.example and context.env';
  }
  if (BLOCKED_PROJECT_WRITE_FILENAMES.has(filename)) {
    return 'package manager lockfiles and system files must not be generated manually';
  }

  const ext = readFileExtension(path);
  if (ext && BLOCKED_PROJECT_WRITE_EXTENSIONS.has(ext)) {
    return `binary/cache file extension "${ext}" is not writable`;
  }

  return null;
}
