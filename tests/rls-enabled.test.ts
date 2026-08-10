import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
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
 *
 * ---------------------------------------------------------------------------
 * THE RECURRING BUG IN A FILE LIKE THIS
 * ---------------------------------------------------------------------------
 *
 * Every sweep below is of the form `expect(offenders).toEqual([])`, which means an
 * empty input set passes it. A query that returns nothing — wrong role name, wrong
 * schema, a `relkind` that stopped matching — reports the same green as a schema that
 * is genuinely correct. So each sweep is paired with a guard that its input was not
 * empty. That pairing is the point of the file; without it these are assertions that
 * cannot fail.
 */

const CORE_TABLES = ['gear_items', 'pack_categories', 'pack_items', 'packs'] as const;

/**
 * `relkind in ('r', 'p')` — ordinary AND partitioned tables.
 *
 * `'r'` alone was a real hole, not a hypothetical one: a partitioned table is `'p'`,
 * carries its own RLS setting, and is exposed through PostgREST exactly like any other.
 * A `public.part_table` with RLS off, no policies and `grant select to anon` passed
 * every test in this file while `'r'` was the only filter.
 */
const publicTables = () =>
  adminSql<{ table_name: string; rls_enabled: boolean }>(
    `select c.relname as table_name, c.relrowsecurity as rls_enabled
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p')
      order by c.relname`,
  );

