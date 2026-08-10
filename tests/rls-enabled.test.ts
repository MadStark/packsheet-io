import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { adminSql } from './support/local-database';

/**
 * The sweep: what must be true of EVERY table in `public`, not just today's four.
 *
 * Ref 49's acceptance criterion is precise about this — "assert it with a query
 * against `pg_class.relrowsecurity`, so a new table without policies fails the build
 * rather than shipping". Every assertion here is therefore written against whatever
 * the catalogue currently contains, with no allow-list of table names to update. A
 * migration that adds a table and forgets its policies turns this file red without
 * anyone having remembered to extend it.
 *
 * Running as `postgres` is correct HERE and only here. These are questions about how
 * the tables are configured, which is exactly what a superuser can see and a
 * restricted role cannot. Whether the configuration actually stops a stranger is a
 * different question, asked by rls-anon.test.ts as the `anon` role.
 */

/** Base tables only: views and materialised views have no relrowsecurity to set. */
const publicTables = () =>
  adminSql<{ table_name: string; rls_enabled: boolean }>(
    `select c.relname as table_name, c.relrowsecurity as rls_enabled
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
      order by c.relname`,
  );

describe('row level security is on every table in public', () => {
  // Without this, every assertion below passes vacuously against an empty schema —
  // including on a database where the migrations silently did not run.
  it('finds the core tables, so the sweep is not passing over nothing', async () => {
    const names = (await publicTables()).map((t) => t.table_name);
    expect(names).toEqual(
      expect.arrayContaining(['gear_items', 'pack_categories', 'pack_items', 'packs']),
    );
  });

  it('has RLS enabled on every table', async () => {
    const without = (await publicTables()).filter((t) => !t.rls_enabled).map((t) => t.table_name);
    expect(without).toEqual([]);
  });

  // RLS with no policies denies everything, which is safe but is almost never what
  // the author meant — it is the signature of a table whose policies were left for
  // later. Ref 49 is the ticket that says "later" does not arrive.
  it('has at least one policy on every table', async () => {
    const rows = await adminSql<{ table_name: string }>(
      `select c.relname as table_name
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
    left join pg_policy p on p.polrelid = c.oid
        where n.nspname = 'public' and c.relkind = 'r'
     group by c.relname
       having count(p.oid) = 0`,
    );
    expect(rows.map((r) => r.table_name)).toEqual([]);
  });
});

/**
 * Grants — the half of the boundary that policies cannot express.
 *
 * A default Supabase project hands `anon` TRUNCATE, REFERENCES, TRIGGER and MAINTAIN
 * on tables created by `postgres`, even with the data privileges withheld. TRUNCATE is
 * not filtered by row level security: no policy anywhere can stop it. Before the
 * revoke block in 20260810120000_core_schema.sql, `set role anon; truncate
 * public.packs cascade;` succeeded against this schema.
 *
 * These two tests are what make that a permanent property rather than something that
 * was true once, and they are written over every table for the same reason as above:
 * the default ACL applies to the next table too.
 */
describe('table privileges are the minimum each role needs', () => {
  const grantsFor = (grantee: string) =>
    adminSql<{ table_name: string; privilege_type: string }>(
      `select table_name, privilege_type
         from information_schema.role_table_grants
        where table_schema = 'public' and grantee = $1
        order by table_name, privilege_type`,
      [grantee],
    );

  it('gives anon nothing but SELECT — in particular, never TRUNCATE', async () => {
    const offending = (await grantsFor('anon')).filter((g) => g.privilege_type !== 'SELECT');
    expect(offending).toEqual([]);
  });

  it('gives authenticated no privilege beyond the four DML verbs', async () => {
    const allowed = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE']);
    const offending = (await grantsFor('authenticated')).filter(
      (g) => !allowed.has(g.privilege_type),
    );
    expect(offending).toEqual([]);
  });
});

/**
 * The step that makes all of the above run in CI.
 *
 * Everything in this file is worthless if the job never starts a database: the tests
 * would fail, someone would remove the step or the tests to get a merge through, and
 * the schema would ship unguarded. Pinning it here means deleting the step turns a
 * test red with an explanation attached, rather than turning the whole suite red with
 * a connection error.
 *
 * Asserted against the parsed workflow, in the same spirit as tests/deploy-workers.ts:
 * the ORDER is the property, not the presence of a string somewhere in the file.
 */
describe('CI runs these tests against a real database', () => {
  const ciWorkflow = parse(
    readFileSync(fileURLToPath(new URL('../.github/workflows/ci.yml', import.meta.url)), 'utf8'),
  ) as { jobs: Record<string, { steps?: { name?: string; run?: string; uses?: string }[] }> };

  // By name. `check` is the required status check on main and staging, so a database
  // started in some other job would not gate anything.
  const steps = ciWorkflow.jobs?.check?.steps ?? [];

  it('starts the database before running the tests, in the check job', () => {
    const start = steps.findIndex((s) => /supabase\s+start/.test(s.run ?? ''));
    const test = steps.findIndex((s) => /^npm test\b/.test((s.run ?? '').trim()));

    expect(start, 'no `supabase start` step in the check job').toBeGreaterThanOrEqual(0);
    expect(test, 'no `npm test` step in the check job').toBeGreaterThanOrEqual(0);
    expect(test).toBeGreaterThan(start);
  });

  it('installs the same CLI version the deploy workflows use', () => {
    const setup = steps.find((s) => s.uses?.startsWith('supabase/setup-cli'));
    expect(setup).toBeDefined();

    const deployVersions = ['deploy-staging.yml', 'deploy-production.yml'].map((file) => {
      const workflow = parse(
        readFileSync(
          fileURLToPath(new URL(`../.github/workflows/${file}`, import.meta.url)),
          'utf8',
        ),
      ) as { jobs: Record<string, { steps?: { uses?: string; with?: { version?: string } }[] }> };
      return Object.values(workflow.jobs)
        .flatMap((job) => job.steps ?? [])
        .find((s) => s.uses?.startsWith('supabase/setup-cli'))?.with?.version;
    });

    for (const version of deployVersions) {
      expect(version).toBeDefined();
      expect((setup as { with?: { version?: string } }).with?.version).toBe(version);
    }
  });
});

/**
 * SECURITY DEFINER functions are the standard way around RLS, and a legitimate one —
 * but a definer function with a mutable search_path lets its caller choose what its
 * unqualified names resolve to, while it runs as its owner. Supabase's own linter
 * flags it as `function_search_path_mutable`.
 *
 * There are no definer functions in this schema today. The assertion exists so that
 * the first one to arrive has to be deliberate about it.
 */
describe('security definer functions pin their search_path', () => {
  it('has no SECURITY DEFINER function in public without a set search_path', async () => {
    const rows = await adminSql<{ function_name: string }>(
      `select p.proname as function_name
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.prosecdef
          and not exists (
                select 1 from unnest(coalesce(p.proconfig, '{}')) as config
                 where config like 'search_path=%'
              )`,
    );
    expect(rows.map((r) => r.function_name)).toEqual([]);
  });
});
