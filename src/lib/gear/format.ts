/**
 * Pure display formatting for the closet list (PK-4) that is not already covered by
 * `src/lib/money.ts` or `src/lib/units.ts` on its own — what to show for a `gear_items`
 * row's price, which is nullable and, per `src/lib/money.ts`'s own `isCurrencyCode`,
 * only shape-validated on write and never guaranteed to still be a real `CurrencyCode`
 * by the time it is read back through a bare `string | null` client; for its `status`;
 * and, since PK-61, for its `acquired_on`, a nullable date whose absence is an ordinary
 * value ("I don't know") rather than a data problem.
 *
 * WHY THIS LIVES IN src/lib/ RATHER THAN IN THE PAGE. Same reasoning as the rest of
 * this directory: `vitest.config.ts:64` excludes `src/pages/`, and "what does a
 * visitor see for a row whose price or currency is missing or malformed" is exactly
 * the kind of branch that is easy to get wrong silently in frontmatter and impossible
 * to pin with a test there.
 *
 * WEIGHT HAS A FORMATTER SINCE PK-67, AND IT IS NOT HERE — it is `formatWeight` in
 * `src/lib/units.ts`. This comment used to argue that weight got no formatter at all,
 * because `gear_items.weight` was rendered "as entered, with its unit" — never converted,
 * never re-derived — which was simply `` `${item.weight} ${item.weight_unit}` `` with no
 * decision in it for a function to make.
 *
 * Both halves of that stopped being true at once. There is no per-row unit to render
 * beside the number, and the stored figure is grams, so rendering a closet row now means
 * choosing a unit from the account's system and a scale from the magnitude — `1850` is
 * `1.85 kg` to one visitor and `4.08 lb` to another. Those are real decisions, which is
 * exactly the test this module applies to `formatGearAcquiredOn` below.
 *
 * It lives in `units.ts` rather than in this file because everything it needs is already
 * there — the conversion factors, the system vocabulary, `fromGrams` — and that module's
 * own comment exists to keep unit knowledge in one place. A wrapper here would put half a
 * unit decision in a second file, which is the drift this directory's comments keep
 * warning about.
 */

import { formatMoney, fromDecimal, isCurrencyCode } from '../money';
import { GEAR_STATUS_LABELS, isGearStatus, type GearStatus } from './fields';

/** Shown wherever a closet-list cell has nothing to render: a row with no price at all
 *  or with a price this module refuses to render (see `formatGearPrice` for both), and
 *  a row with no `acquired_on` (see `formatGearAcquiredOn`). An em dash rather than
 *  "N/A", "Unknown" or a blank cell: it reads as "nothing here" without implying an
 *  error or a missing-data problem the visitor is expected to go and fix, and it is the
 *  same mark this role plays in the rest of this product's tables.
 *
 *  ONE constant rather than one per column, deliberately. PK-61 briefly had a second
 *  constant holding the identical em dash for the date column, with a comment
 *  cross-referencing this one — two names for a single decision, which is how the two
 *  quietly drift apart later when somebody changes "the empty-cell mark" and finds only
 *  one of them. How this table renders absence is a single product decision, so it is
 *  spelled once and named for the idea rather than for either column. */
const NO_VALUE_LABEL = '—';

/**
 * Renders a `gear_items` row's `price`/`currency` pair for the closet list, reusing
 * `fromDecimal` and `formatMoney` rather than re-deriving what a minor-unit scale or a
 * currency symbol is — see those functions' own module comment for why hand-rolling
 * either here would risk the exact 100x error they exist to prevent.
 *
 * THREE WAYS THIS RETURNS THE NO-PRICE LABEL RATHER THAN THROWING, and each is a real,
 * reachable case rather than defensive paranoia:
 *
 *   - `price === null`: `gear_items_price_has_currency` guarantees `currency` is then
 *     also `null` — this is the ordinary "no price set" row, not a data problem.
 *   - `currency === null` with a non-null `price`: the same constraint says this
 *     cannot happen for a row read straight from the table, but `GearItemInput` types
 *     the pair independently and a future caller could construct this module's input
 *     from some other source; the fallback is the safe answer for either case rather
 *     than assuming the constraint's back.
 *   - `currency` is non-null but not shape-valid per `isCurrencyCode` (mirrors
 *     `gear_items.currency check (currency ~ '^[A-Z]{3}$')`): not reachable through
 *     this product's own write path today, but a row written directly against
 *     PostgREST with a malformed value is not something the CHECK constraint would
 *     have refused to fix later — `fromDecimal`'s own `currencyFormat` call would
 *     otherwise be handed a string `Intl.NumberFormat` was never promised to accept
 *     cleanly. Refusing it here, rather than letting it reach `fromDecimal`, keeps a
 *     single malformed row from taking down the whole list render.
 */
export function formatGearPrice(price: number | null, currency: string | null): string {
  if (price === null || currency === null) return NO_VALUE_LABEL;
  if (!isCurrencyCode(currency)) return NO_VALUE_LABEL;
  return formatMoney(fromDecimal(price, currency));
}

