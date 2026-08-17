import { describe, expect, it } from 'vitest';
import {
  WEIGHT_BUCKETS,
  computeTotals,
  resolvePackItem,
  type PackTotals,
  type PackTreeCategory,
  type PackTreeGearItem,
  type PackTreeItem,
  type PackTreePack,
  type WeightBucket,
} from '../src/lib/totals';
// Type-only, so nothing in tests/support runs here and no Supabase client, `pg` or child
// process is loaded: this file is as pure as the module it tests. The import exists for
// the compile-time assertion at the bottom of this file, which is the only honest way to
// state "the engine consumes what the application actually fetches".
import type { packTreeQuery } from './support/local-database';
import type { Json } from '../src/lib/database.types';
// `money.ts` is pure too, so importing the formatter keeps this file's purity claim
// intact — and the price rollup is only checkable end to end through it.
import { formatMoney, type CurrencyCode } from '../src/lib/money';

/**
 * `src/lib/totals.ts` — the third file of the Ref 23 engine, and the only place in the
 * product where two weights are added together. Read that module's comment first: several
 * tests below exist to hold a decision it argues for in place, and will look arbitrary
 * without it. The LighterPack worn-weight defect has its own file
 * (tests/worn-weight-quantity.test.ts) and is deliberately not re-tested here.
 *
 * ---------------------------------------------------------------------------
 * A TABLE THAT LOOKS FULL AND EXERCISES ONE CLAUSE
 * ---------------------------------------------------------------------------
 *
 * tests/safe-next-path.test.ts documents the trap this suite had to be written against:
 * eight rejection cases, every one of them failing the FIRST check, so deleting the other
 * three rules left the suite green. The engine here has more rules than that and a
 * richer input, so the same care is spelled out case by case — the resolution-precedence
 * block in particular names, for each case, the rule that is the ONLY thing standing
 * between it and a different answer.
 *
 * Two of those are worth stating up front because they are the ones a plausible
 * re-implementation gets wrong while every other case stays green:
 *
 *   - "prefers the snapshot on a locked pack that still references live gear" is what
 *     decides the precedence. Every other resolution case here has exactly one of the two
 *     sources present, so an engine written the other way round — live gear preferred,
 *     the snapshot read only once the reference is gone — is a defensible-looking
 *     implementation, and this is the ONE case in this file that catches its arithmetic.
 *   - "merges overrides over the snapshot too" is the only case where an override sits on
 *     a frozen item. An engine that applied overrides only on the live-gear path passes
 *     every other override case here and fails this one alone.
 *
 * Both were confirmed the way that comment demands, rather than reasoned about: each rule
 * was actually broken in src/lib/totals.ts, the suite run, and the change reverted. What
 * that showed, exactly, and it is worth recording precisely because the obvious summary
 * is wrong:
 *
 *   - Inverting the base selection alone — `gear ?? snapshot` instead of
 *     `snapshot ?? gear` — turns exactly ONE case red, the precedence case (1 failed, 56
 *     passed as this file stands). Not two. "merges overrides over the snapshot too"
 *     survives it, because the override it applies (450 g) wins over whichever base was
 *     chosen, so the number it asserts is right for the wrong reason.
 *   - That second case only joins it when `source` is inverted too (2 failed, 55 passed).
 *     It is load-bearing for the `source` FIELD, not for the arithmetic — which is a
 *     genuine thing to pin, since `source` is what tells a reader a row is frozen, but it
 *     is not a second guard on the total.
 *   - Skipping the merge on the frozen path turns exactly that one case red (1 failed, 56
 *     passed) and nothing else, as claimed.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A gear row as the query embeds it. 100 g by default — the same weight
 * tests/support/fixtures.ts gives its first gear item, so a number seen in both files
 * means the same thing.
 *
 * `price` and `currency` are stated as an explicit null pair rather than left out. They
 * are required-but-nullable on `PackTreeGearItem`, so this fixture could not omit them
 * even if it wanted to — which is the property being relied on: a fixture that cannot
 * accidentally represent "the query forgot to fetch this" cannot accidentally assert
 * what the engine does with such a row either.
 */
function gear(overrides: Partial<PackTreeGearItem> = {}): PackTreeGearItem {
  return {
    name: 'Gear 1',
    // Grams, since PK-67 — there is no `weight_unit` to pair it with. Fixtures that used
    // to say `{ weight: 4.4, weight_unit: 'oz' }` now say the gram figure directly,
    // because the engine no longer converts and the conversion is not what they were
    // ever really about.
    weight_grams: 100,
    price: null,
    currency: null,
    ...overrides,
  };
}

/**
 * A pack item, defaulted to the shape PACK_TREE_SELECT returns: every flag present and
 * false, because `worn`, `consumable` and `packed` are all `boolean not null default
 * false` columns and that select fetches all three. There is no "absent flag" case
 * to default here any more — the type has no room for one.
 */
function packItem(overrides: Partial<PackTreeItem> = {}): PackTreeItem {
  return {
    id: 'item-1',
    quantity: 1,
    worn: false,
    consumable: false,
    packed: false,
    overrides: {},
    gear_items: gear(),
    ...overrides,
  };
}

function category(id: string, items: readonly PackTreeItem[], name = id): PackTreeCategory {
  return { id, name, pack_items: items };
}

function pack(categories: readonly PackTreeCategory[]): PackTreePack {
  return { pack_categories: categories };
}

/** One category holding one item — the shortest path to a total. */
function packOf(...items: readonly PackTreeItem[]): PackTreePack {
  return pack([category('category-1', items)]);
}

/**
 * A snapshot in the exact shape `private.gear_item_snapshot()` writes — every key that
 * function builds, including the two it deliberately does NOT capture being absent
 * (`notes` and `url`, per the migration: this is a display record, not an audit log).
 *
 * Typed `Json` rather than a hand-written interface on purpose: that is what the column
 * is and what `PackTreeItem` receives, so a fixture that only compiles against a narrower
 * type would be testing a boundary this engine does not actually have.
 */
