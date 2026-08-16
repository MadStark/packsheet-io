import { describe, expect, it } from 'vitest';
import {
  GRAMS_PER_UNIT,
  WEIGHT_DECIMALS,
  WEIGHT_UNITS,
  convertWeight,
  fromGrams,
  isWeightUnit,
  roundWeight,
  toGrams,
  type WeightUnit,
} from '../src/lib/units';

/**
 * `src/lib/units.ts` is the whole weight engine: no I/O, so everything about it is
 * pinned here rather than partly in an integration suite. Read that file's module
 * comment first — in particular "GRAMS IS THE CANONICAL UNIT" and "THROW, NOT RETURN"
 * — because several tests below exist specifically to hold those two decisions in
 * place rather than to restate what the code plainly does.
 *
 * The exact conversion factors (`kg` = 1000, `oz` = 28.349523125, `lb` = 453.59237)
 * are re-typed here as literals rather than imported from `GRAMS_PER_UNIT`, except
 * where a test is deliberately checking that constant itself. Importing them for the
 * conversion-table test would make that test tautological — it would pass even if a
 * factor in the source were wrong, because it would be checking the constant against
 * itself. Typing the four values out independently means a transposed digit in
 * `units.ts` is a real, catchable bug rather than an invisible one.
 */

const FACTORS: Readonly<Record<WeightUnit, number>> = {
  g: 1,
  kg: 1000,
  oz: 28.349523125,
  lb: 453.59237,
};

// Four kinds of value the round-trip and conversion-table tests each exercise: zero
// (the additive identity, and the one value every factor maps to itself), a value
// carrying all three decimal places `numeric(12, 3)` allows, a very small value where
// a division-then-multiplication round trip has the least room to drift, and a value
// at the top of what that column can store (12 total digits: 9 integer + 3 decimal).
const WEIGHT_VALUES = [0, 12.345, 0.001, 999_999_999.999];

// Every ordered (from, to) pair, generated from WEIGHT_UNITS itself rather than
// hand-listed, so a fifth unit added to that array automatically gains a row here
// instead of silently leaving a gap in the table.
const UNIT_PAIRS: readonly (readonly [WeightUnit, WeightUnit])[] = WEIGHT_UNITS.flatMap((from) =>
  WEIGHT_UNITS.map((to) => [from, to] as const),
);

describe('WEIGHT_UNITS and isWeightUnit', () => {
  // Pins the CHECK constraint in supabase/migrations/20260810120000_core_schema.sql
  // literally: `check (weight_unit in ('g', 'kg', 'oz', 'lb'))`. If this list and that
  // constraint ever disagree, a row can exist that this module cannot convert, or this
  // module can accept a unit the database will reject on write.
  it('is exactly the four units the gear_items.weight_unit CHECK constraint allows', () => {
    expect(WEIGHT_UNITS).toEqual(['g', 'kg', 'oz', 'lb']);
  });

  it.each(WEIGHT_UNITS.map((unit) => [unit] as const))('accepts %s as a WeightUnit', (unit) => {
    expect(isWeightUnit(unit)).toBe(true);
  });

  // Each of these gets PAST "is it a string" and is refused only by not being one of
  // the four exact members — the near-miss a human types without a picker in front of
  // them, not a wildly wrong value a bare typeof check would already catch.
  it.each([
    ['uppercase', 'G'],
    ['a plural imperial abbreviation', 'lbs'],
    ['the unabbreviated unit name', 'gram'],
    ['a unit with trailing whitespace', 'kg '],
    ['the empty string', ''],
  ])('rejects %s (%s)', (_label, value) => {
    expect(isWeightUnit(value)).toBe(false);
  });

  // Non-string values a `string`-typed database column can never actually produce, but
  // that an untyped JSON payload or a bad cast could hand this guard in place of one.
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a number', 1],
    ['an object', { unit: 'g' }],
    ['an array', ['g']],
  ])('rejects %s', (_label, value) => {
    expect(isWeightUnit(value)).toBe(false);
  });
});

describe('exact conversion factors', () => {
  // `GRAMS_PER_UNIT` is the one place the exact factors live; this pins each literal
  // against the 1959 agreement's own numbers so a "tidied" 28.35 fails here first.
  it('matches the 1959 international yard-and-pound agreement exactly', () => {
    expect(GRAMS_PER_UNIT).toEqual(FACTORS);
  });
});

