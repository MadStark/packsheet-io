/**
 * The units and weight engine (Ref 23 — "Units and weight engine (pure functions)").
 * `supabase/migrations/20260817120000_gear_weight_in_grams.sql` says it plainly on the
 * `gear_items.weight_grams` column, carrying the sentence forward from the core schema's
 * comment on the `weight` column it replaced: "Conversion and totalling are pure functions
 * in the application (Ref 23), not database concerns." This module, and this module alone,
 * is that promise kept — no I/O, no framework import, no Supabase client, nothing that
 * can fail for a reason other than a bad argument.
 *
 * ---------------------------------------------------------------------------
 * GRAMS IS THE CANONICAL UNIT — IN MEMORY, IN ARITHMETIC, AND AT REST
 * ---------------------------------------------------------------------------
 *
 * Every weight number that exists anywhere downstream of entry — a pack total, a
 * category rollup, a comparison between two items — is a gram figure at full
 * floating-point precision. Unit conversion is an ENTRY AND DISPLAY concern only: a
 * value arrives in the base unit of the account's system, `toGrams` converts it exactly
 * once, and from that point on nothing downstream ever holds, stores, or reasons about a
 * non-gram number. `fromGrams` exists solely to bring a gram figure back out to a
 * human-readable unit at the moment it is rendered.
 *
 * The alternative — carrying the original unit alongside every intermediate value and
 * converting lazily wherever two weights need to be combined — is the more "faithful"
 * design on paper, and it is also the one where a pack total silently sums ounces and
 * kilograms as if they were the same number the first time somebody forgets a
 * conversion at a call site three modules away. Converting once, at the boundary, and
 * carrying grams everywhere after that means there is exactly one place a conversion
 * bug can hide, and this file is that place.
 *
 * THE DATABASE NOW AGREES, AND THIS PARAGRAPH USED TO SAY THE OPPOSITE. Until PK-67 this
 * module argued that grams were canonical "in memory, during arithmetic, never at rest",
 * and pointed at `gear_items.weight` — stored as entered, beside a per-row `weight_unit` —
 * as a deliberate counterweight: the database kept the user's own precision, because a
 * 4.4 oz entry is not "124.7381 g" to anybody who typed 4.4.
 *
 * What made that reasoning work was the per-row unit, and PK-67 removed it. The unit is
 * now one account-level choice (`public.profiles.weight_units`, metric or imperial), so
 * there is no longer a per-row "as entered" unit for the column to be faithful to —
 * keeping one would have recorded which way the account happened to be set on the day
 * each row was written, which describes a preference rather than a fact about the gear.
 * `gear_items.weight_grams` is therefore grams at rest, and the name says so.
 *
 * The 4.4-oz reader is not worse off. They still type 4.4 and still see `4.4 oz`, because
 * `formatWeight` derives the displayed unit from their account setting and the magnitude
 * rather than from a stored string. What is genuinely gone is the ability to distinguish
 * their row from 124.738 g typed by a metric user — two rows that now hold the same
 * number because they describe the same weight, which is the entire point of a closet
 * whose rows can be compared by eye.
 *
 * ---------------------------------------------------------------------------
 * THROW, NOT RETURN, ON NaN, INFINITY AND NEGATIVES
 * ---------------------------------------------------------------------------
 *
 * `gear_items.weight_grams` carries `check (weight_grams >= 0 and weight_grams <
 * 'Infinity'::numeric)` — the constraint PK-67's rename carried across from `weight`
 * unchanged, Postgres having rewritten its expression along with the column — and that
 * column's comment explains why the upper bound is there at all: Postgres
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
 *
 * BOTH HALVES OF THAT CHECK CONSTRAINT, not only the upper one. `weight_grams >= 0` is the
 * half that is easy to skip here because it looks like a data-entry concern the database
 * has already handled — and it has, for `gear_items.weight_grams`. It has NOT handled
 * `pack_items.overrides`, which is constrained only to `jsonb_typeof(overrides) =
 * 'object'` with its contents unconstrained, and which the owner may PATCH on any
 * unlocked pack item through the ordinary Data API. An override of `{"weight": -400}` is
 * therefore an ordinary, reachable value, and a negative gram figure is worse than a NaN
 * one: NaN poisons every total it touches and is at least visible as "NaN" to anything
 * that looks, whereas -400 g subtracts from a pack total, leaves it a perfectly ordinary
 * finite number, and — because the buckets partition and each line lands in exactly one
 * of them — keeps `base + worn + consumable === total` true while every number in the
 * identity is wrong. There is no structural assertion downstream that can catch it. It
 * has to be refused at entry, which is here.
 *
 * THE PRODUCT IS CHECKED AS WELL AS THE ARGUMENT. A conversion can leave the finite
 * range that its own input sat comfortably inside: `toGrams(1e308, 'kg')` is `Infinity`
 * built out of two entirely finite numbers. `numeric(12, 3)` caps a stored weight near
 * 1e9, so this needs an override or a hand-written snapshot to reach — but those are
 * exactly the values this module exists to defend against, being the ones that never
 * went through the database at all. Checking only the argument would let this module
 * MANUFACTURE the poison it was written to keep out, and the resulting `Infinity` is the
 * one value that defeats the totals engine's structural guarantee rather than tripping
 * it: `Infinity === Infinity`, so a pack whose every line is Infinity satisfies
 * `base + worn + consumable === total` and reports green while meaning nothing.
 */