function snapshot(overrides: { [key: string]: Json } = {}): Json {
  return {
    name: 'Gear 1',
    brand: 'Testbrand',
    category: null,
    description: null,
    // The KEY is `weight` while the gear COLUMN is `weight_grams`, and that mismatch is
    // the snapshot's own vocabulary rather than an error here — see `resolvePackItem`.
    // PK-67 removed the `weight_unit` key that used to sit beside this one and made the
    // value a gram figure; the key itself was deliberately left alone so that existing
    // `{"weight": ...}` overrides keep applying to frozen rows.
    weight: 100,
    price: null,
    currency: null,
    photo_path: null,
    gear_item_id: '00000000-0000-0000-0000-000000000001',
    captured_at: '2026-08-10T12:00:00+00:00',
    ...overrides,
  };
}

/** The exact gram values of the four units, re-typed rather than imported — see units.test.ts. */
const GRAMS = { g: 1, kg: 1000, oz: 28.349523125, lb: 453.59237 } as const;

// ---------------------------------------------------------------------------
// resolvePackItem — the precedence
// ---------------------------------------------------------------------------

describe('resolvePackItem', () => {
  // Rule 1: the reference, with nothing else in play. The baseline every other case in
  // this block differs from by exactly one thing.
  it('reads the live gear row when there is no snapshot and no override', () => {
    const resolved = resolvePackItem(
      packItem({ gear_items: gear({ weight_grams: 1.2 * GRAMS.kg }) }),
    );

    expect(resolved).toEqual({
      source: 'gear_item',
      name: 'Gear 1',
      weightGrams: 1200,
      price: null,
    });
  });

  // Rule 1's exception. Pins that overrides are merged at all.
  it('merges overrides over the live gear row', () => {
    const resolved = resolvePackItem(packItem({ overrides: { weight: 450 } }));

    expect(resolved.weightGrams).toBe(450);
    // The name is NOT in the override, so it still comes from the gear row: this is the
    // half of "merge" that a naive `overrides ?? gear` would get wrong by replacing the
    // whole record instead of the fields it names.
    expect(resolved.name).toBe('Gear 1');
  });

  // The merge is per-field in BOTH directions. This case replaces PK-67's deleted
  // "takes an overridden unit and the gear row's weight together", which pinned the same
  // property using a `weight_unit` override — a shape that no longer exists, because the
  // migration stripped that key from every `overrides` object and there is no unit to
  // override. The property itself is unchanged and still worth pinning: an override that
  // names ONE field must leave the others coming from the base, in both directions.
  it('takes an overridden name and the gear row’s weight together', () => {
    const resolved = resolvePackItem(
      packItem({
        gear_items: gear({ name: 'Gear 1', weight_grams: 2000 }),
        overrides: { name: 'Renamed for this pack' },
      }),
    );

    expect(resolved.name).toBe('Renamed for this pack');
    expect(resolved.weightGrams).toBe(2000);
  });

  it('takes an overridden weight and the gear row’s name together', () => {
    const resolved = resolvePackItem(
      packItem({
        gear_items: gear({ name: 'Gear 1', weight_grams: 2000 }),
        overrides: { weight: 450 },
      }),
    );

    expect(resolved.name).toBe('Gear 1');
    // 450 GRAMS, not 450 of some base unit. PK-67 changed what a bare `{"weight": n}`
    // override means, which is why the migration converted the ones that already existed
    // rather than leaving them to be reread — see resolvePackItem's own comment.
    expect(resolved.weightGrams).toBe(450);
  });

  // Rule 3: the gear is gone, the foreign key has nulled the reference, and the snapshot
  // is all that remains. Only this case fails if the snapshot path is never read at all.
  it('reads the snapshot when the gear item has been deleted', () => {
    const resolved = resolvePackItem(
      packItem({ gear_items: null, snapshot: snapshot({ name: 'Deleted tent', weight: 800 }) }),
    );

    expect(resolved).toEqual({
      source: 'snapshot',
      name: 'Deleted tent',
      weightGrams: 800,
      price: null,
    });
  });

  /**
   * THE PRECEDENCE CASE. A locked pack still references live gear — locking freezes the
   * values but only DELETING the gear nulls `gear_item_id` — so this is the one state
   * where both sources are present, and the only case in this file that distinguishes
   * "snapshot wins" from "gear wins".
   *
   * The evidence for which way round it goes is tests/core-schema.test.ts, "does not
   * follow later edits to the gear it froze": the gear is renamed after the lock and the
   * snapshot keeps the old name. Resolve the other way and this engine would silently
   * undo that freeze on the one surface a user can see it — while every schema test
   * stayed green, because the database would still be holding the frozen copy correctly.
   */
  it('prefers the snapshot on a locked pack that still references live gear', () => {
    const resolved = resolvePackItem(
      packItem({
        gear_items: gear({ name: 'Changed after the trip', weight_grams: 100 }),
        snapshot: snapshot({ name: 'Gear 1', weight: 900 }),
      }),
    );

    expect(resolved.source).toBe('snapshot');
    expect(resolved.weightGrams).toBe(900);
    expect(resolved.name).toBe('Gear 1');
  });

  /**
   * And overrides still apply on the frozen path — the argument for why is in
   * src/lib/totals.ts under "OVERRIDES ARE MERGED OVER THE SNAPSHOT TOO" and is not
   * restated here. What belongs here is what is specific to the case: it is the ONLY one
   * that catches a merge applied on the live-gear path alone, because "merges overrides
   * over the live gear row" above passes happily against exactly that implementation.
   */
  it('merges overrides over the snapshot too', () => {
    const resolved = resolvePackItem(
      packItem({
        gear_items: gear(),
        snapshot: snapshot({ weight: 900 }),
        overrides: { weight: 450 },
      }),
    );

    expect(resolved.source).toBe('snapshot');
    expect(resolved.weightGrams).toBe(450);
  });

  // `pack_items_reference_or_snapshot` makes this unrepresentable in the database, so
  // reaching it means a hand-built object or a select that omitted the embed — and the
  // message says exactly that rather than resolving to a zero-weight ghost.
  it('refuses an item with neither a gear item nor a snapshot', () => {
    expect(() => resolvePackItem(packItem({ gear_items: null }))).toThrow(
      /item-1.*neither a gear item nor a snapshot/s,
    );
  });

  /**
   * PK-67 replaced "converts through grams once, whatever unit the item is entered in".
   * There is no unit to convert from: `gear_items.weight_grams` is grams at rest and
   * `resolveWeightGrams` returns it untouched.
   *
   * That makes this the test for the property that REPLACED conversion — the engine must
   * pass the stored figure through EXACTLY, with no scaling, no rounding and no
   * re-derivation. Asserted with `toBe` rather than `toBeCloseTo` precisely because there
   * is no arithmetic left to lose precision to: any tolerance here would hide a stray
   * conversion factor, which is the one regression this test exists to catch.
   */
  it.each([0, 2, 100, 124.738, 1850, 453.59237])(
    'passes a stored gram figure (%s) through untouched',
    (grams) => {
      const resolved = resolvePackItem(packItem({ gear_items: gear({ weight_grams: grams }) }));
      expect(resolved.weightGrams).toBe(grams);
    },
  );
});

