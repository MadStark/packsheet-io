/**
 * The pack totals engine (Ref 23 — "Units and weight engine (pure functions)"), the third
 * and last file of that engine. `src/lib/units.ts` converts, `src/lib/money.ts`
 * denominates, and this file is the only place in the product where two weights are ever
 * added together. Read those two module comments first: everything they establish holds
 * here unchanged and is deliberately not restated — pure functions only, no I/O, no
 * framework import, no Supabase client, nothing that can fail for a reason other than a
 * bad argument.
 *
 * One import rule is worth spelling out because it bites a module that contains no auth
 * code at all: nothing here may import from `src/lib/auth/`. Invariant A in
 * tests/anonymous-read-path.test.ts is an EDGE rule — it does not look at what a module
 * contains, only at whether something outside the choke point has an import edge into it
 * — and this engine will be imported by the public share page, the most-visited anonymous
 * surface in the product. See the doc comment at the top of `src/lib/auth-routes.ts`,
 * which exists for exactly this reason. Constants, types and arithmetic only.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT THIS MODULE EXISTS TO NOT HAVE
 * ---------------------------------------------------------------------------
 *
 * LighterPack's worn-weight subtotal ignores quantity — nine years and counting. Every
 * bucket below multiplies by quantity, with no exceptions, and
 * tests/worn-weight-quantity.test.ts is the regression guard that says so in its own
 * file so it cannot be diluted into a general totals suite and quietly deleted. That file
 * carries the full story, including the original line of JavaScript and the two issue
 * numbers it was reported under. Read it before changing anything below that touches
 * `quantity`.
 *
 * ---------------------------------------------------------------------------
 * THREE BUCKETS THAT PARTITION, AND AN ITEM IN TWO OF THEM IS REFUSED
 * ---------------------------------------------------------------------------
 *
 * Base, worn and consumable are a partition of the pack: every item is in exactly one,
 * and the three add up to the whole. `pack_items.worn` and `pack_items.consumable` are
 * two independent booleans in
 * `supabase/migrations/20260810120000_core_schema.sql` with no CHECK constraint coupling
 * them, so the database permits an item flagged as both TODAY. A separate task in this
 * same ticket adds that constraint; until it lands, this module is the only thing
 * standing between that row and a total that does not add up, and after it lands the two
 * will simply agree.
 *
 * Such an item is REFUSED — `computeTotals` throws and names it. The alternative was a
 * precedence rule ("worn wins over consumable", or the reverse), and it lost on the
 * arithmetic rather than on taste: an item counted in two buckets makes
 * `base + worn + consumable === total` false, and an item counted in one CHOSEN bucket
 * makes the number silently disagree with what the user ticked. The product owner chose
 * an explicit error over silently picking a winner, because the flags are two clicks
 * apart in a form and a person who has ticked both has a question that only they can
 * answer.
 *
 * ---------------------------------------------------------------------------
 * `total` IS DEFINED AS `base + worn + consumable` — NOT SUMMED INDEPENDENTLY
 * ---------------------------------------------------------------------------
 *
 * There is no fourth accumulator anywhere below. `sumBuckets` is the ONLY function that
 * produces a `WeightBuckets`, at every level of the tree, and it derives `total` from the
 * three parts it just added rather than accumulating a fourth sum over the same items.
 *
 * That makes the acceptance criterion "the three sum to the total" hold STRUCTURALLY:
 * it cannot drift, because there is no second number to drift from, and it cannot fail
 * from floating-point summation order — four independent accumulations over the same
 * doubles are not guaranteed to satisfy `a + b + c === d` even when every input is
 * correct, and a pack whose totals row is out by 2⁻⁴⁰ g is a bug report nobody can
 * reproduce. The same construction is used one level up: a pack's buckets are the sum of
 * its categories' buckets, not a second pass over the items, so "the categories sum to
 * the pack" is structural too.
 *
 * Somebody will later notice that this walks the tree in more passes than it strictly
 * needs and "optimise" it into a single loop with four `+=`. That reintroduces exactly
 * the possibility this construction removes. The engine totals a list of at most a few
 * hundred items on a page that is already making a network round trip; the passes are
 * free and the guarantee is not.
 *
 * ---------------------------------------------------------------------------
 * WHAT A PACK ITEM ACTUALLY IS: THE RESOLUTION PRECEDENCE
 * ---------------------------------------------------------------------------
 *
 * Every weight below starts as `resolvePackItem`, and the precedence is not obvious from
 * the columns. The migration's THREE RULES are the model being computed over:
 *
 *   - Rule 1: `pack_items.gear_item_id` is a REFERENCE, never a copy. The live
 *     `gear_items` row supplies the values, which is what makes editing a gear item
 *     update every pack that references it.
 *   - Rule 1's exception: `pack_items.overrides` is the per-list divergence, merged OVER
 *     whatever the base is. It is `jsonb not null default '{}'` — "an empty object, never
 *     null, so consumers merge unconditionally instead of branching on null", per the
 *     column comment. This module merges unconditionally.
 *   - Rules 2 and 3: `pack_items.snapshot` is the frozen copy written by
 *     `private.gear_item_snapshot()`. It is non-null once the pack is locked or the
 *     referenced gear item was deleted.
 *
 * THE SNAPSHOT WINS OVER THE LIVE GEAR ROW when both are present, which is the case on
 * every locked pack: locking freezes the values but does not clear `gear_item_id` (only
 * deleting the gear does that, and the foreign key nulls the reference while leaving the
 * snapshot behind). The evidence is in the migration and pinned by a test rather than
 * inferred: `freeze_pack_items_on_lock()` exists so that "a completed trip stays true as
 * the closet evolves", and tests/core-schema.test.ts asserts it directly — "does not
 * follow later edits to the gear it froze", where the gear is renamed after the lock and
 * the snapshot still reads the old name. Resolve the other way round and a locked pack
 * silently tracks later gear edits through this module while the database dutifully keeps
 * the frozen copy nobody reads: the freeze would be defeated in the one place it is
 * visible to a user, and every schema test would stay green.
 *
 * OVERRIDES ARE MERGED OVER THE SNAPSHOT TOO, not only over the live gear row. The
 * snapshot captures the GEAR row, not the pack item, so an item whose weight this list
 * overrides to 450 g would jump back to the closet's 100 g at the moment the pack was
 * locked if overrides were dropped on the frozen path — a pack changing its own total as
 * a side effect of being frozen for posterity. The write policies refuse edits to a
 * locked pack's items, so a locked pack's overrides are themselves already frozen; there
 * is nothing to be gained by ignoring them and a visible wrong number to be had.
 *
 * `pack_items_reference_or_snapshot` guarantees at least one of the two is present, so an
 * item with NEITHER is unrepresentable in the database. It is treated here as a
 * programming error — a caller that built the object by hand, or a `select` that omitted
 * the gear embed — and throws with a message that says which, rather than resolving to
 * some zero-weight ghost item that would quietly under-report the pack.
 *
 * ---------------------------------------------------------------------------
 * ABSENT IS A VALUE; MALFORMED IS A DEFECT
 * ---------------------------------------------------------------------------
 *
 * `overrides` and `snapshot` are `Json` in `src/lib/database.types.ts` — untyped at the
 * boundary, because that is the honest type for a jsonb column. Everything read out of
 * them is narrowed deliberately below, never cast, and the rule the narrowing follows is:
 *
 *   - A field that is ABSENT (or JSON `null` where the column is nullable) is a value in
 *     its own right, and means what its absence means. No price and no currency is an
 *     unpriced item, which contributes nothing to the price rollup rather than
 *     contributing zero of some assumed currency.
 *   - A field that is PRESENT and MALFORMED — a `weight` of `"heavy"` or `null` or an
 *     array, a `weight_unit` of `'lbs'`, a price without its currency — throws, naming
 *     the item.
 *
 * The alternative for the malformed case was to fall back to the underlying gear value
 * and carry on. It loses for the reason `units.ts` gives under "THROW, NOT RETURN": a
 * weight that is wrong is not a weight that is missing. A pack that silently ignores a
 * bad override renders a total that is confidently, specifically wrong, sitting next to
 * forty honest numbers in the same column and looking exactly like them; there is no
 * conservative stand-in for "this item weighs something we could not read".
 *
 * This does cut against `money.ts`'s own conclusion that "a thrown exception on the
 * public share page is an outage", and the difference is worth naming. That argument was
 * about a WELL-FORMED value (`'ZZZ'`) that renders honestly and is only questionable — it
 * is a symptom, and rendering it is more useful than refusing it. A `weight` of `"heavy"`
 * has no honest rendering at all. Note also how such a value gets in: `overrides` is
 * constrained only to be a JSON object, so a malformed field inside it can only come from
 * this application writing one, i.e. from a bug we would rather see immediately than
 * average into a total. The right place to make it unreachable is the entry form, or a
 * CHECK constraint on the shape of `overrides` — not a shrug in the formatter three steps
 * downstream.
 *
 * The one deliberate exception is `name`, which is narrowed leniently: a non-string name
 * resolves to `null` rather than throwing. Names are display, not arithmetic. A blank
 * name is visibly blank and misleads nobody about how much anything weighs, and taking
 * the whole share page down over a bad string while a perfectly good weight sits next to
 * it would be the trade this section argues against, in reverse.
 *
 * ---------------------------------------------------------------------------
 * COUNTS ARE QUANTITIES, NOT ROWS
 * ---------------------------------------------------------------------------
 *
 * `itemCount` and `packedCount` sum QUANTITIES: a single row with `quantity: 2` counts as
 * two items, not one. The genuine alternative — counting pack_item rows, i.e. "how many
 * lines are in this list" — is defensible and was rejected for consistency with the very
 * defect this ticket exists to fix. If quantity counts for weight then it counts for the
 * count; a product that tells you two pairs of socks weigh 120 g and that you are
 * carrying "1 item" has picked both answers. A caller wanting the row count has
 * `categories.flatMap((c) => c.items).length` and does not need this module's help;
 * a caller wanting the quantity sum from row counts would have to re-walk the tree and
 * re-derive it, which is the direction that loses information.
 *
 * `packed` is a boolean on a row of quantity N, so a half-packed row is not
 * representable: `packedCount` moves by the whole quantity or not at all. That is a
 * property of the schema (there is no `packed_quantity` column and this ticket does not
 * add one), recorded here because the number is otherwise easy to misread as a count of
 * individual physical things that have been put in the bag.
 *
 * ---------------------------------------------------------------------------
 * THE INPUT TYPES ARE THE SHAPE THE APPLICATION ALREADY FETCHES
 * ---------------------------------------------------------------------------
 *
 * `PackTreePack` and friends below are satisfied, without reshaping, by the result of
 * `packTreeQuery` in tests/support/local-database.ts — the single-round-trip select the
 * share page uses. That is a deliberate constraint on this module rather than a
 * coincidence: an engine whose input needs hand-mapping from the query result puts a
 * second, hand-written transcription of the schema between the database and the
 * arithmetic, and that transcription is exactly where a `worn` flag gets dropped. The
 * types are structural, so a wider select (extra columns, extra embeds) satisfies them
 * too; tests/totals.test.ts pins the assignability at compile time.
 *
 * KNOWN GAP, recorded here rather than discovered later: `PACK_TREE_SELECT` does not
 * currently fetch `pack_items.consumable`, `pack_items.packed`, or `gear_items.price` and
 * `gear_items.currency`. Those four are therefore OPTIONAL below, and an absent flag is
 * read as `false` — matching the column defaults, and the only reading available, since
 * "not selected" and "false" are indistinguishable once the row has been serialised.
 * The consequence is precise and worth knowing before trusting a number: computed over
 * today's share-page select, every item lands in the base bucket, `packedCount` is 0, and
 * the price rollup is empty. Nothing is wrong; nothing was asked for either. Whichever
 * ticket renders a consumable split, a packing checklist or a pack's cost must widen that
 * select first, and the totals it wants will then simply appear.
 */

