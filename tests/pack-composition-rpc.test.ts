import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import {
  adminSql,
  adminSqlWith,
  anonClient,
  createUser,
  localDatabase,
  type TestUser,
} from './support/local-database';
import { planCategoryMove, planItemMove, type ReorderPlan } from '../src/lib/packs/reorder';
import type { Json } from '../src/lib/database.types';

/**
 * The three pack-composition RPCs (PK-37), against the real database.
 *
 * `20260818000000_pack_composition_functions.sql` adds `move_pack_item`,
 * `move_pack_category` and `duplicate_pack`, and every property worth asserting about them
 * is a property of Postgres executing them: the transaction, the row lock two concurrent
 * reorders contend on, the policies that decide which rows a caller may touch, and the
 * privileges that decide whether an anonymous caller reaches them at all. None of that has
 * a unit-testable stand-in — see the header of tests/support/local-database.ts for why this
 * suite talks to a running stack and fails rather than skips without one.
 *
 * ---------------------------------------------------------------------------
 * THE PLANS ARE BUILT BY THE REAL PLANNER, NOT WRITTEN BY HAND
 * ---------------------------------------------------------------------------
 *
 * Every payload below comes from `planItemMove` / `planCategoryMove` in
 * `src/lib/packs/reorder.ts`. That is the point of the design these functions were written
 * to serve: the migration does NO position arithmetic, so a hand-written `[{id, position}]`
 * here would be a third implementation of the ordering rules, sitting in the test that is
 * supposed to prove there are only two. It would also pass against an RPC that quietly
 * renumbered rows itself, which is the one thing this arrangement exists to forbid.
 *
 * ---------------------------------------------------------------------------
 * WHICH CLIENT EACH TEST USES, AND WHY IT IS NOT ALWAYS THE SAME ONE
 * ---------------------------------------------------------------------------
 *
 *   PostgREST (`user.client.rpc`) is the default and the honest one: it is the surface the
 *   application uses, one transaction per request, under the caller's own JWT.
 *
 *   Raw `pg` connections appear in exactly one describe block — the concurrency one —
 *   because PostgREST gives each request its own transaction and no way to hold one open,
 *   so nothing routed through it can express two overlapping reorders. Those connections
 *   still run as `authenticated` with `request.jwt.claims` set, rather than as the
 *   superuser: the property under test is that the row lock serialises two callers, and
 *   bypassing RLS would remove the policies from a test whose subject is what happens to
 *   rows they guard. tests/pack-lock-concurrency.test.ts connects as `postgres` for the
 *   opposite and equally deliberate reason — there, authorization is what has to be
 *   removed as an explanation.
 *
 *   `adminSql` is used only to read the catalogue, to count rows without RLS filtering the
 *   answer, and to install the failing trigger the last test needs.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A pack with several categories and several items each.
 *
 * tests/support/fixtures.ts's `createPack` builds one category, which is the right shape
 * for every rule-2 and rule-3 assertion in this suite and the wrong shape for this file:
 * a cross-category move needs two runs to exist at all, and a pack with one category gives
 * `duplicate_pack`'s category-id mapping nothing it could mis-associate — the copy comes out
 * right however wrong the mapping is.
 *
 * Built through PostgREST as its owner, with `user_id` left to its `auth.uid()` default,
 * for the reason fixtures.ts sets out in its header: a fixture inserted as `postgres` could
 * be one the insert policies would have refused, and a later assertion passing over a row
 * that could never exist is worse than no test.
 */
interface TreeFixture {
  packId: string;
  slug: string;
  categoryIds: string[];
  /** Item ids per category, in the order they were created (positions 0..n-1). */
  itemIds: string[][];
  allItemIds: string[];
}

interface TreeOptions {
  /**
   * One entry per category: its name, and how many items it holds. Names are NOT required
   * to be distinct, and the duplication test deliberately repeats one — see
   * `duplicate_pack`'s comment on why matching categories back up by name is the trap this
   * fixture has to be able to set.
   */
  categories: { name: string; items: number }[];
  locked?: boolean;
  /** Written to every pack item, so `duplicate_pack` has something to carry verbatim. */
  overrides?: Record<string, unknown>;
}

async function createTree(user: TestUser, options: TreeOptions): Promise<TreeFixture> {
  const db = user.client;
  const totalItems = options.categories.reduce((sum, c) => sum + c.items, 0);

  const gear = await db
    .from('gear_items')
    .insert(
      Array.from({ length: totalItems }, (_, index) => ({
        name: `Gear ${index + 1}`,
        weight_grams: 100 + index,
      })),
    )
    .select('id');
  if (gear.error || !gear.data || gear.data.length !== totalItems) {
    throw new Error(`Fixture failed to insert gear: ${gear.error?.message ?? 'wrong row count'}`);
  }

  const pack = await db.from('packs').insert({ name: 'Composition test pack' }).select('id, slug');
  if (pack.error || !pack.data?.[0]) {
    throw new Error(`Fixture failed to insert pack: ${pack.error?.message ?? 'no rows'}`);
  }

  const categories = await db
    .from('pack_categories')
    .insert(
      options.categories.map((c, index) => ({
        pack_id: pack.data[0].id,
        name: c.name,
        position: index,
      })),
    )
    .select('id, position');
  if (categories.error || categories.data?.length !== options.categories.length) {
    throw new Error(
      `Fixture failed to insert categories: ${categories.error?.message ?? 'wrong row count'}`,
    );
  }
  // Ordered by the position we sent rather than by the order PostgREST returned them in —
  // a multi-row insert is not promised to come back in request order, and every index into
  // `categoryIds` below assumes it did.
  const categoryIds = [...categories.data].sort((a, b) => a.position - b.position).map((c) => c.id);

  const itemIds: string[][] = [];
  let gearCursor = 0;
  for (const [index, category] of options.categories.entries()) {
    const rows = Array.from({ length: category.items }, (_, position) => ({
      pack_category_id: categoryIds[index],
      gear_item_id: gear.data[gearCursor++].id,
      position,
      overrides: (options.overrides ?? {}) as Json,
    }));
    const items = await db.from('pack_items').insert(rows).select('id, position');
    if (items.error || items.data?.length !== category.items) {
      throw new Error(
        `Fixture failed to insert items: ${items.error?.message ?? 'wrong row count'}`,
      );
    }
    itemIds.push([...items.data].sort((a, b) => a.position - b.position).map((i) => i.id));
  }

  if (options.locked) {
    const locked = await db
      .from('packs')
      .update({ locked_at: new Date().toISOString() })
      .eq('id', pack.data[0].id)
      .select('id, locked_at');
    if (locked.error || !locked.data?.[0]?.locked_at) {
      throw new Error(`Fixture failed to lock pack: ${locked.error?.message ?? 'not locked'}`);
    }
  }

  return {
    packId: pack.data[0].id,
    slug: pack.data[0].slug,
    categoryIds,
    itemIds,
    allItemIds: itemIds.flat(),
  };
}

