import { describe, it, expect, beforeAll } from 'vitest';
import { createUser, type TestUser } from './support/local-database';
import { toGrams, WEIGHT_UNITS, type WeightUnit } from '../src/lib/units';

/**
 * The gear-closet columns added by supabase/migrations/20260813000000_gear_closet.sql —
 * `quantity` (how many I own) and `weight_grams` (a generated, comparable weight) — and
 * the ownership boundary around writing to a closet row at all.
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
    .select('id, quantity, weight, weight_unit, weight_grams')
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

/**
 * The POLICY half of "only I can change my gear". `deleteGearItems`, `updateGearItem`
 * and the two bulk writes (src/lib/gear/mutations.ts) each add their own
 * `.eq('user_id', userId)`, and tests/gear-closet.test.ts asserts that filter directly;
 * the two cases here are what holds when NOBODY goes through those functions — a bare
 * `.eq('id', …)` write, the shape a hand-rolled request or a future caller that forgets
 * the owner filter would take.
 *
 * The delete case is the one that earns its place twice over. Deleting gear now removes
 * the row (supabase/migrations/20260813130000_gear_hard_delete.sql), firing
 * `gear_items_snapshot_before_delete` into every pack that referenced it, and no tier
 * behind it can put any of that back — so a hole here is not "a stranger edited my gear",
 * it is "a stranger destroyed it".
 *
 * tests/rls-owner.test.ts covers this same boundary for gear sitting on a PUBLIC pack —
 * the case where the stranger can already SELECT the row, which is what makes the write
 * policies reachable at all. These two cover a plain, private closet row, which is what
 * almost every gear item is.
 */
