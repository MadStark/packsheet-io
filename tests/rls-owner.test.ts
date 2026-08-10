import { describe, it, expect, beforeAll } from 'vitest';
import { anonClient, createUser, type TestUser } from './support/local-database';
import { createPack, type PackFixture } from './support/fixtures';

/**
 * Two signed-in users, and the boundary between them.
 *
 * The anon tests cover the stranger. This file covers the case that is easier to get
 * wrong, because both parties hold a valid token and the difference between them is
 * one column: a policy written with USING and no WITH CHECK, or one that trusts a
 * `user_id` the client sent, passes every anonymous test in the suite and still lets
 * any account read or rewrite any other.
 */

let alice: TestUser;
let mallory: TestUser;
let alicePrivate: PackFixture;

beforeAll(async () => {
  alice = await createUser('alice');
  mallory = await createUser('mallory');
  alicePrivate = await createPack(alice, { visibility: 'private', itemCount: 2 });
});

describe('one user cannot reach another user’s private pack', () => {
  it('returns zero rows for it, by id and by slug', async () => {
    const byId = await mallory.client.from('packs').select('id').eq('id', alicePrivate.packId);
    const bySlug = await mallory.client.from('packs').select('id').eq('slug', alicePrivate.slug);

    expect(byId.data).toEqual([]);
    expect(bySlug.data).toEqual([]);
  });

  it('returns zero rows for its categories, items and gear', async () => {
    const categories = await mallory.client
      .from('pack_categories')
      .select('id')
      .eq('pack_id', alicePrivate.packId);
    const items = await mallory.client
      .from('pack_items')
      .select('id')
      .in('id', alicePrivate.itemIds);
    const gear = await mallory.client
      .from('gear_items')
      .select('id')
      .in('id', alicePrivate.gearItemIds);

    expect(categories.data).toEqual([]);
    expect(items.data).toEqual([]);
    expect(gear.data).toEqual([]);
  });

  // An UPDATE that matches no rows is not an error in PostgREST — it is a successful
  // request affecting nothing. So the assertion that matters is on Alice's row.
  it('cannot rename or delete it', async () => {
    await mallory.client
      .from('packs')
      .update({ name: 'Owned by Mallory' })
      .eq('id', alicePrivate.packId);
    await mallory.client.from('packs').delete().eq('id', alicePrivate.packId);

    const { data } = await alice.client
      .from('packs')
      .select('name')
      .eq('id', alicePrivate.packId)
      .single();
    expect(data?.name).toBe('Test pack');
  });
});

describe('a user cannot write a row into someone else’s name', () => {
  it('is refused an insert that claims another user_id', async () => {
    const { error } = await mallory.client
      .from('packs')
      .insert({ name: 'Planted', user_id: alice.id })
      .select('id');

    // 42501 — the row-level-security refusal, asserted rather than "some error".
    // `not.toBeNull()` alone is satisfied by a renamed column, a stale PostgREST schema
    // cache, a 502, or any other failure that has nothing to do with the policy.
    expect(error?.code).toBe('42501');
  });

  // WITH CHECK on the update policy. Without it, the row would be handed over and
  // simply vanish from Mallory's own view — a write she should never have been
  // allowed to make, failing silently.
  it('is refused an update that reassigns its own row to another user', async () => {
    const mine = await createPack(mallory, { visibility: 'private' });

    const { error } = await mallory.client
      .from('packs')
      .update({ user_id: alice.id })
      .eq('id', mine.packId)
      .select('id');

    expect(error?.code).toBe('42501');

    // And the row really did stay hers.
    const { data } = await mallory.client.from('packs').select('id').eq('id', mine.packId).single();
    expect(data?.id).toBe(mine.packId);
  });
});

/**
 * The escalation this schema's composite foreign keys exist to prevent.
 *
 * Foreign keys are checked by the system, NOT under row level security, so a plain
 * `gear_item_id references gear_items(id)` accepts any gear id from anyone who has one.
 * Combined with the anon read policy on gear_items — which exposes gear referenced by a
 * PUBLIC pack — that is a complete read primitive for another user's private closet:
 * make a public pack, point an item at their gear id, read it back as a stranger.
 *
 * `pack_items(user_id, gear_item_id) references gear_items(user_id, id)` closes it in
 * the schema, where no policy edit can reopen it.
 */
