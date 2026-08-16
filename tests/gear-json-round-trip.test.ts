import { describe, it, expect, beforeAll } from 'vitest';
import { createUser, type TestUser } from './support/local-database';
import type { TablesInsert } from '../src/lib/database.types';
import {
  GEAR_EXPORT_SELECT,
  buildGearItemsDocument,
  serialiseGearItemsDocument,
  type GearExportRow,
} from '../src/lib/gear/json-schema';
import { importableGearItems, parseGearItemsFile } from '../src/lib/gear/json-import';
import { importGearItems } from '../src/lib/gear/mutations';
import { loadGearItemsForExport } from '../src/lib/gear/query';
import { MAX_IMPORT_ITEMS } from '../src/lib/gear/json-import';

/**
 * PK-65's central acceptance criterion, against a real database rather than in memory:
 * export a closet, import the file, and get the same values back.
 *
 * Written through PostgREST as the owner, because that is how the application does it and
 * because a round trip that only holds for a superuser is not a round trip — the same
 * argument tests/core-schema.test.ts makes for itself. Every insert here goes through
 * `gear_items_insert_own`, every read through the two unioned SELECT policies, and
 * `weight_grams` is computed by Postgres rather than by this file.
 *
 * WHAT "IDENTICAL" MEANS HERE, and it is narrower than PK-65's text. Values round-trip:
 * name, brand, category, description, notes, quantity, weight AS A MASS, price, currency,
 * acquired_on, status, url. The visitor's UNIT does not — an item entered in ounces comes
 * back in grams — because this build's file format carries grams and no unit at all. See
 * `json-schema.ts`'s header for that decision and what it costs. The tests below assert
 * the mass, in grams, on both sides, which is the claim this build actually makes.
 */

let owner: TestUser;
let stranger: TestUser;

beforeAll(async () => {
  owner = await createUser('json-round-trip');
  stranger = await createUser('json-stranger');
});

/** Inserts rows as the owner and returns their ids, so a test can export exactly them.
 *  Typed against the generated `TablesInsert` rather than a loose record, so a column
 *  renamed in a migration fails this file at build time instead of at runtime. */
async function seed(
  user: TestUser,
  rows: readonly TablesInsert<'gear_items'>[],
): Promise<readonly string[]> {
  // Copied rather than passed through: postgrest-js types `insert` as taking a MUTABLE
  // array, and this helper takes a readonly one so callers can hand it a literal.
  const { data, error } = await user.client
    .from('gear_items')
    .insert([...rows])
    .select('id');
  expect(error).toBeNull();
  return (data ?? []).map((row) => row.id);
}

/** The export half: read the rows, build the document, serialise it. Exactly what
 *  `src/pages/gear/index.astro`'s export branch does, minus the Response. */
async function exportToText(user: TestUser, ids: readonly string[]): Promise<string> {
  const { items, error } = await loadGearItemsForExport(user.client, user.id, ids);
  expect(error).toBeNull();
  return serialiseGearItemsDocument(
    buildGearItemsDocument(items as GearExportRow[], new Date('2026-08-16T00:00:00.000Z')),
  );
}

