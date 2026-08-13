import { describe, expect, it, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createUser, type TestUser } from './support/local-database';
import { createPack } from './support/fixtures';
import {
  GEAR_SELECT,
  applyGearQuery,
  loadGearCloset,
  loadGearItem,
  parseGearQuery,
} from '../src/lib/gear/query';
import {
  GEAR_PAGE_SIZE,
  GEAR_SORT_COLUMNS,
  GEAR_STATUSES,
  type GearSortKey,
  type GearStatus,
} from '../src/lib/gear/fields';
import { bulkSetCategory, bulkSetStatus, deleteGearItems } from '../src/lib/gear/mutations';
import type { WeightUnit } from '../src/lib/units';
import type { Database } from '../src/lib/database.types';

type GearInsert = Database['public']['Tables']['gear_items']['Insert'];

/**
 * The integration tests behind the gear closet's acceptance criteria: "500 items remain
 * responsive; filters compose correctly; deleting an item deletes it." Every other gear
 * closet test file is a unit test for one layer in isolation — `gear-query.test.ts`
 * for the pure URL <-> `GearQuery` translation, `gear-bulk.test.ts` for bulk-action
 * validation, `gear-search-escaping.test.ts` for the two-layer search escaping,
 * `gear-closet-schema.test.ts` for the closet's own columns and its write boundary. This
 * file is the one that proves those layers actually compose correctly against a REAL
 * database, through PostgREST, as a real authenticated user — the same path
 * `src/pages/gear/index.astro` and `src/pages/gear/[id].astro` take.
 *
 * WHAT CHANGED IN THE PK-4 INDEPENDENT REVIEW (C3). This file used to assert against
 * `closetQuery()`, a hand-written COPY of the page's query living only in this test
 * file — so `applyGearQuery` and an inline `.eq('user_id', ...)` were pinned, but the
 * page's OWN query (`vitest.config.ts` excludes `src/pages/`) and every one of its write
 * statements were not. Mutation testing on the page proved it: deleting the owner
 * filter, or mutating the delete statement itself, left the full suite green — not
 * because the assertions were weak but because nothing in the suite could execute those
 * statements at all (see `src/lib/gear/mutations.ts`'s own module comment). The fix
 * moved the owner-scoped queries and every write into `src/lib/gear/`
 * (`loadGearCloset`/`loadGearItem` in `query.ts`, `loadGearOptions` in `options.ts`,
 * every mutation in `mutations.ts`) so the pages and this file call the SAME functions.
 * `closetQuery` below is a thin adapter over `loadGearCloset` — not a reimplementation
 * of it — so a bug in the shared function is a bug this file sees too.
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
// Helpers: thin adapters over the real functions, not copies of what they do.
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
 * THE REAL CLOSET QUERY — a direct call to `loadGearCloset` (`src/lib/gear/query.ts`),
 * the exact function `src/pages/gear/index.astro` calls. All this adapter does is turn
 * the test's ergonomic `{ q: '...', category: '...' }` shape into the `GearQuery`
 * `loadGearCloset` actually takes, via `parseGearQuery` — the same translation the page
 * itself performs from `Astro.url.searchParams`. There is no query-building logic of
 * this file's own left to drift from the page.
 */
function closetQuery(user: TestUser, entries: Record<string, string | string[]> = {}) {
  return loadGearCloset(user.client, user.id, parseGearQuery(toSearchParams(entries)));
}

/**
 * THE BROKEN CLOSET QUERY — everything `closetQuery`/`loadGearCloset` does, built by
 * hand from the same exported building blocks (`applyGearQuery`, `GEAR_SELECT`) MINUS
 * the one line that matters: no `.eq('user_id', user.id)`. This is what a closet query
 * would look like if `loadGearCloset` never added that filter, or someone "simplified"
 * it away. It exists ONLY so the leak test below can demonstrate the leak actually
 * happens absent that filter, rather than merely asserting the real function looks
 * correct in isolation.
 */
function leakyClosetQuery(user: TestUser, entries: Record<string, string | string[]> = {}) {
  const query = parseGearQuery(toSearchParams(entries));
  return applyGearQuery(user.client.from('gear_items').select(GEAR_SELECT), query);
}

