import { describe, it, expect, beforeAll } from 'vitest';
import {
  anonClient,
  countingFetch,
  createUser,
  packTreeQuery,
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

    // The public pack must be IN these listings before their not-containing anything is
    // worth asserting. An unfiltered select plus `.not.toContain()` is satisfied by an
    // empty or truncated result, and PostgREST truncates at `db-max-rows` — unset
    // locally, and ordinary production hardening. Without this, the strongest negative
    // in the file quietly becomes a tautology.
    expect(packs.data?.map((p) => p.id)).toContain(publicPack.packId);
    expect(items.data?.map((i) => i.id)).toContain(publicPack.itemIds[0]);
    expect(gear.data?.map((g) => g.id)).toContain(publicPack.gearItemIds[0]);

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
    const { data, error } = await packTreeQuery(anonClient(counter.fetch), bigPack.slug).single();

    expect(error).toBeNull();
    expect(counter.count()).toBe(1);

    const categories = data?.pack_categories ?? [];
    expect(categories).toHaveLength(1);
    expect(categories[0].pack_items).toHaveLength(40);
    // Embedded through to the closet, so nothing needs a second query for names.
    expect(categories[0].pack_items[0].gear_items?.name).toBeTruthy();
  });
});

/**
 * What a frozen pack carries forward.
 *
 * READ THIS BEFORE TREATING THE ASSERTION BELOW AS A RULE: it still describes what the
 * code does, but the reasoning that put it there has been overtaken.
 *
 * The migration's grants block records a known gap — a public pack exposes the whole
 * gear row, because column-level grants are the obvious fix and are incompatible with
 * PostgREST embedding (measured, not assumed). `gear_item_snapshot()` was written to
 * omit `notes` and `url` on the strength of it: the live path had not decided whether to
 * show them, a snapshot is read by `anon` on a public pack and is permanent, so freezing
 * them would have published them somewhere a later fix to the live path could not reach.
 *
 * That objection is now spent. `notes` and `url` are public, deliberately, along with
 * `price` — see the describe below and PACK_TREE_SELECT's comment for why. Only
 * `user_id` is left of the gap.
 *
 * Which turns this omission from a protection into an open question of a different kind.
 * If those fields are extras worth showing on a live item, then a locked pack — or one
 * whose gear was deleted — quietly loses them, and rule 3's promise that deleting gear
 * never destroys pack history holds for the weight but not for the remark beside it.
 * Whether the snapshot should start capturing them is a change to `gear_item_snapshot()`
 * and belongs with the freeze rules rather than here. That is PK-58, which is written and
 * carries the one decision this file cannot make: whether to backfill the snapshots
 * already written, or leave old and new frozen items rendering differently. This test
 * records what is true today, so the change is a deliberate flip rather than a silent one
 * — invert it, do not delete it.
 */
describe('the frozen snapshot carries only what renders the item', () => {
  it('omits notes and url', async () => {
    const locked = await createPack(owner, { visibility: 'public', itemCount: 1, locked: true });

    const { data } = await anonClient()
      .from('pack_items')
      .select('snapshot')
      .eq('id', locked.itemIds[0])
      .single();

    expect(data?.snapshot).not.toHaveProperty('notes');
    expect(data?.snapshot).not.toHaveProperty('url');
    // Still a usable display record.
    expect(data?.snapshot).toMatchObject({ name: 'Gear 1', weight_unit: 'g' });
  });
});

/**
 * What a public pack tells a stranger, decided rather than leaked.
 *
 * `price`, `notes` and `url` are all published on purpose. A price sits on the same
 * footing as a weight — what a setup cost is a large part of why the list is worth
 * sharing at all, and nobody has ever proposed hiding a weight. `notes` and `url` are
 * extras an owner chooses to attach to an item: a remark, and a link to somewhere the
 * item is sold or written about. A reader who followed a shared link is welcome to all
 * three. None of them is a headline field and the share page should not lead with them,
 * but that is Ref 26 deciding a layout, not this file deciding a privilege.
 *
 * `url` is deliberately not called "the purchase link" anywhere in this codebase. That
 * is the common case and not the definition — it may point at a review, a manufacturer's
 * page, a forum thread — and a name that narrowed it would be quoted back later as
 * licence to render it as a Buy button.
 *
 * What is left of the migration's known gap is `user_id`, which is a different kind of
 * thing entirely: the owner's JWT `sub`, which nobody asked for and which lets a stranger
 * group every public pack by author. Still Ref 26's to close.
 *
 * PINNED HERE RATHER THAN LEFT TO THE GRANTS BLOCK, because today "anon can read these"
 * is true by ACCIDENT: it follows from the table-level grant the known gap exists to
 * complain about, not from anything recording that they are meant to be visible. Both
 * candidate fixes for that gap — a `security_invoker` view exposing only the public
 * columns, or moving the private columns to a 1:1 owner-only table — require writing down
 * a column list. A view drawn up to hide `user_id` that took these three with it would
 * silently empty every price on the share page and drop the extras, and the totals engine
 * would report a pack costing nothing and be right to, having been asked for nothing.
 * This test is what makes that a build failure instead of a discovery.
 */
describe('a public pack carries its prices and extras to an anonymous reader', () => {
  it('lets a stranger read price, currency, notes and url on the referenced gear', async () => {
    const pack = await createPack(owner, { visibility: 'public', itemCount: 2 });

    const extras = {
      price: 25,
      currency: 'GBP',
      notes: 'Runs small, size up.',
      url: 'https://example.com/reviews/the-thing',
    };

    // Written on the gear rows, the way an owner fills in their closet — nothing is
    // written to the pack items, so this also exercises the reference rather than a copy.
    const { error: updateError } = await owner.client
      .from('gear_items')
      .update(extras)
      .in('id', pack.gearItemIds);
    expect(updateError).toBeNull();

    // Named explicitly rather than read through packTreeQuery, and that is the point of
    // the test rather than a shortcut around it. PACK_TREE_SELECT exists to carry what
    // the TOTALS ENGINE reads; `notes` and `url` are display extras it has no use for. If
    // this asserted through that select, then narrowing the select — a query decision —
    // would fail a test about PRIVILEGE, and widening it would be the only way to make a
    // privilege test pass. Asking for the four columns directly keeps the two questions
    // apart: what a stranger is ALLOWED to read, and what any given page bothers to ask
    // for. Reaching these rows at all also exercises the anon policy on gear_items, which
    // grants read only to gear a public pack references.
    const { data, error } = await anonClient()
      .from('gear_items')
      .select('id, price, currency, notes, url')
      .in('id', pack.gearItemIds);

    expect(error).toBeNull();
    expect(data).toHaveLength(2);
    for (const gear of data ?? []) {
      expect(gear).toMatchObject(extras);
    }
  });
});