describe('export → import → identical values', () => {
  it('brings back every field a fully-populated item carries', async () => {
    const ids = await seed(owner, [
      {
        name: 'Nemo Hornet 2P',
        brand: 'Nemo',
        category: 'Shelter',
        description: 'Two-person tent',
        notes: 'Fly pitches first',
        quantity: 2,
        weight: 907,
        weight_unit: 'g',
        price: 429.99,
        currency: 'GBP',
        acquired_on: '2024-05-01',
        status: 'owned',
        url: 'https://example.com/hornet',
      },
    ]);

    const text = await exportToText(owner, ids);
    const items = importableGearItems(parseGearItemsFile(text));
    expect(items).not.toBeNull();

    // Imported into a DIFFERENT account, which is the strongest form of the claim: it
    // proves the file carries no row identity at all. A file that smuggled an id or a
    // user_id would either collide or be refused here.
    const { error, count } = await importGearItems(stranger.client, stranger.id, items ?? []);
    expect(error).toBeNull();
    expect(count).toBe(1);

    const { data } = await stranger.client
      .from('gear_items')
      .select(GEAR_EXPORT_SELECT)
      .eq('user_id', stranger.id)
      .eq('name', 'Nemo Hornet 2P')
      .single();

    expect(data).toMatchObject({
      name: 'Nemo Hornet 2P',
      brand: 'Nemo',
      category: 'Shelter',
      description: 'Two-person tent',
      notes: 'Fly pitches first',
      quantity: 2,
      price: 429.99,
      currency: 'GBP',
      acquired_on: '2024-05-01',
      status: 'owned',
      url: 'https://example.com/hornet',
    });
    expect(Number(data?.weight_grams)).toBe(907);
  });

  it('preserves a mass entered in ounces, as grams', async () => {
    // 2.3 oz is 65.2039031875 g exactly. The export rounds to the three decimals
    // gear_items.weight can hold, and the re-import stores that number as grams — so the
    // mass survives to within the column's own precision while the UNIT does not.
    const ids = await seed(owner, [
      { name: 'Katadyn BeFree', weight: 2.3, weight_unit: 'oz', status: 'owned' },
    ]);

    const text = await exportToText(owner, ids);
    expect(text).toContain('"weight_grams": 65.204');

    const items = importableGearItems(parseGearItemsFile(text));
    const { error } = await importGearItems(stranger.client, stranger.id, items ?? []);
    expect(error).toBeNull();

    const { data } = await stranger.client
      .from('gear_items')
      .select('weight, weight_unit, weight_grams')
      .eq('user_id', stranger.id)
      .eq('name', 'Katadyn BeFree')
      .single();

    expect(Number(data?.weight)).toBe(65.204);
    expect(data?.weight_unit).toBe('g');
    expect(Number(data?.weight_grams)).toBe(65.204);
  });

  it('settles: exporting the re-imported items reproduces the same items', async () => {
    // The property that makes the round trip a round trip rather than a slow drift. If
    // the export did not round to the column's scale, this is the assertion that would
    // fail on the second pass.
    const ids = await seed(owner, [
      { name: 'Settling tent', weight: 4.4, weight_unit: 'oz', status: 'owned' },
      { name: 'Settling stove', weight: 1.5, weight_unit: 'lb', status: 'wishlist' },
    ]);

    const first = await exportToText(owner, ids);
    const items = importableGearItems(parseGearItemsFile(first));
    const { error } = await importGearItems(stranger.client, stranger.id, items ?? []);
    expect(error).toBeNull();

    const { data } = await stranger.client
      .from('gear_items')
      .select('id')
      .eq('user_id', stranger.id)
      .in('name', ['Settling tent', 'Settling stove']);
    const reImportedIds = (data ?? []).map((row) => row.id);
    expect(reImportedIds).toHaveLength(2);

    const second = await exportToText(stranger, reImportedIds);
    expect(JSON.parse(second).data.items).toEqual(JSON.parse(first).data.items);
  });

  it('brings back an item that is nothing but a name', async () => {
    const ids = await seed(owner, [{ name: 'Just a name' }]);
    const text = await exportToText(owner, ids);
    const items = importableGearItems(parseGearItemsFile(text));
    expect(items).not.toBeNull();

    const { error, count } = await importGearItems(stranger.client, stranger.id, items ?? []);
    expect(error).toBeNull();
    expect(count).toBe(1);
  });
});

