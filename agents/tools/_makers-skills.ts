import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tool as defineClaudeTool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { ClaudeMcpTool } from '../_types.ts';

export const MAKERS_REFERENCE_SKILL_NAMES = [
  'makers-agents',
  'makers-deploy',
  'makers-edge-functions',
  'makers-cloud-functions',
  'makers-storage',
  'makers-middleware',
  'makers-cli',
  'makers-recipes',
  'makers-env-adaption',
  'makers-migration',
  'makers-frameworks',
] as const;

export type MakersReferenceSkillName = (typeof MAKERS_REFERENCE_SKILL_NAMES)[number];

const makersReferenceSkillSchema = z.enum(MAKERS_REFERENCE_SKILL_NAMES);

export function resolveMakersSkillDirectory(skill: MakersReferenceSkillName) {
  return path.join(
    process.cwd(),
    '.claude',
    'skills',
    'edgeone-makers-tools',
    'references',
    skill,
  );
}

// Each vendored SKILL.md links to its own deeper documents as
// `references/<name>.md`. Accept that spelling alongside the bare relative form
// so a link copied straight out of the document body resolves.
export function resolveMakersSkillReferencePath(
  skill: MakersReferenceSkillName,
  ref: string,
): string | null {
  const cleaned = ref
    .trim()
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
    .replace(/^references\//, '');
  if (!cleaned || !cleaned.endsWith('.md')) {
    return null;
  }

  const root = path.join(resolveMakersSkillDirectory(skill), 'references');
  const target = path.resolve(root, cleaned);
  return target.startsWith(`${root}${path.sep}`) ? target : null;
}

const referenceIndexCache = new Map<MakersReferenceSkillName, readonly string[]>();

export async function listMakersSkillReferences(
  skill: MakersReferenceSkillName,
): Promise<readonly string[]> {
  const cached = referenceIndexCache.get(skill);
  if (cached) {
    return cached;
  }

  const root = path.join(resolveMakersSkillDirectory(skill), 'references');
  const found: string[] = [];

  async function walk(dir: string) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      // Several skills are a single SKILL.md with no deeper references.
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.name.endsWith('.md')) {
        found.push(path.relative(root, full).replaceAll(path.sep, '/'));
      }
    }
  }

  await walk(root);
  found.sort();
  referenceIndexCache.set(skill, found);
  return found;
}

// Without this index the model cannot discover the deeper documents: it has no
// directory listing for the agent runtime, and the links inside SKILL.md are
// relative paths it would otherwise have to guess at.
function buildReferenceIndex(skill: MakersReferenceSkillName, refs: readonly string[]) {
  if (refs.length === 0) {
    return '';
  }
  return [
    '',
    '---',
    '',
    `## Deeper references for ${skill} (${refs.length})`,
    '',
    'Load one with this same tool by passing ref, for example',
    `{"skill":"${skill}","ref":"${refs[0]}"}`,
    'No file-reading tool can open these paths; this tool is the only way in.',
    '',
    ...refs.map((ref) => `- ${ref}`),
  ].join('\n');
}

function formatUnknownReference(
  skill: MakersReferenceSkillName,
  ref: string,
  refs: readonly string[],
) {
  if (refs.length === 0) {
    return `The skill ${skill} has no deeper reference documents. Call load_makers_skill with only the skill argument.`;
  }
  return [
    `Unknown reference "${ref}" for ${skill}. Available references:`,
    ...refs.map((item) => `- ${item}`),
  ].join('\n');
}

export function buildLoadMakersSkillTool() {
  return defineClaudeTool(
    'load_makers_skill',
    [
      'Load official EdgeOne Makers reference documentation verbatim.',
      'Call it with only a skill to get that skill overview plus an index of its deeper reference documents.',
      'Call it again with skill and ref to open one of those deeper documents, for example {"skill":"makers-agents","ref":"platform/sse-protocol.md"}.',
      'These documents exist only on the agent runtime and no file-reading tool can reach them, so this tool is the only way to read them.',
      'Choose only what the user request needs. Independent loads may be issued in parallel in one assistant message.',
      'Use makers-agents for AI/LLM/SSE endpoints, makers-recipes for project layout, makers-cloud-functions for Node/Go/Python APIs, makers-edge-functions for V8 edge APIs, makers-storage for KV/Blob persistence, makers-middleware for middleware, makers-deploy only for live deployment, makers-cli for CLI commands, makers-env-adaption for restricted environments, and makers-migration for adapting an existing agent project.',
    ].join(' '),
    {
      skill: makersReferenceSkillSchema.describe('The specific Makers reference skill to load.'),
      ref: z
        .string()
        .optional()
        .describe(
          'Optional path of a deeper reference document inside that skill, taken from the index returned with the skill overview (for example "platform/sse-protocol.md"). Omit to load the skill overview.',
        ),
    },
    async (input) => {
      try {
        const skill = makersReferenceSkillSchema.parse(input.skill);
        const ref = typeof input.ref === 'string' ? input.ref.trim() : '';

        if (!ref) {
          const [content, refs] = await Promise.all([
            readFile(path.join(resolveMakersSkillDirectory(skill), 'SKILL.md'), 'utf8'),
            listMakersSkillReferences(skill),
          ]);
          return {
            content: [{ type: 'text' as const, text: content + buildReferenceIndex(skill, refs) }],
          };
        }

        const target = resolveMakersSkillReferencePath(skill, ref);
        const content = target ? await readFile(target, 'utf8').catch(() => null) : null;
        if (content === null) {
          return {
            content: [{
              type: 'text' as const,
              text: formatUnknownReference(skill, ref, await listMakersSkillReferences(skill)),
            }],
            isError: true,
          };
        }

        return {
          content: [{ type: 'text' as const, text: content }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text' as const, text: `Unable to load Makers skill: ${message}` }],
          isError: true,
        };
      }
    },
  ) as ClaudeMcpTool;
}
