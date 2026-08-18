/**
 * The owner-scoped reads for pack list composition (PK-37): the composition editor's
 * single-pack load, and the `/packs` list's per-pack totals — plus the one pack-tree
 * select both of them, and the public share page's anonymous read, are built from. On
 * the same footing as `src/lib/gear/query.ts`, whose structure and comment standard this
 * file mirrors deliberately rather than by coincidence; read that module first, and read
 * it for two things specifically.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS LIVES IN src/lib/ RATHER THAN IN THE PAGE
 * ---------------------------------------------------------------------------
 *
 * `vitest.config.ts:64` excludes `src/pages/` from the test run, because every file
 * there becomes a route. `src/pages/account/index.astro:51-55` names the same reasoning
 * for `src/lib/account-deletion.ts`, and `src/lib/gear/query.ts`'s own header repeats it
 * for the closet. The composition editor and the pack list are exactly the same shape of
 * problem: which columns to ask for, how to scope a read to its owner, and how to fold a
 * tree of rows into per-pack totals are all decisions a hostile or merely stale request
 * can probe, and NONE of them can be pinned by a test if they are written in frontmatter.
 * This module is where they live instead.
 *
 * ---------------------------------------------------------------------------
 * OWNER SCOPING IS LOAD-BEARING, NOT BELT-AND-BRACES
 * ---------------------------------------------------------------------------
 *
 * `.eq('user_id', userId)` on every function below is the second thing to read
 * `src/lib/gear/query.ts` for: its own comment on `loadGearCloset` makes this exact
 * argument for `gear_items`, and the argument applies to `packs`, `pack_categories` and
 * `pack_items` with full force, for the identical reason and against the identical
 * mechanism.
 *
 * `supabase/migrations/20260810120000_core_schema.sql` grants each of these three tables
 * TWO permissive SELECT policies:
 *
 *   - `packs_select_own` (:731) and `packs_select_public` (:727)
 *   - `pack_categories_select_own` (:767) and `pack_categories_select_public` (:758)
 *   - `pack_items_select_own` (:824) and `pack_items_select_public` (:813)
 *
 * RLS policies are UNIONED, not intersected. A signed-in visitor's plain
 * `select * from packs` is answered with "every row I own OR every row whose pack is
 * `visibility = 'public'`" — and the `_own` half does not care whose pack the `_public`
 * half is matching, because Postgres evaluates `using (own) OR using (public)` as one
 * expression, not as two gates in series. A read that relied on RLS alone to show "your
 * packs" would therefore show this visitor's own packs *or* any pack — anyone's —
 * sitting with `visibility = 'public'`, the moment that stranger published one. That is
 * not a hypothetical: it is the exact defect `tests/gear-closet.test.ts`'s "THE
 * CROSS-USER LEAK" section found by loading the real closet page, for the sibling table.
 * `tests/packs-query.test.ts`'s own leak test proves the same mechanism here, against
 * `loadPackForEdit`, the same way that one proves it against `loadGearCloset`.
 *
 * `applyGearFilters`/`applyGearQuery` in the sibling module deliberately do not add this
 * filter themselves, because they do not know who is asking; the same is true of nothing
 * in this file, because every function here IS the place that knows the signed-in
 * visitor's id, and is therefore the one place responsible for adding it.
 *
 * ---------------------------------------------------------------------------
 * NOT importing src/lib/auth/
 * ---------------------------------------------------------------------------
 *
 * Every function below takes a `PacksheetClient` and a `userId` as parameters rather than
 * constructing or authenticating either itself — the same posture `src/lib/gear/query.ts`
 * takes and argues for in its own header, and the same one `src/lib/packs/routes.ts` and
 * `src/lib/packs/reorder.ts` argue for theirs. Importing `src/lib/auth/` would need an
 * `AUTH_CONSUMERS` entry, and a pure query-building module has no business asking for
 * that standing permission — its caller already has an authenticated client from
 * middleware and only ever lends it for the duration of one call.
 *
 * This is not a style preference here specifically: PK-26's public share page — not yet
 * written — will import `PACK_TREE_SELECT` from this module for its own anonymous read
 * (replacing the copy that currently lives in `tests/support/local-database.ts`, see
 * below), and Invariant A in `tests/anonymous-read-path.test.ts` is an EDGE rule. It does
 * not look at what a module contains, only at whether something outside the auth choke
 * point has an import edge into it — so an import added here today would fail a build
 * that has not been written yet, for a page that has not been written yet, in a way
 * nothing in this ticket would catch. The rule is enforced now, before there is anything
 * concrete to violate it, because that is the only point at which enforcing it is free.
 */

