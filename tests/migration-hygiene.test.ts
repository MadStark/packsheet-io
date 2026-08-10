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