// ---------------------------------------------------------------------------
// resolvePackItem — the jsonb boundary
// ---------------------------------------------------------------------------

/**
 * "ABSENT IS A VALUE; MALFORMED IS A DEFECT" — the module comment's narrowing rule, case
 * by case, and the property the safe-next-path trap demands is that each row is refused
 * by a DIFFERENT clause rather than all of them piling onto the first.
 *
 * That is what the regexes are for: each names the message its own clause produces, so a
 * row that started failing somewhere earlier would fail this table rather than pass it
 * quietly. Two rows are refused before the merge happens at all — the non-object
 * snapshot and the array overrides, caught by the first and second statements of
 * `resolvePackItem` — and that is where they belong, since there is no merged record to
 * read a weight out of when the thing being merged is a number. Every other row gets past
 * the precedence rules with a perfectly good base to resolve from and is stopped only by
 * the narrowing of the field it names.
 */
describe('resolvePackItem refuses malformed overrides and snapshots', () => {
  const malformed: [label: string, item: PackTreeItem, expected: RegExp][] = [
    [
      'an override whose weight is a string',
      packItem({ overrides: { weight: 'heavy' } }),
      /weight of "heavy", which is not a finite number/,
    ],
    [
      // JSON null is not "no override": `gear_items.weight` is NOT NULL, so a null here
      // is a value someone wrote and cannot mean "fall back to the gear row".
      'an override whose weight is null',
      packItem({ overrides: { weight: null } }),
      /weight of null, which is not a finite number/,
    ],
    [
      'an override whose weight is NaN-shaped',
      packItem({ overrides: { weight: Number.NaN } }),
      /not a finite number/,
    ],
    [
      // PK-67 replaced "an override with an unknown weight unit" (`{ weight_unit: 'lbs' }`,
      // refused because a weight whose unit cannot be read has no conversion at all). There
      // is no unit to misspell now, and a stray `weight_unit` key is simply ignored rather
      // than refused — see the "malformed" note in this module's own comment for what that
      // costs and where it is paid instead.
      //
      // The case is replaced rather than dropped so this table keeps a row for the OVERRIDE
      // path specifically. A `weight` that is present and unreadable is still the defect it
      // always was, and this is now the only entry that reaches it through `overrides`
      // rather than through a snapshot — the distinction the table exists to keep separate.
      'an override with a non-numeric weight',
      packItem({ overrides: { weight: 'heavy' } }),
      /weight of "heavy", which is not a finite number/,
    ],
    [
      // The snapshot CHECK constraint only guarantees `captured_at` and a non-blank
      // `name`; a hand-written one can be missing the weight entirely.
      'a snapshot with no weight at all',
      packItem({ gear_items: null, snapshot: { name: 'Gear 1', captured_at: '2026-08-10' } }),
      /weight of undefined, which is not a finite number/,
    ],
    [
      'a snapshot that is not an object',
      packItem({ gear_items: null, snapshot: 5 }),
      /snapshot that is not a JSON object/,
    ],
    [
      'overrides that are an array rather than an object',
      packItem({ overrides: [1, 2] }),
      /overrides that are not a JSON object/,
    ],
    [
      'a price with no currency',
      packItem({ gear_items: gear({ price: 42.5, currency: null }) }),
      /not a three-letter ISO 4217 code/,
    ],
    [
      'a currency with no price',
      packItem({ gear_items: gear({ price: null, currency: 'GBP' }) }),
      /price of null/,
    ],
    [
      // The price side of "NaN-shaped", and NOT the same clause as the row above: null
      // is refused by `typeof price !== 'number'`, this one is a number and reaches
      // `!Number.isFinite`. Without it that half of the disjunction was unexercised —
      // delete it and NaN sails through to `fromDecimal`, which does throw, but with a
      // message that names no row at all. The weight side has had this case all along.
      'a price that is a number but not a finite one',
      packItem({ gear_items: gear({ price: Number.NaN, currency: 'GBP' }) }),
      /price of NaN with a currency of "GBP", which is not a finite number/,
    ],
    [
      'an override that removes only the currency',
      packItem({
        gear_items: gear({ price: 42.5, currency: 'GBP' }),
        overrides: { currency: null },
      }),
      /not a three-letter ISO 4217 code/,
    ],
    [
      // `gear_items.weight` is `check (weight >= 0 ...)`, but `overrides` is constrained
      // only to be a JSON object, so this is one ordinary PATCH away for the owner of an
      // unlocked pack. It passes every other rule in this function — finite, a number, a
      // known unit, an object — and is refused only by the sign check.
      'an override whose weight is negative',
      packItem({ overrides: { weight: -400 } }),
      /weight of -400, which is negative/,
    ],
    [
      // The same hole on the price side, mirroring `check (price >= 0 ...)`. Reached only
      // by the sign check: -1 is finite, is a number, and comes with a valid currency.
      'an override whose price is negative',
      packItem({
        gear_items: gear({ price: 42.5, currency: 'GBP' }),
        overrides: { price: -1 },
      }),
      /price of -1, which is negative/,
    ],
  ];

  it.each(malformed)('throws for %s', (_label, item, expected) => {
    expect(() => resolvePackItem(item)).toThrow(expected);
    // Every message names the row, because a pack holds forty of these and "value must be
    // a finite number" alone is not something a person can act on.
    expect(() => resolvePackItem(item)).toThrow(/item-1/);
  });

  /**
   * The deliberate exception. A name is display, not arithmetic — a blank name misleads
   * nobody about how much anything weighs, and taking down the public share page over a
   * bad string while a perfectly good weight sits next to it is the trade the module
   * comment argues against in the other direction.
   */
  it('resolves a non-string name to null rather than throwing', () => {
    expect(resolvePackItem(packItem({ overrides: { name: 42 } })).name).toBeNull();
  });

  // `overrides` is `not null default '{}'` in the schema, so this is unreachable through
  // the Data API — but the generated type permits it, and "no overrides" is the only
  // sane reading. Contrast with the array case above, which is a value someone wrote.
  it('treats null overrides as no overrides rather than a defect', () => {
    expect(resolvePackItem(packItem({ overrides: null })).weightGrams).toBe(100);
  });

  /**
   * WHY THE SIGN CHECK LIVES HERE AND NOT ONLY IN units.ts. `toGrams` refuses a negative
   * weight too, so deleting this module's check leaves the pack refused either way — and
   * the difference, which is the whole reason for the duplication the module comment
   * defends, is the message. `units.ts` can only say "value must not be negative, got
   * -400"; a pack holds forty rows and that names none of them.
   *
   * Asserted as two separate expectations rather than one combined regexp so a failure
   * says which half is missing: the refusal, or the row it happened on.
   */
  it('names the row a negative weight came from, not just the value', () => {
    const item = packItem({
      gear_items: gear({ name: 'Wool socks' }),
      overrides: { weight: -400 },
    });

    expect(() => resolvePackItem(item)).toThrow(/negative/);
    expect(() => resolvePackItem(item)).toThrow(/pack item item-1 \("Wool socks"\)/);
  });

  /**
   * And a name that is PRESENT but blank falls back to the bare id, which is the half of
   * `describeItem` the type system cannot state: `typeof name === 'string'` is true of
   * `'   '`, so without the `trim().length > 0` half the message reads
   * `pack item item-1 ("   ")` — an item that looks as though it were named something
   * invisible, in a message whose entire job is helping somebody find the row. `name text
   * not null check (length(btrim(name)) > 0)` refuses a blank name on the gear row, but
   * an override or a hand-written snapshot can carry one, which is how it arrives here.
   *
   * Asserted with an anchored regexp rather than a `not.toThrow`, so the test says which
   * string it wants rather than merely which one it does not.
   */
  it('names a blank-named item by its id alone, not by an empty pair of quotes', () => {
    const item = packItem({ gear_items: gear({ name: '   ' }), overrides: { weight: -400 } });

    expect(() => resolvePackItem(item)).toThrow(/^pack item item-1 resolved to a weight of/);
  });

  /**
   * The two failures that happen BEFORE there is a merged record to read a name out of.
   * Both had `describeItem(item.id, undefined)` hardcoded and so could never name
   * anything, while `item.gear_items.name` sat in scope one line above — which is the
   * case `describeItem` exists for in the first place.
   */
  it.each([
    ['a snapshot that is not an object', { snapshot: 5 as Json }],
    ['overrides that are not an object', { overrides: [1, 2] as Json }],
  ])('names the item from its live gear row when it has %s', (_label, broken) => {
    const item = packItem({ gear_items: gear({ name: 'Wool socks' }), ...broken });

    expect(() => resolvePackItem(item)).toThrow(/pack item item-1 \("Wool socks"\)/);
  });
});

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

