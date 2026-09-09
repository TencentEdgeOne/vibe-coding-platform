import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import {
  NPM_WARMUP_NOTICE,
  buildNpmCacheReclaimScript,
  buildNpmWarmupCommand,
  buildNpmWarmupHandoffScript,
  buildNpmWarmupWaitScript,
} from '../shared/npm-install.ts';
import {
  isBareInstallCommand,
  isScaffolderCommand,
  withExitCodeEcho,
} from '../shared/tool-phase.ts';

const run = promisify(execFile);

/**
 * Run the real scripts against a fake npm, because what they claim is about
 * process lifetimes: that the warmup outlives the shell that started it, that a
 * second npm never starts beside it, and that its exit code survives to whoever
 * asks. None of that is visible in the script text.
 */
async function withProject(
  body: (project: {
    dir: string;
    base: string;
    sh: (script: string) => Promise<{ stdout: string; stderr: string }>;
    npmRuns: () => Promise<number>;
    cacheCleans: () => Promise<number>;
    failWith: (output: string) => Promise<void>;
  }) => Promise<void>,
) {
  const dir = await mkdtemp(path.join(tmpdir(), 'npm-warmup-'));
  try {
    const base = path.join(dir, 'warmup');
    await writeFile(path.join(dir, 'package.json'), '{"name":"probe"}\n');

    // A fake npm that takes long enough to still be running when the next
    // script looks, and that counts its own invocations. A cache clean returns
    // at once: it contends for nothing, so no test should have to wait for it.
    const bin = path.join(dir, 'bin');
    await mkdir(bin);
    const at = (name: string) => JSON.stringify(path.join(dir, name));
    await writeFile(
      path.join(bin, 'npm'),
      '#!/bin/sh\n'
      + `echo "$@" >> ${at('npm.calls')}\n`
      + 'case "$1" in cache) exit 0 ;; esac\n'
      + 'sleep 1\n'
      + `cat ${at('npm.stdout')} 2>/dev/null || echo "added 42 packages"\n`
      + `exit "$(cat ${at('npm.exit')} 2>/dev/null || echo 0)"\n`,
      { mode: 0o755 },
    );

    const sh = (script: string) => run('sh', ['-c', script], {
      cwd: dir,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    const calls = async (kind: 'install' | 'cache') => {
      const log = await readFile(path.join(dir, 'npm.calls'), 'utf8').catch(() => '');
      return log.split('\n').filter((line) => line.startsWith(kind)).length;
    };
    await body({
      dir,
      base,
      sh,
      // Counted apart, because the claim they back is about node_modules: one
      // install at a time on one tree. A cache clean touches neither.
      npmRuns: () => calls('install'),
      cacheCleans: () => calls('cache'),
      failWith: async (output: string) => {
        await writeFile(path.join(dir, 'npm.exit'), '1\n');
        await writeFile(path.join(dir, 'npm.stdout'), output);
      },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('the warmup outlives the shell that started it', async () => {
  await withProject(async ({ base, sh, npmRuns, cacheCleans }) => {
    const started = Date.now();
    await sh(buildNpmWarmupCommand(base));
    // Returning without waiting is the whole point: the files are still being
    // written while this runs.
    assert.ok(Date.now() - started < 900, 'the warmup blocked its caller');
    // Recorded synchronously, so the handoff can find it however soon it looks.
    const pid = Number((await readFile(`${base}.pid`, 'utf8')).trim());
    assert.ok(pid > 0);
    assert.doesNotThrow(() => process.kill(pid, 0), 'the warmup died with its shell');

    // Still running, so the wait has something to wait for — and after it, the
    // install has finished on its own.
    await sh(buildNpmWarmupWaitScript(base));
    assert.equal(await readFile(`${base}.done`, 'utf8'), '0\n');
    assert.equal(await npmRuns(), 1);
    // Reclaimed inside the same shell, so the wait covers it: every tarball it
    // downloaded is otherwise still on the disk, and the build that comes next
    // needs that room more than a re-download would cost.
    assert.equal(await cacheCleans(), 1);
  });
});

test('an install the warmup already ran is answered, not run again', async () => {
  await withProject(async ({ base, sh, npmRuns }) => {
    await sh(buildNpmWarmupCommand(base));

    const handoff = [buildNpmWarmupHandoffScript(base), 'npm install; echo EXIT:$?'].join('\n');
    const { stdout } = await sh(handoff);

    // The warmup's own output, and its exit code in the form the sandbox needs.
    assert.match(stdout, /added 42 packages/);
    assert.match(stdout, /EXIT:0/);
    assert.match(stdout, /already running in the background/);
    // The model's own npm never ran: one process touched node_modules, ever.
    assert.equal(await npmRuns(), 1);
  });
});

test('a failed warmup reaches the model as its own failure', async () => {
  await withProject(async ({ base, sh, npmRuns, failWith }) => {
    await failWith('npm error code E404\n');
    await sh(buildNpmWarmupCommand(base));

    const { stdout } = await sh(
      [buildNpmWarmupHandoffScript(base), 'npm install; echo EXIT:$?'].join('\n'),
    );
    // Not reported as a success the model would have to explain later, and not
    // as a recording either: its own install ran and failed the same way.
    assert.match(stdout, /EXIT:1/);
    assert.doesNotMatch(stdout, /already running in the background/);
    assert.equal(await npmRuns(), 2);
  });
});

/**
 * The failure that made replaying one a bad idea. A full disk is the one an
 * install can fix from inside the sandbox — the npm cache and the project share
 * 1.1G — and the fix is worth nothing if the retry never runs.
 */
test('an install the warmup lost to a full disk is retried, not replayed', async () => {
  await withProject(async ({ dir, base, sh, npmRuns, cacheCleans, failWith }) => {
    await failWith('npm warn tar TAR_ENTRY_ERROR ENOSPC: no space left on device, write\n');
    await sh(buildNpmWarmupCommand(base));
    await sh(buildNpmWarmupWaitScript(base));

    // The disk has room again, which is the whole point: nothing about the
    // project changed, so a replay would report the same failure forever.
    await rm(path.join(dir, 'npm.exit'));
    await rm(path.join(dir, 'npm.stdout'));

    const { stdout } = await sh(
      [buildNpmWarmupHandoffScript(base), 'npm install; echo EXIT:$?'].join('\n'),
    );
    // The model's install ran, so a disk with room again installs now.
    assert.match(stdout, /EXIT:0/, 'the retry never ran');
    assert.equal(await npmRuns(), 2);
    // Once by the warmup, once by the retry that read ENOSPC in its log.
    assert.equal(await cacheCleans(), 2);

    // The record is gone too, so a later install is not answered from it.
    await sh([buildNpmWarmupHandoffScript(base), 'npm install; echo EXIT:$?'].join('\n'));
    assert.equal(await npmRuns(), 3);
  });
});

/**
 * The path that was filling the disk after the warmup stopped doing it. A turn
 * that never rewrites package.json gets no warmup, so nothing had reclaimed
 * anything by the time the model's own install left 494M of cache behind — and
 * the measured session went on to fail for want of exactly that room.
 */
test('an install the model ran itself still gives the cache back', async () => {
  await withProject(async ({ base, sh, npmRuns, cacheCleans }) => {
    const { stdout } = await sh([
      buildNpmWarmupHandoffScript(base),
      'npm install; echo EXIT:$?',
      buildNpmCacheReclaimScript(),
    ].join('\n'));

    // No warmup ran, so this install is the only one and it is the model's.
    assert.equal(await npmRuns(), 1);
    assert.doesNotMatch(stdout, /already running in the background/);
    assert.equal(await cacheCleans(), 1);
  });
});

// A full disk is what stops `npm cache clean` from writing, and it runs after
// the marker the sandbox reads the exit code from. Left unguarded it would
// take the whole output down with it — costing the model the install log at
// the one moment the log is the only way out.
test('a cache reclaim that cannot run costs the install nothing', async () => {
  await withProject(async ({ dir, base, sh }) => {
    // Fails whatever it is asked to do, cache clean included.
    await writeFile(path.join(dir, 'npm.exit'), '1\n');
    await writeFile(path.join(dir, 'bin', 'npm'), '#!/bin/sh\necho "npm error code ENOSPC"\nexit 1\n', { mode: 0o755 });

    const { stdout } = await sh([
      buildNpmWarmupHandoffScript(base),
      withExitCodeEcho('npm install'),
      buildNpmCacheReclaimScript(),
    ].join('\n'));

    assert.match(stdout, /ENOSPC/, 'the install output did not survive the reclaim');
    assert.match(stdout, /EXIT:1/, 'the install exit code did not survive the reclaim');
  });
});

// The warmup ran a bare install, so it can answer another one — and nothing
// else. An install naming a package must reach npm: answering it from the
// warmup reports success for a package that is still not in the tree, and the
// lie surfaces much later as an import that cannot resolve.
test('only an install that asks for nothing in particular can be answered', () => {
  assert.equal(isBareInstallCommand('npm install'), true);
  assert.equal(isBareInstallCommand('npm ci'), true);
  assert.equal(isBareInstallCommand('npm i --no-audit --no-fund'), true);
  assert.equal(isBareInstallCommand('cd projects/demo/app && npm install'), true);
  assert.equal(isBareInstallCommand('npm install && npm run build'), true);

  assert.equal(isBareInstallCommand('npm install @tanstack/react-start@latest'), false);
  assert.equal(isBareInstallCommand('npm i -D typescript'), false);
  assert.equal(isBareInstallCommand('npm install --save-dev vitest'), false);
  assert.equal(isBareInstallCommand('pip install -r requirements.txt'), false);
  assert.equal(isBareInstallCommand('npm run build'), false);
});

// A scaffolder installs as it goes, so it contends for node_modules like an
// install and has to be sequenced like one — but it is never answered from the
// warmup, because the files it writes are the whole reason to run it.
test('a scaffolder is sequenced like an install and never stands in for one', () => {
  for (const command of [
    'npm create vite@latest . -- --template react-ts',
    'npm create @tanstack/start@latest .',
    'npx create-next-app@latest . --yes',
    'npx -y create-vite my-app',
    'pnpm create svelte@latest .',
    'yarn create react-app .',
  ]) {
    assert.equal(isScaffolderCommand(command), true, command);
    // Routed to the wait, not to the replay.
    assert.equal(isBareInstallCommand(command), false, command);
    // And its exit code has to survive, like every other install's.
    assert.match(withExitCodeEcho(command), /; echo EXIT:\$\?$/, command);
  }

  assert.equal(isScaffolderCommand('npm install'), false);
  assert.equal(isScaffolderCommand('npm run build'), false);
  // The name only counts as a scaffolder when it is what runs.
  assert.equal(isScaffolderCommand('echo "npm create vite"'), false);
});

test('a package.json that moved sends the install back to npm', async () => {
  await withProject(async ({ dir, base, sh, npmRuns }) => {
    await sh(buildNpmWarmupCommand(base));
    await sh(buildNpmWarmupWaitScript(base));
    // The model added a dependency after the warmup read the file.
    await writeFile(path.join(dir, 'package.json'), '{"name":"probe","dependencies":{"x":"1"}}\n');

    const { stdout } = await sh(
      [buildNpmWarmupHandoffScript(base), 'npm install; echo EXIT:$?'].join('\n'),
    );
    assert.doesNotMatch(stdout, /already running in the background/);
    // Two runs total, in sequence — never at the same time.
    assert.equal(await npmRuns(), 2);
  });
});

test('a second warmup is not started beside the first', async () => {
  await withProject(async ({ base, sh, npmRuns }) => {
    await sh(buildNpmWarmupCommand(base));
    // package.json is written again while the first warmup is still running.
    await sh(buildNpmWarmupCommand(base));
    await sh(buildNpmWarmupWaitScript(base));
    assert.equal(await npmRuns(), 1);
  });
});

test('an already-installed project is not warmed up at all', async () => {
  await withProject(async ({ dir, base, sh, npmRuns }) => {
    await mkdir(path.join(dir, 'node_modules'));
    await sh(buildNpmWarmupCommand(base));
    assert.equal(await npmRuns(), 0);
    // And nothing is left behind for the handoff to match against.
    await assert.rejects(() => readFile(`${base}.pid`, 'utf8'));
  });
});
