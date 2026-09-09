/**
 * Refresh the vendored Makers skills from the upstream skills repository.
 *
 * The skills are edited in edgeone-makers-tools and consumed here as real,
 * committed files. They cannot be a symlink to a checkout next door: the
 * runtime resolves them from process.cwd(), the compatibility lint reads its
 * rules and framework profiles out of them, and three test files read the
 * directory directly — so a clone, CI, and the deployed bundle all need the
 * files to be inside this repository. A symlink satisfies only the machine that
 * created it, and it makes git report every vendored file as deleted.
 *
 * What this copies is the source checkout's working tree, not a branch it
 * resolves on its own — that keeps the debugging loop short, since edits to a
 * skill are picked up without committing them first. The branch is therefore
 * something to verify rather than something to choose: the skills repo carries
 * a dozen of them, and syncing whichever one happens to be checked out is how
 * the wrong tree lands here without a word.
 *
 * Usage:
 *   npm run sync:skills
 *   MAKERS_SKILLS_BRANCH=main npm run sync:skills
 *   MAKERS_SKILLS_REPO=/path/to/edgeone-makers-tools npm run sync:skills
 */

import { execFile } from 'node:child_process';
import { cp, lstat, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const repoRoot = path.resolve(import.meta.dirname, '..');
const source = path.resolve(
  repoRoot,
  process.env.MAKERS_SKILLS_REPO || '../edgeone-makers-tools',
);
const sourceSkills = path.join(source, 'skills');
const destination = path.join(repoRoot, '.claude', 'skills');

/**
 * The branch the vendored tree is expected to come from.
 *
 * Move this to main once the framework work merges upstream. Until then a sync
 * from main would quietly drop the makers-frameworks skill, and the failure
 * would surface as a lint that cannot find its framework profiles.
 *
 * Deliberately not `feature/operating-contract`, the other line upstream keeps.
 * It tells an agent to sign in, install the CLI and persist credentials — three
 * things `agents/_prompt.ts` forbids and the tool layer refuses outright, so
 * vendoring it would put two contradicting instructions in the same context and
 * spend turns on the wrong one. The corrections worth having from that line were
 * carried over to this branch on their own.
 */
const EXPECTED_BRANCH = process.env.MAKERS_SKILLS_BRANCH || 'feature/framework';

/** The file that proves this is the skills repository and not some directory. */
const SENTINEL = path.join(sourceSkills, 'edgeone-makers-tools', 'SKILL.md');

function fail(message) {
  console.error(`sync:skills — ${message}`);
  process.exit(1);
}

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function countMarkdown(dir) {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      total += await countMarkdown(path.join(dir, entry.name));
    } else if (entry.name.endsWith('.md')) {
      total += 1;
    }
  }
  return total;
}

/**
 * Branch, commit, and whether the skills subtree has uncommitted edits.
 *
 * All three are best effort: a source that is not a git checkout at all — an
 * extracted archive, say — has no branch to get wrong, so there is nothing for
 * the check below to protect and refusing to run would only be unhelpful.
 */
async function describeSource() {
  const git = async (...args) => (
    (await run('git', ['-C', source, ...args])).stdout.trim()
  );
  try {
    const [branch, commit, dirty] = await Promise.all([
      git('rev-parse', '--abbrev-ref', 'HEAD'),
      git('rev-parse', '--short', 'HEAD'),
      git('status', '--porcelain', '--', 'skills'),
    ]);
    return { branch, commit, dirty: dirty.length > 0 };
  } catch {
    return undefined;
  }
}

if (!(await exists(SENTINEL))) {
  fail(
    `no skills found at ${sourceSkills}.\n`
    + '  Clone TencentEdgeOne/edgeone-makers-tools next to this repository, or\n'
    + '  point MAKERS_SKILLS_REPO at your checkout.',
  );
}

const origin = await describeSource();
if (origin && origin.branch !== EXPECTED_BRANCH) {
  fail(
    `the skills checkout is on ${origin.branch}, not ${EXPECTED_BRANCH}.\n`
    + `  Switch it with: git -C ${path.relative(repoRoot, source)} checkout ${EXPECTED_BRANCH}\n`
    + `  Or sync from the branch you have: MAKERS_SKILLS_BRANCH=${origin.branch} npm run sync:skills`,
  );
}

// Copy to a scratch directory first. Replacing the vendored tree in place would
// leave the project with no skills at all if the copy failed halfway, and every
// test and the agent itself would then fail on a missing file rather than on
// whatever actually went wrong here.
const staging = await mkdtemp(path.join(os.tmpdir(), 'makers-skills-'));
try {
  await cp(sourceSkills, staging, {
    recursive: true,
    dereference: true,
    filter: (entry) => !path.basename(entry).startsWith('.'),
  });

  const files = await countMarkdown(staging);
  if (files === 0) fail('the source contains no skill documents; refusing to replace the vendored copy.');

  // lstat, not stat: the point is to notice a symlink rather than follow it.
  const current = await lstat(destination).catch(() => null);
  if (current) await rm(destination, { recursive: true, force: true });

  await cp(staging, destination, { recursive: true });

  const from = current?.isSymbolicLink() ? ' (replacing a symlink with real files)' : '';
  const ref = origin ? `${origin.branch}@${origin.commit}` : 'an untracked source';
  console.log(`sync:skills — ${files} documents from ${ref}${from}`);

  // Worth saying out loud: content that is only in a working tree exists in no
  // history, so the vendored copy committed here would be unreproducible from
  // the skills repo, and a later sync would silently revert it.
  if (origin?.dirty) {
    console.warn(
      'sync:skills — warning: the skills checkout has uncommitted changes under skills/.\n'
      + '  They are now vendored here but exist in no commit upstream. Commit them in\n'
      + '  the skills repo, or a later sync will take them back out.',
    );
  }
  console.log('Review with: git status .claude/skills');
} finally {
  await rm(staging, { recursive: true, force: true });
}
