/**
 * Runtime-agnostic helpers for Makers CLI --json deploy output and URL detection.
 * Keep this free of sandbox / React imports so tests and the frontend can share it.
 */

import { buildMakersDevStopScript } from './makers-dev.ts';
import { buildNpmCacheReclaimScript } from './npm-install.ts';
import type { DeploymentInfo } from './protocol.ts';
import { shellQuote } from './shell.ts';
import { MAKERS_CLI_UNAVAILABLE_MESSAGE, isEdgeoneCliUnavailable } from './tool-phase.ts';

/**
 * Printed by the deploy command when the CLI reported a successful publish that
 * carried no client build.
 *
 * `.edgeone` is the directory the CLI uploads, and it clears `.edgeone/assets`
 * before running the build — necessary, because the filenames in there are
 * content-hashed and an unpruned directory would publish the union of every
 * build ever run in it, with a stale index.html shadowing the SSR routes that
 * sit behind `handle: filesystem` in the generated route table. What makes the
 * clear unsafe is what pairs with it: afterwards the CLI decides whether to
 * fall back to the framework's own output directory by asking whether
 * `.edgeone/assets` exists, not whether anything is in it. An adapter that
 * creates the directory without copying its client bundle into it therefore
 * publishes an empty static layer and exits 0 — the SSR routes answer, and
 * every hashed asset the rendered HTML points at 404s.
 */
export const MAKERS_DEPLOY_EMPTY_ASSETS_MARKER = 'MAKERS_DEPLOY_EMPTY_ASSETS:1';

/**
 * The publish writes here rather than to the pipe so the checks below can read
 * it back after the exit code is captured, and so the output survives to be
 * printed once whether the deploy succeeded or not.
 *
 * It is also what makes the publish watchable. A deploy runs for minutes and
 * `commands.run` is one await that resolves at the end, so a foreground publish
 * shows nothing until it is over — the spinner sat on an empty card for the
 * whole build. Backgrounding the script against this file turns the same output
 * into something the host can tail while it is still being written.
 */
const DEPLOY_LOG = '/tmp/makers-deploy.log';

/** Written by the launcher, read by the poll to tell "still building" from "gone". */
const DEPLOY_PID = '/tmp/makers-deploy.pid';

/** Terminates every poll payload, so the tail above it is unambiguous. */
export const MAKERS_DEPLOY_ALIVE_MARKER = 'MAKERS_DEPLOY_ALIVE:';

/**
 * How much of the log a poll carries back.
 *
 * A rolling window rather than the bytes since the last poll, because the two
 * jobs are different: this one only has to look like a build in progress, and
 * the verdict is read at the end from the whole file. Byte accounting between
 * polls would put the parse at the mercy of an off-by-one in the display path.
 */
const DEPLOY_TAIL_BYTES = 4000;
const DEPLOY_TAIL_LINES = 24;

/**
 * Runs in the sandbox after the publish, against the tree the CLI just
 * uploaded. `.edgeone-assets-config.json` is excluded because the CLI writes it
 * itself after the build, so it is there either way and cannot stand in for a
 * client bundle.
 *
 * Treats an empty directory as a failed publish unconditionally, which would be
 * wrong for a project that serves nothing but functions. Every template this
 * host scaffolds from is a web framework with a client bundle, so that project
 * does not currently exist here — and until it does, failing loudly on the tree
 * beats handing back a URL that 404s everything the page loads.
 */
const MAKERS_DEPLOY_ASSET_CHECK = [
  'if [ "$deploy_status" = 0 ]; then',
  "  published=$(find .edgeone/assets -type f ! -name '.edgeone-assets-config.json' 2>/dev/null | head -n 1)",
  `  [ -n "$published" ] || echo "${MAKERS_DEPLOY_EMPTY_ASSETS_MARKER}"`,
  'fi',
].join('\n');

