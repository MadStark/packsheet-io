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
 * is that enforcement, the same way `WEIGHT_SYSTEMS`' own comment pins it against
 * `check (weight_units in ('metric', 'imperial'))` on `public.profiles`. (It used to name
 * `WEIGHT_UNITS` and `weight_unit`; PK-67 deleted that column, and `WEIGHT_SYSTEMS` is now
 * the list with a constraint behind it.)
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
 * `WEIGHT_SYSTEMS`'s comment for the same relationship applied to the units setting.
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
 * One-sentence explanations of what each status means, for use as a `title` tooltip
 * next to the visible label (PK-63's item form, where the status picker is a radio
 * group and each option carries one of these on its label or wrapper).
 *
 * NOT A SUBSTITUTE FOR `GEAR_STATUS_LABELS`. A tooltip is an ENHANCEMENT layered on top
 * of an already-complete visible label and accessible name, never the only place the
 * meaning lives: `title` is not reliably reachable by keyboard (no native focus
 * triggers it) or by touch (no hover to speak of), so anyone who cannot hover a mouse
 * over the option sees only the label `GEAR_STATUS_LABELS` already provides and must be
 * able to understand the status from that alone. If a label ever needed this text to
 * make sense, the label would be the thing to fix, not this record.
 */
export const GEAR_STATUS_MEANINGS: Record<GearStatus, string> = {
  owned: 'Gear you have and can pack.',
  wishlist: 'Gear you want but do not own yet.',
  retired: 'Gear you no longer use but want to keep a record of.',
};

/**
 * The statuses a closet query filters by, and the boxes the filter bar ticks, when the
 * visitor has selected none — equivalently, what a `status`-less URL means. PK-70: a
 * fresh, unfiltered closet no longer shows gear marked `retired`; a visitor sees `owned`
 * and `wishlist` until they explicitly ask for `retired` too. Retired items are not
 * hidden FROM the closet — `?status=retired` still returns exactly them, unchanged (see
 * `applyGearFilters` in query.ts) — only from the DEFAULT, unfiltered view of it.
 */
export const GEAR_DEFAULT_STATUSES = ['owned', 'wishlist'] as const;

/**
 * Which statuses an "empty" selection actually means, for BOTH of the two places that
 * question gets asked: which checkboxes the closet's filter bar renders as TICKED, given
 * the statuses `parseGearQuery` actually found in the URL, and — since PK-70 —
 * which statuses `applyGearFilters` filters `gear_items.status` by for that same query
 * (query.ts imports this function rather than re-deriving its own default). One function
 * answering both is what makes it structurally impossible for the ticked boxes and the
 * returned rows to disagree: a visitor can never see a box unticked next to a status that
 * is still quietly present in the list, or ticked next to one the query just filtered out.
 *
 * THE RENAME FROM `checkedGearStatuses` IS LOAD-BEARING, NOT COSMETIC. The old name
 * described only the checkbox half of what this function has done since PK-62 — accurately,
 * as far as it went — but PK-70 gave it a second, equally real caller in the query layer,
 * and a name that advertises only the UI use is exactly the kind of name that lets a
 * caller quietly stop sharing the function it was supposed to share, rather than one that
 * makes "these two things must agree" obvious at every call site.
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
 * A NOTE FOR THE NEXT READER WHO DIFFS THIS AGAINST PK-62'S TICKET. This function used to
 * return `GEAR_STATUSES` (all three) for an empty selection, and its own comment argued
 * "THE QUERY LAYER NEEDED NO MATCHING CHANGE, and that is the point rather than an
 * omission" — because `applyGearFilters` applied no `status` filter at all for an empty
 * list, so "none ticked" and "all three ticked" were already the same result set, and this
 * function only had to make them look like the same STATE. PK-70 makes both of those
 * statements false at once: an empty selection is no longer "no floor", it resolves to
 * `GEAR_DEFAULT_STATUSES` — owned and wishlist, retired excluded — and the query layer DOES
 * need this function's answer now, because that is the only way "no `status` param at all"
 * stops meaning "show me everything, retired included". What survives from PK-62 unchanged
 * is the other half of the rule: unticking every box still must not produce an empty
 * closet, and an explicit selection — an explicit all-three, or a bare `?status=retired` —
 * is still returned exactly as given, never rewritten.
 */
