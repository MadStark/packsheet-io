import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * `src/lib/database.types.ts` and the schema, held against each other.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS CATCHES
 * ---------------------------------------------------------------------------
 *
 * Rename a column in a migration and forget to regenerate, and every call site that
 * still names the old column keeps compiling — against a `Database` type describing a
 * schema that no longer exists. Nothing goes wrong until a request is made, and then
 * what goes wrong is `undefined`, on the share page, for a stranger.
 *
 * So the failing thing has to be the build, and the thing the build compares is the
 * committed file against the migrations replayed from empty.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A TEST RATHER THAN A STEP IN ci.yml
 * ---------------------------------------------------------------------------
 *
 * Four workflows run `npm test` and only one of them is `ci.yml`. The two deploys run
 * it before they push migrations and before they build — the last point at which a
 * schema that has moved past the types the site was compiled against can still be
 * stopped, and stopped for free.
 *
 * A workflow step would also never run on a contributor's machine, and this is a check
 * whose value is almost entirely in being told BEFORE pushing. `supabase start && npm
 * test` is already the documented loop for anything touching the database; putting the
 * check inside it costs a second and closes the gap between "my call sites compile" and
 * "my call sites compile against the schema I actually wrote".
 *
 * It runs in the required `check` job because `npm test` does. That matters: a check
 * reporting outside the job registered on branch protection reports without blocking.
 *
 * ---------------------------------------------------------------------------
 * WHY IT SHELLS OUT INSTEAD OF GENERATING THE TYPES HERE
 * ---------------------------------------------------------------------------
 *
 * `scripts/database-types.sh` is the one place that knows how these types are made —
 * which CLI, which flags, which stack. Reimplementing that here would create a second
 * definition of "correct" that agrees with the first until the day it doesn't, and the
 * day it doesn't the failure reads as drift in the schema rather than drift between two
 * copies of a command. It also means the fix named in the error output below is
 * literally the command that just ran, in the mode that writes rather than compares.
 *
 * Like every other database test here it FAILS rather than skips when there is no
 * stack — see the header of tests/support/local-database.ts. A guardrail that reports
 * green while not running is the defect this suite exists to catch.
 */

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const SCRIPT = `${repoRoot}scripts/database-types.sh`;

describe('the committed database types', () => {
  // Generation is a round trip to the local database and back, roughly a second in
  // practice. Vitest's 5s default is close enough to that to fail on a cold container
  // rather than on anything about the schema.
  it('match the schema that supabase/migrations/ produces', { timeout: 30_000 }, () => {
    try {
      execFileSync(SCRIPT, ['check'], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (cause) {
      const { stdout, stderr } = cause as { stdout?: string; stderr?: string };
      const output = `${stderr ?? ''}${stdout ?? ''}`.trim();

      // Nothing to relay: the script is missing, or the Supabase CLI is not installed.
      // The caught error is then the only evidence there is, so it is attached.
      if (!output) {
        throw new Error(`${SCRIPT} check failed without output — is the Supabase CLI installed?`, {
          cause,
        });
      }

      // The script has already written the diff and the remedy, and that text IS the
      // failure — a diff nobody can act on gets deleted. It is reported verbatim rather
      // than replaced by an assertion message saying two strings differ and leaving the
      // reader to go and find out how.
      //
      // `expect.fail` rather than `throw new Error(output, { cause })`: Vitest
      // serialises an attached cause and prints it after the message, so the child
      // process error — which carries the same diff in its `stderr` — reproduces the
      // whole thing a second time with its newlines escaped, pushing the remedy below a
      // wall of `\n`. Measured, not assumed. Nothing is lost by leaving it off: the
      // caught error's stdout and stderr are precisely what is being reported.
      expect.fail(output);
    }
  });
});