/**
 * The stored rows, read without RLS so a row that escaped into another pack is still seen.
 *
 * A `type` rather than an `interface`, and not interchangeably: `adminSql` constrains its
 * parameter to `Record<string, unknown>`, and only an object TYPE gets TypeScript's implicit
 * index signature. An interface with the same members does not satisfy that constraint.
 */
type StoredItem = {
  id: string;
  position: number;
  pack_category_id: string;
  pack_id: string;
};

async function storedItems(itemIds: string[]): Promise<StoredItem[]> {
  return adminSql<StoredItem>(
    `select i.id, i.position, i.pack_category_id, c.pack_id
       from public.pack_items i
       join public.pack_categories c on c.id = i.pack_category_id
      where i.id = any($1::uuid[])`,
    [itemIds],
  );
}

/** Item ids of one category, in the order a reader of the pack tree would see them. */
async function orderedItemIds(categoryId: string): Promise<string[]> {
  const rows = await adminSql<{ id: string }>(
    `select i.id
       from public.pack_items i
      where i.pack_category_id = $1
      order by i.position, i.id`,
    [categoryId],
  );
  return rows.map((r) => r.id);
}

/** Category ids of one pack, in reading order. */
async function orderedCategoryIds(packId: string): Promise<string[]> {
  const rows = await adminSql<{ id: string }>(
    `select c.id from public.pack_categories c where c.pack_id = $1 order by c.position, c.id`,
    [packId],
  );
  return rows.map((r) => r.id);
}

/** The run a planner needs: the rows of one category, as they are stored right now. */
async function itemRun(parentId: string) {
  const rows = await adminSql<{ id: string; position: number }>(
    `select id, position from public.pack_items where pack_category_id = $1`,
    [parentId],
  );
  return { parentId, rows };
}

async function categoryRun(packId: string) {
  const rows = await adminSql<{ id: string; position: number }>(
    `select id, position from public.pack_categories where pack_id = $1`,
    [packId],
  );
  return { parentId: packId, rows };
}

/** `plan.runs`, as the RPC takes it — the whole point being that nothing reshapes it. */
const runsArgument = (plan: ReorderPlan): Json => plan.runs as unknown as Json;

// ---------------------------------------------------------------------------
// Privileges
// ---------------------------------------------------------------------------

/**
 * The signatures, spelled out, because `has_function_privilege` needs them and because
 * writing them here is what makes this check fail if an argument list ever changes without
 * the revoke/grant pair below it being revisited.
 */
const SIGNATURES = [
  'public.move_pack_item(uuid, uuid, uuid, jsonb)',
  'public.move_pack_category(uuid, jsonb)',
  'public.duplicate_pack(uuid)',
] as const;

