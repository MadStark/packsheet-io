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
 * — and this engine will be imported by the public share page (Ref 26, which is not
 * written yet), the anonymous surface this product is built around. See the doc comment
 * at the top of `src/lib/auth-routes.ts`, which exists for exactly this reason.
 * Constants, types and arithmetic only.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT THIS MODULE EXISTS TO NOT HAVE
 * ---------------------------------------------------------------------------
 *
 * LighterPack's worn-weight subtotal ignores quantity: reported in 2017 and still
 * unfixed when this was written in August 2026 — an as-of claim rather than a standing
 * fact, and tests/worn-weight-quantity.test.ts records where it was read. Every
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
 * two independent booleans in `supabase/migrations/20260810120000_core_schema.sql`, and
 * `supabase/migrations/20260812000000_worn_consumable_exclusive.sql` — which ships in
 * this same commit — is the `check (not (worn and consumable))` that stops them being
 * true together at rest.
 *
 * THE CONSTRAINT AND THE REFUSAL BELOW SHIP TOGETHER, AND NEITHER MAKES THE OTHER
 * REDUNDANT. The constraint covers every row of that table, including rows written by
 * psql, by a restore, or by some later import path that never calls this module. This
 * module covers every input that did not come from that table: a hand-built object, a
 * fixture, a payload assembled by a future feature. The engine is a pure function over a
 * shape, not a reader of one database, so "the database will not let that happen" is not
 * a reason for it to stop checking.
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
 * There is no fourth accumulator anywhere below. `makeBuckets` is the ONLY function that
 * produces a `WeightBuckets` — the only place `total` is ever assigned — at every level of
 * the tree, and it derives `total` from the parts handed to it rather than from a fourth
 * sum over the same items. The two callers that build one (`sumBuckets`, which adds a
 * list of breakdowns, and `itemAsBuckets`, which turns a single line into one) both go
 * through it, so neither can carry its own idea of what `total` means.
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
 * snapshot behind). The evidence is a test rather than an inference:
 * tests/core-schema.test.ts asserts it directly under "does not follow later edits to the
 * gear it froze" — "a completed trip stays true as the closet evolves", in that file's
 * own words — where the gear is renamed after the lock and the snapshot still reads the
 * old name. `freeze_pack_items_on_lock()` in the core schema migration is the trigger
 * that makes it so. Resolve the other way round and a locked pack silently tracks later
 * gear edits through this module while the database dutifully keeps the frozen copy
 * nobody reads: the freeze would be defeated in the one place it is visible to a user,
 * and every schema test would stay green.
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
 * THE INPUT TYPES ARE THE SHAPE THE ONE PACK-TREE QUERY ALREADY FETCHES
 * ---------------------------------------------------------------------------
 *
 * `PackTreePack` and friends below are satisfied, without reshaping, by the result of
 * `packTreeQuery` in tests/support/local-database.ts — the single-round-trip select the
 * share page will issue once Ref 26 writes it.
 *
 * That select (`PACK_TREE_SELECT`) currently lives in tests/support/ because the page
 * that will issue it does not exist yet, which is worth saying plainly rather than
 * leaving a reader to discover: production code is documenting its input contract by
 * pointing at a test helper. The pointer moves to the page's own module the day there is
 * one, and the compile-time assertion in tests/totals.test.ts moves with it — what must
 * not happen in the meantime is a second, hand-written select growing up beside it.
 *
 * The shape is a deliberate constraint on this module rather than a coincidence: an
 * engine whose input needs hand-mapping from the query result puts a second,
 * hand-written transcription of the schema between the database and the arithmetic,
 * and that transcription is exactly where a `worn` flag gets dropped. The
 * types are structural, so a wider select (extra columns, extra embeds) satisfies them
 * too; tests/totals.test.ts pins the assignability at compile time.
 *
 * EVERY FIELD THIS ENGINE READS IS REQUIRED, INCLUDING THE NULLABLE ONES. `consumable`,
 * `packed`, `price` and `currency` are not optional properties below: the two flags are
 * required booleans and the two price fields are required but NULLABLE (`number | null`,
 * `string | null`), so a caller with no price must say `null` rather than omit the key.
 *
 * That is a correction, and the shape it replaces is worth recording because it looked
 * reasonable. The four were optional, defaulted with `?? false` / `?? null`, and
 * documented as "may legitimately be absent" — but absent never meant "this item has no
 * such fact", it meant "the one query we had did not fetch this column yet", and reading
 * it as a value produced two wrong answers rather than one missing one:
 *
 *   - Every consumable item's weight landed in BASE, and a pack full of food was
 *     indistinguishable from a pack with no consumables at all. A total that is silently
 *     the wrong shape, not a total that is absent.
 *   - Worse, the fields were not even absent uniformly WITHIN one pack.
 *     `private.gear_item_snapshot()` captures `price` and `currency`, so a frozen item
 *     carries them whatever the select asked for. Delete one gear item from a forty-item
 *     priced pack and the BEFORE DELETE trigger snapshots that row alone: the price
 *     rollup then reported that item's price and nothing else — `{ GBP: 4250 }` for a
 *     pack that cost two thousand pounds. A partial map is worse than an empty one. An
 *     empty map is visibly nothing; a partial map is a confident wrong number.
 *
 * Making the fields required moves that from a runtime surprise to a compile error, and
 * the compile error lands in the right place: tests/totals.test.ts asserts that
 * `PACK_TREE_SELECT`'s inferred row type is assignable to `PackTreePack`, which with no
 * optional properties left now fails in BOTH directions — when a select is too narrow, as
 * well as when one is narrowed later. `tests/support/local-database.ts` fetches all four.
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
 * `price` and `currency` are REQUIRED and NULLABLE, which is the whole distinction: the
 * columns are nullable (an unpriced item is an ordinary thing, and
 * `gear_items_price_has_currency` makes both null together the only way to express it),
 * but a caller must SAY null rather than leave the key out. An optional property would
 * collapse "this gear has no price" and "the query did not ask for a price" into the same
 * value, and those two have different right answers — see the module comment for the
 * partial-rollup number that produced.
 */
