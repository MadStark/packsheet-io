import { readFile } from 'node:fs/promises';
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { adminSql, createUser, type TestUser } from './support/local-database';
import { GRAMS_PER_UNIT, toGrams, WEIGHT_UNITS, type WeightUnit } from '../src/lib/units';

/**
 * The one irreversible data step in PK-67: `20260817120000_gear_weight_in_grams.sql`
 * rewrites every EXISTING `pack_items.snapshot` and `pack_items.overrides` row, converting
 * a frozen `weight` by its own frozen `weight_unit` and then removing that key.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS TEST EXISTS AT ALL, WHEN THE MIGRATION HAS ALREADY RUN
 * ---------------------------------------------------------------------------
 *
 * Every other suite here exercises the schema as it stands. This one exercises a statement
 * that ran ONCE, against data that existed before it, and can never run again — which is
 * precisely why it needs a test more than the rest of the schema does, not less. A pack
 * locked before the migration is a historical record a user cannot recreate: if the
 * conversion was wrong, the pack silently reports a different total than it did the day it
 * was locked, and there is no second run to fix it and nothing to compare against.
 *
 * `20260813120000_gear_schema_slim.sql` established that pre-existing snapshots are left
 * alone because "a snapshot is historical fact ... not a live projection". This migration
 * is the documented exception, and the reason is that the MEANING of a key changed rather
 * than a key being added or removed: absence of `weight_unit` is ambiguous between "grams"
 * and "an old row that never had one", so `totals.ts` could not have told the two apart at
 * runtime. Converting once, here, is what leaves exactly one shape in the database.
 *
 * ---------------------------------------------------------------------------
 * THE STATEMENTS ARE READ OUT OF THE SHIPPED MIGRATION AND EXECUTED VERBATIM
 * ---------------------------------------------------------------------------
 *
 * Not re-typed. A copy of the SQL in this file would pass with the shipped SQL wrong,
 * which is the tautology `tests/units.test.ts` warns about applied to a migration — and
 * the failure it would hide is permanent data corruption rather than a red test.
 *
 * The fixtures below are therefore written in the PRE-migration shape (`weight` plus
 * `weight_unit`) directly through admin SQL, since PostgREST can no longer produce one,
 * and the real statement is then run over them.
 */

const MIGRATION_PATH = new URL(
  '../supabase/migrations/20260817120000_gear_weight_in_grams.sql',
  import.meta.url,
);

/**
 * One `update public.pack_items ...;` statement from the migration, located by a fragment
 * of its own SET clause and taken through to its terminating semicolon.
 *
 * The file holds three such statements — two over `overrides`, one over `snapshot` — so
 * each is addressed by a fragment unique to it rather than by position, which would break
 * silently the first time the migration's statements are reordered.
 */
async function migrationStatement(setFragment: string): Promise<string> {
  const sql = await readFile(MIGRATION_PATH, 'utf8');
  const at = sql.indexOf(setFragment);
  expect(at, `no statement in the migration contains ${setFragment}`).toBeGreaterThan(-1);

  const start = sql.lastIndexOf('update public.pack_items', at);
  const end = sql.indexOf(';', at);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);

  return sql.slice(start, end + 1);
}

const SNAPSHOT_REWRITE = "set snapshot = (snapshot - 'weight_unit')";
const OVERRIDE_WITH_UNIT = 'where overrides ? ';
const OVERRIDE_WITHOUT_UNIT = "where not (pi.overrides ? 'weight_unit')";

let owner: TestUser;
let packId: string;
let categoryId: string;

/**
 * A pack item carrying a PRE-migration snapshot and overrides, written with admin SQL
 * because no client can produce this shape any more.
 *
 * The pack is left UNLOCKED for insertion and locked afterwards by the caller, mirroring
 * the real history these rows have: a snapshot exists precisely because the pack was
 * locked or its gear was deleted, which is what makes `pack_items_assert_unlocked` the
 * trigger the migration has to suppress.
 */
