import { clearLegacyProjectSnapshot, getLegacyProjectSnapshot } from '../_memory.ts';
import type { ProjectState } from '../_types.ts';
import { restoreProjectArchive } from './_archive.ts';
import { runSandboxCommand } from './_commands.ts';

export async function restorePersistedProject(
  context: any,
  conversationId: string,
  state: ProjectState,
  options: { installDependencies?: boolean } = {},
): Promise<{ restored: boolean; migratedLegacy?: boolean; error?: string }> {
  try {
    const restored = await context.sandbox.restore({ path: state.appDir });
    if (restored?.restored) {
      if (options.installDependencies !== false) await installDependencies(context, state);
      return { restored: true };
    }
  } catch (error) {
    return { restored: false, error: error instanceof Error ? error.message : String(error) };
  }

  const legacy = await getLegacyProjectSnapshot(context, conversationId);
  if (!legacy) return { restored: false };
  const restoredLegacy = await restoreProjectArchive(context, state, legacy, options);
  if (!restoredLegacy.ok) return { restored: false, error: restoredLegacy.error };

  try {
    await context.sandbox.persist({ path: state.appDir });
    await clearLegacyProjectSnapshot(context, conversationId);
  } catch {
    // Keep the legacy metadata until migration has durably completed.
  }
  return { restored: true, migratedLegacy: true };
}

async function installDependencies(context: any, state: ProjectState) {
  if (!(await context.sandbox.files.exists(`${state.appDir}/package.json`))) return;
  if (await context.sandbox.files.exists(`${state.appDir}/node_modules`)) return;
  await runSandboxCommand(context, 'npm install --no-audit --no-fund', {
    cwd: state.appDir,
    timeout: 300,
  });
}
