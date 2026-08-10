import { describe, it, expect, beforeAll } from 'vitest';
import { adminSql, adminSqlWith, createUser, toOne, type TestUser } from './support/local-database';
import { anonClient, packTreeQuery } from './support/local-database';
import { createPack } from './support/fixtures';

/**
 * The three rules the model exists to enforce (Ref 7), tested as behaviour.
 *
 *   1. Editing a gear item updates every pack referencing it, except where a pack item
 *      holds an override.
 *   2. Locking a pack copies current values into snapshot, freezing it.
 *   3. Deleting a gear item never destroys pack history.
 *
 * Written through PostgREST as the owner, because that is how the application will do
 * it and because a rule that only holds for a superuser is not a rule.
 */

let owner: TestUser;

beforeAll(async () => {
  owner = await createUser('schema');
});

describe('rule 1 — a pack item references the closet rather than copying it', () => {
  it('shows an edited gear item’s new values on every pack referencing it', async () => {
    const pack = await createPack(owner, { itemCount: 1 });

    await owner.client
      .from('gear_items')
      .update({ name: 'Renamed tent', weight: 999 })
      .eq('id', pack.gearItemIds[0]);

    const { data } = await owner.client
      .from('pack_items')
      .select('gear_items(name, weight)')
      .eq('id', pack.itemIds[0])
      .single();

    const gear = toOne<{ name: string; weight: string }>(data?.gear_items);
    expect(gear.name).toBe('Renamed tent');
    expect(Number(gear.weight)).toBe(999);
  });

  it('keeps per-list divergence in overrides, leaving the master record alone', async () => {
    const pack = await createPack(owner, { itemCount: 1 });

    await owner.client
      .from('pack_items')
      .update({ overrides: { weight: 450 } })
      .eq('id', pack.itemIds[0]);

    const item = await owner.client
      .from('pack_items')
      .select('overrides, gear_items(weight)')
      .eq('id', pack.itemIds[0])
      .single();

    expect(item.data?.overrides).toEqual({ weight: 450 });
    // The closet is untouched: the divergence belongs to this list only.
    expect(Number(toOne<{ weight: string }>(item.data?.gear_items).weight)).toBe(100);
  });

  it('defaults overrides to an empty object rather than null, so consumers need not branch', async () => {
    const pack = await createPack(owner, { itemCount: 1 });
    const { data } = await owner.client
      .from('pack_items')
      .select('overrides')
      .eq('id', pack.itemIds[0])
      .single();

    expect(data?.overrides).toEqual({});
  });
});