/**
 * The four units a weight can be WRITTEN in, smallest first within each system.
 *
 * These are no longer the values of a database column. Until PK-67 this list mirrored
 * `check (weight_unit in ('g', 'kg', 'oz', 'lb'))` on `gear_items`, and this comment was
 * the only thing keeping two independent files in step; that column is gone, weight is
 * stored in grams, and nothing in the schema now constrains this list. What it pins
 * instead is narrower and entirely internal: `GRAMS_PER_UNIT` must have a factor for
 * every member, which `Record<WeightUnit, number>` enforces at compile time rather than
 * by comment.
 *
 * The ORDER is load-bearing where the spelling used to be. `WEIGHT_SYSTEM_UNITS` below
 * lists each system's units smallest-first and `formatWeight` walks them in that order to
 * pick a scale, so reordering this array silently changes which unit a weight is rendered
 * in.
 */
export const WEIGHT_UNITS = ['g', 'kg', 'oz', 'lb'] as const;

export type WeightUnit = (typeof WEIGHT_UNITS)[number];

/**
 * The narrowing guard that turns a `string` into a `WeightUnit` the compiler will hold
 * everything else in this module to, rather than trusting a value that merely looks
 * plausible. `'G'`, `'lbs'` and `'gram'` are all the kind of near-miss a human types
 * without a picker in front of them, and all three must fail this exactly as a bare typo
 * would.
 *
 * ITS REMAINING CALLERS ARE NARROWER THAN THEY WERE, and worth naming because the obvious
 * ones are gone. Nothing reads a unit off a gear row or a form field any more — there is
 * no such column and no such field. What is left is `src/lib/gear/query.ts`, narrowing the
 * hand-editable `?wunit=` search parameter, which is a string a visitor types into an
 * address bar and therefore exactly the case this was written for.
 */
export function isWeightUnit(value: unknown): value is WeightUnit {
  return typeof value === 'string' && (WEIGHT_UNITS as readonly string[]).includes(value);
}

/**
 * The two systems an account can think in — the whole of `public.profiles.weight_units`,
 * mirroring `check (weight_units in ('metric', 'imperial'))` in
 * `supabase/migrations/20260817000000_user_profiles.sql`. Independent files with no shared
 * import, so this comment is the enforcement, exactly as the one above `WEIGHT_UNITS` used
 * to be for the column PK-67 deleted: add a third system here and that CHECK constraint
 * has to move with it, and vice versa.
 */
export const WEIGHT_SYSTEMS = ['metric', 'imperial'] as const;

export type WeightSystem = (typeof WEIGHT_SYSTEMS)[number];

/**
 * Narrows the `string` the generated row type gives `profiles.weight_units` into a
 * `WeightSystem`. The same gap `isWeightUnit` exists for, and reachable for the same
 * reason: the CHECK constraint holds on write but is not proven to still hold by the time
 * a row is read back through a client that types the column as a bare `string`.
 */
export function isWeightSystem(value: unknown): value is WeightSystem {
  return typeof value === 'string' && (WEIGHT_SYSTEMS as readonly string[]).includes(value);
}

/**
 * What a missing `profiles` row means. Named here rather than written as a bare
 * `'metric'` at each of the handful of call sites that need it, because "no row yet" is
 * the ordinary state of every account that has never opened the account page — see the
 * profiles migration's "A MISSING ROW MEANS THE DEFAULT" section — and it must agree with
 * that column's own `default 'metric'` or the two disagree for exactly the users who have
 * saved nothing.
 */
export const DEFAULT_WEIGHT_SYSTEM: WeightSystem = 'metric';