describe('known-value anchors', () => {
  // Multiplying by 1 changes no bits, so these hold by exact equality rather than an
  // approximation — a human can check each right-hand side by hand.
  it('1 kg is 1000 g', () => {
    expect(toGrams(1, 'kg')).toBe(1000);
  });

  it('1 lb is 453.59237 g', () => {
    expect(toGrams(1, 'lb')).toBe(453.59237);
  });

  it('1000 g is 1 kg', () => {
    expect(fromGrams(1000, 'kg')).toBe(1);
  });

  // The anchor from the ticket, and the one that crosses two imperial factors: 16 oz
  // into grams, then back down by 453.59237. It holds by EXACT equality, and that is a
  // property worth pinning rather than a tolerance worth choosing. 16 is a power of two,
  // so multiplying by it only shifts the exponent of whatever double `28.349523125` is
  // stored as — no bits are lost — and the product lands on precisely the double stored
  // for `453.59237` (`16 * 28.349523125 === 453.59237` is `true`). The division is then
  // x / x. A tolerance here would pass just as happily against two imperial constants
  // that agreed with their own definitions to nine decimal places and with each other
  // not at all, which is the thing this anchor is for.
  it('16 oz is exactly 1 lb', () => {
    expect(16 * FACTORS.oz).toBe(FACTORS.lb);
    expect(convertWeight(16, 'oz', 'lb')).toBe(1);
  });
});

describe('exhaustive conversion table', () => {
  // All 16 ordered pairs, each checked against a factor computed independently of
  // units.ts (see FACTORS above). The (g, g) row in particular pins that a same-unit
  // conversion is a genuine multiply-by-1 rather than a special-cased no-op that could
  // mask a broken general path; every other row is the only place its two factors are
  // exercised together in that order, so swapping `from` and `to` inside convertWeight
  // would fail exactly the rows where the two factors differ.
  it.each(UNIT_PAIRS)('converts %s -> %s for every test value', (from, to) => {
    for (const value of WEIGHT_VALUES) {
      const expected = (value * FACTORS[from]) / FACTORS[to];
      expect(convertWeight(value, from, to)).toBeCloseTo(expected, 9);
    }
  });
});

describe('round-trip identity', () => {
  // A value entered in `from`, converted to `to` and back to `from`, must reproduce
  // what the database would actually store — i.e. equal after rounding to
  // WEIGHT_DECIMALS, not merely close at some arbitrary tolerance. Floating-point
  // division and multiplication by the imperial factors do not perfectly undo each
  // other bit-for-bit, which is exactly what roundWeight exists to absorb.
  // Two placeholders, because a UNIT_PAIRS row is two units. The title used to carry a
  // third for the return leg and vitest filled it with `undefined` — sixteen titles
  // reading "round-trips g -> kg -> undefined", which nobody had cause to read closely
  // while they were green.
  it.each(UNIT_PAIRS)('round-trips %s -> %s and back to the original value', (from, to) => {
    for (const value of WEIGHT_VALUES) {
      const there = convertWeight(value, from, to);
      const back = convertWeight(there, to, from);
      expect(roundWeight(back)).toBe(value);
    }
  });
});

describe('NaN and Infinity are rejected, not propagated', () => {
  // Number.isFinite is false for NaN and both signed infinities alike, but a table that
  // only ever passed NaN would not catch a guard mistakenly written as `Number.isNaN`
  // instead — which rejects NaN and lets both infinities straight through. Each of the
  // three bad values is listed separately so that mistake cannot hide behind the others.
  const badValues: [label: string, value: number][] = [
    ['NaN', NaN],
    ['positive Infinity', Infinity],
    ['negative Infinity', -Infinity],
  ];

  it.each(badValues)('toGrams throws for %s', (_label, value) => {
    expect(() => toGrams(value, 'g')).toThrow(RangeError);
  });

  it.each(badValues)('fromGrams throws for %s', (_label, value) => {
    expect(() => fromGrams(value, 'g')).toThrow(RangeError);
  });

  it.each(badValues)('convertWeight throws for %s', (_label, value) => {
    expect(() => convertWeight(value, 'g', 'kg')).toThrow(RangeError);
  });

  it.each(badValues)('roundWeight throws for %s', (_label, value) => {
    expect(() => roundWeight(value)).toThrow(RangeError);
  });

  // A finite value is not rejected merely for being large or being zero — the guard is
  // "not finite", not "suspiciously big" or "falsy".
  it('does not reject ordinary finite values, including zero', () => {
    expect(() => toGrams(0, 'g')).not.toThrow();
    expect(() => toGrams(999_999_999.999, 'lb')).not.toThrow();
  });
});