import type { Json } from './database.types';
import {
  fromDecimal,
  isCurrencyCode,
  makeMoney,
  sumByCurrency,
  type CurrencyCode,
  type Money,
} from './money';
import { isWeightUnit, toGrams } from './units';

// ---------------------------------------------------------------------------
// Input: the pack tree, as PACK_TREE_SELECT returns it
// ---------------------------------------------------------------------------

/**
 * The `gear_items` embed on a pack item: the master record, live. Only the fields this
 * engine reads are named — a wider row satisfies this type structurally, which is why
 * the query's `id` and `brand` need no mention here.
 *
 * `price` and `currency` are optional because today's share-page select does not fetch
 * them (see the KNOWN GAP in the module comment); `name`, `weight` and `weight_unit` are
 * required because it does, and because a weight engine handed a row with no weight has
 * nothing to compute.
 */
export interface PackTreeGearItem {
  readonly name: string;
  readonly weight: number;
  readonly weight_unit: string;
  readonly price?: number | null;
  readonly currency?: string | null;
}

/**
 * One row of `pack_items`, with its gear embed.
 *
 * `overrides` and `snapshot` are `Json` rather than a hand-written shape, because that is
 * what the generated types say and what the columns actually guarantee: an object, of
 * whatever shape whoever wrote it chose. `resolvePackItem` narrows them; nothing else in
 * this file touches them.
 */
