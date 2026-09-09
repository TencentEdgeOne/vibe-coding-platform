import { MAKERS_DEV_PORT } from '../_constants.ts';
import { saveProjectState } from '../_memory.ts';
import { getFileTree, runSandboxCommand } from '../_project.ts';
import { assertMakersProjectCompatible } from '../project/_makers-compat.ts';
import { resolveMakersProjectName } from '../project/_makers-deploy.ts';
import { startPreviewServer } from '../project/_preview.ts';
import {
  buildSandboxMakersEnv,
  resolveMakersMasterToken,
  resolveSandboxMakersToken,
} from '../project/_makers-token.ts';
import type {
  AgentProgressEvent,
  DeploymentInfo,
  StreamSend,
} from '../_types.ts';
import {
  DEPLOY_PARSE_FAILURE,
  buildMakersDeployLaunchCommand,
  buildMakersDeployPollCommand,
  buildMakersDeployReadCommand,
  describeMakersDeployment,
  parseMakersDeployExitCode,
  parseMakersDeployProgress,
  readMakersDeployOutcome,
  redactSecret,
} from '../../shared/makers-deploy.ts';
import { resolveConversationId } from '../utils/_request.ts';
import {
  createProjectCheckpointController,
  ensureProjectDependencies,
  extendExistingSandboxTimeout,
  previewLinkFromState,
  withLiveDeploymentUrl,
} from './_helpers.ts';
import { createTurnLifecycle } from './_turn-lifecycle.ts';
import { prepareProjectWorkspace } from './_workspace.ts';

/** Used when an API caller asks to publish without wording the request itself. */
export const DEFAULT_DEPLOY_REQUEST = 'Deploy this project';

const DEPLOY_TIMEOUT_SECONDS = 600;

/** Only has to start the background script, so it never needs the publish budget. */
const DEPLOY_LAUNCH_TIMEOUT_SECONDS = 120;

/** Reads a file and one process table; anything slower than this is a sick sandbox. */
const DEPLOY_POLL_TIMEOUT_SECONDS = 60;

/**
 * How often the log is read while the publish runs.
 *
 * Two seconds is granular enough that a build printing steadily looks like it
 * is moving, and at 600 seconds of budget it is 300 round trips of one `tail`
 * — a rate the sandbox does not notice.
 */
const DEPLOY_POLL_INTERVAL_MS = 2000;

/**
 * The first read comes sooner than the rest. The CLI prints its banner and the
 * project it resolved almost immediately, and that is the part worth not
 * waiting for: it turns the card from empty into started.
 */
const DEPLOY_FIRST_POLL_MS = 800;

const sleep = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms); });

// The transcript row this pipeline writes. Matching the command the model would
// have typed keeps one "Deploy project" entry in the activity stream, whoever
// started it.
const DEPLOY_ACTIVITY_COMMAND = 'edgeone makers deploy';

const COPY = {
  zh: {
    missingConversation: '缺少会话 ID，无法部署当前项目。',
    noProject: '还没有可部署的项目，请先生成一个项目。',
    success: '已发布到线上。',
    failedPrefix: '部署失败：',
  },
  en: {
    missingConversation: 'Missing conversationId, so this project cannot be deployed.',
    noProject: 'There is no project to deploy yet. Generate one first.',
    success: 'The project is live.',
    failedPrefix: 'Deploy failed: ',
  },
} as const;

/** Deploy output can run to pages; the chat reply carries only its opening line. */
function summarizeDeployError(error: string) {
  const firstLine = error.split('\n').map((line) => line.trim()).find(Boolean) || error.trim();
  return firstLine.length > 200 ? `${firstLine.slice(0, 200)}…` : firstLine;
}

/**
 * Publish, reporting what the CLI prints while it is still printing it.
 *
 * The publish is backgrounded and polled rather than awaited, because
 * `commands.run` resolves exactly once: awaited, a build that takes minutes
 * reaches the UI as minutes of empty card followed by all of its output at
 * once, which is what a spinner over a blank panel was.
 *
 * The return value is the whole log, read in one piece after the process is
 * gone. Nothing the deployment's status depends on is assembled from the
 * polls — they are a view, and a view that drops bytes must not be able to
 * turn a live site into a reported failure.
 */