export function effectiveGearStatuses(statuses: readonly GearStatus[]): readonly GearStatus[] {
  return statuses.length === 0 ? GEAR_DEFAULT_STATUSES : statuses;
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

/** The sort keys the closet list offers, as they appear in the URL's `sort` parameter.
 *  `brand` was added by PK-62 alongside its Brand column header becoming a sort link —
 *  ordering a closet by maker is the one grouping the removed Brand filter checkboxes
 *  used to provide, and a sort does it without a panel of every brand the visitor owns.
 *  `category` was added the same way by PK-70: PK-62 removed the Category filter
 *  checkboxes alongside Brand's (see `unsurfacedFilterParams` in query.ts), and a Category
 *  sort link is the same substitute for the one grouping they used to provide. */
export const GEAR_SORT_KEYS = ['name', 'brand', 'category', 'weight', 'price', 'added'] as const;

export type GearSortKey = (typeof GEAR_SORT_KEYS)[number];

/**
 * What `?sort=` and `?dir=` mean when the URL omits them, or names something
 * `isGearSortKey` refuses. Exported from this module — the closet's vocabulary — rather
 * than written inline in `parseGearQuery`, because PK-70 gave the pair a SECOND reader:
 * `syncFilterFormToUrl` in `src/lib/gear/live-list.ts` has to write the same two values
 * into the filter form's hidden inputs after an in-place sort, and a client bundle cannot
 * import `query.ts` to ask (that module reaches the Supabase client; this one imports a
 * type and nothing else).
 *
 * THE ALTERNATIVE WAS TWO LITERALS IN TWO FILES, and it fails silently in the one direction
 * that matters. Change the default here to `added` and, with the pair duplicated, the server
 * would render a list ordered by date under a form still claiming `name` — the visitor's next
 * keystroke would reorder the list they had not asked to reorder, with nothing thrown and
 * nothing logged. Naming it once makes that a compile-time rename instead.
 */
export const GEAR_DEFAULT_SORT: GearSortKey = 'name';

/** The other half of `GEAR_DEFAULT_SORT`; see there. Ascending, so a closet opens in
 *  A-Z name order rather than in whichever order the rows happen to come back. */
export const GEAR_DEFAULT_DIRECTION: 'asc' | 'desc' = 'asc';

/** Narrows an untrusted `sort` query parameter, mirroring `isGearStatus` above. */
export function isGearSortKey(value: unknown): value is GearSortKey {
  return typeof value === 'string' && (GEAR_SORT_KEYS as readonly string[]).includes(value);
}

/**
 * Maps each public sort key to the real `gear_items` column PostgREST orders by.
 * `weight` sorts by `weight_grams`, which since PK-67 IS the stored weight rather than a
 * generated copy of it: every row is grams, so a plain column sort already compares like
 * with like. There is no raw `weight` column any more, and no row can be "entered in a
 * different unit" from its neighbour — the problem this mapping existed to explain, which
 * `20260817120000_gear_weight_in_grams.sql` removed at the source.
 *
 * `price` sorts by the raw `price` column, and that is a known, accepted limitation
 * rather than an oversight: a pack can hold gear priced in different currencies (see
 * `src/lib/money.ts`'s module comment, "CROSS-CURRENCY SUMMING IS IMPOSSIBLE, NOT
 * MERELY DISCOURAGED" — the same reasoning applies to ordering, not only summing,
 * because there is no exchange rate this product is willing to invent). Sorting by the
 * bare number therefore orders £10 below $15 as "cheaper", which is not a real value
 * ordering when the two rows disagree about currency. There is no canonical-price column
 * this migration could add — canonicalising a price
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
 * `category` (PK-70) sorts by the raw column and needs no such argument of its own — it is
 * nullable exactly the way `brand` is, and `applyGearQuery`'s global `nullsFirst: false`
 * already pins an uncategorised row last in BOTH directions, the same mechanism and the
 * same reasoning as the `brand` paragraph just above, not a second decision.
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
  category: 'category',
  weight: 'weight_grams',
  price: 'price',
  added: 'acquired_on',
};

/**
 * Every labelled column header the closet list renders, in render order, with
 * `key: null` marking one that is not sortable. The Status column is absent because
 * PK-62 removed it — a three-value field an icon beside the name says faster (see
 * `GearStatusIcon.astro`). The Added column is absent for a different reason: PK-64's
 * Notebook Paper conversion found that the closet's 1000px content column cannot hold
 * nine columns without a cell wrapping, and a wrapped cell breaks the ledger's 40px row
 * rhythm for every row below it (DESIGN.md §3). Added was the least-scanned column and
 * its value is already on the item's own page, so it is the one that goes — the header
 * and its `<td>` only. `added` STAYS a valid `?sort=` value: `GEAR_SORT_KEYS` and
 * `GEAR_SORT_COLUMNS` are untouched, so a bookmarked `?sort=added` still orders the list
 * by `acquired_on`, exactly as PK-62 kept `category`/`brand`/weight-range filters working
 * by URL after removing their own UI (see `unsurfacedFilterParams` in query.ts).
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
 * misaligns every row after it. This diff exercised exactly that coupling twice over —
 * removing the Status column meant deleting an entry here AND a cell there, and PK-64
 * removing Added meant the same pair again. Keep them in step by reading; there is no
 * compiler help.
 */
export const GEAR_LIST_COLUMNS: readonly {
  readonly key: GearSortKey | null;
  readonly label: string;
  /**
   * Whether this column holds figures, which decides that its header and its cells are
   * right-aligned (DESIGN.md §7 — "figures are written, and right-aligned").
   *
   * IT IS A FIELD RATHER THAN A PREDICATE OVER THE LABEL, and that is the point. PK-64
   * first wrote it as `label === 'Qty' || label === 'Weight' || label === 'Price'` on the
   * page, which keys a layout decision off display copy: renaming Qty to Quantity would
   * compile, ship, and quietly lose the alignment. It cannot be derived from `key`
   * either — Qty is a figure and is not sortable.
   *
   * Putting it here means a new column cannot be added without answering the question,
   * and puts the answer somewhere a test can reach it: `vitest.config.ts` excludes
   * `src/pages/**`.
   */
  readonly numeric: boolean;
}[] = [
  { key: 'name', label: 'Name', numeric: false },
  { key: 'brand', label: 'Brand', numeric: false },
  { key: 'category', label: 'Category', numeric: false },
  { key: null, label: 'Qty', numeric: true },
  { key: 'weight', label: 'Weight', numeric: true },
  { key: 'price', label: 'Price', numeric: true },
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
