import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { adminSql, inRolledBackTransaction } from './support/local-database';

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
 * The sweep above is correct and, until PK-57, could not see the environment it guards.
 *
 * `public.delete_own_account()` shipped to `packsheet-staging` EXECUTE-able by `anon`
 * while the assertion directly above this comment stayed green — because it runs against
 * the LOCAL stack, and the two databases did not agree about what a newly created
 * function is granted to. Measured on the same day, on the same migration:
 *
 *     local     delete_own_account  {postgres=X/postgres,authenticated=X/postgres}
 *     staging   delete_own_account  {postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}
 *
 * The difference is `pg_default_acl`. A hosted Supabase project ships with
 *
 *     alter default privileges in schema public
 *       grant execute on functions to anon, authenticated, service_role;
 *
 * so a function is created there with `anon=X` attached as a NAMED grant, on top of the
 * PUBLIC grant every `create function` carries. The migration's `revoke all on function
 * ... from public` removed one of those two and read as though it had removed both. The
 * local stack's own defaults are narrower — no named grant on functions at all — so
 * locally the same revoke really was sufficient, and the test really did pass.
 *
 * `20260811120000_public_grant_hardening.sql` removes those default privileges, which is
 * what lets the sweep above mean the same thing in both places. Everything below exists
 * to keep that true: an assertion on the defaults themselves, and — because reading
 * `pg_default_acl` and predicting Postgres's resolution from it is exactly the kind of
 * reasoning that produced this bug — a probe that creates a real object and measures it.
 *
 * These run against whatever database the suite is pointed at. Against staging as it
 * stood when PK-57 was written, the probe fails.
 */
describe('nothing created in public is granted to a Data API role by default', () => {
  /** The three roles PostgREST can authenticate a request as. */
  const DATA_API_ROLES = ['anon', 'authenticated', 'service_role'] as const;

  /**
   * `postgres` is the role migrations are applied as — `supabase db push` connects as it,
   * and every object in `public` on both hosted projects is owned by it — so its entry is
   * the one that decides what this project's own migrations create.
   *
   * The `supabase_admin` entry is deliberately out of scope. It is not ours to alter
   * (`postgres` is not a member of it on a hosted project) and it governs only objects
   * created BY `supabase_admin`, which nothing in this repository does. If the platform
   * ever creates one in `public` anyway, the catalogue sweeps above are what see it —
   * they ask about objects that exist, not about defaults.
   */
  const MIGRATION_ROLE = 'postgres';

  const defaultPrivileges = () =>
    adminSql<{ grantor: string; object_type: string; acl: string }>(
      `select pg_get_userbyid(d.defaclrole) as grantor,
              d.defaclobjtype::text as object_type,
              d.defaclacl::text as acl
         from pg_default_acl d
         join pg_namespace n on n.oid = d.defaclnamespace
        where n.nspname = 'public'`,
    );

  // The guard this file demands of every sweep. An empty result would pass the assertion
  // below having inspected nothing — and here that is a reachable state rather than a
  // theoretical one: it is what the schema looks like if the hardening migration's
  // `alter default privileges` statements never ran.
  it('finds default privilege entries for public, so the sweep is not passing over nothing', async () => {
    const ours = (await defaultPrivileges()).filter((e) => e.grantor === MIGRATION_ROLE);
    expect(
      ours.length,
      `no pg_default_acl entry in public for ${MIGRATION_ROLE} — did the hardening migration run?`,
    ).toBeGreaterThan(0);
  });

  it('leaves no standing grant to anon, authenticated or service_role', async () => {
    const offending = (await defaultPrivileges())
      .filter((e) => e.grantor === MIGRATION_ROLE)
      .filter((e) => DATA_API_ROLES.some((role) => e.acl.includes(`${role}=`)));
    expect(offending).toEqual([]);
  });

  /**
   * The probe, and the assertion PK-57 actually turns on.
   *
   * Two measurements of one function, in a transaction that is thrown away:
   *
   *   1. Before any revoke, `anon` CAN execute it. That is the guard — not a nicety. If a
   *      fresh function in `public` were unreachable by anon to begin with, this probe
   *      could never fail and the assertion below would prove nothing. It is also the
   *      property that makes a FORGOTTEN revoke loud: the sweep at the top of this
   *      section catches it on the next CI run rather than after a deploy. That reach is
   *      the built-in PUBLIC grant, which the hardening migration deliberately leaves
   *      alone for exactly this reason.
   *
   *   2. After `revoke all ... from public` — the idiom every migration in this
   *      repository uses — `anon` CANNOT. This is the half that was false on staging,
   *      where a named `anon=X` survived the revoke and no local test could see it.
   */
  it('leaves a function in public reachable only through PUBLIC, so revoking PUBLIC is enough', async () => {
    await inRolledBackTransaction(async (sql) => {
      await sql(
        `create function public.__anon_grant_probe() returns int language sql as 'select 1'`,
      );

      const measure = () =>
        sql<{ acl: string | null; anon_can_execute: boolean }>(
          `select p.proacl::text as acl,
                  has_function_privilege('anon', p.oid, 'EXECUTE') as anon_can_execute
             from pg_proc p
             join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = '__anon_grant_probe'`,
        );

      const [born] = await measure();
      expect(
        born?.anon_can_execute,
        'a function created in public was not anon-executable even before any revoke, so this probe cannot fail and proves nothing',
      ).toBe(true);

      await sql('revoke all on function public.__anon_grant_probe() from public');

      const [revoked] = await measure();
      expect(
        revoked?.anon_can_execute,
        `revoking PUBLIC left anon holding EXECUTE by name — acl ${revoked?.acl}. This is the hosted default privileges being back; see 20260811120000_public_grant_hardening.sql.`,
      ).toBe(false);
    });
  });

  /**
   * The same question about tables, which is where it bites harder.
   *
   * A hosted project's default privileges hand `anon` `arwdDxtm` on a new table in
   * `public` — TRUNCATE included, which row level security cannot refuse. That is why the
   * core-schema migration has to open its grants block with four `revoke all on
   * public.<table> from anon, authenticated, service_role` lines, and why a fifth table
   * added without a fifth revoke would be a hole no policy could close.
   *
   * The local stack was never identical here either: its defaults granted `anon` `Dxtm`
   * — no read or write, but TRUNCATE and MAINTAIN, both of which the grants sweep above
   * treats as unacceptable on an existing table and neither of which anything checked on
   * a future one.
   */
  it('leaves a table created in public with nothing at all for anon', async () => {
    await inRolledBackTransaction(async (sql) => {
      await sql('create table public.__anon_grant_probe (id int)');

      const [row] = await sql<{ acl: string | null; privileges: string[] }>(
        `select c.relacl::text as acl,
                array(
                  select privilege
                    from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) as privilege
                   where has_table_privilege('anon', c.oid, privilege)
                ) as privileges
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relname = '__anon_grant_probe'`,
      );

      expect(row?.privileges, `a new table in public arrives with acl ${row?.acl}`).toEqual([]);
    });
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
    env?: Record<string, string>;
  }
  interface Workflow {
    env?: Record<string, string>;
    jobs: Record<string, { steps?: Step[]; env?: Record<string, string> }>;
  }

  const workflowsDir = fileURLToPath(new URL('../.github/workflows', import.meta.url));
  const files = readdirSync(workflowsDir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));

  const parsed = files.map((file) => ({
    file,
    workflow: parse(readFileSync(`${workflowsDir}/${file}`, 'utf8')) as Workflow,
  }));

  const isTest = (s: Step) => (s.run ?? '').trim() === 'npm test';
  const isDatabase = (s: Step) => (s.uses ?? '') === './.github/actions/local-database';

  /** Every (workflow, job) pair that runs the suite, with the two env scopes that reach
   *  a step from ABOVE it — the workflow's and the job's. A step's own `env:` is read
   *  off the step itself where it is needed; these two are the ones that apply to every
   *  step in the job whether it asked for them or not, which is the whole distinction
   *  the environment assertions below turn on. */
  const suiteJobs = parsed.flatMap(({ file, workflow }) =>
    Object.entries(workflow.jobs ?? {})
      .filter(([, job]) => (job.steps ?? []).some(isTest))
      .map(([jobName, job]) => ({
        file,
        jobName,
        steps: job.steps ?? [],
        inheritedEnv: { ...(workflow.env ?? {}), ...(job.env ?? {}) },
      })),
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

  /**
   * WHERE THE SUITE IS POINTED, which is a sharper question than whether it has a
   * database at all.
   *
   * `npm test` creates users, signs them in and DELETES ACCOUNTS — tests/auth-flow.test.ts
   * ends by calling `deleteOwnAccount()` for real. Against the local stack that is a
   * container that gets thrown away. Against a hosted project it is somebody's data.
   *
   * Two of the three workflows that run this suite are deploys, and both of them legitimately
   * hold hosted `PUBLIC_SUPABASE_URL` / `PUBLIC_SUPABASE_ANON_KEY` secrets, because Vite
   * inlines those into the artifact at build time. So the hosted values and the destructive
   * suite live in the same job, a few lines apart, and the only thing separating them is
   * WHERE the secrets are set: on the Build step's own `env:`, which no other step can see.
   *
   * Moving that pair up one level — to the job, or to the workflow — is a plausible-looking
   * tidy-up (it removes a duplicated block between the two deploy files) and it would point
   * the account-deleting tests at production. Nothing else in this repository would notice.
   * So it is asserted here, keyed on `npm test` rather than on a filename, for the same
   * reason the database assertion above is: a fourth workflow must inherit the rule rather
   * than have to remember it.
   *
   * The rule is deliberately about the ENVIRONMENT rather than about the word "secrets".
   * A literal hosted URL typed into a job-level `env:` is exactly as dangerous as a secret
   * reference, and reads as more innocent.
   */
  const SUPABASE_TARGET_VARS = ['PUBLIC_SUPABASE_URL', 'PUBLIC_SUPABASE_ANON_KEY'];

  it.each(suiteJobs.map((j) => [`${j.file}:${j.jobName}`, j] as const))(
    '%s sets no Supabase target above step level, so npm test cannot see a hosted project',
    (_label, job) => {
      expect(Object.keys(job.inheritedEnv).filter((n) => SUPABASE_TARGET_VARS.includes(n))).toEqual(
        [],
      );
    },
  );

  it.each(suiteJobs.map((j) => [`${j.file}:${j.jobName}`, j] as const))(
    '%s gives the npm test step itself no Supabase target of its own',
    (_label, job) => {
      for (const step of job.steps.filter(isTest)) {
        expect(Object.keys(step.env ?? {}).filter((n) => SUPABASE_TARGET_VARS.includes(n))).toEqual(
          [],
        );
      }
    },
  );

  /**
   * The other half, and the reason the two assertions above are safe to make rather than
   * merely strict: with nothing setting those variables anywhere a test step can see, the
   * suite would have none at all — which is how PK-19's CI actually failed, with
   * `PUBLIC_SUPABASE_URL is not set` and a summary line reading "skipped".
   *
   * The local-database action is what supplies them, writing this job's own stack into
   * `$GITHUB_ENV`. That is asserted from the action's source rather than assumed, because
   * "no workflow points the tests at a hosted project" and "the tests are pointed at
   * nothing" are the same green here otherwise.
   */
  it('the local-database action is what supplies them, from the stack it just started', () => {
    const action = readFileSync(
      fileURLToPath(new URL('../.github/actions/local-database/action.yml', import.meta.url)),
      'utf8',
    );

    for (const name of SUPABASE_TARGET_VARS) {
      expect(action, `${name} is never written to $GITHUB_ENV`).toMatch(
        new RegExp(`echo "${name}=\\$[A-Z_]+" >> "\\$GITHUB_ENV"`),
      );
    }
    // From the running stack, not from a secret or a literal. `supabase status -o env`
    // is the only thing that knows this job's own ports. Anchored on the expression
    // syntax rather than on the word, so a comment that merely discusses secrets — this
    // action's does, at length — is not mistaken for one that interpolates one.
    expect(action).toContain('scripts/supabase.sh status -o env');
    expect(action).not.toMatch(/\$\{\{\s*secrets\./);

    // And nothing privileged goes with them. The CLI prints SERVICE_ROLE_KEY and
    // SECRET_KEY in the same block, and this action is a step whose exports reach the
    // build.
    expect(action).not.toMatch(/SERVICE_ROLE_KEY=|SECRET_KEY=/);
  });

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
 * This was written when the schema had no definer functions at all, so that the first one
 * to arrive would have to be deliberate about it. PK-19 is that arrival:
 * `public.delete_own_account()` is SECURITY DEFINER — it has to be, because
 * `authenticated` holds no DELETE privilege on `auth.users` and no policy on our own
 * tables can express deleting the identity that owns them — and it pins `search_path = ''`
 * with every name qualified. This assertion is what makes that a checked fact rather than
 * a habit. `private` is swept as well as `public`: it is the schema the migration directs
 * definer HELPERS towards (the RPC itself must live in `public` to be reachable through
 * PostgREST at all), so leaving it out would aim people at the one place nothing was
 * checking.
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