async function publishWithProgress(
  context: any,
  target: { projectName: string; appDir: string; env: Record<string, string> },
  onTail: (tail: string) => void,
): Promise<{ log: string; timedOut: boolean }> {
  await runSandboxCommand(
    context,
    buildMakersDeployLaunchCommand(target.projectName, '', { stopDevPort: MAKERS_DEV_PORT }),
    { cwd: target.appDir, env: target.env, timeout: DEPLOY_LAUNCH_TIMEOUT_SECONDS },
  );

  const deadline = Date.now() + DEPLOY_TIMEOUT_SECONDS * 1000;
  let wait = DEPLOY_FIRST_POLL_MS;
  let running = true;
  while (running && Date.now() < deadline) {
    await sleep(wait);
    wait = DEPLOY_POLL_INTERVAL_MS;
    try {
      const poll = await runSandboxCommand(context, buildMakersDeployPollCommand(), {
        timeout: DEPLOY_POLL_TIMEOUT_SECONDS,
      });
      const progress = parseMakersDeployProgress(poll.stdout);
      running = progress.running;
      if (progress.tail) onTail(progress.tail);
    } catch {
      // A poll that does not answer says nothing about the publish, which is
      // running in its own process against its own log. Dropping the watch
      // here would report a failure the CLI never had; the deadline below is
      // what ends this, and the log is read either way.
    }
  }

  const log = await runSandboxCommand(context, buildMakersDeployReadCommand(), {
    timeout: DEPLOY_POLL_TIMEOUT_SECONDS,
  });
  // Reported rather than thrown, and the log is read either way. A publish
  // whose watch ran out may still have finished — the exit marker knows, and
  // it outlives whatever went wrong with the watching — and even one that did
  // not usually printed the reason before it stopped. Throwing here would
  // discard both in favour of the news that we gave up.
  return {
    log: log.stdout,
    timedOut: running && parseMakersDeployExitCode(log.stdout) == null,
  };
}

/**
 * Publish the current project with the one command that publishes it.
 *
 * Deploying is not creative work: the project, the credential and the target
 * are all already decided, so putting the model in the loop would only add a
 * chance of it doing something else. It still runs in the chat task slot, which
 * is what keeps a publish and a generation from touching the sandbox at once.
 */
