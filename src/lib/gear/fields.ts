/**
 * The shared vocabulary for the gear closet (PK-4): the statuses, sort keys and paging
 * constants the URL <-> query translation in `src/lib/gear/query.ts` is built from.
 * Split out on its own, mirroring `src/lib/units.ts`'s `WEIGHT_UNITS`/`isWeightUnit`
 * pair, so the "what are the valid values" question and the "how do they turn into a
 * PostgREST query" question live in separate, separately-testable files.
 */

import type { Database } from '../database.types';

/**
 * The column names `gear_items` actually has, read off the generated types rather than
 * spelled out here. `GEAR_SORT_COLUMNS` is typed against this so that a mistyped column
 * (`'brnad'`) is a BUILD failure rather than a PostgREST error at request time on
 * whichever sort link nobody clicked before release — the same reason
 * `scripts/database-types.sh` commits the generated file at all.
 */
type GearItemColumn = keyof Database['public']['Tables']['gear_items']['Row'];

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/**
 * The exactly three values `gear_items.status` accepts:
 * `supabase/migrations/20260810120000_core_schema.sql:104` —
 * `check (status in ('owned', 'wishlist', 'retired'))`. The two sides are independent
 * files with no shared import, so nothing enforces them staying in step — this comment
 * is that enforcement, the same way `WEIGHT_UNITS`' own comment pins it against
 * `weight_unit`'s CHECK constraint.
 *
 * A NOTE FOR THE NEXT READER WHO DIFFS THIS AGAINST THE TICKET. PK-4's ticket text names
 * a different set — Available / In use / Maintenance / Retired — and that mismatch is
 * not an oversight. The schema shipped with exactly `('owned', 'wishlist', 'retired')`
 * before this file was written, and changing it now would be a migration (a CHECK
 * constraint rewrite, a data backfill mapping four ticket-named states onto whatever
 * rows already exist) that this ticket was not scoped to do and that no one has decided
 * is even the right four-way split — "In use" and "Available" are not obviously
 * distinguishable for gear that is not currently on a trip. The decision taken here is
 * to build the closet against the three values the database actually has, not to widen
 * the mismatch by inventing a fourth label this module would then have nowhere to
 * store. If the product decision is later made to adopt the ticket's set, that is a
 * schema change with its own migration, and `GEAR_STATUSES` moves with it — see
 * `WEIGHT_UNITS`'s comment for the same relationship applied to units.
 */
export const GEAR_STATUSES = ['owned', 'wishlist', 'retired'] as const;

export type GearStatus = (typeof GEAR_STATUSES)[number];

/**
 * `status` arrives from a query string typed merely as `string`. This narrows it to a
 * `GearStatus`, mirroring `isWeightUnit` in `src/lib/units.ts`: a value that merely
 * looks plausible (`'Owned'`, `'in-use'`, `'active'`) fails this exactly as a bare typo
 * would, rather than being coerced or silently accepted.
 */
export function isGearStatus(value: unknown): value is GearStatus {
  return typeof value === 'string' && (GEAR_STATUSES as readonly string[]).includes(value);
}

/** Human labels for the UI. Values, not the raw column values, are what render. */
export const GEAR_STATUS_LABELS: Record<GearStatus, string> = {
  owned: 'Owned',
  wishlist: 'Wishlist',
  retired: 'Retired',
};