/**
 * Renders a `gear_items` row's `status` as the human label `GEAR_STATUS_LABELS`
 * defines, mirroring `formatGearPrice`'s own defensive shape: `status` arrives from
 * the database typed merely as `string`, backed today by
 * `check (status in ('owned', 'wishlist', 'retired'))` but not proven to still satisfy
 * it by the time a row is read back — the same gap `isGearStatus` exists to guard on
 * the write path. A value this function does not recognise falls back to the raw
 * string rather than throwing or rendering nothing, the same choice `formatMoney`
 * makes for a well-formed-but-unrecognised `'ZZZ'` currency code (see that module's
 * own "WELL-FORMED BUT NOT REAL" section): an honest, debuggable label beats a crashed
 * row in a list that is otherwise rendering fine.
 */
export function formatGearStatus(status: string): string {
  return isGearStatus(status) ? GEAR_STATUS_LABELS[status] : status;
}

/** The glyphs `GearStatusIcon.astro` can draw. `null` is a real answer, not a failure:
 *  it means "this status is drawn by drawing nothing". */
export type GearStatusMarker = 'wishlist' | 'retired';

/**
 * WHICH STATUSES GET A GLYPH, as an exhaustive map rather than a pair of `===` checks.
 *
 * `Record<GearStatus, ...>` is the enforcement: add a fourth value to `GEAR_STATUSES`
 * and this stops compiling until somebody decides whether it has an icon. The two
 * equality checks this replaced were in `GearStatusIcon.astro`, where a fourth status
 * would simply have rendered nothing — silently, with no compile error, and looking
 * exactly like `owned`. Every other part of the status vocabulary (`GEAR_STATUS_LABELS`,
 * `GEAR_SORT_COLUMNS`) is already total in the same way; this was the one gap.
 */
const GEAR_STATUS_MARKERS: Record<GearStatus, GearStatusMarker | null> = {
  // The unmarked default. PK-62's whole argument for dropping the Status column is that
  // marking the overwhelmingly common case says nothing — see GearStatusIcon.astro for
  // why the ragged left edge this produces is accepted rather than padded away.
  owned: null,
  wishlist: 'wishlist',
  retired: 'retired',
};

/**
 * PK-70 REMOVED THE ROW TREATMENT THIS FILE USED TO NAME HERE. Up to PK-64, a marked row
 * additionally got a 5.5% wash of its state's colour and a 3px bar at its left edge
 * (DESIGN.md §7), driven by a `Record<GearStatusMarker, string>` this file exported as
 * `GEAR_MARKER_ROW_CLASS`, mapping each marker to its own row-wash class name. PK-70
 * removes the coloured rail down the left of every row without replacing it with anything
 * of this file's own: what still carries a non-owned status is the icon `gearStatusMarker`
 * resolves below, plus a strike drawn on a retired item's own name. Neither of those needs
 * a mapping in `src/lib/gear/` any more than the icon itself did — they are rendering
 * choices `src/pages/gear/index.astro` makes off the same `gearStatusMarker` return value
 * this file already produced, not a second decision this module has to keep total.
 */

/**
 * The glyph (if any) for a `gear_items` row's status. Takes the widened `string` the
 * database client hands back, for exactly the reason `formatGearStatus` above does:
 * `status` is typed `string` on the generated row type and the CHECK constraint backing
 * it is not proven to still hold by the time a row is read back.
 *
 * AN UNRECOGNISED VALUE DRAWS NOTHING, which is deliberately the SAME answer as `owned`
 * — there is no honest glyph for a value this product has never heard of, and inventing
 * a defect badge would put one on a row whose only fault is having been written straight
 * against PostgREST. That does mean the two are visually indistinguishable, so the
 * closet list pairs this with a screen-reader-only rendering of the raw value for
 * anything `isGearStatus` rejects (`src/pages/gear/index.astro`) — and that pairing is
 * now the ONLY place such a value surfaces at all. When PK-62 removed the Status column
 * there was still one other per-row `formatGearStatus` call, on the trash page; PK-60
 * then deleted that page along with the soft delete, so nothing else renders a stored
 * status as text. Remove the sr-only span and a malformed status becomes invisible
 * everywhere, not merely everywhere obvious.
 */
export function gearStatusMarker(status: string): GearStatusMarker | null {
  return isGearStatus(status) ? GEAR_STATUS_MARKERS[status] : null;
}

/**
 * Renders a `gear_items` row's `acquired_on` for the closet list: the date string as-is
 * when present, `NO_VALUE_LABEL` when `null`. `acquired_on` is a nullable `date` column
 * with no database default (PK-61) — the visitor's own claim about when they got the
 * item, not a fact this product derives — so `null` is an ordinary, expected value here
 * ("I don't know"), not a data problem to guard against the way `formatGearPrice`'s
 * currency-shape checks do.
 *
 * WHY THIS TINY FUNCTION LIVES IN src/lib/ RATHER THAN INLINE IN THE PAGE. Same
 * reasoning as this module's own top comment gives for `formatGearPrice`:
 * `vitest.config.ts:64` excludes `src/pages/`, so a branch written in frontmatter is
 * code no test in this repository can reach. "What does a visitor see when there is no
 * date" IS a decision: it could have been a blank cell, "N/A", or "Unknown", and this
 * module picks the em dash deliberately, the same choice `formatGearPrice` makes for its
 * own no-value case.
 *
 * This paragraph used to contrast the date with `weight`, as the field that needed no
 * formatter because printing it beside its stored unit had no decision in it. PK-67 made
 * that contrast false — see this module's own top comment — so the example is gone rather
 * than left standing as the one claim here a reader could check and find wrong.
 */
export function formatGearAcquiredOn(acquiredOn: string | null): string {
  return acquiredOn === null ? NO_VALUE_LABEL : acquiredOn;
}
