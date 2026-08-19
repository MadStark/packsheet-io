/**
 * The gear closet's writes (PK-4): the closet list's bulk actions — set category, set
 * status, delete — and the single-item edit and delete `src/pages/gear/[id].astro`
 * performs, moved out of page frontmatter and into `src/lib/gear/` (PK-4 review, C3)
 * for the same reason as every read in `src/lib/gear/query.ts` and
 * `src/lib/gear/options.ts`: `vitest.config.ts` excludes `src/pages/`, so a write
 * statement living only in frontmatter is a write statement no test can reach. PK-4's
 * independent review found exactly that by mutation testing — mutations to the delete
 * path survived, not because the assertions were weak but because nothing in the suite
 * could execute the statement at all. Every write below is callable, and asserted,
 * directly.
 *
 * `src/lib/gear/bulk.ts` stays what its own module comment always said it was: pure
 * validation, no query. This module is the other half that comment described as
 * belonging to "the calling page" — now a page, and a test, share.
 *
 * EVERY FUNCTION HERE TAKES `client` AND `userId` AND SCOPES ITS OWN WRITE WITH
 * `.eq('user_id', userId)`. The write policies (`gear_items_update_own` /
 * `gear_items_delete_own`, core_schema.sql:904-911) do already confine every statement
 * below to the caller's own rows, with no "via public pack" counterpart the way the
 * SELECT policies have (see `query.ts`'s `loadGearCloset` comment for that half of the
 * story) — but that is a fact about the policy set as it stands today, not a property
 * of this module, and it is not why the filter is here. A function whose entire
 * contract is "acts on THIS visitor's rows" should enforce that contract itself, so it
 * holds for every future caller, survives a policy being renamed or relaxed, and is
 * something a test can assert on directly rather than having to take RLS's word for.
 * It costs nothing — and one of these functions now removes rows from the table
 * outright, which is the one write in this product where being wrong about whose rows
 * they were cannot be walked back.
 *
 * EVERY WRITE REPORTS WHAT IT ACTUALLY DID, NOT WHAT IT WAS ASKED TO DO (PK-4 review,
 * I6). `.select('id')` on every mutation below, with `count` read off the rows the
 * write actually returned — never off the length of the id list the caller passed in.
 * A zero-row update (a stale link, a second tab that already changed these items, a
 * race with another request) is indistinguishable from a real one over plain PostgREST
 * otherwise, and a page that reports "1 item deleted" from the REQUEST rather than the
 * RESULT can say that about a write that touched nothing at all.
 */

import type { PostgrestError } from '@supabase/supabase-js';
import type { PacksheetClient } from '../supabase';
import type { Database } from '../database.types';
import { MAX_BULK_IDS } from './bulk';
import type { GearStatus } from './fields';
import type { GearItemInput } from './form';
import { MAX_IMPORT_ITEMS } from './json-import';

/** What every write below reports: whether it failed, and how many rows it actually
 *  touched — see the module comment's "EVERY WRITE REPORTS..." section for why `count`
 *  is read off the write's own `.select('id')` rather than off the caller's input. */
export interface GearMutationResult {
  readonly error: PostgrestError | null;
  readonly count: number;
}

/** Sets `category` on every id in `ids`. `category: null` clears the field, mirroring
 *  `parseBulkAction`'s own "empty box means clear it" reading of an empty category box
 *  (`src/lib/gear/bulk.ts`). */
export async function bulkSetCategory(
  client: PacksheetClient,
  userId: string,
  ids: readonly string[],
  category: string | null,
): Promise<GearMutationResult> {
  const { data, error } = await client
    .from('gear_items')
    .update({ category })
    .eq('user_id', userId)
    .in('id', ids as string[])
    .select('id');
  return { error, count: data?.length ?? 0 };
}

/** Sets `status` on every id in `ids` — same shape as `bulkSetCategory`. `'retired'`
 *  gets no special handling here: it is one of the three values `isGearStatus`
 *  (`src/lib/gear/fields.ts`) accepts, written by the same statement as the other two,
 *  and a retired item stays an ordinary row of the closet that every query in
 *  `src/lib/gear/query.ts` returns and every filter can select. */
export async function bulkSetStatus(
  client: PacksheetClient,
  userId: string,
  ids: readonly string[],
  status: GearStatus,
): Promise<GearMutationResult> {
  const { data, error } = await client
    .from('gear_items')
    .update({ status })
    .eq('user_id', userId)
    .in('id', ids as string[])
    .select('id');
  return { error, count: data?.length ?? 0 };
}

