import type {
  ClaudeMcpTool,
  DeploymentInfo,
  PreviewKind,
  ProjectState,
} from '../_types.ts';
import {
  MAKERS_DEV_PORT,
  PREVIEW_ASSET_PREFIX_ENV,
  PREVIEW_PATH_PREFIX,
  PREVIEW_SERVER_PORT,
} from '../_constants.ts';
import { assertMakersProjectCompatible } from '../project/_makers-compat.ts';
import {
  previewFailureWarrantsRestart,
  publishRunningPreview,
  startPreviewServer,
} from '../project/_preview.ts';
import { resolveMakersProjectName } from '../project/_makers-deploy.ts';
import {
  buildSandboxMakersEnv,
  resolveMakersMasterToken,
  resolveSandboxMakersToken,
} from '../project/_makers-token.ts';
import {
  MAKERS_DEV_LAUNCH_TIMEOUT_SECONDS,
  MAKERS_DEV_PORT_DRIFT_EXIT,
  buildMakersDevBackgroundCommand,
  buildMakersDevStopScript,
  parseMakersDevExitCode,
} from '../../shared/makers-dev.ts';
import {
  buildMakersDeployCommand,
  describeMakersDeployment,
  readMakersDeployOutcome,
  redactSecret,
} from '../../shared/makers-deploy.ts';
import {
  buildNpmCacheReclaimScript,
  buildNpmWarmupHandoffScript,
  buildNpmWarmupWaitScript,
} from '../../shared/npm-install.ts';
import {
  MAKERS_CLI_UNAVAILABLE_ERROR_CODE,
  MAKERS_CLI_UNAVAILABLE_MESSAGE,
  buildEdgeoneVersionCheckCommand,
  forbiddenSandboxCommandReason,
  isEdgeoneCliUnavailable,
  isBareInstallCommand,
  isEdgeoneVersionCommand,
  isInstallCommand,
  isScaffolderCommand,
  isMakersDeployCommand,
  isMakersDevCommand,
  isVerificationCommand,
  shortenToolName,
  parseEdgeoneVersionExitCode,
  withExitCodeEcho,
} from '../utils/_tool-phase.ts';

type MakersCommandLifecycle = {
  context: any;
  state: ProjectState;
  onPreviewReady?: (preview: {
    url?: string;
    sandboxDebugUrl?: string;
    kind?: PreviewKind;
  }) => void;
  onDeploymentStatus?: (deployment: DeploymentInfo) => void;
};

function updateDeploymentStatus(
  lifecycle: MakersCommandLifecycle,
  deployment: DeploymentInfo,
) {
  lifecycle.state.deployment = deployment;
  lifecycle.onDeploymentStatus?.(deployment);
}

function extractCommand(args: unknown) {
  const record = args && typeof args === 'object' ? args as Record<string, unknown> : {};
  const command = typeof record.command === 'string'
    ? record.command
    : typeof record.cmd === 'string'
      ? record.cmd
      : '';
  return { record, command };
}

function withWrappedCommand(args: unknown, wrapped: string) {
  const { record, command } = extractCommand(args);
  if (!command || wrapped === command) {
    return args;
  }
  return {
    ...record,
    ...(typeof record.command === 'string' ? { command: wrapped } : {}),
    ...(typeof record.cmd === 'string' ? { cmd: wrapped } : {}),
  };
}

function withCommandOptions(
  args: unknown,
  command: string,
  cwd: string,
  env: Record<string, string>,
  timeout: number,
) {
  const { record } = extractCommand(args);
  return {
    ...record,
    ...(typeof record.command === 'string' ? { command } : { cmd: command }),
    cwd,
    env: {
      ...(record.env && typeof record.env === 'object'
        ? record.env as Record<string, unknown>
        : {}),
      ...env,
    },
    timeout,
  };
}

function textContents(result: Awaited<ReturnType<ClaudeMcpTool['handler']>>) {
  return (result.content || [])
    .flatMap((item) => item && typeof item === 'object' && 'text' in item
      && typeof item.text === 'string' ? [item.text] : [])
    .join('\n');
}