describe('rule 2 — locking a pack freezes it', () => {
  it('copies current gear values into each item’s snapshot', async () => {
    const pack = await createPack(owner, { itemCount: 2, locked: true });

    const { data } = await owner.client
      .from('pack_items')
      .select('snapshot')
      .in('id', pack.itemIds);

    expect(data).toHaveLength(2);
    for (const item of data ?? []) {
      expect(item.snapshot).not.toBeNull();
      expect(item.snapshot.name).toMatch(/^Gear \d+$/);
      expect(item.snapshot.captured_at).toBeTruthy();
    }
  });

  it('refuses edits to a locked pack’s contents', async () => {
    const pack = await createPack(owner, { itemCount: 1, locked: true });

    const updated = await owner.client
      .from('pack_items')
      .update({ quantity: 7 })
      .eq('id', pack.itemIds[0])
      .select('id');
    const inserted = await owner.client
      .from('pack_categories')
      .insert({ pack_id: pack.packId, name: 'Added after locking', position: 1 })
      .select('id');

    // The update matches no rows under the policy; the insert is refused outright.
    expect(updated.data).toEqual([]);
    expect(inserted.error).not.toBeNull();

    const { data } = await owner.client
      .from('pack_items')
      .select('quantity')
      .eq('id', pack.itemIds[0])
      .single();
    expect(data?.quantity).toBe(1);
  });

  // The other four write paths into a locked pack. Each has a `locked_at is null`
  // clause in the migration and none had a test: removing any one of them left the
  // suite green, so rule 2 was pinned on a third of its surface.
  it('refuses inserting a new item into a locked pack', async () => {
    const pack = await createPack(owner, { itemCount: 1, locked: true });

    const { error } = await owner.client
      .from('pack_items')
      .insert({ pack_category_id: pack.categoryId, gear_item_id: pack.gearItemIds[0], quantity: 1 })
      .select('id');

    expect(error).not.toBeNull();

    const { data } = await owner.client
      .from('pack_items')
      .select('id')
      .eq('pack_category_id', pack.categoryId);
    expect(data).toHaveLength(1);
  });

  it('refuses deleting an item from a locked pack', async () => {
    const pack = await createPack(owner, { itemCount: 1, locked: true });

    await owner.client.from('pack_items').delete().eq('id', pack.itemIds[0]);

    const { data } = await owner.client.from('pack_items').select('id').eq('id', pack.itemIds[0]);
    expect(data).toHaveLength(1);
  });

  it('refuses renaming a locked pack’s category', async () => {
    const pack = await createPack(owner, { itemCount: 1, locked: true });

    await owner.client
      .from('pack_categories')
      .update({ name: 'Renamed after locking' })
      .eq('id', pack.categoryId);

    const { data } = await owner.client
      .from('pack_categories')
      .select('name')
      .eq('id', pack.categoryId)
      .single();
    expect(data?.name).toBe('Shelter');
  });

  it('refuses deleting a locked pack’s category', async () => {
    const pack = await createPack(owner, { itemCount: 1, locked: true });

    await owner.client.from('pack_categories').delete().eq('id', pack.categoryId);

    const { data } = await owner.client
      .from('pack_categories')
      .select('id')
      .eq('id', pack.categoryId);
    expect(data).toHaveLength(1);
  });

  // A pack that arrives already locked would never fire the BEFORE UPDATE freeze, so it
  // would be frozen with no snapshots and permanently uneditable — the insert policy
  // refuses the state rather than letting it exist.
  it('refuses a pack created already locked', async () => {
    const { error } = await owner.client
      .from('packs')
      .insert({ name: 'Born locked', locked_at: new Date().toISOString() })
      .select('id');

    expect(error?.code).toBe('42501');
  });

  // A completed trip stays true as the closet evolves: the frozen values do not move
  // when the master record does.
  it('does not follow later edits to the gear it froze', async () => {
    const pack = await createPack(owner, { itemCount: 1, locked: true });

    await owner.client
      .from('gear_items')
      .update({ name: 'Changed after the trip' })
      .eq('id', pack.gearItemIds[0]);

    const { data } = await owner.client
      .from('pack_items')
      .select('snapshot')
      .eq('id', pack.itemIds[0])
      .single();

    expect(data?.snapshot.name).toBe('Gear 1');
  });

  it('unlocks, so a freeze is a decision and not a one-way door', async () => {
    const pack = await createPack(owner, { itemCount: 1, locked: true });

    await owner.client.from('packs').update({ locked_at: null }).eq('id', pack.packId);
    const { data, error } = await owner.client
      .from('pack_items')
      .update({ quantity: 3 })
      .eq('id', pack.itemIds[0])
      .select('quantity');

    expect(error).toBeNull();
    expect(data?.[0].quantity).toBe(3);
  });
});

describe('rule 3 — deleting a gear item never destroys pack history', () => {
  it('leaves a locked pack intact, rendering from its snapshot', async () => {
    const pack = await createPack(owner, { itemCount: 1, locked: true });

    const { error } = await owner.client.from('gear_items').delete().eq('id', pack.gearItemIds[0]);
    expect(error).toBeNull();

    const { data } = await owner.client
      .from('pack_items')
      .select('gear_item_id, snapshot, quantity')
      .eq('id', pack.itemIds[0])
      .single();

    expect(data?.gear_item_id).toBeNull();
    expect(data?.snapshot.name).toBe('Gear 1');
    expect(data?.quantity).toBe(1);
  });

  it('freezes an unlocked pack’s item on the way out rather than blanking it', async () => {
    const pack = await createPack(owner, { itemCount: 1 });

    await owner.client.from('gear_items').delete().eq('id', pack.gearItemIds[0]);

    const { data } = await owner.client
      .from('pack_items')
      .select('gear_item_id, snapshot')
      .eq('id', pack.itemIds[0])
      .single();

    expect(data?.gear_item_id).toBeNull();
    expect(data?.snapshot.name).toBe('Gear 1');
  });

  // The constraint is what makes the trigger's ordering safe to depend on: if the
  // trigger were ever dropped, gear deletion would fail loudly here instead of
  // succeeding and leaving rows nothing can render.
  it('makes a pack item with neither a reference nor a snapshot unrepresentable', async () => {
    await expect(
      adminSql(
        `insert into public.pack_items (user_id, pack_category_id, gear_item_id, snapshot)
         values ($1, gen_random_uuid(), null, null)`,
        [owner.id],
      ),
    ).rejects.toThrow(/pack_items_reference_or_snapshot/);
  });
});

