import { getProjectState } from '../_memory.ts';
import { readFileFromSandbox } from '../_project.ts';
import type { FileTreeItem } from '../_types.ts';
import { selectResumeCacheFiles } from '../../shared/resume-file-cache.ts';

const RESUME_FILE_READ_BATCH_SIZE = 12;

export type ResumeFileContent = {
  path: string;
  content: string;
  size: number;
  truncated: boolean;
  mtime?: number;
};

/**
 * Hydrate a typical generated project's source cache as part of the existing
 * resume SSE request. Reads run in bounded batches; failures are omitted because
 * clicking an omitted or over-budget file still falls back to /file.
 */
export async function loadResumeFileContents(
  context: any,
  conversationId: string,
  items: FileTreeItem[],
): Promise<ResumeFileContent[]> {
  const selected = selectResumeCacheFiles(items);
  if (selected.length === 0) return [];

  const state = await getProjectState(context, conversationId);
  const metadata = new Map(selected.map((item) => [item.path, item]));
  const hydrated: ResumeFileContent[] = [];

  for (let index = 0; index < selected.length; index += RESUME_FILE_READ_BATCH_SIZE) {
    const batch = selected.slice(index, index + RESUME_FILE_READ_BATCH_SIZE);
    const results = await Promise.all(batch.map(async (item) => ({
      path: item.path,
      ...await readFileFromSandbox(context, state, item.path),
    })));
    for (const result of results) {
      if (!result.ok || typeof result.content !== 'string') continue;
      const item = metadata.get(result.path);
      hydrated.push({
        path: result.path,
        content: result.content,
        size: typeof result.size === 'number'
          ? result.size
          : new TextEncoder().encode(result.content).byteLength,
        truncated: Boolean(result.truncated),
        ...(item?.mtime !== undefined ? { mtime: item.mtime } : {}),
      });
    }
  }

  return hydrated;
}