/**
 * Each system's units, SMALLEST FIRST. `formatWeight` walks these in order and stops at
 * the last unit whose threshold the weight clears, so the order is the scaling rule rather
 * than presentation.
 *
 * Two entries each, not four. A metric reader is shown grams or kilograms and never
 * ounces; that is the entire content of the account setting, and mixing systems in one
 * list would reintroduce the `4.4 oz` beside `120 g` comparison problem PK-67 exists to
 * remove. Milligrams and stones are deliberately absent: neither is a unit backpacking
 * gear is weighed in, and adding one means adding a `GRAMS_PER_UNIT` factor and a
 * threshold together.
 */
export const WEIGHT_SYSTEM_UNITS: Readonly<Record<WeightSystem, readonly WeightUnit[]>> = {
  metric: ['g', 'kg'],
  imperial: ['oz', 'lb'],
};

/**
 * The unit a weight is ENTERED in for each system — always the smaller of the two, so
 * there is no magnitude guessing on the way in and the form needs no unit control at all.
 *
 * Derived from `WEIGHT_SYSTEM_UNITS` rather than written out a second time. Two literal
 * maps holding `'g'`/`'oz'` in one and `['g', 'kg']`/`['oz', 'lb']` in the other are two
 * statements of one fact, and the way they drift is that somebody reorders the arrays
 * above for the scaling rule and the entry unit silently stays behind.
 *
 * The consequence, which PK-67 calls out so it is not later filed as a bug: editing an
 * item the closet lists as `1.85 kg` opens its form with `1850` in the weight field and a
 * `g` suffix. Entry is in the base unit; only display scales.
 */
export const WEIGHT_ENTRY_UNIT: Readonly<Record<WeightSystem, WeightUnit>> = {
  metric: WEIGHT_SYSTEM_UNITS.metric[0],
  imperial: WEIGHT_SYSTEM_UNITS.imperial[0],
};

/**
 * How each system is named to a visitor, on the one control that picks between them.
 *
 * THE UNITS ARE IN THE LABEL ON PURPOSE. "Metric" and "Imperial" alone are the names of
 * the systems, not an answer to the question the visitor is actually asking, which is
 * "what will my closet look like" — and a reader who thinks in ounces should not have to
 * know that "imperial" is the word this product filed them under. Naming both units each
 * system will actually render makes the control self-describing, and it is the whole of
 * what changes on screen.
 *
 * `Record<WeightSystem, string>`, like `GEAR_STATUS_LABELS` in `gear/fields.ts`: a third
 * system stops this compiling until somebody writes its label, rather than rendering a
 * bare `'…'` nobody notices.
 */
export const WEIGHT_SYSTEM_LABELS: Readonly<Record<WeightSystem, string>> = {
  metric: 'Metric (g · kg)',
  imperial: 'Imperial (oz · lb)',
};

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
 * `gear_items.weight_grams` is `numeric(12, 3)`: at most three decimal places, of a gram.
 * Named here, once, rather than left as a bare `3` scattered across every rounding call
 * site — the next person touching this file should be able to change the column's scale
 * and grep for exactly one place that needs to agree with it.
 *
 * Since PK-67 this is unambiguously three decimals OF A GRAM rather than of whatever unit
 * a row happened to be entered in, which makes it a stricter bound than it used to be:
 * 0.001 g is finer than 0.001 of any imperial unit, so nothing entered in ounces or pounds
 * loses precision by being stored in grams. That is why the migration keeps `numeric(12, 3)`
 * rather than widening the scale.
 */
export const WEIGHT_DECIMALS = 3;

const WEIGHT_ROUNDING_FACTOR = 10 ** WEIGHT_DECIMALS;

/**
 * The two things a number has to be to mean anything as a weight, mirroring
 * `gear_items.weight_grams`'s own `check (weight_grams >= 0 and weight_grams <
 * 'Infinity'::numeric)` clause for clause — see "THROW, NOT RETURN" above for why either
 * failure is treated as a defect at the boundary rather than quietly repaired or passed
 * through.
 *
 * `Number.isFinite` covers the constraint's upper half on its own: it is `false` for
 * `NaN` and for both signed infinities, so one check does the work of two — and the
 * NaN case is the reason the constraint needs an upper bound at all, since Postgres
 * orders NaN above every numeric value and `'NaN'::numeric >= 0` is TRUE.
 *
 * The two are separate `if`s with separate messages rather than one combined
 * condition, because `-400` and `NaN` are different mistakes made by different people:
 * one is a value somebody typed or computed with a sign error, the other is a parse or
 * a division that failed upstream and never announced itself. A single "invalid weight"
 * message would make the reader work out which they were looking at.
 */
