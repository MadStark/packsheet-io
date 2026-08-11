/**
 * The units and weight engine (Ref 23 — "Units and weight engine (pure functions)").
 * `supabase/migrations/20260810120000_core_schema.sql` says it plainly on the
 * `gear_items.weight` column: "Conversion and totalling are pure functions in the
 * application (Ref 23), not database concerns." This module, and this module alone,
 * is that promise kept — no I/O, no framework import, no Supabase client, nothing that
 * can fail for a reason other than a bad argument.
 *
 * ---------------------------------------------------------------------------
 * GRAMS IS THE CANONICAL UNIT
 * ---------------------------------------------------------------------------
 *
 * Every weight number that exists anywhere downstream of entry — a pack total, a
 * category rollup, a comparison between two items — is a gram figure at full
 * floating-point precision. Unit conversion is an ENTRY AND DISPLAY concern only: a
 * value arrives in whatever unit the user chose, `toGrams` converts it exactly once,
 * and from that point on nothing downstream ever holds, stores, or reasons about a
 * non-gram number. `fromGrams` exists solely to bring a gram figure back out to a
 * human-chosen unit at the moment it is rendered.
 *
 * The alternative — carrying the original unit alongside every intermediate value and
 * converting lazily wherever two weights need to be combined — is the more "faithful"
 * design on paper, and it is also the one where a pack total silently sums ounces and
 * kilograms as if they were the same number the first time somebody forgets a
 * conversion at a call site three modules away. Converting once, at the boundary, and
 * carrying grams everywhere after that means there is exactly one place a conversion
 * bug can hide, and this file is that place.
 *
 * This is deliberately the OPPOSITE choice from `gear_items.weight` itself, which is
 * stored as entered rather than canonicalised — see that column's migration comment.
 * The two are not in tension: the database keeps the user's own precision at rest (a
 * 4.4 oz entry is not "124.7381 g" to anybody who typed 4.4), while this module keeps
 * every computation that combines more than one weight honest. Grams are canonical in
 * memory, during arithmetic, never at rest.
 *
 * ---------------------------------------------------------------------------
 * THROW, NOT RETURN, ON NaN AND INFINITY
 * ---------------------------------------------------------------------------
 *
 * `gear_items.weight` carries `check (weight >= 0 and weight < 'Infinity'::numeric)`,
 * and that column's comment explains why the upper bound is there at all: Postgres
 * orders NaN ABOVE every other numeric value, so a plain `>= 0` check alone lets NaN
 * straight through the Data API, and one NaN poisons every total that touches it
 * afterwards, invisibly, because NaN prints as "NaN" only if something remembers to
 * check for it. That defence covers values that go through the database. It does
 * nothing for a value computed in memory and handed straight to this module — a form
 * field parsed with a stray `parseFloat('')`, a division that overflowed, a total
 * computed from a total that was already wrong.
 *
 * This module is the other half of that defence, and it chooses to THROW rather than
 * to return a sentinel or silently coerce. The alternative considered was to mirror
 * `safeNextPath`'s style (src/lib/auth-routes.ts) and fall back to some default — but
 * `safeNextPath` falls back because "no value" is the everyday, expected case for a
 * visitor who never set `?next=`, and any same-origin path is as good as any other for
 * routing purposes. There is no equivalent safe default for a weight: 0 g is not a
 * conservative stand-in for "unknown", it is a specific and wrong claim about how much
 * something weighs, and it would sum into a pack total looking exactly as valid as
 * every honest figure next to it. A bad weight has to stop the computation that
 * produced it, loudly, at the point where it first becomes a weight — which is here.
 */

/**
 * The four units `gear_items.weight_unit` accepts, in the exact order and spelling of
 * the CHECK constraint in `supabase/migrations/20260810120000_core_schema.sql`:
 * `check (weight_unit in ('g', 'kg', 'oz', 'lb'))`. The two sides are independent
 * files with no shared import, so nothing enforces them staying in step — this
 * comment is that enforcement. If a fifth unit is ever added here, the migration's
 * CHECK constraint (and any row already written under the old one) has to move with
 * it, and vice versa.
 */
export const WEIGHT_UNITS = ['g', 'kg', 'oz', 'lb'] as const;

export type WeightUnit = (typeof WEIGHT_UNITS)[number];