/**
 * THE delete: every id in `ids` leaves `gear_items` for good. There is no tier behind
 * this one and nothing to restore from afterwards. Both callers come through here — the
 * closet list's bulk delete with a selection, and `src/pages/gear/[id].astro`'s
 * single-item delete with a one-element array. There is deliberately no separate
 * single-id function, because there is nothing a delete of one row does differently
 * from a delete of twelve.
 *
 * WHAT THIS SETS OFF IN THE DATABASE. `gear_items_snapshot_before_delete`
 * (core_schema.sql:437-439) fires BEFORE DELETE, once per row, and freezes the row into
 * every `pack_items` row still referencing it that has no snapshot yet; the composite
 * foreign key then nulls those items' `gear_item_id` (core_schema.sql:310-311). That
 * trigger is the whole reason a real delete is safe to offer at all — a pack keeps the
 * name, weight and price its line had, rather than losing the line.
 *
 * Naming the design this replaced is worth the words here, because the risk profile
 * changed and the code does not show it: that trigger used to be reachable only by
 * emptying the trash — the far end of a two-stage journey, behind a typed-out
 * confirmation word. It is now what ordinary deleting does. The only thing standing in
 * front of it is the UI's reveal-then-confirm step (`confirmsGearDeletion` in
 * `src/lib/gear/bulk.ts`); nothing in this function, in `bulk.ts`, or in the database
 * will stop or reverse a confirmed delete.
 *
 * THE TWO GUARDS BELOW, AND WHY THIS FUNCTION EARNS THEM WHEN THE OTHERS DO NOT (PK-60
 * review, F3). `MAX_BULK_IDS` was enforced in exactly one place, `parseBulkAction` — a
 * validator this function neither calls nor can check was called. That is the same
 * mistake the module comment above complains about with `.eq('user_id', …)`: a bound
 * that holds because one particular caller happens to apply it is a property of that
 * caller, not of this contract, and the next caller (an importer, an admin tool, a
 * background job) inherits none of it. `bulkSetCategory` and `bulkSetStatus` are left
 * unguarded on purpose rather than by omission — an over-large or empty UPDATE is a slow
 * or pointless statement, and every row it touches can be set back by issuing the
 * opposite one. Neither is true here. An unbounded `DELETE … IN (…)` built from a
 * `?id=` repeated ten thousand times is irreversible at the scale of whatever it
 * matched, so the cap belongs where the DELETE is issued, not only where a form is read.
 *
 * The two guards fail differently on purpose. An empty `ids` is a NO-OP, not an error:
 * it is what a caller filtering a list down to nothing legitimately produces, the
 * truthful answer is "nothing was deleted", and returning it without a round trip means
 * this function can never issue the degenerate `DELETE … WHERE id IN ()`. Over the cap
 * THROWS rather than truncating or returning an error, because there is no correct
 * partial answer: silently deleting the first 500 of 900 rows would be a wrong,
 * irreversible write reported as a success, and it is not reachable from either gear
 * page — `parseBulkAction` refuses an over-cap selection long before this — so a call
 * that gets here is a programming error in a new caller and should read as one.
 */
export async function deleteGearItems(
  client: PacksheetClient,
  userId: string,
  ids: readonly string[],
): Promise<GearMutationResult> {
  if (ids.length === 0) return { error: null, count: 0 };
  if (ids.length > MAX_BULK_IDS) {
    throw new RangeError(
      `deleteGearItems refuses ${ids.length} ids: at most ${MAX_BULK_IDS} may be deleted at once.`,
    );
  }

  const { data, error } = await client
    .from('gear_items')
    .delete()
    .eq('user_id', userId)
    .in('id', ids as string[])
    .select('id');
  return { error, count: data?.length ?? 0 };
}

