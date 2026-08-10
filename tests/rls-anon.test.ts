import { describe, it, expect, beforeAll } from 'vitest';
import {
  anonClient,
  countingFetch,
  createUser,
  PACK_TREE_SELECT,
  toOne,
  type TestUser,
} from './support/local-database';
import { createPack, type PackFixture } from './support/fixtures';

/**
 * The `anon` role, against real policies. This is the file Ref 49 is about.
 *
 * Every request below is made with the publishable key and no session — the exact
 * credentials a stranger's browser holds when it opens a shared link. Nothing here
 * runs as `postgres`; a superuser bypasses RLS entirely and would pass no matter what
 * the policies said.
 *
 * The assertions are deliberately weighted towards the NEGATIVE. "A public pack is
 * readable" tells you the plumbing works. "A private pack returns zero rows" is the
 * property the product's promise rests on, and it is the one that silently stops
 * being true.
 *
 * HOW TO CHECK THIS FILE STILL BITES. Every negative here was demonstrated red before
 * being committed, by dropping the policy it depends on and re-running:
 *
 *     drop policy packs_select_public on public.packs;
 *     create policy packs_select_public on public.packs
 *       for select to anon, authenticated using (true);
 *
 * If you weaken a policy and this file stays green, the test is wrong, not the policy.
 */

let owner: TestUser;
let privatePack: PackFixture;
let publicPack: PackFixture;

beforeAll(async () => {
  owner = await createUser('owner');
  privatePack = await createPack(owner, { visibility: 'private', itemCount: 2 });
  publicPack = await createPack(owner, { visibility: 'public', itemCount: 2 });
});

describe('a private pack is unreachable with the anon key', () => {
  it('returns zero rows when asked for it by id', async () => {
    const { data, error } = await anonClient()
      .from('packs')
      .select('id')
      .eq('id', privatePack.packId);

    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  // The share page's actual lookup. A policy that covers the id path and not this one
  // would leak every pack whose slug someone guessed or was once told.
  it('returns zero rows when asked for it by slug', async () => {
    const { data, error } = await anonClient()
      .from('packs')
      .select('id')
      .eq('slug', privatePack.slug);

    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  // citext: the slug is matched case-insensitively, so the private-pack answer has to
  // be zero rows in every casing too, not just the one it was created with.
  it('returns zero rows for a differently-cased slug', async () => {
    const { data, error } = await anonClient()
      .from('packs')
      .select('id')
      .eq('slug', privatePack.slug.toUpperCase());

    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it('hides its categories, its items and its gear', async () => {
    const anon = anonClient();

    const categories = await anon
      .from('pack_categories')
      .select('id')
      .eq('pack_id', privatePack.packId);
    const items = await anon.from('pack_items').select('id').in('id', privatePack.itemIds);
    const gear = await anon.from('gear_items').select('id').in('id', privatePack.gearItemIds);

    expect(categories.data).toEqual([]);
    expect(items.data).toEqual([]);
    expect(gear.data).toEqual([]);
  });

  // Listing the table unfiltered is the crudest attack there is, and the one a
  // per-request filter written in application code most often forgets.
  it('is absent from an unfiltered listing of every table', async () => {
    const anon = anonClient();

    const packs = await anon.from('packs').select('id');
    const items = await anon.from('pack_items').select('id');
    const gear = await anon.from('gear_items').select('id');

    expect(packs.data?.map((p) => p.id)).not.toContain(privatePack.packId);
    for (const id of privatePack.itemIds) expect(items.data?.map((i) => i.id)).not.toContain(id);
    for (const id of privatePack.gearItemIds) expect(gear.data?.map((g) => g.id)).not.toContain(id);
  });
});

describe('a public pack is readable with the anon key', () => {
  it('is found by slug', async () => {
    const { data, error } = await anonClient()
      .from('packs')
      .select('id, visibility')
      .eq('slug', publicPack.slug);

    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data?.[0].id).toBe(publicPack.packId);
  });

  // Not a detail: an unlocked public pack has no snapshots, so without the gear rows
  // the share page renders quantities against blank names.
  it('exposes the gear behind its items', async () => {
    const { data, error } = await anonClient()
      .from('gear_items')
      .select('id, name')
      .in('id', publicPack.gearItemIds);

    expect(error).toBeNull();
    expect(data?.map((g) => g.id).sort()).toEqual([...publicPack.gearItemIds].sort());
  });

  // The scope of publishing: exactly the gear on the pack, and nothing else in the
  // closet. Both packs belong to the same owner here, which is what makes this a real
  // question rather than a restatement of the previous test.
  it('does not expose the rest of the owner’s closet', async () => {
    const { data } = await anonClient()
      .from('gear_items')
      .select('id')
      .in('id', privatePack.gearItemIds);

    expect(data).toEqual([]);
  });
});

describe('the anon key cannot write', () => {
  it('is refused an insert, an update and a delete', async () => {
    const anon = anonClient();

    const inserted = await anon.from('packs').insert({ name: 'Anonymous pack' });
    const updated = await anon
      .from('packs')
      .update({ name: 'Renamed' })
      .eq('id', publicPack.packId);
    const deleted = await anon.from('packs').delete().eq('id', publicPack.packId);

    expect(inserted.error).not.toBeNull();
    expect(updated.error).not.toBeNull();
    expect(deleted.error).not.toBeNull();

    // And the row it tried to rename is untouched.
    const { data } = await anon.from('packs').select('name').eq('id', publicPack.packId);
    expect(data?.[0].name).toBe('Test pack');
  });
});

/**
 * Ref 7's acceptance criterion, measured rather than asserted.
 */
describe('a pack with 40 items loads in one round trip', () => {
  it('returns the whole tree from a single HTTP request', async () => {
    const bigPack = await createPack(owner, { visibility: 'public', itemCount: 40 });

    const counter = countingFetch();
    const { data, error } = await anonClient(counter.fetch)
      .from('packs')
      .select(PACK_TREE_SELECT)
      .eq('slug', bigPack.slug)
      .single();

    expect(error).toBeNull();
    expect(counter.count()).toBe(1);

    const categories = data?.pack_categories ?? [];
    expect(categories).toHaveLength(1);
    expect(categories[0].pack_items).toHaveLength(40);
    // Embedded through to the closet, so nothing needs a second query for names.
    const gear = toOne<{ name: string }>(categories[0].pack_items[0].gear_items);
    expect(gear.name).toBeTruthy();
  });
});