function commandOutputFromToolResult(result: Awaited<ReturnType<ClaudeMcpTool['handler']>>) {
  const raw = textContents(result);
  const streams: string[] = [];
  for (const item of result.content || []) {
    if (!item || typeof item !== 'object' || !('text' in item) || typeof item.text !== 'string') {
      continue;
    }
    try {
      const parsed = JSON.parse(item.text) as Record<string, unknown>;
      if (typeof parsed.stdout === 'string') streams.push(parsed.stdout);
      if (typeof parsed.stderr === 'string') streams.push(parsed.stderr);
    } catch {
      // Some runtime versions return raw stdout instead of a JSON envelope.
    }
  }
  return [...streams, raw].filter(Boolean).join('\n');
}

function appendText(
  result: Awaited<ReturnType<ClaudeMcpTool['handler']>>,
  text: string,
) {
  return {
    ...result,
    content: [
      ...(result.content || []),
      { type: 'text' as const, text },
    ],
  };
}

function withMakersCliUnavailableError(
  result: Awaited<ReturnType<ClaudeMcpTool['handler']>>,
  attemptedCommand: string,
) {
  return {
    ...appendText(result, JSON.stringify({
      status: 'error',
      errorCode: MAKERS_CLI_UNAVAILABLE_ERROR_CODE,
      retryable: false,
      error: MAKERS_CLI_UNAVAILABLE_MESSAGE,
      attemptedCommand,
      instruction: 'Stop this preview/deploy attempt. Do not inspect PATH or installation directories, install packages, use npx, or retry. Tell the user this is a sandbox image rollout blocker, not a generated-project error.',
    })),
    isError: true,
  };
}

const DEV_SERVER_STOPPED_NOTICE = 'The preview dev server was stopped before this command, '
  + 'because a build or an install in the same directory races it over .next and node_modules. '
  + 'The preview is down until you run `edgeone makers dev` again.';

function withDevServerStopped(command: string) {
  return [buildMakersDevStopScript(MAKERS_DEV_PORT, DEV_SERVER_STOPPED_NOTICE), command].join('\n');
}

/**
 * Let the background install the host started stand in for this one.
 *
 * Everything waits, because two npm processes on one node_modules is the one
 * thing that must never happen — see shared/npm-install.ts. Only a bare install
 * is answered outright: the warmup ran that exact command, while an install
 * naming a package has to run or the package is never there.
 */
function withWarmedInstall(command: string, wrapped: string) {
  if (isBareInstallCommand(command)) {
    // The reclaim is only reached when the handoff did not stand in, so it
    // follows an install that really ran and really filled the cache.
    return [buildNpmWarmupHandoffScript(), wrapped, buildNpmCacheReclaimScript()].join('\n');
  }
  return [buildNpmWarmupWaitScript(), wrapped].join('\n');
}

function redactToolResult(
  result: Awaited<ReturnType<ClaudeMcpTool['handler']>>,
  secret: string,
) {
  if (!secret) return result;
  return {
    ...result,
    content: (result.content || []).map((item) => (
      item && typeof item === 'object' && 'text' in item && typeof item.text === 'string'
        ? { ...item, text: redactSecret(item.text, secret) }
        : item
    )),
  };
}

async function prepareMakersCommand(
  args: unknown,
  command: string,
  lifecycle: MakersCommandLifecycle,
) {
  const masterToken = resolveMakersMasterToken(lifecycle.context);
  const sandboxToken = await resolveSandboxMakersToken(
    lifecycle.state,
    masterToken,
  );
  const env = buildSandboxMakersEnv(sandboxToken);
  // Whatever name the model typed is replaced here. It has no way to know
  // which project belongs to this conversation, and a name it invents to dodge
  // a collision would strand the site somewhere nobody can find again.
  const projectName = resolveMakersProjectName(lifecycle.context, lifecycle.state);

  if (isMakersDevCommand(command)) {
    return {
      args: withCommandOptions(
        args,
        buildMakersDevBackgroundCommand({
          makersPort: MAKERS_DEV_PORT,
          previewPort: PREVIEW_SERVER_PORT,
          previewPath: PREVIEW_PATH_PREFIX,
          projectName,
          assetPrefixEnvName: PREVIEW_ASSET_PREFIX_ENV,
        }),
        lifecycle.state.appDir,
        env,
        MAKERS_DEV_LAUNCH_TIMEOUT_SECONDS,
      ),
      kind: 'dev' as const,
      sandboxToken,
    };
  }

  return {
    args: withCommandOptions(
      args,
      buildMakersDeployCommand(projectName, command, { stopDevPort: MAKERS_DEV_PORT }),
      lifecycle.state.appDir,
      env,
      600,
    ),
    kind: 'deploy' as const,
    sandboxToken,
  };
}

