import { describe, expect, it, beforeAll } from 'vitest';
import { createUser, type TestUser, type PacksheetClient } from './support/local-database';
import { createPack } from './support/fixtures';
import {
  PACK_TREE_SELECT,
  loadPackForEdit,
  loadPackList,
  type PackTreeRow,
} from '../src/lib/packs/query';
// The reorder engine and the RPC wrappers, because the read-back assertion below has to
// reorder the pack THROUGH the paths the product uses rather than by writing positions
// directly: a test that sets `position` by hand proves the ORDER BY works and says nothing
// about whether a real drag ends up ordered the way it was left.
import { planCategoryMove, planItemMove } from '../src/lib/packs/reorder';
import { movePackCategory, movePackItem } from '../src/lib/packs/mutations';
import { computeTotals, type PackTotals } from '../src/lib/totals';

/**
 * The integration tests for `src/lib/packs/query.ts`, against the real local stack —
 * the same posture `tests/gear-closet.test.ts` takes for `loadGearCloset`/`loadGearItem`,
 * for the identical reason: `loadPackForEdit` and `loadPackList` are owner-scoped reads
 * whose entire job is to add `.eq('user_id', userId)` on top of what RLS alone would
 * return, and the only thing that can prove RLS alone would return more is Postgres,
 * evaluating the real policies, as a real signed-in role. `tests/gear-query.test.ts` is
 * named as this file's house-style model for STRUCTURE and comment density — but that
 * file tests pure functions with no database at all, because `src/lib/gear/query.ts`
 * splits its pure URL-parsing half from its DB-touching loaders and only the former lives
 * there. `src/lib/packs/query.ts` has no pure half: every export touches PostgREST, so
 * this file is closer in KIND to `tests/gear-closet.test.ts`, and borrows its patterns
 * (the "safe query" / "leaky query" pair, `createUser`/`createPack` from
 * `tests/support/fixtures.ts`) directly.
 *
 * SHARED-DATABASE DISCIPLINE, the same rule `tests/gear-closet.test.ts` states for
 * itself: `vitest.config.ts` does not reset the database between files, and
 * `pack_categories_select_public`/`pack_items_select_public` are granted to
 * `authenticated`, not just `anon` — so a public pack from ANY prior test file is visible
 * to every client here. Every fixture below is scoped to its own freshly created user(s)
 * and asserted on by exact id, never by "the only pack in the database".
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * THE LEAKY EDIT QUERY — everything `loadPackForEdit` does, built from the same exported
 * `PACK_TREE_SELECT`, MINUS the one line that matters: no `.eq('user_id', userId)`. The
 * direct analogue of `leakyClosetQuery` in `tests/gear-closet.test.ts`, and it exists for
 * the identical reason: to demonstrate that the leak `loadPackForEdit` closes is a real
 * leak, reachable through RLS alone, rather than merely asserting the shipped function
 * looks correct in isolation.
 */
function leakyLoadPackForEdit(client: PacksheetClient, packId: string) {
  return client
    .from('packs')
    .select(PACK_TREE_SELECT)
    .eq('id', packId)
    .order('position', { referencedTable: 'pack_categories', ascending: true })
    .order('id', { referencedTable: 'pack_categories', ascending: true })
    .order('position', { referencedTable: 'pack_categories.pack_items', ascending: true })
    .order('id', { referencedTable: 'pack_categories.pack_items', ascending: true })
    .maybeSingle();
}

