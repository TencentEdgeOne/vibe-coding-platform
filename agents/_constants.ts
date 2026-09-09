// Preview topology inside the sandbox:
//   edgeone makers dev  → :8088 (application at /)
//   strip-prefix proxy  → :3000 (/preview/* → :8088/*)
//   sandbox gateway     → :9000 public host at /preview/
export const MAKERS_DEV_PORT = 8088;
export const PREVIEW_SERVER_PORT = 3000;
export const PREVIEW_PUBLIC_PORT = 9000;
export const PREVIEW_PATH_PREFIX = '/preview/';

// The one contract between the preview launcher and a generated Next.js app.
// Next emits its own asset URLs as root-absolute /_next/... paths, and the
// gateway publishes nothing above the prefix, so in preview every stylesheet
// and client chunk 404s: the page arrives unstyled and never hydrates, while
// the HTML itself still answers 200 and every other gate passes. The prefix is
// exported into makers dev rather than written into the project because a
// deployment never sets it, which is what keeps the generated site at /.
export const PREVIEW_ASSET_PREFIX_ENV = 'EDGEONE_PREVIEW_ASSET_PREFIX';
export const HISTORY_FETCH_LIMIT = 50;
export const AUTO_FIX_MAX_ATTEMPTS = 1;
export const BUILD_ERROR_PROMPT_LIMIT = 12000;
export const BUILD_RELATED_PATH_LIMIT = 12;
export const DEFAULT_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
export const GATEWAY_QUOTA_BYPASS_HEADER = 'X-Gateway-Quota-Bypass: true';
export const GATEWAY_QUOTA_PROMPT_HEADER = 'X-Prompt-Log: true';
export const GATEWAY_CONVERSATION_ID_HEADER_NAME = 'Makers-Conversation-Id';

export const MAKERS_SKILL_NAMES = [
  'edgeone-makers-tools',
] as const;

export const SANDBOX_MCP_SERVER_NAME = 'edgeone-sandbox';

// Upper bound for the downloadable source archive, guarding against streaming an
// unexpectedly huge archive out of the sandbox and through the function response.
export const DOWNLOAD_ARCHIVE_MAX_BYTES = 60 * 1024 * 1024;

// Directories excluded from the downloadable source archive: build output,
// caches, and dependency/VCS folders that are large and regenerable.
export const ARCHIVE_EXCLUDED_DIRECTORIES = [
  'node_modules',
  '.next',
  '.git',
  'dist',
  'build',
  'out',
  'coverage',
  '.cache',
  '.turbo',
  '.vite',
  '.parcel-cache',
  '__pycache__',
  '.venv',
  'venv',
  // Created by static-http preview (legacy) or unused; keep hidden.
  'preview',
  // Created by `edgeone makers deploy` / `makers dev`; contains platform metadata, not app source.
  '.edgeone',
];


export const PREVIEW_BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.avif',
  '.pdf', '.zip', '.tar', '.gz', '.tgz', '.7z', '.rar',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp3', '.mp4', '.mov', '.webm', '.wav', '.ogg', '.flac',
  '.lock',
]);

export const PREVIEW_MAX_BYTES = 256 * 1024;
export const PREVIEW_BATCH_MAX_FILES = 12;
export const PREVIEW_BATCH_MAX_BYTES = 1024 * 1024;

export const FILE_TREE_IGNORED_DIRECTORIES = [
  'node_modules',
  '.next',
  '.git',
  'dist',
  'build',
  'out',
  'coverage',
  '.cache',
  '.turbo',
  '.vite',
  '.parcel-cache',
  '__pycache__',
  '.venv',
  'venv',
  // Legacy static-preview output — not project source.
  'preview',
  // Created by `edgeone makers deploy` / `makers dev`; hide it from the Files panel.
  '.edgeone',
];

export const FILE_TREE_IGNORED_FILENAMES = new Set([
  'tsconfig.tsbuildinfo',
  '.DS_Store',
  // Legacy static-preview symlink; hide it so Files does not open a directory.
  'preview',
]);

export function isIgnoredFileTreePath(rawPath: string) {
  const segments = rawPath.replace(/^\.\//, '').split('/').filter(Boolean);
  return segments.some((segment) => FILE_TREE_IGNORED_DIRECTORIES.includes(segment))
    || FILE_TREE_IGNORED_FILENAMES.has(segments.at(-1) || '');
}

export const BLOCKED_PROJECT_WRITE_SEGMENTS = new Set([
  'node_modules',
  '.next',
  '.git',
  'dist',
  'build',
  '.cache',
  '__pycache__',
]);

export const BLOCKED_PROJECT_WRITE_FILENAMES = new Set([
  '.env',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  '.DS_Store',
]);

export const BLOCKED_PROJECT_WRITE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.avif',
  '.pdf', '.zip', '.tar', '.gz', '.tgz', '.7z', '.rar',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp3', '.mp4', '.mov', '.webm', '.wav', '.ogg', '.flac',
  '.lock',
]);