/**
 * THE OTHER HALF OF THE CHECK CONSTRAINT. `gear_items.weight` is `check (weight >= 0 and
 * weight < 'Infinity'::numeric)`, and the block above only pins the upper half. Every
 * value here is perfectly finite, so none of them is caught by the finiteness guard —
 * delete the sign check and this block goes red on its own, which is the property
 * tests/safe-next-path.test.ts's trap demands and the reason these are not folded into
 * the table above as three more rows.
 *
 * The reachability is not hypothetical: `pack_items.overrides` is constrained only to be
 * a JSON object, and its owner may PATCH it on any unlocked pack item.
 */
describe('negative weights are rejected, not silently subtracted', () => {
  const negatives: [label: string, value: number][] = [
    ['a whole negative value', -400],
    // -0.001 is the smallest magnitude `numeric(12, 3)` can even express, so a guard
    // written as `value < -1` or with any tolerance at all would let it through.
    ['the smallest storable negative value', -0.001],
  ];

  it.each(negatives)('toGrams throws for %s', (_label, value) => {
    expect(() => toGrams(value, 'g')).toThrow(RangeError);
    expect(() => toGrams(value, 'g')).toThrow(/must not be negative/);
  });

  it.each(negatives)('fromGrams throws for %s', (_label, value) => {
    expect(() => fromGrams(value, 'kg')).toThrow(/must not be negative/);
  });

  it.each(negatives)('convertWeight throws for %s', (_label, value) => {
    expect(() => convertWeight(value, 'oz', 'lb')).toThrow(/must not be negative/);
  });

  it.each(negatives)('roundWeight throws for %s', (_label, value) => {
    expect(() => roundWeight(value)).toThrow(/must not be negative/);
  });

  // Negative ZERO is not a negative weight. `-0 < 0` is false in IEEE 754, and it can
  // arrive from an ordinary `0 * -1` upstream; refusing it would be refusing zero.
  it('accepts negative zero, which is zero', () => {
    expect(toGrams(-0, 'kg')).toBe(-0);
  });
});

/**
 * A conversion can leave the finite range its own argument sat well inside, and this is
 * the only block where the value being refused is one this module MANUFACTURED rather
 * than one it was handed. Every argument below passes the input guard: it is the product
 * that is checked.
 *
 * Why it matters more than its reachability suggests: `Infinity` is the one bad value
 * that makes tests/totals.test.ts's partition assertion pass VACUOUSLY, because
 * `Infinity === Infinity` — a pack whose every line is Infinity satisfies
 * `base + worn + consumable === total` and reports green while meaning nothing. NaN at
 * least fails that identity.
 */
describe('a conversion that overflows is refused rather than returned', () => {
  it('throws when multiplying into grams overflows to Infinity', () => {
    // Finite argument, finite factor, infinite product: 1e308 * 1000.
    expect(Number.isFinite(1e308)).toBe(true);
    expect(() => toGrams(1e308, 'kg')).toThrow(RangeError);
    expect(() => toGrams(1e308, 'kg')).toThrow(/converted to grams must be a finite number/);
  });

  // The argument itself is still accepted at that magnitude when the factor is 1, so the
  // test above is about the PRODUCT and not about a size limit on the input.
  it('still accepts the same magnitude where the conversion does not overflow', () => {
    expect(toGrams(1e308, 'g')).toBe(1e308);
    expect(fromGrams(1e308, 'kg')).toBe(1e305);
  });
});

describe('WEIGHT_DECIMALS and roundWeight', () => {
  it('is 3, matching the numeric(12, 3) scale of gear_items.weight', () => {
    expect(WEIGHT_DECIMALS).toBe(3);
  });

  // Values chosen away from an exact *.xxx5 boundary, where the direction Math.round
  // breaks a tie is not the thing under test here and floating-point representation of
  // the halfway point itself is not guaranteed to land exactly on it.
  it.each([
    ['a value already at full precision', 12.345, 12.345],
    ['a value with a fourth decimal that rounds down', 1.2344, 1.234],
    ['a value with a fourth decimal that rounds up', 1.2346, 1.235],
    ['a whole number', 7, 7],
    ['zero', 0, 0],
  ])('rounds %s (%s) to %s', (_label, input, expected) => {
    expect(roundWeight(input)).toBe(expected);
  });
});
