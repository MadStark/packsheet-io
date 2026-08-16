/**
 * Pure display formatting for the closet list (PK-4) that is not already covered by
 * `src/lib/money.ts` or `src/lib/units.ts` on its own — specifically, what to show for
 * a `gear_items` row's price, which is nullable and, per `src/lib/money.ts`'s own
 * `isCurrencyCode`, only shape-validated on write, never guaranteed to still be a real
 * `CurrencyCode` by the time it is read back through a bare `string | null` client.
 *
 * WHY THIS LIVES IN src/lib/ RATHER THAN IN THE PAGE. Same reasoning as the rest of
 * this directory: `vitest.config.ts:64` excludes `src/pages/`, and "what does a
 * visitor see for a row whose price or currency is missing or malformed" is exactly
 * the kind of branch that is easy to get wrong silently in frontmatter and impossible
 * to pin with a test there.
 *
 * Weight is deliberately NOT given a formatter here. `gear_items.weight` is rendered
 * "as entered, with its unit" per the ticket — never converted, never re-derived —
 * which is simply `` `${item.weight} ${item.weight_unit}` `` with no decision in it
 * for a function to make; adding one here would be a wrapper with nothing behind it,
 * the same reason `src/lib/gear/options.ts` does not wrap its own options query.
 */

import { formatMoney, fromDecimal, isCurrencyCode } from '../money';
import { GEAR_STATUS_LABELS, isGearStatus } from './fields';

/** Shown for a row with no price at all, or with a price this module refuses to
 *  render — see `formatGearPrice` for both cases. An em dash rather than "N/A" or a
 *  blank cell: it reads as "nothing here" in a numeric column without implying an
 *  error, the same role it plays in the rest of this product's tables. */
const NO_PRICE_LABEL = '—';

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
  if (price === null || currency === null) return NO_PRICE_LABEL;
  if (!isCurrencyCode(currency)) return NO_PRICE_LABEL;
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
