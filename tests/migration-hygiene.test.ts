import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Migrations must not rely on the search_path to find an extension's type.
 *
 * This exists because of a failure that every local check passed and the deploy caught,
 * which is the worst place to find it — after the merge button.
 *
 * The baseline migration installs `citext` into `extensions` rather than `public`, on
 * purpose: `public` is served by PostgREST, so an extension there puts its functions on
 * the anonymous API surface. `extra_search_path` in supabase/config.toml then adds
 * `extensions` to the search_path of every API REQUEST — and that is the trap, because a
 * migration is not an API request. `supabase db reset` locally runs as a role whose
 * search_path happens to include `extensions`; `supabase db push` connects to a hosted
 * project with its own role and its own search_path, which does not. So:
 *
 *     slug citext              -- fine locally, `type "citext" does not exist` on deploy
 *     slug extensions.citext   -- correct everywhere
 *
 * Reproduce the hosted behaviour locally with `set search_path = 'public'` before the
 * statement.
 *
 * This check is NAME-BOUND, in the same way the privileged-key scan in
 * anonymous-read-path.test.ts is: it knows the extension types this project installs and
 * no others. Whoever adds an extension must add its types here, or the rule is
 * permanently green while the next migration breaks the deploy.
 */

const MIGRATIONS_DIR = fileURLToPath(new URL('../supabase/migrations', import.meta.url));

/** Types provided by an extension living outside `public`. */
const EXTENSION_TYPES = ['citext'] as const;

/** Comments legitimately name these types in prose; only executable SQL is in scope. */
const stripComments = (sql: string): string =>
  sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');