/**
 * What the disk looked like when a publish ran out of it.
 *
 * The CLI names the one file it could not copy and nothing else, so a report of
 * this failure arrives with no way to tell which tree was holding the space —
 * whether the cache came back, whether an earlier conversation left a
 * node_modules behind, or whether one build genuinely does not fit. That is
 * three guesses, and every one of them is answered by four commands.
 *
 * Reactive on purpose: `du` over a 422M tree is not worth a second of every
 * successful deploy, and this is the one path where the second buys something.
 * `../../*` reaches the sibling conversations because the publish runs in
 * <projects>/<conversation>/app; deriving it from cwd rather than naming the
 * absolute path keeps it from outliving that layout as a wrong answer.
 */
const MAKERS_DEPLOY_DISK_REPORT = [
  `if [ "$deploy_status" != 0 ] && grep -q ENOSPC ${DEPLOY_LOG} 2>/dev/null; then`,
  '  echo "--- disk at failure ---"',
  '  df -h . 2>/dev/null',
  '  du -sh node_modules .next .edgeone "$HOME/.npm" 2>/dev/null',
  '  du -sh ../../* 2>/dev/null | sort -rh | head -n 3',
  'fi',
].join('\n');

function makersDeployLaunch(projectName: string, requestedCommand: string) {
  const previewEnvironment = /(?:^|\s)(?:-e|--environment)(?:\s+|=)preview(?:\s|$)/i
    .test(requestedCommand);
  return [
    'edgeone makers deploy',
    `-n ${shellQuote(projectName)}`,
    '--json',
    previewEnvironment ? '-e preview' : '',
  ].filter(Boolean).join(' ');
}

/**
 * The publish, from stopping the preview to printing its own exit code.
 *
 * One list with two endings rather than two lists. Both callers publish the
 * same project the same way, and the comment on readMakersDeployOutcome is
 * about what a difference between them costs: a deployment one of them calls
 * failed while the site is live. `streamed` moves only where the output goes —
 * to this script's stdout, for the backgrounded run whose caller is tailing the
 * file that stdout points at, or into the log and back out at the end, for the
 * foreground run that has no reader until it returns.
 */
function buildMakersDeploySteps(
  launch: string,
  options: { stopDevPort?: number },
  streamed: boolean,
) {
  return [
    'set +e',
    // Before the CLI builds, not after: the preview dev server writes to the
    // same build directory, and whichever of the two loses fails on a file the
    // other removed. Here rather than at either call site so that publishing
    // from the button and publishing from the model cannot diverge on it.
    ...(options.stopDevPort ? [buildMakersDevStopScript(options.stopDevPort)] : []),
    // And then its output, which the build below writes from scratch regardless.
    // Keeping it is what ran the sandbox out of disk: a dev-mode .next is the
    // fatter of the two, `next build` adds its own beside it, and then copies
    // that into .next/standalone/.next — three trees on a quota sized for one
    // project. It surfaced as a build failure rather than as a quota, because
    // the CLI reports only the file it could not write.
    //
    // Relative on purpose: the command runs with cwd set to the project, so
    // this cannot reach a .next belonging to anything else. A project that has
    // none, which is every non-Next framework, loses nothing here.
    'rm -rf .next',
    // And .edgeone for the same reason one step further in: it is the directory
    // the CLI uploads, but the only part of it the build clears is
    // .edgeone/assets. A cloud-functions tree from an earlier build survives
    // into this publish, so a server bundle can ship beside client assets from
    // a different build and reference hashed filenames that were never emitted
    // — which is the same 404 as an empty static layer, reached the other way.
    'rm -rf .edgeone',
    // The last reclaimable thing on the disk, and the only one the build cannot
    // rebuild from. An install leaves the tarballs it extracted behind — 460M
    // measured beside a 422M project on a 1.1G disk — and the warmup gives that
    // back on its own path, but the install ensureProjectDependencies runs when
    // a resumed conversation finds no node_modules does not. That one is
    // therefore the publish that starts with the cache already full.
    //
    // Worth doing even when it is already empty: a Next.js publish peaks at
    // three copies of one dependency tree, so the cache is the difference
    // between fitting and the CLI failing on whichever file it reached last.
    buildNpmCacheReclaimScript(),
    // Streamed, the launcher truncated the log and pointed this stdout at it,
    // so the CLI writes straight into the file being tailed. The disk report
    // below still greps that file and still finds the CLI's output in it: the
    // process it came from has exited by then, so nothing of it is unflushed.
    ...(streamed
      ? [launch]
      : [`rm -f ${DEPLOY_LOG}`, `${launch} > ${DEPLOY_LOG} 2>&1`]),
    'deploy_status=$?',
    ...(streamed ? [] : [`cat ${DEPLOY_LOG}`]),
    MAKERS_DEPLOY_ASSET_CHECK,
    MAKERS_DEPLOY_DISK_REPORT,
    'echo "MAKERS_DEPLOY_EXIT:$deploy_status"',
    // Preserve the CLI output even on failure; the command adapter converts
    // the marker back into an MCP tool error after parsing it.
    'exit 0',
  ].join('\n');
}