export interface PackTreeItem {
  readonly id: string;
  readonly quantity: number;
  readonly worn: boolean;
  readonly consumable?: boolean;
  readonly packed?: boolean;
  readonly overrides: Json;
  readonly snapshot?: Json | null;
  readonly gear_items?: PackTreeGearItem | null;
}

/** One row of `pack_categories`, with its items. */
export interface PackTreeCategory {
  readonly id: string;
  readonly name: string;
  readonly pack_items: readonly PackTreeItem[];
}

/**
 * A pack, with its categories. Deliberately nothing else: this engine has no use for the
 * pack's name, slug, visibility or `locked_at`, and asking for them would make a caller
 * that legitimately holds only a subtree unable to call it. Lockedness in particular is
 * NOT an input — whether a pack is frozen is already expressed, per item, by the presence
 * of a snapshot, and reading `locked_at` here would create a second source of truth that
 * could disagree with the row in front of it.
 */
export interface PackTreePack {
  readonly pack_categories: readonly PackTreeCategory[];
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/**
 * The three buckets, named once. Exported because a caller rendering a breakdown wants to
 * iterate them in a fixed order rather than hardcoding three property names in a
 * template, and because a test can walk it to prove the partition holds for each.
 */
export const WEIGHT_BUCKETS = ['base', 'worn', 'consumable'] as const;

export type WeightBucket = (typeof WEIGHT_BUCKETS)[number];

/**
 * A weight breakdown, in grams, at any level of the tree: one item, one category, or the
 * whole pack. `total` is always `base + worn + consumable` — see the module comment for
 * why that is a definition rather than a coincidence that happens to hold.
 */
export interface WeightBuckets {
  readonly total: number;
  readonly base: number;
  readonly worn: number;
  readonly consumable: number;
}

/** Quantities, not rows — see "COUNTS ARE QUANTITIES, NOT ROWS" in the module comment. */
export interface ItemCounts {
  readonly itemCount: number;
  readonly packedCount: number;
}

/** Which of the two sources a pack item's values came from. */
export type PackItemSource = 'gear_item' | 'snapshot';

/**
 * What a pack item resolved to: the values after the precedence in the module comment has
 * been applied. One item's worth, before quantity is involved at all — `weightGrams` is
 * the weight of ONE of these, and `price` is the price of one.
 */
export interface ResolvedPackItem {
  readonly source: PackItemSource;
  readonly name: string | null;
  readonly weightGrams: number;
  readonly price: Money | null;
}

/**
 * The per-item rollup. Both weights are given because both are wanted and deriving one
 * from the other at a call site is where the quantity multiplier goes missing: a table
 * shows "84 g × 2 = 168 g", and a template that has to compute the right-hand side is a
 * template that can compute it wrongly. `unitPrice` and `linePrice` are the same
 * distinction for money.
 */
export interface ItemTotals {
  readonly id: string;
  readonly name: string | null;
  readonly source: PackItemSource;
  readonly bucket: WeightBucket;
  readonly quantity: number;
  readonly packed: boolean;
  readonly unitWeightGrams: number;
  readonly lineWeightGrams: number;
  readonly unitPrice: Money | null;
  readonly linePrice: Money | null;
}

/**
 * A category's contribution to the pack, and the rollups of the items inside it. A
 * category with no items is a legitimate, ordinary thing — a heading someone has made and
 * not filled in yet — and rolls up to zeroes rather than being skipped, so a caller
 * rendering the tree gets a row for it.
 */
export interface CategoryTotals extends WeightBuckets, ItemCounts {
  readonly id: string;
  readonly name: string;
  readonly items: readonly ItemTotals[];
  readonly pricesByCurrency: ReadonlyMap<CurrencyCode, number>;
}

/**
 * The whole pack.
 *
 * The per-item rollups live inside their category rather than also being repeated in a
 * flat list at this level. Two collections holding the same numbers is two things to keep
 * in step for no gain, and the tree is the direction that keeps information: a flat view
 * is `categories.flatMap((c) => c.items)`, whereas rebuilding the grouping from a flat
 * list means re-joining on a category id this shape would then have to carry.
 *
 * `pricesByCurrency` is a map from currency code to total MINOR units — see
 * `sumByCurrency` in `src/lib/money.ts`, and that module's "CROSS-CURRENCY SUMMING IS
 * IMPOSSIBLE" section, for why there is no single number here and why one must never be
 * added. A pack with GBP and USD gear yields two entries; rendering that as two lines, or
 * as an explicit "mixed currencies" notice, is the caller's decision.
 */
export interface PackTotals extends WeightBuckets, ItemCounts {
  readonly categories: readonly CategoryTotals[];
  readonly pricesByCurrency: ReadonlyMap<CurrencyCode, number>;
}

// ---------------------------------------------------------------------------
// Narrowing the jsonb boundary
// ---------------------------------------------------------------------------

/** What `overrides` and `snapshot` are once narrowed: a plain JSON object. */
type JsonObject = { readonly [key: string]: Json | undefined };

/**
 * `typeof null === 'object'` and `typeof [] === 'object'`, so both have to be excluded by
 * hand. Returns `undefined` for anything that is not a JSON object, leaving the caller to
 * decide whether that means "absent" or "malformed" — a distinction this function cannot
 * make and the two call sites below can.
 */
function asJsonObject(value: Json | null | undefined): JsonObject | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value;
}

