import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileFromSandbox } from '../agents/project/_fs.ts';
import { projectState } from './helpers/fixtures.ts';

/** A workspace whose every read fails, with the message the real one raised. */
function failingRead(message: string) {
  return {
    sandbox: {
      files: {
        read: async () => { throw new Error(message); },
      },
    },
  };
}

// The sandbox files a directory read under SANDBOX_UNKNOWN_ERROR, the same code
// it uses when it has genuinely lost track of what went wrong — and the prompt
// reads that code as output having been dropped. So the one failure the model
// could fix by itself arrives looking like the one it cannot.
//
// The session that found it had just read +Layout.tsx and +Head.tsx, which both
// import a logo out of `assets`, and asked to read `assets` to see what else was
// in there. Nothing in the answer said to list it instead.
test('a directory read says so, and says what to do instead', async () => {
  const result = await readFileFromSandbox(
    failingRead(
      'Sandbox file read failed: <project>/assets [instanceId=bgjer455pky7otgbgozfsxins7kxhdw7'
      + "vwv6givo, expiresAt=2026-09-08T10:30:26+08:00]: path '/home/user/<project>/assets' is"
      + ' a directory (code=SANDBOX_UNKNOWN_ERROR, operation=file)',
    ),
    projectState('projects/demo'),
    'assets',
  );

  assert.equal(result.ok, false);
  assert.match(String(result.error), /is a directory, not a file/);
  assert.match(String(result.error), /List it/);
  // The instance id and the misleading code go with it. Neither survives into
  // the transcript the next turn is answered from.
  assert.doesNotMatch(String(result.error), /SANDBOX_UNKNOWN_ERROR|instanceId/);
});

test('EISDIR is the same answer under the other name', async () => {
  const result = await readFileFromSandbox(
    failingRead("EISDIR: illegal operation on a directory, read '/home/user/app/src'"),
    projectState('projects/demo'),
    'src',
  );
  assert.match(String(result.error), /is a directory, not a file/);
});

// Two sentences that fit two conditions. Anything else is passed through as it
// came, because flattening it into either one would describe a problem the
// model does not have and send it looking for a file that is not the trouble.
test('a missing file and an unrecognised failure keep their own answers', async () => {
  const state = projectState('projects/demo');

  const missing = await readFileFromSandbox(
    failingRead("ENOENT: no such file or directory, open '/home/user/app/nope.ts'"),
    state,
    'nope.ts',
  );
  assert.equal(missing.error, 'File does not exist.');

  const unrecognised = await readFileFromSandbox(
    failingRead('connection reset by peer'),
    state,
    'app.ts',
  );
  assert.equal(unrecognised.error, 'connection reset by peer');
});