export async function runDeployPipeline(
  context: any,
  message: string,
  send: StreamSend,
  options: { turnId?: string; userMessagePersisted?: boolean } = {},
) {
  const { conversationId } = resolveConversationId(context);
  const request = message.trim() || DEFAULT_DEPLOY_REQUEST;
  const copy = /[\u3400-\u9fff]/.test(request) ? COPY.zh : COPY.en;

  if (!conversationId) {
    send({
      type: 'result',
      data: {
        ok: false,
        conversation_id: '',
        reply: copy.missingConversation,
        preview: {},
      },
    });
    return;
  }

  await extendExistingSandboxTimeout(context);
  send({ type: 'status', message: 'Publishing the project to Makers' });

  const state = await prepareProjectWorkspace(context, conversationId, false, send);
  const turn = createTurnLifecycle({
    context,
    conversationId,
    message: request,
    turnId: options.turnId
      || String(context?.run_id || `${Date.now()}-${Math.random().toString(36).slice(2)}`),
    userMessagePersisted: options.userMessagePersisted === true,
    state,
    // Publishing writes no project files, so nothing here ever needs a snapshot.
    checkpoint: createProjectCheckpointController(context, conversationId, state),
  });

  // No `build` field: publishing runs no verification, and reporting one would
  // clear whatever the last generation said about the project.
  const finish = async (reply: string, status: 'completed' | 'failed') => {
    await turn.finalize(reply, status);
    send({
      type: 'result',
      data: {
        ok: status === 'completed',
        reply,
        conversation_id: conversationId,
        preview: previewLinkFromState(state),
        deployment: state.deployment,
      },
    });
  };

  const files = await getFileTree(context, state).catch(() => []);
  if (!files.some((item) => item.type === 'file')) {
    await finish(copy.noProject, 'failed');
    return;
  }

  const startedAt = Date.now();
  const toolUseId = `deploy-${startedAt}`;
  const emit = (event: AgentProgressEvent) => {
    turn.recordProgress(event);
    send(event as unknown as Record<string, unknown>);
  };
  const publish = (deployment: DeploymentInfo) => {
    state.deployment = deployment;
    // Eagerly persisted so a refresh mid-publish resumes into the same state
    // the deployment bar was showing.
    void saveProjectState(context, conversationId, state);
    send({ type: 'deployment_status', data: deployment });
  };
  // `detail` is whatever the CLI printed when it failed without phrasing the
  // failure itself. It goes to the activity card and nowhere else: the chat
  // reply and the deployment bar both have room for one line, and a wall of CLI
  // output in either would bury the sentence that says what to do next.
  const fail = async (error: string, detail = '') => {
    publish({
      status: 'failed',
      startedAt,
      finishedAt: Date.now(),
      error,
    });
    emit({
      type: 'tool_result',
      data: {
        tool_use_id: toolUseId,
        toolName: 'commands',
        ok: false,
        preview: '',
        outputSummary: detail || summarizeDeployError(error),
        status: 'failed',
        endedAt: Date.now(),
      },
    });
    await finish(`${copy.failedPrefix}${summarizeDeployError(error)}`, 'failed');
  };

  emit({
    type: 'tool_use',
    data: {
      id: toolUseId,
      name: 'commands',
      inputSummary: DEPLOY_ACTIVITY_COMMAND,
      phaseHint: 'link',
      startedAt,
    },
  });
  publish({ status: 'running', startedAt });

  let sandboxToken = '';
  try {
    await assertMakersProjectCompatible(context, state);
    await ensureProjectDependencies(context, state);
    sandboxToken = await resolveSandboxMakersToken(
      state,
      resolveMakersMasterToken(context),
    );
  } catch (error) {
    await fail(error instanceof Error ? error.message : String(error));
    return;
  }

  let stdout = '';
  let commandError = '';
  let timedOut = false;
  try {
    // Past this point the CLI owns the outcome: an abort would stop us reading
    // the result, not the publish, so the run is always seen through.
    ({ log: stdout, timedOut } = await publishWithProgress(
      context,
      {
        projectName: resolveMakersProjectName(context, state),
        appDir: state.appDir,
        env: buildSandboxMakersEnv(sandboxToken),
      },
      // `send` and not `emit`: this fires every couple of seconds and the row
      // it patches is already recorded. recordProgress merges a repeated
      // tool_use by id and keeps only its name and input, so putting the tail
      // through it would store nothing and do it hundreds of times.
      //
      // Redacted on the way out like the final read is. The token is in the
      // environment the CLI inherited, and a live log is no safer a place for
      // it to surface than a finished one.
      (tail) => {
        send({
          type: 'tool_use',
          data: {
            id: toolUseId,
            name: 'commands',
            inputSummary: DEPLOY_ACTIVITY_COMMAND,
            phaseHint: 'link',
            startedAt,
            outputSummary: redactSecret(tail, sandboxToken),
          },
        });
      },
    ));
  } catch (error) {
    commandError = redactSecret(
      error instanceof Error ? error.message : String(error),
      sandboxToken,
    );
  }

  // The command above stopped the preview so the build would not share a
  // directory with it. Restart before reporting either way, so the preview link
  // in the workspace is live again by the time the user reads the result.
  try {
    await startPreviewServer(context, state, { verifyRoutes: false });
  } catch {
    // A preview that does not come back is not a failed publish, and saying so
    // here would contradict the live URL in the same reply. The next turn
    // starts it again.
  }

  if (commandError) {
    await fail(commandError);
    return;
  }

  // No stderr of its own to pass: the publish is backgrounded with 2>&1, so
  // both streams are already interleaved in the log stdout was read from.
  const outcome = readMakersDeployOutcome(stdout, '', sandboxToken);
  if (outcome.status !== 'success') {
    // A watch that ran out says so only where the log said nothing: that one
    // message means the output named no cause, and it is the one place where
    // "it never finished" is more use than "it did not parse". Anywhere else
    // the log won the argument — it named the cause, and the publish stopping
    // is how it ended, not why.
    const error = timedOut && outcome.error === DEPLOY_PARSE_FAILURE
      ? `edgeone makers deploy did not finish within ${DEPLOY_TIMEOUT_SECONDS} seconds.`
      : outcome.error;
    await fail(error, outcome.status === 'error' ? outcome.detail ?? '' : '');
    return;
  }

  publish(describeMakersDeployment(outcome, { startedAt }));
  emit({
    type: 'tool_result',
    data: {
      tool_use_id: toolUseId,
      toolName: 'commands',
      ok: true,
      preview: '',
      outputSummary: outcome.url,
      status: 'completed',
      endedAt: Date.now(),
    },
  });
  await finish(withLiveDeploymentUrl(copy.success, outcome.url), 'completed');
}