// ---------------------------------------------------------------------------
// loadPackForEdit — owner scoping
// ---------------------------------------------------------------------------
//
// THE CROSS-USER LEAK, for packs — the same defect `tests/gear-closet.test.ts` documents
// at length for `gear_items`, against the sibling mechanism: `packs_select_public`
// (`supabase/migrations/20260810120000_core_schema.sql:727`) is granted to
// `anon, authenticated` alike, so a signed-in visitor's plain `select * from packs`
// returns "my own rows OR any row whose pack is `visibility = 'public'`", regardless of
// whose session is asking.
//
// WHY THIS TEST PROVES SOMETHING ABOUT THE WRITE PATH, NOT ABOUT INVISIBILITY. A public
// pack is not secret — that is the entire point of `visibility = 'public'`, and the
// "leaky" half below deliberately demonstrates the row IS genuinely readable by the
// attacker, by id, with the owner filter removed. What has to be false, and what this
// test actually pins, is narrower and more consequential: that `loadPackForEdit` — the
// read the composition EDITOR calls to decide what form to render — never treats "I can
// see this row" as "I may open this row for editing". Those are different questions that
// a naive `.eq('id', ...)` makes look like the same one.
describe('loadPackForEdit: owner scoping', () => {
  let victim: TestUser;
  let attacker: TestUser;
  let victimPackId: string;

  beforeAll(async () => {
    victim = await createUser('packs-query-leak-victim');
    attacker = await createUser('packs-query-leak-attacker');

    // Built entirely as the victim, through PostgREST under RLS — createPack
    // (tests/support/fixtures.ts) is what makes this a faithful stand-in for how a real
    // user's pack ends up public, rather than a row inserted by fiat.
    const victimPack = await createPack(victim, { visibility: 'public', itemCount: 1 });
    victimPackId = victimPack.packId;
  });

  it('excludes it for another user, even though the same query minus the owner filter includes it', async () => {
    const safe = await loadPackForEdit(attacker.client, attacker.id, victimPackId);
    expect(safe.error).toBeNull();
    // The bug this catches: the composition editor silently opening — and, downstream,
    // offering to save changes to — a pack the visitor does not own, the moment its
    // owner makes it public.
    expect(safe.data).toBeNull();

    const leaky = await leakyLoadPackForEdit(attacker.client, victimPackId);
    expect(leaky.error).toBeNull();
    // Proves the premise: the row really is visible to a signed-in stranger through RLS
    // alone, so the safe half above demonstrates a real exclusion, not a query that was
    // always going to return nothing for some unrelated reason (a typo'd id, an empty
    // table).
    expect(leaky.data?.id).toBe(victimPackId);
  });

  it('the owner still loads their own pack through the identical function', async () => {
    const own = await loadPackForEdit(victim.client, victim.id, victimPackId);
    expect(own.error).toBeNull();
    expect(own.data?.id).toBe(victimPackId);
  });
});