export function buildMakersDeployCommand(
  projectName: string,
  requestedCommand = '',
  options: { stopDevPort?: number } = {},
) {
  return buildMakersDeploySteps(
    makersDeployLaunch(projectName, requestedCommand),
    options,
    false,
  );
}

/**
 * Start the publish and return, leaving it running.
 *
 * Returns as soon as the CLI is launched, so the caller reaches its poll loop
 * while the build is still in its first seconds — which is the point. The log
 * is truncated here rather than inside the script because the script cannot
 * truncate the file its own stdout is already open on.
 */
export function buildMakersDeployLaunchCommand(
  projectName: string,
  requestedCommand = '',
  options: { stopDevPort?: number } = {},
) {
  const body = buildMakersDeploySteps(
    makersDeployLaunch(projectName, requestedCommand),
    options,
    true,
  );
  return [
    `rm -f ${DEPLOY_LOG} ${DEPLOY_PID}`,
    `nohup sh -c ${shellQuote(body)} > ${DEPLOY_LOG} 2>&1 &`,
    `echo "$!" > ${DEPLOY_PID}`,
    'exit 0',
  ].join('\n');
}

/** A window on the log, and whether there is still something writing to it. */
export function buildMakersDeployPollCommand() {
  return [
    // Liveness before the tail, not after. Read the other way round, a publish
    // that finished between the two reads is reported as done while the lines
    // it printed on the way out have not been shown yet.
    `if [ -s ${DEPLOY_PID} ] && kill -0 "$(cat ${DEPLOY_PID})" 2>/dev/null; then alive=1; else alive=0; fi`,
    `tail -c ${DEPLOY_TAIL_BYTES} ${DEPLOY_LOG} 2>/dev/null | tail -n ${DEPLOY_TAIL_LINES}`,
    `printf '\\n%s%s\\n' ${shellQuote(MAKERS_DEPLOY_ALIVE_MARKER)} "$alive"`,
    'exit 0',
  ].join('\n');
}

/**
 * The whole log, read once the publish is over.
 *
 * The verdict comes from this and never from the accumulated polls. Every
 * reader below — the --json result, the exit marker, the empty-assets marker,
 * the ENOSPC scan, the window around the failing line — wants the full text,
 * and a rolling window assembled over a few hundred round trips is the wrong
 * thing to stake a deployment's status on.
 */
export function buildMakersDeployReadCommand() {
  return [`cat ${DEPLOY_LOG} 2>/dev/null`, 'exit 0'].join('\n');
}

/**
 * What one poll saw: the tail to show, and whether to poll again.
 *
 * A poll that comes back without the marker is treated as still running. The
 * loop has its own deadline, so believing a malformed answer costs one more
 * round trip, while disbelieving it would end the watch on a publish that is
 * still building.
 */
export function parseMakersDeployProgress(stdout: string): {
  tail: string;
  running: boolean;
} {
  const marker = stdout.lastIndexOf(MAKERS_DEPLOY_ALIVE_MARKER);
  if (marker < 0) return { tail: stdout.trimEnd(), running: true };
  const flag = stdout.slice(marker + MAKERS_DEPLOY_ALIVE_MARKER.length).trim();
  return {
    tail: stdout.slice(0, marker).trimEnd(),
    running: flag.startsWith('1'),
  };
}