/**
 * How an item is named in an error message. The id is always there and is what a
 * maintainer needs to find the row; the name is what the person reporting the problem can
 * actually see on their screen, and is included when it resolved to something readable. A
 * pack holds forty of these, and "value must be a finite number" with neither is a
 * message nobody can act on.
 */
function describeItem(id: string, name: unknown): string {
  return typeof name === 'string' && name.trim().length > 0
    ? `pack item ${id} ("${name}")`
    : `pack item ${id}`;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Resolves what a pack item actually is: the frozen copy if there is one, otherwise the
 * live gear row, with this list's overrides merged over the top of whichever won. The
 * full argument for that precedence, and for the merge applying on both paths, is in the
 * module comment under "WHAT A PACK ITEM ACTUALLY IS".
 *
 * Returns one item's values, never a line: quantity is not this function's business, and
 * keeping it out is what makes the multiplication happen in exactly one place
 * (`computeItemTotals`) rather than at every call site that wants a weight.
 *
 * The merge is SHALLOW, and deliberately so — the same shallow merge PostgREST callers
 * would get from `||` on the two jsonb values. It means `{ "weight": 450 }` overrides the
 * weight and leaves the unit alone, taking `weight_unit` from the base, which is the
 * behaviour a form that edits one field has to have. The snapshot's keys are exactly the
 * gear row's column names, because `private.gear_item_snapshot()` builds it that way, so
 * one set of field names covers both bases — and an override written against a live item
 * keeps working unchanged after that item is frozen.
 */
export function resolvePackItem(item: PackTreeItem): ResolvedPackItem {
  const snapshot = asJsonObject(item.snapshot);
  if (item.snapshot != null && snapshot === undefined) {
    throw new TypeError(
      `${describeItem(item.id, undefined)} has a snapshot that is not a JSON object. ` +
        `The pack_items.snapshot CHECK constraint permits only null or an object, so this row ` +
        `cannot have come from the database as it stands.`,
    );
  }

  // Null is not reachable through the Data API — the column is `not null default '{}'` —
  // but the generated type allows it, and "no overrides" is the only sane reading of it.
  // Anything else non-object (a number, a string, an array) is a value someone wrote on
  // purpose and this module cannot merge, so it is a defect rather than an absence.
  const overrides = asJsonObject(item.overrides);
  if (item.overrides != null && overrides === undefined) {
    throw new TypeError(
      `${describeItem(item.id, undefined)} has overrides that are not a JSON object. ` +
        `pack_items.overrides is an object holding per-list divergence from the gear item; ` +
        `an empty object means no divergence.`,
    );
  }

  const gear = item.gear_items;
  const base: JsonObject | undefined =
    snapshot ??
    (gear
      ? {
          name: gear.name,
          weight: gear.weight,
          weight_unit: gear.weight_unit,
          price: gear.price ?? null,
          currency: gear.currency ?? null,
        }
      : undefined);

  if (base === undefined) {
    throw new TypeError(
      `${describeItem(item.id, undefined)} has neither a gear item nor a snapshot, so there ` +
        `is nothing to resolve it from. The pack_items_reference_or_snapshot check constraint ` +
        `makes that state unrepresentable in the database, so either this object was built by ` +
        `hand or the query that fetched it omitted the gear_items embed.`,
    );
  }

  const merged: JsonObject = { ...base, ...overrides };
  const name = typeof merged.name === 'string' ? merged.name : null;

  return {
    source: snapshot ? 'snapshot' : 'gear_item',
    name,
    weightGrams: resolveWeightGrams(item.id, name, merged),
    price: resolvePrice(item.id, name, merged),
  };
}

/**
 * The merged `weight` and `weight_unit`, converted to grams once — the single conversion
 * every weight in a pack passes through, per `units.ts`'s "GRAMS IS THE CANONICAL UNIT".
 * Nothing downstream of this line holds a non-gram number.
 *
 * The finiteness half of the check duplicates `assertFiniteWeight` inside `toGrams`, and
 * that repetition is on purpose rather than an oversight: `toGrams` correctly reports
 * "value must be a finite number, got NaN", and this one can say which of the forty rows
 * on the page it came from. The item id is worth one redundant comparison.
 */
function resolveWeightGrams(id: string, name: string | null, merged: JsonObject): number {
  const weight = merged.weight;
  if (typeof weight !== 'number' || !Number.isFinite(weight)) {
    throw new TypeError(
      `${describeItem(id, name)} resolved to a weight of ${JSON.stringify(weight)}, which is ` +
        `not a finite number. gear_items.weight is numeric and non-null, so this came from an ` +
        `override or a snapshot; fix the value rather than the total it breaks.`,
    );
  }

  const unit = merged.weight_unit;
  if (!isWeightUnit(unit)) {
    throw new TypeError(
      `${describeItem(id, name)} resolved to a weight unit of ${JSON.stringify(unit)}, which is ` +
        `not one of the four gear_items.weight_unit accepts (g, kg, oz, lb). A weight with an ` +
        `unknown unit cannot be converted, and guessing grams would be a specific wrong answer.`,
    );
  }

  return toGrams(weight, unit);
}

/**
 * The merged `price` and `currency` as one `Money`, or `null` for an item that has no
 * price at all.
 *
 * THE UNITS BOUNDARY IS THE WHOLE POINT OF THIS FUNCTION. `gear_items.price` is
 * `numeric(12, 2)` — a DECIMAL major-unit value, `42.50` meaning forty-two pounds fifty —
 * and `money.ts` models amounts in MINOR units. `fromDecimal` is the crossing, and it is
 * not merely `× 100`: it asks `Intl` how many fraction digits the currency actually has,
 * so a ¥100 item does not become ¥10,000. Handing that `42.50` to `makeMoney` instead
 * would under-report every price by a factor of a hundred, and £0.43 next to £42.50 in a
 * list is the kind of wrong that reads as a data-entry mistake rather than a bug.
 *
 * Half a pair throws. `gear_items_price_has_currency check ((price is null) = (currency is
 * null))` makes that unrepresentable on the gear row, but an override can set one without
 * the other, and both silent readings are worse than an error: dropping the price
 * under-reports the pack's cost — a total people compare against another pack's — while
 * inventing a currency is precisely the guess `money.ts` exists to make impossible.
 */
function resolvePrice(id: string, name: string | null, merged: JsonObject): Money | null {
  const price = merged.price ?? null;
  const currency = merged.currency ?? null;

  if (price === null && currency === null) return null;

  if (typeof price !== 'number' || !Number.isFinite(price)) {
    throw new TypeError(
      `${describeItem(id, name)} resolved to a price of ${JSON.stringify(price)} with a ` +
        `currency of ${JSON.stringify(currency)}. A currency with no price is a unit with ` +
        `nothing to measure; clear both to leave the item unpriced.`,
    );
  }

  if (!isCurrencyCode(currency)) {
    throw new TypeError(
      `${describeItem(id, name)} resolved to a price of ${JSON.stringify(price)} with a ` +
        `currency of ${JSON.stringify(currency)}, which is not a three-letter ISO 4217 code. ` +
        `A price without a currency is a number no formatter can render; clear both to leave ` +
        `the item unpriced.`,
    );
  }

  return fromDecimal(price, currency);
}

// ---------------------------------------------------------------------------
// Classification and per-item rollup
// ---------------------------------------------------------------------------

/**
 * Which bucket an item belongs in, and the refusal that keeps the three a partition. See
 * "THREE BUCKETS THAT PARTITION" in the module comment for why this throws rather than
 * applying a precedence rule, and for the CHECK constraint that will make the state
 * unreachable from the database side.
 *
 * `consumable` defaults to `false` when absent, matching the column default and today's
 * share-page select — see the KNOWN GAP in the module comment.
 */
function classifyPackItem(item: PackTreeItem, name: string | null): WeightBucket {
  const consumable = item.consumable ?? false;
  if (item.worn && consumable) {
    throw new TypeError(
      `${describeItem(item.id, name)} is flagged both worn and consumable. Base, worn and ` +
        `consumable must partition the pack exactly — an item in two buckets makes ` +
        `base + worn + consumable disagree with the total — so clear one of the two flags: ` +
        `worn means carried on the body rather than in the pack, consumable means used up ` +
        `during the trip.`,
    );
  }
  if (item.worn) return 'worn';
  if (consumable) return 'consumable';
  return 'base';
}

/**
 * One pack item's rollup: resolve it, classify it, and multiply by quantity — once, here,
 * for weight and price alike, in every bucket without exception.
 *
 * `quantity` is validated against its own CHECK constraint (`quantity integer not null
 * check (quantity > 0)`) rather than trusted, for the same reason `isWeightUnit` mirrors
 * its constraint instead of assuming the column: the value arrives typed merely as
 * `number`, and a zero, a negative or a fractional quantity would sail through the
 * multiplication and produce a total that is wrong without ever looking wrong. Zero is the
 * dangerous one — it silently removes an item from a pack that still lists it.
 */
function computeItemTotals(item: PackTreeItem): ItemTotals {
  const resolved = resolvePackItem(item);
  const bucket = classifyPackItem(item, resolved.name);
  const quantity = item.quantity;

  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new RangeError(
      `${describeItem(item.id, resolved.name)} has a quantity of ${JSON.stringify(quantity)}. ` +
        `pack_items.quantity is an integer with check (quantity > 0), so a pack item is always ` +
        `at least one of something.`,
    );
  }

  return {
    id: item.id,
    name: resolved.name,
    source: resolved.source,
    bucket,
    quantity,
    packed: item.packed ?? false,
    unitWeightGrams: resolved.weightGrams,
    // The multiplier LighterPack's worn subtotal collapses to 1. It is applied here, for
    // every bucket, with no branch on `bucket` anywhere near it — see
    // tests/worn-weight-quantity.test.ts.
    lineWeightGrams: resolved.weightGrams * quantity,
    unitPrice: resolved.price,
    // Minor units are integers (`fromDecimal` rounds to them), and an integer times an
    // integer quantity stays one, so a line price needs no rounding of its own.
    linePrice:
      resolved.price === null
        ? null
        : makeMoney(resolved.price.amountMinorUnits * quantity, resolved.price.currency),
  };
}

