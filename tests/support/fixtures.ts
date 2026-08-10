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

import type { SupabaseClient } from '@supabase/supabase-js';
import type { TestUser } from './local-database';

/** Anything PostgREST refuses is a broken fixture, and must stop the test immediately. */
function must<T>(result: { data: T | null; error: { message: string } | null }, what: string): T {
  if (result.error) throw new Error(`Fixture failed to ${what}: ${result.error.message}`);
  if (result.data === null) throw new Error(`Fixture failed to ${what}: no rows returned`);
  return result.data;
}

export interface PackFixture {
  packId: string;
  slug: string;
  categoryId: string;
  itemIds: string[];
  gearItemIds: string[];
}

export interface PackFixtureOptions {
  visibility?: 'private' | 'public';
  /** Distinct gear items, one pack item each. */
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
  const db: SupabaseClient = user.client;

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
      .select('id'),
    'insert pack items',
  );

  // Last, so the contents are in place before the freeze the policies then enforce.
  if (locked) {
    must(
      await db
        .from('packs')
        .update({ locked_at: new Date().toISOString() })
        .eq('id', pack.id)
        .select('id'),
      'lock pack',
    );
  }

  return {
    packId: pack.id,
    slug: pack.slug,
    categoryId: category.id,
    itemIds: items.map((i) => i.id),
    gearItemIds: gear.map((g) => g.id),
  };
}