import type { PacksheetClient } from '../supabase';
import { computeTotals, type PackTotals } from '../totals';

// ---------------------------------------------------------------------------
// PACK_TREE_SELECT
// ---------------------------------------------------------------------------

/**
 * The one pack-tree select. Every reader of a pack — the anonymous share page (PK-26,
 * via `packTreeQuery` in `tests/support/local-database.ts`), the composition editor
 * (`loadPackForEdit` below) and the `/packs` list (`loadPackList` below) — issues this
 * exact select, embedded with `pack_categories(pack_items(gear_items(...)))`, and the
 * only thing that differs between them is which `.eq(...)`/`.order(...)` calls sit on
 * top of it and whether the query is scoped to one row or many.
 *
 * MOVED HERE FROM `tests/support/local-database.ts:345` (PK-37). `src/lib/totals.ts`'s
 * own module comment named the day this would happen before this ticket existed:
 * "The pointer moves to the page's own module the day there is one" — this is that day,
 * because this ticket adds the first `src/lib/` module that reads a pack for anything
 * other than a test. `packTreeQuery` in `tests/support/local-database.ts` keeps its
 * anonymous-by-slug shape (that helper belongs to PK-26's share page, not to this
 * ticket), but now imports this constant rather than declaring it, so there is exactly
 * one copy of the select string in the whole codebase.
 *
 * EVERY COLUMN THE TOTALS ENGINE READS IS HERE, and that is a requirement rather than
 * generosity — carried over unchanged from the comment this replaces. `src/lib/totals.ts`
 * takes `consumable`, `packed`, `price` and `currency` as required fields, and
 * `tests/packs-query.test.ts` asserts at compile time that this select's inferred row
 * type is assignable to `PackTreePack` — so dropping one of them from this string fails
 * `tsc --noEmit` rather than quietly changing what a total means. The failure it prevents
 * is not hypothetical: with `price` unselected, a pack whose one deleted gear item
 * carried a snapshot (which DOES capture price, whatever the select asked for) reported
 * that single item's price as the whole pack's cost.
 *
 * WIDENED FOR THE EDITOR (PK-37): `description` and `trip_type` are new on the packs
 * level, added because `loadPackForEdit` needs them and the share page's read of a pack
 * never carried them. This is the ONE constant, widened, rather than a second,
 * hand-written select growing up beside it — see the paragraph on widening below for why
 * that is safe here specifically, and why narrowing is the direction that is not.
 *
 * WIDENING THIS SELECT IS SAFE; NARROWING IT IS NOT, AND THE ASSERTION ONLY PINS ONE
 * DIRECTION. `tests/packs-query.test.ts`'s compile-time assignability check
 * (`_acceptsQueryRows`, moved from `tests/totals.test.ts` in this same change) is a
 * CONTRAVARIANT check: it fails if the select's row type stops satisfying
 * `PackTreePack` — i.e. if a column the totals engine needs is removed — but it has
 * nothing to say about a column being ADDED, because a wider row still satisfies a
 * narrower required shape structurally. That asymmetry is exactly why widening this one
 * constant, rather than writing a second select for the editor's extra columns, is the
 * correct fix for "the editor needs a couple of columns the share-page read does not":
 * the assertion keeps catching the mistake that actually matters (a select trimmed until
 * a total goes quietly wrong) while imposing no compile-time obstacle to the direction
 * that is safe.
 *
 * WIDENING THIS SELECT PUBLISHES NOTHING, for the packs table specifically, which is
 * worth checking rather than assuming by analogy with `gear_items`. `grant select on
 * public.packs to anon` (`supabase/migrations/20260810120000_core_schema.sql:987`) is a
 * table-wide grant with no column list — Postgres has no notion of "anon may read
 * `name` but not `description`" here, and the migration's own grants-block comment
 * explains why column-level grants are not used at all while PostgREST embeds are (see
 * that comment, cited by the paragraph this one replaces). So `description` and
 * `trip_type` were already readable by `anon` for any `visibility = 'public'` pack
 * before this change; asking for them in the one shared select does not cross a boundary
 * that policy did not already remove. Whether the share page should ever RENDER them to
 * a stranger is a layout decision for PK-26, not a privilege one — the same distinction
 * `tests/support/local-database.ts`'s comment draws for `notes`, `url` and `price`.
 *
 * Ordering is applied by each caller, not written here, because PostgREST orders an
 * embedded resource from a separate parameter, not from the select list — see
 * `packTreeQuery` in `tests/support/local-database.ts` and `loadPackForEdit`/
 * `loadPackList` below, all three of which apply the identical four `.order(...)` calls
 * for the identical reason (the tie-break `pack_categories.position`'s own schema
 * comment describes, `supabase/migrations/20260810120000_core_schema.sql:228`, echoed at
 * `:268` for `pack_items.position`).
 */
