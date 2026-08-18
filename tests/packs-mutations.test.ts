import { describe, it, expect } from 'vitest';
import { adminSql, createUser, type TestUser } from './support/local-database';
import {
  addGearItemsToCategory,
  buildCustomItemSnapshot,
  createCustomPackItem,
  createPack,
  createPackCategory,
  deletePack,
  deletePackCategory,
  deletePackItem,
  duplicatePack,
  movePackCategory,
  movePackItem,
  renamePack,
  renamePackCategory,
  setPackDescription,
  setPackItemCarriage,
  setPackItemPacked,
  setPackItemQuantity,
  setPackTripType,
  updatePack,
  updatePackItem,
} from '../src/lib/packs/mutations';
import { loadPackForEdit } from '../src/lib/packs/query';
import { planCategoryMove, planItemMove } from '../src/lib/packs/reorder';
import { deleteGearItems } from '../src/lib/gear/mutations';
import { computeTotals } from '../src/lib/totals';
import type { CustomPackItemInput, PackInput } from '../src/lib/packs/form';
import type { CurrencyCode } from '../src/lib/money';
import type { PacksheetClient } from '../src/lib/supabase';

/** `CurrencyCode` is a branded type, so a literal needs the same cast every other test in
 *  this suite uses for one — see `tests/money.test.ts`, which names the reason: the brand
 *  exists so a bare `string` cannot be passed where a validated code is required. */
const GBP = 'GBP' as CurrencyCode;

/**
 * Every write in `src/lib/packs/mutations.ts`, against the real database, through PostgREST,
 * as a real authenticated user under row level security — the same path the pack editor's
 * pages and endpoints take.
 *
 * WHY A REAL DATABASE RATHER THAN A DOUBLE. Almost everything worth asserting about these
 * functions is a property of Postgres executing them: the policies that decide which rows a
 * caller may touch, the composite foreign keys that make cross-tenant writes
 * unrepresentable, the cascade behind a category delete, the BEFORE DELETE trigger that
 * freezes gear into referencing pack items, and the silent zero-row result a locked pack
 * produces. A mock would assert that this file's own expectations agree with themselves.
 *
 * WHY THE WRITES ARE CALLED DIRECTLY RATHER THAN THROUGH A PAGE. `vitest.config.ts:64`
 * excludes `src/pages/`, so a write statement written in frontmatter is one no test can
 * execute — PK-4's independent review proved that by mutation testing the gear pages, where
 * mutations to the delete path survived because nothing in the suite could reach the
 * statement at all. Every function below is the exact function the pages will call.
 *
 * ---------------------------------------------------------------------------
 * THE FOUR ACCEPTANCE CRITERIA THIS FILE EXISTS FOR
 * ---------------------------------------------------------------------------
 *
 *   1. Creating a custom item leaves `gear_items` BYTE-FOR-BYTE unchanged. Nothing on that
 *      path may write to the closet, however tempting "create the gear row and reference
 *      it" is as an implementation.
 *   2. A custom item and an item whose gear was DELETED are distinguishable by
 *      `snapshot -> 'gear_item_id'`. The deleted-gear side is produced by exercising the
 *      real deletion path, so the comparison is against what the database trigger actually
 *      writes rather than against this file's idea of it.
 *   3. A custom item contributes its weight to the pack total through `computeTotals`.
 *   4. There is NO CAP on the number of packs. Asserted rather than left true by accident.
 *
 * SHARED-DATABASE DISCIPLINE. `vitest.config.ts` does not reset the database between files,
 * and `gear_items_select_via_public_pack` means gear on ANY public pack from ANY earlier
 * file is visible to every authenticated client here. Every fixture below is therefore
 * created by its own freshly made user and asserted on by exact id, or scoped with an
 * explicit `.eq('user_id', …)` — never by "everything this client can see".
 */

// ---------------------------------------------------------------------------
// Fixtures — built through PostgREST as their owner, never as `postgres`
// ---------------------------------------------------------------------------

/**
 * `tests/support/fixtures.ts`'s `createPack` builds a pack in one call, and this file
 * deliberately does not use it: the functions under test ARE the pack-building functions, so
 * a fixture that built rows another way would leave the writes themselves unexercised. Every
 * fixture here is assembled by calling `createPack`/`createPackCategory` from
 * `src/lib/packs/mutations.ts` and asserting each step landed, which is also how the fixture
 * helper's own header argues fixtures should be built — through the policies, not around
 * them.
 */
function packInput(name: string, over: Partial<PackInput> = {}): PackInput {
  return { name, description: null, trip_type: null, ...over };
}

function customInput(over: Partial<CustomPackItemInput> = {}): CustomPackItemInput {
  return {
    name: 'Hand-rolled stove',
    brand: null,
    category: null,
    description: null,
    weight_grams: 250,
    price: null,
    currency: null,
    quantity: 1,
    worn: false,
    consumable: false,
    packed: false,
    ...over,
  };
}

/** A pack with one category, built through the functions under test. */
async function makePack(user: TestUser, name = 'Test pack') {
  const pack = await createPack(user.client, user.id, packInput(name));
  expect(pack.error).toBeNull();
  expect(pack.id).not.toBeNull();

  const category = await createPackCategory(user.client, user.id, pack.id!, { name: 'Shelter' }, 0);
  expect(category.error).toBeNull();
  expect(category.id).not.toBeNull();

  return { packId: pack.id!, categoryId: category.id! };
}

/** Gear in the owner's closet, inserted the way the closet itself does. */
async function makeGear(user: TestUser, count: number, weightGrams = 100): Promise<string[]> {
  const { data, error } = await user.client
    .from('gear_items')
    .insert(
      Array.from({ length: count }, (_, index) => ({
        name: `Gear ${index + 1}`,
        weight_grams: weightGrams + index,
      })),
    )
    .select('id');
  expect(error).toBeNull();
  expect(data).toHaveLength(count);
  return (data ?? []).map((row) => row.id);
}

