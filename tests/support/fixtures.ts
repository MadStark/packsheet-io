/**
 * Pack fixtures, built the way the application will build them.
 *
 * Every row here goes in through PostgREST as its owner, under RLS, with `user_id`
 * left to its `auth.uid()` default. That is a deliberate constraint rather than a
 * convenience: a fixture inserted as `postgres` could be one the insert policies
 * would have refused, and a later assertion passing against a row that could never
 * exist is worse than no test at all. If a policy is wrong, these helpers throw
 * during setup rather than producing a green run over impossible data.
 */

import type { PostgrestError } from '@supabase/supabase-js';
import type { TestUser } from './local-database';

/**
 * Anything PostgREST refuses is a broken fixture, and must stop the test immediately.
 *
 * "Refuses" includes returning NO ROWS, and that is the case worth spelling out: a write
 * that row-level security declines is not an error at this layer. PostgREST answers it
 * `{ data: [], error: null, status: 200 }` — a shape this suite documents elsewhere
 * (core-schema.test.ts asserts exactly it for an update against a locked pack). An
 * earlier version of this helper checked only `error` and `data === null`, so the lock
 * step below could be refused and `createPack` would still hand back a fixture claiming
 * `locked: true`. Every "locked pack" assertion would then run against an unlocked pack
 * and fail somewhere far from the cause. The helper written to stop fixtures failing
 * silently had a silent-success hole on the one call where silence was possible.
 */
function must<T>(
  result: { data: T | null; error: PostgrestError | null },
  what: string,
): NonNullable<T> {
  if (result.error) {
    // The SQLSTATE, not just the message. In CI, "new row violates row-level security
    // policy" without `42501` / `23503` / `23514` beside it is the difference between
    // "the policy is wrong" and "the foreign key is wrong".
    throw new Error(`Fixture failed to ${what}: [${result.error.code}] ${result.error.message}`, {
      cause: result.error,
    });
  }
  if (result.data === null) throw new Error(`Fixture failed to ${what}: no rows returned`);
  if (Array.isArray(result.data) && result.data.length === 0) {
    throw new Error(
      `Fixture failed to ${what}: the request succeeded but affected no rows — row-level security refused it silently`,
    );
  }
  return result.data as NonNullable<T>;
}

/** A fixture that quietly built less than it was asked for makes later assertions vacuous. */
function expectCount(actual: number, wanted: number, what: string): void {
  if (actual !== wanted) {
    throw new Error(`Fixture failed to ${what}: expected ${wanted} rows, got ${actual}`);
  }
}

export interface PackFixture {
  packId: string;
  slug: string;
  categoryId: string;
  /** Pack item and the gear item it references, paired at the source. */
  items: { itemId: string; gearItemId: string }[];
  itemIds: string[];
  gearItemIds: string[];
}

export interface PackFixtureOptions {
  visibility?: 'private' | 'public';
  /**
   * Distinct gear items, one pack item each. Must be at least 1.
   *
   * Zero is rejected rather than allowed, because an empty fixture makes the suite's
   * strongest negatives vacuous rather than wrong: `.in('id', [])` returns `[]`, so
   * `expect(items.data).toEqual([])` passes having asked about nothing, and a
   * `for (const id of [])` loop runs no assertions at all. "A private pack's items are
   * invisible to a stranger" would report green against a pack with no items.
   */
  itemCount?: number;
  /** Set locked_at after the contents exist — the write policies refuse edits once it is set. */
  locked?: boolean;
  slug?: string;
}

export async function createPack(
  user: TestUser,
  options: PackFixtureOptions = {},
): Promise<PackFixture> {
  const { visibility = 'private', itemCount = 1, locked = false, slug } = options;
  const db = user.client;

  if (!Number.isInteger(itemCount) || itemCount < 1) {
    throw new Error(`createPack needs itemCount >= 1, got ${itemCount}`);
  }

  const gear = must(
    await db
      .from('gear_items')
      .insert(
        Array.from({ length: itemCount }, (_, index) => ({
          name: `Gear ${index + 1}`,
          brand: 'Testbrand',
          weight: 100 + index,
          weight_unit: 'g',
        })),
      )
      .select('id'),
    'insert gear items',
  );
  expectCount(gear.length, itemCount, 'insert gear items');

  const [pack] = must(
    await db
      .from('packs')
      .insert({ name: 'Test pack', visibility, ...(slug ? { slug } : {}) })
      .select('id, slug'),
    'insert pack',
  );

  const [category] = must(
    await db
      .from('pack_categories')
      .insert({ pack_id: pack.id, name: 'Shelter', position: 0 })
      .select('id'),
    'insert pack category',
  );

  const items = must(
    await db
      .from('pack_items')
      .insert(
        gear.map((g, index) => ({
          pack_category_id: category.id,
          gear_item_id: g.id,
          quantity: 1,
          position: index,
        })),
      )
      .select('id, gear_item_id'),
    'insert pack items',
  );
  expectCount(items.length, itemCount, 'insert pack items');

  // Last, so the contents are in place before the freeze the policies then enforce.
  if (locked) {
    const [locked_pack] = must(
      await db
        .from('packs')
        .update({ locked_at: new Date().toISOString() })
        .eq('id', pack.id)
        .select('id, locked_at'),
      'lock pack',
    );
    // Asserted, not assumed. A fixture that says `locked: true` and returns an unlocked
    // pack would send every rule-2 assertion green or red for the wrong reason.
    if (!locked_pack?.locked_at) throw new Error('Fixture failed to lock pack: locked_at is null');
  }

  return {
    packId: pack.id,
    slug: pack.slug,
    categoryId: category.id,
    // Paired rather than two arrays that happen to line up. The correspondence
    // (this pack item holds this gear item) is real and relied on by the tests; as
    // parallel arrays it was an invariant held only by insertion order, which also
    // assumed PostgREST returns a multi-row insert in the order it was sent.
    items: items.map((i) => ({ itemId: i.id, gearItemId: i.gear_item_id as string })),
    itemIds: items.map((i) => i.id),
    gearItemIds: items.map((i) => i.gear_item_id as string),
  };
}