// ---------------------------------------------------------------------------
// Accumulation
// ---------------------------------------------------------------------------

/**
 * The ONLY place a `WeightBuckets` is built, at every level of the tree, and the only
 * place `total` is ever assigned. It is derived from the three parts this call just
 * added, never accumulated alongside them — the structural guarantee the module comment
 * describes lives in these four lines and nowhere else. An empty list gives four zeroes,
 * which is the right answer for an empty pack and for a category nobody has filled in.
 */
function sumBuckets(parts: readonly WeightBuckets[]): WeightBuckets {
  let base = 0;
  let worn = 0;
  let consumable = 0;
  for (const part of parts) {
    base += part.base;
    worn += part.worn;
    consumable += part.consumable;
  }
  return { total: base + worn + consumable, base, worn, consumable };
}

/**
 * One item as a weight breakdown: its whole line weight in exactly one bucket, and zero
 * in the other two. This is what makes `sumBuckets` the single accumulator — an item, a
 * category and a pack are all just `WeightBuckets` to it, so there is no second summation
 * path where the item-level and category-level arithmetic could disagree.
 */
function itemAsBuckets(item: ItemTotals): WeightBuckets {
  const weightIn = (bucket: WeightBucket): number =>
    item.bucket === bucket ? item.lineWeightGrams : 0;
  const base = weightIn('base');
  const worn = weightIn('worn');
  const consumable = weightIn('consumable');
  return { total: base + worn + consumable, base, worn, consumable };
}