// ---------------------------------------------------------------------------
// loadPackForEdit — the position/id ordering tie-break
// ---------------------------------------------------------------------------
//
// `pack_categories.position` and `pack_items.position` are deliberately NOT unique
// (`supabase/migrations/20260810120000_core_schema.sql:228`, "Deliberately NOT unique: a
// unique (parent, position) pair forces every reindex through a DEFERRABLE constraint or
// a temporary negative range") — so two siblings sharing a position is legal data, not an
// edge case, and the only thing keeping a repeated read of the same pack in a STABLE
// order is the `id` tie-break `loadPackForEdit` applies after `position` on every level.
// Without it, Postgres is free to answer two consecutive requests for rows tied on
// `position` in different orders, which reads to a visitor as items spontaneously
// swapping places on reload.
describe('loadPackForEdit: the position/id ordering tie-break', () => {
  let owner: TestUser;
  let packId: string;
  let sortedCategoryIds: string[];
  let sortedItemIds: string[];

  beforeAll(async () => {
    owner = await createUser('packs-query-tiebreak-owner');

    // Three items in one category, all forced onto position 0 — createPack gives each a
    // distinct position (0, 1, 2), which this overwrites specifically to construct the
    // tie this test is about, through the owner's own client under RLS.
    const fixture = await createPack(owner, { itemCount: 3 });
    packId = fixture.packId;
    sortedItemIds = [...fixture.itemIds].sort();

    for (const itemId of fixture.itemIds) {
      const { error } = await owner.client
        .from('pack_items')
        .update({ position: 0 })
        .eq('id', itemId);
      if (error) throw new Error(`Fixture failed to tie item positions: ${error.message}`);
    }

    // A second category, tied at position 0 with the first (createPack's own category,
    // "Shelter", is also position 0 by default).
    const { data: secondCategory, error: categoryError } = await owner.client
      .from('pack_categories')
      .insert({ pack_id: packId, name: 'Sleep', position: 0 })
      .select('id')
      .single();
    if (categoryError || !secondCategory) {
      throw new Error(`Fixture failed to insert second category: ${categoryError?.message}`);
    }
    sortedCategoryIds = [fixture.categoryId, secondCategory.id].sort();
  });

  it('breaks a tie on pack_categories.position by ascending id', async () => {
    const { data, error } = await loadPackForEdit(owner.client, owner.id, packId);
    expect(error).toBeNull();
    expect(data?.pack_categories.map((c) => c.id)).toEqual(sortedCategoryIds);
  });

  it('breaks a tie on pack_items.position by ascending id, within the tied category', async () => {
    const { data, error } = await loadPackForEdit(owner.client, owner.id, packId);
    expect(error).toBeNull();

    // The three tied items all live on createPack's own category — found by having
    // items at all, since the second ("Sleep") category was inserted empty and this
    // test is not about telling the two categories apart.
    const withItems = data?.pack_categories.find((c) => c.pack_items.length > 0);
    expect(withItems?.pack_items.map((i) => i.id)).toEqual(sortedItemIds);
  });
});

// ---------------------------------------------------------------------------
// loadPackForEdit — a real reorder survives a reload
// ---------------------------------------------------------------------------

/**
 * THE ACCEPTANCE CRITERION, ON THE PATH A BROWSER RELOAD ACTUALLY TAKES (independent
 * review, B4).
 *
 * Before this block, deleting BOTH `.order('position', ...)` calls from `loadPackForEdit`
 * left the entire suite green. The tie-break block above cannot catch it: it forces every
 * position to 0, so it exercises only the `id` half of `(position, id)` and is satisfied by
 * a query that never sorted on `position` at all. Nothing else read a pack back after
 * writing an order to it. "Reordering survives a reload" was the PR's headline claim and
 * the one thing no test could fail on.
 *
 * WHAT MAKES THIS TEST BITE, AND WHY IT IS NOT AUTOMATIC. Both moves below are chosen so
 * that the stored order DISAGREES with ascending id: each one sends the row with the
 * LOWEST id to the end of its run. Strip `.order('position', ...)` and PostgREST answers
 * from the surviving `.order('id', ...)` alone — ascending id — which is exactly the order
 * these assertions say must not come back. Without that construction the two orders could
 * coincide by luck (`gen_random_uuid()` decides), and the test would pass over a query that
 * had stopped sorting. The precondition is asserted rather than assumed, so a fixture that
 * stops producing the disagreement fails loudly instead of going quiet.
 *
 * THE ORDER IS WRITTEN THROUGH THE REAL RPCs, planned by the real planner. A test that
 * UPDATEd `position` by hand would be asserting that PostgREST can sort integers. What is
 * under test is the round trip: `planCategoryMove`/`planItemMove` decide the numbers,
 * `move_pack_category`/`move_pack_item` apply them in one transaction, and this read is the
 * next page load. Every one of those three is a place the order can be lost.
 */