describe('the public lookup', () => {
  it('gives every pack a slug without anyone having to generate one', async () => {
    const pack = await createPack(owner, {});
    expect(pack.slug).toMatch(/^[a-z0-9]{12}$/);
  });

  // The reason the baseline migration installs citext: /p/Ultralight and
  // /p/ultralight must not be two different packs.
  it('treats slugs case-insensitively for uniqueness', async () => {
    const slug = `case-${Date.now().toString(36)}`;
    await createPack(owner, { slug });

    const { error } = await owner.client
      .from('packs')
      .insert({ name: 'Collision', slug: slug.toUpperCase() })
      .select('id');

    expect(error).not.toBeNull();
    expect(error?.code).toBe('23505');
  });

  it('resolves a pack by a differently-cased slug', async () => {
    const slug = `mixed-${Date.now().toString(36)}`;
    const pack = await createPack(owner, { slug, visibility: 'public' });

    const { data } = await owner.client.from('packs').select('id').eq('slug', slug.toUpperCase());

    expect(data?.[0]?.id).toBe(pack.packId);
  });

  // "A single indexed query" (Ref 7). Two halves, because either alone is misleading.
  //
  // The index has to exist — and it has to be USABLE for this predicate, which is not
  // the same thing. A slug column that was text with a citext comparison, or an index
  // built with the wrong operator class, would sit there looking correct and never be
  // consulted; the lookup would degrade to a full scan as the table grows and nothing
  // would say so.
  //
  // What is deliberately NOT asserted is that the planner CHOOSES the index here. On a
  // test database holding a handful of packs a sequential scan is genuinely cheaper
  // and Postgres is right to pick it, so that assertion would pass or fail according
  // to how many rows other tests had inserted first. Disabling seqscan asks the
  // question that is actually stable: can this lookup be answered from the index at
  // all?
  it('has a unique index on slug', async () => {
    const indexes = await adminSql<{ indexdef: string }>(
      `select indexdef from pg_indexes where schemaname = 'public' and tablename = 'packs'`,
    );
    expect(indexes.some((i) => /create unique index .* \(slug\)/i.test(i.indexdef))).toBe(true);
  });

  it('can answer the slug lookup from that index', async () => {
    const plan = await adminSqlWith<{ 'QUERY PLAN': string }>(
      ['set enable_seqscan = off'],
      `explain (costs off) select id from public.packs where slug = 'anything'::citext`,
    );
    const text = plan.map((row) => row['QUERY PLAN']).join('\n');
    expect(text).toMatch(/Index (Only )?Scan/);
  });
});

describe('timestamps are the server’s to set', () => {
  const FORGED = '2000-01-01T00:00:00.000Z';

  it('ignores an updated_at sent by the client on UPDATE', async () => {
    const pack = await createPack(owner, {});

    const { data } = await owner.client
      .from('packs')
      .update({ name: 'Touched', updated_at: FORGED })
      .eq('id', pack.packId)
      .select('updated_at')
      .single();

    expect(new Date(data!.updated_at).getFullYear()).toBeGreaterThan(2000);
  });

  // The baseline migration's reason for making updated_at unforgeable is that
  // optimistic concurrency will compare against it — which applies to the first write
  // as much as the second. A DEFAULT does not carry that: it only supplies a value the
  // client omitted, so INSERT was the one place the guarantee did not hold.
  it('ignores created_at and updated_at sent by the client on INSERT', async () => {
    const { data } = await owner.client
      .from('packs')
      .insert({ name: 'Forged timestamps', created_at: FORGED, updated_at: FORGED })
      .select('created_at, updated_at')
      .single();

    expect(new Date(data!.created_at).getFullYear()).toBeGreaterThan(2000);
    expect(new Date(data!.updated_at).getFullYear()).toBeGreaterThan(2000);
  });

  // All four tables, not just packs: each carries its own pair of triggers, and three
  // of them had no test at all.
  it('stamps updated_at on every core table', async () => {
    const pack = await createPack(owner, { itemCount: 1 });

    const gear = await owner.client
      .from('gear_items')
      .update({ name: 'Touched gear', updated_at: FORGED })
      .eq('id', pack.gearItemIds[0])
      .select('updated_at')
      .single();
    const category = await owner.client
      .from('pack_categories')
      .update({ name: 'Touched category', updated_at: FORGED })
      .eq('id', pack.categoryId)
      .select('updated_at')
      .single();
    const item = await owner.client
      .from('pack_items')
      .update({ quantity: 2, updated_at: FORGED })
      .eq('id', pack.itemIds[0])
      .select('updated_at')
      .single();

    for (const [table, result] of Object.entries({ gear, category, item })) {
      expect(new Date(result.data!.updated_at).getFullYear(), table).toBeGreaterThan(2000);
    }
  });
});