describe('migrations schema-qualify extension types', () => {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));

  it('finds migration files, so this is not passing over nothing', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s has no unqualified extension type', (file) => {
    const sql = stripComments(readFileSync(`${MIGRATIONS_DIR}/${file}`, 'utf8'));

    const offenders: string[] = [];
    for (const type of EXTENSION_TYPES) {
      // Every occurrence of the bare name that is not already schema-qualified and is
      // not the `create extension` statement that installs it.
      const pattern = new RegExp(`(\\w+\\.)?\\b${type}\\b`, 'g');
      for (const match of sql.matchAll(pattern)) {
        if (match[1]) continue; // already qualified
        const before = sql.slice(Math.max(0, match.index - 60), match.index);
        if (/create\s+extension\s+(if\s+not\s+exists\s+)?$/i.test(before)) continue;
        offenders.push(`${type} at offset ${match.index}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});

/**
 * A function in `public` must have its EXECUTE revoked from `anon` BY NAME.
 *
 * PK-57, and the same shape as the citext rule above: true locally, false against a
 * hosted project, and the local run is the one wired into CI. `20260811000000_account_
 * deletion.sql` ends with what looks like the complete pair —
 *
 *     revoke all on function public.delete_own_account() from public;
 *     grant execute on function public.delete_own_account() to authenticated;
 *
 * — and shipped a function `anon` could call on `packsheet-staging`. `revoke ... from
 * public` removes the grant held by the `PUBLIC` pseudo-role, which is the only one a
 * function is born with locally. A hosted project also attaches `anon`, `authenticated`
 * and `service_role` as named grants, from an `alter default privileges in schema public
 * grant execute on functions to anon, authenticated, service_role` — which both of this
 * project's Supabase projects carry. Newly created cloud projects do not (see the note
 * on the cloud default at `supabase/config.toml`); ours predate that change, and a
 * migration has to be correct on the projects that exist. The revoke removed one grant
 * of two.
 *
 * `20260811120000_public_grant_hardening.sql` takes those default privileges away, so
 * new functions arrive the same in both places. This check is the belt to that braces,
 * and it is the one that needs no database: it reads the migrations as text and would
 * have failed on the migration that caused this, on a laptop, before the deploy. It is
 * also the only new check that would have done so — the catalogue probes in
 * rls-enabled.test.ts fail against a hosted project in that state but are green on the
 * local stack, which is the only database CI has.
 *
 * The rule is over the migration SEQUENCE, not over each file alone. A function created
 * in one migration may legitimately be revoked by a later one: `public.set_updated_at()`
 * is created by the baseline with no revoke block at all, and covered by the sweep at
 * the end of `20260810120000_core_schema.sql` — which is also why it still holds
 * `anon=X` on production, where only the baseline has been applied so far. What is not
 * allowed is a function that no migration, then or afterwards, ever takes away from
 * `anon`.
 *
 * ORDER MATTERS WITHIN A FILE, and getting that wrong here would reproduce PK-57 exactly.
 * A whole-schema sweep only reaches functions that already exist when it runs, which is
 * the entire reason core-schema's sweep did not cover `delete_own_account()`. So a sweep
 * counts for a function in the SAME file only when it appears after the `create`; from a
 * later file it counts unconditionally.
 *
 * Only `public` is in scope. PostgREST routes to `public` and `graphql_public` alone, so
 * a helper in `private` is not on the anonymous surface and is governed by the schema's
 * own `revoke all on schema private from public` instead. An UNQUALIFIED `create
 * function` is in scope too, and is treated as an error in its own right: it resolves
 * through the search_path, which puts it in `public` on both the local stack and a hosted
 * project, while being invisible to a rule that only matches a written `public.` prefix.
 */
describe('migrations revoke function EXECUTE from anon by name', () => {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    // Explicitly, because readdirSync does not promise order and the rule below is
    // "this migration or a later one" — which is meaningless if the order is the
    // filesystem's rather than the one the CLI applies them in.
    .sort();

  const sqlFor = new Map(
    files.map((file) => [file, stripComments(readFileSync(`${MIGRATIONS_DIR}/${file}`, 'utf8'))]),
  );

  /**
   * `create [or replace] function [<schema>.]<name>(`, with either part optionally
   * double-quoted. The schema group is captured so an unqualified or wrongly-quoted
   * creation is SEEN rather than skipped — a rule that silently matches nothing is the
   * failure mode this whole file is written against.
   */
  const CREATE_FUNCTION =
    /create\s+(?:or\s+replace\s+)?function\s+(?:"?([a-z0-9_]+)"?\s*\.\s*)?"?([a-z0-9_]+)"?\s*\(/gi;

  const creations = files.flatMap((file) =>
    [...sqlFor.get(file)!.matchAll(CREATE_FUNCTION)].map((match) => ({
      file,
      schema: match[1]?.toLowerCase(),
      name: match[2].toLowerCase(),
      index: match.index ?? 0,
    })),
  );

  /** In `public` explicitly, or in `public` by default because nothing was written. */
  const inPublic = creations.filter((c) => c.schema === undefined || c.schema === 'public');

  /** The grantee list of a revoke, as written — `from public, anon, authenticated`. */
  const namesAnon = (granteeList: string) => /\banon\b/i.test(granteeList);

  /**
   * `revoke execute on all functions in schema public from ... anon ...`, with the offset
   * it appears at — because a sweep only reaches functions that already exist when it
   * runs, so its position relative to a `create` in the same file decides whether it
   * covers it.
   */
  const wholeSchemaSweeps = (sql: string) =>
    [
      ...sql.matchAll(
        /revoke\s+(?:execute|all(?:\s+privileges)?)\s+on\s+all\s+functions\s+in\s+schema\s+public\s+from\s+([^;]*)/gi,
      ),
    ]
      .filter((match) => namesAnon(match[1]))
      .map((match) => match.index ?? 0);

  /**
   * `revoke execute on function public.<name>(...) from ... anon ...`
   *
   * The signature is matched non-greedily up to the `)` that precedes `from`, rather than
   * with `\([^)]*\)`, so a parameterised type closes correctly: `public.priced(numeric(10,2))`
   * has an inner `)` that the simpler pattern stops at, which would fail correct code.
   */
  const revokesByName = (sql: string, name: string) =>
    [
      ...sql.matchAll(
        new RegExp(
          `revoke\\s+(?:execute|all(?:\\s+privileges)?)\\s+on\\s+function\\s+(?:"?public"?\\s*\\.\\s*)?"?${name}"?\\s*\\([\\s\\S]*?\\)\\s*from\\s+([^;]*)`,
          'gi',
        ),
      ),
    ].some((match) => namesAnon(match[1]));

  it('finds functions created in public, so this is not passing over nothing', () => {
    expect(inPublic.length).toBeGreaterThan(0);
  });

  /**
   * Per FILE, not per corpus. The guard above proves some migration was parsed; it stays
   * green off the other files if one migration's `create function` stops matching, which
   * is exactly the silent skip this rule cannot afford. `create` is searched for in the
   * raw text so that a file the regex failed on is still known to contain one.
   */
  it.each(files)('%s: every function it creates was parsed', (file) => {
    const sql = sqlFor.get(file)!;
    const mentions = /create\s+(?:or\s+replace\s+)?function\b/gi.test(sql);
    if (!mentions) return;
    expect(
      creations.filter((c) => c.file === file).length,
      `${file} contains a \`create function\` this rule could not parse, so it is being skipped silently`,
    ).toBeGreaterThan(0);
  });

  it.each(creations.map((entry) => [`${entry.file} → ${entry.name}`, entry] as const))(
    '%s names the schema it is created in',
    (_label, { schema, name }) => {
      expect(
        schema,
        `\`create function ${name}(\` has no schema, so it resolves through the search_path — which lands it in \`public\`, on the Data API surface, while reading as though it were private.`,
      ).toBeDefined();
    },
  );

  it.each(inPublic.map((entry) => [`${entry.file} → public.${entry.name}`, entry] as const))(
    '%s is revoked from anon by name, here or in a later migration',
    (_label, { file, name, index }) => {
      const from = files.indexOf(file);

      const covered = files.slice(from).filter((later, offset) => {
        const sql = sqlFor.get(later)!;
        if (revokesByName(sql, name)) return true;
        // A sweep in a LATER file always runs after the create. A sweep in the SAME file
        // only counts if it is written after it — the ordering that PK-57 turned on.
        return wholeSchemaSweeps(sql).some((at) => offset > 0 || at > index);
      });

      expect(
        covered,
        `public.${name} is never revoked from anon. \`revoke ... from public\` is NOT enough: on a hosted Supabase project the function is also created with a named anon grant, which that statement does not touch. A \`revoke ... on all functions in schema public\` earlier in the same file does not count either — it only reaches functions that already exist when it runs.`,
      ).not.toEqual([]);
    },
  );
});