/** Every column of the owner's closet, ordered, for the byte-for-byte comparison. */
async function closetSnapshot(user: TestUser) {
  const { data, error } = await user.client
    .from('gear_items')
    .select('*')
    .eq('user_id', user.id)
    .order('id', { ascending: true });
  expect(error).toBeNull();
  return data;
}

/** The stored pack item rows, read without RLS so nothing is hidden by a policy. */
async function storedItems(itemIds: string[]) {
  return adminSql<{
    id: string;
    gear_item_id: string | null;
    snapshot: Record<string, unknown> | null;
    quantity: number;
    worn: boolean;
    consumable: boolean;
    packed: boolean;
    position: number;
  }>(
    `select id, gear_item_id, snapshot, quantity, worn, consumable, packed, position
       from public.pack_items
      where id = any($1::uuid[])
      order by position, id`,
    [itemIds],
  );
}

/** The run a planner needs, read back as the rows actually are right now. */
async function itemRun(client: PacksheetClient, categoryId: string) {
  const { data } = await client
    .from('pack_items')
    .select('id, position')
    .eq('pack_category_id', categoryId);
  return { parentId: categoryId, rows: data ?? [] };
}

async function orderedItemIds(categoryId: string): Promise<string[]> {
  const rows = await adminSql<{ id: string }>(
    `select id from public.pack_items where pack_category_id = $1 order by position, id`,
    [categoryId],
  );
  return rows.map((r) => r.id);
}

// ---------------------------------------------------------------------------
// Packs
// ---------------------------------------------------------------------------

describe('createPack', () => {
  it('creates one pack and reports the row it actually wrote', async () => {
    const user = await createUser('packs-create');

    const result = await createPack(
      user.client,
      user.id,
      packInput('Cairngorms winter', { description: 'March', trip_type: 'winter' }),
    );

    expect(result.error).toBeNull();
    expect(result.count).toBe(1);
    expect(result.id).not.toBeNull();

    const [row] = await adminSql<{
      name: string;
      description: string | null;
      trip_type: string | null;
      visibility: string;
      slug: string;
      locked_at: string | null;
      user_id: string;
    }>(
      `select name, description, trip_type, visibility, slug, locked_at, user_id
         from public.packs where id = $1`,
      [result.id],
    );

    expect(row.name).toBe('Cairngorms winter');
    expect(row.description).toBe('March');
    expect(row.trip_type).toBe('winter');
    expect(row.user_id).toBe(user.id);
    // The three columns createPack deliberately does not write, each landing on its own
    // default: private, unlocked, and an opaque slug that does not leak the pack's title.
    expect(row.visibility).toBe('private');
    expect(row.locked_at).toBeNull();
    expect(row.slug).toMatch(/^[a-z0-9]{12}$/);
    expect(row.slug.toLowerCase()).not.toContain('cairngorms');
  });

  /**
   * ACCEPTANCE CRITERION 4. There is no cap on how many packs an account may have, and
   * nothing counts the existing ones before creating another. Asserted as an absence,
   * because a limit is exactly the kind of thing that gets added to a create path by
   * reflex — with this here, doing so fails a test instead of quietly shipping.
   */
  it('enforces no cap on the number of packs', async () => {
    const user = await createUser('packs-no-cap');

    const results = [];
    for (let index = 0; index < 25; index += 1) {
      results.push(await createPack(user.client, user.id, packInput(`Pack ${index}`)));
    }

    for (const result of results) {
      expect(result.error).toBeNull();
      expect(result.count).toBe(1);
    }

    const [{ count }] = await adminSql<{ count: string }>(
      `select count(*)::text as count from public.packs where user_id = $1`,
      [user.id],
    );
    expect(Number(count)).toBe(25);
  });

  it('refuses to create a pack owned by somebody other than the caller', async () => {
    const owner = await createUser('packs-create-owner');
    const stranger = await createUser('packs-create-stranger');

    // The `userId` argument and the client's own identity disagree. The insert writes
    // `user_id` explicitly, so `packs_insert_own`'s WITH CHECK refuses it rather than the
    // column's auth.uid() default quietly producing a row owned by the caller.
    const result = await createPack(owner.client, stranger.id, packInput('Not mine'));

    expect(result.error).not.toBeNull();
    expect(result.error?.code).toBe('42501');
    expect(result.id).toBeNull();
    expect(result.count).toBe(0);

    const rows = await adminSql(`select id from public.packs where name = 'Not mine'`);
    expect(rows).toEqual([]);
  });
});

