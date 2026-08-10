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

    expect(error).not.toBeNull();
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

    expect(error).not.toBeNull();
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

    expect(error).not.toBeNull();

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

    expect(error).not.toBeNull();
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
