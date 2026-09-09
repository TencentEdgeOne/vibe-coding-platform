import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { presentToolActivity } from '../app/lib/tool-activity.ts';

// Publishing and generating both drive the same sandbox, so they share the one
// task slot: whichever starts first makes the other wait, and a refresh
// mid-publish reconnects through the stream the frontend already knows.
test('publishing occupies the chat task slot instead of a route of its own', async () => {
  const [tasks, route, resume, client] = await Promise.all([
    readFile('agents/_chat-tasks.ts', 'utf8'),
    readFile('agents/chat.ts', 'utf8'),
    readFile('agents/pipelines/_resume.ts', 'utf8'),
    readFile('app/features/workspace/workspace-api.ts', 'utf8'),
  ]);

  assert.match(tasks, /intent === 'deploy'[\s\S]*?runDeployPipeline/);
  assert.match(route, /body\?\.intent === 'deploy'/);
  assert.match(client, /\.\.\.\(options\.intent \? \{ intent: options\.intent \} : \{\}\)/);
  assert.match(resume, /streamUrl: `\/chat\?runId=/);
});

// The project, the credential and the target project are all decided before
// the button is even enabled, so there is nothing here for a model to choose.
test('the deploy pipeline publishes without the model in the loop', async () => {
  const pipeline = await readFile('agents/pipelines/_deploy.ts', 'utf8');

  assert.doesNotMatch(pipeline, /runCodingAgent|from '\.\.\/_agent'/);
  assert.match(pipeline, /projectName: resolveMakersProjectName\(context, state\),/);
  assert.match(pipeline, /buildMakersDeployLaunchCommand\(target\.projectName,/);
  assert.match(pipeline, /readMakersDeployOutcome\(stdout, '', sandboxToken\)/);
  // Same short-lived tenant credential as every other sandbox CLI call.
  assert.match(pipeline, /resolveSandboxMakersToken\(/);
  assert.match(pipeline, /buildSandboxMakersEnv\(sandboxToken\)/);
  // Nothing to publish is answered before the CLI is ever started.
  assert.match(pipeline, /if \(!files\.some\(\(item\) => item\.type === 'file'\)\)/);
  // The live URL is the deliverable, so the reply carries it in full.
  assert.match(pipeline, /withLiveDeploymentUrl\(copy\.success, outcome\.url\)/);
});

// The preview dev server and the deploy build write to the same directory, and
// the build loses: it fails on a file the dev server removed between writing it
// and copying it. Publishing stops the server first, and both ways of
// publishing get that from the one command builder rather than remembering to
// do it separately.
test('publishing stops the preview dev server before the build starts', async () => {
  const [deploy, dev, pipeline, wrapper] = await Promise.all([
    readFile('shared/makers-deploy.ts', 'utf8'),
    readFile('shared/makers-dev.ts', 'utf8'),
    readFile('agents/pipelines/_deploy.ts', 'utf8'),
    readFile('agents/tools/_commands-wrap.ts', 'utf8'),
  ]);

  // Stopping is part of the command, so it cannot be skipped by a caller.
  assert.match(deploy, /options\.stopDevPort \? \[buildMakersDevStopScript\(options\.stopDevPort\)\]/);
  for (const source of [pipeline, wrapper]) {
    assert.match(source, /stopDevPort: MAKERS_DEV_PORT/);
  }

  // The PID alone misses a framework server that outlived the CLI above it, and
  // the port alone depends on tools the sandbox image may not ship.
  assert.match(dev, /echo "\$dev_pid" > /);
  assert.match(dev, /pkill -TERM -P "\$stop_pid"/);
  assert.match(dev, /fuser -k \$\{makersPort\}\/tcp|fuser -k .*makersPort/);

  // Ordered: the stop has to precede the CLI, not follow it. Anchored on the
  // launch rather than on the log path that sits beside it — that path is a
  // filename, it has moved into a constant once already, and when it did this
  // assertion started passing a -1 around instead of saying so.
  const stopIndex = deploy.indexOf('buildMakersDevStopScript');
  const launchIndex = deploy.search(/\$\{launch\} >/);
  assert.ok(stopIndex >= 0, 'the stop script is never built into the command');
  assert.ok(launchIndex >= 0, 'the CLI launch is never redirected into a log');
  assert.ok(stopIndex < launchIndex, 'the stop must precede the CLI launch');
});

// Stopping the preview is a means, not an outcome. Both publishing paths bring
// it back, and neither reports a publish as failed because it did not come back.
test('publishing restarts the preview without paying for the smoke gates again', async () => {
  const [preview, pipeline, wrapper] = await Promise.all([
    readFile('agents/project/_preview.ts', 'utf8'),
    readFile('agents/pipelines/_deploy.ts', 'utf8'),
    readFile('agents/tools/_commands-wrap.ts', 'utf8'),
  ]);

  // The gates cost a real model call, and the project did not change.
  assert.match(preview, /const verifyRoutes = options\.verifyRoutes !== false/);
  assert.match(preview, /if \(verifyRoutes\) \{\s*await assertGeneratedRoutesReady/);
  for (const source of [pipeline, wrapper]) {
    assert.match(source, /startPreviewServer\([\s\S]{0,80}?verifyRoutes: false/);
  }

  // Restarted before the result is reported, so a failed publish still leaves a
  // preview to inspect.
  const restart = pipeline.indexOf('verifyRoutes: false');
  assert.ok(restart >= 0 && restart < pipeline.indexOf('readMakersDeployOutcome(stdout'));
  assert.ok(restart < pipeline.indexOf('if (commandError)'));
});

// Publishing stops the preview server, but nothing reloads the iframe, so the
// frame keeps showing a page whose server is gone and still looks live. The
// frame itself is left alone on purpose — a scrim over a page that still
// renders was more intrusive than the dead links it was covering for — so the
// refusal rides on the two controls that would otherwise walk into the stopped
// server.
test('a publish closes the routes out of the preview without covering it', async () => {
  const [screen, frame, controls, i18n] = await Promise.all([
    readFile('app/features/workspace/workspace-screen.tsx', 'utf8'),
    readFile('app/features/workspace/components/preview-frame.tsx', 'utf8'),
    readFile('app/features/workspace/components/preview-controls.tsx', 'utf8'),
    readFile('app/i18n.ts', 'utf8'),
  ]);

  // The frame is not told a publish is running, which is the whole of it: with
  // no publishing prop there is no state it could cover the page for, and the
  // loading and expired states it does own are unreachable from a publish.
  assert.ok(
    !frame.includes('publishing'),
    'the preview frame should not dim, blur, or block during a publish',
  );

  // Reconnecting during a publish fails and then blames an expired connection,
  // which is the one explanation that is not true here, so both routes out of
  // the frame are closed for the duration.
  assert.equal(controls.match(/disabled=\{publishing\}/g)?.length, 2);
  // An icon button says nothing on its own, so the refusal is named too — and it
  // is the accessible name, not only the tooltip.
  assert.match(controls, /const linkHint = publishing \? copy\.pausedForDeploy : ''/);
  assert.equal(controls.match(/aria-label=\{linkHint \|\| copy\.\w+\}/g)?.length, 2);

  // Only the controls are told, and the phrase is assembled for them alone.
  assert.match(screen, /<PreviewControls[\s\S]*?publishing=\{publishing\}/);
  assert.equal(screen.match(/pausedForDeploy: t\.workspace\.previewPausedForDeploy/g)?.length, 1);

  for (const language of ['zh', 'en']) {
    assert.ok(i18n.includes('previewPausedForDeploy'), language);
  }
  assert.equal(i18n.match(/previewPausedForDeploy:/g)?.length, 2);
});

// A failed publish is diagnosed from the CLI output, which only reaches the user
// if the pipeline forwards it. Discarding it here is what left a failed deploy
// showing one sentence that named no cause.
test('a failed publish shows the CLI output on the card and one line in the chat', async () => {
  const pipeline = await readFile('agents/pipelines/_deploy.ts', 'utf8');

  assert.match(pipeline, /await fail\(error, outcome\.status === 'error' \? outcome\.detail \?\? '' : ''\)/);
  // The CLI's own diagnosis is what gets reported. A watch that ran out only
  // speaks where the log named no cause, so "it never finished" can never
  // displace the line that says what actually broke.
  assert.match(pipeline, /timedOut && outcome\.error === DEPLOY_PARSE_FAILURE/);
  // The card has room to scroll; the reply and the deployment bar do not.
  assert.match(pipeline, /outputSummary: detail \|\| summarizeDeployError\(error\)/);
  assert.match(pipeline, /\$\{copy\.failedPrefix\}\$\{summarizeDeployError\(error\)\}/);
});

test('a publish reads as one row in the transcript, whoever started it', () => {
  // What the pipeline records for its own run.
  assert.equal(
    presentToolActivity({ name: 'commands', inputSummary: 'edgeone makers deploy' }).action,
    'Deploy project',
  );
  // What the model's command tool records for the same work.
  assert.equal(
    presentToolActivity({
      name: 'mcp__sandbox__commands',
      inputSummary: JSON.stringify({ command: "edgeone makers deploy -n 'vibe-coding-1234' --json" }),
    }).action,
    'Deploy project',
  );
});

test('the deploy button is disabled until a project exists and nothing is running', async () => {
  const screen = await readFile('app/features/workspace/workspace-screen.tsx', 'utf8');

  assert.match(screen, /const hasDeployableProject = Boolean\(download\?\.url\)/);
  assert.match(screen, /const publishing = deployment\?\.status === 'running'/);
  assert.match(screen, /const deployRunning = loading \|\| publishing/);
  assert.match(
    screen,
    /const canDeployProject = hasDeployableProject && !deployRunning && !workspaceRestoring/,
  );
  assert.match(screen, /sendMessage\(t\.workspace\.deployRequest, \{ intent: 'deploy' \}\)/);
  assert.match(screen, /disabled=\{!canDeployProject\}/);
  // The rocket stays put while a publish runs. A spinner here was a second
  // progress indicator next to the preview overlay that already says so.
  assert.match(screen, /className="workspace-icon-button is-publish"/);
  assert.doesNotMatch(screen, /is-running/);
  assert.match(screen, /<Rocket className="size-3\.5" \/>/);
  assert.doesNotMatch(
    screen.slice(screen.indexOf('handleDeployProject'), screen.indexOf('handleExportTranscript')),
    /workspace-icon-spinner/,
  );
  // An icon says nothing on its own, and a disabled one says even less about
  // why, so the same tooltip names the action and explains a refusal.
  assert.match(screen, /data-tooltip=\{deployHint\}/);
  assert.match(
    screen,
    /canDeployProject \? t\.deployLabel : t\.workspace\.deployNeedsIdle/,
  );
});

// Two deployments, one word between them. Publishing the user's project runs
// here and needs a finished project; taking a copy of the template is a console
// flow that has nothing to do with this session, so it is a plain link that is
// never disabled and never reads the project state.
test('the header ships the template, the panel ships the project', async () => {
  const [screen, header] = await Promise.all([
    readFile('app/features/workspace/workspace-screen.tsx', 'utf8'),
    readFile('app/features/workspace/components/site-header.tsx', 'utf8'),
  ]);

  assert.match(header, /href=\{templateDeployUrl\}/);
  assert.match(header, /href=\{templateSourceUrl\}/);
  assert.doesNotMatch(header, /canDeploy|onDeploy|onDownload|onExportTranscript/);
  assert.match(screen, /onClick=\{handleDeployProject\}/);
  assert.match(screen, /onClick=\{handleExportTranscript\}/);
  assert.match(screen, /onClick=\{\(\) => void handleDownload\(\)\}/);
});

// Resume hands back whatever deployment the stored conversation carries, so the
// card has to follow the payload down as well as up. While every handler only set
// it on presence, a URL published in an earlier session stayed on screen through a
// session that never published anything.
test('resumed history decides the deployment card, including when there is none', async () => {
  const screen = await readFile('app/features/workspace/workspace-screen.tsx', 'utf8');
  const start = screen.indexOf('const applyHistory = (data: ResumeData) => {');
  const body = screen.slice(start, screen.indexOf('const applyWorkspace = (data: ResumeData) => {', start));

  assert.ok(start >= 0 && body.length > 0);
  assert.match(body, /setDeployment\(data\.deployment \?\? null\)/);
  assert.doesNotMatch(body, /if \(data\.deployment\) \{\s*setDeployment/);
});

// The same stale card from the other direction: a resume already streaming when
// the user starts a new project used to keep applying its events, restoring the
// previous conversation — id, history and deployment — over the fresh one.
test('starting a new project stops the resume that was already in flight', async () => {
  const screen = await readFile('app/features/workspace/workspace-screen.tsx', 'utf8');
  const reset = screen.slice(
    screen.indexOf('function startNewProject() {'),
    screen.indexOf('function handleNewProject() {'),
  );

  assert.ok(reset.length > 0);
  assert.match(reset, /resumeAbortControllerRef\.current\?\.abort\(\)/);
  // Aborting only stops the fetch; events already in hand still need the epoch.
  assert.match(
    screen,
    /if \(cancelled \|\| workspaceEpoch !== workspaceEpochRef\.current \|\| event\.type === 'ping'\) return;/,
  );
});

// The composer is a text field the user may be mid-sentence in, and the Files
// panel is not waiting on anything a publish does.
test('publishing leaves the composer and the files panel alone', async () => {
  const screen = await readFile('app/features/workspace/workspace-screen.tsx', 'utf8');
  const start = screen.indexOf('async function sendMessage(');
  const body = screen.slice(start, screen.indexOf('async function handleSubmit(', start));

  assert.ok(start >= 0 && body.length > 0);
  assert.match(body, /const isStartingFromHome = !isDeploy && !hasWorkspace/);
  assert.match(body, /if \(!isDeploy\) \{\s*setFilesRefreshing\(true\);\s*setInput\(''\);/);
});
