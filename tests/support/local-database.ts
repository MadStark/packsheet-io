/**
 * The local Supabase stack, as the row-level-security tests reach it.
 *
 * ---------------------------------------------------------------------------
 * WHY THESE TESTS TALK TO A REAL DATABASE
 * ---------------------------------------------------------------------------
 *
 * Ref 49 asks for tests that run **as the `anon` role**, and is explicit about why:
 * a test that connects as the superuser bypasses RLS entirely and passes no matter
 * what the policies say. There is no unit-testable stand-in for that. A policy is a
 * SQL expression evaluated by Postgres against a role, and the only thing that can
 * tell you what it does is Postgres, evaluating it, as that role.
 *
 * So these tests need a running stack, and they FAIL — loudly, with the command to
 * fix it — when there is not one. They never skip. A skipped test reports green, and
 * a guardrail that reports green while not running is the precise defect this
 * project's suite exists to catch (see the header of vitest.config.ts, and the
 * `src/pages` rule in ci.yml). `.github/workflows/ci.yml` starts the stack before
 * `npm test` for the same reason.
 *
 * ---------------------------------------------------------------------------
 * HOW AN AUTHENTICATED IDENTITY IS OBTAINED
 * ---------------------------------------------------------------------------
 *
 * By inserting a row in `auth.users` and minting a JWT for it against the local
 * stack's own signing secret — NOT by calling `auth.signUp()`.
 *
 * That looks like the less faithful choice and is deliberately the more honest one.
 * What PostgREST does with a request is decided entirely by the token's `role` and
 * `sub` claims: it switches to that role and exposes the claims to `auth.uid()`. A
 * token minted here and a token returned by a real sign-up are the same object to
 * every line of policy under test. What sign-up would add is a dependency on GoTrue's
 * email flow and on `auth.rate_limit.sign_in_sign_ups`, which is 30 per five minutes
 * per IP — shared by every test file, every worker, and every re-run. That turns
 * "run the tests twice while fixing something" into a rate-limited failure with
 * nothing to do with the policy that broke, which is how a suite earns a reputation
 * for flakiness and starts getting skipped.
 *
 * The sign-up path itself belongs to Ref 19, which owns authentication. This file
 * tests the boundary, not the door.
 */

import { spawnSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';
import type { Database } from '../../src/lib/database.types';
import { POSTGREST_MAJOR, type PacksheetClient } from '../../src/lib/supabase';

/**
 * Re-exported so the fixtures and the tests have one name to reach for. The type itself
 * lives in src/lib/, not here: the schema and the PostgREST version it carries are facts
 * about the database, and will be just as true for the query code Refs 4 and 37 write.
 * Declaring it in tests/ would guarantee a second, hand-written copy later — and a
 * hand-written copy is the one thing the drift check cannot see.
 */
export type { PacksheetClient };

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

export interface LocalDatabase {
  /** PostgREST + GoTrue, the surface a browser talks to. */
  apiUrl: string;
  /** The publishable key. Public by design; RLS is what makes that safe. */
  anonKey: string;
  /** Superuser connection, for catalogue assertions ONLY — never for fixtures. */
  dbUrl: string;
  jwtSecret: string;
}

const START_HINT =
  'Start it with `npm run db:start`, then `npm run db:reset` to replay the migrations.';

/**
 * Ask the CLI where this worktree's stack is.
 *
 * Through `scripts/supabase.sh`, which is the only thing that knows this worktree's
 * ports: supabase/config.toml reads its project name and all seven ports from the
 * environment so each worktree gets its own stack, and the CLI cannot default an
 * `env(...)`. A bare `supabase status` therefore does not report the wrong stack, it
 * fails to parse the config at all — `ProjectConfigParseError`, naming neither cause nor
 * fix.
 *
 * There is no fallback to a bare `supabase`, and that is deliberate. This file ships in
 * the same checkout as the wrapper, so a missing wrapper is not an older layout to be
 * tolerated — it is a broken tree, and falling back would run a command that cannot parse
 * the config and then report it as "the stack is not running", which is advice that sends
 * the reader in the wrong direction.
 */
function readStatusEnv(): Record<string, string> {
  const script = `${repoRoot}scripts/supabase.sh`;
  if (!existsSync(script)) {
    throw new Error(
      `scripts/supabase.sh is missing from this checkout. It is the only thing that knows this worktree's ports; the CLI cannot read supabase/config.toml without it.`,
    );
  }
  const [command, ...leading] = [script];

  // spawnSync, and BOTH streams. This used to be execFileSync reading stdout only, and
  // that quietly disabled the partial-stack check below: the CLI prints its settings on
  // stdout but the `Stopped services: [...]` notice on STDERR, so the scan for it never
  // matched and the throw was unreachable. The guard existed, read convincingly, and
  // could not fire.
  const result = spawnSync(command, [...leading, 'status', '-o', 'env'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  if (result.error || result.status !== 0) {
    throw new Error(
      `Could not reach the local Supabase stack: \`${command} status\` failed. ${START_HINT}`,
      { cause: result.error ?? new Error(result.stderr || `exit ${result.status}`) },
    );
  }

  const raw = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;

  // KEY="value" lines, interleaved with human-readable notices that must not be parsed
  // as settings — but one of those notices is load-bearing and used to be thrown away.
  //
  // `supabase status` exits 0 and prints a full, correct-looking env block when only
  // SOME containers are up, listing the rest on a `Stopped services: [...]` line. So a
  // stack with PostgREST down reports every URL and key it would have had, this function
  // returned them happily, and the tests died on an opaque hook timeout instead of the
  // actionable message below. `supabase start` leaves exactly that state behind when a
  // container fails, so it is the common failure, not an exotic one.
  const env: Record<string, string> = {};
  let stopped = '';
  for (const line of raw.split('\n')) {
    const match = /^([A-Z0-9_]+)="(.*)"$/.exec(line.trim());
    if (match) {
      env[match[1]] = match[2];
      continue;
    }
    const notice = /^Stopped services:\s*\[(.*)\]$/.exec(line.trim());
    if (notice) stopped = notice[1];
  }

  // Only the services these tests actually depend on. Studio, mailpit and the edge
  // runtime being down is not a reason to fail a database test.
  const required = ['_db', '_rest', '_auth'].filter((service) => stopped.includes(service));
  if (required.length > 0) {
    throw new Error(
      `The local Supabase stack is only partly up — these are stopped: ${stopped}. ${START_HINT}`,
    );
  }

  return env;
}

let cached: LocalDatabase | undefined;

/**
 * Connection details for this worktree's stack.
 *
 * Environment variables win, so CI (and anyone pointing at a stack the CLI does not
 * know about) can supply them directly without a CLI round trip.
 */
export function localDatabase(): LocalDatabase {
  if (cached) return cached;

  // SUPABASE_-prefixed variables are an explicit override and win outright. Everything
  // else comes from the CLI, as one set, describing one stack.
  //
  // What is deliberately NOT read is the ambient unprefixed `API_URL` / `DB_URL` /
  // `ANON_KEY`. An earlier version fell back to those and let `process.env` outrank the
  // CLI, which meant a `DB_URL` exported by a direnv or a shell profile silently
  // redirected the superuser half of the suite to a different database while the
  // PostgREST half still talked to this one. That is not hypothetical here: this project
  // runs one Supabase stack per worktree, so the other database is the same schema at a
  // different version, and the catalogue sweep would have certified one branch by
  // reading another. `DB_URL` is far too common a name to trust from the environment.
  const override =
    process.env.SUPABASE_API_URL &&
    process.env.SUPABASE_ANON_KEY &&
    process.env.SUPABASE_DB_URL &&
    process.env.SUPABASE_JWT_SECRET;

  const env = override
    ? {
        API_URL: process.env.SUPABASE_API_URL,
        ANON_KEY: process.env.SUPABASE_ANON_KEY,
        DB_URL: process.env.SUPABASE_DB_URL,
        JWT_SECRET: process.env.SUPABASE_JWT_SECRET,
      }
    : readStatusEnv();

  const apiUrl = env.API_URL;
  const anonKey = env.ANON_KEY;
  const dbUrl = env.DB_URL;
  const jwtSecret = env.JWT_SECRET;

  const missing = Object.entries({ apiUrl, anonKey, dbUrl, jwtSecret })
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(
      `The local Supabase stack did not report ${missing.join(', ')}. It is probably not running. ${START_HINT}`,
    );
  }

  cached = { apiUrl: apiUrl!, anonKey: anonKey!, dbUrl: dbUrl!, jwtSecret: jwtSecret! };
  return cached;
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

const base64url = (input: Buffer | string): string =>
  Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** An HS256 token in the shape PostgREST reads: `role` selects the database role, `sub` becomes auth.uid(). */
function mintAccessToken(userId: string, secret: string): string {
  const issuedAt = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({
      sub: userId,
      role: 'authenticated',
      aud: 'authenticated',
      iat: issuedAt,
      exp: issuedAt + 3600,
    }),
  );
  const signature = base64url(createHmac('sha256', secret).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${signature}`;
}

/**
 * No session persistence and no refresh timer. Both would outlive the test that
 * created the client and keep the worker alive after the assertions finish.
 */
const clientOptions = (accessToken?: string, fetchImpl?: typeof fetch) => ({
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  global: {
    ...(accessToken ? { headers: { Authorization: `Bearer ${accessToken}` } } : {}),
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  },
});

/** A stranger: exactly what a browser loading a share page has. */
export function anonClient(fetchImpl?: typeof fetch): PacksheetClient {
  const { apiUrl, anonKey } = localDatabase();
  return createClient<Database, { PostgrestVersion: typeof POSTGREST_MAJOR }>(
    apiUrl,
    anonKey,
    clientOptions(undefined, fetchImpl),
  );
}

/**
 * A `fetch` that counts calls.
 *
 * "A pack with 40 items loads in one round trip" (Ref 7) is a claim about the number
 * of HTTP requests, and the only honest way to test it is to count them. Asserting
 * that the returned object has the right shape would pass just as happily against a
 * client that made five requests and stitched the results together.
 */
export function countingFetch(): { fetch: typeof fetch; count: () => number } {
  let count = 0;
  const counting: typeof fetch = (...args) => {
    count += 1;
    return fetch(...args);
  };
  return { fetch: counting, count: () => count };
}

export interface TestUser {
  id: string;
  email: string;
  /** Authenticated as this user, through PostgREST, under RLS. */
  client: PacksheetClient;
}

/**
 * A signed-in user.
 *
 * The `auth.users` row exists because every core table's `user_id` has a foreign key
 * to it; only `id` is required without a default.
 */
export async function createUser(label = 'user'): Promise<TestUser> {
  const { apiUrl, anonKey, jwtSecret } = localDatabase();
  const id = randomUUID();
  const email = `${label}-${id}@packsheet.test`;

  await adminSql('insert into auth.users (id, email) values ($1, $2)', [id, email]);

  return {
    id,
    email,
    client: createClient<Database, { PostgrestVersion: typeof POSTGREST_MAJOR }>(
      apiUrl,
      anonKey,
      clientOptions(mintAccessToken(id, jwtSecret)),
    ),
  };
}

/**
 * The full pack tree, in the shape the share page will ask PostgREST for — see below for
 * why a select no page issues yet lives in tests/ at all.
 *
 * Ordering is applied by packTreeQuery() rather than written here, because PostgREST
 * orders an embedded resource from a separate parameter, not from the select list.
 *
 * EVERY COLUMN THE TOTALS ENGINE READS IS HERE, and that is a requirement rather than
 * generosity. `src/lib/totals.ts` takes `consumable`, `packed`, `price` and `currency`
 * as required fields, and tests/totals.test.ts asserts at compile time that this
 * select's inferred row type is assignable to `PackTreePack` — so dropping one of them
 * from this string fails `tsc --noEmit` rather than quietly changing what a total
 * means. The failure it prevents is not hypothetical: with `price` unselected, a pack
 * whose one deleted gear item carried a snapshot (which DOES capture price, whatever
 * the select asked for) reported that single item's price as the whole pack's cost.
 *
 * WIDENING THIS SELECT PUBLISHES NOTHING. This constant lives in tests/, is used only
 * by this suite, and no share page exists yet. `anon` already holds `grant select on
 * public.gear_items` for the whole table — the migration's grants block records exactly
 * that, along with why column-level grants cannot be used while PostgREST embeds are —
 * so asking for `price` here reads a column anon could already read, and no policy or
 * privilege changes either way.
 *
 * Whether the live share page should EXPOSE prices to anonymous readers was left open
 * when this select was widened, and has since been decided: it should. A price is public,
 * on the same footing as a weight. What a setup cost is a large part of why anyone shares
 * a pack list in the first place — it is the comparison the reader came to make — so
 * there is nothing here to protect. tests/rls-anon.test.ts pins that a public pack really
 * does carry its prices to a stranger, so the decision is checkable rather than merely
 * written down.
 *
 * That settles `price` and `currency` and nothing else. The grants block's known gap is
 * `notes`, `url` and `user_id` — a private aside, often an order-confirmation link, and
 * the owner's JWT `sub`, which lets a stranger group public packs by author. None of
 * those is something a reader came for, and all three are still Ref 26's to close.
 */
export const PACK_TREE_SELECT =
  'id, name, slug, visibility, locked_at, pack_categories(id, name, position, pack_items(id, quantity, worn, consumable, packed, position, overrides, snapshot, gear_items(id, name, brand, weight, weight_unit, price, currency)))';

// ---------------------------------------------------------------------------
// Superuser access — catalogue only
// ---------------------------------------------------------------------------

/**
 * Runs SQL as `postgres`, which BYPASSES row level security.
 *
 * That is the point for the two jobs it has here — reading `pg_class` and
 * `information_schema` to assert how the tables are configured, and creating the
 * `auth.users` rows that the Data API has no anonymous route to create.
 *
 * It is emphatically NOT the way to build fixtures. Every pack, category and item in
 * these tests is inserted through PostgREST as its owner, so the insert policies are
 * exercised on the way in and a fixture that RLS would have refused cannot quietly
 * come into existence and make a later assertion pass.
 */
export async function adminSql<T extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  // Multi-statement strings are refused, and this is a correctness guard rather than
  // fussiness. node-postgres returns an ARRAY of results for one, and an earlier version
  // of this function returned the LAST result's rows — so any query ending in a `set` or
  // `reset` returned `[]`. Every catalogue assertion in this suite is of the form
  // `expect(rows).toEqual([])`, which means "adminSql returned nothing" is the PASSING
  // condition for all of them: one trailing `set` would have turned the RLS sweep, the
  // grants sweep and the definer sweep green simultaneously and silently. Use
  // adminSqlWith() when a session setting is genuinely needed.
  if (/;\s*\S/.test(text.trim().replace(/;\s*$/, ''))) {
    throw new Error(
      'adminSql takes a single statement — use adminSqlWith(setup, query) for session settings.',
    );
  }

  const client = new pg.Client({ connectionString: localDatabase().dbUrl });
  await client.connect();
  try {
    const result = await client.query(text, params);
    return result.rows as T[];
  } finally {
    await client.end();
  }
}

/**
 * Run one or more session settings, then a query, on the same connection.
 *
 * Separate statements over one client rather than a semicolon-joined string: each
 * `set` is issued and acknowledged in its own round trip, so a typo in one fails at
 * that statement instead of silently changing which result set the caller reads.
 * `adminSql` opens a fresh connection per call, which is why a `set` issued through it
 * would be gone before the next statement ran.
 */
export async function adminSqlWith<T extends Record<string, unknown> = Record<string, unknown>>(
  setup: string[],
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const client = new pg.Client({ connectionString: localDatabase().dbUrl });
  await client.connect();
  try {
    for (const statement of setup) await client.query(statement);
    const result = await client.query(text, params);
    return result.rows as T[];
  } finally {
    await client.end();
  }
}

/**
 * The pack tree, ordered, as one PostgREST request.
 *
 * The `position` columns are deliberately not unique, so ties are broken on `id` to
 * make the result a stable sequence rather than whatever order the rows came back in.
 * Without an explicit order PostgREST emits no ORDER BY at all — which would leave the
 * ordering index, and the `position` column itself, as decoration.
 */
export function packTreeQuery(client: PacksheetClient, slug: string) {
  return client
    .from('packs')
    .select(PACK_TREE_SELECT)
    .eq('slug', slug)
    .order('position', { referencedTable: 'pack_categories', ascending: true })
    .order('id', { referencedTable: 'pack_categories', ascending: true })
    .order('position', { referencedTable: 'pack_categories.pack_items', ascending: true })
    .order('id', { referencedTable: 'pack_categories.pack_items', ascending: true });
}