describe('bucket classification', () => {
  // Ordered label, bucket, flags rather than label, flags, bucket so that both `%s` in
  // the title land on something a human reads — vitest fills them from the row in order,
  // and a title containing a printed object is a title nobody scans.
  const cases: [label: string, bucket: WeightBucket, flags: Partial<PackTreeItem>][] = [
    ['an item that is neither worn nor consumable', 'base', { worn: false, consumable: false }],
    ['a worn item', 'worn', { worn: true, consumable: false }],
    // There is no fourth row for "an item with no consumable flag at all". That case
    // used to be here, and used to land in base — which was the defect, not the
    // behaviour: `consumable` is a required boolean now, so a row that does not say is
    // a compile error rather than a pack whose food silently weighs as base weight.
    ['a consumable item', 'consumable', { worn: false, consumable: true }],
  ];

  it.each(cases)('puts %s in the %s bucket', (_label, bucket, flags) => {
    const totals = computeTotals(packOf(packItem(flags)));

    expect(totals[bucket]).toBe(100);
    // The other two are zero, so an implementation that counted an item in two buckets
    // could not pass — which is the same failure the both-flags refusal below prevents,
    // reached from the other side.
    for (const other of WEIGHT_BUCKETS) {
      if (other !== bucket) expect(totals[other]).toBe(0);
    }
  });

  /**
   * The refusal, on the read side. `pack_items_worn_consumable_exclusive` (added in the
   * same commit, and asserted in tests/core-schema.test.ts) stops this row existing at
   * rest — but the engine is a pure function over a shape, and the item below never went
   * near a database. That is the case this test is: input the constraint cannot reach.
   *
   * A precedence rule ("worn wins") would make the number silently disagree with what the
   * user ticked, so the message has to name the item and say what to do about it, because
   * only the person who ticked both can decide which one they meant.
   */
  it('refuses an item flagged both worn and consumable', () => {
    const both = packItem({
      worn: true,
      consumable: true,
      gear_items: gear({ name: 'Wool socks' }),
    });

    expect(() => computeTotals(packOf(both))).toThrow(/flagged both worn and consumable/);
    expect(() => computeTotals(packOf(both))).toThrow(/item-1.*Wool socks/s);
    expect(() => computeTotals(packOf(both))).toThrow(/clear one of the two flags/);
  });
});

// ---------------------------------------------------------------------------
// The partition
// ---------------------------------------------------------------------------

