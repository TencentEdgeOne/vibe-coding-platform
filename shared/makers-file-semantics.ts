import type { FileTreeItem } from './protocol.ts';

export type MakersFileCapability =
  | 'agent'
  | 'cloud-function'
  | 'edge-function'
  | 'middleware'
  | 'config';

export type MakersFileSemantic = {
  capability: MakersFileCapability;
  badge: 'AI' | 'API' | 'EDGE' | 'MW' | 'CONFIG';
  route?: string;
};

const FUNCTION_EXTENSIONS = new Set([
  'js',
  'jsx',
  'mjs',
  'cjs',
  'ts',
  'tsx',
  'py',
  'go',
]);

const AGENT_EXTENSIONS = new Set([
  'js',
  'jsx',
  'mjs',
  'cjs',
  'ts',
  'tsx',
  'py',
]);

function splitExtension(path: string) {
  const slash = path.lastIndexOf('/');
  const dot = path.lastIndexOf('.');
  if (dot <= slash) return null;
  return {
    stem: path.slice(0, dot),
    extension: path.slice(dot + 1).toLowerCase(),
  };
}

function routeSegment(segment: string) {
  const optionalCatchAll = segment.match(/^\[\[([^\]]+)\]\]$/);
  if (optionalCatchAll) {
    return optionalCatchAll[1] === 'default' ? '*' : `*${optionalCatchAll[1]}`;
  }
  const dynamic = segment.match(/^\[([^\]]+)\]$/);
  return dynamic ? `:${dynamic[1]}` : segment;
}

function routeFromFunctionPath(path: string, root: string) {
  const split = splitExtension(path);
  if (!split || !FUNCTION_EXTENSIONS.has(split.extension)) return undefined;
  const relative = split.stem.slice(root.length + 1);
  const segments = relative.split('/').filter(Boolean);
  if (segments.at(-1)?.startsWith('_')) return undefined;
  if (
    root === 'cloud-functions'
    && split.extension === 'py'
    && segments.at(-1) === 'index'
  ) {
    const parent = segments.slice(0, -1).map(routeSegment).join('/');
    return parent ? `/${parent}/*` : '/*';
  }
  if (
    root === 'cloud-functions'
    && split.extension === 'go'
    && segments.length === 1
    && segments[0] === 'api'
  ) {
    return '/api/*';
  }
  if (segments.at(-1) === 'index') segments.pop();
  const routed = segments.map(routeSegment).join('/');
  return routed ? `/${routed}` : '/';
}

function routeFromAgentPath(path: string) {
  const split = splitExtension(path);
  if (!split || !AGENT_EXTENSIONS.has(split.extension)) return undefined;
  const relative = split.stem.slice('agents/'.length);
  const segments = relative.split('/').filter(Boolean);
  if (
    segments.length === 1
    && !segments[0].startsWith('_')
  ) {
    return `/${routeSegment(segments[0])}`;
  }
  if (
    segments.length === 2
    && segments[1] === 'index'
    && !segments[0].startsWith('_')
  ) {
    return `/${routeSegment(segments[0])}`;
  }
  return undefined;
}

export function makersFileSemantic(
  item: Pick<FileTreeItem, 'path' | 'type'>,
): MakersFileSemantic | null {
  if (item.type === 'directory') {
    if (item.path === 'agents') return { capability: 'agent', badge: 'AI' };
    if (item.path === 'cloud-functions') {
      return { capability: 'cloud-function', badge: 'API' };
    }
    if (item.path === 'edge-functions') {
      return { capability: 'edge-function', badge: 'EDGE' };
    }
    return null;
  }

  if (item.path === 'edgeone.json') {
    return { capability: 'config', badge: 'CONFIG' };
  }
  if (item.path === 'middleware.js' || item.path === 'middleware.ts') {
    return { capability: 'middleware', badge: 'MW', route: '/*' };
  }
  if (item.path.startsWith('agents/')) {
    const route = routeFromAgentPath(item.path);
    return route ? { capability: 'agent', badge: 'AI', route } : null;
  }
  if (item.path.startsWith('cloud-functions/')) {
    const route = routeFromFunctionPath(item.path, 'cloud-functions');
    return route
      ? { capability: 'cloud-function', badge: 'API', route }
      : null;
  }
  if (item.path.startsWith('edge-functions/')) {
    const route = routeFromFunctionPath(item.path, 'edge-functions');
    return route
      ? { capability: 'edge-function', badge: 'EDGE', route }
      : null;
  }
  return null;
}