describe('editing a pack', () => {
  it('saves the whole form with updatePack', async () => {
    const user = await createUser('packs-update');
    const { packId } = await makePack(user);

    const result = await updatePack(
      user.client,
      user.id,
      packId,
      packInput('Renamed', { description: 'New notes', trip_type: 'alpine' }),
    );

    expect(result.error).toBeNull();
    expect(result.count).toBe(1);

    const [row] = await adminSql<{ name: string; description: string; trip_type: string }>(
      `select name, description, trip_type from public.packs where id = $1`,
      [packId],
    );
    expect(row).toEqual({ name: 'Renamed', description: 'New notes', trip_type: 'alpine' });
  });

  it('renames a pack without touching its other fields', async () => {
    const user = await createUser('packs-rename');
    const pack = await createPack(
      user.client,
      user.id,
      packInput('Before', { description: 'Keep me', trip_type: 'weekend' }),
    );

    const result = await renamePack(user.client, user.id, pack.id!, 'After');

    expect(result.error).toBeNull();
    expect(result.count).toBe(1);

    const [row] = await adminSql<{ name: string; description: string; trip_type: string }>(
      `select name, description, trip_type from public.packs where id = $1`,
      [pack.id],
    );
    // The whole reason the narrow setter exists: an inline rename must not clear a
    // description the visitor never opened.
    expect(row).toEqual({ name: 'After', description: 'Keep me', trip_type: 'weekend' });
  });

  it('clears a description with null rather than an empty string', async () => {
    const user = await createUser('packs-description');
    const pack = await createPack(user.client, user.id, packInput('A', { description: 'gone' }));

    const result = await setPackDescription(user.client, user.id, pack.id!, null);

    expect(result.error).toBeNull();
    expect(result.count).toBe(1);

    const [row] = await adminSql<{ description: string | null }>(
      `select description from public.packs where id = $1`,
      [pack.id],
    );
    // "Has no description" must have exactly one spelling, or every later reader has to
    // know about two.
    expect(row.description).toBeNull();
  });

  /**
   * `packs.trip_type` carries no CHECK constraint on purpose, and `setPackTripType` takes a
   * bare string for that reason — PK-33/PK-65 import packs whose trip-type vocabularies are
   * their own, and an imported value has to survive a round trip byte-identically. This is
   * the database half of the assertion `tests/packs-form.test.ts` makes about the parser.
   */
  it.each(['PCT section hike', 'vacaciones', 'Bikepack - gravel'])(
    'stores the unrecognised trip type %j unchanged',
    async (tripType) => {
      const user = await createUser('packs-trip-type');
      const { packId } = await makePack(user);

      const result = await setPackTripType(user.client, user.id, packId, tripType);

      expect(result.error).toBeNull();
      expect(result.count).toBe(1);

      const [row] = await adminSql<{ trip_type: string }>(
        `select trip_type from public.packs where id = $1`,
        [packId],
      );
      expect(row.trip_type).toBe(tripType);
    },
  );

  it('clears a trip type to null rather than storing "no trip type" as one', async () => {
    const user = await createUser('packs-trip-type-null');
    const pack = await createPack(user.client, user.id, packInput('A', { trip_type: 'winter' }));

    await setPackTripType(user.client, user.id, pack.id!, null);

    const [row] = await adminSql<{ trip_type: string | null }>(
      `select trip_type from public.packs where id = $1`,
      [pack.id],
    );
    expect(row.trip_type).toBeNull();
  });
});

