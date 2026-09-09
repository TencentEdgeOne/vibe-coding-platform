/**
 * Start `npm install` when the dependencies are known, not when the model gets
 * around to asking for it.
 *
 * Measured on a TanStack Start run: package.json landed 126s in, the install
 * started at 199s, and the 73s between them went to writing the other fourteen
 * files. The install itself took 204s — 42% of a 490s session — and none of it
 * needed the rest of the project to exist. Warming it up at the first write
 * overlaps that gap with work the user is already watching happen.
 *
 * The whole design rests on one rule: never two npm processes on one
 * node_modules. A half-written tree fails in ways that read as project bugs
 * (ENOTEMPTY, a module that resolves to nothing), and the run then spends its
 * turns on a mess the harness made. So nothing here kills a warmup to get out
 * of the way, and nothing starts a second one — the callers wait instead, which
 * costs at worst the time the warmup would have cost anyway.
 */

/**
 * Outside the project directory, so an install never sees its own bookkeeping,
 * and shared by every caller because there is only ever one warmup. Overridable
 * only so the tests can run the real scripts without touching a live sandbox's
 * state or colliding with each other.
 */
export const NPM_WARMUP_BASE = '/tmp/npm-warmup';

function warmupPaths(base: string) {
  return {
    pid: `${base}.pid`,
    log: `${base}.log`,
    done: `${base}.done`,
    stamp: `${base}.stamp`,
  };
}

/** cksum is POSIX; md5sum is not, and this runs in whatever image is current. */
const STAMP_OF_PACKAGE_JSON = `cksum package.json 2>/dev/null | cut -d' ' -f1,2`;

/**
 * npm keeps every tarball it downloads, so an install pays for the same bytes
 * twice: once in ~/.npm, once extracted into node_modules. On a 1.1G sandbox
 * disk that is the difference between fitting and not — a measured Next.js
 * session held 460M of cache beside 422M of project, died of ENOSPC with 25M
 * free, and got 456M back from this one command. Nothing reads the cache
 * afterwards that a re-download cannot serve, and the build still needs room.
 */
const RECLAIM_NPM_CACHE = 'npm cache clean --force > /dev/null 2>&1';

export const NPM_WARMUP_NOTICE = 'This install was already running in the '
  + 'background: the host started it when package.json was written, and the '
  + 'output above is that run. Nothing was installed twice.';

/**
 * Kick off the install, or do nothing at all.
 *
 * Silent and best-effort by design — it runs as a side effect of writing a
 * file, and a warmup that cannot start is not a reason for that write to fail.
 * The model is never told this happened; it just finds its own install already
 * finished.
 */
export function buildNpmWarmupCommand(base = NPM_WARMUP_BASE) {
  const at = warmupPaths(base);
  return [
    'set +e',
    // Already installed, or nothing to install from: nothing to warm up.
    '[ -d node_modules ] && exit 0',
    '[ -f package.json ] || exit 0',
    // A warmup is already in flight. Leaving it alone is the point: if this
    // write changed package.json, the handoff below will notice the stamp no
    // longer matches and run the model's own install after this one drains.
    `if [ -f ${at.pid} ] && kill -0 "$(cat ${at.pid} 2>/dev/null)" 2>/dev/null; then exit 0; fi`,
    `rm -f ${at.done} ${at.log}`,
    `${STAMP_OF_PACKAGE_JSON} > ${at.stamp}`,
    // The exit code has to outlive the shell that started it, so it is written
    // where the handoff can read it rather than returned to anyone. Reclaiming
    // the cache comes after that record so it cannot overwrite the code, and
    // before this shell exits so the wait above covers it like the install.
    `nohup sh -c '${[
      `npm install --no-audit --no-fund > ${at.log} 2>&1`,
      `echo "$?" > ${at.done}`,
      RECLAIM_NPM_CACHE,
    ].join('; ')}' > /dev/null 2>&1 &`,
    `echo $! > ${at.pid}`,
    'exit 0',
  ].join('\n');
}

/**
 * Block until no warmup is running.
 *
 * Prepended to builds as well as installs. A build is the case that made this
 * necessary: `npm run build` beside a running install reads a node_modules that
 * is still being written, and fails for reasons that are nowhere in the project.
 */
export function buildNpmWarmupWaitScript(base = NPM_WARMUP_BASE) {
  const at = warmupPaths(base);
  return [
    `if [ -f ${at.pid} ]; then`,
    `  __warmup_pid=$(cat ${at.pid} 2>/dev/null)`,
    '  if [ -n "$__warmup_pid" ]; then',
    '    while kill -0 "$__warmup_pid" 2>/dev/null; do sleep 1; done',
    '  fi',
    'fi',
  ].join('\n');
}

/**
 * Wait for the warmup, then stand in for the model's install if it did the
 * same work and succeeded at it.
 *
 * Only a success can stand in. A failure is a record of the conditions at one
 * moment, not a verdict on the project, and replaying it turned a recoverable
 * ENOSPC into an unrecoverable one: the model cleared 456M of npm cache, and
 * every retry still got the same stale error back in a second and a half,
 * until it thought to rewrite package.json to break the stamp. So a failed
 * warmup is discarded and the install runs for real, which is also how the
 * model learns of a genuine failure — from its own command, not a recording.
 *
 * Emits the EXIT: marker itself because it exits before the caller's echo — see
 * withExitCodeEcho in shared/tool-phase.ts, which the sandbox needs since it
 * discards output whenever the shell exits non-zero.
 */
export function buildNpmWarmupHandoffScript(base = NPM_WARMUP_BASE) {
  const at = warmupPaths(base);
  return [
    buildNpmWarmupWaitScript(base),
    // A stamp mismatch means package.json moved after the warmup read it, so
    // the warmup installed the wrong thing. Falling through re-runs the install
    // over a tree it already populated, which is the fast path npm is good at.
    `if [ -f ${at.done} ] && [ -f ${at.stamp} ] \\`,
    `  && [ "$(${STAMP_OF_PACKAGE_JSON})" = "$(cat ${at.stamp} 2>/dev/null)" ]; then`,
    `  if [ "$(cat ${at.done} 2>/dev/null)" = "0" ]; then`,
    `    cat ${at.log} 2>/dev/null`,
    `    echo ${JSON.stringify(NPM_WARMUP_NOTICE)}`,
    '    echo "EXIT:0"',
    '    exit 0',
    '  fi',
    // A full disk is the one failure the retry can fix by itself, so it does,
    // and the model never has to spend its turns discovering that the cache
    // and the project share 1.1G.
    `  if grep -q ENOSPC ${at.log} 2>/dev/null; then ${RECLAIM_NPM_CACHE}; fi`,
    `  rm -f ${at.done} ${at.log} ${at.stamp}`,
    'fi',
  ].join('\n');
}

/**
 * Give the cache's disk back after an install the model ran itself.
 *
 * The warmup has reclaimed its own cache since it started doing the install,
 * but the model's install was left out, and that is the path that actually
 * filled the disk: a turn whose package.json never changed gets no warmup at
 * all, so `npm install` runs raw, leaves 494M of cache behind, and the next
 * thing needing room does not get it. Same reclamation, same reasoning — the
 * tree is what the project runs on, the cache is a download receipt.
 *
 * Runs after the EXIT: marker and swallows its own failure, both deliberately.
 * The sandbox discards a script's entire output when it exits non-zero, and a
 * full disk is exactly what stops `npm cache clean` from writing, so without
 * the guard the one install whose log the model most needs is the one it would
 * lose.
 */
export function buildNpmCacheReclaimScript() {
  return `${RECLAIM_NPM_CACHE} || true`;
}
