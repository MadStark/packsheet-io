import { describe, expect, it, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createUser, type TestUser } from './support/local-database';
import { createPack } from './support/fixtures';
import {
  GEAR_SELECT,
  GEAR_TRASH_SELECT,
  applyGearQuery,
  parseGearQuery,
} from '../src/lib/gear/query';
import {
  GEAR_PAGE_SIZE,
  GEAR_STATUSES,
  type GearSortKey,
  type GearStatus,
} from '../src/lib/gear/fields';
import { makeUndoToken } from '../src/lib/gear/bulk';
import type { WeightUnit } from '../src/lib/units';
import type { Database } from '../src/lib/database.types';

type GearInsert = Database['public']['Tables']['gear_items']['Insert'];

/**
 * The integration tests behind PK-4's acceptance criteria: "500 items remain
 * responsive; filters compose correctly; bulk delete is undoable." Every other gear
 * closet test file is a unit test for one layer in isolation — `gear-query.test.ts`
 * for the pure URL <-> `GearQuery` translation, `gear-bulk.test.ts` for bulk-action
 * validation, `gear-search-escaping.test.ts` for the two-layer search escaping,
 * `gear-closet-schema.test.ts` for the three new columns. This file is the one that
 * proves those layers actually compose correctly against a REAL database, through
 * PostgREST, as a real authenticated user — the same path `src/pages/gear/index.astro`
 * and `src/pages/gear/trash.astro` take.
 *
 * Same care as the rest of this project's suites: every assertion is commented with
 * the specific bug it would catch, not merely what the code does.
 *
 * SHARED-DATABASE DISCIPLINE. `vitest.config.ts` does not reset the database between
 * files, and this suite's own RLS tests establish that `gear_items_select_via_public_pack`
 * is granted to `authenticated` — so gear on ANY public pack, from ANY prior test file,
 * is visible to every client here. Every fixture below is therefore scoped to its own
 * freshly created user(s) and asserted on by exact id or by a value distinctive enough
 * (a random suffix, a fixed set of names inserted together) that it cannot collide with
 * whatever else this shared Postgres happens to hold by the time this file runs.
 */

// ---------------------------------------------------------------------------
// Helpers: the real query shapes the pages build, not hand-rolled stand-ins.
// ---------------------------------------------------------------------------

function toSearchParams(entries: Record<string, string | string[]>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(entries)) {
    if (Array.isArray(value)) {
      for (const v of value) params.append(key, v);
    } else {
      params.set(key, value);
    }
  }
  return params;
}

/**
 * THE REAL CLOSET QUERY — byte-for-byte the same shape `src/pages/gear/index.astro`
 * builds: `parseGearQuery` over a URL query string, then `applyGearQuery` over a
 * builder that is ALREADY scoped with `.eq('user_id', user.id)` before
 * `applyGearQuery` ever sees it. See that page's own comment on why the owner filter
 * has to be added by the caller rather than by `applyGearQuery` itself.
 */
function closetQuery(user: TestUser, entries: Record<string, string | string[]> = {}) {
  const query = parseGearQuery(toSearchParams(entries));
  return applyGearQuery(
    user.client.from('gear_items').select(GEAR_SELECT, { count: 'exact' }).eq('user_id', user.id),
    query,
  );
}

/**
 * THE BROKEN CLOSET QUERY — identical to `closetQuery` in every way except the one
 * line that matters: no `.eq('user_id', user.id)`. This is what a closet query would
 * look like if the fix described in the file header had never been written, or were
 * ever deleted by someone "simplifying" the query. It exists ONLY so the leak test
 * below can demonstrate the leak actually happens absent that filter, rather than
 * merely asserting the filtered query looks correct in isolation.
 */
function leakyClosetQuery(user: TestUser, entries: Record<string, string | string[]> = {}) {
  const query = parseGearQuery(toSearchParams(entries));
  return applyGearQuery(user.client.from('gear_items').select(GEAR_SELECT), query);
}

/** The real trash query — byte-for-byte the same shape `src/pages/gear/trash.astro`
 *  builds, `.eq('user_id', ...)` included for the identical reason as `closetQuery`. */