export interface PackTreeGearItem {
  readonly name: string;
  readonly weight: number;
  readonly weight_unit: string;
  readonly price: number | null;
  readonly currency: string | null;
}

/**
 * One row of `pack_items`, with its gear embed.
 *
 * `overrides` and `snapshot` are `Json` rather than a hand-written shape, because that is
 * what the generated types say and what the columns actually guarantee: an object, of
 * whatever shape whoever wrote it chose. `resolvePackItem` narrows them; nothing else in
 * this file touches them.
 *
 * `worn`, `consumable` and `packed` are all three required booleans, matching three
 * `boolean not null default false` columns. `snapshot` and `gear_items` stay optional
 * because for those two, absent and null genuinely mean the same thing — an item with no
 * frozen copy, an item whose gear has been deleted — and `pack_items_reference_or_snapshot`
 * guarantees they are never both missing at once, which is the case `resolvePackItem`
 * refuses by name.
 */
export interface PackTreeItem {
  readonly id: string;
  readonly quantity: number;
  readonly worn: boolean;
  readonly consumable: boolean;
  readonly packed: boolean;
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
 * whole pack. `total` is always the sum of the buckets — see the module comment for why
 * that is a definition rather than a coincidence that happens to hold.
 *
 * DERIVED FROM `WEIGHT_BUCKETS` RATHER THAN LISTING THE SAME THREE NAMES AGAIN. That
 * constant is exported so a caller rendering a breakdown need not hardcode the bucket
 * names; a hand-written `{ total; base; worn; consumable }` here would have made this
 * file itself the hardcoding it spares them. The failure that closes is specific: adding
 * a fourth bucket to `WEIGHT_BUCKETS` compiled cleanly and the new bucket then silently
 * vanished from every total — classified into by `classifyPackItem`, dropped by the
 * accumulator, absent from the sum, with nothing red anywhere. Written this way, that
 * same edit fails to compile in `makeBuckets` until the accumulation counts it too.
 *
 * The field names are unchanged and deliberately so: `total`, `base`, `worn`,
 * `consumable` are what the ticket specifies and what a template reads.
 */
export type WeightBuckets = { readonly total: number } & {
  readonly [B in WeightBucket]: number;
};

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
  readonly pricesByCurrency: ReadonlyMap<CurrencyCode, Money>;
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
 * `pricesByCurrency` is a map from currency code to the total `Money` in that currency —
 * see `sumByCurrency` in `src/lib/money.ts`, and that module's "CROSS-CURRENCY SUMMING IS
 * IMPOSSIBLE" section, for why there is no single number here and why one must never be
 * added, and its "THE VALUES ARE `Money`" note for why the totals are not bare minor-unit
 * numbers a template could print unscaled. A pack with GBP and USD gear yields two
 * entries; rendering that as two lines, or as an explicit "mixed currencies" notice, is
 * the caller's decision — through `formatMoney`, which is now the only thing that can
 * render one of these values at all.
 */
export interface PackTotals extends WeightBuckets, ItemCounts {
  readonly categories: readonly CategoryTotals[];
  readonly pricesByCurrency: ReadonlyMap<CurrencyCode, Money>;
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

/**
 * How a rejected VALUE is rendered in those messages. `JSON.stringify` for everything a
 * jsonb column can actually hold, so a string arrives quoted (`"heavy"`) and is visibly a
 * string — but NOT for the non-finite numbers, because `JSON.stringify(NaN)` and
 * `JSON.stringify(Infinity)` are both the literal `"null"`, and "resolved to a price of
 * null" is a report of the one thing that did not happen: the reader goes looking for a
 * missing field when what they have is a bad number. `undefined` still renders as
 * `undefined`, which is what an absent key is.
 */
function describeValue(value: unknown): string {
  return typeof value === 'number' && !Number.isFinite(value)
    ? String(value)
    : JSON.stringify(value);
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
 * behaviour a form that edits one field has to have. The snapshot uses the gear row's own
 * column names for every field an override can touch — `name`, `weight`, `weight_unit`,
 * `price`, `currency` — because `private.gear_item_snapshot()` builds it that way, so one
 * set of field names covers both bases — and an override written against a live item
 * keeps working unchanged after that item is frozen.
 *
 * It is NOT a whole-row copy, and nothing above should be read as saying it is: that
 * function renames `id` to `gear_item_id`, adds `captured_at`, and leaves out `notes`,
 * `url`, `status`, `user_id` and the timestamps (a display record, not an audit log —
 * the migration says so where it builds the object). None of those is a field this
 * module reads, which is why the difference costs nothing here; it would cost something
 * to the next person reaching for a column on the frozen path that only the live row has.
 */
export function resolvePackItem(item: PackTreeItem): ResolvedPackItem {
  // The gear embed's own name, for the two failures below that happen before there is a
  // merged record to read a name out of. It is the best name available at this point and
  // frequently the right one — an item whose snapshot or overrides are unreadable usually
  // still references live gear — and `describeItem` falls back to the bare id when it is
  // absent, which is the case for a frozen item whose gear has since been deleted.
  const gearName = item.gear_items?.name;

  const snapshot = asJsonObject(item.snapshot);
  if (item.snapshot != null && snapshot === undefined) {
    throw new TypeError(
      `${describeItem(item.id, gearName)} has a snapshot that is not a JSON object. ` +
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
      `${describeItem(item.id, gearName)} has overrides that are not a JSON object. ` +
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
          price: gear.price,
          currency: gear.currency,
        }
      : undefined);

  if (base === undefined) {
    // The one message here that cannot name the item, and it is not an oversight: this
    // branch is reached precisely because there is no gear row and no snapshot, so there
    // is nowhere left for a name to come from. The message says which two things are
    // missing instead, which is what the reader needs anyway.
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
 * The finiteness and non-negativity checks duplicate `assertWeight` inside `toGrams`, and
 * that repetition is on purpose rather than an oversight: `toGrams` correctly reports
 * "value must be a finite number, got NaN", and this one can say which of the forty rows
 * on the page it came from. The item id is worth two redundant comparisons.
 *
 * Both halves of `gear_items.weight`'s CHECK constraint are mirrored, not just the upper
 * one. A negative weight is reachable through an ordinary PATCH of `pack_items.overrides`
 * (whose contents no constraint touches) and it is the more dangerous of the two, because
 * it does not announce itself downstream: two 1000 g items, one overridden to -400 g,
 * total 600 g — a plausible number, in a partition that still adds up, on a page with no
 * way to tell it from the truth. See "THROW, NOT RETURN" in units.ts.
 */
function resolveWeightGrams(id: string, name: string | null, merged: JsonObject): number {
  const weight = merged.weight;
  if (typeof weight !== 'number' || !Number.isFinite(weight)) {
    throw new TypeError(
      `${describeItem(id, name)} resolved to a weight of ${describeValue(weight)}, which is ` +
        `not a finite number. gear_items.weight is numeric and non-null, so this came from an ` +
        `override or a snapshot; fix the value rather than the total it breaks.`,
    );
  }

  if (weight < 0) {
    throw new TypeError(
      `${describeItem(id, name)} resolved to a weight of ${describeValue(weight)}, which is ` +
        `negative. gear_items.weight carries check (weight >= 0), so this came from an override ` +
        `or a snapshot; a negative line subtracts from the pack total while leaving it a ` +
        `perfectly ordinary number, so nothing downstream can catch it.`,
    );
  }

  const unit = merged.weight_unit;
  if (!isWeightUnit(unit)) {
    throw new TypeError(
      `${describeItem(id, name)} resolved to a weight unit of ${describeValue(unit)}, which is ` +
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
      `${describeItem(id, name)} resolved to a price of ${describeValue(price)} with a ` +
        `currency of ${describeValue(currency)}, which is not a finite number. A currency ` +
        `with nothing usable to measure is not a price; clear both to leave the item ` +
        `unpriced, or fix the value this one came from.`,
    );
  }

  if (price < 0) {
    throw new TypeError(
      `${describeItem(id, name)} resolved to a price of ${describeValue(price)}, which is ` +
        `negative. gear_items.price carries check (price >= 0), so this came from an override ` +
        `or a snapshot; this product prices gear and has no refunds or credits for a negative ` +
        `price to mean. Checked here rather than left to makeMoney so the message names the row.`,
    );
  }

  if (!isCurrencyCode(currency)) {
    throw new TypeError(
      `${describeItem(id, name)} resolved to a price of ${describeValue(price)} with a ` +
        `currency of ${describeValue(currency)}, which is not a three-letter ISO 4217 code. ` +
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
 * applying a precedence rule, and for why it keeps throwing even though
 * `pack_items_worn_consumable_exclusive` now makes the state unreachable from the
 * database side: this function is handed objects that never came from that table.
 *
 * Both flags are read exactly the same way — as the required booleans they are, with no
 * defaulting on either side. That symmetry is the point: while `consumable` was optional
 * and `worn` was not, this function silently answered "base" for every consumable item a
 * query had not thought to fetch, and nothing distinguished that from a pack with no
 * consumables in it. See the module comment.
 */
function classifyPackItem(item: PackTreeItem, name: string | null): WeightBucket {
  if (item.worn && item.consumable) {
    throw new TypeError(
      `${describeItem(item.id, name)} is flagged both worn and consumable. Base, worn and ` +
        `consumable must partition the pack exactly — an item in two buckets makes ` +
        `base + worn + consumable disagree with the total — so clear one of the two flags: ` +
        `worn means carried on the body rather than in the pack, consumable means used up ` +
        `during the trip.`,
    );
  }
  if (item.worn) return 'worn';
  if (item.consumable) return 'consumable';
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
      `${describeItem(item.id, resolved.name)} has a quantity of ${describeValue(quantity)}. ` +
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
    packed: item.packed,
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
 * THE ONLY PLACE `total` IS EVER ASSIGNED — the four lines the module comment's
 * structural guarantee actually lives in. Both producers of a `WeightBuckets` go through
 * here, so `total` is derived from the parts every single time rather than written out
 * beside them.
 *
 * This exists because the claim above it used to be false in a small, quiet way:
 * `sumBuckets` said it was the only producer while `itemAsBuckets` was a second one with
 * its own hand-written `base + worn + consumable`. The two formulas agreed, so there was
 * no bug — but a second producer is exactly where the invariant drifts later, and the
 * comment denying its existence is what would have made the drift hard to find.
 *
 * `total` is summed over `WEIGHT_BUCKETS` rather than written as `base + worn +
 * consumable`, for the reason on `WeightBuckets` itself: a fourth bucket then joins the
 * total by existing, instead of being silently omitted from it. The iteration order is
 * the constant's own order, so the floating-point result is bit-identical to the
 * left-associative sum it replaces — which matters, because the partition is asserted
 * with exact equality.
 */
function makeBuckets(parts: { readonly [B in WeightBucket]: number }): WeightBuckets {
  let total = 0;
  for (const bucket of WEIGHT_BUCKETS) total += parts[bucket];
  return { ...parts, total };
}

/**
 * The accumulator, at every level of the tree. It adds the three parts and hands them to
 * `makeBuckets`, never accumulating a fourth sum over the same items — see the module
 * comment. An empty list gives four zeroes, which is the right answer for an empty pack
 * and for a category nobody has filled in.
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
  return makeBuckets({ base, worn, consumable });
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
  return makeBuckets({
    base: weightIn('base'),
    worn: weightIn('worn'),
    consumable: weightIn('consumable'),
  });
}

/**
 * Counts add at every level exactly as the weights do, but NOT for the same reason, and
 * the difference is worth one line so nobody transplants the argument: these are
 * integers, so summation order cannot disturb them and there is no structural guarantee
 * here to protect. They get their own accumulator only because they are not weights.
 */
function sumCounts(parts: readonly ItemCounts[]): ItemCounts {
  let itemCount = 0;
  let packedCount = 0;
  for (const part of parts) {
    itemCount += part.itemCount;
    packedCount += part.packedCount;
  }
  return { itemCount, packedCount };
}

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
function pricesByCurrency(items: readonly ItemTotals[]): ReadonlyMap<CurrencyCode, Money> {
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
