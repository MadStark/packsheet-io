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
 *     implementation that this file catches in exactly two places and nowhere else.
 *   - "merges overrides over the snapshot too" is the only case where an override sits on
 *     a frozen item, and is the second of those two places. An engine that applied
 *     overrides only on the live-gear path passes every other override case here.
 *
 * Both were confirmed the way that comment demands, rather than reasoned about: each rule
 * was actually broken in src/lib/totals.ts — the precedence inverted, then the merge
 * skipped on the frozen path — the suite run, exactly the named cases seen to go red (2
 * failed, 50 passed; then 1 failed, 51 passed), and the change reverted.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A gear row as the query embeds it. 100 g by default — the same weight
 * tests/support/fixtures.ts gives its first gear item, so a number seen in both files
 * means the same thing.
 */
function gear(overrides: Partial<PackTreeGearItem> = {}): PackTreeGearItem {
  return { name: 'Gear 1', weight: 100, weight_unit: 'g', ...overrides };
}

/**
 * A pack item, defaulted to the shape today's share-page select actually returns:
 * `consumable` and `packed` absent rather than `false`, because that is what a row looks
 * like when the column was not selected, and the engine's reading of an absent flag is a
 * decision this suite should be exercising by default rather than in one special case.
 */
function packItem(overrides: Partial<PackTreeItem> = {}): PackTreeItem {
  return {
    id: 'item-1',
    quantity: 1,
    worn: false,
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
    weight: 100,
    weight_unit: 'g',
    price: null,
    currency: null,
    volume_litres: null,
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
      packItem({ gear_items: gear({ weight: 1.2, weight_unit: 'kg' }) }),
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

  // The merge is per-field in BOTH directions. Only this case fails if the unit is read
  // from the base whenever the override omits a weight, or vice versa — an override of
  // the unit alone re-denominates the gear row's own number.
  it('takes an overridden unit and the gear row’s weight together', () => {
    const resolved = resolvePackItem(
      packItem({
        gear_items: gear({ weight: 2, weight_unit: 'g' }),
        overrides: { weight_unit: 'kg' },
      }),
    );

    expect(resolved.weightGrams).toBe(2000);
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
        gear_items: gear({ name: 'Changed after the trip', weight: 100 }),
        snapshot: snapshot({ name: 'Gear 1', weight: 900 }),
      }),
    );

    expect(resolved.source).toBe('snapshot');
    expect(resolved.weightGrams).toBe(900);
    expect(resolved.name).toBe('Gear 1');
  });

  /**
   * And overrides still apply on the frozen path. The snapshot captures the GEAR row, not
   * the pack item, so an engine that skipped the merge here would make a pack change its
   * own total at the moment it was locked — 450 g jumping back to the closet's 100 g as a
   * side effect of being frozen for posterity.
   *
   * Only this case catches that: "merges overrides over the live gear row" above passes
   * happily against an implementation that merges on one path only.
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

  it('converts through grams once, whatever unit the item is entered in', () => {
    for (const [unit, factor] of Object.entries(GRAMS)) {
      const resolved = resolvePackItem(
        packItem({ gear_items: gear({ weight: 2, weight_unit: unit }) }),
      );
      expect(resolved.weightGrams).toBeCloseTo(2 * factor, 9);
    }
  });
});

// ---------------------------------------------------------------------------
// resolvePackItem — the jsonb boundary
// ---------------------------------------------------------------------------

/**
 * "ABSENT IS A VALUE; MALFORMED IS A DEFECT" — the module comment's narrowing rule, case
 * by case. Every row here gets PAST the precedence rules above (there is a base to
 * resolve from) and is refused only by the narrowing, which is the property the
 * safe-next-path trap demands: none of these is caught by an earlier check.
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
      // The near-miss a human types without a picker: refused exactly as a bare typo is,
      // because a weight whose unit cannot be read has no conversion at all.
      'an override with an unknown weight unit',
      packItem({ overrides: { weight_unit: 'lbs' } }),
      /weight unit of "lbs"/,
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
      'an override that removes only the currency',
      packItem({
        gear_items: gear({ price: 42.5, currency: 'GBP' }),
        overrides: { currency: null },
      }),
      /not a three-letter ISO 4217 code/,
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
    ['a consumable item', 'consumable', { worn: false, consumable: true }],
    // The share page's select does not fetch `consumable` at all, so "absent" is the
    // everyday shape rather than an exotic one, and reading it as false is a decision
    // rather than an accident. See the KNOWN GAP in the module comment.
    ['an item with no consumable flag at all', 'base', { worn: false }],
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
   * The refusal. Two independent booleans with no CHECK constraint coupling them means
   * the database permits this row today, and a precedence rule ("worn wins") would make
   * the number silently disagree with what the user ticked. The message has to name the
   * item and say what to do about it, because only the person who ticked both can decide
   * which one they meant.
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
        gear_items: gear({ weight: 1.1, weight_unit: 'lb' }),
      }),
      packItem({ id: 'tent', quantity: 1, gear_items: gear({ weight: 1.2, weight_unit: 'kg' }) }),
    ]),
    category('food', [
      packItem({
        id: 'oats',
        quantity: 3,
        consumable: true,
        gear_items: gear({ weight: 4.4, weight_unit: 'oz' }),
      }),
      packItem({ id: 'stove', quantity: 2, gear_items: gear({ weight: 85, weight_unit: 'g' }) }),
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
          packItem({ id: 'a', gear_items: gear({ weight: 8, weight_unit: 'oz' }) }),
          packItem({ id: 'b', gear_items: gear({ weight: 0.5, weight_unit: 'kg' }) }),
        ]),
        category('plain', [packItem({ id: 'c', gear_items: gear({ weight: 30 }) })]),
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
            weight: 1.5,
            weight_unit: 'oz',
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

  // Absent, like `consumable`, because the share page's select does not fetch it.
  it('treats an absent packed flag as not packed', () => {
    expect(computeTotals(packOf(packItem({ quantity: 4 }))).packedCount).toBe(0);
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

    expect(Object.fromEntries(totals.pricesByCurrency)).toEqual({
      GBP: 4250 + 2 * 1000,
      USD: 9999,
      JPY: 500,
    });
  });

  it('multiplies price by quantity, exactly as weight is multiplied', () => {
    const [sleep] = computeTotals(priced).categories;

    expect(Object.fromEntries(sleep.pricesByCurrency)).toEqual({ GBP: 4250 + 2000 });
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

    expect(Object.fromEntries(totals.pricesByCurrency)).toEqual({ GBP: 8500 });
  });
});

// ---------------------------------------------------------------------------
// The input shape
// ---------------------------------------------------------------------------

/**
 * The engine must consume what the application actually fetches, without a hand-written
 * reshaping step in between — that transcription is precisely where a `worn` flag gets
 * dropped on the way from the query to the arithmetic.
 *
 * Both halves are asserted. The compile-time half below is the load-bearing one: it fails
 * `tsc --noEmit` if `PACK_TREE_SELECT`'s inferred row type stops being assignable to
 * `PackTreePack`, which is what would happen the day somebody narrows the select. The
 * runtime half is a literal in the exact shape PostgREST returns — a to-one `gear_items`
 * embed as an OBJECT (core-schema.test.ts pins that against the wire format), embedded
 * arrays for the to-many ones, and no `consumable`, `packed`, `price` or `currency` keys,
 * because that select does not ask for them.
 */
describe('the shape the share page already fetches', () => {
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
              position: 0,
              overrides: {},
              snapshot: null,
              gear_items: {
                id: 'gear-1',
                name: 'Gear 1',
                brand: 'Testbrand',
                weight: 100,
                weight_unit: 'g',
              },
            },
          ],
        },
      ],
    };

    const totals = computeTotals(row);

    expect(totals.total).toBe(200);
    expect(totals.base).toBe(200);
    expect(totals.itemCount).toBe(2);
    // The consequence of that select, stated rather than left to be discovered: with no
    // `consumable`, `packed`, `price` or `currency` column fetched, everything lands in
    // base, nothing is packed, and there is no price rollup at all.
    expect(totals.packedCount).toBe(0);
    expect(totals.pricesByCurrency.size).toBe(0);
  });
});