describe('deletePack', () => {
  it('removes the pack, its categories and its items, and no gear at all', async () => {
    const user = await createUser('packs-delete');
    const { packId, categoryId } = await makePack(user);
    const gearIds = await makeGear(user, 2);
    await addGearItemsToCategory(user.client, user.id, categoryId, gearIds, 0);

    const result = await deletePack(user.client, user.id, packId);

    expect(result.error).toBeNull();
    expect(result.count).toBe(1);

    // Gone for real, not merely hidden behind a column some later query could forget.
    expect(await adminSql(`select id from public.packs where id = $1`, [packId])).toEqual([]);
    expect(
      await adminSql(`select id from public.pack_categories where pack_id = $1`, [packId]),
    ).toEqual([]);
    expect(
      await adminSql(`select id from public.pack_items where pack_category_id = $1`, [categoryId]),
    ).toEqual([]);

    // Rule 1: a pack item points AT the closet and never owns it, so deleting a pack removes
    // appearances of gear, never gear.
    const gear = await adminSql<{ id: string }>(
      `select id from public.gear_items where id = any($1::uuid[])`,
      [gearIds],
    );
    expect(gear.map((g) => g.id).sort()).toEqual([...gearIds].sort());
  });

  it('reports zero rows, without an error, for a pack that is not the caller’s', async () => {
    const owner = await createUser('packs-delete-owner');
    const stranger = await createUser('packs-delete-stranger');
    const { packId } = await makePack(owner);

    // `packs_delete_own`'s USING clause filters the row out rather than raising, so this is
    // the silent-zero case that `count` exists to make visible.
    const result = await deletePack(stranger.client, stranger.id, packId);

    expect(result.error).toBeNull();
    expect(result.count).toBe(0);
    expect(await adminSql(`select id from public.packs where id = $1`, [packId])).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

describe('categories', () => {
  it('creates, renames and reports one row each time', async () => {
    const user = await createUser('packs-categories');
    const pack = await createPack(user.client, user.id, packInput('A'));

    const created = await createPackCategory(user.client, user.id, pack.id!, { name: 'Sleep' }, 3);
    expect(created.error).toBeNull();
    expect(created.count).toBe(1);

    const renamed = await renamePackCategory(user.client, user.id, created.id!, 'Sleep system');
    expect(renamed.error).toBeNull();
    expect(renamed.count).toBe(1);

    const [row] = await adminSql<{ name: string; position: number; user_id: string }>(
      `select name, position, user_id from public.pack_categories where id = $1`,
      [created.id],
    );
    expect(row).toEqual({ name: 'Sleep system', position: 3, user_id: user.id });
  });

  it('allows two categories in one pack to share a name', async () => {
    const user = await createUser('packs-categories-dupes');
    const pack = await createPack(user.client, user.id, packInput('A'));

    const first = await createPackCategory(user.client, user.id, pack.id!, { name: 'Extras' }, 0);
    const second = await createPackCategory(user.client, user.id, pack.id!, { name: 'Extras' }, 1);

    // `pack_categories.name` is not unique and nothing may rely on it being so — see
    // duplicate_pack's comment on the cross product a join on name produces.
    expect(first.error).toBeNull();
    expect(second.error).toBeNull();
    expect(first.id).not.toBe(second.id);
  });

  it('takes every item in the category with it when deleted, and still reports one row', async () => {
    const user = await createUser('packs-category-delete');
    const { categoryId } = await makePack(user);
    const gearIds = await makeGear(user, 3);
    await addGearItemsToCategory(user.client, user.id, categoryId, gearIds, 0);

    const result = await deletePackCategory(user.client, user.id, categoryId);

    expect(result.error).toBeNull();
    // ONE, not three. `count` reports the rows THIS statement deleted; the three cascaded
    // items are the foreign key's doing and are deliberately not counted here — see the
    // function's own comment for why counting them would mean reporting a stale SELECT as
    // if it were the write's result.
    expect(result.count).toBe(1);
    expect(
      await adminSql(`select id from public.pack_items where pack_category_id = $1`, [categoryId]),
    ).toEqual([]);
    // And the gear itself is untouched, again.
    expect(
      await adminSql(`select id from public.gear_items where id = any($1::uuid[])`, [gearIds]),
    ).toHaveLength(3);
  });

  it('cannot re-parent a category into another user’s pack', async () => {
    const owner = await createUser('packs-category-owner');
    const stranger = await createUser('packs-category-stranger');
    const { packId } = await makePack(owner);

    // The composite FK `(user_id, pack_id) references packs (user_id, id)` makes the target
    // row simply not exist, which is why this is unrepresentable rather than merely refused.
    const result = await createPackCategory(
      stranger.client,
      stranger.id,
      packId,
      { name: 'Mine now' },
      0,
    );

    expect(result.error).not.toBeNull();
    expect(result.id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Closet items, added as references
// ---------------------------------------------------------------------------

describe('addGearItemsToCategory', () => {
  it('adds a reference and never a copy', async () => {
    const user = await createUser('packs-add-reference');
    const { packId, categoryId } = await makePack(user);
    const [gearId] = await makeGear(user, 1, 480);

    const result = await addGearItemsToCategory(user.client, user.id, categoryId, [gearId], 0);

    expect(result.error).toBeNull();
    expect(result.count).toBe(1);

    const rows = await adminSql<{ gear_item_id: string | null; snapshot: unknown }>(
      `select gear_item_id, snapshot from public.pack_items where pack_category_id = $1`,
      [categoryId],
    );
    expect(rows).toEqual([{ gear_item_id: gearId, snapshot: null }]);

    // Rule 1 in action: renaming the closet item changes what the pack renders, because the
    // pack holds a reference rather than a copy taken at add time.
    await user.client.from('gear_items').update({ name: 'Renamed in the closet' }).eq('id', gearId);
    const { data: pack } = await loadPackForEdit(user.client, user.id, packId);
    expect(pack?.pack_categories[0].pack_items[0].gear_items?.name).toBe('Renamed in the closet');
  });

  it('adds the same gear item twice when asked twice', async () => {
    const user = await createUser('packs-add-twice');
    const { categoryId } = await makePack(user);
    const [gearId] = await makeGear(user, 1);

    const result = await addGearItemsToCategory(
      user.client,
      user.id,
      categoryId,
      [gearId, gearId],
      0,
    );

    expect(result.error).toBeNull();
    // Nothing makes (category, gear) unique, and that is correct: the same fuel canister
    // listed twice for two legs is a real thing a visitor means. Collapsing them would give
    // no way to express it.
    expect(result.count).toBe(2);
    const rows = await adminSql(
      `select id from public.pack_items where pack_category_id = $1 and gear_item_id = $2`,
      [categoryId, gearId],
    );
    expect(rows).toHaveLength(2);
  });

  it('lays consecutive positions from the caller’s append point', async () => {
    const user = await createUser('packs-add-positions');
    const { categoryId } = await makePack(user);
    const gearIds = await makeGear(user, 3);

    await addGearItemsToCategory(user.client, user.id, categoryId, gearIds, 5);

    const rows = await adminSql<{ position: number }>(
      `select position from public.pack_items where pack_category_id = $1 order by position`,
      [categoryId],
    );
    expect(rows.map((r) => r.position)).toEqual([5, 6, 7]);
  });

  it('treats an empty list as a no-op rather than issuing a degenerate insert', async () => {
    const user = await createUser('packs-add-empty');
    const { categoryId } = await makePack(user);

    const result = await addGearItemsToCategory(user.client, user.id, categoryId, [], 0);

    expect(result.error).toBeNull();
    expect(result.count).toBe(0);
    expect(
      await adminSql(`select id from public.pack_items where pack_category_id = $1`, [categoryId]),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Counts are read off the write's own result
// ---------------------------------------------------------------------------

describe('every write reports what it actually did', () => {
  it('reports zero, not the caller’s id count, when the parent pack is locked', async () => {
    const user = await createUser('packs-count-locked');
    const { packId, categoryId } = await makePack(user);
    const gearIds = await makeGear(user, 2);

    await user.client
      .from('packs')
      .update({ locked_at: new Date().toISOString() })
      .eq('id', packId);

    const result = await addGearItemsToCategory(user.client, user.id, categoryId, gearIds, 0);

    // The caller passed two ids and nothing was written. A count taken from the input would
    // have reported "2 items added" about a write that touched nothing.
    expect(result.count).toBe(0);
    expect(gearIds).toHaveLength(2);
    expect(
      await adminSql(`select id from public.pack_items where pack_category_id = $1`, [categoryId]),
    ).toEqual([]);
  });

  it('reports zero with no error at all for an update a policy silently filters out', async () => {
    const user = await createUser('packs-count-silent');
    const { packId, categoryId } = await makePack(user);
    const [gearId] = await makeGear(user, 1);
    await addGearItemsToCategory(user.client, user.id, categoryId, [gearId], 0);
    const [item] = await storedItems(
      (
        await adminSql<{ id: string }>(
          `select id from public.pack_items where pack_category_id = $1`,
          [categoryId],
        )
      ).map((r) => r.id),
    );

    await user.client
      .from('packs')
      .update({ locked_at: new Date().toISOString() })
      .eq('id', packId);

    const result = await setPackItemQuantity(user.client, user.id, item.id, 9);

    // `pack_items_update_own`'s USING clause requires the parent pack to be unlocked, and a
    // filtered UPDATE is `{ data: [], error: null }` over PostgREST — not an error. `count`
    // is the ONLY thing that distinguishes "saved" from "that pack is frozen".
    expect(result.error).toBeNull();
    expect(result.count).toBe(0);
    const [after] = await storedItems([item.id]);
    expect(after.quantity).toBe(1);
  });

  it('reports zero for a delete of an id that is not there', async () => {
    const user = await createUser('packs-count-missing');
    const result = await deletePackItem(
      user.client,
      user.id,
      '00000000-0000-4000-8000-000000000000',
    );

    expect(result.error).toBeNull();
    expect(result.count).toBe(0);
  });

  it('reports zero for a rename of another user’s pack', async () => {
    const owner = await createUser('packs-count-stranger-owner');
    const stranger = await createUser('packs-count-stranger');
    const { packId } = await makePack(owner, 'Owner pack');

    const result = await renamePack(stranger.client, stranger.id, packId, 'Taken');

    expect(result.error).toBeNull();
    expect(result.count).toBe(0);
    const [row] = await adminSql<{ name: string }>(`select name from public.packs where id = $1`, [
      packId,
    ]);
    expect(row.name).toBe('Owner pack');
  });
});

// ---------------------------------------------------------------------------
// The one-off custom item
// ---------------------------------------------------------------------------

describe('createCustomPackItem', () => {
  /** ACCEPTANCE CRITERION 1. */
  it('leaves gear_items byte-for-byte unchanged', async () => {
    const user = await createUser('packs-custom-closet');
    const { categoryId } = await makePack(user);
    await makeGear(user, 3);

    const before = await closetSnapshot(user);
    expect(before).toHaveLength(3);

    const result = await createCustomPackItem(
      user.client,
      user.id,
      categoryId,
      customInput({ name: 'Titanium windscreen', weight_grams: 32 }),
      0,
    );
    expect(result.error).toBeNull();
    expect(result.count).toBe(1);

    const after = await closetSnapshot(user);

    // Not "the same number of rows" — every column of every row, including `updated_at`,
    // serialised identically. The tempting implementation of "add a custom item" creates a
    // gear row and references it, which would fill a visitor's closet with one-off entries
    // they never asked to keep.
    expect(after).toEqual(before);
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  it('writes gear_item_id null and a snapshot, which the schema already permits', async () => {
    const user = await createUser('packs-custom-shape');
    const { categoryId } = await makePack(user);

    const capturedAt = new Date('2026-08-18T09:41:00.000Z');
    const values = customInput({
      name: 'Hand-rolled stove',
      brand: 'Homemade',
      category: 'Cooking',
      description: 'Cat food tin',
      weight_grams: 12.5,
      price: 0.5,
      currency: GBP,
      quantity: 2,
      consumable: false,
      worn: false,
      packed: true,
    });
    const created = await createCustomPackItem(
      user.client,
      user.id,
      categoryId,
      values,
      4,
      capturedAt,
    );
    expect(created.error).toBeNull();

    const [row] = await storedItems([created.id!]);

    // `pack_items_reference_or_snapshot` is satisfied by the snapshot half; no new column
    // and no migration were needed for any of this.
    expect(row.gear_item_id).toBeNull();
    expect(row.snapshot).toEqual(buildCustomItemSnapshot(values, capturedAt));
    expect(row.snapshot).toEqual({
      name: 'Hand-rolled stove',
      brand: 'Homemade',
      category: 'Cooking',
      description: 'Cat food tin',
      weight: 12.5,
      price: 0.5,
      currency: 'GBP',
      photo_path: null,
      gear_item_id: null,
      captured_at: '2026-08-18T09:41:00.000Z',
    });
    // The per-list settings are ordinary columns, not part of the snapshot: they belong to
    // this appearance of the item, not to the item.
    expect(row).toMatchObject({ quantity: 2, worn: false, consumable: false, packed: true });
    expect(row.position).toBe(4);
  });

  /**
   * THE SHAPE IS PINNED AGAINST THE REAL FUNCTION, not against a list written out in this
   * file. `src/lib/totals.ts` reads `pack_items.snapshot` through one code path and has no
   * provenance field to branch on, so a key spelled differently by one of the two writers is
   * a line whose weight silently vanishes from a pack total — or a TypeError on a pack the
   * visitor can no longer open.
   */
  it('writes exactly the keys private.gear_item_snapshot() writes', async () => {
    const user = await createUser('packs-custom-keys');
    const { categoryId } = await makePack(user);
    const [gearId] = await makeGear(user, 1);

    const [{ snapshot: frozen }] = await adminSql<{ snapshot: Record<string, unknown> }>(
      `select private.gear_item_snapshot(g) as snapshot from public.gear_items g where g.id = $1`,
      [gearId],
    );

    const created = await createCustomPackItem(user.client, user.id, categoryId, customInput(), 0);
    const [row] = await storedItems([created.id!]);

    expect(Object.keys(row.snapshot ?? {}).sort()).toEqual(Object.keys(frozen).sort());
    // The two keys PK-67 is about, asserted by name so a regression is legible: the weight
    // is a gram figure and there is no unit key beside it. Writing even a harmless-looking
    // 'weight_unit': 'g' would reintroduce the second shape that migration exists to have
    // eliminated.
    expect(Object.keys(frozen)).toContain('weight');
    expect(Object.keys(frozen)).not.toContain('weight_unit');
    expect(row.snapshot).not.toHaveProperty('weight_unit');
    expect(typeof row.snapshot?.weight).toBe('number');
  });

  /** ACCEPTANCE CRITERION 2. */
  it('is distinguishable from an item whose gear was deleted, by snapshot -> gear_item_id', async () => {
    const user = await createUser('packs-custom-discriminator');
    const { categoryId } = await makePack(user);
    const [gearId] = await makeGear(user, 1, 700);

    await addGearItemsToCategory(user.client, user.id, categoryId, [gearId], 0);
    const [referencing] = await adminSql<{ id: string }>(
      `select id from public.pack_items where pack_category_id = $1`,
      [categoryId],
    );
    const custom = await createCustomPackItem(user.client, user.id, categoryId, customInput(), 1);

    // The REAL deletion path, not a hand-written snapshot: deleteGearItems fires
    // `gear_items_snapshot_before_delete`, which freezes the gear into every referencing
    // pack item, and the composite FK's `on delete set null (gear_item_id)` then clears the
    // column. So the comparison below is against what the database actually writes.
    const deleted = await deleteGearItems(user.client, user.id, [gearId]);
    expect(deleted.error).toBeNull();
    expect(deleted.count).toBe(1);

    const rows = await adminSql<{
      id: string;
      column_gear_item_id: string | null;
      has_key: boolean;
      snapshot_gear_item_id: string | null;
      is_json_null: boolean;
    }>(
      `select id,
              gear_item_id as column_gear_item_id,
              snapshot ? 'gear_item_id' as has_key,
              snapshot ->> 'gear_item_id' as snapshot_gear_item_id,
              snapshot -> 'gear_item_id' = 'null'::jsonb as is_json_null
         from public.pack_items
        where id = any($1::uuid[])`,
      [[referencing.id, custom.id]],
    );
    const frozen = rows.find((r) => r.id === referencing.id)!;
    const authored = rows.find((r) => r.id === custom.id)!;

    // The COLUMN cannot tell them apart — it is null on both — which is exactly why the
    // snapshot has to.
    expect(frozen.column_gear_item_id).toBeNull();
    expect(authored.column_gear_item_id).toBeNull();

    // The frozen copy names the gear row it came from; the authored item names nothing.
    expect(frozen.snapshot_gear_item_id).toBe(gearId);
    expect(authored.snapshot_gear_item_id).toBeNull();

    // And the key is PRESENT on both. Absent and null are different in jsonb, and `->>`
    // returns SQL NULL for either — so without the explicit key a reader could not tell an
    // authored item from one written by a version of this code that forgot to write it.
    // PK-66's promote-into-the-closet offer is built on this distinction.
    expect(authored.has_key).toBe(true);
    expect(authored.is_json_null).toBe(true);
    expect(frozen.has_key).toBe(true);
    expect(frozen.is_json_null).toBe(false);
  });

  /** ACCEPTANCE CRITERION 3. */
  it('contributes its weight to the pack total through computeTotals', async () => {
    const user = await createUser('packs-custom-totals');
    const { packId, categoryId } = await makePack(user);
    const [gearId] = await makeGear(user, 1, 100);
    await addGearItemsToCategory(user.client, user.id, categoryId, [gearId], 0);

    const before = await loadPackForEdit(user.client, user.id, packId);
    expect(before.error).toBeNull();
    const beforeTotals = computeTotals(before.data!);
    expect(beforeTotals.total).toBe(100);

    await createCustomPackItem(
      user.client,
      user.id,
      categoryId,
      customInput({ weight_grams: 250, quantity: 2 }),
      1,
    );

    const after = await loadPackForEdit(user.client, user.id, packId);
    expect(after.error).toBeNull();
    const afterTotals = computeTotals(after.data!);

    // 100 g of gear plus two of a 250 g custom item. `computeTotals` reads the snapshot
    // through the same `resolvePackItem` it reads a gear row through, and cannot tell which
    // writer produced it — which is the whole reason the snapshot shape has to match.
    expect(afterTotals.total).toBe(600);
    expect(afterTotals.base).toBe(600);
    // Counts are QUANTITIES, not rows — one gear item plus two of the custom one.
    expect(afterTotals.itemCount).toBe(3);
    expect(afterTotals.packedCount).toBe(0);
  });

  it('puts a worn custom item in the worn bucket, not the base one', async () => {
    const user = await createUser('packs-custom-worn');
    const { packId, categoryId } = await makePack(user);

    await createCustomPackItem(
      user.client,
      user.id,
      categoryId,
      customInput({ weight_grams: 400, worn: true }),
      0,
    );

    const { data } = await loadPackForEdit(user.client, user.id, packId);
    const totals = computeTotals(data!);

    expect(totals.worn).toBe(400);
    expect(totals.base).toBe(0);
    // The three buckets partition the total exactly — the invariant the exclusive constraint
    // and this module's three-way carriage vocabulary exist to keep true.
    expect(totals.base + totals.worn + totals.consumable).toBe(totals.total);
  });

  it('cannot be created in another user’s category', async () => {
    const owner = await createUser('packs-custom-owner');
    const stranger = await createUser('packs-custom-stranger');
    const { categoryId } = await makePack(owner);

    const result = await createCustomPackItem(
      stranger.client,
      stranger.id,
      categoryId,
      customInput(),
      0,
    );

    expect(result.error).not.toBeNull();
    expect(result.id).toBeNull();
    expect(result.count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Per-item settings
// ---------------------------------------------------------------------------

describe('per-item settings', () => {
  async function itemFixture(label: string) {
    const user = await createUser(label);
    const { packId, categoryId } = await makePack(user);
    const [gearId] = await makeGear(user, 1);
    await addGearItemsToCategory(user.client, user.id, categoryId, [gearId], 0);
    const [item] = await adminSql<{ id: string }>(
      `select id from public.pack_items where pack_category_id = $1`,
      [categoryId],
    );
    return { user, packId, categoryId, itemId: item.id };
  }

  it('saves the whole per-item form with updatePackItem', async () => {
    const { user, itemId } = await itemFixture('packs-item-update');

    const result = await updatePackItem(user.client, user.id, itemId, {
      quantity: 3,
      worn: false,
      consumable: true,
      packed: true,
    });

    expect(result.error).toBeNull();
    expect(result.count).toBe(1);
    const [row] = await storedItems([itemId]);
    expect(row).toMatchObject({ quantity: 3, worn: false, consumable: true, packed: true });
  });

  it('sets the quantity without disturbing anything else', async () => {
    const { user, itemId } = await itemFixture('packs-item-quantity');
    await setPackItemPacked(user.client, user.id, itemId, true);

    const result = await setPackItemQuantity(user.client, user.id, itemId, 4);

    expect(result.count).toBe(1);
    const [row] = await storedItems([itemId]);
    expect(row.quantity).toBe(4);
    expect(row.packed).toBe(true);
  });

  it('refuses a quantity of zero at the database, if one ever got this far', async () => {
    const { user, itemId } = await itemFixture('packs-item-quantity-zero');

    // The form layer refuses this long before here; the constraint is the backstop for a
    // caller that bypassed it, and this asserts the backstop is real rather than assumed.
    const result = await setPackItemQuantity(user.client, user.id, itemId, 0);

    expect(result.error).not.toBeNull();
    expect(result.count).toBe(0);
  });

  it('moves an item between the three carriages, one statement at a time', async () => {
    const { user, itemId } = await itemFixture('packs-item-carriage');

    for (const [carriage, expected] of [
      ['worn', { worn: true, consumable: false }],
      ['consumable', { worn: false, consumable: true }],
      ['carried', { worn: false, consumable: false }],
    ] as const) {
      const result = await setPackItemCarriage(user.client, user.id, itemId, carriage);

      expect(result.error).toBeNull();
      expect(result.count).toBe(1);
      const [row] = await storedItems([itemId]);
      expect({ worn: row.worn, consumable: row.consumable }).toEqual(expected);
    }
  });

  /**
   * The straight-line proof that the three-way vocabulary is what keeps
   * `pack_items_worn_consumable_exclusive` unreachable: going from worn to consumable is ONE
   * statement that sets both columns, so there is no intermediate row with both true for the
   * constraint to refuse. Two independent setters would have to pass through exactly that.
   */
  it('goes from worn straight to consumable without a refused intermediate write', async () => {
    const { user, itemId } = await itemFixture('packs-item-carriage-swap');

    await setPackItemCarriage(user.client, user.id, itemId, 'worn');
    const result = await setPackItemCarriage(user.client, user.id, itemId, 'consumable');

    expect(result.error).toBeNull();
    expect(result.count).toBe(1);
    const [row] = await storedItems([itemId]);
    expect({ worn: row.worn, consumable: row.consumable }).toEqual({
      worn: false,
      consumable: true,
    });
  });

  it('refuses a both-flags write at the database, if one ever got this far', async () => {
    const { user, itemId } = await itemFixture('packs-item-exclusive');

    const { error } = await user.client
      .from('pack_items')
      .update({ worn: true, consumable: true })
      .eq('id', itemId)
      .select('id');

    // Not reachable through anything in src/lib/packs/, which is the point: the constraint
    // is the defence against psql, a restore and a future import path, not against this form.
    expect(error).not.toBeNull();
    expect(error?.code).toBe('23514');
    expect(error?.message).toContain('pack_items_worn_consumable_exclusive');
  });

  it('ticks and unticks the packing checklist', async () => {
    const { user, itemId } = await itemFixture('packs-item-packed');

    expect((await setPackItemPacked(user.client, user.id, itemId, true)).count).toBe(1);
    expect((await storedItems([itemId]))[0].packed).toBe(true);
    expect((await setPackItemPacked(user.client, user.id, itemId, false)).count).toBe(1);
    expect((await storedItems([itemId]))[0].packed).toBe(false);
  });

  it('removes an appearance of a piece of gear, not the gear', async () => {
    const { user, categoryId, itemId } = await itemFixture('packs-item-delete');
    const [{ gear_item_id: gearId }] = await storedItems([itemId]);

    const result = await deletePackItem(user.client, user.id, itemId);

    expect(result.error).toBeNull();
    expect(result.count).toBe(1);
    expect(
      await adminSql(`select id from public.pack_items where pack_category_id = $1`, [categoryId]),
    ).toEqual([]);
    expect(await adminSql(`select id from public.gear_items where id = $1`, [gearId])).toHaveLength(
      1,
    );
  });
});

// ---------------------------------------------------------------------------
// The RPC wrappers
// ---------------------------------------------------------------------------

describe('the RPC wrappers', () => {
  async function treeFixture(label: string) {
    const user = await createUser(label);
    const pack = await createPack(user.client, user.id, packInput('Reorder me'));
    const first = await createPackCategory(user.client, user.id, pack.id!, { name: 'A' }, 0);
    const second = await createPackCategory(user.client, user.id, pack.id!, { name: 'B' }, 1);
    const gearIds = await makeGear(user, 4);
    await addGearItemsToCategory(user.client, user.id, first.id!, gearIds.slice(0, 2), 0);
    await addGearItemsToCategory(user.client, user.id, second.id!, gearIds.slice(2), 0);
    return { user, packId: pack.id!, categoryIds: [first.id!, second.id!] };
  }

  it('applies a within-category item move planned by reorder.ts', async () => {
    const { user, packId, categoryIds } = await treeFixture('packs-rpc-move-item');
    const run = await itemRun(user.client, categoryIds[0]);
    const before = await orderedItemIds(categoryIds[0]);

    // The plan comes from the real planner. A hand-written [{id, position}] here would be a
    // third implementation of the ordering rules, in the test meant to prove there are two.
    const plan = planItemMove(run, run, before[1], 0);
    const result = await movePackItem(
      user.client,
      user.id,
      packId,
      before[1],
      categoryIds[0],
      plan.runs,
    );

    expect(result.error).toBeNull();
    expect(await orderedItemIds(categoryIds[0])).toEqual([before[1], before[0]]);
  });

  it('applies a cross-category move, re-parenting the item', async () => {
    const { user, packId, categoryIds } = await treeFixture('packs-rpc-move-across');
    const from = await itemRun(user.client, categoryIds[0]);
    const to = await itemRun(user.client, categoryIds[1]);
    const moving = (await orderedItemIds(categoryIds[0]))[0];

    const plan = planItemMove(from, to, moving, 0);
    const result = await movePackItem(
      user.client,
      user.id,
      packId,
      moving,
      categoryIds[1],
      plan.runs,
    );

    expect(result.error).toBeNull();
    expect(await orderedItemIds(categoryIds[0])).not.toContain(moving);
    expect((await orderedItemIds(categoryIds[1]))[0]).toBe(moving);
  });

  it('applies a category reorder', async () => {
    const { user, packId, categoryIds } = await treeFixture('packs-rpc-move-category');
    const rows = await adminSql<{ id: string; position: number }>(
      `select id, position from public.pack_categories where pack_id = $1`,
      [packId],
    );

    const plan = planCategoryMove({ parentId: packId, rows }, categoryIds[1], 0);
    const result = await movePackCategory(user.client, user.id, packId, plan.runs);

    expect(result.error).toBeNull();
    const after = await adminSql<{ id: string }>(
      `select id from public.pack_categories where pack_id = $1 order by position, id`,
      [packId],
    );
    expect(after.map((c) => c.id)).toEqual([categoryIds[1], categoryIds[0]]);
  });

  it('refuses a move against a pack the caller does not own', async () => {
    const { packId, categoryIds } = await treeFixture('packs-rpc-owner');
    const stranger = await createUser('packs-rpc-stranger');
    const [itemId] = await orderedItemIds(categoryIds[0]);

    const result = await movePackItem(
      stranger.client,
      stranger.id,
      packId,
      itemId,
      categoryIds[0],
      [],
    );

    // The `for update` on `packs` inside the function is both the lock and the
    // authorisation check — a pack that is someone else's is simply not found there.
    expect(result.error).not.toBeNull();
    expect(result.error?.message).toMatch(/not yours/);
  });

  it('duplicates a pack and hands back the new id', async () => {
    const { user, packId } = await treeFixture('packs-rpc-duplicate');
    await user.client.from('packs').update({ visibility: 'public' }).eq('id', packId);

    const result = await duplicatePack(user.client, user.id, packId);

    expect(result.error).toBeNull();
    expect(result.id).not.toBeNull();
    expect(result.id).not.toBe(packId);

    const [copy] = await adminSql<{
      name: string;
      visibility: string;
      slug: string;
      locked_at: string | null;
    }>(`select name, visibility, slug, locked_at from public.packs where id = $1`, [result.id]);
    const [original] = await adminSql<{ name: string; slug: string }>(
      `select name, slug from public.packs where id = $1`,
      [packId],
    );

    // Verbatim name, fresh slug, private and unlocked — the migration's decisions, asserted
    // at the wrapper so a caller can rely on them.
    expect(copy.name).toBe(original.name);
    expect(copy.slug).not.toBe(original.slug);
    expect(copy.visibility).toBe('private');
    expect(copy.locked_at).toBeNull();

    const [counts] = await adminSql<{ categories: string; items: string }>(
      `select (select count(*) from public.pack_categories c where c.pack_id = $1)::text as categories,
              (select count(*) from public.pack_items i
                 join public.pack_categories c on c.id = i.pack_category_id
                where c.pack_id = $1)::text as items`,
      [result.id],
    );
    expect(Number(counts.categories)).toBe(2);
    expect(Number(counts.items)).toBe(4);
  });

  it('copies a custom item’s snapshot verbatim into the duplicate', async () => {
    const user = await createUser('packs-rpc-duplicate-custom');
    const { packId, categoryId } = await makePack(user);
    const capturedAt = new Date('2026-08-18T10:00:00.000Z');
    const values = customInput({ name: 'Cosy socks', weight_grams: 88 });
    await createCustomPackItem(user.client, user.id, categoryId, values, 0, capturedAt);

    const copy = await duplicatePack(user.client, user.id, packId);
    expect(copy.error).toBeNull();

    const rows = await adminSql<{ gear_item_id: string | null; snapshot: Record<string, unknown> }>(
      `select i.gear_item_id, i.snapshot
         from public.pack_items i
         join public.pack_categories c on c.id = i.pack_category_id
        where c.pack_id = $1`,
      [copy.id],
    );

    expect(rows).toHaveLength(1);
    // `pack_items_reference_or_snapshot` makes a copy without the snapshot unrepresentable —
    // an authored item has nothing else to render itself from — so the copy is still a
    // custom item, discriminator and all.
    expect(rows[0].gear_item_id).toBeNull();
    expect(rows[0].snapshot).toEqual(buildCustomItemSnapshot(values, capturedAt));
  });
});