describe('loadPackForEdit: an order written by a reorder comes back', () => {
  /** The list after moving `id` to `toIndex` — the same result `planCategoryMove` and
   *  `planItemMove` produce, computed independently here so the expectation is not the
   *  planner's own opinion of what it did. */
  function moveWithin(order: readonly string[], id: string, toIndex: number): string[] {
    const next = order.filter((candidate) => candidate !== id);
    next.splice(toIndex, 0, id);
    return next;
  }

  let owner: TestUser;
  let packId: string;
  let expectedCategoryOrder: string[];
  let reorderedCategoryId: string;
  let expectedItemOrder: string[];

  beforeAll(async () => {
    owner = await createUser('packs-query-reorder-reload');

    const { data: pack, error: packError } = await owner.client
      .from('packs')
      .insert({ name: 'Reordered' })
      .select('id')
      .single();
    if (packError || !pack) {
      throw new Error(`Fixture failed to insert pack: ${packError?.message}`);
    }
    packId = pack.id;

    // Three categories at 0, 1, 2 — distinct and non-zero positions, so the ordering has
    // real work to do rather than being satisfied by every row sharing a number.
    const { data: categories, error: categoryError } = await owner.client
      .from('pack_categories')
      .insert([
        { pack_id: packId, name: 'Shelter', position: 0 },
        { pack_id: packId, name: 'Kitchen', position: 1 },
        { pack_id: packId, name: 'Clothing', position: 2 },
      ])
      .select('id, position');
    if (categoryError || categories?.length !== 3) {
      throw new Error(`Fixture failed to insert categories: ${categoryError?.message}`);
    }
    // Sorted by the position we SENT, not by the order PostgREST returned them in: a
    // multi-row insert makes no promise about that, and every index below assumes it did.
    const categoryOrder = [...categories].sort((a, b) => a.position - b.position).map((c) => c.id);

    const { data: gear, error: gearError } = await owner.client
      .from('gear_items')
      .insert(
        Array.from({ length: 3 }, (_, index) => ({
          name: `Gear ${index + 1}`,
          weight_grams: 100 + index,
        })),
      )
      .select('id');
    if (gearError || gear?.length !== 3) {
      throw new Error(`Fixture failed to insert gear: ${gearError?.message}`);
    }

    // Every item goes in ONE category, so the item-level assertion is about a run of three
    // rather than about three runs of one — a run of one is ordered correctly by any query.
    reorderedCategoryId = categoryOrder[0];
    const { data: items, error: itemError } = await owner.client
      .from('pack_items')
      .insert(
        gear.map((g, index) => ({
          pack_category_id: reorderedCategoryId,
          gear_item_id: g.id,
          position: index,
        })),
      )
      .select('id, position');
    if (itemError || items?.length !== 3) {
      throw new Error(`Fixture failed to insert items: ${itemError?.message}`);
    }
    const itemOrder = [...items].sort((a, b) => a.position - b.position).map((i) => i.id);

    // THE MOVES. Each sends the lowest-id row of its run to the end, which is what makes
    // the stored order differ from ascending id — see this block's comment.
    const lowestCategory = [...categoryOrder].sort()[0];
    const categoryPlan = planCategoryMove(
      { parentId: packId, rows: categories },
      lowestCategory,
      categoryOrder.length - 1,
    );
    const categoryMove = await movePackCategory(owner.client, packId, categoryPlan.runs);
    if (categoryMove.error) {
      throw new Error(`Fixture failed to reorder categories: ${categoryMove.error.message}`);
    }
    expectedCategoryOrder = moveWithin(categoryOrder, lowestCategory, categoryOrder.length - 1);

    const lowestItem = [...itemOrder].sort()[0];
    const itemRun = { parentId: reorderedCategoryId, rows: items };
    const itemPlan = planItemMove(itemRun, itemRun, lowestItem, itemOrder.length - 1);
    const itemMove = await movePackItem(
      owner.client,
      { packId, itemId: lowestItem, toCategoryId: reorderedCategoryId },
      itemPlan.runs,
    );
    if (itemMove.error) {
      throw new Error(`Fixture failed to reorder items: ${itemMove.error.message}`);
    }
    expectedItemOrder = moveWithin(itemOrder, lowestItem, itemOrder.length - 1);
  });

  it('returns the categories in the order the reorder wrote, not in id order', () => {
    // The premise. If these two ever agree, every assertion below passes for a query that
    // dropped `position` entirely — so this failing is a broken TEST, not a broken read.
    expect(
      expectedCategoryOrder,
      'the fixture stopped producing an order that disagrees with ascending id, so the assertion below could no longer tell a sorted read from an unsorted one',
    ).not.toEqual([...expectedCategoryOrder].sort());
  });

  it('reads a reordered pack back in exactly the order that was written', async () => {
    const { data, error } = await loadPackForEdit(owner.client, owner.id, packId);
    expect(error).toBeNull();
    expect(data).not.toBeNull();

    expect(data?.pack_categories.map((category) => category.id)).toEqual(expectedCategoryOrder);

    // Distinct and not all zero, stated as an assertion rather than trusted to the reindex:
    // an order that came back right because every position happens to be 0 and the ids
    // happen to be ascending would prove nothing about `position` being read at all.
    const positions = data?.pack_categories.map((category) => category.position) ?? [];
    expect(new Set(positions).size).toBe(positions.length);
    expect(positions.some((position) => position !== 0)).toBe(true);
  });

  it('reads the items of a reordered category back in the order that was written', async () => {
    expect(
      expectedItemOrder,
      'the fixture stopped producing an item order that disagrees with ascending id',
    ).not.toEqual([...expectedItemOrder].sort());

    const { data, error } = await loadPackForEdit(owner.client, owner.id, packId);
    expect(error).toBeNull();

    const category = data?.pack_categories.find((c) => c.id === reorderedCategoryId);
    expect(category, 'the reordered category is missing from the tree').toBeDefined();
    expect(category?.pack_items.map((item) => item.id)).toEqual(expectedItemOrder);

    const positions = category?.pack_items.map((item) => item.position) ?? [];
    expect(new Set(positions).size).toBe(positions.length);
    expect(positions.some((position) => position !== 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// loadPackForEdit — a pack with no categories is a valid empty state
// ---------------------------------------------------------------------------
//
// A brand new pack — created, never given a category — is the ordinary state of "I just
// clicked New Pack", not a malformed one. `loadPackForEdit` must hand it back as a real
// row with `pack_categories: []`, not as an error and not as `null` (which this module
// otherwise reserves for "does not exist or is not yours" — see the owner-scoping
// describe block above).
describe('loadPackForEdit: a pack with no categories', () => {
  it('loads as an empty pack_categories array, not an error', async () => {
    const owner = await createUser('packs-query-empty-owner');

    const { data: pack, error: insertError } = await owner.client
      .from('packs')
      .insert({ name: 'Freshly created' })
      .select('id')
      .single();
    if (insertError || !pack) {
      throw new Error(`Fixture failed to insert empty pack: ${insertError?.message}`);
    }

    const { data, error } = await loadPackForEdit(owner.client, owner.id, pack.id);
    expect(error).toBeNull();
    expect(data).not.toBeNull();
    expect(data?.id).toBe(pack.id);
    expect(data?.pack_categories).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// loadPackList — owner-scoped, and per-pack totals from computeTotals alone
// ---------------------------------------------------------------------------

describe('loadPackList', () => {
  it("excludes another user's public pack, the same way loadPackForEdit does", async () => {
    const victim = await createUser('packs-query-list-leak-victim');
    const attacker = await createUser('packs-query-list-leak-attacker');
    const victimPack = await createPack(victim, { visibility: 'public', itemCount: 1 });

    const { packs, error } = await loadPackList(attacker.client, attacker.id);
    expect(error).toBeNull();
    expect(packs.map((entry) => entry.pack.id)).not.toContain(victimPack.packId);
  });

  it('fetches every owned pack, each with per-pack totals equal to computeTotals over the same tree', async () => {
    // Two packs so this is a real claim about a LIST, not one that happens to hold for
    // a single-pack result by coincidence.
    const owner = await createUser('packs-query-list-owner');
    const packA = await createPack(owner, { itemCount: 2 });
    const packB = await createPack(owner, { itemCount: 1 });

    const { packs, error } = await loadPackList(owner.client, owner.id);
    expect(error).toBeNull();

    const packAEntry = packs.find((entry) => entry.pack.id === packA.packId);
    const packBEntry = packs.find((entry) => entry.pack.id === packB.packId);
    expect(packAEntry).toBeDefined();
    expect(packBEntry).toBeDefined();

    // TOTALS COME FROM computeTotals AND NOWHERE ELSE. This does not assert a
    // hand-computed weight or price — that would only prove computeTotals itself is
    // correct, which is tests/totals.test.ts's job. It asserts that the tree
    // loadPackList fetched for each pack, run back through computeTotals independently
    // via loadPackForEdit, produces the IDENTICAL totals loadPackList reported. That is
    // what "no second summation" actually means in a way a test can fail on: if
    // loadPackList ever grew its own weight/price arithmetic that drifted from
    // computeTotals, this is the assertion that would catch it.
    const freshA = await loadPackForEdit(owner.client, owner.id, packA.packId);
    const freshB = await loadPackForEdit(owner.client, owner.id, packB.packId);
    expect(freshA.error).toBeNull();
    expect(freshB.error).toBeNull();
    expect(freshA.data).not.toBeNull();
    expect(freshB.data).not.toBeNull();

    const expectedA: PackTotals = computeTotals(freshA.data as PackTreeRow);
    const expectedB: PackTotals = computeTotals(freshB.data as PackTreeRow);

    expect(packAEntry?.totals.itemCount).toBe(expectedA.itemCount);
    expect(packAEntry?.totals.base).toBe(expectedA.base);
    expect(Object.fromEntries(packAEntry!.totals.pricesByCurrency)).toEqual(
      Object.fromEntries(expectedA.pricesByCurrency),
    );

    expect(packBEntry?.totals.itemCount).toBe(expectedB.itemCount);
    expect(packBEntry?.totals.base).toBe(expectedB.base);
    expect(Object.fromEntries(packBEntry!.totals.pricesByCurrency)).toEqual(
      Object.fromEntries(expectedB.pricesByCurrency),
    );
  });
});

// ---------------------------------------------------------------------------
// The shape PACK_TREE_SELECT returns — moved from tests/totals.test.ts (PK-37)
// ---------------------------------------------------------------------------

/**
 * Moved here from `tests/totals.test.ts` alongside `PACK_TREE_SELECT` itself — see
 * `src/lib/totals.ts:200-220` for the full history of why the assertion used to live
 * there and why it lives here now. Nothing about the REASONING changed in the move, only
 * its address, and the paragraph below is preserved for that reason rather than rewritten.
 *
 * The engine must consume what the one pack-tree select actually fetches, without a
 * hand-written reshaping step in between — that transcription is precisely where a `worn`
 * flag gets dropped on the way from the query to the arithmetic.
 *
 * Both halves are asserted. The compile-time half below is the load-bearing one, and it
 * fires in BOTH directions: with no optional properties left on `computeTotals`'s input
 * types, it fails `tsc --noEmit` if `PACK_TREE_SELECT` is narrowed (a missing column is a
 * missing required property) as well as if the engine grows a field the select does not
 * fetch. Before the four flag and price fields were made required on the engine side it
 * could only catch the second, which is why a select that had never fetched `consumable`
 * or `price` compiled happily for as long as it did.
 *
 * "No optional properties left" only became literally true at PK-37's independent review.
 * `snapshot` and `gear_items` stayed optional through that first correction, and a reviewer
 * demonstrated the gap by deleting both from `PACK_TREE_SELECT` and watching `tsc --noEmit`
 * pass — a select that fetches no snapshots resolves every item of a LOCKED pack from live
 * gear instead of from the frozen copy, which is a wrong pack rather than a missing one.
 * Both are required-and-nullable now, and removing either from the select string is a
 * compile error in this block.
 *
 * The runtime half is a literal in the exact shape PostgREST returns — a to-one
 * `gear_items` embed as an OBJECT (`tests/core-schema.test.ts` pins that against the wire
 * format), embedded arrays for the to-many ones, and every column the select names,
 * including the four whose absence used to be the interesting case.
 */
describe('the shape PACK_TREE_SELECT returns', () => {
  // THE VACUITY GUARD, AND IT IS NOT WHAT USED TO BE HERE. `never` is assignable to
  // everything, so if `PackTreeRow` ever resolved to `never` — a PostgREST select string
  // the type-level parser cannot read resolves its row type that way — the assignment
  // below would compile whatever `computeTotals` demanded, and this whole block would be
  // asserting nothing at all. What stood here was `type _CategoriesAreEmbedded =
  // PackTreeRow['pack_categories']`, with a comment claiming that naming the property
  // "keeps that honest". It does not: an indexed access on `never` is `never`, so that
  // alias compiles happily for exactly the case it was written to catch.
  //
  // This is the test that actually fires. `[T] extends [never]` is the tuple-wrapped form,
  // which is what stops the conditional distributing over a union and answering the wrong
  // question; on the `never` branch the required type has no `true` in it, so the
  // initialiser below fails to compile and names the reason.
  type _Inhabited<T> = [T] extends [never] ? 'PackTreeRow resolved to never' : true;
  const _packTreeRowIsInhabited: _Inhabited<PackTreeRow> = true;

  // Still worth naming: this fails if the row type has no `pack_categories` at all, which
  // is a differently-shaped mistake from the row type collapsing to `never`.
  type _CategoriesAreEmbedded = PackTreeRow['pack_categories'];

  // The assertion itself: a function accepting the query's row type, satisfied by
  // computeTotals. Contravariance means this only compiles if PackTreeRow is assignable
  // to PackTreePack.
  const _acceptsQueryRows: (row: PackTreeRow) => PackTotals = computeTotals;

  it('totals a row in exactly the shape PACK_TREE_SELECT returns', () => {
    const GRAMS = { oz: 28.349523125 } as const;

    const row = {
      id: 'pack-1',
      name: 'Test pack',
      description: null,
      trip_type: null,
      slug: 'testpack1234',
      visibility: 'public',
      locked_at: null,
      pack_categories: [
        {
          id: 'category-1',
          name: 'Shelter',
          position: 0,
          pack_items: [
            {
              id: 'item-1',
              quantity: 2,
              worn: false,
              consumable: false,
              packed: true,
              position: 0,
              overrides: {},
              snapshot: null,
              gear_items: {
                id: 'gear-1',
                name: 'Gear 1',
                brand: 'Testbrand',
                weight_grams: 100,
                price: 42.5,
                currency: 'GBP',
              },
            },
            {
              id: 'item-2',
              quantity: 1,
              worn: false,
              consumable: true,
              packed: false,
              position: 1,
              overrides: {},
              snapshot: null,
              gear_items: {
                id: 'gear-2',
                name: 'Oats',
                brand: 'Testbrand',
                weight_grams: 4.4 * GRAMS.oz,
                price: null,
                currency: null,
              },
            },
          ],
        },
      ],
    };

    const totals = computeTotals(row);

    expect(totals.base).toBe(200);
    expect(totals.itemCount).toBe(3);
    // The consequence of the widened select, stated rather than left to be discovered:
    // the consumable item's weight lands in its own bucket instead of in base, the packed
    // row is counted, and the pack has a price.
    expect(totals.consumable).toBeCloseTo(4.4 * GRAMS.oz, 9);
    expect(totals.packedCount).toBe(2);
    expect(Object.fromEntries(totals.pricesByCurrency)).toEqual({
      GBP: { amountMinorUnits: 8500, currency: 'GBP' },
    });
  });
});