function trashQuery(user: TestUser) {
  return user.client
    .from('gear_items')
    .select(GEAR_TRASH_SELECT)
    .eq('user_id', user.id)
    .not('deleted_at', 'is', null)
    .order('deleted_at', { ascending: false })
    .order('id', { ascending: true });
}

function names(rows: { name: string }[] | null | undefined): string[] {
  return (rows ?? []).map((row) => row.name);
}

/** Reads one field out of a jsonb snapshot without a bare `any` cast. */
function jsonField(value: unknown, key: string): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return (value as Record<string, unknown>)[key];
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 1. THE CROSS-USER LEAK — the single most important test in this file.
// ---------------------------------------------------------------------------
//
// An earlier task found this by loading the real gear closet page: a closet query
// relying on RLS alone returned ANOTHER USER'S gear the moment that user's gear sat
// on a public pack. The mechanism is `gear_items_select_via_public_pack`
// (core_schema.sql), a SELECT policy granted to `authenticated` (not just `anon`) so
// a signed-in visitor can render a shared pack link. RLS policies are UNIONED, not
// intersected — so a signed-in user's plain `select * from gear_items` is answered
// with "my own rows OR any row that sits on ANYONE's public pack", and nothing in
// that policy cares whose session is asking. The fix was an explicit
// `.eq('user_id', user.id)` on every closet read, which both `closetQuery` above and
// the real `src/pages/gear/index.astro` carry.
//
// WHY THIS TEST ASSERTS BOTH HALVES, NOT JUST "A DOES NOT SEE B'S ITEM". Asserting
// only the safe half would still pass if `applyGearQuery` or RLS had been changed in
// some unrelated way that happened to also hide the item — it would prove nothing
// about WHICH line of code is doing the work. Asserting only the leaky half would
// prove the vulnerability exists but not that the shipped fix closes it. Asserting
// both — the exact same query, once with the owner filter and once without it, one
// returning nothing and the other returning the item — is what pins the fix to the
// one line responsible for it. Delete `.eq('user_id', user.id)` from `closetQuery`
// (or from the real page) and this test fails; that is the entire reason it exists,
// and why it belongs in this file rather than being read as redundant with the RLS
// suite: `tests/rls-owner.test.ts` proves the POLICY layer behaves as designed
// (`gear_items_select_via_public_pack` does what its own comment says); this test
// proves the APPLICATION layer does not lean on that policy alone for a page whose
// entire premise is "your own gear, and nothing else".
describe('THE CROSS-USER LEAK — a closet query never returns another user’s gear, even when that gear sits on a public pack', () => {
  let victim: TestUser;
  let attacker: TestUser;
  let leakedItemId: string;
  let leakedBrand: string;

  beforeAll(async () => {
    victim = await createUser('gear-closet-leak-victim');
    attacker = await createUser('gear-closet-leak-attacker');

    // Give the victim a gear item, on the victim's own public pack — createPack
    // (tests/support/fixtures.ts) builds the pack, its category and its one gear
    // item entirely as the victim, through PostgREST under RLS, which is exactly
    // how a real user's closet item ends up on a real public pack.
    const victimPublicPack = await createPack(victim, { visibility: 'public', itemCount: 1 });
    leakedItemId = victimPublicPack.gearItemIds[0];

    // Renamed to a value nothing else in this shared, never-reset-between-files
    // database could coincidentally also carry, so the search-scoped queries below
    // find this row and ONLY this row — regardless of how many other packs, from
    // other test files, already happen to be public by the time this runs.
    leakedBrand = `LeakProbe-${randomUUID()}`;
    await victim.client
      .from('gear_items')
      .update({ name: 'Victim’s Ultralight Tarp', brand: leakedBrand })
      .eq('id', leakedItemId);
  });

  it('the real closet query excludes it; the same query with the owner filter removed includes it', async () => {
    // Scoped by search to the one distinctive row, so this assertion is not at the
    // mercy of pagination or of how much other public-pack fixture data this shared
    // database already holds by the time this file runs.
    const safe = await closetQuery(attacker, { q: leakedBrand });
    expect(safe.error).toBeNull();
    // The bug this catches: "your gear closet" silently showing a stranger's item
    // the moment that stranger publishes a pack.
    expect((safe.data ?? []).map((row) => row.id)).toEqual([]);

    const leaky = await leakyClosetQuery(attacker, { q: leakedBrand });
    expect(leaky.error).toBeNull();
    // Proves the premise: RLS alone really does hand this row to a signed-in
    // stranger, so the safe half above is demonstrating a real fix, not a query that
    // was already going to return nothing for some unrelated reason (a typo in the
    // search term, an empty table, a broken client).
    expect((leaky.data ?? []).map((row) => row.id)).toContain(leakedItemId);
  });
});