function names(rows: readonly { name: string }[] | null | undefined): string[] {
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
// `.eq('user_id', user.id)` on every closet read, which `loadGearCloset` and the real
// `src/pages/gear/index.astro` (which now just calls it) both carry.
//
// WHY THIS TEST ASSERTS BOTH HALVES, NOT JUST "A DOES NOT SEE B'S ITEM". Asserting
// only the safe half would still pass if `applyGearQuery` or RLS had been changed in
// some unrelated way that happened to also hide the item — it would prove nothing
// about WHICH line of code is doing the work. Asserting only the leaky half would
// prove the vulnerability exists but not that the shipped fix closes it. Asserting
// both — the exact same query, once through `loadGearCloset` (owner filter included)
// and once through the hand-built `leakyClosetQuery` (owner filter removed), one
// returning nothing and the other returning the item — is what pins the fix to the
// one line responsible for it. Delete `.eq('user_id', userId)` from `loadGearCloset`
// itself — the function `src/pages/gear/index.astro` actually calls, not a stand-in —
// and this test fails; that is the entire reason it exists, and why it belongs in
// this file rather than being read as redundant with the RLS suite:
// `tests/rls-owner.test.ts` proves the POLICY layer behaves as designed
// (`gear_items_select_via_public_pack` does what its own comment says); this test
// proves the APPLICATION layer does not lean on that policy alone for a function whose
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

  it('loadGearCloset excludes it; the same query with the owner filter removed includes it', async () => {
    // Scoped by search to the one distinctive row, so this assertion is not at the
    // mercy of pagination or of how much other public-pack fixture data this shared
    // database already holds by the time this file runs.
    const safe = await closetQuery(attacker, { q: leakedBrand });
    expect(safe.error).toBeNull();
    // The bug this catches: "your gear closet" silently showing a stranger's item
    // the moment that stranger publishes a pack.
    expect(safe.items.map((row) => row.id)).toEqual([]);

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
    const { items, error } = await closetQuery(filterUser, entries);
    expect(error).toBeNull();
    return names(items);
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
// asterisks, non-ASCII) are already covered exhaustively by
// tests/gear-search-escaping.test.ts against buildSearchFilter directly — not
// duplicated here. This section only confirms the higher-level behaviour: name-or
// -brand, case-insensitive, mid-word.
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
    const { items, error } = await closetQuery(filterUser, { q });
    expect(error).toBeNull();
    return names(items);
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

    // `added` sorts by `acquired_on` (PK-61), not `created_at` — see GEAR_SORT_COLUMNS
    // in src/lib/gear/fields.ts. Each row below is given an explicit, distinct
    // `acquired_on` for the same reason the old version of this fixture inserted rows
    // one at a time to force `created_at` apart: without a real spread on the column
    // this sort actually orders by, the expected order would be ambiguous. The
    // difference that matters is WHY a client can supply this at all — `created_at` is
    // stamped unconditionally by the `set_row_timestamps()` BEFORE INSERT trigger
    // (core_schema.sql) and no client write to it is ever honoured (see
    // tests/core-schema.test.ts, "ignores created_at and updated_at sent by the client
    // on INSERT" — the same trigger function is attached to gear_items too), but
    // `acquired_on` carries no such trigger, so what is entered here is exactly what
    // gets stored and exactly what the sort reads back. That is the entire point of
    // PK-61: "when I got this" is the visitor's own claim, not a fact the database
    // derives, so unlike `created_at` a client CAN and does set it directly.
    const rows: GearInsert[] = [
      {
        name: 'Featherweight Quilt',
        weight: 300,
        weight_unit: 'g',
        price: 200,
        currency: 'USD',
        acquired_on: '2026-01-01',
      },
      {
        name: 'Basecamp Grill',
        weight: 500,
        weight_unit: 'g',
        price: 50,
        currency: 'USD',
        acquired_on: '2026-02-01',
      },
      {
        name: 'Overnight Pack',
        weight: 2,
        weight_unit: 'lb', // ≈ 907 g — heavier than either of the two above in grams
        price: 120,
        currency: 'USD',
        acquired_on: '2026-03-01',
      },
    ];
    const { error } = await sortUser.client.from('gear_items').insert(rows);
    if (error) {
      throw new Error(`Fixture failed to insert sort items: ${error.message}`, { cause: error });
    }
  });

  async function sortedNames(sort: GearSortKey, direction: 'asc' | 'desc'): Promise<string[]> {
    const { items, error } = await closetQuery(sortUser, { sort, dir: direction });
    expect(error).toBeNull();
    return names(items);
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

  // C1 (PK-61 review): `nullsFirst: false` in applyGearQuery is passed for
  // GEAR_SORT_COLUMNS[query.sort] regardless of which key that is — so this same
  // PK-61 change also moved where an unpriced row lands on `price desc`, not only
  // where an undated row lands on `added`. The fixture above never covers this: every
  // one of its three rows carries a real price, so nothing in "sorts by price, both
  // directions" exercises a null at all. A separate user (rather than a fourth row on
  // sortUser) keeps this independent of that fixture's own three prices, the same
  // isolation the "no acquired_on" test below uses for the identical reason.
  it('an item with no price sorts LAST in both directions, not merely last in one', async () => {
    const unpricedUser = await createUser('gear-closet-sort-unpriced');
    const rows: GearInsert[] = [
      { name: 'Cheap Item', price: 10, currency: 'USD' },
      { name: 'Pricey Item', price: 500, currency: 'USD' },
      { name: 'No-Price Item' }, // price/currency omitted entirely — stay null
    ];
    const { error } = await unpricedUser.client.from('gear_items').insert(rows);
    expect(error).toBeNull();

    const { items: asc, error: ascError } = await closetQuery(unpricedUser, {
      sort: 'price',
      dir: 'asc',
    });
    expect(ascError).toBeNull();
    expect(names(asc)).toEqual(['Cheap Item', 'Pricey Item', 'No-Price Item']);

    // Postgres's own unpinned default for DESC is NULLS FIRST, which would put
    // 'No-Price Item' at index 0 here if applyGearQuery's nullsFirst: false did not
    // apply to every sort column, price included.
    const { items: desc, error: descError } = await closetQuery(unpricedUser, {
      sort: 'price',
      dir: 'desc',
    });
    expect(descError).toBeNull();
    expect(names(desc)).toEqual(['Pricey Item', 'Cheap Item', 'No-Price Item']);
  });

  // Asserted DIRECTLY, not merely implied by the ordering test below, and this is not
  // belt-and-braces. The three fixture rows go in as a single bulk insert, so they share
  // one `created_at` exactly — `now()` is `transaction_timestamp()`, constant for the
  // whole transaction. If somebody reverted GEAR_SORT_COLUMNS.added to `'created_at'`,
  // every row would tie on the sort column and the ordering would fall through to the
  // `id` tiebreaker, i.e. to random UUIDs — so the test below would fail only by luck,
  // and pass outright often enough to look flaky rather than broken. Mutation-testing
  // confirmed exactly that: reverting the mapping failed 2 or 3 of the ordering
  // assertions depending on the run. This line turns a probabilistic detector into a
  // deterministic one, and is the only direct test of the mapping in src/lib/gear/fields.ts.
  it('maps the "added" sort key to acquired_on, not to created_at', () => {
    expect(GEAR_SORT_COLUMNS.added).toBe('acquired_on');
  });

  it('sorts by date added, both directions', async () => {
    // Featherweight Quilt 2026-01-01, Basecamp Grill 2026-02-01, Overnight Pack
    // 2026-03-01 — the explicit acquired_on values the fixture above sets, exactly the
    // dates a visitor typed rather than an insertion-order proxy for them.
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

  // nullsFirst: false (applyGearQuery, query.ts) is what this test exists to pin.
  // Postgres's own default null ordering is NOT symmetric: NULLS LAST for ascending,
  // but NULLS FIRST for descending — so an unpinned "added desc" would put every
  // undated item at the very TOP of the closet, the least informative rows crowding out
  // the most relevant ones on exactly the sort a visitor reaches for to see what they
  // logged most recently. A separate user (rather than a fourth row on sortUser above)
  // keeps this test's expectations independent of the three-row fixture's own dates.
  it('an item with no acquired_on sorts LAST in both directions, not merely last in one', async () => {
    const undatedUser = await createUser('gear-closet-sort-undated');
    const rows: GearInsert[] = [
      { name: 'Dated Early', acquired_on: '2026-01-01' },
      { name: 'Dated Late', acquired_on: '2026-06-01' },
      { name: 'Undated Item' }, // acquired_on omitted entirely — stays null
    ];
    const { error } = await undatedUser.client.from('gear_items').insert(rows);
    expect(error).toBeNull();

    const { items: asc, error: ascError } = await closetQuery(undatedUser, {
      sort: 'added',
      dir: 'asc',
    });
    expect(ascError).toBeNull();
    expect(names(asc)).toEqual(['Dated Early', 'Dated Late', 'Undated Item']);

    // The case Postgres's own default would get backwards: DESC with no explicit
    // nullsFirst puts NULLs first, which would put 'Undated Item' at index 0 here.
    const { items: desc, error: descError } = await closetQuery(undatedUser, {
      sort: 'added',
      dir: 'desc',
    });
    expect(descError).toBeNull();
    expect(names(desc)).toEqual(['Dated Late', 'Dated Early', 'Undated Item']);
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

  // Run over BOTH sort keys, not just weight. The 120 fixture rows above tie on weight
  // (all 100 g) AND on acquired_on (none of them set it, so every one is NULL), which
  // makes them a total tie on either column — the worst case for a sort with no stable
  // tiebreaker, twice over.
  //
  // `added` is the case PK-61 made newly urgent, and it exercises something `weight`
  // cannot: 120 rows whose sort value is NULL, ordered under `nullsFirst: false`, sliced
  // across three `.range()` calls. Postgres has no obligation to return a consistent
  // relative order within a block of nulls any more than within a block of equal
  // weights, so the null pinning and the `id` tiebreaker have to hold TOGETHER across
  // page boundaries or a row silently duplicates onto two pages or falls between them.
  // Nothing covered that combination before.
  it.each<GearSortKey>(['weight', 'added'])(
    `the union of every page equals the full set exactly, for ${TIE_COUNT} items all tied on %s`,
    async (sort) => {
      const pageCount = Math.ceil(TIE_COUNT / GEAR_PAGE_SIZE);
      const seen = new Map<string, number>();

      for (let page = 1; page <= pageCount; page++) {
        const { items, error } = await closetQuery(paginationUser, {
          sort,
          page: String(page),
        });
        expect(error).toBeNull();
        for (const row of items) {
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
    },
  );
});

// ---------------------------------------------------------------------------
// 5b. C2 (PK-4 review) — an over-range page clamps to the last real page.
// ---------------------------------------------------------------------------
//
// PostgREST answers a `.range()` whose offset exceeds the row count with PGRST103
// (416, "Requested range not satisfiable"), and an offset exactly EQUAL to the count
// with a 206 and an empty array (I11). Both were previously treated as, or rendered
// as, "no items" — the first as a load failure that replaced the whole page with an
// error, the second as the "No items match these filters" empty state with no filters
// active. `loadGearCloset` clamps `page` to `max(1, ceil(count / GEAR_PAGE_SIZE))`
// BEFORE the ranged request ever runs, so neither case can reach PostgREST at all.
describe('C2 — loadGearCloset clamps an over-range page to the last real page instead of erroring', () => {
  let clampUser: TestUser;
  const ITEM_COUNT = GEAR_PAGE_SIZE; // exactly one full page — the I11 boundary case

  beforeAll(async () => {
    clampUser = await createUser('gear-closet-clamp');
    const rows = Array.from({ length: ITEM_COUNT }, (_, i) => ({
      name: `Clamp Item ${String(i).padStart(3, '0')}`,
      category: 'ClampFixture',
    }));
    const { error } = await clampUser.client.from('gear_items').insert(rows);
    if (error) {
      throw new Error(`Fixture failed to insert clamp items: ${error.message}`, { cause: error });
    }
  });

  it('page 1 of exactly one full page returns every row, unclamped', async () => {
    const result = await closetQuery(clampUser, { category: 'ClampFixture', page: '1' });
    expect(result.error).toBeNull();
    expect(result.page).toBe(1);
    expect(result.count).toBe(ITEM_COUNT);
    expect(result.items.length).toBe(ITEM_COUNT);
  });

  it('I11 — page 2 (offset exactly equal to the count) no longer returns an empty page; it clamps to page 1', async () => {
    // Before the clamp: offset = (2-1)*50 = 50, count = 50 — PostgREST's 206-with-
    // empty-array case, previously rendered as "No items match these filters" with
    // zero filters actually excluding anything. After the clamp: page is reported as
    // 1, and the full set of 50 rows comes back, not an empty page.
    const result = await closetQuery(clampUser, { category: 'ClampFixture', page: '2' });
    expect(result.error).toBeNull();
    expect(result.page).toBe(1);
    expect(result.count).toBe(ITEM_COUNT);
    expect(result.items.length).toBe(ITEM_COUNT);
  });

  it('C2 — a wildly over-range page (PGRST103 territory) also clamps to page 1, not an error', async () => {
    const result = await closetQuery(clampUser, { category: 'ClampFixture', page: '999' });
    expect(result.error).toBeNull();
    expect(result.page).toBe(1);
    expect(result.items.length).toBe(ITEM_COUNT);
  });

  it('an over-range page against a filter matching NOTHING clamps to page 1 with an empty (not errored) result', async () => {
    const result = await closetQuery(clampUser, { category: 'NoSuchCategoryAtAll', page: '5' });
    expect(result.error).toBeNull();
    expect(result.page).toBe(1);
    expect(result.count).toBe(0);
    expect(result.items).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5c. I2 (PK-4 review) — the weight boundary includes an exact match.
// ---------------------------------------------------------------------------
//
// `4.4 oz` stores `weight_grams = 124.73790175` exactly in Postgres numeric, but
// `toGrams(4.4, 'oz')` computes `124.73790175000002` in IEEE-754 double precision —
// so an unmodified `>=` comparison excludes the very row that IS "4.4 oz and
// heavier". `applyGearFilters` (query.ts) now widens both bounds by
// `WEIGHT_COMPARISON_TOLERANCE_GRAMS` (1e-6 g) to close this without letting in a
// row that is genuinely outside the requested range.
describe('I2 — a weight-range boundary entered in a non-gram unit includes an item stored at exactly that weight', () => {
  let weightUser: TestUser;

  beforeAll(async () => {
    weightUser = await createUser('gear-closet-weight-boundary');
    await weightUser.client.from('gear_items').insert([
      { name: 'Exactly 4.4oz Item', weight: 4.4, weight_unit: 'oz' },
      { name: 'Lighter 4.3oz Item', weight: 4.3, weight_unit: 'oz' },
      { name: 'Heavier 4.5oz Item', weight: 4.5, weight_unit: 'oz' },
    ]);
  });

  it('wmin=4.4oz includes the item entered as exactly 4.4oz, not only strictly heavier ones', async () => {
    const { items, error } = await closetQuery(weightUser, { wmin: '4.4', wunit: 'oz' });
    expect(error).toBeNull();
    // The bug this catches: toGrams(4.4, 'oz') rounds up in IEEE-754, so an
    // unwidened `>=` would silently drop "Exactly 4.4oz Item" from its own boundary.
    expect(names(items)).toEqual(['Exactly 4.4oz Item', 'Heavier 4.5oz Item']);
  });

  it('wmax=4.4oz includes the item entered as exactly 4.4oz, not only strictly lighter ones', async () => {
    const { items, error } = await closetQuery(weightUser, { wmax: '4.4', wunit: 'oz' });
    expect(error).toBeNull();
    expect(names(items)).toEqual(['Exactly 4.4oz Item', 'Lighter 4.3oz Item']);
  });

  it('the tolerance does not widen the range enough to pull in a genuinely different weight', async () => {
    // The negative control: a range tight enough to name only the exact item must
    // still exclude both neighbours, one full tenth of an ounce away — proving the
    // fix is a boundary-precision correction, not a loosened filter.
    const { items, error } = await closetQuery(weightUser, {
      wmin: '4.4',
      wmax: '4.4',
      wunit: 'oz',
    });
    expect(error).toBeNull();
    expect(names(items)).toEqual(['Exactly 4.4oz Item']);
  });
});

// ---------------------------------------------------------------------------
// 6. Deleting — through the real mutation function.
// ---------------------------------------------------------------------------

describe('deleting gear removes it from the database', () => {
  it('a deleted item is in no list, cannot be loaded by id, and is not in the table at all', async () => {
    const user = await createUser('gear-closet-delete');
    const created = await user.client
      .from('gear_items')
      .insert({ name: 'Doomed Item' })
      .select('id')
      .single();
    const itemId = created.data!.id as string;

    // Present first, so every assertion below is about the delete rather than about a
    // fixture that never inserted.
    const before = await closetQuery(user);
    expect(before.items.map((row) => row.id)).toContain(itemId);

    // The delete itself — deleteGearItems (src/lib/gear/mutations.ts), the EXACT
    // function both src/pages/gear/index.astro's bulk delete and
    // src/pages/gear/[id].astro's single-item delete call.
    const deleted = await deleteGearItems(user.client, user.id, [itemId]);
    expect(deleted.error).toBeNull();
    // I6 (PK-4 review): the affected count is read off the write's own result, not
    // assumed from the length of the id list passed in.
    expect(deleted.count).toBe(1);

    // 1. Gone from the closet list.
    const closet = await closetQuery(user);
    expect(closet.error).toBeNull();
    expect(closet.items.map((row) => row.id)).not.toContain(itemId);

    // 2. Gone from the detail page's own load. `loadGearCloset` and `loadGearItem` are
    // the only two reads the gear closet has — there is no second list a deleted item
    // could still be sitting in — so between them these two assertions are the whole of
    // "it is in no list".
    const { data: reloaded, error: reloadError } = await loadGearItem(user.client, user.id, itemId);
    expect(reloadError).toBeNull();
    expect(reloaded).toBeNull();

    // 3. And not merely invisible to those two queries: nothing with that id is left in
    // the table, asked with no filter at all but the id, as the owner who would be the
    // one person still allowed to see it. This is the assertion that separates a real
    // DELETE from a write that only HID the row behind a column some future query could
    // forget to filter on.
    const { data: raw, error: rawError } = await user.client
      .from('gear_items')
      .select('id')
      .eq('id', itemId);
    expect(rawError).toBeNull();
    expect(raw).toEqual([]);
  });

  it('deleting one selection leaves another selection’s rows exactly where they were', async () => {
    const user = await createUser('gear-closet-delete-batches');

    const inserted = await user.client
      .from('gear_items')
      .insert([{ name: 'Keep A' }, { name: 'Keep B' }, { name: 'Remove A' }, { name: 'Remove B' }])
      .select('id, name');
    expect(inserted.error).toBeNull();
    const byName = new Map((inserted.data ?? []).map((row) => [row.name, row.id as string]));
    const keepIds = [byName.get('Keep A')!, byName.get('Keep B')!];
    const removeIds = [byName.get('Remove A')!, byName.get('Remove B')!];

    const deleted = await deleteGearItems(user.client, user.id, removeIds);
    expect(deleted.error).toBeNull();
    expect(deleted.count).toBe(2);

    // A delete acts on the ids it was handed and on nothing else. The bug this catches
    // is an `.in('id', ids)` lost or widened: a statement scoped only by
    // `.eq('user_id', …)` would take the whole closet with it, and the count would not
    // give it away on its own — a test that checked only "the requested rows are gone"
    // passes just as happily against a delete that removed everything.
    const closet = await closetQuery(user);
    expect(closet.error).toBeNull();
    expect(names(closet.items).sort()).toEqual(['Keep A', 'Keep B']);
    expect(closet.items.map((row) => row.id).sort()).toEqual([...keepIds].sort());
  });

  it('deleteGearItems is owner-scoped: a stranger passing another visitor’s ids deletes nothing', async () => {
    const owner = await createUser('gear-closet-delete-owner');
    const stranger = await createUser('gear-closet-delete-stranger');

    const inserted = await owner.client
      .from('gear_items')
      .insert([{ name: 'Owner-only Item A' }, { name: 'Owner-only Item B' }])
      .select('id');
    expect(inserted.error).toBeNull();
    const itemIds = (inserted.data ?? []).map((row) => row.id as string);
    expect(itemIds).toHaveLength(2);

    // The stranger calls the real function with the OWNER's ids and their own user id —
    // exactly what a copied form post, or a crafted request carrying somebody else's
    // checkbox values, looks like from the server's side. Both RLS
    // (`gear_items_delete_own`, core_schema.sql) and the explicit `.eq('user_id', …)`
    // deleteGearItems adds refuse it independently.
    const strangerDelete = await deleteGearItems(stranger.client, stranger.id, itemIds);
    expect(strangerDelete.error).toBeNull();
    expect(strangerDelete.count).toBe(0);

    // The count is necessary and nowhere near sufficient: a DELETE that matched zero
    // rows and a DELETE the policy refused are byte-identical over PostgREST, and so
    // would be a delete that reported 0 while removing the rows anyway. The rows
    // themselves are the real assertion — read back as the owner, the only visitor who
    // can see them at all.
    const { data: survivors, error: readError } = await owner.client
      .from('gear_items')
      .select('name')
      .in('id', itemIds);
    expect(readError).toBeNull();
    expect(names(survivors).sort()).toEqual(['Owner-only Item A', 'Owner-only Item B']);

    // Proves the premise rather than assuming it: these ids ARE deletable, so the
    // refusal above was about WHO asked and not about ids naming nothing, a mistyped
    // fixture, or a broken client that would have reported 0 either way.
    const ownerDelete = await deleteGearItems(owner.client, owner.id, itemIds);
    expect(ownerDelete.error).toBeNull();
    expect(ownerDelete.count).toBe(2);
  });

  it('bulkSetCategory and bulkSetStatus report the actual affected count, not the requested one', async () => {
    const user = await createUser('gear-closet-mutation-counts');
    const other = await createUser('gear-closet-mutation-counts-other');

    const mine = await user.client
      .from('gear_items')
      .insert({ name: 'Recategorised Item', category: 'Old' })
      .select('id')
      .single();
    const myId = mine.data!.id as string;

    const theirs = await other.client
      .from('gear_items')
      .insert({ name: 'Someone else’s item', category: 'Theirs', status: 'owned' })
      .select('id')
      .single();
    const theirId = theirs.data!.id as string;

    const setCategory = await bulkSetCategory(user.client, user.id, [myId], 'New');
    expect(setCategory.error).toBeNull();
    expect(setCategory.count).toBe(1);

    const setStatus = await bulkSetStatus(user.client, user.id, [myId], 'retired');
    expect(setStatus.error).toBeNull();
    expect(setStatus.count).toBe(1);

    // THE GAP BETWEEN REQUESTED AND AFFECTED, built from ids these writes genuinely
    // cannot touch: one row of this visitor's own, one belonging to somebody else, and
    // one naming no row anywhere. Three requested, one affected. Reporting the length
    // of the id list instead — the I6 defect (PK-4 review) these counts exist to
    // prevent — would tell the visitor "3 items updated" about a write that changed
    // one, and the confirmation banner src/pages/gear/index.astro builds from that
    // number would be stating something untrue about their own closet.
    const missingId = randomUUID();
    const mixedCategory = await bulkSetCategory(
      user.client,
      user.id,
      [myId, theirId, missingId],
      'Mixed',
    );
    expect(mixedCategory.error).toBeNull();
    expect(mixedCategory.count).toBe(1);

    const mixedStatus = await bulkSetStatus(
      user.client,
      user.id,
      [myId, theirId, missingId],
      'wishlist',
    );
    expect(mixedStatus.error).toBeNull();
    expect(mixedStatus.count).toBe(1);

    // And the other visitor's row really is untouched — so each 1 above means "one row
    // changed", not "one of three writes happened to be counted while another landed on
    // somebody else's gear".
    const { data: theirRow } = await other.client
      .from('gear_items')
      .select('category, status')
      .eq('id', theirId)
      .single();
    expect(theirRow?.category).toBe('Theirs');
    expect(theirRow?.status).toBe('owned');
  });
});

// ---------------------------------------------------------------------------
// 7. Deleting freezes the packs the item sat on.
// ---------------------------------------------------------------------------
//
// THE ASSERTION THE WHOLE DESIGN RESTS ON. `gear_items_snapshot_before_delete`
// (core_schema.sql:437-439) fires BEFORE DELETE, once per row, freezing the row into
// every `pack_items` row still referencing it that has no snapshot yet; the composite
// foreign key then nulls those items' `gear_item_id` (core_schema.sql:310-311). That
// trigger is the entire reason a real delete is safe to offer as the ordinary gesture —
// without it, deleting a closet item would silently take the line out of every pack
// carrying it. Nothing stands between a confirmed delete and this trigger: the reveal
// -then-confirm step (`BULK_FORM_FIELD.confirm`, src/lib/gear/bulk.ts) is in front of
// the write, and there is nothing at all behind it — see
// supabase/migrations/20260813130000_gear_hard_delete.sql's second numbered reason,
// which names this as the price the ticket accepts deliberately.
describe('deleting an item freezes the pack it sat on rather than taking the line with it', () => {
  it('deleteGearItems fires gear_items_snapshot_before_delete: the pack_items row survives, gear_item_id becomes null, and the snapshot captures the item', async () => {
    const user = await createUser('gear-closet-freeze');
    const pack = await createPack(user, { visibility: 'private', itemCount: 1 });
    const gearItemId = pack.gearItemIds[0];
    const packItemId = pack.itemIds[0];

    // Through the real mutations.ts function, not a hand-written `.delete()` here: the
    // trigger fires for any DELETE, so a stand-in would prove the DATABASE freezes packs
    // while saying nothing about whether the function the two gear pages actually call
    // still issues a DELETE at all.
    const { error: deleteError, count } = await deleteGearItems(user.client, user.id, [gearItemId]);
    expect(deleteError).toBeNull();
    expect(count).toBe(1);

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
    const { items, error, count, page } = await closetQuery(user, {
      category: 'Shelter',
      sort: 'weight',
      dir: 'asc',
      page: '2',
    });
    const elapsedMs = performance.now() - start;

    expect(error).toBeNull();
    expect(page).toBe(2);
    // The bug this catches: a missing .range() (returns every match, or the wrong
    // slice), a broken tiebreaker at this scale, or the weight filter/sort not
    // actually composing over 500 rows the way section 2 already proved they do at
    // fixture scale.
    expect(names(items)).toEqual(expectedPage2);
    // The list page's own pager text ("Showing X-Y of Z", total page count) is
    // computed straight from this count — a wrong number here is a wrong pager, not
    // merely a display nit.
    expect(count).toBe(100);

    // A GENEROUS ceiling, not a performance SLO — this is "not pathological", not a
    // promise about milliseconds. loadGearCloset now issues TWO requests per render
    // (an unranged count, then the ranged page — see its own C2 comment for why),
    // so the ceiling is doubled from the single-request version's 3000ms to keep the
    // same headroom per request while accounting for the extra round trip. A single
    // scoped, sorted, range-limited query over 500 rows should take low tens of
    // milliseconds on this local stack; 6000ms leaves enormous headroom for a slow
    // or loaded CI machine while still catching the class of regression this test
    // exists for — an accidental full-table scan, a per-row N+1, or a missing
    // .range() that fetches and paginates 500 rows in application memory instead of
    // asking Postgres to.
    expect(elapsedMs).toBeLessThan(6000);
    console.log(
      `[gear-closet] 500-item filtered/sorted/paginated query: ${elapsedMs.toFixed(1)}ms`,
    );
  });
});
