import { tool as defineClaudeTool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { ensureProjectScaffold } from '../_project.ts';
import { buildNpmWarmupCommand } from '../../shared/npm-install.ts';
import {
  ensureMakersAgentDeclarations,
  ensureMakersFrameworkAdapter,
} from '../project/_makers-declarations.ts';
import type { ScaffoldOutcome } from '../project/_scaffold.ts';
import type { ClaudeMcpTool, ProjectState, ScaffoldLog } from '../_types.ts';
import { getBlockedProjectWriteReason, toAppRelPath } from '../utils/_paths.ts';
import { stringifyToolResult } from '../utils/_text.ts';

const writeProjectFileInputSchema = {
  path: z.string().describe(
    'Path relative to the project appDir only (e.g. package.json, src/App.tsx). Do not include the appDir prefix.',
  ),
  content: z.string().describe('Complete UTF-8 contents for that one file.'),
};

const scaffoldInputSchema = {
  framework: z
    .string()
    .optional()
    .describe(
      'The web framework the user asked for, if the request named one — for example "Next.js", "Vite", "Nuxt", "Astro", "SvelteKit". Omit it for a plain HTML/CSS/JS page or when no framework was named. When a baked template exists for it, the workspace comes back already holding that framework\'s project files with the install running, and no scaffolder needs to be run.',
    ),
};

/**
 * What the model is told about the workspace it just asked for.
 *
 * One function rather than a literal with two conditional spreads in it,
 * because both of them wanted to set installHint and the second silently won.
 * There is only ever one right answer to "should I install", and the order it
 * is decided in here is the order the cases actually rank: a populated
 * node_modules settles it whatever else happened, then an install this call
 * started, then nothing to say.
 */
export function describeScaffold(
  state: ProjectState,
  outcome: ScaffoldOutcome,
): Record<string, unknown> {
  const { created, dependenciesInstalled, template, available } = outcome;
  return {
    created,
    appDir: state.appDir,
    dependenciesInstalled,
    // The scaffolder step, reported as already done. The model has no listing
    // of the workspace, so without this it reaches step 2 of the workflow and
    // runs a scaffolder into a directory that is no longer empty.
    ...(template
      ? {
        templateApplied: template.id,
        templateFiles: template.files,
        scaffolderHint: `The ${template.id} scaffolder has already been run for you and its ${template.files} files are in ${state.appDir}. Do not run a scaffold command. Adapt what is there — the platform declarations and the entry route — rather than rewriting files it already got right. The preview asset-prefix option is already in the framework config; do not set it again.`,
        ...(template.adapted
          ? {
            adapterHint: 'This framework\'s platform adapter was added to package.json before the install started, so the dependency is already on its way. Wiring it into the framework config is still yours to do; makers-frameworks says where it goes.',
          }
          : {}),
      }
      // The trees that were there and went unused, named so the miss is
      // recoverable. A status log is not enough — only this result reaches the
      // model, so a gap here reads to it as "there is no template for this"
      // rather than "you did not ask for one", and it goes on to write the tree
      // by hand beside a baked one.
      : available?.length
        ? {
          templatesAvailable: available,
          templatesHint: `No baked template was applied, because the framework argument matched none. These are baked and ready: ${available.join(', ')}. If one of them fits what you are about to build, call ensure_project_scaffold again with that id as framework — the workspace is still empty, so it will be filled from the baked tree, install and all. Prefer that over writing package.json and an entry file by hand. If none fits, carry on and generate the project yourself.`,
        }
        : {}),
    // Said outright, because the listing above cannot show it and the model's
    // default reading of a project it did not install is that it needs
    // installing. The disk is the reason it must not: the cache npm fills to
    // install is about as large as the tree it installs, and only one of them
    // fits beside the other here.
    ...(dependenciesInstalled
      ? {
        installHint: 'node_modules is already populated and its executables work. Do not run npm install — the download cache would not fit beside the existing tree, and a failed install leaves the tree unusable. Install only when you add a dependency, and then name it (npm install <pkg>).',
      }
      : template
        ? {
          installHint: 'The install for this template is already running against this package.json. Run npm install only after you add a package to it.',
        }
        : {}),
    writePathHint: 'write_project_file path is relative to appDir (e.g. package.json, src/App.tsx), never prefix with appDir',
  };
}

export function buildProjectScaffoldTool(
  context: any,
  state: ProjectState,
  onLog?: (log: ScaffoldLog) => void,
  onResult?: (result: { created: boolean }) => void,
) {
  return defineClaudeTool(
    'ensure_project_scaffold',
    'Prepare or reuse the project workspace in the EdgeOne sandbox before any project file reads or writes. Always pass framework: the framework the request names, or, when it names none, the kind of app being built (chat, agent, react). Baked templates are matched from it, and a workspace prepared from one arrives with its files and its install already started; omitting it is what leaves the workspace empty.',
    scaffoldInputSchema,
    async (input) => {
      try {
        const requested = input as { framework?: unknown };
        const { created, dependenciesInstalled, template } = await ensureProjectScaffold(
          context,
          state,
          onLog,
          { framework: typeof requested.framework === 'string' ? requested.framework : undefined },
        );
        state.created = true;
        onResult?.({ created });
        return {
          content: [{
            type: 'text' as const,
            text: stringifyToolResult(
              describeScaffold(state, { created, dependenciesInstalled, template }),
            ),
          }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text' as const, text: message }],
          isError: true,
        };
      }
    },
  ) as ClaudeMcpTool;
}
export function buildWriteProjectFileTool(
  context: any,
  state: ProjectState,
  // The content is handed back so the pipeline can push it straight to the
  // frontend, which then renders the file without a /file round trip.
  onResult?: (result: { written: string; content: string }) => void | Promise<void>,
) {
  return defineClaudeTool(
    'write_project_file',
    'Create or replace exactly one complete UTF-8 project file under appDir. Up to four calls may be issued together for files that do not depend on each other. Keep files modular and reasonably small — prefer multiple focused files over one giant HTML/JS blob so each write finishes faster for the user. Path must be relative to appDir itself (package.json, src/App.tsx) — never prefix with the appDir path.',
    writeProjectFileInputSchema,
    async (input) => {
      try {
        const file = input as { path?: unknown; content?: unknown };
        if (typeof file.path !== 'string' || typeof file.content !== 'string') {
          throw new Error('Call write_project_file with {"path":"src/App.tsx","content":"complete file contents"}.');
        }
        const relPath = toAppRelPath(file.path, state.appDir);
        if (!relPath) {
          throw new Error(
            `Invalid file path: ${file.path}. Use a path relative to ${state.appDir} (example: src/App.tsx), not ${state.appDir}/src/App.tsx.`,
          );
        }
        const blockedReason = getBlockedProjectWriteReason(relPath);
        if (blockedReason) {
          throw new Error(`Refusing to write ${relPath}: ${blockedReason}`);
        }

        const parent = relPath.split('/').slice(0, -1).join('/');
        if (parent) {
          await context.sandbox.files.makeDir(`${state.appDir}/${parent}`);
        }
        await context.sandbox.files.write(`${state.appDir}/${relPath}`, file.content);
        await onResult?.({ written: relPath, content: file.content });
        // An agents/ project needs two platform declarations that nothing here
        // has to decide, and meeting them at the preview gate instead costs the
        // user a failed attempt. Best effort: the lint remains the authority, so
        // a failure here costs the old behaviour and nothing more.
        let adapterAdded = false;
        const declared = relPath.startsWith('agents/')
          ? await ensureMakersAgentDeclarations(context, state).catch(() => [])
          : [];
        // The dependencies are known the moment this file lands, and the
        // install needs nothing else in the project to exist. Starting it now
        // overlaps it with the files still being written instead of leaving
        // that stretch on the floor. Silent and best-effort: the model is not
        // told, it just finds its own install already done.
        if (relPath === 'package.json') {
          // Ordered ahead of the install rather than beside it: a framework
          // that cannot build without its platform adapter needs that package
          // in this install, not in a second one after the lint asks for it.
          const adapter = await ensureMakersFrameworkAdapter(context, state, file.content)
            .catch(() => undefined);
          if (adapter) {
            declared.push(adapter);
            adapterAdded = true;
          }
          await context.sandbox.commands
            .run(buildNpmWarmupCommand(), { cwd: state.appDir })
            .catch(() => undefined);
        }
        for (const declaration of declared) {
          await onResult?.({ written: declaration.path, content: declaration.content });
        }
        return {
          content: [{
            type: 'text' as const,
            text: stringifyToolResult({
              written: relPath,
              ...(declared.length > 0 ? {
                alsoWritten: declared.map((declaration) => declaration.path),
                note: adapterAdded
                  ? 'Platform declarations written for you, including the platform adapter this framework cannot build without — it is in dependencies and the install already has it. Wiring it into the framework config is still yours to do; makers-frameworks says where it goes. Edit a value that is wrong; do not write these files again from scratch.'
                  : 'Platform declarations an agents/ project requires, written for you. Edit a value that is wrong; do not write these files again from scratch.',
              } : {}),
            }),
          }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text' as const, text: message }],
          isError: true,
        };
      }
    },
  ) as ClaudeMcpTool;
}