describe('row level security is on every table in public', () => {
  // Without this, every assertion below passes vacuously against an empty schema —
  // including on a database where the migrations silently did not run.
  it('finds the core tables, so the sweep is not passing over nothing', async () => {
    const names = (await publicTables()).map((t) => t.table_name);
    expect(names).toEqual(expect.arrayContaining([...CORE_TABLES]));
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
        where n.nspname = 'public' and c.relkind in ('r', 'p')
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
 * Written over every table for the same reason as above: the default ACL applies to
 * the next table too.
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

  // The guard the sweeps below need. If `anon` were ever renamed — Supabase is actively
  // migrating towards publishable/secret key naming — `grantsFor('anon')` would return
  // nothing and every filter over it would pass having checked no privilege at all.
  it('finds grants for each role, so the sweeps are not passing over nothing', async () => {
    for (const role of ['anon', 'authenticated', 'service_role']) {
      const grants = await grantsFor(role);
      expect(grants.length, `no grants found at all for ${role}`).toBeGreaterThan(0);
    }
  });

  it('gives anon nothing but SELECT — in particular, never TRUNCATE', async () => {
    const offending = (await grantsFor('anon')).filter((g) => g.privilege_type !== 'SELECT');
    expect(offending).toEqual([]);
  });

  // The mirror image, and not redundant: everything above is satisfied by a schema that
  // granted `anon` nothing at all, which would break every share page while reporting
  // a clean bill of health.
  it('still gives anon the SELECT the share page needs, on each core table', async () => {
    const selectable = new Set(
      (await grantsFor('anon'))
        .filter((g) => g.privilege_type === 'SELECT')
        .map((g) => g.table_name),
    );
    for (const table of CORE_TABLES)
      expect(selectable.has(table), `anon cannot SELECT ${table}`).toBe(true);
  });

  it('gives authenticated no privilege beyond the four DML verbs', async () => {
    const allowed = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE']);
    const offending = (await grantsFor('authenticated')).filter(
      (g) => !allowed.has(g.privilege_type),
    );
    expect(offending).toEqual([]);
  });

  // service_role bypasses RLS by role attribute, so its table privileges are the only
  // thing bounding it. The migration deliberately grants it four verbs and not ALL;
  // nothing checked that until this test.
  it('gives service_role no privilege beyond the four DML verbs', async () => {
    const allowed = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE']);
    const offending = (await grantsFor('service_role')).filter(
      (g) => !allowed.has(g.privilege_type),
    );
    expect(offending).toEqual([]);
  });

  /**
   * MAINTAIN needs `has_table_privilege`, not `information_schema`.
   *
   * MAINTAIN (Postgres 17: VACUUM, ANALYZE, REINDEX, CLUSTER, REFRESH MATERIALIZED
   * VIEW) is not in the SQL standard, so `role_table_grants` does not report it — the
   * sweep above cannot see it at all. Granting all four of the default ACL's privileges
   * to `anon` and querying both, `information_schema` returns REFERENCES/TRIGGER/
   * TRUNCATE while `has_table_privilege(..., 'MAINTAIN')` returns true.
   *
   * In practice the default ACL grants the four together, so a forgotten revoke still
   * trips the TRUNCATE assertion — but a MAINTAIN-only grant would pass it silently,
   * and MAINTAIN on an anonymous role is a denial-of-service surface with no
   * legitimate use.
   */
  it('never leaves MAINTAIN with anon or authenticated', async () => {
    const rows = await adminSql<{ table_name: string; grantee: string }>(
      `select c.relname as table_name, r.rolname as grantee
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        cross join (select unnest(array['anon', 'authenticated']) as rolname) r
        where n.nspname = 'public' and c.relkind in ('r', 'p')
          and has_table_privilege(r.rolname, c.oid, 'MAINTAIN')`,
    );
    expect(rows).toEqual([]);
  });
});

/**
 * Functions are a privilege surface too, and one that is granted by default.
 *
 * A function is created with EXECUTE to PUBLIC, and `public` is an exposed PostgREST
 * schema, so a helper defined there is an anonymous RPC endpoint from the moment it
 * exists. Verified against this schema before the revoke landed:
 *
 *     POST /rest/v1/rpc/gear_item_snapshot   (apikey: anon)   ->   200
 *
 * The sweep matters more than that one function did. The standard remedy for policy
 * recursion in Supabase is a SECURITY DEFINER helper, and one written in `public` out
 * of habit would land on the anonymous surface running as its owner.
 */
describe('no function in public is callable by anon', () => {
  const publicFunctions = () =>
    adminSql<{ function_name: string; anon_can_execute: boolean }>(
      `select p.proname as function_name,
              has_function_privilege('anon', p.oid, 'execute') as anon_can_execute
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'`,
    );

  it('finds functions in public, so the sweep is not passing over nothing', async () => {
    expect((await publicFunctions()).length).toBeGreaterThan(0);
  });

  it('grants EXECUTE to anon on none of them', async () => {
    const callable = (await publicFunctions())
      .filter((f) => f.anon_can_execute)
      .map((f) => f.function_name);
    expect(callable).toEqual([]);
  });
});

/**
 * The step that makes all of the above run in CI — in EVERY workflow that runs the suite.
 *
 * The first version of this guard checked ci.yml and only ci.yml, and that is precisely
 * how the gap it was meant to prevent got shipped: the other workflows that run
 * `npm test` — at the time pr-preview.yml and both deploys — started no database. The
 * suite refuses to skip its row-level-security tests without one, so all three went red.
 *
 * The deploy workflows are the serious half. They run `npm test` BEFORE pushing
 * migrations and before building, so the effect was not a broken site but a frozen
 * pipeline: no release could ship at all.
 *
 * So the assertion is written over whatever workflows exist, keyed on the thing that
 * actually creates the requirement — a step that runs `npm test` — rather than on a
 * list of filenames somebody has to remember to extend.
 */
describe('every workflow that runs the suite starts a database first', () => {
  interface Step {
    name?: string;
    run?: string;
    uses?: string;
    if?: string;
    'continue-on-error'?: boolean;
    with?: { version?: string };
  }
  interface Workflow {
    jobs: Record<string, { steps?: Step[] }>;
  }

  const workflowsDir = fileURLToPath(new URL('../.github/workflows', import.meta.url));
  const files = readdirSync(workflowsDir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));

  const parsed = files.map((file) => ({
    file,
    workflow: parse(readFileSync(`${workflowsDir}/${file}`, 'utf8')) as Workflow,
  }));

  const isTest = (s: Step) => (s.run ?? '').trim() === 'npm test';
  const isDatabase = (s: Step) => (s.uses ?? '') === './.github/actions/local-database';

  /** Every (workflow, job) pair that runs the suite. */
  const suiteJobs = parsed.flatMap(({ file, workflow }) =>
    Object.entries(workflow.jobs ?? {})
      .filter(([, job]) => (job.steps ?? []).some(isTest))
      .map(([jobName, job]) => ({ file, jobName, steps: job.steps ?? [] })),
  );

  // Without this the whole describe passes over an empty list — the same vacuum the
  // catalogue sweeps above are guarded against.
  it('finds the jobs that run npm test', () => {
    expect(files.length, 'no workflow files found').toBeGreaterThan(0);
    expect(suiteJobs.length, 'no job runs `npm test`').toBeGreaterThan(0);
  });

  it.each(suiteJobs.map((j) => [`${j.file}:${j.jobName}`, j] as const))(
    '%s starts the database before running the tests',
    (_label, job) => {
      const database = job.steps.findIndex(isDatabase);
      const test = job.steps.findIndex(isTest);

      expect(database, 'no local-database step in this job').toBeGreaterThanOrEqual(0);
      expect(test).toBeGreaterThan(database);
    },
  );

  // Order is not enough. `continue-on-error: true` on either step leaves the sequence
  // intact and the guardrail reporting without blocking — the exact failure this file
  // exists to prevent, one line away from a green review.
  it.each(suiteJobs.map((j) => [`${j.file}:${j.jobName}`, j] as const))(
    '%s lets neither step be skipped or excused from failing',
    (_label, job) => {
      for (const step of job.steps.filter((s) => isDatabase(s) || isTest(s))) {
        expect(step['continue-on-error']).toBeUndefined();
        expect(step.if).toBeUndefined();
      }
    },
  );

  // One CLI version across every workflow that installs it, including the two that
  // `db push` to a hosted project: the migrations replayed locally and the migrations
  // pushed to production must be applied by the same tool.
  it('pins one CLI version everywhere it is installed', () => {
    const versions = parsed.flatMap(({ file, workflow }) =>
      Object.values(workflow.jobs ?? {})
        .flatMap((job) => job.steps ?? [])
        .filter((s) => (s.uses ?? '').startsWith('supabase/setup-cli'))
        .map((s) => ({ file, version: s.with?.version })),
    );

    expect(versions.length, 'no workflow installs the Supabase CLI').toBeGreaterThan(0);
    for (const { file, version } of versions) {
      expect(version, `${file} does not pin a CLI version`).toBeDefined();
      expect(version, `${file} pins a different CLI version`).toBe(versions[0].version);
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
 * the first one to arrive has to be deliberate about it. `private` is swept as well as
 * `public`: it is the schema the migration directs definer helpers towards, so leaving
 * it out would aim people at the one place nothing was checking.
 */
describe('security definer functions pin their search_path', () => {
  it('has no SECURITY DEFINER function without a set search_path', async () => {
    const rows = await adminSql<{ function_name: string }>(
      `select p.proname as function_name
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('public', 'private')
          and p.prosecdef
          and not exists (
                select 1 from unnest(coalesce(p.proconfig, '{}')) as config
                 where config like 'search_path=%'
              )`,
    );
    expect(rows.map((r) => r.function_name)).toEqual([]);
  });
});