async function seedFrozenItem(
  weight: number,
  unit: WeightUnit,
  overrides: Record<string, unknown>,
): Promise<string> {
  const [row] = await adminSql<{ id: string }>(
    `insert into public.pack_items (user_id, pack_category_id, overrides, snapshot)
     values ($1, $2, $3::jsonb, $4::jsonb)
     returning id`,
    [
      owner.id,
      categoryId,
      JSON.stringify(overrides),
      JSON.stringify({
        name: 'Frozen gear',
        brand: null,
        category: null,
        description: null,
        weight,
        weight_unit: unit,
        price: null,
        currency: null,
        photo_path: null,
        gear_item_id: null,
        captured_at: '2026-08-10T12:00:00+00:00',
      }),
    ],
  );
  return row.id;
}

/** Runs the migration's own rewrite statements, with the two triggers it suppresses. */
async function replayRewrite(): Promise<void> {
  const withoutUnit = await migrationStatement(OVERRIDE_WITHOUT_UNIT);
  const withUnit = await migrationStatement(OVERRIDE_WITH_UNIT);
  const snapshots = await migrationStatement(SNAPSHOT_REWRITE);

  await adminSql('alter table public.pack_items disable trigger pack_items_assert_unlocked');
  await adminSql('alter table public.pack_items disable trigger pack_items_set_updated_at');
  try {
    // Same order as the migration: the override that carries no unit of its own is
    // converted FIRST, while the snapshot it reads its base unit from still has one.
    await adminSql(withoutUnit);
    await adminSql(withUnit);
    await adminSql(snapshots);
  } finally {
    await adminSql('alter table public.pack_items enable trigger pack_items_assert_unlocked');
    await adminSql('alter table public.pack_items enable trigger pack_items_set_updated_at');
  }
}

/**
 * `gear_items.weight_unit` IS TEMPORARILY PUT BACK, and this is the one piece of scaffolding
 * in this file that needs justifying.
 *
 * The first of the three statements resolves an override's base unit as
 * `coalesce(snapshot ->> 'weight_unit', (select g.weight_unit from gear_items g ...))`, so it
 * NAMES a column the same migration drops four statements later. Replaying it against the
 * post-migration schema fails to parse — `column g.weight_unit does not exist` — which would
 * leave the subtlest of the three statements as the only one this file could not exercise.
 *
 * Re-adding the column for the duration reconstructs the schema the statement was written
 * against, which is the honest way to run it, and it stays a scaffold rather than a fixture:
 * the rows below carry no `gear_item_id`, so the subquery yields NULL and `coalesce` takes
 * the snapshot's own frozen unit exactly as it would have in production for a frozen row.
 * The column has to EXIST for the statement to parse; nothing here depends on its contents.
 *
 * Safe because `vitest.config.ts:99` sets `fileParallelism: false`, so no other suite is
 * reading this schema while the column is present — `tests/database-types.test.ts` in
 * particular compares the committed types against the live database and would fail on a
 * stray column. `afterAll` drops it unconditionally, so a failing assertion above cannot
 * leave it behind for the next file.
 */
const PRE_MIGRATION_COLUMN = 'alter table public.gear_items add column weight_unit text';
const DROP_PRE_MIGRATION_COLUMN = 'alter table public.gear_items drop column weight_unit';

afterAll(async () => {
  await adminSql(DROP_PRE_MIGRATION_COLUMN);
});

beforeAll(async () => {
  await adminSql(PRE_MIGRATION_COLUMN);
  owner = await createUser('snapshot-grams');

  const [pack] = await adminSql<{ id: string }>(
    "insert into public.packs (user_id, name, slug) values ($1, 'Frozen trip', $2) returning id",
    [owner.id, `frozen${Date.now().toString(36)}`],
  );
  packId = pack.id;

  const [category] = await adminSql<{ id: string }>(
    "insert into public.pack_categories (user_id, pack_id, name) values ($1, $2, 'Shelter') returning id",
    [owner.id, packId],
  );
  categoryId = category.id;
});

