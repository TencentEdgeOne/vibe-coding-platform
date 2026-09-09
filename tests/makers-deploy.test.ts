import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  DEPLOY_DISK_FULL,
  DEPLOY_EMPTY_ASSETS,
  DEPLOY_PARSE_FAILURE,
  MAKERS_DEPLOY_ALIVE_MARKER,
  MAKERS_DEPLOY_EMPTY_ASSETS_MARKER,
  buildMakersDeployCommand,
  buildMakersDeployLaunchCommand,
  buildMakersDeployPollCommand,
  buildMakersDeployReadCommand,
  describeMakersDeployment,
  diagnoseMakersDeployFailure,
  formatMakersDeployFailure,
  isMakersDeployUrl,
  parseMakersDeployExitCode,
  parseMakersDeployJson,
  parseMakersDeployProgress,
  readMakersDeployOutcome,
  redactSecret,
} from '../shared/makers-deploy.ts';
import { shellQuote } from '../shared/shell.ts';
import { resolveMakersProjectName } from '../agents/project/_makers-deploy.ts';
import { projectState } from './helpers/fixtures.ts';

test('builds a non-interactive direct CLI deploy command', () => {
  const production = buildMakersDeployCommand('vibe-coding-playground');
  const preview = buildMakersDeployCommand('demo', 'edgeone makers deploy -e preview');
  assert.match(production, /edgeone makers deploy -n 'vibe-coding-playground' --json/);
  assert.match(preview, /edgeone makers deploy -n 'demo' --json -e preview/);
  assert.match(production, /MAKERS_DEPLOY_EXIT:\$deploy_status/);
  assert.match(production, /exit 0/);
});

// The quota the publish has to fit in holds one project, and a Next build asks
// for three trees at once: the dev server's .next, the production .next written
// beside it, and the copy of that one that goes into .next/standalone/.next.
// The publish died on the quota and reported the file it could not write, so
// nothing in its output named the cause — the fix was deleting .next by hand.
test('the dev server build output is reclaimed between the stop and the build', () => {
  const command = buildMakersDeployCommand('vibe-coding-playground', '', {
    stopDevPort: 8088,
  });

  // The invocation, not the shell function the stop script defines above it.
  const stopped = command.lastIndexOf('stop_makers_dev');
  const reclaimed = command.indexOf('rm -rf .next');
  const built = command.indexOf('edgeone makers deploy -n');
  assert.ok(reclaimed !== -1, '.next is never reclaimed');
  // Both ends of the window matter. Earlier, and it is the race the stop exists
  // to avoid: a dev server still flushing writes the directory back. Later, and
  // it deletes what was just published.
  assert.ok(stopped < reclaimed, 'the reclaim must not run while the dev server is up');
  assert.ok(reclaimed < built, 'the reclaim must not run after the build');

  // Relative to the project cwd. An absolute path would depend on a directory
  // this builder is never given, so it could only be guessed at.
  assert.doesNotMatch(command, /rm -rf \S*\/\.next/);
});

// The CLI clears .edgeone/assets before it builds, but nothing clears the
// cloud-functions tree beside it, so an SSR bundle from an earlier build
// survives into this publish. Two builds of the same source do not agree on
// content hashes, so the surviving bundle renders HTML pointing at filenames
// this build never emitted, and the site 404s on every one of them.
test('the platform output tree is reclaimed before the build, not just Next', () => {
  const command = buildMakersDeployCommand('vibe-coding-playground', '', {
    stopDevPort: 8088,
  });

  const stopped = command.lastIndexOf('stop_makers_dev');
  const reclaimed = command.indexOf('rm -rf .edgeone');
  const built = command.indexOf('edgeone makers deploy -n');
  assert.ok(reclaimed !== -1, '.edgeone is never reclaimed');
  assert.ok(stopped < reclaimed, 'the reclaim must not run while the dev server is up');
  assert.ok(reclaimed < built, 'the reclaim must not run after the build');

  // .edgeone is what gets uploaded, so reclaiming it after the publish would
  // delete the tree that was just sent rather than the one left from last time.
  assert.ok(
    command.indexOf('rm -rf .edgeone') < command.indexOf('MAKERS_DEPLOY_EXIT'),
    'the reclaim must not run after the upload',
  );
  assert.doesNotMatch(command, /rm -rf \S+\/\.edgeone/);
});

