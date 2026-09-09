'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, FileCode2, Folder, FolderOpen } from 'lucide-react';
import { Highlight, type PrismTheme } from 'prism-react-renderer';
import type { FileCopy } from '../i18n';
import type { FileTree } from '../types/workspace';
import type { FileContentCache } from '../hooks/use-file-content-cache';
import { getOrCreateCachedConversationId } from '../lib/conversation';
import { makersFileSemantic } from '../../shared/makers-file-semantics';
import { Spinner } from './spinner';

type FilePreviewState =
  | { status: 'idle' }
  | { status: 'loading'; path: string }
  | {
      status: 'ready';
      path: string;
      content: string;
      truncated: boolean;
      size: number;
    }
  | { status: 'error'; path: string; error: string };

type FileReadResult = {
  ok?: boolean;
  path?: string;
  content?: string;
  size?: number;
  truncated?: boolean;
  error?: string;
};

// Memoized: while the agent streams, the workspace re-renders on every token,
// and this panel re-tokenizes the whole open file with Prism on each pass. Its
// props only move when the project actually changes.
export const FilesPanel = memo(function FilesPanel({
  tree,
  refreshing,
  conversationId,
  copy,
  cache,
  focusPath = null,
}: {
  tree: FileTree | null;
  refreshing: boolean;
  conversationId: string | null;
  copy: FileCopy;
  cache: FileContentCache;
  // When set, open this file once it is present in the tree (or immediately from cache).
  focusPath?: string | null;
}) {
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(() => new Set());
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<FilePreviewState>({ status: 'idle' });
  // Track the latest requested path so slower responses cannot overwrite newer selections.
  const latestRequestRef = useRef<string | null>(null);
  const inFlightRef = useRef<AbortController | null>(null);
  const focusedPathRef = useRef<string | null>(null);

  // A read outliving the panel would resolve into an unmounted component; the
  // request is also pointless by then.
  useEffect(() => () => {
    inFlightRef.current?.abort();
    inFlightRef.current = null;
  }, []);
  const cacheVersion = cache.version;
  const readCachedFile = cache.read;
  const writeCachedFile = cache.write;

  // Drop the selection and preview held here when the tree they described is
  // replaced. Keyed on the root rather than the conversation because the root
  // is what the paths below were resolved against.
  useEffect(() => {
    setCollapsedDirs(new Set());
    setSelectedPath(null);
    setPreview({ status: 'idle' });
    latestRequestRef.current = null;
    focusedPathRef.current = null;
  }, [tree?.root]);

  const visibleItems = useMemo(() => {
    if (!tree) {
      return [];
    }

    return tree.items.filter((item) => {
      for (const collapsedPath of collapsedDirs) {
        if (item.path !== collapsedPath && item.path.startsWith(`${collapsedPath}/`)) {
          return false;
        }
      }
      return true;
    });
  }, [collapsedDirs, tree]);

  const toggleDirectory = (path: string) => {
    setCollapsedDirs((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  // Generated files normally arrive over the chat SSE stream. Only files absent
  // from that cache are fetched, and only after an explicit user click.
  const fetchFile = useCallback(async (path: string, options: { silent?: boolean } = {}) => {
    latestRequestRef.current = path;
    // A superseded read is wasted work on the agent route and across the sandbox
    // boundary, so it is cancelled rather than merely ignored on arrival.
    inFlightRef.current?.abort();
    const controller = new AbortController();
    inFlightRef.current = controller;
    if (!options.silent) {
      setPreview({ status: 'loading', path });
    }
    try {
      const headers: HeadersInit = {};
      const cid = conversationId || getOrCreateCachedConversationId();
      if (cid) {
        headers['makers-conversation-id'] = cid;
        headers['conversationId'] = cid;
      }
      const resp = await fetch(`/file?path=${encodeURIComponent(path)}`, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });
      const data = (await resp.json()) as FileReadResult;
      // Discard this response if the user selected another file while it was
      // loading, or if the panel went away underneath it.
      if (controller.signal.aborted || latestRequestRef.current !== path) {
        return;
      }
      if (!data.ok) {
        setPreview({ status: 'error', path, error: data.error || copy.readFailed });
        return;
      }
      // No mtime yet: like streamed content, the next file listing stamps it. Doing
      // it here would risk pinning the content to a listing it does not belong to.
      const entry = {
        content: data.content || '',
        size: typeof data.size === 'number' ? data.size : 0,
        truncated: Boolean(data.truncated),
      };
      writeCachedFile(path, entry);
      setPreview({ status: 'ready', path, ...entry });
    } catch (err) {
      if (controller.signal.aborted || latestRequestRef.current !== path) {
        return;
      }
      setPreview({
        status: 'error',
        path,
        error: err instanceof Error ? err.message : copy.requestFailed,
      });
    } finally {
      if (inFlightRef.current === controller) {
        inFlightRef.current = null;
      }
    }
  }, [conversationId, copy, writeCachedFile]);

  const loadFile = useCallback((path: string) => {
    setSelectedPath(path);
    const cached = readCachedFile(path);
    if (cached) {
      latestRequestRef.current = path;
      setPreview({
        status: 'ready',
        path,
        content: cached.content,
        truncated: cached.truncated,
        size: cached.size,
      });
      return;
    }
    void fetchFile(path);
  }, [fetchFile, readCachedFile]);

  // Open the path the parent asked for (first generated file). Prefer waiting until
  // the tree lists it so parent dirs can expand; fall back to cache-only so a
  // file_content that arrives before file_tree still shows immediately.
  useEffect(() => {
    if (!focusPath || focusedPathRef.current === focusPath) {
      return;
    }
    const inTree = tree?.items.some((item) => item.type === 'file' && item.path === focusPath);
    const cached = readCachedFile(focusPath);
    if (!inTree && !cached) {
      return;
    }
    focusedPathRef.current = focusPath;
    // Ensure ancestor directories are expanded so the selection is visible in the list.
    if (tree) {
      const parts = focusPath.split('/');
      if (parts.length > 1) {
        setCollapsedDirs((current) => {
          let changed = false;
          const next = new Set(current);
          for (let i = 1; i < parts.length; i += 1) {
            const dir = parts.slice(0, i).join('/');
            if (next.has(dir)) {
              next.delete(dir);
              changed = true;
            }
          }
          return changed ? next : current;
        });
      }
    }
    loadFile(focusPath);
  }, [focusPath, loadFile, readCachedFile, tree]);

  // Keep the open file current. When the agent rewrites it the new text arrives in
  // the cache and swaps in silently; when the cache entry is dropped because the
  // file changed in a way we could not observe, refetch instead of leaving stale
  // code on screen.
  const previewStatus = preview.status;
  const previewPath = preview.status === 'idle' ? null : preview.path;
  useEffect(() => {
    const path = selectedPath;
    if (!path) return;
    const cached = readCachedFile(path);
    if (cached) {
      setPreview((current) => (
        current.status === 'ready' && current.path === path && current.content === cached.content
          ? current
          : {
            status: 'ready',
            path,
            content: cached.content,
            truncated: cached.truncated,
            size: cached.size,
          }
      ));
      return;
    }
    if (previewStatus === 'ready' && previewPath === path) {
      void fetchFile(path, { silent: true });
    }
  }, [cacheVersion, fetchFile, previewPath, previewStatus, readCachedFile, selectedPath]);

  if (!tree || tree.items.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 bg-card px-6 text-center text-muted-foreground">
        {refreshing ? (
          <>
            <Spinner />
            <p>{copy.refreshing}</p>
          </>
        ) : (
          <p>{copy.empty}</p>
        )}
      </div>
    );
  }

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[220px_minmax(0,1fr)] overflow-hidden bg-[var(--code-paper)] text-[var(--code-ink)] max-sm:grid-cols-[164px_minmax(0,1fr)]">
      <aside className="flex min-h-0 flex-col border-r border-[var(--border)] bg-[var(--code-rail)]">
        <div className="min-h-0 flex-1 overflow-auto px-2 py-2.5">
          <div className="flex h-8 items-center px-2 text-[11px] font-semibold text-[var(--n-700)]">
            {copy.projectFiles}
          </div>
          <div className="flex flex-col gap-px text-[12px] leading-5">
            {visibleItems.map((item) => {
              const isDirectory = item.type === 'directory';
              const isCollapsed = collapsedDirs.has(item.path);
              const isSelected = !isDirectory && selectedPath === item.path;
              const semantic = makersFileSemantic(item);
              const capabilityLabel = semantic
                ? copy.capabilities[semantic.capability]
                : '';
              const semanticTitle = semantic
                ? [
                    capabilityLabel,
                    semantic.route ? copy.route(semantic.route) : '',
                  ].filter(Boolean).join(' · ')
                : '';

              return (
                <button
                  key={item.path}
                  type="button"
                  onClick={() => {
                    if (isDirectory) {
                      toggleDirectory(item.path);
                    } else {
                      loadFile(item.path);
                    }
                  }}
                  className={`group relative flex min-h-7 w-full min-w-0 items-center gap-1.5 rounded-[5px] py-1 pr-2 text-left transition-colors ${
                    isSelected
                      ? 'bg-[var(--cap-agent-soft)] font-medium text-[var(--code-selected-text)]'
                      : 'text-[var(--n-700)] hover:bg-[var(--secondary)] hover:text-[var(--n-900)]'
                  }`}
                  style={{ paddingLeft: `${7 + item.depth * 16}px` }}
                  title={semanticTitle || item.path}
                >
                  {isDirectory ? (
                    <>
                      <ChevronRight className={`size-3 shrink-0 text-[var(--n-500)] transition-transform ${isCollapsed ? '' : 'rotate-90'}`} aria-hidden="true" />
                      {isCollapsed ? <Folder className="size-3.5 shrink-0 text-[var(--code-icon-folder)]" /> : <FolderOpen className="size-3.5 shrink-0 text-[var(--code-icon-folder-open)]" />}
                    </>
                  ) : (
                    <>
                      <span className="size-3 shrink-0" aria-hidden="true" />
                      <FileCode2 className={`size-3.5 shrink-0 ${isSelected ? 'text-[var(--brand)]' : 'text-[var(--code-icon)]'}`} aria-hidden="true" />
                    </>
                  )}
                  <span className="flex min-w-0 flex-1 flex-col justify-center">
                    <span className="flex min-w-0 items-center gap-1">
                      <span className="truncate">{item.name}</span>
                      {semantic ? (
                        <span
                          className="capability-badge"
                          data-capability={semantic.capability}
                          aria-label={capabilityLabel}
                        >
                          {semantic.badge}
                        </span>
                      ) : null}
                    </span>
                    {semantic?.route ? (
                      <span className="truncate font-mono text-[9px] font-normal leading-3 text-[var(--code-subtle)]">
                        {copy.route(semantic.route)}
                      </span>
                    ) : null}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </aside>

      <div className="flex min-h-0 flex-col">
        <FileContentView preview={preview} copy={copy} />
      </div>
    </div>
  );
});

// GitHub Light-inspired syntax theme for the code workspace. These are the one
// place in this surface that keeps raw hex: prism-react-renderer writes the
// values into inline styles and never resolves custom properties, so a
// var(--…) here would render as no colour at all. The panel chrome around it
// reads from the code-surface tokens instead.
const CODE_THEME: PrismTheme = {
  plain: { color: '#24292f', backgroundColor: 'transparent' },
  styles: [
    { types: ['comment', 'prolog', 'doctype', 'cdata'], style: { color: '#8b949e', fontStyle: 'italic' } },
    { types: ['punctuation'], style: { color: '#24292f' } },
    { types: ['keyword', 'operator', 'boolean', 'important', 'atrule'], style: { color: '#cf222e' } },
    { types: ['function', 'function-variable', 'method'], style: { color: '#8250df' } },
    { types: ['string', 'char', 'attr-value', 'template-string', 'regex', 'url'], style: { color: '#0a7d33' } },
    { types: ['number', 'unit'], style: { color: '#0550ae' } },
    { types: ['tag', 'selector'], style: { color: '#116329' } },
    { types: ['attr-name', 'constant', 'builtin', 'symbol'], style: { color: '#0550ae' } },
    { types: ['class-name', 'maybe-class-name'], style: { color: '#953800' } },
    { types: ['property', 'variable', 'parameter'], style: { color: '#24292f' } },
    { types: ['deleted'], style: { color: '#cf222e' } },
    { types: ['inserted'], style: { color: '#0a7d33' } },
  ],
};

// Map a file path to a Prism language. Unknown extensions fall back to plain text
// (Prism renders a single token, so the file still shows uncolored but intact).
function prismLanguage(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'ts':
      return 'typescript';
    case 'tsx':
      return 'tsx';
    case 'js':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'jsx':
      return 'jsx';
    case 'json':
      return 'json';
    case 'css':
      return 'css';
    case 'scss':
    case 'sass':
      return 'scss';
    case 'html':
    case 'htm':
    case 'xml':
    case 'svg':
    case 'vue':
      return 'markup';
    case 'md':
    case 'mdx':
    case 'markdown':
      return 'markdown';
    case 'py':
      return 'python';
    case 'sh':
    case 'bash':
    case 'zsh':
      return 'bash';
    case 'yml':
    case 'yaml':
      return 'yaml';
    case 'go':
      return 'go';
    case 'rs':
      return 'rust';
    default:
      return 'tsx';
  }
}

function FileContentView({ preview, copy }: { preview: FilePreviewState; copy: FileCopy }) {
  if (preview.status === 'idle') {
    return (
      <div className="flex h-full min-h-0 items-center justify-center px-6 text-center text-muted-foreground">
        {copy.selectFile}
      </div>
    );
  }
  if (preview.status === 'loading') {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex h-10 items-center gap-2 border-b border-[var(--border)] bg-[var(--code-rail)] px-4 text-xs text-primary">
          <Spinner />
          <span className="truncate font-mono text-[11px] text-muted-foreground">
            {copy.loading(preview.path)}
          </span>
        </div>
        <div className="flex flex-1 items-center justify-center">
          <Spinner />
        </div>
      </div>
    );
  }
  if (preview.status === 'error') {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex h-10 items-center border-b border-[var(--border)] bg-[var(--code-rail)] px-4">
          <p className="truncate font-mono text-[11px] text-muted-foreground">{preview.path}</p>
        </div>
        <div className="flex flex-1 items-center justify-center px-6 text-center text-destructive">
          {preview.error}
        </div>
      </div>
    );
  }

  const lines = preview.content.split('\n');
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-10 flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] bg-[var(--code-rail)] px-4 py-2">
        <p className="min-w-0 truncate font-mono text-[11px] font-medium text-[var(--n-800)]">
          {preview.path}
        </p>
        <div className="flex shrink-0 items-center gap-2 font-mono text-[11px] text-muted-foreground">
          <span>{copy.lines(lines.length)}</span>
          <span>{formatFileSize(preview.size)}</span>
          {preview.truncated && (
            <span className="rounded-full bg-[color-mix(in_srgb,var(--gold)_15%,transparent)] px-2 py-0.5 text-[var(--gold)]">
              {copy.truncated}
            </span>
          )}
        </div>
      </div>
      <Highlight code={preview.content} language={prismLanguage(preview.path)} theme={CODE_THEME}>
        {({ tokens, getTokenProps }) => (
          <pre className="min-h-0 flex-1 overflow-auto bg-[var(--code-paper)] py-3 font-mono text-[12px] leading-5 text-[var(--code-ink)]">
            <code>
              {tokens.map((line, lineIndex) => (
                <span
                  key={lineIndex}
                  className="grid min-w-max grid-cols-[3.5rem_minmax(0,1fr)] gap-3 px-4"
                >
                  <span className="select-none border-r border-[var(--secondary)] pr-3 text-right text-[var(--code-gutter)]">
                    {lineIndex + 1}
                  </span>
                  <span className="whitespace-pre">
                    {line.map((token, key) => (
                      <span key={key} {...getTokenProps({ token })} />
                    ))}
                  </span>
                </span>
              ))}
            </code>
          </pre>
        )}
      </Highlight>
    </div>
  );
}

function formatFileSize(bytes: number): string {
  if (!bytes || bytes < 1024) return `${bytes || 0} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