export const PACK_TREE_SELECT =
  'id, name, description, trip_type, slug, visibility, locked_at, pack_categories(id, name, position, pack_items(id, quantity, worn, consumable, packed, position, overrides, snapshot, gear_items(id, name, brand, weight_grams, price, currency)))';

/**
 * `client.from('packs').select(PACK_TREE_SELECT)`'s row type, as a `ReturnType<typeof …>`
 * derivation rather than a hand-written interface — the same pattern
 * `src/lib/gear/query.ts` uses for `GearItemsQueryBuilder`/`_gearItemsQuery`, and for the
 * identical reason: deriving the type from the query itself means it can never drift
 * from `PACK_TREE_SELECT`, because the two are the same expression. `_packTreeQuery` is
 * never called — it exists purely to be the argument to `ReturnType<typeof …>` — and the
 * leading underscore is this project's convention (see `_gearItemsQuery`'s own comment)
 * for "used only as a type", which is what tells `no-unused-vars` this is deliberate.
 *
 * Exported as `PackTreeRow` rather than left internal, because `tests/packs-query.test.ts`
 * needs the exact same derivation `tests/totals.test.ts` used to perform inline against
 * `packTreeQuery` — see the assignability assertion this module's own comment on
 * `PACK_TREE_SELECT` describes.
 */
function _packTreeQuery(client: PacksheetClient) {
  return client.from('packs').select(PACK_TREE_SELECT);
}

export type PackTreeRow = NonNullable<Awaited<ReturnType<typeof _packTreeQuery>>['data']>[number];

// ---------------------------------------------------------------------------
// loadPackForEdit — the owner-scoped single-pack load, for the composition editor
// ---------------------------------------------------------------------------

/**
 * The owner-scoped load for the composition editor: one pack by id, with its categories
 * and items ordered `position` then `id`.
 *
 * `.eq('id', packId).eq('user_id', userId)` — BOTH, not `id` alone. See this module's own
 * header, "OWNER SCOPING IS LOAD-BEARING, NOT BELT-AND-BRACES": `packs_select_public`
 * would hand this query any public pack's id whether or not it belongs to the visitor
 * asking, and `pack_categories`/`pack_items` carry the identical pair of policies one
 * level down. Without `user_id` scoped explicitly, a signed-in visitor who merely guessed
 * or was sent someone else's public pack id would land on what looks like an edit form —
 * and, if a later mutation trusted this read instead of re-checking under RLS itself,
 * would be one PATCH away from actually being allowed to change it, because
 * `pack_categories_update_own`/`pack_items_update_own` both require `user_id =
 * auth.uid()` on the WRITE side too and would simply refuse it — but "the edit form loads
 * for a pack you do not own" is already the wrong outcome on its own, RLS backstop or
 * not.
 *
 * A missing pack, another visitor's pack, and a malformed id (which PostgREST refuses
 * with an error before RLS is even consulted) all collapse to the same `{ data: null }`
 * shape here, on purpose — the identical collapse `loadGearItem` in
 * `src/lib/gear/query.ts` performs, and for the identical reason: the caller turns all
 * three into one real 404, and none of the three is a distinction a visitor probing this
 * editor should be able to tell apart from the outside.
 *
 * THE ORDER CALLS MATCH `packTreeQuery` IN `tests/support/local-database.ts` EXACTLY,
 * because the tie-break they express is a fact about the schema, not about which query is
 * asking. `position` then `id`: PostgREST orders an embedded resource from a
 * `{ referencedTable }` parameter rather than from the select list, and Postgres itself
 * makes no promise about the order of rows sharing a `position` — duplicates are a
 * deliberate allowance, not an edge case (`pack_categories.position`'s own comment at
 * `supabase/migrations/20260810120000_core_schema.sql:228`, "Deliberately NOT unique",
 * echoed for `pack_items.position` at `:268`). `id` is a `uuid primary key`, always
 * present and always unique, which is what makes it a safe universal tie-break — and it
 * is the same trailing column the read indexes
 * (`pack_categories_pack_id_position_idx`, `pack_items_pack_category_id_position_idx`,
 * both at `:697`-`:699`) already carry, so this ordering comes back sorted from the index
 * rather than through a sort node.
 */