// The two trees above are what an earlier publish left behind. The cache is
// what an install left behind, it is the largest of the three, and the publish
// was the one path that never gave it back: the warmup reclaims its own, and so
// does an install the model ran, but the one ensureProjectDependencies runs when
// a resumed conversation finds no node_modules does not. That publish starts
// with 460M of tarballs on a 1.1G disk and a build that wants three copies of
// one dependency tree.
test('the npm cache is given back before the build, not after the upload', () => {
  const command = buildMakersDeployCommand('vibe-coding-playground', '', {
    stopDevPort: 8088,
  });

  const reclaimed = command.indexOf('npm cache clean --force');
  const built = command.indexOf('edgeone makers deploy -n');
  assert.ok(reclaimed !== -1, 'the npm cache is never reclaimed');
  assert.ok(reclaimed < built, 'reclaiming after the build frees nothing the build needed');

  // A full disk is exactly what stops `npm cache clean` from writing, so the
  // one publish that most needs the room cannot be the one this aborts.
  assert.match(command, /npm cache clean --force[^\n]*\|\| true/);
});

// ENOSPC arrives naming the single file the CLI could not copy, which says
// nothing about which tree held the space. Reading that report left three
// possibilities — the cache came back, a sibling conversation kept its
// node_modules, or one build genuinely does not fit — and no way to choose.
test('a publish that ran out of disk measures the disk before reporting', () => {
  const command = buildMakersDeployCommand('vibe-coding-playground');

  const reported = command.indexOf('--- disk at failure ---');
  assert.ok(reported !== -1, 'a full disk is never measured');
  assert.ok(
    command.indexOf('deploy_status=$?') < reported,
    'the report must read the exit code the CLI actually returned',
  );

  // Reactive on both counts: du over a 422M tree costs a second, and a publish
  // that failed for some other reason is not a disk report.
  assert.match(command, /if \[ "\$deploy_status" != 0 \] && grep -q ENOSPC/);

  // The four questions, and the sibling conversations reached through cwd
  // rather than through an absolute path that would outlive the layout.
  assert.match(command, /df -h \./);
  assert.match(command, /du -sh node_modules \.next \.edgeone "\$HOME\/\.npm"/);
  assert.match(command, /du -sh \.\.\/\.\.\/\*/);
  assert.doesNotMatch(command, /\/home\/user\/projects/);
});

// A publish is judged on the upload, and the upload succeeds whether or not
// anything was built into it. The check has to look at the tree.
test('the publish is checked for a client build, not just for an exit code', () => {
  const command = buildMakersDeployCommand('vibe-coding-playground');

  const checked = command.indexOf('.edgeone/assets');
  assert.ok(checked !== -1, 'the published assets are never checked');
  assert.ok(
    command.indexOf('deploy_status=$?') < checked,
    'the check must read the exit code the CLI actually returned',
  );
  // The CLI writes this file itself after the build, so it is in the directory
  // whether or not a client bundle is, and counting it would pass every time.
  assert.match(command, /! -name '\.edgeone-assets-config\.json'/);
  // A failed publish already reports its own cause; re-reporting it as a
  // missing client build would name the wrong one.
  assert.match(command, /if \[ "\$deploy_status" = 0 \]/);
});

test('parses captured direct CLI deploy exit codes', () => {
  assert.equal(parseMakersDeployExitCode('log\nMAKERS_DEPLOY_EXIT:1\n'), 1);
  assert.equal(parseMakersDeployExitCode('MAKERS_DEPLOY_EXIT:0\n'), 0);
  assert.equal(parseMakersDeployExitCode('no marker'), undefined);
});

test('parses --json success from the last JSON line', () => {
  const parsed = parseMakersDeployJson([
    '[cli] Deploying...',
    '{"status":"success","url":"https://vibe-coding-playground.edgeone.cool?eo_token=abc","projectId":"makers-1","deploymentId":"dp-1"}',
  ].join('\n'));
  assert.equal(parsed.status, 'success');
  if (parsed.status !== 'success') return;
  assert.equal(parsed.url, 'https://vibe-coding-playground.edgeone.cool?eo_token=abc');
  assert.equal(parsed.projectId, 'makers-1');
});