/**
 * Writes a validated JSON import (PK-65) into the closet: every item, or none of them.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS ONE `.insert()` AND NOT THE `SECURITY DEFINER` RPC THE TICKET ASKS FOR
 * ---------------------------------------------------------------------------
 *
 * PK-65 says, in as many words, that import needs "a `SECURITY DEFINER` import RPC,
 * following `delete_own_account` — PostgREST cannot do a multi-table transaction from the
 * client, and this project holds no service-role key". That reasoning is correct and it
 * does not apply to THIS half of the ticket, so this function is a plain insert and this
 * branch adds no migration at all.
 *
 * The premise of the RPC is the word MULTI-TABLE. Importing a PACK writes `packs`, then
 * `pack_categories`, then `pack_items`, and three statements over PostgREST are three
 * transactions — there is no client-side sequence of them that is atomic, so the only
 * place the atomicity can live is inside a function. Importing GEAR ITEMS writes one
 * table. A single multi-row `INSERT` is ONE statement, and a statement in Postgres is
 * atomic on its own: if row 187 of 200 violates `gear_items_price_has_currency`, the
 * whole statement rolls back and rows 1 to 186 were never visible to anybody. "Transac-
 * tional — no partial imports" is therefore already true here, by construction, with
 * nothing added.
 *
 * That leaves a `SECURITY DEFINER` function with no job to do, and the project's own
 * rules say not to write one anyway: README's authorization section makes DEFINER
 * conditional on RLS being structurally unable to express the operation — which is what
 * justifies `delete_own_account`, since `authenticated` holds no privilege on
 * `auth.users` at all and no policy can be written to grant it. Inserting your own rows
 * into your own table is the exact operation `gear_items_insert_own` already expresses.
 * Adding a DEFINER function here would take a write that RLS enforces and move it behind
 * a function that bypasses RLS to re-implement the same check by hand — strictly more
 * privilege, strictly more code, and one more entry for `tests/rls-enabled.test.ts`'s
 * sweep to have to be satisfied about, in exchange for nothing.
 *
 * WHEN THAT CHANGES: the moment pack import lands. It genuinely needs the RPC, for the
 * reason the ticket gives. Nothing here should be read as an argument against it — only
 * as the observation that the items-only half never had the problem the RPC solves.
 *
 * ---------------------------------------------------------------------------
 * THE REST OF THE HOUSE RULES, APPLIED
 * ---------------------------------------------------------------------------
 *
 * `user_id` IS SET EXPLICITLY rather than left to the column's `default auth.uid()`. The
 * default would produce the identical value and the insert policy would refuse anything
 * else, so this is not a correctness fix — it is the same contract every other function
 * in this module keeps, and its module comment argues for at length: a function whose
 * contract is "writes THIS visitor's rows" should say so itself rather than inherit it
 * from a column default and a policy, both of which are facts about the schema as it
 * stands rather than properties of this function.
 *
 * IT REPORTS WHAT WAS WRITTEN, not what it was asked to write — `count` off
 * `.select('id')`, like every other write here. For an insert that is a weaker signal
 * than it is for an update (an insert that succeeds inserted what it was given), but a
 * caller reporting "200 items imported" should be reading the result either way, and the
 * one shape that must never appear is a success message assembled from the input list.
 *
 * THE CAP IS ENFORCED HERE AS WELL AS IN THE PARSER, and `deleteGearItems`' own comment
 * is the precedent: `MAX_IMPORT_ITEMS` living only in `parseGearItemsFile` is a bound
 * that holds because one caller applies it, not a property of this function. An empty
 * list is a NO-OP rather than an error, for the same reason it is there — it is what a
 * caller legitimately produces, and the truthful answer is "nothing was imported".
 * Over the cap THROWS, because there is no correct partial answer to give.
 */
export async function importGearItems(
  client: PacksheetClient,
  userId: string,
  items: readonly GearItemInput[],
): Promise<GearMutationResult> {
  if (items.length === 0) return { error: null, count: 0 };
  if (items.length > MAX_IMPORT_ITEMS) {
    throw new RangeError(
      `importGearItems refuses ${items.length} items: at most ${MAX_IMPORT_ITEMS} may be imported at once.`,
    );
  }

  const { data, error } = await client
    .from('gear_items')
    .insert(items.map((values) => gearItemInsert(values, userId)))
    .select('id');
  return { error, count: data?.length ?? 0 };
}

/**
 * One validated item as an insertable row, with `weight_grams` made unwritable.
 *
 * `weight_grams` IS `GENERATED ALWAYS ... STORED` AND POSTGRES REFUSES A DIRECT WRITE TO
 * IT — but nothing in TypeScript did. The generated `Insert` type lists every column
 * including that one, so `.insert([{ …, weight_grams: 999 }])` compiled cleanly and failed
 * only at runtime, as a raw Postgres error, on a path whose whole point is that the file
 * carries grams and the database derives them. This ticket makes that mistake unusually
 * easy to make: `PacksheetGearItem` HAS a `weight_grams` field, so spreading a file item
 * into an insert is the obvious wrong thing to reach for. `Omit` turns it into a compile
 * error instead of a 500.
 */
function gearItemInsert(
  values: GearItemInput,
  userId: string,
): Omit<Database['public']['Tables']['gear_items']['Insert'], 'weight_grams'> {
  return { ...values, user_id: userId };
}

/** Saves an edit to exactly one item. `.eq('id', id)` alone would not be enough to make
 *  this "edit MY item": an id is guessable, and the owner filter is what ties the
 *  statement to the visitor the caller actually authenticated — see the module comment's
 *  "EVERY FUNCTION HERE TAKES..." section. `values` is a `GearItemInput`, already
 *  validated by `src/lib/gear/form.ts`, so nothing raw from a form reaches the column
 *  list here. */
export async function updateGearItem(
  client: PacksheetClient,
  userId: string,
  id: string,
  values: GearItemInput,
): Promise<GearMutationResult> {
  const { data, error } = await client
    .from('gear_items')
    .update(values)
    .eq('user_id', userId)
    .eq('id', id)
    .select('id');
  return { error, count: data?.length ?? 0 };
}