describe('base + worn + consumable === total', () => {
  /**
   * Mixed units in one pack, which is the case the grams-canonical claim is actually
   * about: four items entered in four different units, in three different buckets, in two
   * categories. An engine that summed the numbers as entered would produce a total that
   * is not merely imprecise but meaningless, and would still satisfy the partition — so
   * the identity is asserted alongside the value, not instead of it.
   */
  const mixed = pack([
    category('worn-and-base', [
      packItem({
        id: 'boots',
        quantity: 1,
        worn: true,
        gear_items: gear({ weight_grams: 1.1 * GRAMS.lb }),
      }),
      packItem({ id: 'tent', quantity: 1, gear_items: gear({ weight_grams: 1.2 * GRAMS.kg }) }),
    ]),
    category('food', [
      packItem({
        id: 'oats',
        quantity: 3,
        consumable: true,
        gear_items: gear({ weight_grams: 4.4 * GRAMS.oz }),
      }),
      packItem({ id: 'stove', quantity: 2, gear_items: gear({ weight_grams: 85 }) }),
    ]),
  ]);

  it('holds exactly, with four units in one pack', () => {
    const totals = computeTotals(mixed);

    // Exact equality, not toBeCloseTo: `total` is DEFINED as this sum rather than
    // accumulated separately, so any tolerance here would be admitting the possibility
    // the definition exists to remove.
    expect(totals.base + totals.worn + totals.consumable).toBe(totals.total);
  });

  it('converts every unit to grams before adding anything', () => {
    const totals = computeTotals(mixed);

    expect(totals.worn).toBeCloseTo(1.1 * GRAMS.lb, 9);
    expect(totals.base).toBeCloseTo(1.2 * GRAMS.kg + 2 * 85, 9);
    expect(totals.consumable).toBeCloseTo(3 * 4.4 * GRAMS.oz, 9);
    expect(totals.total).toBeCloseTo(1.1 * GRAMS.lb + 1.2 * GRAMS.kg + 170 + 3 * 4.4 * GRAMS.oz, 9);
  });

  it('holds for every category as well as for the pack', () => {
    const totals = computeTotals(mixed);

    for (const each of totals.categories) {
      expect(each.base + each.worn + each.consumable).toBe(each.total);
    }
    // And the categories sum to the pack, which is structural for the same reason: the
    // pack's buckets ARE the sum of the categories' buckets, not a second pass.
    for (const bucket of WEIGHT_BUCKETS) {
      const summed = totals.categories.reduce((sum, each) => sum + each[bucket], 0);
      expect(summed).toBe(totals[bucket]);
    }
  });

  /**
   * THE CASE THE PARTITION CANNOT CATCH, which is why it is asserted here rather than
   * left to the refusal table above. A negative line lands in exactly one bucket like any
   * other, so `base + worn + consumable === total` stays TRUE while every number in it is
   * wrong: two 1000 g items, one overridden to -400 g, and the pack claims 600 g — a
   * plausible figure, adding up perfectly, with nothing on the page to distinguish it
   * from the truth. The identity is asserted here too, to say plainly that it would have
   * held; the refusal is what stops the number existing.
   */
  it('refuses a negative line rather than subtracting it from an otherwise valid pack', () => {
    const withNegativeLine = packOf(
      packItem({ id: 'tent', gear_items: gear({ weight_grams: 1000 }) }),
      packItem({
        id: 'quilt',
        gear_items: gear({ name: 'Quilt', weight_grams: 1000 }),
        overrides: { weight: -400 },
      }),
    );

    expect(() => computeTotals(withNegativeLine)).toThrow(/negative/);
    expect(() => computeTotals(withNegativeLine)).toThrow(/quilt.*Quilt/s);

    // The same pack with the sign flipped is accepted and totals 1400 g, so what this
    // test refuses is the SIGN and nothing else about the shape of the row — and it puts
    // the two numbers side by side: 1400 g for `{"weight": 400}`, 600 g for
    // `{"weight": -400}`, neither of which looks wrong on its own.
    const positive = packOf(
      packItem({ id: 'tent', gear_items: gear({ weight_grams: 1000 }) }),
      packItem({
        id: 'quilt',
        gear_items: gear({ name: 'Quilt', weight_grams: 1000 }),
        overrides: { weight: 400 },
      }),
    );
    expect(computeTotals(positive).total).toBe(1400);
  });
});

// ---------------------------------------------------------------------------
// Rollups
// ---------------------------------------------------------------------------