test('parses --json error without treating earlier log lines as the result', () => {
  const parsed = parseMakersDeployJson(
    'building...\n{"status":"error","error":"Project name conflict"}',
  );
  assert.deepEqual(parsed, {
    status: 'error',
    error: 'Project name conflict',
  });
});

test('falls back to EDGEONE_DEPLOY_URL text output', () => {
  const parsed = parseMakersDeployJson(
    '[cli][✔] Deploy Success\nEDGEONE_DEPLOY_URL=https://demo.edgeone.cool?eo_token=keep-me\n',
  );
  assert.equal(parsed.status, 'success');
  if (parsed.status !== 'success') return;
  assert.equal(parsed.url, 'https://demo.edgeone.cool?eo_token=keep-me');
});

test('detects Makers deploy hosts and rejects sandbox /preview/ URLs', () => {
  assert.equal(
    isMakersDeployUrl('https://vibe-coding-playground.edgeone.cool?eo_token=1'),
    true,
  );
  assert.equal(
    isMakersDeployUrl('https://sandbox.example.com/preview/?access_token=1'),
    false,
  );
  assert.equal(isMakersDeployUrl('not a url'), false);
});

test('redacts secrets from CLI output', () => {
  assert.equal(redactSecret('edgeone makers deploy -t secret-token --json', 'secret-token'), 'edgeone makers deploy -t [redacted] --json');
});

test('parses quota errors from CLI text when --json is missing', () => {
  const parsed = parseMakersDeployJson(
    '[cli][✘] Error creating pages project: Error: Makers project exceeds 40 limit\n',
  );
  assert.deepEqual(parsed, {
    status: 'error',
    error: 'Makers project exceeds 40 limit',
  });
});

test('formatMakersDeployFailure tells the model not to delete other projects', () => {
  const message = formatMakersDeployFailure(
    '{"status":"error","error":"Makers project exceeds 40 limit"}',
  );
  assert.match(message, /exceeds 40 limit/);
  assert.match(message, /Do not delete other Makers projects/);
});

// A publish that fails before the CLI reaches its --json result used to be
// reported as "did not return a parseable --json result" and nothing else,
// which names no cause and leaves the output that did name one unread.
test('an unparseable deploy is reported from what the CLI actually printed', () => {
  const outcome = readMakersDeployOutcome([
    '[cli] Preparing deployment...',
    '[cli] Uploading 42 files',
    "[cli][✘] Error: project 'vibe-coding-abc1234567' is not a direct upload project",
    'MAKERS_DEPLOY_EXIT:1',
  ].join('\n'));

  assert.equal(outcome.status, 'error');
  if (outcome.status !== 'error') return;
  assert.match(outcome.error, /not a direct upload project/);
  assert.notEqual(outcome.error, DEPLOY_PARSE_FAILURE);
  assert.equal(outcome.exitCode, 1);
  // The surrounding log is what turns one complaint into a diagnosis.
  assert.match(outcome.detail || '', /Uploading 42 files/);
  // Bookkeeping the wrapper added, not something the CLI said.
  assert.doesNotMatch(outcome.detail || '', /MAKERS_DEPLOY_EXIT/);
});

// CLIs print progress and failures to one stream and do not reliably end on the
// failure, so the last line is the wrong thing to quote.
test('the reported line is the complaint, not whatever came last', () => {
  const { error } = diagnoseMakersDeployFailure([
    '[cli][✘] Error: authentication rejected',
    '[cli] Done in 3.2s',
  ].join('\n'));
  assert.match(error, /authentication rejected/);
});