function assertWeight(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${label} must be a finite number, got ${value}`);
  }
  if (value < 0) {
    throw new RangeError(`${label} must not be negative, got ${value}`);
  }
}

/**
 * Converts a value entered in `unit` into grams — the one conversion every weight in
 * this product passes through exactly once, at entry. See the module comment for why
 * nothing downstream of this call ever holds a non-gram number.
 *
 * The RESULT is asserted as well as the argument, and the second call is not
 * redundant: multiplying a finite value by a finite factor can still overflow to
 * `Infinity` (`1e308 * 1000`), which would hand a caller the exact value this module
 * exists to keep out of a total — see "THE PRODUCT IS CHECKED AS WELL AS THE ARGUMENT"
 * in the module comment. Sign cannot change under a positive factor, so it is only the
 * finiteness half that this second call can actually catch; it goes through the same
 * helper anyway rather than a bare `Number.isFinite`, so a fifth unit with a negative
 * or zero factor could not quietly make that reasoning false.
 */
export function toGrams(value: number, unit: WeightUnit): number {
  assertWeight(value, 'value');
  const grams = value * GRAMS_PER_UNIT[unit];
  assertWeight(grams, `${value} ${unit} converted to grams`);
  return grams;
}

/**
 * Converts a canonical gram figure back out to `unit` for entry or display. The
 * inverse of `toGrams`, and the ONLY place a gram figure is allowed to stop being one
 * — never a silent side effect of some other computation.
 *
 * The result is asserted for the same reason as in `toGrams`, and here the check is
 * genuinely unreachable TODAY rather than merely hard to reach: every factor in
 * `GRAMS_PER_UNIT` is at least 1, so dividing a finite gram figure by one of them can
 * only move it towards zero. It is written anyway because that is a property of the
 * table's current contents, not of this function — a sub-gram unit (`mg`, at 0.001)
 * would make this division the overflow path the multiplication is in `toGrams`, and
 * the person adding that row should not also have to notice this line was missing.
 */
export function fromGrams(grams: number, unit: WeightUnit): number {
  assertWeight(grams, 'grams');
  const value = grams / GRAMS_PER_UNIT[unit];
  assertWeight(value, `${grams} g converted to ${unit}`);
  return value;
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
 *
 * IT ROUNDS WHATEVER UNIT IT IS HANDED, and since PK-67 the unit that matters is grams.
 * `numeric(12, 3)` is now three decimals OF A GRAM — `gear_items.weight_grams` is
 * canonicalised at rest (see "GRAMS IS THE CANONICAL UNIT") — so `roundWeight(grams)` is
 * the call that reproduces what the database stores, and it is the strictest of the four:
 * 0.001 g is finer than 0.001 of any other unit in `GRAMS_PER_UNIT`, so a value that
 * survives this round-trip in grams survives it in every unit.
 *
 * This reverses the guidance that used to live here. While weight was stored as entered,
 * the column's scale applied to whatever unit the row was in, and a caller reproducing the
 * stored value had to round in THAT unit — `roundWeight(fromGrams(grams, unit))`. There is
 * no longer an entered unit for that ordering to be about. The function still rounds
 * whatever it is handed, and a caller rounding a converted figure for display
 * (`roundWeight(fromGrams(grams, 'lb'))`) is rounding pounds to three places for
 * presentation, which is a display decision of its own and no longer a claim about the
 * column.
 */
export function roundWeight(value: number): number {
  assertWeight(value, 'value');
  return Math.round(value * WEIGHT_ROUNDING_FACTOR) / WEIGHT_ROUNDING_FACTOR;
}

/**
 * How many decimal places each unit is SHOWN to. Display precision, and deliberately not
 * `WEIGHT_DECIMALS` — that is the column's scale, a storage fact, and three decimals of a
 * kilogram on a closet list is `1.850 kg`, which is noise pretending to be precision.
 *
 * The four numbers are chosen so that one step of the last shown digit is roughly a gram
 * in every unit: 1 g exactly, 0.01 kg is 10 g, 0.1 oz is 2.8 g, 0.01 lb is 4.5 g. A gear
 * list is compared by eye, and a column where one row resolves to the gram and the next to
 * ten grams reads as though the finer row were measured more carefully.
 */
const WEIGHT_DISPLAY_DECIMALS: Readonly<Record<WeightUnit, number>> = {
  g: 0,
  kg: 2,
  oz: 1,
  lb: 2,
};

/**
 * The unit a gram figure should be SHOWN in for an account's system: the largest unit of
 * that system the weight fills at least one of.
 *
 * THE THRESHOLD IS THE FACTOR, which is why there is no table of thresholds here. "Show
 * kg at or above 1000 g" and "show lb at or above 453.59237 g" are both just "at or above
 * one of the larger unit", and one of the larger unit is exactly its entry in
 * `GRAMS_PER_UNIT`. Writing the thresholds out separately would be a second copy of the
 * conversion factors — the precise duplication `convertWeight` declines to make for
 * cross-unit conversion, and the one where `453.59` instead of `453.59237` would put the
 * boundary in the wrong place for weights within a rounding error of exactly one pound.
 *
 * Walks `WEIGHT_SYSTEM_UNITS` smallest-first and keeps the last unit that fits, so adding
 * a third unit to a system needs a `GRAMS_PER_UNIT` factor and a place in that array and
 * nothing here.
 */
function displayUnit(grams: number, system: WeightSystem): WeightUnit {
  let chosen = WEIGHT_SYSTEM_UNITS[system][0];
  for (const unit of WEIGHT_SYSTEM_UNITS[system]) {
    if (grams >= GRAMS_PER_UNIT[unit]) chosen = unit;
  }
  return chosen;
}

/**
 * Renders a canonical gram figure as the string a visitor reads, scaled to their account's
 * system: `1850` is `'1.85 kg'` under metric and `'4.08 lb'` under imperial, and `124.738`
 * is `'125 g'` or `'4.4 oz'`.
 *
 * WHY THIS EXISTS AT ALL, since `src/lib/gear/format.ts` argued the opposite. That module
 * said weight got no formatter because `` `${item.weight} ${item.weight_unit}` `` "has no
 * decision in it for a function to make". That was true of a row that stored its own unit
 * and was rendered as entered. It is false now: choosing between `g` and `kg` from the
 * magnitude, and between metric and imperial from the account, are two real decisions, and
 * a branch written in Astro frontmatter is a branch `vitest.config.ts:64` excludes from the
 * test suite. So the reasoning inverts and the function lands here rather than there —
 * in `units.ts` specifically, because everything it needs (`GRAMS_PER_UNIT`, the system
 * vocabulary, `fromGrams`) already lives here and splitting unit knowledge across two
 * files is what this module's own comment exists to prevent.
 *
 * TRAILING ZEROS ARE TRIMMED, so 2 kg is `'2 kg'` and not `'2.00 kg'`, and 4.4 lb is
 * `'4.4 lb'` and not `'4.40 lb'`. `toFixed` is what does the rounding — it is the only
 * option here that rounds and formats in one step without reintroducing floating-point
 * error between the two — and the trim afterwards is a string operation on a string
 * `toFixed` has already made well-formed, so it cannot produce `'2.'` or eat a significant
 * digit.
 *
 * IT THROWS on a negative or non-finite input rather than rendering a placeholder, which
 * is the opposite of what `formatGearPrice` does for a malformed currency and is a
 * deliberate difference rather than an inconsistency. That function degrades because its
 * input is a `text` column whose CHECK constraint is not proven to still hold by the time a
 * row is read back, so a single bad row would otherwise crash a list that is rendering
 * fine. This function's input is `numeric not null check (weight_grams >= 0 and
 * weight_grams < 'Infinity')` — a bad value cannot arrive from the column, and one that
 * arrives from anywhere else is the in-memory defect the "THROW, NOT RETURN" section above
 * exists to stop, at the boundary, loudly. Rendering `'—'` for it would hide a poisoned
 * number in a list of honest ones.
 *
 * THE ROUNDING BOUNDARY IS NOT SMOOTHED, and it is worth naming so it is not read as an
 * oversight: 999.6 g under metric is below the 1000 g threshold, so it is shown in grams,
 * and rounding to whole grams then renders it `'1000 g'` rather than `'1 kg'`. The rule
 * PK-67 specifies is a threshold on the stored figure, and applying it before rounding is
 * the reading that keeps `displayUnit` a pure function of the weight. Re-scaling after
 * rounding would make the chosen unit depend on the display precision of the unit not yet
 * chosen, which is a loop worth more than the one gram of tidiness it buys.
 */
export function formatWeight(grams: number, system: WeightSystem): string {
  assertWeight(grams, 'grams');
  const unit = displayUnit(grams, system);
  const value = fromGrams(grams, unit).toFixed(WEIGHT_DISPLAY_DECIMALS[unit]);
  // Only touches a string that has a decimal point, so an integer rendering like '1000'
  // is returned untouched rather than having its trailing zeros stripped to '1'.
  const trimmed = value.includes('.') ? value.replace(/\.?0+$/, '') : value;
  return `${trimmed} ${unit}`;
}