describe('the file carries no identity', () => {
  it('writes no id, user_id, slug or photo_path', async () => {
    const ids = await seed(owner, [{ name: 'Identity check', status: 'owned' }]);
    const text = await exportToText(owner, ids);
    for (const forbidden of ['"id"', '"user_id"', '"slug"', '"photo_path"', ids[0]]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it('gives the imported row a new id owned by the importer', async () => {
    const ids = await seed(owner, [{ name: 'New identity', status: 'owned' }]);
    const items = importableGearItems(parseGearItemsFile(await exportToText(owner, ids)));
    await importGearItems(stranger.client, stranger.id, items ?? []);

    const { data } = await stranger.client
      .from('gear_items')
      .select('id, user_id')
      .eq('user_id', stranger.id)
      .eq('name', 'New identity')
      .single();

    expect(data?.user_id).toBe(stranger.id);
    expect(data?.id).not.toBe(ids[0]);
  });
});

describe('the export read is owner-scoped', () => {
  it('returns nothing for another visitor’s ids', async () => {
    // Without the explicit .eq('user_id', …), gear_items_select_via_public_pack — which
    // is granted to `authenticated` and unioned with the owner policy — would make this a
    // working data-exfiltration endpoint for every item on every public pack, delivered
    // as a tidy JSON document. See loadGearItemsForExport's own comment.
    const ids = await seed(owner, [{ name: 'Not yours', status: 'owned' }]);
    const { items, error } = await loadGearItemsForExport(stranger.client, stranger.id, ids);
    expect(error).toBeNull();
    expect(items).toEqual([]);
  });

  it('returns nothing for an empty selection without issuing a query', async () => {
    const { items, error } = await loadGearItemsForExport(owner.client, owner.id, []);
    expect(error).toBeNull();
    expect(items).toEqual([]);
  });
});

describe('the import write', () => {
  it('is transactional — one bad row writes none of them', async () => {
    // The whole "no partial imports" promise, exercised against the database rather than
    // asserted about the parser. A single multi-row INSERT is one statement, so a
    // constraint violation anywhere in it rolls the whole statement back.
    //
    // The bad row is built by hand rather than parsed, because parseGearItemsFile would
    // refuse it long before a query — which is the point: this asserts the SECOND line of
    // defence, the one that holds if a future caller skips the first.
    const good = { name: 'Transaction A', quantity: 1, weight: 1, weight_unit: 'g' };
    const bad = { name: 'Transaction B', quantity: 1, weight: 1, weight_unit: 'g', price: 10 };

    const { error } = await stranger.client
      .from('gear_items')
      .insert([good, bad].map((values) => ({ ...values, user_id: stranger.id })))
      .select('id');
    // `price` without `currency` violates gear_items_price_has_currency.
    expect(error).not.toBeNull();

    const { data } = await stranger.client
      .from('gear_items')
      .select('id')
      .eq('user_id', stranger.id)
      .in('name', ['Transaction A', 'Transaction B']);
    expect(data).toEqual([]);
  });

  it('reports the number of rows it actually wrote', async () => {
    const items = importableGearItems(
      parseGearItemsFile(
        JSON.stringify([
          { name: 'Counted one', weight_grams: 1 },
          { name: 'Counted two', weight_grams: 2 },
          { name: 'Counted three', weight_grams: 3 },
        ]),
      ),
    );
    const { error, count } = await importGearItems(stranger.client, stranger.id, items ?? []);
    expect(error).toBeNull();
    expect(count).toBe(3);
  });

  it('is a no-op for an empty list rather than an error', async () => {
    const { error, count } = await importGearItems(stranger.client, stranger.id, []);
    expect(error).toBeNull();
    expect(count).toBe(0);
  });

  it('refuses more items than the cap, at the write rather than only at the parser', async () => {
    // MAX_IMPORT_ITEMS living only in parseGearItemsFile would be a bound that holds
    // because one caller applies it — the same defect deleteGearItems' comment records.
    const many = Array.from({ length: MAX_IMPORT_ITEMS + 1 }, (_, index) => ({
      name: `Over cap ${index}`,
      quantity: 1,
      weight: 0,
      weight_unit: 'g' as const,
      price: null,
      currency: null,
      acquired_on: null,
      status: 'owned' as const,
      url: null,
      brand: null,
      category: null,
      description: null,
      notes: null,
    }));
    await expect(importGearItems(stranger.client, stranger.id, many)).rejects.toThrow(RangeError);
  });

  it('creates closet items with no dedup, as the ticket decided', async () => {
    // Importing the same file twice produces two items, deliberately. PK-33 commits the
    // CSV path to dedup; JSON import behaves differently on purpose, and whoever builds
    // both should not "unify" them without revisiting that decision.
    const text = JSON.stringify([{ name: 'Deliberate duplicate', weight_grams: 10 }]);
    const items = importableGearItems(parseGearItemsFile(text));
    await importGearItems(stranger.client, stranger.id, items ?? []);
    await importGearItems(stranger.client, stranger.id, items ?? []);

    const { data } = await stranger.client
      .from('gear_items')
      .select('id')
      .eq('user_id', stranger.id)
      .eq('name', 'Deliberate duplicate');
    expect(data).toHaveLength(2);
  });
});

describe('scale', () => {
  it('imports a 200-item file in one statement', async () => {
    // PK-65's own acceptance names 200 items as the size that must not time out.
    const bulkOwner = await createUser('json-bulk');
    const text = JSON.stringify(
      Array.from({ length: 200 }, (_, index) => ({
        name: `Bulk item ${index}`,
        category: 'Bulk',
        quantity: 1,
        weight_grams: index,
        status: 'owned',
      })),
    );
    const items = importableGearItems(parseGearItemsFile(text));
    expect(items).toHaveLength(200);

    const { error, count } = await importGearItems(bulkOwner.client, bulkOwner.id, items ?? []);
    expect(error).toBeNull();
    expect(count).toBe(200);

    const { data } = await bulkOwner.client
      .from('gear_items')
      .select('id')
      .eq('user_id', bulkOwner.id);
    expect(data).toHaveLength(200);
  });
});