describe('category and per-item rollups', () => {
  /**
   * A category whose items span units — the rollup has to convert before it adds, exactly
   * as the pack total does, and a category that summed raw entered numbers would be wrong
   * on its own line while the pack total above it stayed right.
   */
  it('rolls a category up across mixed units', () => {
    const totals = computeTotals(
      pack([
        category('mixed', [
          packItem({ id: 'a', gear_items: gear({ weight_grams: 8 * GRAMS.oz }) }),
          packItem({ id: 'b', gear_items: gear({ weight_grams: 0.5 * GRAMS.kg }) }),
        ]),
        category('plain', [packItem({ id: 'c', gear_items: gear({ weight_grams: 30 }) })]),
      ]),
    );

    const [mixed, plain] = totals.categories;
    expect(mixed.id).toBe('mixed');
    expect(mixed.total).toBeCloseTo(8 * GRAMS.oz + 500, 9);
    expect(plain.total).toBe(30);
    expect(totals.total).toBeCloseTo(mixed.total + plain.total, 9);
  });

  it('gives each item its own resolved weight and its line weight', () => {
    const totals = computeTotals(
      packOf(
        packItem({
          id: 'socks',
          quantity: 2,
          worn: true,
          packed: true,
          gear_items: gear({
            name: 'Wool socks',
            weight_grams: 1.5 * GRAMS.oz,
            price: 12.5,
            currency: 'GBP',
          }),
        }),
      ),
    );

    const [item] = totals.categories[0].items;
    expect(item).toMatchObject({
      id: 'socks',
      name: 'Wool socks',
      source: 'gear_item',
      bucket: 'worn',
      quantity: 2,
      packed: true,
    });
    // Both weights, because a template that has to derive the line from the unit is a
    // template that can derive it wrongly — which is the whole subject of
    // tests/worn-weight-quantity.test.ts.
    expect(item.unitWeightGrams).toBeCloseTo(1.5 * GRAMS.oz, 9);
    expect(item.lineWeightGrams).toBeCloseTo(2 * 1.5 * GRAMS.oz, 9);
    expect(item.unitPrice).toEqual({ amountMinorUnits: 1250, currency: 'GBP' });
    expect(item.linePrice).toEqual({ amountMinorUnits: 2500, currency: 'GBP' });
  });

  it('reports the source of every item, so a frozen row is visible as one', () => {
    const totals = computeTotals(
      packOf(
        packItem({ id: 'live' }),
        packItem({ id: 'frozen', gear_items: null, snapshot: snapshot() }),
      ),
    );

    expect(totals.categories[0].items.map((item) => item.source)).toEqual([
      'gear_item',
      'snapshot',
    ]);
  });

  /**
   * A ZERO-WEIGHT ITEM IS AN ITEM. `gear_items.weight` is `not null default 0`, so a row
   * somebody has not weighed yet — or a stuff sack they genuinely count as nothing — is
   * an ordinary, reachable value rather than a stand-in for "unknown", which is exactly
   * the distinction units.ts's "THROW, NOT RETURN" section turns on.
   *
   * It is worth a case of its own because zero is the one weight a truthiness test would
   * silently reclassify: a guard written `if (!weight) throw` instead of
   * `!Number.isFinite(weight)`, or a filter dropping falsy lines, refuses or discards this
   * item while every other assertion in this file stays green — and the item vanishes from
   * `itemCount` too, so the pack quietly lists fewer things than it holds.
   */
  it('counts a zero-weight item rather than dropping it', () => {
    const totals = computeTotals(
      packOf(
        packItem({ id: 'stuff-sack', quantity: 2, gear_items: gear({ weight_grams: 0 }) }),
        packItem({ id: 'tent', gear_items: gear({ weight_grams: 1000 }) }),
      ),
    );

    expect(totals.total).toBe(1000);
    expect(totals.itemCount).toBe(3);
    const [sack] = totals.categories[0].items;
    expect(sack.unitWeightGrams).toBe(0);
    expect(sack.lineWeightGrams).toBe(0);
  });

  it('keeps a category with no items, rolled up to zeroes', () => {
    const totals = computeTotals(pack([category('empty', []), category('full', [packItem()])]));

    // Not skipped: an empty category is a heading somebody made and has not filled in, and
    // a caller rendering the tree needs a row for it.
    expect(totals.categories).toHaveLength(2);
    expect(totals.categories[0]).toMatchObject({
      id: 'empty',
      total: 0,
      base: 0,
      worn: 0,
      consumable: 0,
      itemCount: 0,
      packedCount: 0,
    });
    expect(totals.categories[0].items).toEqual([]);
    expect(totals.total).toBe(100);
  });

  it('returns zeroes and nothing else for an empty pack', () => {
    const totals = computeTotals(pack([]));

    expect(totals).toEqual({
      total: 0,
      base: 0,
      worn: 0,
      consumable: 0,
      itemCount: 0,
      packedCount: 0,
      categories: [],
      // Not a zero in some assumed currency: an empty pack has no total to report in any
      // currency at all. See sumByCurrency in src/lib/money.ts.
      pricesByCurrency: new Map(),
    });
  });
});

// ---------------------------------------------------------------------------
// Counts
// ---------------------------------------------------------------------------

/**
 * Quantities, not rows — the ambiguity the module comment resolves, tested with
 * quantities above one so the choice is visible rather than incidental. Every count in
 * this block would be a different number under the row-counting reading, which is the
 * point: a suite where every quantity is 1 cannot tell the two apart.
 */
describe('itemCount and packedCount', () => {
  const counted = pack([
    category('shelter', [
      packItem({ id: 'stakes', quantity: 8, packed: true }),
      packItem({ id: 'tent', quantity: 1, packed: false }),
    ]),
    category('worn', [packItem({ id: 'socks', quantity: 2, worn: true, packed: true })]),
  ]);

  it('sums quantities rather than counting pack_item rows', () => {
    const totals = computeTotals(counted);

    // Three rows, eleven items. Under the rejected reading this is 3.
    expect(totals.itemCount).toBe(11);
    expect(totals.categories.map((each) => each.itemCount)).toEqual([9, 2]);
  });

  /**
   * `packed` is a boolean on a row of quantity N, so a partially-packed row is not
   * representable: the count moves by the whole quantity or not at all. Ten here, not
   * two rows and not "some of the stakes".
   */
  it('counts the whole quantity of a packed row, because half a row cannot be packed', () => {
    const totals = computeTotals(counted);

    expect(totals.packedCount).toBe(10);
    expect(totals.categories.map((each) => each.packedCount)).toEqual([8, 2]);
  });

  // An unpacked row contributes its quantity to itemCount and nothing to packedCount, so
  // the two counts are genuinely independent rather than one being derived from the other.
  it('counts an unpacked row’s quantity as items but not as packed', () => {
    const totals = computeTotals(packOf(packItem({ quantity: 4, packed: false })));

    expect(totals.itemCount).toBe(4);
    expect(totals.packedCount).toBe(0);
  });

  /**
   * `quantity integer not null check (quantity > 0)`, mirrored rather than trusted. Zero
   * is the dangerous one: it silently removes an item from a pack that still lists it,
   * and every other assertion in this file would stay green.
   */
  it.each([
    ['zero', 0],
    ['a negative quantity', -2],
    ['a fractional quantity', 1.5],
  ])('refuses %s', (_label, quantity) => {
    expect(() => computeTotals(packOf(packItem({ quantity })))).toThrow(/quantity of/);
  });
});

// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------

/**
 * The per-currency rollup, over a genuinely mixed pack. `money.ts` has no `sum(): Money`
 * and must never grow one — see its "CROSS-CURRENCY SUMMING IS IMPOSSIBLE" section — so
 * what is asserted here is a map with one entry per currency actually present.
 */