describe('another user cannot write to someone else’s closet row', () => {
  it('a stranger’s update changes nothing, confirmed by re-reading as the owner', async () => {
    const { data: created } = await insertGear({ name: 'Owner’s tarp' });
    const id = created!.id as unknown as string;

    // A stranger's UPDATE against a row RLS hides from them matches zero rows and
    // still comes back as { error: null, data: [] } — a successful request affecting
    // nothing, not a refusal PostgREST reports as an error. So the only way to tell
    // "refused" from "silently vandalised my gear" apart is to re-read as the owner.
    await stranger.client.from('gear_items').update({ name: 'VANDALISED' }).eq('id', id);

    const { data: stillOwners } = await owner.client
      .from('gear_items')
      .select('name')
      .eq('id', id)
      .single();
    expect(stillOwners?.name).toBe('Owner’s tarp');
  });

  it('a stranger’s delete removes nothing, confirmed by re-reading as the owner', async () => {
    const { data: created } = await insertGear({ name: 'Owner’s stove' });
    const id = created!.id as unknown as string;

    // Same indistinguishability as the update above, and the same remedy: a DELETE
    // matching zero rows is byte-identical to a DELETE the policy refused, so the
    // stranger's own response says nothing. `maybeSingle` rather than `single` on the
    // read-back, so a row that HAS been destroyed fails on the assertion below rather
    // than on PostgREST's "expected one row" error.
    await stranger.client.from('gear_items').delete().eq('id', id);

    const { data: survivor } = await owner.client
      .from('gear_items')
      .select('name')
      .eq('id', id)
      .maybeSingle();
    expect(survivor?.name).toBe('Owner’s stove');
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

/**
 * `acquired_on` and the removal of `volume_litres` — both from
 * supabase/migrations/20260813120000_gear_schema_slim.sql (PK-61), not the gear-closet
 * migration this file is named after. Kept in this file rather than a new one anyway:
 * it is the closest fit in style (real local database, fixtures inserted through
 * PostgREST as their owner under RLS, exact error-code assertions) and PK-61 is a slim
 * follow-on to the same table this file already covers end to end.
 */
describe('acquired_on — the user’s own claim about when they got the item (PK-61)', () => {
  // NO DATABASE DEFAULT — this is the assertion that would catch someone "helpfully"
  // adding `default current_date` later. The migration's own comment is explicit that a
  // default would be wrong: "when I got this" is genuinely unknown for plenty of real
  // gear, and the product treats an empty date box as "I don't know", never as a
  // silent guess of "today".
  it('omitting it on insert leaves it null — there is no database default', async () => {
    const { data, error } = await insertGear();
    expect(error).toBeNull();
    const { data: read } = await owner.client
      .from('gear_items')
      .select('acquired_on')
      .eq('id', data!.id)
      .single();
    expect(read?.acquired_on).toBeNull();
  });

  // THE WHOLE JUSTIFICATION FOR THIS COLUMN EXISTING, made concrete: a client-supplied
  // acquired_on is stored exactly as sent, in direct CONTRAST to created_at, which
  // tests/core-schema.test.ts ("ignores created_at and updated_at sent by the client on
  // INSERT") proves the server always overwrites — both columns are timestamped by the
  // same `set_row_timestamps()` BEFORE INSERT trigger for created_at, but acquired_on
  // carries no such trigger, so it is the one date on this row the visitor actually
  // controls. Without this column, "when I got this" had no honest home: created_at
  // answers "when was this row entered into the closet", a fact about the database, not
  // about the physical item.
  it('a client-supplied value is stored as sent — unlike created_at, nothing overwrites it', async () => {
    const { data, error } = await insertGear({ acquired_on: '2021-06-15' });
    expect(error).toBeNull();
    const { data: read } = await owner.client
      .from('gear_items')
      .select('acquired_on')
      .eq('id', data!.id)
      .single();
    expect(read?.acquired_on).toBe('2021-06-15');
  });

  it('can be updated to a new date, and cleared back to null, confirmed by re-reading the owner’s own row', async () => {
    const { data: created } = await insertGear({ acquired_on: '2021-06-15' });
    const id = created!.id as unknown as string;

    await owner.client.from('gear_items').update({ acquired_on: '2023-11-02' }).eq('id', id);
    const { data: updated } = await owner.client
      .from('gear_items')
      .select('acquired_on')
      .eq('id', id)
      .single();
    expect(updated?.acquired_on).toBe('2023-11-02');

    // Back to "I don't know" — the same undo story deleted_at's own test above tells,
    // and equally not a one-way door.
    await owner.client.from('gear_items').update({ acquired_on: null }).eq('id', id);
    const { data: cleared } = await owner.client
      .from('gear_items')
      .select('acquired_on')
      .eq('id', id)
      .single();
    expect(cleared?.acquired_on).toBeNull();
  });

  // Not a CHECK constraint this time — acquired_on is a plain `date` column with no
  // constraint of its own (see the migration's own comment: "this one mirrors a TYPE
  // rather than a CHECK constraint", echoed in src/lib/gear/form.ts's identical note on
  // its application-side validator). Postgres's `date` input function refuses the
  // string outright, at the type layer, before any CHECK could even run.
  it('rejects an invalid date string at the database', async () => {
    const { error } = await insertGear({ acquired_on: 'not-a-date' });
    // 22007: invalid_datetime_format — confirmed by actually running this against the
    // local stack rather than assumed, per this file's own SQLSTATE discipline.
    expect(error?.code).toBe('22007');
  });
});

/**
 * `volume_litres` is GONE (PK-61) — not merely unused, but a column PostgREST no
 * longer knows about at all. Both shapes below were confirmed by actually running them
 * against the local stack, not assumed from the migration alone: a SELECT naming a
 * dropped column fails at the Postgres layer (planning the query against a catalogue
 * that no longer has the column), while an INSERT naming it fails one layer up, in
 * PostgREST's own schema cache, before the statement it would build is ever sent to
 * Postgres — different components, different error codes, both real.
 */
describe('volume_litres is gone', () => {
  it('a select naming it fails at the database, not silently returning null', async () => {
    // The generated Database type has no volume_litres column any more (that is what
    // tests/database-types.test.ts pins), so reaching this column at all needs the same
    // deliberate escape hatch tests/core-schema.test.ts's own weightLiteral uses for a
    // value the generated type says cannot occur: cast the select string itself, not
    // the response, so the ONE place this file lies about the schema is visible at the
    // call site.
    const { error } = await owner.client.from('gear_items').select('id, volume_litres' as 'id');
    // 42703: undefined_column, from Postgres itself.
    expect(error?.code).toBe('42703');
    expect(error?.message).toContain('volume_litres');
  });

  it('an insert naming it is refused by PostgREST’s schema cache, not silently ignored', async () => {
    const { error } = await owner.client
      .from('gear_items')
      .insert({ name: 'Test gear', volume_litres: 4.2 } as unknown as { name: string })
      .select('id');
    // PGRST204: PostgREST could not find the column in its schema cache — distinct from
    // 42703 above because this refusal never reaches Postgres at all.
    expect(error?.code).toBe('PGRST204');
    expect(error?.message).toContain('volume_litres');
  });
});
