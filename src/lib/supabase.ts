import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './database.types';

/**
 * The PostgREST major version the Data API actually speaks.
 *
 * supabase-js changes what it will let you write according to this number: it is where
 * `maxAffected()`, spreads over to-many embeds, and several other query forms are gated.
 * The number is supposed to arrive inside the generated types, as
 * `__InternalSupabase.PostgrestVersion` — but `supabase gen types typescript --local`
 * does not emit that key, so supabase-js falls back to its default of `'12'`.
 *
 * The stack answers `Server: postgrest/14.16`. Left at the default, the types are wrong
 * about the database in both directions: `.update(…).maxAffected(1)` is a compile error
 * against a database that supports it, and a to-many spread types as a single object
 * where PostgREST returns a correlated array. Both measured, not assumed.
 *
 * That is the same class of failure src/lib/database.types.ts exists to prevent, and the
 * drift check cannot see it — that check compares generated output against generated
 * output and never against the running database. So this is the one hand-written fact in
 * the chain, and tests/database-types.test.ts pins it against the `Server` header rather
 * than leaving it to be discovered by a query that will not compile.
 *
 * Remove this, and the version argument below, if the generator starts emitting
 * `__InternalSupabase` — at that point the drift check covers it and a second source of
 * truth is worse than none.
 */
export const POSTGREST_MAJOR = '14';

/**
 * A Supabase client that knows this project's schema.
 *
 * Everything worth having comes from the `Database` parameter: `.from()` table names,
 * `Insert`/`Update` payload keys, `select()` column names, and — the one that had a
 * hand-written cast standing in for it until Ref 52 — embed cardinality. A to-one embed
 * resolves to an object rather than the array an untyped client infers, so
 * `data.gear_items.name` compiles and means what it says.
 *
 * Written as one alias rather than spelled out per call site because the PostgREST
 * version above has to travel with it. A bare `SupabaseClient` — no type argument — is
 * `SupabaseClient<any>`, which silently discards all of it; that is not hypothetical,
 * one annotation in tests/support/fixtures.ts was doing exactly that.
 */
export type PacksheetClient = SupabaseClient<
  Database,
  { PostgrestVersion: typeof POSTGREST_MAJOR }
>;