// ---------------------------------------------------------------------------
// 2 & 3. Filters compose correctly, and search matches name or brand.
// ---------------------------------------------------------------------------

interface FilterFixtureItem {
  name: string;
  category: string;
  status: GearStatus;
  brand: string;
  weight: number;
  weightUnit: WeightUnit;
}

/**
 * Varied across category, status, brand and weight (entered in different units, so
 * `weight_grams` is genuinely doing the comparing rather than the raw `weight`
 * number). Every combination test below is chosen so that at least one OTHER item
 * would incorrectly appear if the filter in question were dropped or turned into an
 * OR — see each test's own comment for which item that is.
 */
const FILTER_ITEMS: readonly FilterFixtureItem[] = [
  {
    name: 'Alpine Tent',
    category: 'Shelter',
    status: 'owned',
    brand: 'Alpha',
    weight: 2,
    weightUnit: 'kg',
  },
  {
    name: 'Bivy Sack',
    category: 'Shelter',
    status: 'wishlist',
    brand: 'Alpha',
    weight: 500,
    weightUnit: 'g',
  },
  {
    name: 'Camp Stove',
    category: 'Cook',
    status: 'owned',
    brand: 'Alpha',
    weight: 300,
    weightUnit: 'g',
  },
  {
    name: 'Dutch Oven',
    category: 'Cook',
    status: 'retired',
    brand: 'Beta',
    weight: 1.5,
    weightUnit: 'kg',
  },
  {
    name: 'Sleeping Bag',
    category: 'Sleep',
    status: 'owned',
    brand: 'Beta',
    weight: 900,
    weightUnit: 'g',
  },
  {
    name: 'Sleeping Pad',
    category: 'Sleep',
    status: 'wishlist',
    brand: 'Beta',
    weight: 2,
    weightUnit: 'lb',
  },
  {
    name: 'Backpack',
    category: 'Pack',
    status: 'owned',
    brand: 'Alpha',
    weight: 3,
    weightUnit: 'lb',
  },
  {
    name: 'Trekking Poles',
    category: 'Pack',
    status: 'retired',
    brand: 'Beta',
    weight: 8,
    weightUnit: 'oz',
  },
  {
    name: 'Duffel Bag',
    category: 'Pack',
    status: 'owned',
    brand: 'Gamma',
    weight: 400,
    weightUnit: 'g',
  },
];