// A real failed publish, as the CLI printed it. A build fails inside-out: the
// cause comes first and every layer above restates it as an exit code, so the
// last complaint on screen is the one that explains least. Reporting it named
// nothing, and the colour codes around it survived into the message because a
// browser renders the escape itself as nothing.
test('a build failure is reported from its cause, not the wrappers around it', () => {
  const app = '/home/user/projects/3a462b0e-f658-4c71-919c-9b8ae8648b6d/app';
  const outcome = readMakersDeployOutcome([
    '[builder] Installing dependencies',
    '[builder] > next build',
    '   Creating an optimized production build ...',
    ' ✓ Compiled successfully',
    `Error: ENOENT: no such file or directory, copyfile '${app}/.next/routes-manifest.json' -> '${app}/.next/standalone/.next/routes-manifest.json'`,
    '    at async Object.copyFile (node:internal/fs/promises:621:10)',
    `    at async writeStandaloneDirectory (${app}/node_modules/next/dist/build/index.js:223:5)`,
    '{',
    '  errno: -2,',
    "  code: 'ENOENT',",
    "  syscall: 'copyfile',",
    '}',
    '[builder] "npm run build" execute time: 18721ms',
    '[builder] "npm run build" failed, exit code: 1',
    '[builder] ✗ Build project failed after 18.72s',
    '\u001B[90m[StaticAssetsBuilder]\u001B[0m\u001B[31m[✘] \u001B[0mCommand failed with code 1',
    'MAKERS_DEPLOY_EXIT:1',
  ].join('\n'));

  assert.equal(outcome.status, 'error');
  if (outcome.status !== 'error') return;
  assert.match(outcome.error, /ENOENT.*routes-manifest\.json/);
  assert.doesNotMatch(outcome.error, /Command failed with code 1/);
  // Invisible in a terminal, but the bracket codes read as message text in HTML.
  assert.doesNotMatch(outcome.error, /\u001B|\[90m|\[31m|\[0m/);
  assert.doesNotMatch(outcome.detail || '', /\u001B|\[90m/);
  // The errno block is what distinguishes this from every other build failure.
  assert.match(outcome.detail || '', /syscall: 'copyfile'/);
  // Still worth keeping: they say the build step was what failed.
  assert.match(outcome.detail || '', /Build project failed/);
});

// Slicing a character budget off the end of a joined log cuts whatever line
// straddles the boundary, which is how "copyfile '/home/..." reached a user as
// "ile '/home/...".
test('a long log is trimmed on line boundaries, around the cause', () => {
  const noise = Array.from({ length: 200 }, (_, i) => `[builder] compiling module ${i}`);
  const { error, detail = '' } = diagnoseMakersDeployFailure([
    ...noise,
    "Error: ENOENT: no such file or directory, copyfile '/home/user/app/.next/routes-manifest.json'",
    ...Array.from({ length: 40 }, (_, i) => `    at frame ${i}`),
    '[builder] ✗ Build project failed after 18.72s',
    'MAKERS_DEPLOY_EXIT:1',
  ].join('\n'), '', 1);

  assert.match(error, /ENOENT/);
  // The cause survives the trim, whole, with the lead-in that located it.
  assert.match(detail, /copyfile '\/home\/user\/app\/\.next\/routes-manifest\.json'/);
  assert.match(detail, /compiling module 199/);
  for (const line of detail.split('\n')) {
    assert.ok(
      line.startsWith('…') || noise.includes(line) || /^(at frame|Error: ENOENT|\[builder\])/.test(line),
      `trimmed mid-line: ${JSON.stringify(line)}`,
    );
  }
  assert.match(detail, /… \d+ earlier lines omitted …/);
});

// The build succeeded. The line the picker found is the right line and still
// the wrong thing to report: handed a failed copyfile, the model reads it as a
// defect in the project and starts editing files, which frees nothing and
// spends the working build it already had. The same shape as a lint rule
// rejecting the anchors the host mandates — a failure whose text points at the
// wrong thing gets repaired at the wrong thing.
test('a publish that ran out of disk is reported as the disk, not as the file', () => {
  const { error, detail = '' } = diagnoseMakersDeployFailure([
    '[builder] "npm run build" executed successfully',
    '[StaticAssetsBuilder] ✓ Build project completed in 26.50s',
    "[plugins][✘] Error executing onBuild hook: ENOSPC: no space left on device, copyfile '/home/user/projects/aa/app/.next/standalone/node_modules/next/dist/compiled/conf/index.js' -> '/home/user/projects/aa/app/.edgeone/cloud-functions/ssr-node/node_modules/next/dist/compiled/conf/index.js'",
    '--- disk at failure ---',
    '/dev/vda1       1.1G  1.1G     0 100% /',
    '422M    node_modules',
    'MAKERS_DEPLOY_EXIT:1',
  ].join('\n'), '', 1);

  assert.equal(error, DEPLOY_DISK_FULL);
  // The build is the part a user is about to doubt, so the report says it was
  // fine before it says anything else.
  assert.match(error, /build finished successfully/);
  assert.match(error, /Do not edit project files/);
  // The measurement is the whole point of taking it, so it reaches the card
  // together with the line that triggered it.
  assert.match(detail, /ENOSPC/);
  assert.match(detail, /1\.1G  1\.1G     0 100%/);
  assert.match(detail, /422M {4}node_modules/);
});

// "none error in configuration file" is the EdgeOne config validator announcing
// that the config is clean, and reading it as a complaint reported the one line
// in the log asserting the deploy was fine as the reason it was not. The detail
// window then anchored on it, so the 42 lines below — the build, and whatever
// ended it — were trimmed away to keep the all-clear on screen.
test('a validator reporting no errors is not the reason a deploy failed', () => {
  const { error, detail = '' } = diagnoseMakersDeployFailure([
    ...Array.from({ length: 14 }, (_, i) => `[builder] npm install: fetching package ${i}`),
    '[builder] "npm install" executed successfully',
    'inited plugin manager',
    '> Start validating the configuration file:',
    'none error in configuration file',
    'End validating!',
    '[StaticAssetsBuilder] BuildScript: npm run build',
    ...Array.from({ length: 38 }, (_, i) => `[builder] compiled route ${i}`),
    // The three lines the CLI prints on a failed build step, verbatim, and all
    // three read as restatements — which is what left the validator's all-clear
    // as the last thing standing.
    '[builder] "npm run build" failed, exit code: 1',
    '[builder] ✗ Build project failed after 21.34s',
    '[StaticAssetsBuilder][✘] Command failed with code 1',
    'MAKERS_DEPLOY_EXIT:1',
  ].join('\n'), '', 1);

  assert.doesNotMatch(error, /none error in configuration file/);
  // Nothing here names a cause, so the honest report is the innermost
  // restatement: it at least says which step failed.
  assert.match(error, /npm run build" failed/);
  // The window follows the anchor, so the tail is what survives the trim now.
  assert.match(detail, /compiled route 37/);
  assert.doesNotMatch(detail, /npm install: fetching package/);
});

// A build the kernel killed prints nothing on its way out, so the exit code is
// the whole of the evidence. Reading 137 as one more "failed with code N"
// restatement discarded the only line saying the build never finished at all.
test('a build killed by a signal is reported as the kill, not as a wrapper', () => {
  const { error, detail = '' } = diagnoseMakersDeployFailure([
    'none error in configuration file',
    '[StaticAssetsBuilder] BuildScript: npm run build',
    ...Array.from({ length: 30 }, (_, i) => `[builder] compiled route ${i}`),
    '[builder] "npm run build" failed, exit code: 137',
    '[builder] ✗ Build project failed after 21.34s',
    '[StaticAssetsBuilder][✘] Command failed with code 137',
    'MAKERS_DEPLOY_EXIT:1',
  ].join('\n'), '', 1);

  assert.match(error, /exit code: 137/);
  assert.doesNotMatch(error, /none error in configuration file/);
  assert.match(detail, /137/);
});

// A CLI that says nothing at all is itself the finding, and the exit code is
// the only fact left to report.
test('a silent deploy failure reports its exit code instead of a parse complaint', () => {
  const outcome = readMakersDeployOutcome('MAKERS_DEPLOY_EXIT:137\n');
  assert.equal(outcome.status, 'error');
  if (outcome.status !== 'error') return;
  assert.match(outcome.error, /exited with code 137 without printing a result/);
  assert.equal(outcome.detail, undefined);
});

// The URL is only trustworthy when the payload and the exit code agree, and
// when they do not, the success payload is the last thing to quote as a reason.
test('a success payload with a non-zero exit is reported as the disagreement it is', () => {
  const outcome = readMakersDeployOutcome([
    '{"status":"success","url":"https://demo.edgeone.cool","projectId":"makers-1"}',
    'MAKERS_DEPLOY_EXIT:1',
  ].join('\n'));

  assert.equal(outcome.status, 'error');
  if (outcome.status !== 'error') return;
  assert.match(outcome.error, /printed a success result but exited with code 1/);
  assert.doesNotMatch(outcome.error, /demo\.edgeone\.cool/);
  assert.match(outcome.detail || '', /demo\.edgeone\.cool/);
});

// The one failure the CLI cannot see. It clears .edgeone/assets before the
// build and afterwards asks only whether the directory exists, so an adapter
// that creates it and copies nothing in leaves the fallback skipped and the
// static layer empty. Everything downstream agrees the publish worked: the
// upload had a tree to send, the payload says success, the exit code is 0. The
// site serves its SSR routes and 404s every script and stylesheet they name.
test('a publish that shipped no client build is not a successful deploy', () => {
  const outcome = readMakersDeployOutcome([
    '[StaticAssetsBuilder] ✓ Build project completed in 4.50s',
    '[StaticAssetsBuilder] MoveProjectToAssets time: 0ms',
    '[cli][✔] Deploy Success',
    '{"status":"success","url":"https://demo.edgeone.cool","projectId":"makers-1"}',
    MAKERS_DEPLOY_EMPTY_ASSETS_MARKER,
    'MAKERS_DEPLOY_EXIT:0',
  ].join('\n'));

  assert.equal(outcome.status, 'error');
  if (outcome.status !== 'error') return;
  assert.equal(outcome.error, DEPLOY_EMPTY_ASSETS);
  // The URL resolves and renders, which is what makes it the wrong thing to
  // hand back: it looks like a working site until the first asset loads.
  assert.doesNotMatch(outcome.error, /demo\.edgeone\.cool/);
});

// The marker is wrapper bookkeeping like the exit code, so it belongs in
// neither the reason nor the log window quoted beside it.
test('the empty-assets marker is not quoted back as CLI output', () => {
  const outcome = readMakersDeployOutcome([
    '[builder] "npm run build" executed successfully',
    "[cli][✘] Error: project 'demo' is not a direct upload project",
    MAKERS_DEPLOY_EMPTY_ASSETS_MARKER,
    'MAKERS_DEPLOY_EXIT:1',
  ].join('\n'));

  assert.equal(outcome.status, 'error');
  if (outcome.status !== 'error') return;
  assert.doesNotMatch(outcome.error, /MAKERS_DEPLOY_EMPTY_ASSETS/);
  assert.doesNotMatch(outcome.detail || '', /MAKERS_DEPLOY_EMPTY_ASSETS/);
  // A publish that failed on its own terms reports that, not the tree it left.
  assert.match(outcome.error, /not a direct upload project/);
});

// When the CLI phrases its own failure, the raw log beside it is the same
// sentence twice.
test('a CLI that phrased its own failure carries no raw log', () => {
  const outcome = readMakersDeployOutcome(
    '{"status":"error","error":"Project name conflict"}\nMAKERS_DEPLOY_EXIT:1\n',
  );
  assert.equal(outcome.status, 'error');
  if (outcome.status !== 'error') return;
  assert.equal(outcome.error, 'Project name conflict');
  assert.equal(outcome.detail, undefined);
});

// The detail is raw CLI output, which is exactly where a credential would show
// up if one leaked into the log.
test('the credential is redacted from the diagnosis as well as the reason', () => {
  const outcome = readMakersDeployOutcome(
    '[cli][✘] Error: token sub-token-value rejected\nMAKERS_DEPLOY_EXIT:1\n',
    '',
    'sub-token-value',
  );
  assert.equal(outcome.status, 'error');
  if (outcome.status !== 'error') return;
  assert.doesNotMatch(outcome.error, /sub-token-value/);
  assert.doesNotMatch(outcome.detail || '', /sub-token-value/);
  assert.match(outcome.detail || '', /\[redacted\]/);
});

// The model's command tool and the deploy button both publish. One reading of
// the CLI output keeps them from disagreeing about whether the site is live.
test('one reading of the CLI output serves both ways of publishing', () => {
  const startedAt = 1_700_000_000_000;
  const success = readMakersDeployOutcome([
    '[cli] Deploying...',
    '{"status":"success","url":"https://demo.edgeone.cool/?eo_token=keep-me","projectId":"makers-1","deploymentId":"dp-1"}',
    'MAKERS_DEPLOY_EXIT:0',
  ].join('\n'), '', 'keep-me');
  assert.deepEqual(success, {
    status: 'success',
    url: 'https://demo.edgeone.cool/?eo_token=keep-me',
    projectId: 'makers-1',
    deploymentId: 'dp-1',
  });
  assert.deepEqual(describeMakersDeployment(success, { startedAt, finishedAt: startedAt + 5 }), {
    status: 'success',
    startedAt,
    finishedAt: startedAt + 5,
    url: 'https://demo.edgeone.cool/?eo_token=keep-me',
    projectId: 'makers-1',
    deploymentId: 'dp-1',
  });

  // A zero exit with an error payload, or a non-zero exit with a success
  // payload, are both failures: the URL is only trustworthy when they agree.
  const failed = readMakersDeployOutcome(
    '{"status":"error","error":"Failed to create pages project"}\nMAKERS_DEPLOY_EXIT:1\n',
  );
  assert.deepEqual(failed, {
    status: 'error',
    error: 'Failed to create pages project',
    exitCode: 1,
  });
  assert.equal(
    describeMakersDeployment(failed, { startedAt, finishedAt: startedAt + 5 }).error,
    'Failed to create pages project',
  );

  // A missing CLI is an image problem, not something to report as a bad deploy.
  assert.equal(
    readMakersDeployOutcome('sh: 1: edgeone: not found\nMAKERS_DEPLOY_EXIT:127\n').status,
    'cli-missing',
  );

  // The credential can appear in the log, but never in what is shown back.
  const leaked = readMakersDeployOutcome(
    '{"status":"error","error":"token sub-token-value rejected"}\nMAKERS_DEPLOY_EXIT:1\n',
    '',
    'sub-token-value',
  );
  assert.equal(leaked.status === 'error' && leaked.error.includes('sub-token-value'), false);
});

// Both CLI commands create the project when the lookup misses, and a tenant
// token only sees what its own tenant created. A name shared between
// conversations therefore misses on lookup and collides on create — preview
// never starts, and a deploy that did start would land on another user's site.
test('each conversation owns one project, for preview and deploy alike', () => {
  const first = projectState('projects/conversation-a');
  const second = projectState('projects/conversation-b');

  const name = resolveMakersProjectName({ env: {} }, first);
  assert.match(name, /^vibe-coding-[0-9a-f]{10}$/);
  assert.notEqual(name, resolveMakersProjectName({ env: {} }, second));
  // Stable without being stored: later turns have to reach the same project.
  assert.equal(resolveMakersProjectName({ env: {} }, projectState('projects/conversation-a')), name);
  // The conversation ID ends up in a public hostname, so it is hashed first.
  assert.doesNotMatch(name, /conversation-a/);

  // An operator who names the project explicitly gets exactly that name, and
  // with it the single shared project that implies.
  const pinned = { env: { MAKERS_DEPLOY_PROJECT_NAME: 'my-site' } };
  assert.equal(resolveMakersProjectName(pinned, first), 'my-site');
  assert.equal(resolveMakersProjectName(pinned, second), 'my-site');
});

// Preview and deploy write the same .edgeone/project.json. If they disagreed
// about the name, whichever ran first would pin the link file and the other
// would either be silently ignored or repoint it mid-conversation.
test('preview and deploy resolve the project through the same function', async () => {
  const [previewSource, commandSource] = await Promise.all([
    readFile('agents/project/_preview.ts', 'utf8'),
    readFile('agents/tools/_commands-wrap.ts', 'utf8'),
  ]);

  assert.match(previewSource, /resolveMakersProjectName\(context, state\)/);
  assert.match(commandSource, /resolveMakersProjectName\(lifecycle\.context, lifecycle\.state\)/);
  // One resolution per command, reused by both branches.
  assert.equal(commandSource.match(/resolveMakersProjectName\(/g)?.length, 1);
  for (const source of [previewSource, commandSource]) {
    assert.doesNotMatch(source, /vibe-coding-playground/);
  }
});

test('uses the sandbox-provided CLI without installing or prewarming it', async () => {
  const paths = [
    'shared/makers-deploy.ts',
    'agents/tools/_commands-wrap.ts',
    'agents/project/_makers-deploy.ts',
    'agents/project/_preview.ts',
    'agents/project/_scaffold.ts',
    'agents/pipelines/_chat.ts',
    'agents/pipelines/_resume.ts',
  ];
  const source = (await Promise.all(paths.map((path) => readFile(path, 'utf8')))).join('\n');

  assert.doesNotMatch(source, /npm install -g edgeone/);
  assert.doesNotMatch(source, /edgeone-cli-install/);
  assert.doesNotMatch(source, /prewarmEdgeoneCli|ensureEdgeoneCli/);
  assert.match(source, /edgeone makers deploy/);
  assert.match(source, /edgeone makers dev/);
  assert.doesNotMatch(source, /buildDeployToMakersTool|buildPublishPreviewTool/);
});

// `commands.run` resolves once, so a publish that is awaited cannot report on
// itself: the card held a spinner and no output for the whole build. The
// launcher returns as soon as the script is running, which is what leaves
// something for a caller to watch.
test('the publish can be started without being waited for', () => {
  const launch = buildMakersDeployLaunchCommand('vibe-coding-playground', '', {
    stopDevPort: 8088,
  });

  assert.match(launch, /nohup sh -c [\s\S]*> \/tmp\/makers-deploy\.log 2>&1 &/);
  assert.match(launch, /echo "\$!" > \/tmp\/makers-deploy\.pid/);
  // Truncated out here because a script cannot truncate the file its own
  // stdout is already open on.
  assert.ok(
    launch.indexOf('rm -f /tmp/makers-deploy.log') < launch.indexOf('nohup'),
    'the log is cleared after the run it belongs to has already started writing',
  );

  // The steps that make a publish fit on the disk belong to both assemblies,
  // and a launcher that quietly dropped one would publish a stale tree from a
  // sandbox that had room for it right up until it did not.
  for (const step of ['rm -rf .next', 'rm -rf .edgeone', 'npm cache clean --force']) {
    assert.ok(launch.includes(step), step);
  }
  assert.match(launch, /buildMakersDevStopScript|kill|fuser|pkill/);
});

test('a streamed publish writes where it is being read, and still reads itself back', () => {
  const streamed = buildMakersDeployLaunchCommand('demo');
  const blocking = buildMakersDeployCommand('demo');

  // The foreground assembly has no reader until it returns, so it collects and
  // reprints. The streamed one must not: redirected into the log it would be
  // invisible until the end, which is the whole failure being fixed.
  assert.match(blocking, /edgeone makers deploy[^\n]*> \/tmp\/makers-deploy\.log 2>&1/);
  assert.match(blocking, /^cat \/tmp\/makers-deploy\.log$/m);
  assert.doesNotMatch(streamed, /edgeone makers deploy[^\n]*> \/tmp\/makers-deploy\.log/);
  assert.doesNotMatch(streamed, /^cat \/tmp\/makers-deploy\.log$/m);

  // Both still end in the marker the exit code is read from, and both still
  // ask the log whether the disk was what failed.
  for (const source of [streamed, blocking]) {
    assert.match(source, /echo "MAKERS_DEPLOY_EXIT:\$deploy_status"/);
    assert.match(source, /grep -q ENOSPC \/tmp\/makers-deploy\.log/);
    assert.ok(source.includes(MAKERS_DEPLOY_EMPTY_ASSETS_MARKER));
  }
});

test('a poll reports liveness before the output it has not shown yet', () => {
  const poll = buildMakersDeployPollCommand();
  const aliveRead = poll.indexOf('kill -0');
  const tailRead = poll.indexOf('tail -c');

  // Read the other way round, a publish that exits between the two reads is
  // called finished while its last lines are still unseen.
  assert.ok(aliveRead >= 0 && tailRead > aliveRead, poll);
  assert.match(poll, new RegExp(MAKERS_DEPLOY_ALIVE_MARKER));
  // A window, not the file: this runs a few hundred times per publish.
  assert.match(poll, /tail -c 4000 .* \| tail -n 24/);

  // The verdict comes from the whole log instead, once.
  assert.match(buildMakersDeployReadCommand(), /^cat \/tmp\/makers-deploy\.log/m);
});

test('a poll payload splits into what to show and whether to keep watching', () => {
  const running = parseMakersDeployProgress(
    `Building...\n  ▲ Next.js 16\n\n${MAKERS_DEPLOY_ALIVE_MARKER}1\n`,
  );
  assert.equal(running.running, true);
  assert.equal(running.tail, 'Building...\n  ▲ Next.js 16');

  const finished = parseMakersDeployProgress(`done\n\n${MAKERS_DEPLOY_ALIVE_MARKER}0\n`);
  assert.equal(finished.running, false);
  assert.equal(finished.tail, 'done');

  // A malformed answer must not end the watch: the loop has its own deadline,
  // so believing this costs one round trip, and disbelieving it abandons a
  // publish that is still building.
  const garbled = parseMakersDeployProgress('half a line');
  assert.equal(garbled.running, true);
  assert.equal(garbled.tail, 'half a line');
});