describe('price rollups', () => {
  const priced = pack([
    category('sleep', [
      // 42.50 is the case the units boundary exists for: `gear_items.price` is
      // numeric(12, 2), a DECIMAL major-unit value, and `money.ts` holds MINOR units.
      // Passing it straight to makeMoney would store 42.5 minor units — 43p — and look
      // entirely plausible on the page.
      packItem({ id: 'quilt', quantity: 1, gear_items: gear({ price: 42.5, currency: 'GBP' }) }),
      packItem({ id: 'mat', quantity: 2, gear_items: gear({ price: 10, currency: 'GBP' }) }),
    ]),
    category('cook', [
      packItem({ id: 'stove', quantity: 1, gear_items: gear({ price: 99.99, currency: 'USD' }) }),
      // A zero-decimal currency, so a hardcoded × 100 anywhere in the chain turns ¥500
      // into ¥50,000. `fromDecimal` asks Intl rather than assuming.
      packItem({ id: 'pot', quantity: 1, gear_items: gear({ price: 500, currency: 'JPY' }) }),
      // No price at all: contributes nothing, rather than zero of some assumed currency.
      packItem({ id: 'spork', quantity: 1, gear_items: gear() }),
    ]),
  ]);

  it('keeps one total per currency and never adds two together', () => {
    const totals = computeTotals(priced);

    // Each value is a `Money`, not a bare minor-unit number. The currency in the KEY is
    // not enough: a caller iterating the entries holds the amount, and an amount whose
    // scale lives only in a doc comment renders as £4250 for £42.50 the first time
    // somebody writes `£{{ total }}`. See "THE VALUES ARE `Money`" in src/lib/money.ts.
    expect(Object.fromEntries(totals.pricesByCurrency)).toEqual({
      GBP: { amountMinorUnits: 4250 + 2 * 1000, currency: 'GBP' },
      USD: { amountMinorUnits: 9999, currency: 'USD' },
      JPY: { amountMinorUnits: 500, currency: 'JPY' },
    });
  });

  /**
   * The same fact from the rendering end, which is where it is actually paid for: a total
   * taken straight out of this map and handed to `formatMoney` comes out at the right
   * scale, with no call-site arithmetic in between. A map of bare numbers cannot even be
   * passed to `formatMoney` — that is the point — so this is what a caller now does
   * instead of dividing by a hundred it had to know about.
   */
  it('yields totals a formatter can render without the caller rescaling anything', () => {
    const totals = computeTotals(priced);

    const gbp = totals.pricesByCurrency.get('GBP' as CurrencyCode);
    expect(gbp).toBeDefined();
    // No whitespace normalisation needed: en-GB renders its own currency with the
    // symbol adjacent to the digits, which money.test.ts's own GBP rows pin.
    expect(formatMoney(gbp!)).toBe('£62.50');
  });

  it('multiplies price by quantity, exactly as weight is multiplied', () => {
    const [sleep] = computeTotals(priced).categories;

    expect(Object.fromEntries(sleep.pricesByCurrency)).toEqual({
      GBP: { amountMinorUnits: 4250 + 2000, currency: 'GBP' },
    });
  });

  /**
   * The same separation ONE LEVEL DOWN. `sleep` above holds a single currency and the
   * pack-level map is asserted elsewhere, so between them they leave a gap exactly the
   * size of a bug that collapses currencies per category and not per pack: `cook` is the
   * only mixed category in this file, and until this case nothing read its own map at all.
   */
  it('keeps a mixed-currency category’s own rollup separated, not only the pack’s', () => {
    const [, cook] = computeTotals(priced).categories;

    expect(Object.fromEntries(cook.pricesByCurrency)).toEqual({
      USD: { amountMinorUnits: 9999, currency: 'USD' },
      JPY: { amountMinorUnits: 500, currency: 'JPY' },
    });
  });

  /**
   * MINOR UNITS ARE INTEGERS ALL THE WAY OUT TO THE MAP, which two comments in
   * src/lib/totals.ts already reason FROM: a line price "needs no rounding of its own"
   * because an integer times an integer quantity stays one, and the per-currency addition
   * is exact because integers add exactly.
   *
   * £1.10 is what makes this a test rather than a restatement. Every other price in this
   * repository is exactly representable once multiplied by 100; `1.1 * 100` is
   * `110.00000000000001`, and three of them come to `330.00000000000006`. `fromDecimal`
   * rounds, so what reaches the map is 110 and 330 — and if it ever stopped rounding,
   * `makeMoney` would refuse the amount outright rather than let a fractional "minor unit"
   * into a total. Both halves are asserted: the value, and its integrality.
   */
  it('keeps minor units integral for a price that is not exact in binary', () => {
    const totals = computeTotals(
      packOf(
        packItem({ id: 'gel', quantity: 3, gear_items: gear({ price: 1.1, currency: 'GBP' }) }),
        packItem({ id: 'bar', quantity: 1, gear_items: gear({ price: 1.1, currency: 'GBP' }) }),
      ),
    );

    expect(Object.fromEntries(totals.pricesByCurrency)).toEqual({
      GBP: { amountMinorUnits: 440, currency: 'GBP' },
    });
    for (const money of totals.pricesByCurrency.values()) {
      expect(Number.isInteger(money.amountMinorUnits)).toBe(true);
    }
    // And it renders as the four pounds forty it is, rather than as £4.40000000000000x.
    expect(formatMoney(totals.pricesByCurrency.get('GBP' as CurrencyCode)!)).toBe('£4.40');
  });

  it('leaves an unpriced item out of the rollup entirely', () => {
    const totals = computeTotals(packOf(packItem({ gear_items: gear() })));

    expect(totals.pricesByCurrency.size).toBe(0);
    expect(totals.categories[0].items[0].linePrice).toBeNull();
  });

  // An explicit null pair is the same thing as an absent one — that is what
  // `(price is null) = (currency is null)` guarantees a row looks like when it is
  // unpriced, and a column the query did not select looks identical once serialised.
  it('treats an explicit null price and currency as unpriced', () => {
    const totals = computeTotals(
      packOf(packItem({ gear_items: gear({ price: null, currency: null }) })),
    );

    expect(totals.pricesByCurrency.size).toBe(0);
  });

  it('prices a frozen item from its snapshot', () => {
    const totals = computeTotals(
      packOf(
        packItem({
          gear_items: null,
          snapshot: snapshot({ price: 42.5, currency: 'GBP' }),
          quantity: 2,
        }),
      ),
    );

    expect(Object.fromEntries(totals.pricesByCurrency)).toEqual({
      GBP: { amountMinorUnits: 8500, currency: 'GBP' },
    });
  });

  /**
   * THE MIXED PACK: most items live, one frozen, all of them priced. This is the shape a
   * real pack takes the moment one gear item is deleted — the BEFORE DELETE trigger
   * snapshots that row alone, and `private.gear_item_snapshot()` captures `price` and
   * `currency` whether or not the select asked for them.
   *
   * It is the shape that produced the wrong number this suite previously had no case for.
   * With `price` optional on the input type and unfetched by PACK_TREE_SELECT, the three
   * live rows arrived with no price key at all and the frozen one arrived with £42.50, so
   * the rollup reported `{ GBP: 4250 }` for a pack costing £142.50 — not a total that was
   * missing, a total that was confidently wrong, and one no assertion in this file could
   * have distinguished from a pack holding only that item.
   *
   * The fields are required now, so a fixture cannot express the broken half of that any
   * more; what this pins is the arithmetic it should have produced all along, on both
   * sources at once, with the per-item `source` asserted so the mixture is real rather
   * than nominally so.
   */
  it('sums prices across live gear and frozen snapshots in the same pack', () => {
    const totals = computeTotals(
      packOf(
        packItem({ id: 'tent', gear_items: gear({ price: 50, currency: 'GBP' }) }),
        packItem({ id: 'mat', gear_items: gear({ price: 25, currency: 'GBP' }), quantity: 2 }),
        packItem({
          id: 'deleted-quilt',
          gear_items: null,
          snapshot: snapshot({ name: 'Deleted quilt', price: 42.5, currency: 'GBP' }),
        }),
      ),
    );

    expect(totals.categories[0].items.map((item) => item.source)).toEqual([
      'gear_item',
      'gear_item',
      'snapshot',
    ]);
    expect(Object.fromEntries(totals.pricesByCurrency)).toEqual({
      GBP: { amountMinorUnits: 5000 + 2 * 2500 + 4250, currency: 'GBP' },
    });
  });
});