describe('filters compose correctly', () => {
  let filterUser: TestUser;

  beforeAll(async () => {
    filterUser = await createUser('gear-closet-filters');
    const { error } = await filterUser.client.from('gear_items').insert(
      FILTER_ITEMS.map((item) => ({
        name: item.name,
        category: item.category,
        status: item.status,
        brand: item.brand,
        weight: item.weight,
        weight_unit: item.weightUnit,
      })),
    );
    if (error) {
      throw new Error(`Fixture failed to insert filter items: ${error.message}`, { cause: error });
    }
  });

  async function filteredNames(entries: Record<string, string | string[]>): Promise<string[]> {
    const { data, error } = await closetQuery(filterUser, entries);
    expect(error).toBeNull();
    return names(data);
  }

  it('search AND category — "Bag" alone matches two items, category=Sleep must narrow to one', async () => {
    // Both "Sleeping Bag" (Sleep) and "Duffel Bag" (Pack) contain "Bag". If search
    // and category were composed as OR instead of AND, this would return both.
    expect(await filteredNames({ q: 'Bag', category: 'Sleep' })).toEqual(['Sleeping Bag']);
  });

  it('category AND status — Pack has three items, status=owned drops the retired one', async () => {
    // Pack alone is Backpack, Trekking Poles, Duffel Bag. Trekking Poles is retired
    // and must be dropped without dropping the other two.
    expect(await filteredNames({ category: 'Pack', status: 'owned' })).toEqual([
      'Backpack',
      'Duffel Bag',
    ]);
  });

  it('status AND brand — three Alpha items are owned; a fourth Alpha item is not', async () => {
    // Bivy Sack is Alpha but wishlist, and must be excluded by the status half even
    // though the brand half alone would include it.
    expect(await filteredNames({ status: 'owned', brand: 'Alpha' })).toEqual([
      'Alpine Tent',
      'Backpack',
      'Camp Stove',
    ]);
  });

  it('weight range AND category — proves weight_grams, not the raw entered number, is compared', async () => {
    // Camp Stove is 300 g; Dutch Oven is 1.5 kg = 1500 g. A 200-1000 g range within
    // category=Cook must keep the first and drop the second. Comparing the raw
    // `weight` column instead (300 vs 1.5) would get this backwards.
    expect(await filteredNames({ category: 'Cook', wmin: '200', wmax: '1000' })).toEqual([
      'Camp Stove',
    ]);
  });

  it('three filters at once — category, status and weight range together', async () => {
    // Backpack (3 lb ~= 1361 g) and Duffel Bag (400 g) are both category=Pack and
    // status=owned; capping at 500 g must keep only Duffel Bag. Any one of the three
    // filters being dropped would let Backpack, Trekking Poles or Bivy Sack back in.
    expect(await filteredNames({ category: 'Pack', status: 'owned', wmax: '500' })).toEqual([
      'Duffel Bag',
    ]);
  });

  it('a combination matching nothing returns an empty list, not an error and not every row', async () => {
    // No Sleep item is branded Alpha (both Sleeping Bag and Sleeping Pad are Beta) —
    // the negative control for every AND above: if the filters had degenerated into
    // an OR, this would return every Sleep item and every Alpha item instead of none.
    expect(await filteredNames({ category: 'Sleep', brand: 'Alpha' })).toEqual([]);
  });

  it('minGrams greater than maxGrams returns an empty list, by design — never reordered or half-applied', async () => {
    // parseGearQuery's own contract (query.ts, "MIN > MAX IS KEPT, NEVER FIXED"):
    // wmin=2000 > wmax=100 produces `weight_grams >= 2000 and weight_grams <= 100`,
    // an always-false range. This pins that applyGearQuery honours that contract
    // rather than "helpfully" swapping the two bounds or dropping one of them.
    expect(await filteredNames({ wmin: '2000', wmax: '100' })).toEqual([]);
  });
});

// Character-escaping edge cases (commas, %, _, quotes, parentheses, backslashes,
// non-ASCII) are already covered exhaustively by tests/gear-search-escaping.test.ts
// against buildSearchFilter directly — not duplicated here. This section only
// confirms the higher-level behaviour: name-or-brand, case-insensitive, mid-word.
describe('search matches name or brand, case-insensitively, mid-word', () => {
  let filterUser: TestUser;

  beforeAll(async () => {
    filterUser = await createUser('gear-closet-search');
    const { error } = await filterUser.client.from('gear_items').insert(
      FILTER_ITEMS.map((item) => ({
        name: item.name,
        category: item.category,
        status: item.status,
        brand: item.brand,
        weight: item.weight,
        weight_unit: item.weightUnit,
      })),
    );
    if (error) {
      throw new Error(`Fixture failed to insert search items: ${error.message}`, { cause: error });
    }
  });

  async function searchNames(q: string): Promise<string[]> {
    const { data, error } = await closetQuery(filterUser, { q });
    expect(error).toBeNull();
    return names(data);
  }

  it('matches a substring in the middle of a name, not only a prefix', async () => {
    // "ine Te" sits in the middle of "Alpine Tent" (…alp-INE TE-nt…); a search that
    // only matched from the start of the string would return nothing here.
    expect(await searchNames('ine Te')).toEqual(['Alpine Tent']);
  });

  it('matches via brand when the term appears nowhere in the name', async () => {
    // "amm" is a substring of the brand "Gamma" (on Duffel Bag) and appears in no
    // item's NAME — this fails if search were name-only rather than name-or-brand.
    expect(await searchNames('amm')).toEqual(['Duffel Bag']);
  });

  it('is case-insensitive in both name and brand', async () => {
    expect(await searchNames('ALPINE')).toEqual(['Alpine Tent']);
    expect(await searchNames('GAMMA')).toEqual(['Duffel Bag']);
  });
});

