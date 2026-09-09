import {
  BUILD_ERROR_PROMPT_LIMIT,
  BUILD_RELATED_PATH_LIMIT,
} from '../_constants.ts';
import type { BuildResult } from '../_types.ts';
import { truncateForPrompt } from './_text.ts';

export function extractBuildRelatedPaths(log: string): string[] {
  const paths = new Set<string>();
  const re = /(?:\.\/)?(?:[\w@.-]+\/)*[\w@.-]+\.(?:tsx|ts|jsx|js|mjs|cjs|css|json|html|py)/g;
  for (const match of log.matchAll(re)) {
    const path = match[0]
      .replace(/^\.\//, '')
      .replace(/[),:;'"`]+$/g, '');
    if (
      path
      && !path.includes('node_modules/')
      && !path.startsWith('.next/')
      && !path.startsWith('next/dist/')
    ) {
      paths.add(path);
    }
    if (paths.size >= BUILD_RELATED_PATH_LIMIT) {
      break;
    }
  }
  return [...paths];
}

export function summarizeBuildError(build: BuildResult): { summary: string; paths: string[] } {
  const stderr = typeof build.stderr === 'string' ? build.stderr.trim() : '';
  const stdout = typeof build.stdout === 'string' ? build.stdout.trim() : '';
  const combined = [stderr, stdout].filter(Boolean).join('\n\n--- stdout ---\n\n');
  const summary = truncateForPrompt(combined || 'Verification command failed without stdout/stderr.', BUILD_ERROR_PROMPT_LIMIT);
  return {
    summary,
    paths: extractBuildRelatedPaths(summary),
  };
}

export function buildAutoFixPrompt(
  originalMessage: string,
  previousReply: string,
  build: BuildResult,
  attempt: number,
  maxAttempts: number,
): string {
  const { summary, paths } = summarizeBuildError(build);
  return [
    'There are errors in the generated code. Fix the errors reported.',
    '',
    `Auto-fix attempt: ${attempt}/${maxAttempts}.`,
    '',
    'Original user request:',
    originalMessage,
    '',
    previousReply ? `Previous assistant summary:\n${previousReply}` : '',
    '',
    'Verification error summary:',
    '```',
    summary,
    '```',
    paths.length
      ? [
          '',
          'The following files may contain errors:',
          '```',
          paths.join('\n'),
          '```',
        ].join('\n')
      : '',
    '',
    'Requirements:',
    '- Read the error message carefully and identify the specific issue.',
    '- Make the smallest complete fix needed for verification to pass.',
    '- Do not regenerate all files or rewrite unrelated code.',
    '- Use write_project_file for exactly one complete file per call. Wait for each result before writing another file.',
    '- After fixing, rerun edgeone makers dev through the sandbox commands tool to refresh the preview.',
    '- Final response must be a concrete conclusion tailored to the original user request, covering what was completed and the preview/verification result. Do not use a generic completion line.',
    '- Do not include preview URLs, sandboxDebugUrl, or preview buttons in the final response.',
  ]
    .filter((part) => part !== '')
    .join('\n');
}
