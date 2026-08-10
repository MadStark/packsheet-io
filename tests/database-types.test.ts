import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { POSTGREST_MAJOR } from '../src/lib/supabase';
import { localDatabase } from './support/local-database';

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
 * So the failing thing has to be the build, and what the build compares is the committed
 * file against types generated from the schema in the local stack — which the script
 * refuses to read until it is level with supabase/migrations/, because a stack a
 * migration behind agrees with the committed file about a schema nobody has.
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
 * green while not running is the defect this suite exists to catch, and the second
 * describe block below exists because this file has already been that defect twice.
 */

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const SCRIPT = `${repoRoot}scripts/database-types.sh`;

/** What the script reports on success. Asserted, not merely produced — see below. */
const COMPARED =
  /^Compared src\/lib\/database\.types\.ts against the local database: [1-9]\d* tables, \d+ lines, identical\.$/m;

describe('the committed database types', () => {
  // Generation is two round trips to the local database and back, roughly two seconds in
  // practice. Vitest's 5s default is close enough to that to fail on a cold container
  // rather than on anything about the schema.
  it('match the schema in the local database', { timeout: 30_000 }, () => {
    let stdout: string;
    try {
      stdout = execFileSync(SCRIPT, ['check'], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (cause) {
      const { stdout: out, stderr } = cause as { stdout?: string; stderr?: string };
      const output = `${stderr ?? ''}${out ?? ''}`.trim();

      // Nothing on either stream means the script never ran: it is missing, or its
      // executable bit was lost (a checkout with core.fileMode=false, an archive
      // export). A missing Supabase CLI does NOT land here — bash writes
      // `supabase: command not found` to stderr, which is captured, so that case goes
      // to expect.fail below with the CLI's own words. Measured, not assumed.
      if (!output) {
        const { code } = cause as { code?: string };
        throw new Error(
          `${SCRIPT} produced no output (${code ?? 'unknown error'}) — is it present and executable?`,
          { cause },
        );
      }

      // The script has already written the diff and the remedy, and that text IS the
      // failure — a diff nobody can act on gets deleted. It is reported verbatim rather
      // than replaced by an assertion message saying two strings differ and leaving the
      // reader to go and find out how.
      //
      // `expect.fail` rather than `throw new Error(output, { cause })`: Vitest
      // serialises an attached cause and prints it after the message, so the child
      // process error — which carries the same diff in its `stderr` — reproduces the
      // whole thing a second time with its newlines escaped. Measured, not assumed.
      // Nothing is lost by leaving it off: the caught error's stdout and stderr are
      // precisely what is being reported.
      expect.fail(output);
    }

    // The script exiting 0 is not evidence that it compared anything, and this file has
    // twice shipped a version where it wasn't: `supabase gen types` exits 0 emitting
    // `Database = {}` against an empty schema, and the script's write mode exits 0
    // having rewritten the very file under test. Both reached the user as a green tick
    // through an assertion-free test. So the script says what it did, and this asserts
    // it — including that the schema it compared had tables in it.
    expect(stdout, 'the check exited 0 without reporting a comparison').toMatch(COMPARED);
  });
});

/**
 * The one fact in this chain that is hand-written.
 *
 * `supabase gen types typescript --local` does not emit
 * `__InternalSupabase.PostgrestVersion`, so supabase-js falls back to `'12'` and decides
 * what queries will compile on that basis — against a Data API that is not version 12.
 * src/lib/supabase.ts supplies the number instead, which makes it the only claim about
 * the database in this whole mechanism that the drift check cannot see: that check
 * compares generated output against generated output and never against the running
 * server.
 *
 * So it is pinned against what the server says about itself. Without this, the fix for
 * one silent divergence is just a slower silent divergence.
 */
describe('the PostgREST version the types are built for', () => {
  it('matches the version the Data API reports', async () => {
    const { apiUrl, anonKey } = localDatabase();
    const response = await fetch(`${apiUrl}/rest/v1/`, { headers: { apikey: anonKey } });

    const server = response.headers.get('server');
    expect(server, 'the Data API reported no Server header to check against').toMatch(
      /^postgrest\/\d+/,
    );
    expect(
      /^postgrest\/(\d+)/.exec(server ?? '')?.[1],
      'POSTGREST_MAJOR in src/lib/supabase.ts is not the version this stack runs',
    ).toBe(POSTGREST_MAJOR);
  });
});

/**
 * The script's own failure branches, against a stubbed Supabase CLI.
 *
 * These need no database, on purpose. They cover the paths that only execute when
 * something has already gone wrong — which is exactly when nobody wants to discover the
 * error handling was never run. Two of them also pin behaviour that has no other
 * exercise on this branch at all:
 *
 * - `scripts/supabase.sh` resolution is dead code here and first executes on somebody
 *   else's pull request, after Ref 54 lands. A typo in it would surface then as an
 *   unrelated red build. Every case below works by placing that wrapper and observing
 *   that the script used it, so the branch is pinned now.
 * - `write` mode is never otherwise exercised, despite being the remedy every failure
 *   message names.
 */

/** A stub Supabase CLI: answers `migration list` and `gen types`, nothing else. */
function sandbox(options: { migrations?: string; types?: string; genExit?: number }): string {
  const dir = mkdtempSync(join(tmpdir(), 'packsheet-db-types-'));
  mkdirSync(join(dir, 'scripts'));
  mkdirSync(join(dir, 'src', 'lib'), { recursive: true });
  copyFileSync(SCRIPT, join(dir, 'scripts', 'database-types.sh'));

  const migrations = options.migrations ?? '{"migrations":[{"local":"1","remote":"1"}]}';

  // The generated output goes in a file the stub cats, rather than inline in the script.
  // Interpolating it would put it through two layers of escaping — `printf '%s'` does not
  // expand `\n`, so a newline written that way arrives as a literal backslash-n and the
  // comparison fails for a reason that has nothing to do with what is under test.
  writeFileSync(join(dir, 'scripts', 'stub-types.txt'), options.types ?? '');
  writeFileSync(
    join(dir, 'scripts', 'supabase.sh'),
    `#!/usr/bin/env bash
here="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
case "$*" in
  *"migration list"*) printf '%s\\n' '${migrations}' ;;
  *"gen types"*) cat "$here/stub-types.txt"; exit ${options.genExit ?? 0} ;;
  *) echo "stub: unexpected $*" >&2; exit 64 ;;
esac
`,
    { mode: 0o755 },
  );
  return dir;
}

/** Run the copied script in its sandbox and report exit status with both streams. */
function run(dir: string, args: string[] = []): { status: number; output: string } {
  try {
    const stdout = execFileSync(join(dir, 'scripts', 'database-types.sh'), args, {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, output: stdout };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? -1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

/** One table's worth of generated output — enough to satisfy the "has tables" gate. */
const ONE_TABLE = `export type Database = {
  public: {
    Tables: {
      gear_items: {
        Row: {
          id: string
        }
      }
    }
  }
}
`;

describe('scripts/database-types.sh', () => {
  it('prefers scripts/supabase.sh over the CLI when it exists', () => {
    const dir = sandbox({ types: ONE_TABLE });
    try {
      writeFileSync(join(dir, 'src', 'lib', 'database.types.ts'), ONE_TABLE);
      const { status, output } = run(dir, ['check']);
      // The sandbox has no supabase/config.toml and the real CLI is not on its way to
      // succeeding there, so a clean comparison is only reachable through the wrapper.
      expect(output).toMatch(COMPARED);
      expect(status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a generation that describes no tables, rather than agreeing with it', () => {
    // `supabase gen types` exits 0 emitting this against a database whose migrations did
    // not apply. Compared against a committed file generated the same way it matches
    // perfectly, which is a green tick certifying nothing.
    const empty = 'export type Database = {}\n';
    const dir = sandbox({ types: empty });
    try {
      writeFileSync(join(dir, 'src', 'lib', 'database.types.ts'), empty);
      const { status, output } = run(dir, ['check']);
      expect(status).toBe(1);
      expect(output).toContain('described no tables');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to write a file generated from a stack the migrations have not reached', () => {
    const dir = sandbox({
      migrations: '{"migrations":[{"local":"1","remote":"1"},{"local":"2","remote":""}]}',
      types: ONE_TABLE,
    });
    try {
      writeFileSync(join(dir, 'src', 'lib', 'database.types.ts'), 'stale\n');
      const { status, output } = run(dir, ['write']);
      expect(status).toBe(1);
      expect(output).toContain('not level with supabase/migrations/');
      expect(output).toContain('migrations on disk that the stack has not applied: 1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('relays what the generator actually said when it fails', () => {
    // The CLI reports connection failures on STDOUT, which is the stream the script
    // redirects into its temp file. Relaying only a fixed hint would delete the one line
    // naming the port — and with a stack per worktree, the wrong port is the common
    // failure, not an exotic one.
    const dir = sandbox({
      types: '{"error":{"message":"connect ECONNREFUSED 127.0.0.1:54399"}}',
      genExit: 1,
    });
    try {
      const { status, output } = run(dir, ['check']);
      expect(status).toBe(1);
      expect(output).toContain('ECONNREFUSED 127.0.0.1:54399');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects an unrecognised mode rather than falling back to one', () => {
    const dir = sandbox({ types: ONE_TABLE });
    try {
      const { status, output } = run(dir, ['wrtie']);
      expect(status).toBe(2);
      expect(output).toContain('usage:');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