export function parseMakersDeployExitCode(output: string) {
  const matches = [...output.matchAll(/(?:^|\n)MAKERS_DEPLOY_EXIT:(\d+)(?=\s|$)/g)];
  if (matches.length === 0) return undefined;
  const value = Number(matches.at(-1)?.[1]);
  return Number.isInteger(value) ? value : undefined;
}

export type MakersDeploySuccess = {
  status: 'success';
  url: string;
  type?: string;
  projectId?: string;
  deploymentId?: string;
  consoleUrl?: string;
};

export type MakersDeployFailure = {
  status: 'error';
  error: string;
};

export type MakersDeployJson = MakersDeploySuccess | MakersDeployFailure;

export function parseMakersDeployJson(stdout: string, stderr = ''): MakersDeployJson {
  const combined = [stdout, stderr].filter(Boolean).join('\n');
  const lines = combined
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed.status === 'success' && typeof parsed.url === 'string' && parsed.url.trim()) {
        return {
          status: 'success',
          url: parsed.url.trim(),
          ...(typeof parsed.type === 'string' ? { type: parsed.type } : {}),
          ...(typeof parsed.projectId === 'string' ? { projectId: parsed.projectId } : {}),
          ...(typeof parsed.deploymentId === 'string' ? { deploymentId: parsed.deploymentId } : {}),
          ...(typeof parsed.consoleUrl === 'string' ? { consoleUrl: parsed.consoleUrl } : {}),
        };
      }
      if (parsed.status === 'error') {
        const error = typeof parsed.error === 'string' && parsed.error.trim()
          ? parsed.error.trim()
          : 'Deploy failed.';
        return { status: 'error', error };
      }
    } catch {
      // Keep scanning earlier lines; CLI may print non-JSON before the result.
    }
  }

  const textMatch = combined.match(/EDGEONE_DEPLOY_URL=(\S+)/);
  if (textMatch?.[1]) {
    return { status: 'success', url: textMatch[1] };
  }

  const quota = combined.match(/Makers project exceeds \d+ limit/i);
  if (quota) {
    return { status: 'error', error: quota[0] };
  }

  return {
    status: 'error',
    error: DEPLOY_PARSE_FAILURE,
  };
}

/**
 * Not a cause, only the absence of one: the CLI failed without phrasing the
 * failure as --json. Anything reported to a user in these words has thrown away
 * the output that would have named the real problem.
 */
export const DEPLOY_PARSE_FAILURE = 'Deploy did not return a parseable --json result.';

/**
 * The build succeeded and the disk did not.
 *
 * Named as its own cause because the CLI reports only the file it could not
 * copy, and that reads as a problem with that file. Handed a message like it,
 * the model's next move is to start editing the project — which cannot free a
 * byte, and spends the working build it already has looking for a defect that
 * is not there. The same shape as a lint rule rejecting the links we mandate:
 * a failure whose text points at the wrong thing gets repaired at the wrong
 * thing.
 *
 * A Next.js publish is what reaches it. `next build` writes a standalone trace
 * of the dependency tree beside the node_modules it was built from, the CLI
 * copies that trace into .edgeone/cloud-functions, and the three of them are
 * three copies of one tree on a 1.1G disk.
 */
export const DEPLOY_DISK_FULL = [
  'Deploy failed on sandbox disk space, not on anything in the project: the build finished successfully and the CLI then had nowhere to copy the server bundle.',
  'A Next.js publish peaks at three copies of one dependency tree — node_modules, the .next/standalone trace built from it, and the .edgeone/cloud-functions copy made from that — on a 1.1G disk.',
  'Tell the user the build itself was fine and the sandbox ran out of room, and that one retry is worth taking because the host reclaims what it can before each publish. Do not edit project files, delete pages, or drop dependencies to chase this: the disk report above names what holds the space, and none of it is the project source.',
].join('\n');

/** errno, and the wording the copy step uses; the CLI prints one or both. */
const DEPLOY_DISK_FULL_PATTERN = /\bENOSPC\b|no space left on device/i;

/**
 * A publish that uploaded a server bundle and no client build. Reported as a
 * failure rather than as the success the CLI called it, because the alternative
 * is a live URL that renders its HTML once and then 404s on every script and
 * stylesheet that HTML asks for — which reads as a working deploy to everything
 * except a browser, including the exit code and the --json payload.
 */