// ---------------------------------------------------------------------------
// 4. Sorting — each of the four sort keys, both directions.
// ---------------------------------------------------------------------------

describe('sorting', () => {
  let sortUser: TestUser;

  beforeAll(async () => {
    sortUser = await createUser('gear-closet-sort');

    // Inserted ONE AT A TIME, in this exact order, so created_at is strictly
    // increasing — a single bulk insert can leave several rows sharing the same
    // microsecond, which would make the "added" sort's expected order ambiguous.
    const insertOne = (fields: GearInsert) =>
      sortUser.client.from('gear_items').insert(fields).select('id').single();

    await insertOne({
      name: 'Featherweight Quilt',
      weight: 300,
      weight_unit: 'g',
      price: 200,
      currency: 'USD',
    });
    await insertOne({
      name: 'Basecamp Grill',
      weight: 500,
      weight_unit: 'g',
      price: 50,
      currency: 'USD',
    });
    await insertOne({
      name: 'Overnight Pack',
      weight: 2,
      weight_unit: 'lb', // ≈ 907 g — heavier than either of the two above in grams
      price: 120,
      currency: 'USD',
    });
  });

  async function sortedNames(sort: GearSortKey, direction: 'asc' | 'desc'): Promise<string[]> {
    const { data, error } = await closetQuery(sortUser, { sort, dir: direction });
    expect(error).toBeNull();
    return names(data);
  }

  it('sorts by name, both directions', async () => {
    expect(await sortedNames('name', 'asc')).toEqual([
      'Basecamp Grill',
      'Featherweight Quilt',
      'Overnight Pack',
    ]);
    expect(await sortedNames('name', 'desc')).toEqual([
      'Overnight Pack',
      'Featherweight Quilt',
      'Basecamp Grill',
    ]);
  });

  it('sorts by weight_grams, not the raw entered number — a 2 lb item outweighs a 500 g one', async () => {
    // Featherweight Quilt: 300 g. Basecamp Grill: 500 g. Overnight Pack: 2 lb ≈ 907
    // g. Sorting by the bare `weight` column would rank Overnight Pack (raw value 2)
    // below both — this is the assertion that proves weight_grams is what
    // GEAR_SORT_COLUMNS.weight actually points at.
    expect(await sortedNames('weight', 'asc')).toEqual([
      'Featherweight Quilt',
      'Basecamp Grill',
      'Overnight Pack',
    ]);
    expect(await sortedNames('weight', 'desc')).toEqual([
      'Overnight Pack',
      'Basecamp Grill',
      'Featherweight Quilt',
    ]);
  });

  it('sorts by price, both directions', async () => {
    expect(await sortedNames('price', 'asc')).toEqual([
      'Basecamp Grill',
      'Overnight Pack',
      'Featherweight Quilt',
    ]);
    expect(await sortedNames('price', 'desc')).toEqual([
      'Featherweight Quilt',
      'Overnight Pack',
      'Basecamp Grill',
    ]);
  });

  it('sorts by date added, both directions', async () => {
    expect(await sortedNames('added', 'asc')).toEqual([
      'Featherweight Quilt',
      'Basecamp Grill',
      'Overnight Pack',
    ]);
    expect(await sortedNames('added', 'desc')).toEqual([
      'Overnight Pack',
      'Basecamp Grill',
      'Featherweight Quilt',
    ]);
  });
});

