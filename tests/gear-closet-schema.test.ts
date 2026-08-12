import { describe, it, expect, beforeAll } from 'vitest';
import { createUser, type TestUser } from './support/local-database';
import { toGrams, WEIGHT_UNITS, type WeightUnit } from '../src/lib/units';

/**
 * The three gear-closet columns added by
 * supabase/migrations/20260813000000_gear_closet.sql: `quantity` (how many I own),
 * `deleted_at` (soft delete) and `weight_grams` (a generated, comparable weight).
 *
 * Same style as tests/rls-owner.test.ts: real local database, fixtures inserted
 * through PostgREST as their owner under RLS, exact SQLSTATE assertions, and every
 * write re-read from the owner's own client — a refused write and a no-op write are
 * byte-identical to PostgREST (see tests/support/fixtures.ts's `must()`), so the
 * response of the write itself is never trusted on its own.
 */

let owner: TestUser;
let stranger: TestUser;

beforeAll(async () => {
  owner = await createUser('closet');
  stranger = await createUser('closet-stranger');
});

/** Minimal gear item, inserted as `owner`, returning every column this file asserts on. */
async function insertGear(overrides: Record<string, unknown> = {}) {
  return owner.client
    .from('gear_items')
    .insert({ name: 'Test gear', ...overrides })
    .select('id, quantity, deleted_at, weight, weight_unit, weight_grams')
    .single();
}

describe('quantity — how many I own', () => {
  it('defaults to 1 when omitted', async () => {
    const { data, error } = await insertGear();
    expect(error).toBeNull();
    expect(data?.quantity).toBe(1);
  });

  // 23514: check violation. This is the specific bug a bare `quantity integer not null`
  // (no CHECK at all) would let through — a closet item that claims to be owned zero or
  // a negative number of times, which is not a quantity anybody can carry.
  it('rejects a quantity of 0 with a check violation', async () => {
    const { error } = await insertGear({ quantity: 0 });
    expect(error?.code).toBe('23514');
  });

  it('rejects a negative quantity with a check violation', async () => {
    const { error } = await insertGear({ quantity: -1 });
    expect(error?.code).toBe('23514');
  });
});

describe('deleted_at — soft delete', () => {
  it('defaults to null', async () => {
    const { data, error } = await insertGear();
    expect(error).toBeNull();
    expect(data?.deleted_at).toBeNull();
  });

  it('an owner can set it and clear it again, confirmed by re-reading their own row', async () => {
    const { data: created } = await insertGear();
    const id = created!.id as unknown as string;

    // Set: this is what "move to trash" is. Re-read rather than trusting the update's
    // own response — see the file header on why that response cannot be trusted alone.
    const trashedAt = new Date().toISOString();
    await owner.client.from('gear_items').update({ deleted_at: trashedAt }).eq('id', id);
    const { data: trashed } = await owner.client
      .from('gear_items')
      .select('deleted_at')
      .eq('id', id)
      .single();
    expect(trashed?.deleted_at).not.toBeNull();

    // Clear: this is "undo", and the entire reason the column is a soft delete rather
    // than a hard DELETE followed by a re-insert — see the migration comment. Re-read
    // again, for the same reason.
    await owner.client.from('gear_items').update({ deleted_at: null }).eq('id', id);
    const { data: restored } = await owner.client
      .from('gear_items')
      .select('deleted_at')
      .eq('id', id)
      .single();
    expect(restored?.deleted_at).toBeNull();
  });

  it('another user cannot set deleted_at on someone else’s row', async () => {
    const { data: created } = await insertGear();
    const id = created!.id as unknown as string;

    // A stranger's UPDATE against a row RLS hides from them matches zero rows and
    // still comes back as { error: null, data: [] } — a successful request affecting
    // nothing, not a refusal PostgREST reports as an error. So the only way to tell
    // "refused" from "silently trashed my gear" apart is to re-read as the owner.
    await stranger.client
      .from('gear_items')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', id);

    const { data: stillOwners } = await owner.client
      .from('gear_items')
      .select('deleted_at')
      .eq('id', id)
      .single();
    expect(stillOwners?.deleted_at).toBeNull();
  });
});

describe('weight_grams — a generated, comparable weight', () => {
  /**
   * Non-trivial weights, one per unit, chosen to have several significant digits so a
   * factor typo (28.35 instead of 28.349523125, say) would move the result by an
   * amount this test can actually see rather than by less than floating-point noise.
   */
  const CASES: Record<WeightUnit, number> = {
    oz: 4.4,
    lb: 2.5,
    kg: 1.75,
    g: 123.456,
  };

  /**
   * The tolerance is not decoration. PostgREST can serialise `numeric` as either a
   * string or a number depending on magnitude, so the value is always run through
   * `Number()` first. From there, the database computed weight_grams with exact
   * decimal arithmetic (Postgres `numeric`), while toGrams() computed the same
   * conversion in IEEE-754 double precision — two different arithmetic systems
   * multiplying the same operands. They agree to a very large number of digits, but
   * are not bitwise-guaranteed to agree at the seventeenth one, so an exact `toBe` is
   * the wrong assertion. 1e-6 grams is roughly a millionth of a gram: far below
   * anything a check on GRAMS_PER_UNIT staying in sync with the SQL factors needs to
   * catch, and far above where double-precision rounding noise could ever land.
   */
  const TOLERANCE_GRAMS = 1e-6;

  it.each(WEIGHT_UNITS)(
    'agrees with toGrams() for a %s weight — the assertion pinning the SQL factors to GRAMS_PER_UNIT',
    async (unit) => {
      const weight = CASES[unit];
      const { data, error } = await insertGear({ weight, weight_unit: unit });
      expect(error).toBeNull();

      const fromDatabase = Number(data?.weight_grams);
      const fromTypeScript = toGrams(weight, unit);

      expect(Math.abs(fromDatabase - fromTypeScript)).toBeLessThan(TOLERANCE_GRAMS);
    },
  );

  // Proves this is genuinely GENERATED and not an ordinary column someone could
  // desynchronise from weight/weight_unit with a direct write. A generated column
  // cannot be the target of an INSERT's column list; Postgres refuses it outright.
  it('rejects an insert that supplies weight_grams directly', async () => {
    const { error } = await owner.client
      .from('gear_items')
      .insert({ name: 'Test gear', weight: 100, weight_unit: 'g', weight_grams: 999 })
      .select('id');

    expect(error).not.toBeNull();
  });

  // Proves STORED recomputes on UPDATE, not only at INSERT time — which is what the
  // range filter and sort-by-weight this column exists for actually depend on: an item
  // whose unit was corrected after the fact must not carry a stale weight_grams.
  it('recomputes when weight or weight_unit is updated', async () => {
    const { data: created } = await insertGear({ weight: 100, weight_unit: 'g' });
    const id = created!.id as unknown as string;
    expect(Number(created?.weight_grams)).toBeCloseTo(toGrams(100, 'g'), 6);

    await owner.client.from('gear_items').update({ weight: 2 }).eq('id', id);
    const { data: afterWeight } = await owner.client
      .from('gear_items')
      .select('weight_grams')
      .eq('id', id)
      .single();
    expect(Number(afterWeight?.weight_grams)).toBeCloseTo(toGrams(2, 'g'), 6);

    await owner.client.from('gear_items').update({ weight_unit: 'kg' }).eq('id', id);
    const { data: afterUnit } = await owner.client
      .from('gear_items')
      .select('weight_grams')
      .eq('id', id)
      .single();
    expect(Number(afterUnit?.weight_grams)).toBeCloseTo(toGrams(2, 'kg'), 6);
  });
});