export const DEPLOY_EMPTY_ASSETS = [
  'Deploy published no client build: .edgeone/assets held no files, so every asset the page references will 404.',
  "The CLI clears that directory before the build and afterwards checks only that it exists, so a framework adapter that does not copy its client output into it publishes an empty static layer at exit code 0.",
].join('\n');

/** Wrapper bookkeeping, not CLI output. */
function isDeployWrapperLine(line: string) {
  return /^MAKERS_DEPLOY_(?:EXIT:\d+|EMPTY_ASSETS:1)$/.test(line);
}

/**
 * Colour codes. Invisible in a terminal and invisible in the activity card too,
 * since the browser renders ESC as nothing — which is worse than visible, because
 * the bracket codes around them survive and read as part of the message.
 */
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE = /\u001B\[[0-9;?]*[ -/]*[@-~]/g;

function readDeployOutputLines(stdout: string, stderr: string) {
  return [stdout, stderr]
    .filter(Boolean)
    .join('\n')
    .split(/\r?\n/)
    .map((line) => line.replace(ANSI_ESCAPE, '').trim())
    .filter((line) => line && !isDeployWrapperLine(line));
}

/** Reads as a failure of some kind. */
const DEPLOY_COMPLAINT = /(error|failed|failure|cannot|denied|unauthori[sz]ed|forbidden|invalid|exceeds|✘|✖)/i;

/**
 * Says that something failed without saying what. Every layer between the build
 * and the CLI adds one of these on the way out, so they are both the most
 * numerous lines and the last ones printed.
 */
const DEPLOY_RESTATEMENT = /\b(?:failed|exited|finished)\b[^.]{0,40}?\bcode[:\s]+\d+|Build project failed|Command failed/i;

/** Names a cause: an errno, an exception class, or a resolution failure. */
const DEPLOY_CAUSE = /\b(?:E[A-Z]{3,}|[A-Za-z]*Error)\b|Cannot find|Module not found|no such file|permission denied|out of memory/;

/**
 * A 128 + signal exit, which names a cause even though it is phrased as a
 * restatement: the build did not disagree with the code, it was killed. 137 is
 * SIGKILL and on a build step that is nearly always the sandbox running out of
 * memory — a process killed that way prints nothing on its way out, so this
 * exit code is the only trace it leaves.
 */
const DEPLOY_SIGNAL_EXIT = /\bcode[:\s]+(?:134|137|139)\b|\bSIGKILL\b|\bSIGSEGV\b/;

/**
 * Counts failures to report that there were none. The EdgeOne config validator
 * says "none error in configuration file" when the config is clean, which is
 * the one line in a failed deploy asserting that nothing is wrong.
 */
const DEPLOY_ALL_CLEAR = /\b(?:none|no|zero|0)\s+errors?\b|\berrors?\s*[:=]\s*(?:none|0)\b/i;

function isDeployComplaint(line: string) {
  // Ordered so a named cause outranks the all-clear wording: a summary saying
  // "0 errors" can sit on the same line as the errno that contradicts it.
  if (DEPLOY_CAUSE.test(line) || DEPLOY_SIGNAL_EXIT.test(line)) return true;
  if (DEPLOY_ALL_CLEAR.test(line)) return false;
  return DEPLOY_COMPLAINT.test(line);
}

/**
 * The index of the line most likely to name the cause.
 *
 * A heuristic, deliberately: the CLI writes progress and failures to one stream
 * and matching its exact wording would date the moment it gets rephrased. The
 * ordering rule is the load-bearing part — a build fails inside-out, printing
 * the cause first and then restating it as an exit code at every layer above,
 * so the last complaint is reliably the least informative one on screen.
 */
function pickDeployErrorLine(lines: string[]) {
  const complaints = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => isDeployComplaint(line));
  const specific = complaints.filter(
    ({ line }) => !DEPLOY_RESTATEMENT.test(line) || DEPLOY_SIGNAL_EXIT.test(line),
  );
  const cause = specific.find(
    ({ line }) => DEPLOY_CAUSE.test(line) || DEPLOY_SIGNAL_EXIT.test(line),
  );
  // Restatements nest outward too, so when they are all that is left the first
  // one is the innermost: it still names the step that failed, where the last
  // is the outermost wrapper saying only that something did.
  return (cause ?? specific.at(-1) ?? complaints.at(0))?.index
    ?? (lines.length ? lines.length - 1 : -1);
}