/** Counts add the same way at every level, and for the same reason. */
function sumCounts(parts: readonly ItemCounts[]): ItemCounts {
  let itemCount = 0;
  let packedCount = 0;
  for (const part of parts) {
    itemCount += part.itemCount;
    packedCount += part.packedCount;
  }
  return { itemCount, packedCount };
}

/** An item's own counts: its quantity, and its quantity again if the row is packed. */
function itemAsCounts(item: ItemTotals): ItemCounts {
  return { itemCount: item.quantity, packedCount: item.packed ? item.quantity : 0 };
}

/**
 * Line prices, per currency.
 *
 * Summed from the flat list of items at each level rather than by merging the categories'
 * maps the way the weights are summed hierarchically, and the difference is deliberate:
 * `Money` amounts are integer minor units, so their addition is exact and cannot depend on
 * summation order — the floating-point argument that makes the weights structural has
 * nothing to say here. Going straight to the items instead keeps `sumByCurrency` as the
 * one place currencies are ever keyed, rather than adding a map-merge that would be a
 * second implementation of the same idea.
 */
function pricesByCurrency(items: readonly ItemTotals[]): ReadonlyMap<CurrencyCode, number> {
  const monies: Money[] = [];
  for (const item of items) {
    if (item.linePrice !== null) monies.push(item.linePrice);
  }
  return sumByCurrency(monies);
}