/**
 * `weight_unit` arrives from the database — and from any form field before it ever
 * reaches the database — typed merely as `string`. This is the narrowing guard that
 * turns that string into a `WeightUnit` the compiler will hold everything else in this
 * module to, rather than trusting a value that merely looks plausible. `'G'`, `'lbs'`
 * and `'gram'` are all the kind of near-miss a human types without a picker in front
 * of them, and all three must fail this exactly as a bare typo would.
 */
export function isWeightUnit(value: unknown): value is WeightUnit {
  return typeof value === 'string' && (WEIGHT_UNITS as readonly string[]).includes(value);
}

/**
 * Grams per unit, i.e. how many grams one of each unit is worth. `g` and `kg` are
 * decimal by definition and need no comment; `oz` and `lb` are not approximations —
 * they are the EXACT decimal values fixed by the 1959 international yard-and-pound
 * agreement, which defined the international pound as precisely 0.45359237 kilograms
 * and the international avoirdupois ounce as exactly 1/16 of that. Write them to fewer
 * digits — `28.35`, say — and every imperial total in the product is wrong by a small
 * but entirely avoidable amount, silently, because the shortened constant still looks
 * right at a glance. Do not "tidy" these.
 */
export const GRAMS_PER_UNIT: Readonly<Record<WeightUnit, number>> = {
  g: 1,
  kg: 1000,
  oz: 28.349523125,
  lb: 453.59237,
};

/**
 * `gear_items.weight` is `numeric(12, 3)`: at most three decimal places, in whatever
 * unit was entered. Named here, once, rather than left as a bare `3` scattered across
 * every rounding call site — the next person touching this file should be able to
 * change the column's scale and grep for exactly one place that needs to agree with it.
 */
export const WEIGHT_DECIMALS = 3;

const WEIGHT_ROUNDING_FACTOR = 10 ** WEIGHT_DECIMALS;

/**
 * A value that is not a finite number cannot mean anything as a weight — see "THROW,
 * NOT RETURN" above for why that is treated as a defect at the boundary rather than
 * quietly repaired or passed through. `Number.isFinite` alone covers both guard rails
 * this module promises: it is `false` for `NaN` and for both signed infinities, so one
 * check does the work of two.
 */
function assertFiniteWeight(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${label} must be a finite number, got ${value}`);
  }
}

/**
 * Converts a value entered in `unit` into grams — the one conversion every weight in
 * this product passes through exactly once, at entry. See the module comment for why
 * nothing downstream of this call ever holds a non-gram number.
 */
export function toGrams(value: number, unit: WeightUnit): number {
  assertFiniteWeight(value, 'value');
  return value * GRAMS_PER_UNIT[unit];
}

/**
 * Converts a canonical gram figure back out to `unit` for entry or display. The
 * inverse of `toGrams`, and the ONLY place a gram figure is allowed to stop being one
 * — never a silent side effect of some other computation.
 */
export function fromGrams(grams: number, unit: WeightUnit): number {
  assertFiniteWeight(grams, 'grams');
  return grams / GRAMS_PER_UNIT[unit];
}

/**
 * Converts a value directly from one unit to another via grams, for the entry-form
 * case where a user switches their preferred unit and the figure they typed has to
 * follow them. Deliberately just `fromGrams(toGrams(...))` rather than a hand-derived
 * `from`-to-`to` factor table: a 4×4 table of cross-factors is sixteen numbers that
 * could individually drift from `GRAMS_PER_UNIT`, where this has exactly four numbers
 * to be right, and going via grams is the same trip every other consumer of a weight
 * already takes.
 */
export function convertWeight(value: number, from: WeightUnit, to: WeightUnit): number {
  return fromGrams(toGrams(value, from), to);
}

/**
 * Rounds to `WEIGHT_DECIMALS` places — the precision `numeric(12, 3)` can actually
 * store. Converting between units and back is not bit-exact in floating point (dividing
 * by `28.349523125` and multiplying back by it does not perfectly undo itself), so this
 * is the helper the round-trip guarantee needs: a value entered, converted for display
 * in another unit, and converted back must reproduce what the database would have
 * stored, not merely something close to it at the seventeenth decimal digit.
 */
export function roundWeight(value: number): number {
  assertFiniteWeight(value, 'value');
  return Math.round(value * WEIGHT_ROUNDING_FACTOR) / WEIGHT_ROUNDING_FACTOR;
}