/**
 * Which status checkboxes the closet's filter bar renders as TICKED, given the statuses
 * `parseGearQuery` actually found in the URL. This is the whole of PK-62's "zero checked
 * behaves as all three checked" rule.
 *
 * WHY IT IS A FUNCTION IN HERE RATHER THAN A TERNARY IN THE PAGE. `vitest.config.ts`
 * excludes `src/pages/**`, so a line written in `src/pages/gear/index.astro`'s
 * frontmatter cannot be asserted on by anything — and this particular line is one of
 * PK-62's four acceptance criteria ("unchecking every status shows the full closet, not
 * an empty one"). Inverting the condition here is a failing test; inverting it in the
 * page was a green suite and a closet that renders nothing, with the filter bar the
 * visitor would need to recover offering no state that fixes it. Same argument every
 * other module in this directory makes for itself.
 *
 * THE QUERY LAYER NEEDED NO MATCHING CHANGE, and that is the point rather than an
 * omission: `applyGearFilters` already applies no `status` filter at all for an empty
 * list, so "none ticked" and "all three ticked" were ALREADY the same result set. All
 * that was missing was rendering them as the same STATE, so that "default" and "cleared"
 * stop looking like two different things that behave identically.
 */
export function checkedGearStatuses(statuses: readonly GearStatus[]): readonly GearStatus[] {
  return statuses.length === 0 ? GEAR_STATUSES : statuses;
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

/** The sort keys the closet list offers, as they appear in the URL's `sort` parameter.
 *  `brand` was added by PK-62 alongside its Brand column header becoming a sort link —
 *  ordering a closet by maker is the one grouping the removed Brand filter checkboxes
 *  used to provide, and a sort does it without a panel of every brand the visitor owns. */
export const GEAR_SORT_KEYS = ['name', 'brand', 'weight', 'price', 'added'] as const;

export type GearSortKey = (typeof GEAR_SORT_KEYS)[number];

/** Narrows an untrusted `sort` query parameter, mirroring `isGearStatus` above. */
export function isGearSortKey(value: unknown): value is GearSortKey {
  return typeof value === 'string' && (GEAR_SORT_KEYS as readonly string[]).includes(value);
}

/**
 * Maps each public sort key to the real `gear_items` column PostgREST orders by.
 * `weight` sorts by `weight_grams` rather than the raw `weight` column deliberately —
 * `weight` alone is not comparable across rows entered in different units (4.4 is not
 * comparable to 2000 without knowing which is oz and which is g); `weight_grams` is the
 * generated column `supabase/migrations/20260813000000_gear_closet.sql` exists to make
 * that comparison possible at all.
 *
 * `price` sorts by the raw `price` column, and that is a known, accepted limitation
 * rather than an oversight: a pack can hold gear priced in different currencies (see
 * `src/lib/money.ts`'s module comment, "CROSS-CURRENCY SUMMING IS IMPOSSIBLE, NOT
 * MERELY DISCOURAGED" — the same reasoning applies to ordering, not only summing,
 * because there is no exchange rate this product is willing to invent). Sorting by the
 * bare number therefore orders £10 below $15 as "cheaper", which is not a real value
 * ordering when the two rows disagree about currency. Unlike weight, there is no
 * generated "canonical price" column this migration could add — canonicalising a price
 * would require an exchange rate, and `money.ts` argues at length for why this product
 * must never invent one. This is left as a known limitation for the UI to surface later
 * (e.g. grouping or flagging mixed-currency results) rather than solved here.
 *
 * `brand` (PK-62) sorts by the raw column, which is the whole mapping. It is nullable,
 * and undated/unbranded placement is NOT this module's decision: `applyGearQuery` passes
 * `nullsFirst: false` on every sort key (PK-61), so null brands are pinned LAST in BOTH
 * directions — not at the top of descending, which is where Postgres's own asymmetric
 * default (NULLS LAST ascending, NULLS FIRST descending) would otherwise put them.
 *
 * A NOTE FOR ANYONE READING THE PK-62 HISTORY. An earlier version of this paragraph
 * argued the opposite — that the Postgres default was deliberately left alone so that
 * descending stayed the exact reverse of ascending. That was true when PK-62 was written
 * and stopped being true when PK-61 landed `nullsFirst: false` first; the two branches
 * were developed in parallel and merged in that order. The pinning is the better
 * behaviour and it is what ships: "no brand" reads as "at the end" whichever way the
 * visitor sorted, consistent with "no date" and "no price". Descending is therefore the
 * reverse of ascending only among the rows that HAVE a brand, which is the trade PK-61
 * made knowingly for `acquired_on` and which applies here for exactly the same reason.
 *
 * `added` sorts by `acquired_on` (PK-61), NOT `created_at` — that swap is the entire
 * point of PK-61. `created_at` is a database audit timestamp: when the row was
 * inserted, which for an item logged weeks after it was actually bought answers a
 * question nobody asked ("when did you get around to typing this in") rather than the
 * one the "Added" column exists to answer ("when did you get this item"). `acquired_on`
 * is the visitor's own claim about that, so it is what "Added" now means.
 *
 * `acquired_on` IS NULLABLE, WITH NO DATABASE DEFAULT — unlike `created_at`, which is
 * always present. A row with no `acquired_on` cannot simply fall wherever Postgres's
 * own default null ordering would put it; it has to be placed deliberately. See the
 * `.order(column, { ascending, nullsFirst: false })` call in `query.ts`'s
 * `applyGearQuery`, which pins undated rows LAST regardless of sort direction.
 */
export const GEAR_SORT_COLUMNS: Record<GearSortKey, GearItemColumn> = {
  name: 'name',
  brand: 'brand',
  weight: 'weight_grams',
  price: 'price',
  added: 'acquired_on',
};

/**
 * Every labelled column header the closet list renders, in render order, with
 * `key: null` marking one that is not sortable. The Status column is absent because
 * PK-62 removed it — a three-value field an icon beside the name says faster (see
 * `GearStatusIcon.astro`).
 *
 * WHY THIS IS HERE AND NOT IN THE PAGE. "The Brand column header becomes a sort link"
 * is one of PK-62's requirements, and a list written in `src/pages/gear/index.astro`
 * frontmatter cannot be asserted on — `vitest.config.ts` excludes `src/pages/**`.
 * Dropping `key: 'brand'` there would have regressed the requirement with a green suite,
 * because `tests/gear-closet.test.ts` proves `sort=brand` WORKS, never that the header
 * OFFERS it. Those are two different claims and only one of them was covered.
 *
 * ONE LIST, NOT TWO SLICES. The page used to hold a sortable-only list rendered as
 * `.slice(0, 1)`, then four hand-written unsortable headers, then `.slice(1)` — an
 * interleaving held together by two magic indices that had to be recounted by hand every
 * time a column moved. Naming each column's sortability removes the slicing altogether.
 *
 * WHAT THIS STILL DOES NOT CAPTURE: the `<tbody>` cells in `src/pages/gear/index.astro`
 * are a SEPARATE, hand-maintained list in the same order, and nothing checks the two
 * move together. Adding an entry here without adding the matching `<td>` there silently
 * misaligns every row after it. This diff exercised exactly that coupling — removing the
 * Status column meant deleting an entry here AND a cell there. Keep them in step by
 * reading; there is no compiler help.
 */
export const GEAR_LIST_COLUMNS: readonly {
  readonly key: GearSortKey | null;
  readonly label: string;
}[] = [
  { key: 'name', label: 'Name' },
  { key: 'brand', label: 'Brand' },
  { key: null, label: 'Category' },
  { key: null, label: 'Qty' },
  { key: 'weight', label: 'Weight' },
  { key: 'price', label: 'Price' },
  { key: 'added', label: 'Added' },
];

// ---------------------------------------------------------------------------
// Paging and search
// ---------------------------------------------------------------------------

/** Rows per page. A per-user closet is bounded at a few hundred rows in practice (see
 *  the "Deliberately no new indexes" section of the gear-closet migration), so a page
 *  this size keeps a single response small without needing more than a handful of pages
 *  for even a large closet. */
export const GEAR_PAGE_SIZE = 50;

/** The longest `q` this module will act on. Longer than any gear name or brand anyone
 *  legitimately types; exists to bound the size of a value this module round-trips into
 *  a URL and into a PostgREST filter, not to reject genuine input. */
export const MAX_SEARCH_LENGTH = 200;