/**
 * The CHECK constraints.
 *
 * Every one of these except pack_items_reference_or_snapshot could be dropped without
 * turning the suite red. They are not decoration: `packs_visibility_check` constrains
 * the column every read policy keys off, and the NaN bound below closes a hole that a
 * plain `>= 0` leaves wide open.
 */
describe('the constrained columns refuse values outside their domain', () => {
  it('refuses NaN and Infinity where a plain >= 0 would let them through', async () => {
    // Postgres orders NaN above every numeric value, so 'NaN' >= 0 is TRUE. Without the
    // upper bound this insert succeeds and poisons every total that touches the row.
    const nan = await owner.client
      .from('gear_items')
      .insert({ name: 'Weight NaN', weight: 'NaN' })
      .select('id');
    expect(nan.error?.code, 'NaN was accepted as a weight').toBe('23514');

    // Infinity is refused one layer earlier, by numeric(12,3) itself — 22003, numeric
    // value out of range, rather than the check constraint. Asserted as its own code
    // rather than folded in with NaN, because "some error" would hide the check
    // constraint being dropped: NaN would then still be refused here and silently
    // accepted everywhere the precision happens to be wider.
    const infinity = await owner.client
      .from('gear_items')
      .insert({ name: 'Weight Infinity', weight: 'Infinity' })
      .select('id');
    expect(infinity.error?.code, 'Infinity was accepted as a weight').toBe('22003');
  });

  it('refuses an unknown weight unit, status or visibility', async () => {
    const unit = await owner.client
      .from('gear_items')
      .insert({ name: 'Bad unit', weight: 1, weight_unit: 'banana' })
      .select('id');
    const status = await owner.client
      .from('gear_items')
      .insert({ name: 'Bad status', status: 'borrowed' })
      .select('id');
    const visibility = await owner.client
      .from('packs')
      .insert({ name: 'Bad visibility', visibility: 'unlisted' })
      .select('id');

    expect(unit.error?.code).toBe('23514');
    expect(status.error?.code).toBe('23514');
    // The one that matters most: 'unlisted' is a value the read policy does not handle,
    // and the constraint is what stops it reaching the column.
    expect(visibility.error?.code).toBe('23514');
  });

  it('refuses half a price', async () => {
    const noCurrency = await owner.client
      .from('gear_items')
      .insert({ name: 'Price only', price: 42 })
      .select('id');
    const noPrice = await owner.client
      .from('gear_items')
      .insert({ name: 'Currency only', currency: 'GBP' })
      .select('id');

    expect(noCurrency.error?.code).toBe('23514');
    expect(noPrice.error?.code).toBe('23514');
  });

  it('refuses a non-positive quantity and a negative position', async () => {
    const pack = await createPack(owner, { itemCount: 1 });

    const quantity = await owner.client
      .from('pack_items')
      .update({ quantity: 0 })
      .eq('id', pack.itemIds[0])
      .select('id');
    const position = await owner.client
      .from('pack_categories')
      .update({ position: -1 })
      .eq('id', pack.categoryId)
      .select('id');

    expect(quantity.error?.code).toBe('23514');
    expect(position.error?.code).toBe('23514');
  });

  // The shape check on snapshot. Without it `{}` satisfies reference-or-snapshot, and
  // an item that renders as nothing is one PATCH away through the ordinary Data API.
  it('refuses a snapshot that could not render the item', async () => {
    const pack = await createPack(owner, { itemCount: 1 });

    const { error } = await owner.client
      .from('pack_items')
      .update({ snapshot: {}, gear_item_id: null })
      .eq('id', pack.itemIds[0])
      .select('id');

    expect(error?.code).toBe('23514');
  });
});

/**
 * Ordering.
 *
 * `position` is deliberately not unique, and the migration says ties "resolve
 * deterministically on id" — which is only true if something actually orders by it.
 * PostgREST emits no ORDER BY unless asked, so without this the ordering index and the
 * column itself would be aspirational.
 */
describe('the pack tree comes back in position order', () => {
  it('orders categories and items, breaking ties on id', async () => {
    const pack = await createPack(owner, { itemCount: 3, visibility: 'public' });

    // Deliberately duplicate positions, which the schema permits: the tie-break is the
    // part that is easy to get wrong and impossible to notice.
    await owner.client.from('pack_items').update({ position: 0 }).in('id', pack.itemIds);

    const { data, error } = await packTreeQuery(anonClient(), pack.slug).single();
    expect(error).toBeNull();

    const items = data!.pack_categories[0].pack_items as { id: string }[];
    expect(items).toHaveLength(3);
    const ids = items.map((i) => i.id);
    expect(ids).toEqual([...ids].sort());
  });
});