const DEPLOY_DETAIL_MAX_LINES = 24;
const DEPLOY_DETAIL_MAX_CHARS = 2000;
/** Context kept above the cause, for the build step that led into it. */
const DEPLOY_DETAIL_LEAD_LINES = 4;

/**
 * The window around the line that named the cause, rather than the last N lines
 * of everything. A build failure ends in restatements, so a plain tail keeps the
 * least informative part and drops the stack that explains it — and slicing by
 * character count on top of that cuts the first kept line in half.
 */
function clampDeployDetail(lines: string[], causeIndex: number) {
  let kept = lines;
  let skipped = 0;
  if (lines.length > DEPLOY_DETAIL_MAX_LINES) {
    const anchor = causeIndex >= 0 ? causeIndex : lines.length - 1;
    skipped = Math.min(
      Math.max(0, anchor - DEPLOY_DETAIL_LEAD_LINES),
      lines.length - DEPLOY_DETAIL_MAX_LINES,
    );
    kept = lines.slice(skipped, skipped + DEPLOY_DETAIL_MAX_LINES);
  }
  while (kept.length > 1 && kept.join('\n').length > DEPLOY_DETAIL_MAX_CHARS) {
    kept = kept.slice(0, -1);
  }
  const trailing = lines.length - skipped - kept.length;
  return [
    ...(skipped > 0 ? [`… ${skipped} earlier lines omitted …`] : []),
    ...kept,
    ...(trailing > 0 ? [`… ${trailing} later lines omitted …`] : []),
  ].join('\n');
}

/**
 * What went wrong, and what the CLI said while it went wrong.
 *
 * `detail` appears only when the CLI never produced a --json result. When it
 * did, its own message is the whole story and repeating the raw log beside it
 * would just be the same sentence twice.
 */
export function diagnoseMakersDeployFailure(
  stdout: string,
  stderr = '',
  exitCode?: number,
): { error: string; detail?: string } {
  const parsed = parseMakersDeployJson(stdout, stderr);
  if (parsed.status === 'error' && parsed.error !== DEPLOY_PARSE_FAILURE) {
    return { error: parsed.error };
  }

  const lines = readDeployOutputLines(stdout, stderr);
  const causeIndex = pickDeployErrorLine(lines);
  const detail = clampDeployDetail(lines, causeIndex);

  // Ahead of the line picking rather than inside it: the picker is right about
  // which line named the cause here, and the line is still the wrong thing to
  // report. `detail` keeps it, together with the disk report that follows it.
  if (DEPLOY_DISK_FULL_PATTERN.test([stdout, stderr].filter(Boolean).join('\n'))) {
    return { error: DEPLOY_DISK_FULL, ...(detail ? { detail } : {}) };
  }

  // The CLI announced success and then exited non-zero. Quoting a line here
  // would quote that success payload back as the reason it failed; the
  // disagreement between the two is the finding.
  const error = parsed.status === 'success'
    ? `edgeone makers deploy printed a success result but exited with code ${exitCode ?? 'non-zero'}.`
    : lines[causeIndex]
      || (exitCode != null
        ? `edgeone makers deploy exited with code ${exitCode} without printing a result.`
        : DEPLOY_PARSE_FAILURE);
  return detail ? { error, detail } : { error };
}

export function formatMakersDeployFailure(stdout: string, stderr = '', fallback = ''): string {
  const parsed = parseMakersDeployJson(stdout, stderr);
  const combined = [stderr, stdout, fallback].filter(Boolean).join('\n').trim();
  let error = parsed.status === 'error' ? parsed.error : '';
  if (!error || error === DEPLOY_PARSE_FAILURE) {
    error = combined.slice(-1500) || fallback || 'Deploy failed.';
  }
  if (/exceeds \d+ limit/i.test(error) || /exceeds \d+ limit/i.test(combined)) {
    return [
      error.includes('exceeds') ? error : 'Makers project exceeds the account limit.',
      'Do not delete other Makers projects and do not call Pages APIs.',
      'Tell the user the account is out of project quota and present only these choices: free a slot in the console, or reuse an existing project name before rerunning the direct CLI deploy.',
    ].join(' ');
  }
  return error;
}