// ---------------------------------------------------------------------------
// 5. Pagination, including the tie case.
// ---------------------------------------------------------------------------

describe('pagination walks every item exactly once, including when many rows tie on the sort column', () => {
  const TIE_COUNT = 120;
  let paginationUser: TestUser;
  let expectedNames: string[];

  beforeAll(async () => {
    paginationUser = await createUser('gear-closet-pagination');

    // Every one of these 120 rows weighs EXACTLY 100 g — a deliberately large tie on
    // the sort column. Without the `id` tiebreaker applyGearQuery adds after every
    // sort column (query.ts, "A STABLE id TIEBREAKER IS ADDED..."), Postgres is free
    // to answer two separate .range() calls for the SAME tied ordering with the ties
    // in a different relative order each time, which can silently drop a row (it
    // falls between two pages' worth of a reshuffled order) or duplicate one (it
    // lands on both). That is exactly what this test exists to catch.
    const rows = Array.from({ length: TIE_COUNT }, (_, i) => ({
      name: `Tie Item ${String(i).padStart(4, '0')}`,
      weight: 100,
      weight_unit: 'g',
    }));
    const { data, error } = await paginationUser.client
      .from('gear_items')
      .insert(rows)
      .select('name');
    if (error) {
      throw new Error(`Fixture failed to insert tie items: ${error.message}`, { cause: error });
    }
    expectedNames = (data ?? []).map((row) => row.name).sort();
  });

  it(`the union of every page equals the full set exactly, for ${TIE_COUNT} items all tied on weight`, async () => {
    const pageCount = Math.ceil(TIE_COUNT / GEAR_PAGE_SIZE);
    const seen = new Map<string, number>();

    for (let page = 1; page <= pageCount; page++) {
      const { data, error } = await closetQuery(paginationUser, {
        sort: 'weight',
        page: String(page),
      });
      expect(error).toBeNull();
      for (const row of data ?? []) {
        seen.set(row.name, (seen.get(row.name) ?? 0) + 1);
      }
    }

    // No row appeared on more than one page — the "duplicated across a page
    // boundary" half of the classic pagination-tiebreaker bug.
    const duplicated = [...seen.entries()].filter(([, count]) => count > 1).map(([name]) => name);
    expect(duplicated).toEqual([]);

    // No row was dropped between page boundaries — the "silently missing" half.
    const missing = expectedNames.filter((name) => !seen.has(name));
    expect(missing).toEqual([]);

    // And nothing extra came back either: the set is exact.
    expect([...seen.keys()].sort()).toEqual(expectedNames);
  });
});

// ---------------------------------------------------------------------------
// 6. Soft delete, undo and the trash.
// ---------------------------------------------------------------------------

