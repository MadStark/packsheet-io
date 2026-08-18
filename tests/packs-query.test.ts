import { describe, expect, it, beforeAll } from 'vitest';
import { createUser, type TestUser, type PacksheetClient } from './support/local-database';
import { createPack } from './support/fixtures';
import {
  PACK_TREE_SELECT,
  loadPackForEdit,
  loadPackList,
  type PackTreeRow,
} from '../src/lib/packs/query';
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
 * The runtime half is a literal in the exact shape PostgREST returns — a to-one
 * `gear_items` embed as an OBJECT (`tests/core-schema.test.ts` pins that against the wire
 * format), embedded arrays for the to-many ones, and every column the select names,
 * including the four whose absence used to be the interesting case.
 */
describe('the shape PACK_TREE_SELECT returns', () => {
  // If this ever resolves to `never` or to a PostgREST parser error, the assignment below
  // would pass vacuously; naming the property keeps that honest.
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