// ---------------------------------------------------------------------------
// The input shape
// ---------------------------------------------------------------------------

/**
 * The engine must consume what the one pack-tree select actually fetches, without a
 * hand-written reshaping step in between — that transcription is precisely where a `worn`
 * flag gets dropped on the way from the query to the arithmetic. (`PACK_TREE_SELECT`
 * lives in tests/support/ for now, because the share page that will issue it is Ref 26
 * and does not exist yet; this assertion moves with it when it moves.)
 *
 * Both halves are asserted. The compile-time half below is the load-bearing one, and it
 * now fires in BOTH directions: with no optional properties left on the input types, it
 * fails `tsc --noEmit` if `PACK_TREE_SELECT` is narrowed (a missing column is a missing
 * required property) as well as if the engine grows a field the select does not fetch.
 * Before the four flag and price fields were made required it could only catch the
 * second, which is why a select that had never fetched `consumable` or `price` compiled
 * happily for as long as it did.
 *
 * The runtime half is a literal in the exact shape PostgREST returns — a to-one
 * `gear_items` embed as an OBJECT (core-schema.test.ts pins that against the wire
 * format), embedded arrays for the to-many ones, and every column the select names,
 * including the four whose absence used to be the interesting case.
 */
describe('the shape PACK_TREE_SELECT returns', () => {
  type PackTreeRow = NonNullable<Awaited<ReturnType<typeof packTreeQuery>>['data']>[number];

  // If this ever resolves to `never` or to a PostgREST parser error, the assignment below
  // would pass vacuously; naming the property keeps that honest.
  type _CategoriesAreEmbedded = PackTreeRow['pack_categories'];

  // The assertion itself: a function accepting the query's row type, satisfied by
  // computeTotals. Contravariance means this only compiles if PackTreeRow is assignable
  // to PackTreePack.
  const _acceptsQueryRows: (row: PackTreeRow) => PackTotals = computeTotals;

  it('totals a row in exactly the shape PACK_TREE_SELECT returns', () => {
    const row = {
      id: 'pack-1',
      name: 'Test pack',
      slug: 'testpack1234',
      visibility: 'public',
      locked_at: null,
      pack_categories: [
        {
          id: 'category-1',
          name: 'Shelter',
          position: 0,
          pack_items: [
            {
              id: 'item-1',
              quantity: 2,
              worn: false,
              consumable: false,
              packed: true,
              position: 0,
              overrides: {},
              snapshot: null,
              gear_items: {
                id: 'gear-1',
                name: 'Gear 1',
                brand: 'Testbrand',
                weight_grams: 100,
                price: 42.5,
                currency: 'GBP',
              },
            },
            {
              id: 'item-2',
              quantity: 1,
              worn: false,
              consumable: true,
              packed: false,
              position: 1,
              overrides: {},
              snapshot: null,
              gear_items: {
                id: 'gear-2',
                name: 'Oats',
                brand: 'Testbrand',
                weight_grams: 4.4 * GRAMS.oz,
                price: null,
                currency: null,
              },
            },
          ],
        },
      ],
    };

    const totals = computeTotals(row);

    expect(totals.base).toBe(200);
    expect(totals.itemCount).toBe(3);
    // The consequence of the widened select, stated rather than left to be discovered:
    // the consumable item's weight lands in its own bucket instead of in base, the packed
    // row is counted, and the pack has a price. Every one of these four numbers was the
    // other answer — 0, 0, everything in base — while the select fetched five columns
    // fewer, and none of them looked wrong.
    expect(totals.consumable).toBeCloseTo(4.4 * GRAMS.oz, 9);
    expect(totals.packedCount).toBe(2);
    expect(Object.fromEntries(totals.pricesByCurrency)).toEqual({
      GBP: { amountMinorUnits: 8500, currency: 'GBP' },
    });
  });
});