describe('a pack cannot reference another user’s gear', () => {
  it('refuses the pack item, and the gear stays invisible to the world', async () => {
    const mine = await createPack(mallory, { visibility: 'public' });
    const stolen = alicePrivate.gearItemIds[0];

    const { error } = await mallory.client
      .from('pack_items')
      .insert({ pack_category_id: mine.categoryId, gear_item_id: stolen, quantity: 1 })
      .select('id');

    // 23503 — foreign key violation, which is the mechanism under test. This is the
    // PR's headline security assertion, and "an error happened" would keep it green if
    // the insert started failing for some unrelated reason while the composite key had
    // been quietly replaced by a plain one.
    expect(error?.code).toBe('23503');

    // The end of the attack chain, asserted rather than inferred: even having tried,
    // Alice's gear is not readable by a stranger.
    const { data } = await anonClient().from('gear_items').select('id').eq('id', stolen);
    expect(data).toEqual([]);
  });

  it('refuses a category re-parented into another user’s pack', async () => {
    const { error } = await mallory.client
      .from('pack_categories')
      .insert({ pack_id: alicePrivate.packId, name: 'Injected', position: 0 })
      .select('id');

    // 42501, not 23503, and the difference is informative: the insert policy asks
    // whether the parent pack is visible and unlocked, and Alice's private pack is not
    // visible to Mallory at all — so row-level security refuses this before the
    // composite foreign key is ever consulted. The FK is the backstop underneath, and
    // it is what the public-pack case in the next describe relies on.
    expect(error?.code).toBe('42501');

    // The category does not exist under Alice's pack either.
    const { data } = await alice.client
      .from('pack_categories')
      .select('id')
      .eq('pack_id', alicePrivate.packId)
      .eq('name', 'Injected');
    expect(data).toEqual([]);
  });
});

describe('an owner keeps full access to their own pack', () => {
  it('reads, updates and deletes it', async () => {
    const mine = await createPack(alice, { visibility: 'private' });

    const read = await alice.client.from('packs').select('id').eq('id', mine.packId);
    expect(read.data).toHaveLength(1);

    const updated = await alice.client
      .from('packs')
      .update({ name: 'Renamed by owner' })
      .eq('id', mine.packId)
      .select('name');
    expect(updated.error).toBeNull();
    expect(updated.data?.[0].name).toBe('Renamed by owner');

    const deleted = await alice.client.from('packs').delete().eq('id', mine.packId).select('id');
    expect(deleted.error).toBeNull();
    expect(deleted.data).toHaveLength(1);
  });
});

/**
 * The write half of the boundary, against a PUBLIC pack.
 *
 * This was the largest gap in the first version of this suite, and how it happened is
 * worth recording. Every ownership test above is about `packs`. Replacing
 * `user_id = (select auth.uid())` with `true` in the seven write policies on
 * gear_items, pack_categories and pack_items left the whole suite green — while
 * Mallory could rename Alice's gear, delete it, rename her category and delete her
 * pack items.
 *
 * PUBLIC is the load-bearing word. A write policy is only reachable for rows the
 * caller can already SELECT, and publishing a pack is precisely what makes the owner's
 * rows selectable by strangers. So the blast radius of a weakened write policy is not
 * an edge case, it is every published pack: vandalisable and deletable by anyone with
 * an account.
 */
describe('a signed-in stranger cannot write to another user’s PUBLIC pack', () => {
  let alicePublic: PackFixture;

  beforeAll(async () => {
    alicePublic = await createPack(alice, { visibility: 'public', itemCount: 2 });
  });

  // Proves the premise instead of assuming it: these rows really are visible to
  // Mallory, so the tests below exercise the write policies and not the read ones.
  it('can read the pack and its gear — which is what publishing means', async () => {
    const pack = await mallory.client.from('packs').select('id').eq('id', alicePublic.packId);
    const gear = await mallory.client
      .from('gear_items')
      .select('id')
      .in('id', alicePublic.gearItemIds);

    expect(pack.data).toHaveLength(1);
    expect(gear.data).toHaveLength(alicePublic.gearItemIds.length);
  });

  // Every assertion here reads Alice's row back afterwards rather than checking the
  // write's own result: a refused write and a write that matched no rows are
  // byte-identical to PostgREST (204, no error), so the write's return value cannot
  // distinguish "refused" from "succeeded".
  it('cannot rename or delete the gear behind it', async () => {
    const gearId = alicePublic.items[0].gearItemId;

    await mallory.client.from('gear_items').update({ name: 'VANDALISED' }).eq('id', gearId);
    await mallory.client.from('gear_items').delete().eq('id', gearId);

    const { data } = await alice.client.from('gear_items').select('name').eq('id', gearId).single();
    expect(data?.name).toBe('Gear 1');
  });

  it('cannot rename or delete its categories', async () => {
    await mallory.client
      .from('pack_categories')
      .update({ name: 'VANDALISED' })
      .eq('id', alicePublic.categoryId);
    await mallory.client.from('pack_categories').delete().eq('id', alicePublic.categoryId);

    const { data } = await alice.client
      .from('pack_categories')
      .select('name')
      .eq('id', alicePublic.categoryId)
      .single();
    expect(data?.name).toBe('Shelter');
  });

  it('cannot change or delete its items', async () => {
    const itemId = alicePublic.items[0].itemId;

    await mallory.client.from('pack_items').update({ quantity: 99 }).eq('id', itemId);
    await mallory.client.from('pack_items').delete().eq('id', itemId);

    const { data } = await alice.client
      .from('pack_items')
      .select('quantity')
      .eq('id', itemId)
      .single();
    expect(data?.quantity).toBe(1);
  });

  it('cannot add anything to it', async () => {
    await mallory.client
      .from('pack_categories')
      .insert({ pack_id: alicePublic.packId, name: 'Mallory was here', position: 9 });

    const { data } = await alice.client
      .from('pack_categories')
      .select('id')
      .eq('pack_id', alicePublic.packId);
    expect(data).toHaveLength(1);
  });
});