export function wrapSandboxTools(
  tools: ClaudeMcpTool[],
  lifecycle?: MakersCommandLifecycle,
): ClaudeMcpTool[] {
  return tools.map((tool) => {
    if (shortenToolName(tool.name) !== 'commands') {
      return tool;
    }
    const originalHandler = tool.handler;
    return {
      ...tool,
      handler: async (args, extra) => {
        const command = extractCommand(args).command;
        const blocked = forbiddenSandboxCommandReason(command);
        if (blocked) {
          return {
            content: [{ type: 'text' as const, text: blocked }],
            isError: true,
          };
        }
        const isDeploymentCommand = isMakersDeployCommand(command);
        const isMakersCommand = isMakersDevCommand(command) || isDeploymentCommand;
        const deploymentStartedAt = Date.now();
        const failDeployment = (error: string) => {
          if (!lifecycle || !isDeploymentCommand) return;
          updateDeploymentStatus(lifecycle, {
            status: 'failed',
            startedAt: deploymentStartedAt,
            finishedAt: Date.now(),
            error,
          });
        };
        if (lifecycle && isDeploymentCommand) {
          updateDeploymentStatus(lifecycle, {
            status: 'running',
            startedAt: deploymentStartedAt,
          });
        }
        // An install or a build in the project directory contends with the dev
        // server for .next and node_modules, and loses in ways that name
        // neither: a build reports a missing file or a Pages Router page it
        // does not have, and an install reports ENOTEMPTY renaming a package
        // the server holds open. One run spent twenty calls reading its own
        // source for a `<Html>` import that was never there.
        const stopsDevServer = !isMakersCommand
          && (
            isInstallCommand(command)
            || isVerificationCommand(command)
            || isScaffolderCommand(command)
          );
        let nextArgs = withWrappedCommand(
          args,
          isEdgeoneVersionCommand(command)
            ? buildEdgeoneVersionCheckCommand()
            : stopsDevServer
              ? withDevServerStopped(withWarmedInstall(command, withExitCodeEcho(command)))
              : withExitCodeEcho(command),
        ) as typeof args;
        let makers:
          | Awaited<ReturnType<typeof prepareMakersCommand>>
          | undefined;
        if (lifecycle && isMakersCommand) {
          try {
            await assertMakersProjectCompatible(lifecycle.context, lifecycle.state);
            makers = await prepareMakersCommand(args, command, lifecycle);
            nextArgs = makers.args as typeof args;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            failDeployment(message);
            return {
              content: [{
                type: 'text' as const,
                text: message,
              }],
              isError: true,
            };
          }
        }
        // Generic verification commands keep isError false even when EXIT:N
        // is non-zero so the model can fix source. The dedicated CLI branches
        // below promote captured lifecycle failures to structured tool errors.
        let result: Awaited<ReturnType<ClaudeMcpTool['handler']>>;
        try {
          result = await originalHandler(nextArgs, extra);
        } catch (error) {
          failDeployment(error instanceof Error ? error.message : String(error));
          throw error;
        }
        if (isEdgeoneVersionCommand(command)) {
          const versionOutput = commandOutputFromToolResult(result);
          const versionExitCode = parseEdgeoneVersionExitCode(versionOutput);
          if (
            versionExitCode === 127
            || isEdgeoneCliUnavailable(versionOutput)
          ) {
            return withMakersCliUnavailableError(result, 'edgeone --version');
          }
          if (versionExitCode != null && versionExitCode !== 0) {
            return {
              ...appendText(result, JSON.stringify({
                status: 'error',
                errorCode: 'MAKERS_CLI_VERSION_CHECK_FAILED',
                retryable: false,
                error: `edgeone --version exited with code ${versionExitCode}.`,
                exitCode: versionExitCode,
              })),
              isError: true,
            };
          }
          return result;
        }
        if (!lifecycle || !makers) {
          return result;
        }

        // Parse deploy output before redaction so a URL query value that
        // happens to overlap the CLI credential is never truncated.
        const makersOutput = commandOutputFromToolResult(result);
        result = redactToolResult(result, makers.sandboxToken);
        // The deploy command stops makers dev so the build does not share its
        // output directory. Restart before any of the branches below report,
        // including the failing ones: the preview is how the model inspects
        // what it just built, and a publish that failed is exactly when it
        // needs to look.
        if (makers.kind === 'deploy') {
          try {
            await startPreviewServer(lifecycle.context, lifecycle.state, {
              verifyRoutes: false,
            });
          } catch {
            // Not part of publishing. The next preview command starts it again,
            // and failing the deploy over this would call a live site broken.
          }
        }
        if (result.isError) {
          failDeployment(
            textContents(result).trim().slice(-1500)
              || 'The Makers deployment command failed.',
          );
          return result;
        }

        if (makers.kind === 'dev') {
          const devExitCode = parseMakersDevExitCode(makersOutput);
          if (devExitCode != null && devExitCode !== 0) {
            if (isEdgeoneCliUnavailable(makersOutput)) {
              return withMakersCliUnavailableError(result, 'edgeone makers dev');
            }
            // The one launch failure that says nothing about the project: the
            // port was still held, so the CLI came up healthy somewhere the
            // proxy does not look. Launching again is the fix, and the launcher
            // now clears that port first, so the second attempt is not a repeat
            // of the first.
            if (devExitCode === MAKERS_DEV_PORT_DRIFT_EXIT) {
              return {
                ...appendText(result, JSON.stringify({
                  status: 'error',
                  errorCode: 'MAKERS_DEV_PORT_DRIFT',
                  retryable: true,
                  error: 'edgeone makers dev started on a port the preview proxy does not forward to, because the previous dev server still held the expected one.',
                  instruction: 'Run the same preview command once more. Nothing in the generated project caused this, so do not change project files, and do not kill processes or free ports yourself — the launcher terminates the previous server before this next attempt.',
                })),
                isError: true,
              };
            }
            return {
              ...appendText(result, JSON.stringify({
                status: 'error',
                error: `edgeone makers dev exited with code ${devExitCode}.`,
                exitCode: devExitCode,
              })),
              isError: true,
            };
          }
          try {
            let preview;
            try {
              preview = await publishRunningPreview(lifecycle.context, lifecycle.state);
            } catch (error) {
              // The smoke test now retries through the rebuild window itself, so
              // reaching here means the server never answered — restart it once.
              // A generated agent that answers wrongly is reported as-is instead:
              // its reply already proves the server and proxy work.
              if (!previewFailureWarrantsRestart(error)) throw error;
              await startPreviewServer(lifecycle.context, lifecycle.state);
              preview = await publishRunningPreview(lifecycle.context, lifecycle.state, {
                routesAlreadyVerified: true,
              });
            }
            lifecycle.onPreviewReady?.(preview);
            return appendText(result, JSON.stringify({
              status: 'success',
              preview: {
                url: preview.url,
                kind: preview.kind,
              },
            }));
          } catch (error) {
            return {
              ...appendText(result, error instanceof Error ? error.message : String(error)),
              isError: true,
            };
          }
        }

        const outcome = readMakersDeployOutcome(makersOutput, '', makers.sandboxToken);
        if (outcome.status === 'cli-missing') {
          failDeployment(outcome.error);
          return withMakersCliUnavailableError(result, 'edgeone makers deploy');
        }
        if (outcome.status === 'error') {
          failDeployment(outcome.error);
          return {
            ...appendText(result, JSON.stringify({
              status: 'error',
              error: outcome.error,
              ...(outcome.exitCode != null ? { exitCode: outcome.exitCode } : {}),
            })),
            isError: true,
          };
        }
        updateDeploymentStatus(lifecycle, describeMakersDeployment(outcome, {
          startedAt: deploymentStartedAt,
        }));
        const { status: _outcomeStatus, ...published } = outcome;
        return appendText(result, JSON.stringify({
          status: 'published',
          ...published,
        }));
      },
    };
  });
}
