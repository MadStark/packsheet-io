import { localDatabase, adminSql } from './local-database';

/**
 * Refuse to start until the database is actually ready.
 *
 * This exists because of a specific, observed failure, and the shape of it matters:
 * running `npm test` immediately after a completed `supabase db reset` produced
 *
 *     rls-enabled  > has RLS enabled on every table
 *                    expected [ 'pack_categories' ] to deeply equal []
 *     rls-owner    > returns zero rows for its categories, items and gear
 *                    expected [ Array(1) ] to deeply equal []     <- one user read another's rows
 *
 * and seconds later the same queries by hand returned a perfectly configured schema.
 * `supabase db reset` prints `Finished` while its container restart is still settling,
 * and nothing here waited for the schema it was about to interrogate.
 *
 * A flaky test is bad. A flaky test that reports *a stranger can read a private pack*
 * is worse than bad: it is the one result in this suite nobody should ever learn to
 * re-run. Whatever else these tests say, they must only say that when it is true.
 *
 * So the gate is deliberately narrow — it asserts the preconditions every file assumes
 * and nothing about the policies themselves. If those preconditions do not arrive, this
 * fails once, here, with the command to fix it, rather than as a scattering of
 * authorization failures across four files.
 */

const CORE_TABLES = ['gear_items', 'pack_categories', 'pack_items', 'packs'] as const;

const READY_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 250;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The four tables exist AND have RLS on — the state every file in this suite assumes. */
async function schemaReady(): Promise<string | null> {
  const rows = await adminSql<{ table_name: string; rls_enabled: boolean }>(
    `select c.relname as table_name, c.relrowsecurity as rls_enabled
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p') and c.relname = any($1)`,
    [[...CORE_TABLES]],
  );

  const found = new Set(rows.map((r) => r.table_name));
  const missing = CORE_TABLES.filter((t) => !found.has(t));
  if (missing.length > 0) return `tables not created yet: ${missing.join(', ')}`;

  const unprotected = rows.filter((r) => !r.rls_enabled).map((r) => r.table_name);
  if (unprotected.length > 0) return `RLS not enabled yet on: ${unprotected.join(', ')}`;

  return null;
}

/**
 * PostgREST answering, not merely the database.
 *
 * `supabase start` exits 0 with the API tier down, so a green start step is not
 * evidence that the surface these tests exercise as `anon` exists.
 */
async function apiReady(): Promise<string | null> {
  const { apiUrl, anonKey } = localDatabase();
  try {
    const response = await fetch(`${apiUrl}/rest/v1/`, { headers: { apikey: anonKey } });
    return response.ok ? null : `PostgREST answered ${response.status}`;
  } catch (error) {
    return `PostgREST unreachable: ${(error as Error).message}`;
  }
}

export default async function setup(): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let reason: string;

  for (;;) {
    reason = (await apiReady()) ?? (await schemaReady()) ?? '';
    if (reason === '') return;
    if (Date.now() > deadline) break;
    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(
    `The local Supabase stack did not become ready within ${READY_TIMEOUT_MS / 1000}s: ${reason}. ` +
      'Start it with `npm run db:start`, then `npm run db:reset` to replay the migrations.',
  );
}
