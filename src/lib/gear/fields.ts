/**
 * The shared vocabulary for the gear closet (PK-4): the statuses, sort keys and paging
 * constants the URL <-> query translation in `src/lib/gear/query.ts` is built from.
 * Split out on its own, mirroring `src/lib/units.ts`'s `WEIGHT_UNITS`/`isWeightUnit`
 * pair, so the "what are the valid values" question and the "how do they turn into a
 * PostgREST query" question live in separate, separately-testable files.
 */

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
 * `brand` (PK-62) sorts by the raw column, which is the whole mapping — but note it is
 * the first NULLABLE column this list offers. Postgres orders nulls LAST ascending and
 * FIRST descending by default, and neither PostgREST nor this module overrides that, so
 * items with no brand cluster at the bottom going up and at the top coming down. That is
 * left as-is deliberately: `nullslast` in both directions would make descending no longer
 * the exact reverse of ascending, which is a stranger promise for a column header whose
 * two clicks a visitor reasonably expects to mirror each other. `applyGearQuery`'s
 * secondary `.order('id')` keeps the run of null-brand rows in a stable, repeatable order
 * across pages rather than letting Postgres return them differently per request.
 */
export const GEAR_SORT_COLUMNS: Record<GearSortKey, string> = {
  name: 'name',
  brand: 'brand',
  weight: 'weight_grams',
  price: 'price',
  added: 'created_at',
};

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