describe('soft delete, undo and the trash', () => {
  it('a soft-deleted item leaves the closet and appears in the trash; undo restores exactly its own batch, leaving an earlier batch untouched; the restored item keeps its original created_at', async () => {
    const user = await createUser('gear-closet-trash');

    // An EARLIER batch, soft-deleted first with its own token. This is the batch
    // that must still be sitting in the trash, unaffected, after the LATER batch's
    // undo below runs.
    const earlier = await user.client
      .from('gear_items')
      .insert({ name: 'Old Batch Item' })
      .select('id')
      .single();
    const earlierId = earlier.data!.id as string;
    const earlierToken = makeUndoToken();
    await user.client
      .from('gear_items')
      .update({ deleted_at: earlierToken })
      .eq('id', earlierId)
      .is('deleted_at', null);

    // A short real wait between the two batches: makeUndoToken has millisecond
    // resolution, and two batches minted back-to-back on a fast local stack could
    // otherwise collide on the same token — which would make this test pass for the
    // wrong reason (one token, not two distinct batches).
    await new Promise((resolve) => setTimeout(resolve, 5));

    const later = await user.client
      .from('gear_items')
      .insert({ name: 'New Batch Item' })
      .select('id, created_at')
      .single();
    const laterId = later.data!.id as string;
    const laterCreatedAt = later.data!.created_at as string;

    const laterToken = makeUndoToken();
    expect(laterToken).not.toBe(earlierToken);

    // The soft delete itself — mirrors src/pages/gear/index.astro's bulk delete
    // exactly, including the `.is('deleted_at', null)` guard. That guard is what
    // stops this UPDATE from re-stamping the EARLIER batch (already in the trash)
    // with THIS batch's new token too, which would silently widen what undoing
    // laterToken restores — see bulk.ts's own "THE CALLER MUST GUARD" comment.
    await user.client
      .from('gear_items')
      .update({ deleted_at: laterToken })
      .eq('id', laterId)
      .is('deleted_at', null);

    // 1a. Disappears from the closet.
    const closetAfterDelete = await closetQuery(user);
    expect((closetAfterDelete.data ?? []).map((row) => row.id)).not.toContain(laterId);

    // 1b. Appears in the trash, alongside the earlier batch.
    const trashAfterDelete = await trashQuery(user);
    const trashIdsAfterDelete = (trashAfterDelete.data ?? []).map((row) => row.id);
    expect(trashIdsAfterDelete).toContain(laterId);
    expect(trashIdsAfterDelete).toContain(earlierId);

    // 2. Undo the LATER batch only — mirrors the production undo statement exactly:
    // `update gear_items set deleted_at = null where deleted_at = $token`.
    await user.client.from('gear_items').update({ deleted_at: null }).eq('deleted_at', laterToken);

    // The earlier batch is untouched: still in the trash, still carrying ITS OWN
    // token. If the `.is('deleted_at', null)` guard on the delete above were
    // missing, the earlier item would already have been silently re-stamped with
    // laterToken and would incorrectly vanish from the trash here too — this is
    // exactly what that guard protects.
    const trashAfterUndo = await trashQuery(user);
    const trashRowsAfterUndo = trashAfterUndo.data ?? [];
    expect(trashRowsAfterUndo.map((row) => row.id)).toEqual([earlierId]);
    // PostgREST serialises timestamptz with a "+00:00" offset rather than the "Z"
    // suffix makeUndoToken() produces, so the two are compared as instants (via
    // Date), not as byte-identical strings — a mismatch here would mean the row read
    // back is not the one earlierToken was actually stamped onto.
    expect(new Date(trashRowsAfterUndo[0]?.deleted_at as string).getTime()).toBe(
      new Date(earlierToken).getTime(),
    );

    // 3. The restored item is back in the closet, with its ORIGINAL created_at
    // intact. This is the entire reason soft delete (clearing one column) was
    // chosen over delete-and-reinsert: set_row_timestamps() unconditionally stamps
    // created_at = now() on INSERT, so a re-inserted row would silently lose its
    // real "date added" — see the gear-closet migration's own reasoning. A wrong
    // created_at here would mean that reasoning was not actually honoured.
    const closetAfterUndo = await closetQuery(user);
    const restored = (closetAfterUndo.data ?? []).find((row) => row.id === laterId);
    expect(restored).toBeDefined();
    expect(restored?.created_at).toBe(laterCreatedAt);
  });
});

// ---------------------------------------------------------------------------
// 7. Permanent delete still freezes packs.
// ---------------------------------------------------------------------------

describe('a permanent delete still freezes the pack it sits on', () => {
  it('DELETE fires gear_items_snapshot_before_delete: the pack_items row survives, gear_item_id becomes null, and the snapshot captures the item', async () => {
    const user = await createUser('gear-closet-freeze');
    const pack = await createPack(user, { visibility: 'private', itemCount: 1 });
    const gearItemId = pack.gearItemIds[0];
    const packItemId = pack.itemIds[0];

    // A REAL delete, not a soft delete — this proves the soft-delete work in this
    // ticket did not quietly change the pre-existing freeze semantics for the case
    // where a gear item is actually removed from the database.
    const { error: deleteError } = await user.client
      .from('gear_items')
      .delete()
      .eq('id', gearItemId);
    expect(deleteError).toBeNull();

    const { data, error: readError } = await user.client
      .from('pack_items')
      .select('id, gear_item_id, snapshot')
      .eq('id', packItemId)
      .single();
    expect(readError).toBeNull();

    // The referencing row survives the delete rather than being cascaded away —
    // the whole point of the freeze.
    expect(data?.id).toBe(packItemId);
    // Its reference to the now-gone gear item is nulled out …
    expect(data?.gear_item_id).toBeNull();
    // … and replaced by a populated snapshot carrying the item's own details, not
    // an empty or null placeholder.
    expect(data?.snapshot).toBeTruthy();
    expect(jsonField(data?.snapshot, 'name')).toBe('Gear 1');
    expect(jsonField(data?.snapshot, 'gear_item_id')).toBe(gearItemId);
  });
});