describe('the composition RPCs are reachable by authenticated and by nobody else', () => {
  it.each(SIGNATURES)('%s: anon holds no EXECUTE, authenticated does', async (signature) => {
    const [row] = await adminSql<{ anon: boolean; authenticated: boolean; service_role: boolean }>(
      `select has_function_privilege('anon', $1, 'EXECUTE') as anon,
              has_function_privilege('authenticated', $1, 'EXECUTE') as authenticated,
              has_function_privilege('service_role', $1, 'EXECUTE') as service_role`,
      [signature],
    );

    expect(row.authenticated, `${signature} is unreachable — the feature is broken`).toBe(true);
    expect(row.anon, `${signature} is an anonymous RPC endpoint`).toBe(false);
    // The hardening migration's argument, applied to new functions: this project has decided
    // never to hold a service-role key, so a standing grant to it is one nobody is auditing.
    expect(row.service_role).toBe(false);
  });

  /**
   * The privilege, measured at the surface it protects rather than in the catalogue.
   *
   * `has_function_privilege` returning false and `POST /rest/v1/rpc/...` being refused are
   * two different claims, and PK-57 was the case where the first was believed and the
   * second was not true. One end-to-end call is what ties them together.
   */
  it('refuses an anonymous call to move_pack_item over PostgREST', async () => {
    const { error } = await anonClient().rpc('move_pack_item', {
      p_pack_id: '00000000-0000-0000-0000-000000000000',
      p_item_id: '00000000-0000-0000-0000-000000000000',
      p_to_category_id: '00000000-0000-0000-0000-000000000000',
      p_runs: [] as unknown as Json,
    });

    expect(error, 'the anon key reached the RPC').not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Moving
// ---------------------------------------------------------------------------

describe('move_pack_item applies a plan and nothing else', () => {
  let owner: TestUser;

  beforeAll(async () => {
    owner = await createUser('mover');
  });

  it('reorders within one category, and the new order survives a re-read', async () => {
    const tree = await createTree(owner, { categories: [{ name: 'Shelter', items: 4 }] });
    const [a, b, c, d] = tree.itemIds[0];

    const run = await itemRun(tree.categoryIds[0]);
    // The last item to the front: the move whose off-by-one only shows at the ends.
    const plan = planItemMove(run, run, d, 0);

    const { error } = await owner.client.rpc('move_pack_item', {
      p_pack_id: tree.packId,
      p_item_id: d,
      p_to_category_id: tree.categoryIds[0],
      p_runs: runsArgument(plan),
    });
    expect(error).toBeNull();

    expect(await orderedItemIds(tree.categoryIds[0])).toEqual([d, a, b, c]);
  });

  /**
   * The case the migration and reorder.ts both warn about in capitals.
   *
   * The moved row appears in the DESTINATION run's updates while it still carries its OLD
   * `pack_category_id`, so an RPC that scoped its update `where pack_category_id = <the
   * run's parentId> and id = u.id` would skip exactly that row. The visible symptom is not
   * an error: the source run renumbers, the destination does not, and the item lands with
   * whatever position it happened to have. Asserting BOTH categories' full order is what
   * makes that visible here — asserting only the destination's membership would pass.
   */
  it('moves an item into another category and renumbers both runs', async () => {
    const tree = await createTree(owner, {
      categories: [
        { name: 'Shelter', items: 3 },
        { name: 'Kitchen', items: 2 },
      ],
    });
    const [a0, a1, a2] = tree.itemIds[0];
    const [b0, b1] = tree.itemIds[1];

    const from = await itemRun(tree.categoryIds[0]);
    const to = await itemRun(tree.categoryIds[1]);
    // Index 1 of the destination: between its two rows, so the destination genuinely has to
    // reindex rather than merely gain a row at the end.
    const plan = planItemMove(from, to, a1, 1);

    const { error } = await owner.client.rpc('move_pack_item', {
      p_pack_id: tree.packId,
      p_item_id: a1,
      p_to_category_id: tree.categoryIds[1],
      p_runs: runsArgument(plan),
    });
    expect(error).toBeNull();

    expect(await orderedItemIds(tree.categoryIds[0])).toEqual([a0, a2]);
    expect(await orderedItemIds(tree.categoryIds[1])).toEqual([b0, a1, b1]);
  });

  /**
   * A move whose position diff is empty but which is entirely real — reorder.ts's
   * "drag the only item of one category into an empty one" case. `plan.runs` comes back
   * empty and `plan.reparent` is the whole move, which is why the destination is a required
   * argument of the RPC rather than a field of the payload.
   */
  it('re-parents an item even when no position changes', async () => {
    const tree = await createTree(owner, {
      categories: [
        { name: 'Solo', items: 1 },
        { name: 'Empty', items: 0 },
      ],
    });
    const [only] = tree.itemIds[0];

    const plan = planItemMove(
      await itemRun(tree.categoryIds[0]),
      await itemRun(tree.categoryIds[1]),
      only,
      0,
    );
    expect(plan.runs, 'the fixture no longer produces the empty-diff case').toEqual([]);

    const { error } = await owner.client.rpc('move_pack_item', {
      p_pack_id: tree.packId,
      p_item_id: only,
      p_to_category_id: tree.categoryIds[1],
      p_runs: runsArgument(plan),
    });
    expect(error).toBeNull();

    expect(await orderedItemIds(tree.categoryIds[0])).toEqual([]);
    expect(await orderedItemIds(tree.categoryIds[1])).toEqual([only]);
  });

  it('reorders a pack’s categories', async () => {
    const tree = await createTree(owner, {
      categories: [
        { name: 'One', items: 1 },
        { name: 'Two', items: 1 },
        { name: 'Three', items: 1 },
      ],
    });
    const [first, second, third] = tree.categoryIds;

    const plan = planCategoryMove(await categoryRun(tree.packId), third, 0);

    const { error } = await owner.client.rpc('move_pack_category', {
      p_pack_id: tree.packId,
      p_runs: runsArgument(plan),
    });
    expect(error).toBeNull();

    expect(await orderedCategoryIds(tree.packId)).toEqual([third, first, second]);
  });

  /**
   * Point 3 of the migration header, exercised as the bug it describes rather than as the
   * attack it is not. Both packs belong to the SAME user, so row level security permits
   * every row involved; what refuses this is the RPC's own check that the payload names one
   * pack. Without it, a plan computed for one pack would renumber another.
   */
  it('refuses a payload mixing two packs of the same owner', async () => {
    const mine = await createTree(owner, { categories: [{ name: 'Mine', items: 2 }] });
    const other = await createTree(owner, { categories: [{ name: 'Other', items: 2 }] });

    const plan = planItemMove(
      await itemRun(mine.categoryIds[0]),
      await itemRun(mine.categoryIds[0]),
      mine.itemIds[0][1],
      0,
    );
    const contaminated = [
      ...plan.runs,
      { parentId: other.categoryIds[0], updates: [{ id: other.itemIds[0][0], position: 5 }] },
    ];

    const { error } = await owner.client.rpc('move_pack_item', {
      p_pack_id: mine.packId,
      p_item_id: mine.itemIds[0][1],
      p_to_category_id: mine.categoryIds[0],
      p_runs: contaminated as unknown as Json,
    });

    expect(error?.code).toBe('42501');
    // Neither pack moved: the refusal is the whole transaction, not the offending run.
    expect(await orderedItemIds(mine.categoryIds[0])).toEqual(mine.itemIds[0]);
    expect(await orderedItemIds(other.categoryIds[0])).toEqual(other.itemIds[0]);
  });
});

// ---------------------------------------------------------------------------
// Somebody else's rows
// ---------------------------------------------------------------------------

describe('a stranger cannot move or duplicate rows that are not theirs', () => {
  let owner: TestUser;
  let stranger: TestUser;
  let tree: TreeFixture;

  beforeAll(async () => {
    owner = await createUser('compowner');
    stranger = await createUser('stranger');
    // PUBLIC, which is the harder case: `packs_select_public` really does let the stranger
    // READ every row named below, so a refusal here has to come from the write path rather
    // than from the rows being invisible.
    tree = await createTree(owner, {
      categories: [
        { name: 'Shelter', items: 2 },
        { name: 'Kitchen', items: 2 },
      ],
    });
    const published = await owner.client
      .from('packs')
      .update({ visibility: 'public' })
      .eq('id', tree.packId)
      .select('id, visibility');
    if (published.error || published.data?.[0]?.visibility !== 'public') {
      throw new Error('Fixture failed to publish the pack');
    }
  });

  it('refuses move_pack_item', async () => {
    const from = await itemRun(tree.categoryIds[0]);
    const to = await itemRun(tree.categoryIds[1]);
    const plan = planItemMove(from, to, tree.itemIds[0][0], 0);

    const { error } = await stranger.client.rpc('move_pack_item', {
      p_pack_id: tree.packId,
      p_item_id: tree.itemIds[0][0],
      p_to_category_id: tree.categoryIds[1],
      p_runs: runsArgument(plan),
    });

    expect(error?.code).toBe('42501');
    expect(await orderedItemIds(tree.categoryIds[0])).toEqual(tree.itemIds[0]);
    expect(await orderedItemIds(tree.categoryIds[1])).toEqual(tree.itemIds[1]);
  });

  it('refuses move_pack_category', async () => {
    const plan = planCategoryMove(await categoryRun(tree.packId), tree.categoryIds[1], 0);

    const { error } = await stranger.client.rpc('move_pack_category', {
      p_pack_id: tree.packId,
      p_runs: runsArgument(plan),
    });

    expect(error?.code).toBe('42501');
    expect(await orderedCategoryIds(tree.packId)).toEqual(tree.categoryIds);
  });

  /**
   * Duplicating someone else's public pack is refused, and the migration explains why the
   * answer is "no" rather than "not yet": `pack_items`' composite foreign key to
   * `gear_items` makes a pack item owned by one user unable to reference another's gear, so
   * a cross-owner copy is a gear-cloning feature wearing a duplicate button.
   */
  it('refuses duplicate_pack, and creates no pack for the stranger', async () => {
    const { error } = await stranger.client.rpc('duplicate_pack', { p_pack_id: tree.packId });
    expect(error?.code).toBe('42501');

    const [{ count }] = await adminSql<{ count: string }>(
      `select count(*) as count from public.packs where user_id = $1`,
      [stranger.id],
    );
    expect(Number(count)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Two reorders at once
// ---------------------------------------------------------------------------

/**
 * The acceptance criterion, stated as the migration states it: two concurrent reorders
 * leave a VALID, COMPLETE ordering — every item present exactly once, positions
 * non-negative, no row orphaned into the wrong category. NOT that both moves survive. Last
 * writer wins on the arrangement, and telling the user their drag was overwritten is
 * PK-20's job.
 *
 * The race is forced rather than hoped for. Both plans are computed against the SAME read,
 * which is what two browsers dragging at once actually produce; then one session opens a
 * transaction and calls the RPC without committing, the other calls it and is observed NOT
 * to have finished, and only then does the first commit.
 *
 * WHAT THE WAITING IN THE FIRST TEST DOES AND DOES NOT PROVE, stated precisely because the
 * obvious reading of it is wrong. The parent pack row is the serialisation point for the
 * whole subtree, and the RPC is not the only thing that takes it:
 * `assert_parent_pack_unlocked()` does `select p.locked_at ... for update` on every INSERT
 * or UPDATE against `pack_categories` and `pack_items`. Measured directly on this stack,
 * two sessions updating DISJOINT items of one pack — no row in common, no statement in
 * common — still block on `transactionid ShareLock`, because both go through that trigger.
 * So the first test below would see the second reorder wait even if `move_pack_item` took
 * no lock of its own, and on its own it establishes the OUTCOME (valid, complete, nothing
 * orphaned) rather than the mechanism.
 *
 * The second test isolates the mechanism. A reorder that writes nothing at all — a
 * same-category move with an empty position diff — fires no row trigger, so the only thing
 * that can make it wait is the migration's own `select ... for update` at the top of the
 * function. That is the lock that matters here: it is taken BEFORE the payload is checked
 * against the pack, so the verify-then-apply sequence is atomic rather than merely the
 * writes at the end of it.
 */
describe('two concurrent reorders leave a valid, complete ordering', () => {
  const clients: pg.Client[] = [];

  async function connect(): Promise<pg.Client> {
    const client = new pg.Client({ connectionString: localDatabase().dbUrl });
    await client.connect();
    clients.push(client);
    return client;
  }

  /**
   * Open a transaction that PostgREST's own request looks like: the `authenticated` role,
   * with `request.jwt.claims` carrying the `sub` that `auth.uid()` reads. `set_config(...,
   * true)` is the function form of `SET LOCAL`, so it is parameterised rather than
   * interpolated and unwinds with the transaction.
   */
  async function beginAs(client: pg.Client, user: TestUser): Promise<void> {
    await client.query('begin');
    await client.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: user.id, role: 'authenticated' }),
    ]);
    await client.query('set local role authenticated');
  }

  afterAll(async () => {
    await Promise.all(clients.map((c) => c.end()));
  });

  it('serialises them on the parent pack row', async () => {
    const owner = await createUser('racer');
    const tree = await createTree(owner, {
      categories: [
        { name: 'Shelter', items: 3 },
        { name: 'Kitchen', items: 2 },
      ],
    });
    const [a0, a1, a2] = tree.itemIds[0];

    // One read, two plans. Both sessions believe the world looks like this.
    const shelter = await itemRun(tree.categoryIds[0]);
    const kitchen = await itemRun(tree.categoryIds[1]);
    const first = planItemMove(shelter, shelter, a2, 0);
    const second = planItemMove(shelter, kitchen, a0, 0);

    const sessionA = await connect();
    const sessionB = await connect();

    await beginAs(sessionA, owner);
    await sessionA.query(`select public.move_pack_item($1, $2, $3, $4)`, [
      tree.packId,
      a2,
      tree.categoryIds[0],
      JSON.stringify(first.runs),
    ]);

    await beginAs(sessionB, owner);
    let bSettled = false;
    const blocked = sessionB
      .query(`select public.move_pack_item($1, $2, $3, $4)`, [
        tree.packId,
        a0,
        tree.categoryIds[1],
        JSON.stringify(second.runs),
      ])
      .finally(() => {
        bSettled = true;
      });

    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(
      bSettled,
      'the second reorder did not wait for the first — the pack row is not being locked, and the two writes interleaved',
    ).toBe(false);

    await sessionA.query('commit');
    await blocked;
    await sessionB.query('commit');

    // ---- the ordering is valid and complete -------------------------------
    const rows = await storedItems(tree.allItemIds);

    expect(rows, 'an item disappeared').toHaveLength(tree.allItemIds.length);
    expect(new Set(rows.map((r) => r.id)).size, 'an item is present twice').toBe(rows.length);
    expect(
      rows.filter((r) => r.pack_id !== tree.packId),
      'an item escaped its pack',
    ).toEqual([]);
    expect(
      rows.filter((r) => r.position < 0),
      'a position went negative',
    ).toEqual([]);

    // Nothing orphaned into the wrong category: the only row either move re-parents is a0,
    // and it goes to Kitchen. Every other row is where it started.
    const categoryOf = new Map(rows.map((r) => [r.id, r.pack_category_id]));
    expect(categoryOf.get(a0)).toBe(tree.categoryIds[1]);
    expect(categoryOf.get(a1)).toBe(tree.categoryIds[0]);
    expect(categoryOf.get(a2)).toBe(tree.categoryIds[0]);
    for (const id of tree.itemIds[1]) expect(categoryOf.get(id)).toBe(tree.categoryIds[1]);

    // And the two categories between them still hold every item exactly once, which is the
    // "complete" half stated as a partition rather than inferred from the counts above.
    const shelterNow = await orderedItemIds(tree.categoryIds[0]);
    const kitchenNow = await orderedItemIds(tree.categoryIds[1]);
    expect([...shelterNow, ...kitchenNow].sort()).toEqual([...tree.allItemIds].sort());
  });

  /**
   * The lock, isolated from the triggers that would otherwise explain the waiting above.
   *
   * The second call here moves an item to the category it is already in with an empty
   * `runs` array: the re-parent is filtered out by `is distinct from`, the position update
   * matches nothing, and so NO row of `pack_categories` or `pack_items` is written and
   * `assert_parent_pack_unlocked()` never fires. Everything the call does is read. It still
   * has to wait, and the only thing that can make it wait is the `select ... for update` the
   * migration takes on the parent pack before it reads anything.
   *
   * That is the property worth pinning: a reorder does not merely serialise its writes, it
   * validates the payload against a pack no other session can move underneath it.
   */
  it('takes the pack row lock before it reads, not only when it writes', async () => {
    const owner = await createUser('lockprobe');
    const tree = await createTree(owner, { categories: [{ name: 'Shelter', items: 2 }] });
    const [a0, a1] = tree.itemIds[0];

    const run = await itemRun(tree.categoryIds[0]);
    const real = planItemMove(run, run, a1, 0);

    const writer = await connect();
    const reader = await connect();

    await beginAs(writer, owner);
    await writer.query(`select public.move_pack_item($1, $2, $3, $4)`, [
      tree.packId,
      a1,
      tree.categoryIds[0],
      JSON.stringify(real.runs),
    ]);

    await beginAs(reader, owner);
    let settled = false;
    // The no-op: same category, empty runs. Nothing to write, so nothing but the explicit
    // lock can block it.
    const waiting = reader
      .query(`select public.move_pack_item($1, $2, $3, $4)`, [
        tree.packId,
        a0,
        tree.categoryIds[0],
        '[]',
      ])
      .finally(() => {
        settled = true;
      });

    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(
      settled,
      'a reorder that writes nothing did not wait — the RPC is not taking the parent pack row lock, so its checks run against a pack another session is moving',
    ).toBe(false);

    await writer.query('commit');
    await waiting;
    await reader.query('commit');

    expect(await orderedItemIds(tree.categoryIds[0])).toEqual([a1, a0]);
  });
});

// ---------------------------------------------------------------------------
// A locked pack
// ---------------------------------------------------------------------------

/**
 * REORDERING A LOCKED PACK IS REFUSED, AND THE REFUSAL IS REPORTED (independent review, B2).
 *
 * WHAT WAS BROKEN, IN THE ORDER IT MATTERS. `move_pack_item` compared the affected row count
 * of its POSITION update against the number of pairs it was sent, and did NOT compare the
 * affected row count of its RE-PARENT update against anything. So with `p_runs = []` — the
 * "re-parents an item even when no position changes" case above, which is what dragging the
 * only item of one category into an empty one produces — `0 <> 0` was false and the function
 * returned success. On a locked pack it had moved nothing at all.
 *
 * WHY RLS DID NOT CATCH IT, WHICH IS THE PART THE MIGRATION'S OWN HEADER GOT WRONG. It
 * claimed the trigger `assert_parent_pack_unlocked()` raises `pack % is locked` "on the first
 * row they touch". `pack_items_update_own` (core_schema.sql:840) carries its
 * `p.locked_at is null` clause in `USING`, which FILTERS: the statement reaches no row, so a
 * BEFORE ROW trigger has nothing to fire on. Measured on this stack rather than argued: the
 * re-parent UPDATE returns `row_count = 0` and raises nothing.
 *
 * THE THREE TESTS BELOW ARE NOT ONE TEST REPEATED. Each reaches a different guard, which is
 * what makes each of them able to fail on its own:
 *
 *   empty runs, cross-category   Only the new re-parent check can see this. `v_pairs` is 0,
 *                                so the position comparison passes whatever happened.
 *   non-empty runs, same         Only the position comparison can see this. The re-parent is
 *   category                     a legitimate no-op (`is distinct from` filters a move to the
 *                                category the item is already in) and the new check correctly
 *                                lets it through.
 *   move_pack_category           The other function entirely, which has one write and no
 *                                re-parent — the audit's result, asserted rather than assumed.
 */
describe('reordering a locked pack', () => {
  let owner: TestUser;

  beforeAll(async () => {
    owner = await createUser('frozen-reorder');
  });

  it('refuses a re-parent whose position diff is empty, and writes nothing', async () => {
    const tree = await createTree(owner, {
      categories: [
        { name: 'Solo', items: 1 },
        { name: 'Empty', items: 0 },
      ],
      locked: true,
    });
    const [only] = tree.itemIds[0];

    const plan = planItemMove(
      await itemRun(tree.categoryIds[0]),
      await itemRun(tree.categoryIds[1]),
      only,
      0,
    );
    // The premise, asserted rather than assumed: if this ever stops being empty the test
    // silently becomes the "non-empty runs" case below and proves nothing about the
    // re-parent check.
    expect(plan.runs, 'the fixture no longer produces the empty-diff case').toEqual([]);

    const { error } = await owner.client.rpc('move_pack_item', {
      p_pack_id: tree.packId,
      p_item_id: only,
      p_to_category_id: tree.categoryIds[1],
      p_runs: runsArgument(plan),
    });

    // 55000 (`object_not_in_prerequisite_state`), deliberately not the 23514 the trigger
    // raises for the same condition — `src/pages/packs/reorder.ts` keys off this code to
    // answer 409 instead of 500, and 23514 is also what `pack_items.position >= 0` raises.
    expect(error, 'a locked pack accepted a move').not.toBeNull();
    expect(error?.code).toBe('55000');

    // Nothing moved. This is the assertion the old function passed while lying: the call
    // returned `{ error: null }` and the item sat exactly here.
    expect(await orderedItemIds(tree.categoryIds[0])).toEqual([only]);
    expect(await orderedItemIds(tree.categoryIds[1])).toEqual([]);
  });

  it('refuses a same-category reorder, and writes nothing', async () => {
    const tree = await createTree(owner, {
      categories: [{ name: 'Shelter', items: 3 }],
      locked: true,
    });
    const before = tree.itemIds[0];

    const run = await itemRun(tree.categoryIds[0]);
    const plan = planItemMove(run, run, before[2], 0);
    expect(plan.runs.length, 'this case needs a non-empty position diff').toBeGreaterThan(0);

    const { error } = await owner.client.rpc('move_pack_item', {
      p_pack_id: tree.packId,
      p_item_id: before[2],
      p_to_category_id: tree.categoryIds[0],
      p_runs: runsArgument(plan),
    });

    // It refused before this change too — the position comparison saw 0 of 3 — but said
    // "refusing to commit a partial reindex", which names corruption that did not happen and
    // gave the endpoint nothing to tell a visitor apart from a 500.
    expect(error?.code).toBe('55000');
    expect(await orderedItemIds(tree.categoryIds[0])).toEqual(before);
  });

  it('refuses a category reorder, and writes nothing', async () => {
    const tree = await createTree(owner, {
      categories: [
        { name: 'One', items: 1 },
        { name: 'Two', items: 1 },
      ],
      locked: true,
    });

    const plan = planCategoryMove(await categoryRun(tree.packId), tree.categoryIds[1], 0);

    const { error } = await owner.client.rpc('move_pack_category', {
      p_pack_id: tree.packId,
      p_runs: runsArgument(plan),
    });

    expect(error?.code).toBe('55000');
    expect(await orderedCategoryIds(tree.packId)).toEqual(tree.categoryIds);
  });

  /**
   * The other half of the audit, and the reason `move_pack_category` gets no re-parent
   * check: with nothing to apply there is nothing to refuse, so success is the honest
   * answer even on a locked pack. Pinned because the tempting "fix" for the finding above
   * is a blanket `if locked then raise` at the top of both functions, which would make this
   * call fail — and would refuse a request that asks for no write at all.
   */
  it('accepts an empty plan on a locked pack, because an empty plan writes nothing', async () => {
    const tree = await createTree(owner, {
      categories: [{ name: 'Only', items: 1 }],
      locked: true,
    });

    const { error } = await owner.client.rpc('move_pack_category', {
      p_pack_id: tree.packId,
      p_runs: [] as unknown as Json,
    });

    expect(error).toBeNull();
    expect(await orderedCategoryIds(tree.packId)).toEqual(tree.categoryIds);
  });
});

// ---------------------------------------------------------------------------
// Duplicating
// ---------------------------------------------------------------------------

describe('duplicate_pack produces an independent copy', () => {
  let owner: TestUser;
  let source: TreeFixture;
  let copyId: string;

  beforeAll(async () => {
    owner = await createUser('duplicator');
    // TWO CATEGORIES WITH THE SAME NAME, deliberately. `pack_categories.name` is not unique,
    // and a copy that matched source categories to their copies by name would produce a
    // cross product here — every item of both 'Extras' in both copies of it. This fixture
    // is the reason the migration pre-generates ids in a CTE instead.
    source = await createTree(owner, {
      categories: [
        { name: 'Extras', items: 2 },
        { name: 'Extras', items: 3 },
        { name: 'Shelter', items: 1 },
      ],
      overrides: { weight: 450, note: 'cut the handle off' },
    });

    const { data, error } = await owner.client.rpc('duplicate_pack', { p_pack_id: source.packId });
    if (error || typeof data !== 'string') {
      throw new Error(`duplicate_pack failed: ${error?.message ?? 'no id returned'}`);
    }
    copyId = data;
  });

  it('gives the copy a new slug, private visibility and no lock', async () => {
    const [copy] = await adminSql<{
      name: string;
      slug: string;
      visibility: string;
      locked_at: string | null;
      user_id: string;
    }>(`select name, slug, visibility, locked_at, user_id from public.packs where id = $1`, [
      copyId,
    ]);

    expect(copy.user_id).toBe(owner.id);
    expect(copy.name).toBe('Composition test pack');
    expect(copy.visibility).toBe('private');
    expect(copy.locked_at).toBeNull();
    expect(copy.slug).not.toBe(source.slug);
  });

  it('copies every category and item once, with positions preserved', async () => {
    const rows = await adminSql<{ name: string; cposition: number; iposition: number | null }>(
      `select c.name, c.position as cposition, i.position as iposition
         from public.pack_categories c
         left join public.pack_items i on i.pack_category_id = c.id
        where c.pack_id = $1
        order by c.position, i.position`,
      [copyId],
    );

    // Three categories, 2 + 3 + 1 items — and NOT the 2+3 cross product a name-based
    // mapping would have produced between the two categories called 'Extras'.
    expect(rows.map((r) => `${r.name}:${r.cposition}:${r.iposition}`)).toEqual([
      'Extras:0:0',
      'Extras:0:1',
      'Extras:1:0',
      'Extras:1:1',
      'Extras:1:2',
      'Shelter:2:0',
    ]);
  });

  it('carries overrides and the gear references verbatim', async () => {
    const rows = await adminSql<{ overrides: unknown; gear_item_id: string | null }>(
      `select i.overrides, i.gear_item_id
         from public.pack_items i
         join public.pack_categories c on c.id = i.pack_category_id
        where c.pack_id = $1`,
      [copyId],
    );

    expect(rows).toHaveLength(6);
    for (const row of rows) {
      expect(row.overrides).toEqual({ weight: 450, note: 'cut the handle off' });
      // Rule 1: the copy references the same closet rows. Duplicating a pack does not
      // duplicate the gear, which is why a cross-owner copy is impossible.
      expect(row.gear_item_id).not.toBeNull();
    }
  });

  it('leaves the original untouched when the copy is edited', async () => {
    const copyCategories = await orderedCategoryIds(copyId);
    const plan = planCategoryMove(await categoryRun(copyId), copyCategories[2], 0);

    const moved = await owner.client.rpc('move_pack_category', {
      p_pack_id: copyId,
      p_runs: runsArgument(plan),
    });
    expect(moved.error).toBeNull();

    const renamed = await owner.client
      .from('pack_categories')
      .update({ name: 'Renamed in the copy' })
      .eq('id', copyCategories[0])
      .select('id');
    expect(renamed.error).toBeNull();
    expect(renamed.data).toHaveLength(1);

    // The original: same category order, same names, same item order.
    expect(await orderedCategoryIds(source.packId)).toEqual(source.categoryIds);
    const names = await adminSql<{ name: string }>(
      `select name from public.pack_categories where pack_id = $1 order by position, id`,
      [source.packId],
    );
    expect(names.map((n) => n.name)).toEqual(['Extras', 'Extras', 'Shelter']);
    for (const [index, categoryId] of source.categoryIds.entries()) {
      expect(await orderedItemIds(categoryId)).toEqual(source.itemIds[index]);
    }
  });
});

describe('duplicating a locked pack', () => {
  it('produces an unlocked copy that can be edited', async () => {
    const owner = await createUser('unfreezer');
    const source = await createTree(owner, {
      categories: [{ name: 'Frozen', items: 2 }],
      locked: true,
    });

    const { data: copyId, error } = await owner.client.rpc('duplicate_pack', {
      p_pack_id: source.packId,
    });
    expect(error, 'duplicating a locked pack was refused').toBeNull();
    expect(typeof copyId).toBe('string');

    const [copy] = await adminSql<{ locked_at: string | null }>(
      `select locked_at from public.packs where id = $1`,
      [copyId as string],
    );
    expect(copy.locked_at, 'the copy inherited the lock').toBeNull();

    // "Unlocked" asserted as a capability rather than as a null column: the write policies
    // and `assert_parent_pack_unlocked` are what the lock actually means, so the copy is
    // only unlocked if they let a write through.
    const categories = await orderedCategoryIds(copyId as string);
    const plan = planItemMove(
      await itemRun(categories[0]),
      await itemRun(categories[0]),
      (await orderedItemIds(categories[0]))[1],
      0,
    );
    const { error: moveError } = await owner.client.rpc('move_pack_item', {
      p_pack_id: copyId as string,
      p_item_id: (await orderedItemIds(categories[0]))[1],
      p_to_category_id: categories[0],
      p_runs: runsArgument(plan),
    });
    expect(moveError, 'the copy behaves as though it were still frozen').toBeNull();

    // And the original is still frozen — duplicating is a read of it.
    const [original] = await adminSql<{ locked_at: string | null }>(
      `select locked_at from public.packs where id = $1`,
      [source.packId],
    );
    expect(original.locked_at).not.toBeNull();
  });
});

/**
 * A duplicate that fails partway leaves no pack behind.
 *
 * The failure is FORCED, not reasoned about: a BEFORE INSERT trigger on `pack_items`, scoped
 * to this test's own user so nothing else in the suite can trip it, raises on every item
 * after the first in a run. By the time it fires, `duplicate_pack` has already inserted the
 * new pack row, all of its categories and one item — three completed statements — so this is
 * genuinely mid-flight rather than a call that failed on its first line.
 *
 * WHY THIS IS MEASURED THROUGH POSTGREST RATHER THAN INSIDE A ROLLED-BACK TRANSACTION. The
 * guarantee under test is that the whole copy is one unit of work, and the boundary of that
 * unit is the REQUEST: PostgREST runs each RPC in its own transaction. Wrapping the call in
 * a transaction this test controls and then rolling back to a savepoint would undo the
 * partial work itself, so "no pack behind" would be true whatever the function did — an
 * assertion that cannot fail. Here nothing but the failure removes those rows.
 *
 * The trigger function goes in `private`, not `public`: a leftover function in `public` is
 * EXECUTE-able by `PUBLIC` and would fail the anon sweep in tests/rls-enabled.test.ts on
 * every later run, turning a crash in this test into an unrelated red elsewhere. `private`
 * is not served by PostgREST and is not swept.
 */
describe('a duplicate that fails partway', () => {
  it('leaves no pack, category or item behind', async () => {
    const owner = await createUser('halfcopy');
    const source = await createTree(owner, {
      categories: [
        { name: 'Shelter', items: 3 },
        { name: 'Kitchen', items: 2 },
      ],
    });

    // adminSqlWith rather than adminSql, with no session settings to apply. adminSql refuses
    // any string with a semicolon before its last non-space character, because
    // node-postgres returns an ARRAY of results for a batch and every catalogue assertion in
    // this suite treats "no rows" as passing. A plpgsql body is one statement containing
    // semicolons, which that guard cannot tell apart from a batch — and this is exactly the
    // escape hatch it names.
    await adminSqlWith(
      [],
      `create function private.pack_composition_test_boom()
       returns trigger
       language plpgsql
       security invoker
       set search_path = ''
       as $fn$
       begin
         if new.user_id = '${owner.id}'::uuid and new.position >= 1 then
           raise exception 'forced failure partway through duplicate_pack';
         end if;
         return new;
       end;
       $fn$`,
    );

    try {
      await adminSql(
        `create trigger pack_composition_test_boom
           before insert on public.pack_items
           for each row execute function private.pack_composition_test_boom()`,
      );

      const { error } = await owner.client.rpc('duplicate_pack', { p_pack_id: source.packId });
      expect(error, 'the forced failure did not happen — this test proved nothing').not.toBeNull();
      expect(error?.message).toContain('forced failure partway through duplicate_pack');

      // Counted without RLS, and over the whole user rather than over the id the failed call
      // would have returned — which it never returned, so a stranded pack has no id to look
      // it up by. The source pack and its rows are the only ones that may exist.
      const [counts] = await adminSql<{ packs: string; categories: string; items: string }>(
        `select (select count(*) from public.packs where user_id = $1) as packs,
                (select count(*) from public.pack_categories where user_id = $1) as categories,
                (select count(*) from public.pack_items where user_id = $1) as items`,
        [owner.id],
      );

      expect(Number(counts.packs), 'a half-built pack survived').toBe(1);
      expect(Number(counts.categories)).toBe(2);
      expect(Number(counts.items)).toBe(5);
    } finally {
      // Both dropped, and in a finally, because a trigger left on `public.pack_items` breaks
      // every fixture in every file that runs after this one.
      await adminSql(`drop trigger if exists pack_composition_test_boom on public.pack_items`);
      await adminSql(`drop function if exists private.pack_composition_test_boom()`);
    }

    // Asserted rather than assumed: the cleanup above is load-bearing for the rest of the
    // suite, and a `finally` that threw would have been swallowed by the failure it followed.
    const leftovers = await adminSql<{ tgname: string }>(
      `select tgname from pg_trigger where tgname = 'pack_composition_test_boom' and not tgisinternal`,
    );
    expect(leftovers).toEqual([]);
  });
});
