import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import {
  ensureProjectScaffold,
  repairNestedAppDirLayout,
} from '../agents/project/_scaffold.ts';
import { projectState } from './helpers/fixtures.ts';

const execFileAsync = promisify(execFile);

/**
 * The workspace as the sandbox presents it: project paths are relative to one
 * root, which is what makes the nested-layout marker `appDir/appDir` mean
 * anything. An absolute appDir would make that test match the app directory
 * itself and the repair would fire on every healthy project.
 */
async function scaffoldFixture(files: Record<string, string> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'makers-scaffold-'));
  const state = projectState('projects/demo');
  const abs = (relative: string) => path.join(root, relative);

  for (const [relative, content] of Object.entries(files)) {
    await mkdir(path.dirname(abs(relative)), { recursive: true });
    await writeFile(abs(relative), content);
  }

  const calls = { makeDir: 0, exists: 0, commands: [] as string[] };
  const context = {
    sandbox: {
      files: {
        makeDir: async (target: string) => {
          calls.makeDir += 1;
          await mkdir(abs(target), { recursive: true });
        },
        exists: async (target: string) => {
          calls.exists += 1;
          return existsSync(abs(target));
        },
        write: async (target: string, content: string) => {
          await mkdir(path.dirname(abs(target)), { recursive: true });
          await writeFile(abs(target), content);
        },
      },
      commands: {
        // Raises on a non-zero exit rather than reporting one, which is what
        // the platform does: `commands.run` rejects with SANDBOX_UNKNOWN_ERROR
        // and the exit status in the message. A fake that returned an exitCode
        // instead made every `exitCode !== 0` branch in this file look tested
        // while none of them could ever run in production.
        run: async (command: string, options: { cwd?: string } = {}) => {
          calls.commands.push(command);
          const { stdout, stderr } = await execFileAsync('sh', ['-c', command], {
            cwd: abs(options.cwd || '.'),
          });
          return { exitCode: 0, stdout, stderr };
        },
      },
    },
  };

  return {
    context,
    state,
    calls,
    exists: (relative: string) => existsSync(abs(relative)),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test('an empty workspace scaffolds and reports itself as new', async () => {
  const fixture = await scaffoldFixture();
  try {
    const outcome = await ensureProjectScaffold(fixture.context, fixture.state);

    assert.equal(outcome.created, true);
    assert.equal(outcome.dependenciesInstalled, false);
    assert.equal(outcome.template, undefined);
    // Left empty because this call named no framework, and the baked trees
    // come back with it: that is the only way the caller learns the workspace
    // could have been filled. Without it a chat-assistant request resolved to
    // nothing and the model wrote a project by hand beside a baked chat agent.
    assert.ok(outcome.available?.includes('deepagents'), 'the baked trees went unreported');

    assert.equal(fixture.exists('projects/demo/app'), true);
  } finally {
    await fixture.cleanup();
  }
});

// One conversation maps to one long-lived project, so a second turn must not
// read as a fresh one.
test('a workspace with files is reused rather than reported as new', async () => {
  const fixture = await scaffoldFixture({
    'projects/demo/app/package.json': '{"name":"demo"}',
  });
  try {
    assert.deepEqual(await ensureProjectScaffold(fixture.context, fixture.state), {
      created: false,
      dependenciesInstalled: false,
    });
  } finally {
    await fixture.cleanup();
  }
});

// The listing prunes node_modules, so this is the only thing standing between
// the model and an `npm install` over a tree that is already installed. On a
// 1.1G sandbox that install does not fit: it fills the disk, dies partway, and
// leaves the tree it overwrote unusable.
test('a workspace whose dependencies are installed says so', async () => {
  const fixture = await scaffoldFixture({
    'projects/demo/app/package.json': '{"name":"demo"}',
    'projects/demo/app/node_modules/.bin/next': '#!/bin/sh\n',
  });
  try {
    const outcome = await ensureProjectScaffold(fixture.context, fixture.state);

    assert.deepEqual(outcome, { created: false, dependenciesInstalled: true });
  } finally {
    await fixture.cleanup();
  }
});

// The state that has to read as "not installed": npm empties .bin early and
// refills it at the end, so a tree left behind by an install that ran out of
// disk is a directory full of packages with nothing runnable in it.
test('a half-installed tree does not count as installed', async () => {
  const fixture = await scaffoldFixture({
    'projects/demo/app/package.json': '{"name":"demo"}',
    'projects/demo/app/node_modules/next/package.json': '{"name":"next"}',
  });
  try {
    const outcome = await ensureProjectScaffold(fixture.context, fixture.state);

    assert.equal(outcome.dependenciesInstalled, false);
  } finally {
    await fixture.cleanup();
  }
});

// node_modules is pruned from the listing because a populated tree is hundreds
// of thousands of paths, and the marker must not leak into it either: a
// workspace holding nothing but dependencies is still an empty project.
test('neither the dependency tree nor its marker counts as a project file', async () => {
  const fixture = await scaffoldFixture({
    'projects/demo/app/node_modules/.bin/next': '#!/bin/sh\n',
    'projects/demo/app/node_modules/next/package.json': '{"name":"next"}',
  });
  try {
    const outcome = await ensureProjectScaffold(fixture.context, fixture.state);

    assert.equal(outcome.created, true);
    assert.equal(outcome.dependenciesInstalled, true);
    // The point of the case: dependencies alone leave it an empty project, so
    // nothing was laid down over them. `available` also comes back here — this
    // call named no framework — and is asserted where it is the subject, not
    // pinned to the baked list, which every new template would change.
    assert.equal(outcome.template, undefined);
  } finally {
    await fixture.cleanup();
  }
});

// The scaffold is the first tool of every turn, so each round trip it makes is
// paid on every turn. One was buying nothing: a recursive create of a directory
// the next call created anyway. The repair's existence probe is not in that
// category — it is what keeps the repair command from running at all, which is
// the cheaper and the safer of the two.
test('the scaffold makes one directory and only probes for the nested layout', async () => {
  const fixture = await scaffoldFixture();
  try {
    await ensureProjectScaffold(fixture.context, fixture.state);

    assert.equal(fixture.calls.makeDir, 1);
    assert.equal(fixture.calls.exists, 1);
    assert.equal(
      fixture.calls.commands.some((command) => command.includes('NESTED=')),
      false,
      'a project with no nested layout should never run the repair script',
    );
  } finally {
    await fixture.cleanup();
  }
});

// What took the failure to production: the repair is opportunistic, but a
// sandbox that raises on it took the whole turn down with it — and because it
// raises instead of reporting an exit code, the function's own `exitCode !== 0`
// branch could not absorb anything. This is the first tool of every
// conversation, so that failure was the first thing every user saw.
test('a sandbox that fails the repair command does not fail the turn', async () => {
  const fixture = await scaffoldFixture({
    'projects/demo/app/projects/demo/app/package.json': '{"name":"nested"}',
  });
  fixture.context.sandbox.commands.run = async (command: string) => {
    fixture.calls.commands.push(command);
    if (command.includes('NESTED=')) {
      throw new Error(
        'Sandbox command failed [instanceId=test]: exit status 1 '
        + '(code=SANDBOX_UNKNOWN_ERROR, operation=command)',
      );
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };

  try {
    assert.equal(await repairNestedAppDirLayout(fixture.context, fixture.state), false);
    assert.equal((await ensureProjectScaffold(fixture.context, fixture.state)).created, true);
  } finally {
    await fixture.cleanup();
  }
});

// Models used to pass appDir-prefixed paths to write_project_file, which joined
// appDir again. The repair is what brings that tree back to the project root.
test('a nested app directory is lifted back to the project root', async () => {
  const fixture = await scaffoldFixture({
    'projects/demo/app/projects/demo/app/package.json': '{"name":"nested"}',
    'projects/demo/app/projects/demo/app/src/App.tsx': 'export default () => null;\n',
  });
  try {
    assert.equal(await repairNestedAppDirLayout(fixture.context, fixture.state), true);

    assert.equal(fixture.exists('projects/demo/app/package.json'), true);
    assert.equal(fixture.exists('projects/demo/app/src/App.tsx'), true);
    assert.equal(fixture.exists('projects/demo/app/projects'), false);
  } finally {
    await fixture.cleanup();
  }
});

test('a healthy project is left untouched by the repair', async () => {
  const fixture = await scaffoldFixture({
    'projects/demo/app/package.json': '{"name":"healthy"}',
  });
  try {
    assert.equal(await repairNestedAppDirLayout(fixture.context, fixture.state), false);
    assert.equal(fixture.exists('projects/demo/app/package.json'), true);
  } finally {
    await fixture.cleanup();
  }
});

// The guard that matters most: a nested directory that is not a project must
// not have its contents hoisted over the real one.
test('a nested directory with no project in it is not lifted', async () => {
  const fixture = await scaffoldFixture({
    'projects/demo/app/package.json': '{"name":"real"}',
    'projects/demo/app/projects/demo/app/notes.txt': 'not a project\n',
  });
  try {
    assert.equal(await repairNestedAppDirLayout(fixture.context, fixture.state), false);
    assert.equal(fixture.exists('projects/demo/app/notes.txt'), false);
    assert.equal(fixture.exists('projects/demo/app/package.json'), true);
  } finally {
    await fixture.cleanup();
  }
});