describe('the frozen-snapshot rewrite (PK-67)', () => {
  /**
   * The acceptance criterion, one unit at a time: a pack locked before the migration
   * reports the same total afterwards.
   *
   * `toBeCloseTo(…, 3)` is the ticket's own "to three decimals". The second assertion is
   * far tighter and says what actually holds, but it is deliberately NOT `toBe`: Postgres
   * multiplies with EXACT decimal arithmetic and stores `124.73790175`, while
   * `toGrams(4.4, 'oz')` computes `124.73790175000002` in IEEE-754 double precision. Two
   * arithmetic systems, the same operands, agreeing to about fourteen decimal places and
   * not beyond — the same pairing `tests/gear-closet-schema.test.ts` documents for the
   * factors themselves.
   *
   * Which way that difference falls is worth stating, because it is the reassuring
   * direction: the database's answer is the mathematically exact one, and the pre-migration
   * total was the floating-point approximation of it. The rewrite therefore does not lose
   * precision against what a locked pack used to report — it holds slightly more of it —
   * and the discrepancy is around 1e-14 g against an acceptance bar of 1e-3.
   *
   * The rewrite also does NOT round to the column's scale, deliberately: `snapshot` is
   * jsonb and has no scale, so converting at full precision keeps the frozen figure as
   * close to the original as the two arithmetics allow.
   */
  it.each(WEIGHT_UNITS)(
    'converts a frozen %s weight to the identical gram figure',
    async (unit) => {
      const weight = 4.4;
      const id = await seedFrozenItem(weight, unit, {});

      await replayRewrite();

      const [row] = await adminSql<{ weight: number; has_unit: boolean }>(
        `select (snapshot ->> 'weight')::float8 as weight,
              (snapshot ? 'weight_unit') as has_unit
         from public.pack_items where id = $1`,
        [id],
      );

      expect(row.has_unit, 'the frozen unit must be removed, not merely ignored').toBe(false);
      expect(row.weight).toBeCloseTo(toGrams(weight, unit), 3);
      expect(row.weight).toBeCloseTo(weight * GRAMS_PER_UNIT[unit], 9);
    },
  );

  /**
   * THE SHAPE A LITERAL READING OF THE TICKET WOULD HAVE MISSED. An override carrying a
   * weight but NO unit of its own meant "n of whatever unit the BASE row was in", because
   * `resolvePackItem` merges per field. Converting it needs the snapshot's frozen unit,
   * which is why the migration runs this statement before the one that strips it.
   *
   * Left unconverted, an 8.8 override against an ounces item would silently become 8.8 g —
   * a wrong number on a shared pack, arrived at by doing nothing.
   */
  it('converts an override that carries a weight but no unit, using the frozen base unit', async () => {
    const id = await seedFrozenItem(4.4, 'oz', { weight: 8.8 });

    await replayRewrite();

    const [row] = await adminSql<{ weight: number; has_unit: boolean }>(
      `select (overrides ->> 'weight')::float8 as weight,
              (overrides ? 'weight_unit') as has_unit
         from public.pack_items where id = $1`,
      [id],
    );

    expect(row.has_unit).toBe(false);
    expect(row.weight).toBeCloseTo(8.8 * GRAMS_PER_UNIT.oz, 9);
    // And emphatically NOT the 8.8 g it would have become had this statement been skipped
    // — the whole point of converting this shape rather than leaving it.
    expect(row.weight).toBeGreaterThan(200);
  });

  it('converts an override that carries its own unit, by that unit rather than the base one', async () => {
    // The base is frozen in ounces; the override says kilograms. Converting by the base
    // would give 2 * 28.35 rather than 2000, so this is the case that distinguishes the
    // two statements from each other.
    const id = await seedFrozenItem(4.4, 'oz', { weight: 2, weight_unit: 'kg' });

    await replayRewrite();

    const [row] = await adminSql<{ weight: number; has_unit: boolean }>(
      `select (overrides ->> 'weight')::float8 as weight,
              (overrides ? 'weight_unit') as has_unit
         from public.pack_items where id = $1`,
      [id],
    );

    expect(row.has_unit).toBe(false);
    expect(row.weight).toBe(2000);
  });

  /**
   * An override that carried ONLY a unit re-denominated the base row's own number. There
   * is no longer a unit for it to override, and it never carried a figure of its own, so
   * the key is dropped and the item falls back to its base gram weight — the only answer
   * available that does not invent data.
   */
  it('drops a unit-only override, leaving no weight behind', async () => {
    const id = await seedFrozenItem(4.4, 'oz', { weight_unit: 'lb' });

    await replayRewrite();

    const [row] = await adminSql<{ overrides: Record<string, unknown> }>(
      'select overrides from public.pack_items where id = $1',
      [id],
    );

    expect(row.overrides).toEqual({});
  });

  /**
   * A malformed unit was already unrenderable — `isWeightUnit` in `totals.ts` threw on it
   * — so no correct rendering is lost by reading its number as grams from here on. What
   * must NOT happen is the migration aborting on it: a schema change that fails on one
   * user's hand-written override takes the whole deploy down.
   */
  it('drops a malformed unit without aborting, leaving the number untouched', async () => {
    const id = await seedFrozenItem(4.4, 'oz', { weight: 5, weight_unit: 'stones' });

    await replayRewrite();

    const [row] = await adminSql<{ overrides: Record<string, unknown> }>(
      'select overrides from public.pack_items where id = $1',
      [id],
    );

    expect(row.overrides).toEqual({ weight: 5 });
  });

  /**
   * A hand-written snapshot can carry a non-numeric weight — the CHECK constraint only
   * guarantees `captured_at` and a non-blank `name`. `::numeric` on `"heavy"` would abort
   * the migration, so the statement guards with `jsonb_typeof(...) = 'number'` and such a
   * row keeps whatever it had, losing only its unit key.
   */
  it('leaves a non-numeric frozen weight alone rather than failing the migration', async () => {
    const [row] = await adminSql<{ id: string }>(
      `insert into public.pack_items (user_id, pack_category_id, snapshot)
       values ($1, $2, $3::jsonb) returning id`,
      [
        owner.id,
        categoryId,
        JSON.stringify({
          name: 'Hand-written',
          weight: 'heavy',
          weight_unit: 'oz',
          captured_at: '2026-08-10T12:00:00+00:00',
        }),
      ],
    );

    await replayRewrite();

    const [after] = await adminSql<{ weight: string; has_unit: boolean }>(
      `select snapshot ->> 'weight' as weight, (snapshot ? 'weight_unit') as has_unit
         from public.pack_items where id = $1`,
      [row.id],
    );

    expect(after.weight).toBe('heavy');
    expect(after.has_unit).toBe(false);
  });

  /**
   * The rewrite has to reach LOCKED packs, which is where every snapshot actually lives —
   * `pack_items_assert_unlocked` raises `pack % is locked` on any depth-1 UPDATE, so
   * without suppressing it the migration does not merely skip these rows, it ABORTS.
   *
   * This is the failure PK-67's own requirements did not anticipate, so it is pinned
   * directly rather than left to the statements above happening to run against an unlocked
   * fixture.
   */
  it('rewrites a snapshot on a LOCKED pack, the state every snapshot is actually in', async () => {
    const id = await seedFrozenItem(4.4, 'oz', {});
    await adminSql('update public.packs set locked_at = now() where id = $1', [packId]);

    try {
      await replayRewrite();

      const [row] = await adminSql<{ weight: number }>(
        `select (snapshot ->> 'weight')::float8 as weight from public.pack_items where id = $1`,
        [id],
      );
      expect(row.weight).toBeCloseTo(4.4 * GRAMS_PER_UNIT.oz, 9);
    } finally {
      await adminSql('update public.packs set locked_at = null where id = $1', [packId]);
    }
  });

  /**
   * And the trigger the ticket DOES name: a schema migration must not restamp every row as
   * user-edited, in a column optimistic-concurrency logic compares against.
   */
  it('does not move updated_at on the rows it rewrites', async () => {
    const id = await seedFrozenItem(4.4, 'oz', { weight: 8.8 });
    const [before] = await adminSql<{ updated_at: Date }>(
      'select updated_at from public.pack_items where id = $1',
      [id],
    );

    await replayRewrite();

    const [after] = await adminSql<{ updated_at: Date }>(
      'select updated_at from public.pack_items where id = $1',
      [id],
    );
    expect(after.updated_at.getTime()).toBe(before.updated_at.getTime());
  });
});
