import type { FileTreeItem } from './protocol.ts';

export const RESUME_FILE_CACHE_MAX_FILES = 48;
export const RESUME_FILE_CACHE_MAX_BYTES = 2 * 1024 * 1024;
const RESUME_FILE_CACHE_MAX_SINGLE_BYTES = 256 * 1024;
const UNKNOWN_FILE_ESTIMATE_BYTES = 32 * 1024;

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.avif',
  '.pdf', '.zip', '.tar', '.gz', '.tgz', '.7z', '.rar',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp3', '.mp4', '.mov', '.webm', '.wav', '.ogg', '.flac',
  '.lock',
]);

const PRIORITY_PATHS = [
  'package.json',
  'src/app.tsx',
  'src/app.jsx',
  'src/main.tsx',
  'src/main.jsx',
  'app/page.tsx',
  'app/layout.tsx',
  'app/globals.css',
  'index.html',
  'readme.md',
];
const priority = new Map(PRIORITY_PATHS.map((path, index) => [path, index]));

function extension(path: string) {
  const filename = path.split('/').pop() || '';
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? filename.slice(dot).toLowerCase() : '';
}

/** Select the most useful previewable files within the resume payload budget. */
export function selectResumeCacheFiles(items: FileTreeItem[]) {
  const candidates = items
    .filter((item) => item.type === 'file')
    .filter((item) => !BINARY_EXTENSIONS.has(extension(item.path)))
    .filter((item) => item.size === undefined || item.size <= RESUME_FILE_CACHE_MAX_SINGLE_BYTES)
    .sort((left, right) => {
      const leftPriority = priority.get(left.path.toLowerCase()) ?? PRIORITY_PATHS.length;
      const rightPriority = priority.get(right.path.toLowerCase()) ?? PRIORITY_PATHS.length;
      return leftPriority - rightPriority
        || left.depth - right.depth
        || (left.size ?? UNKNOWN_FILE_ESTIMATE_BYTES) - (right.size ?? UNKNOWN_FILE_ESTIMATE_BYTES)
        || left.path.localeCompare(right.path);
    });

  const selected: FileTreeItem[] = [];
  let estimatedBytes = 0;
  for (const item of candidates) {
    const bytes = item.size ?? UNKNOWN_FILE_ESTIMATE_BYTES;
    if (selected.length >= RESUME_FILE_CACHE_MAX_FILES) break;
    if (estimatedBytes + bytes > RESUME_FILE_CACHE_MAX_BYTES) continue;
    selected.push(item);
    estimatedBytes += bytes;
  }
  return selected;
}
