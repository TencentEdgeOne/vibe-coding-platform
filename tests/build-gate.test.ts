import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PRODUCTION_BUILD_DEFERRED,
  runVerification,
} from '../agents/project/_scaffold.ts';
import { projectState } from './helpers/fixtures.ts';

const state = projectState();

/**
 * The sandbox as `runVerification` uses it: a lint script it writes and runs, a
 * package.json probe, and the build itself. Every command is recorded so a test
 * can assert on the one that did not run.
 */
function fakeSandbox(options: {
  packageJson?: boolean;
  buildScript?: boolean;
  buildFails?: boolean;
  declaredBuild?: string;
  declaredBuildFails?: boolean;
} = {}) {
  const commands: string[] = [];
  const context = {
    sandbox: {
      files: {
        write: async () => undefined,
        exists: async (target: string) => options.packageJson !== false
          && target.endsWith('package.json'),
        makeDir: async () => undefined,
      },
      commands: {
        run: async (command: string) => {
          commands.push(command);
          if (command.includes('makers-compat-check')) {
            return { exitCode: 0, stdout: 'Makers compatibility lint passed\nEXIT:0', stderr: '' };
          }
          if (command.includes('p.scripts.build')) {
            return { exitCode: 0, stdout: options.buildScript === false ? 'no' : 'yes', stderr: '' };
          }
          if (command.includes('c.buildCommand')) {
            return { exitCode: 0, stdout: options.declaredBuild || '', stderr: '' };
          }
          if (options.declaredBuild && command.includes(options.declaredBuild)) {
            return options.declaredBuildFails
              ? { exitCode: 0, stdout: 'EXIT:1', stderr: 'Error: module "theme" not found' }
              : { exitCode: 0, stdout: 'Total in 84 ms\nEXIT:0', stderr: '' };
          }
          if (command.includes('npm run build')) {
            return options.buildFails
              ? { exitCode: 0, stdout: 'EXIT:1', stderr: 'Type error in app/page.tsx' }
              : { exitCode: 0, stdout: 'compiled successfully\nEXIT:0', stderr: '' };
          }
          // The Python probe reads stdout raw, so it has to come back empty:
          // anything at all here reads as "this project has Python sources".
          if (command.includes("-name '*.py'")) {
            return { exitCode: 0, stdout: '', stderr: '' };
          }
          return { exitCode: 0, stdout: 'EXIT:0', stderr: '' };
        },
      },
    },
  };
  return { context, commands, ran: (fragment: string) => commands.some((c) => c.includes(fragment)) };
}

// The turn this exists for: the user changed a line of copy, the preview picked
// it up, and the old flow still spent up to ten minutes rebuilding the project
// from scratch before it would say anything.
test('a verified preview stands in for the production build', async () => {
  const sandbox = fakeSandbox();
  const build = await runVerification(sandbox.context, state, { previewVerified: true });

  assert.equal(build.status, 'success');
  assert.equal(sandbox.ran('npm run build'), false);
  assert.match(build.stdout || '', /Skipped the production build/);
  // The lint is not what got skipped. It is the gate that catches the adapter,
  // and it costs seconds rather than minutes.
  assert.equal(sandbox.ran('makers-compat-check'), true);
  assert.match(build.stdout || '', /compatibility lint passed/);
});

// Without a preview there is no other evidence that the project assembles, so
// the build is the gate rather than a second opinion.
test('no preview means the build runs', async () => {
  const sandbox = fakeSandbox();
  const build = await runVerification(sandbox.context, state);

  assert.equal(build.status, 'success');
  assert.equal(sandbox.ran('npm run build'), true);
  assert.doesNotMatch(build.stdout || '', /Skipped the production build/);
});

test('a build that fails still fails the turn', async () => {
  const sandbox = fakeSandbox({ buildFails: true });
  const build = await runVerification(sandbox.context, state);

  assert.equal(build.status, 'failed');
  assert.match(build.stderr || '', /Type error/);
});

test('a project with no build script needs neither', async () => {
  const sandbox = fakeSandbox({ buildScript: false });
  const build = await runVerification(sandbox.context, state, { previewVerified: true });

  assert.equal(build.status, 'success');
  assert.equal(sandbox.ran('npm run build'), false);
});

// The skip has to explain itself to the model, which sees this text and would
// otherwise read a green verification as proof the deployment will succeed.
test('the skip says where the real build still happens', () => {
  assert.match(PRODUCTION_BUILD_DEFERRED, /Publishing runs the real build/);
  assert.match(PRODUCTION_BUILD_DEFERRED, /bundling and prerendering/);
});

// Hugo is a Go binary, Jekyll a Ruby one: no package.json, no npm build script,
// and until this branch existed they reached the end of verification with
// nothing checked and passed for having nothing to check.
test('a generator with no package.json is verified by the build it declares', async () => {
  const sandbox = fakeSandbox({ packageJson: false, declaredBuild: 'hugo --minify' });
  const build = await runVerification(sandbox.context, state);

  assert.equal(build.status, 'success');
  assert.equal(sandbox.ran('hugo --minify'), true);
  assert.match(build.stdout || '', /Total in 84 ms/);
});

test('a declared build that fails fails the turn', async () => {
  const sandbox = fakeSandbox({
    packageJson: false,
    declaredBuild: 'hugo --minify',
    declaredBuildFails: true,
  });
  const build = await runVerification(sandbox.context, state);

  assert.equal(build.status, 'failed');
  assert.match(build.stderr || '', /module "theme" not found/);
});

// The same deferral as npm: a preview that came up already ran the generator.
test('a verified preview stands in for the declared build too', async () => {
  const sandbox = fakeSandbox({ packageJson: false, declaredBuild: 'hugo --minify' });
  const build = await runVerification(sandbox.context, state, { previewVerified: true });

  assert.equal(build.status, 'success');
  assert.equal(sandbox.ran('hugo --minify'), false);
});

// A package.json whose scripts have no build still falls through to whatever
// edgeone.json declares, rather than stopping at the missing npm script.
test('a declared build is found even when package.json has no build script', async () => {
  const sandbox = fakeSandbox({ buildScript: false, declaredBuild: 'vite build' });
  const build = await runVerification(sandbox.context, state);

  assert.equal(build.status, 'success');
  assert.equal(sandbox.ran('vite build'), true);
});

test('a project that declares no build at all is told what to declare', async () => {
  const sandbox = fakeSandbox({ packageJson: false });
  const build = await runVerification(sandbox.context, state);

  assert.equal(build.status, 'success');
  assert.match(build.stdout || '', /buildCommand and outputDirectory in edgeone\.json/);
});

// The value reaches a shell, and nothing legitimate spans lines.
test('a multi-line buildCommand is refused rather than run', async () => {
  const sandbox = fakeSandbox({
    packageJson: false,
    declaredBuild: 'hugo --minify\nrm -rf /',
  });
  const build = await runVerification(sandbox.context, state);

  assert.equal(build.status, 'success');
  assert.equal(sandbox.ran('rm -rf /'), false);
  assert.match(build.stdout || '', /Nothing declared a build/);
});