export async function loadPackForEdit(client: PacksheetClient, userId: string, packId: string) {
  return client
    .from('packs')
    .select(PACK_TREE_SELECT)
    .eq('id', packId)
    .eq('user_id', userId)
    .order('position', { referencedTable: 'pack_categories', ascending: true })
    .order('id', { referencedTable: 'pack_categories', ascending: true })
    .order('position', { referencedTable: 'pack_categories.pack_items', ascending: true })
    .order('id', { referencedTable: 'pack_categories.pack_items', ascending: true })
    .maybeSingle();
}

// ---------------------------------------------------------------------------
// loadPackList — the owner-scoped pack list, with per-pack totals
// ---------------------------------------------------------------------------

/** One row of the `/packs` list: the pack tree `loadPackList` fetched, and its totals. */
export interface PackListEntry {
  readonly pack: PackTreeRow;
  readonly totals: PackTotals;
}

/**
 * The owner-scoped load for `/packs`: every pack this visitor owns, each with its own
 * `PackTotals` computed from the SAME tree the row was fetched with — one round trip for
 * the whole list, not one query per pack plus N calls to total each of them.
 *
 * ONE ROUND TRIP IS THE POINT, NOT AN OPTIMISATION APPLIED AFTERWARD. `PACK_TREE_SELECT`
 * already embeds `pack_categories(pack_items(gear_items(...)))`, so asking PostgREST for
 * every owned pack with that same embed is exactly as many requests as asking for the
 * packs alone would have been — one — and the embed is what lets `computeTotals` run
 * against each row with no second fetch. A per-pack loop calling `loadPackForEdit` (or
 * anything that issues its own request) for each id in the list would turn "how many
 * packs do you have" into an N+1 query pattern the moment a visitor has more than one
 * pack, which is the ordinary case, not the edge case.
 *
 * TOTALS COME FROM `computeTotals` (`src/lib/totals.ts`) AND NOWHERE ELSE. This function
 * does not sum a weight or a price itself — it folds the fetched tree through the one
 * totals engine the product has, the same function `loadPackForEdit`'s caller and the
 * (not yet written) share page will use for the identical pack. A second, hand-written
 * summation here — "just add up the prices for the list view" — is exactly the kind of
 * duplication `src/lib/totals.ts`'s own module comment exists to prevent: two
 * implementations of "what does this pack cost" drift, and the way they drift is that the
 * list page and the editor disagree about a number a visitor can see on both screens at
 * once.
 *
 * `.eq('user_id', userId)` — see this module's header. A read of "your packs" relying on
 * RLS alone would union in every OTHER visitor's `visibility = 'public'` pack via
 * `packs_select_public`, which is precisely the wrong list to show under a heading that
 * says "your packs".
 *
 * ORDERED `created_at` DESCENDING, `id` ASCENDING AS TIE-BREAK. Newest first is the
 * ordinary "what did I just make" reading of a list with no explicit sort control yet;
 * `id` breaks a tie on `created_at` for the same reason every other ordered read in this
 * codebase pins a tie-break rather than leaving it to whatever order Postgres happens to
 * return duplicate timestamps in — `packs.created_at` has no uniqueness guarantee, and
 * two packs created in the same transaction (a duplicate, e.g.) can share it to the
 * microsecond, the same failure mode `src/lib/gear/query.ts`'s `applyGearQuery` documents
 * at length for `gear_items.created_at`. The four `pack_categories`/`pack_items`
 * `.order(...)` calls beneath it are the identical tie-break `loadPackForEdit` and
 * `packTreeQuery` apply, for the identical reason — the same schema comment governs all
 * three call sites.
 *
 * ERRORS COLLAPSE TO AN EMPTY LIST WITH THE ERROR ATTACHED, not to a thrown exception —
 * the caller decides what an empty `/packs` looks like versus a failed one, the same
 * shape `loadGearCloset` in `src/lib/gear/query.ts` returns for its own count-query
 * failure.
 */
export async function loadPackList(client: PacksheetClient, userId: string) {
  const { data, error } = await client
    .from('packs')
    .select(PACK_TREE_SELECT)
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: true })
    .order('position', { referencedTable: 'pack_categories', ascending: true })
    .order('id', { referencedTable: 'pack_categories', ascending: true })
    .order('position', { referencedTable: 'pack_categories.pack_items', ascending: true })
    .order('id', { referencedTable: 'pack_categories.pack_items', ascending: true });

  if (error) return { packs: [], error };

  return {
    packs: data.map((pack) => ({ pack, totals: computeTotals(pack) })),
    error: null,
  };
}