function computeCategoryTotals(category: PackTreeCategory): CategoryTotals {
  const items = category.pack_items.map(computeItemTotals);
  return {
    id: category.id,
    name: category.name,
    ...sumBuckets(items.map(itemAsBuckets)),
    ...sumCounts(items.map(itemAsCounts)),
    items,
    pricesByCurrency: pricesByCurrency(items),
  };
}

/**
 * The pack's totals, its categories' contributions, and every item's own weights — all in
 * grams, at full precision, never rounded.
 *
 * Rounding is a DISPLAY concern and `roundWeight` is where it belongs (`units.ts`). Doing
 * it here would be worse than useless: rounding each line and then summing gives a total
 * that disagrees with the honest sum by an amount that grows with the number of items, so
 * a forty-item pack would show a total that is not what its own visible rows add up to.
 * A caller renders `fromGrams` + `roundWeight` at the last moment, per number shown.
 *
 * Throws — naming the item — for an item flagged both worn and consumable, for a quantity
 * outside its CHECK constraint, and for a weight, unit or price that resolved to
 * something malformed. Nothing here returns a partial or best-effort total: see "ABSENT IS
 * A VALUE; MALFORMED IS A DEFECT".
 */
export function computeTotals(pack: PackTreePack): PackTotals {
  const categories = pack.pack_categories.map(computeCategoryTotals);
  const items = categories.flatMap((category) => category.items);

  return {
    ...sumBuckets(categories),
    ...sumCounts(categories),
    categories,
    pricesByCurrency: pricesByCurrency(items),
  };
}