// ---------------------------------------------------------------------------
// 8. 500 items remain responsive.
// ---------------------------------------------------------------------------

describe('500 items remain responsive', () => {
  it('a realistic filtered, sorted, paginated query returns the exact page and the exact count, in bounded time', async () => {
    const user = await createUser('gear-closet-perf');
    const PERF_COUNT = 500;
    const categories = ['Shelter', 'Cook', 'Sleep', 'Pack', 'Camp'];

    // weight = i, unit 'g' throughout, so weight_grams = i exactly for every row —
    // unique and monotonic, which makes the expected sorted page below computable
    // in plain arithmetic rather than needing to guess how Postgres breaks ties.
    const rows = Array.from({ length: PERF_COUNT }, (_, i) => ({
      name: `Perf Item ${String(i).padStart(4, '0')}`,
      category: categories[i % categories.length],
      status: GEAR_STATUSES[i % GEAR_STATUSES.length],
      brand: `Brand${i % 7}`,
      weight: i,
      weight_unit: 'g',
    }));

    // One bulk insert, not 500 round trips — this fixture alone would otherwise
    // dominate the file's runtime and the wider suite's ~24s baseline.
    const insert = await user.client.from('gear_items').insert(rows);
    expect(insert.error).toBeNull();

    // category='Shelter' is i % 5 === 0 → exactly 100 of the 500 rows match, with
    // weight (and so weight_grams) increasing in step with i across that subset. So
    // sorted-by-weight-ascending order is exactly ascending i, and page 2
    // (offset 50, size GEAR_PAGE_SIZE) is i = 250, 255, …, 495.
    const expectedPage2 = Array.from({ length: GEAR_PAGE_SIZE }, (_, k) => {
      const i = (GEAR_PAGE_SIZE + k) * 5;
      return `Perf Item ${String(i).padStart(4, '0')}`;
    });

    const start = performance.now();
    const { data, error, count } = await closetQuery(user, {
      category: 'Shelter',
      sort: 'weight',
      dir: 'asc',
      page: '2',
    });
    const elapsedMs = performance.now() - start;

    expect(error).toBeNull();
    // The bug this catches: a missing .range() (returns every match, or the wrong
    // slice), a broken tiebreaker at this scale, or the weight filter/sort not
    // actually composing over 500 rows the way section 2 already proved they do at
    // fixture scale.
    expect(names(data)).toEqual(expectedPage2);
    // The list page's own pager text ("Showing X-Y of Z", total page count) is
    // computed straight from this count — a wrong number here is a wrong pager, not
    // merely a display nit.
    expect(count).toBe(100);

    // A GENEROUS ceiling, not a performance SLO — this is "not pathological", not a
    // promise about milliseconds. A single scoped, sorted, range-limited query over
    // 500 rows should take low tens of milliseconds on this local stack; 3000ms
    // leaves enormous headroom for a slow or loaded CI machine while still catching
    // the class of regression this test exists for — an accidental full-table scan,
    // a per-row N+1, or a missing .range() that fetches and paginates 500 rows in
    // application memory instead of asking Postgres to.
    expect(elapsedMs).toBeLessThan(3000);
    console.log(
      `[gear-closet] 500-item filtered/sorted/paginated query: ${elapsedMs.toFixed(1)}ms`,
    );
  });
});