export type MakersDeployOutcome =
  | Omit<MakersDeploySuccess, 'type'>
  | { status: 'cli-missing'; error: string }
  | {
      status: 'error';
      error: string;
      exitCode?: number;
      /** Raw CLI output, present only when the CLI never phrased its own failure. */
      detail?: string;
    };

/**
 * The single reading of what the CLI just did.
 *
 * Two callers publish — the model through its command tool, and the deploy
 * button through its own pipeline — and a disagreement between them would show
 * as a deployment the UI calls failed while the site is live, or the reverse.
 */
export function readMakersDeployOutcome(
  stdout: string,
  stderr = '',
  secret = '',
): MakersDeployOutcome {
  const combined = [stdout, stderr].filter(Boolean).join('\n');
  if (isEdgeoneCliUnavailable(combined)) {
    return { status: 'cli-missing', error: MAKERS_CLI_UNAVAILABLE_MESSAGE };
  }

  // Read before redacting: the deploy URL carries a token query value that can
  // overlap the credential, and redacting first would cut the link in half.
  const parsed = parseMakersDeployJson(stdout, stderr);
  const exitCode = parseMakersDeployExitCode(combined);
  if (parsed.status === 'success' && (exitCode == null || exitCode === 0)) {
    // Checked here rather than beside the other disagreements below because
    // this one is not a disagreement: the CLI, the exit code and the payload
    // all agree the publish worked, and they are all reporting on the upload
    // rather than on what was uploaded.
    if (combined.includes(MAKERS_DEPLOY_EMPTY_ASSETS_MARKER)) {
      return {
        status: 'error',
        error: DEPLOY_EMPTY_ASSETS,
        ...(exitCode != null ? { exitCode } : {}),
      };
    }
    return {
      status: 'success',
      url: parsed.url,
      ...(parsed.projectId ? { projectId: parsed.projectId } : {}),
      ...(parsed.deploymentId ? { deploymentId: parsed.deploymentId } : {}),
      ...(parsed.consoleUrl ? { consoleUrl: parsed.consoleUrl } : {}),
    };
  }

  // Deliberately not `parsed.error`: when the parse itself is what failed, that
  // field holds only the news that it failed, and returning it here is what
  // reduced every unparseable deploy to one sentence that named no cause.
  const diagnosis = diagnoseMakersDeployFailure(stdout, stderr, exitCode);
  return {
    status: 'error',
    error: redactSecret(diagnosis.error, secret),
    ...(diagnosis.detail ? { detail: redactSecret(diagnosis.detail, secret) } : {}),
    ...(exitCode != null ? { exitCode } : {}),
  };
}

export function describeMakersDeployment(
  outcome: MakersDeployOutcome,
  timing: { startedAt: number; finishedAt?: number },
): DeploymentInfo {
  const finishedAt = timing.finishedAt ?? Date.now();
  if (outcome.status === 'success') {
    const { status, ...details } = outcome;
    return {
      status: 'success',
      startedAt: timing.startedAt,
      finishedAt,
      ...details,
    };
  }
  return {
    status: 'failed',
    startedAt: timing.startedAt,
    finishedAt,
    error: outcome.error,
  };
}

export function isMakersDeployUrl(url?: string | null): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (parsed.pathname === '/preview/' || parsed.pathname.startsWith('/preview/')) {
      return false;
    }
    return /(?:^|\.)edgeone\.(?:cool|ai|link)$/i.test(parsed.hostname)
      || /(?:^|\.)pages\.edgeone\./i.test(parsed.hostname)
      || /(?:^|\.)edgeone\.page$/i.test(parsed.hostname);
  } catch {
    return false;
  }
}

export function redactSecret(text: string, secret: string) {
  if (!secret) return text;
  return text.split(secret).join('[redacted]');
}

