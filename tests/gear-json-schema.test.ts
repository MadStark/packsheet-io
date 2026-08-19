import { describe, it, expect } from 'vitest';
import {
  GEAR_EXPORT_SELECT,
  GEAR_ITEMS_KIND,
  PACKSHEET_SCHEMA_VERSION,
  buildGearItemsDocument,
  gearItemToJson,
  gearItemsFilename,
  serialiseGearItemsDocument,
  type GearExportRow,
} from '../src/lib/gear/json-schema';

/**
 * Writing a Packsheet gear file (PK-65) — the shape, the fields that are deliberately
 * absent, and the rounding that makes a round trip settle rather than drift.
 */

const ROW: GearExportRow = {
  name: 'Nemo Hornet 2P',
  brand: 'Nemo',
  category: 'Shelter',
  description: 'Two-person tent',
  quantity: 1,
  weight_grams: 907,
  price: 429.99,
  currency: 'GBP',
  acquired_on: '2024-05-01',
  status: 'owned',
  url: 'https://example.com/hornet',
  notes: 'Fly pitches first',
};

const EXPORTED_AT = new Date('2026-08-16T12:34:56.000Z');

describe('the envelope', () => {
  it('carries the version, the kind and the export time', () => {
    const document = buildGearItemsDocument([ROW], EXPORTED_AT);
    expect(document.packsheet).toBe(PACKSHEET_SCHEMA_VERSION);
    expect(document.kind).toBe(GEAR_ITEMS_KIND);
    expect(document.exported_at).toBe('2026-08-16T12:34:56.000Z');
  });

  it('always holds an array, even for one item', () => {
    // A format that degenerates to a bare object for a one-item selection is one every
    // consumer has to branch on, in the branch exercised by the rarest input.
    expect(buildGearItemsDocument([ROW], EXPORTED_AT).data.items).toHaveLength(1);
    expect(Array.isArray(buildGearItemsDocument([ROW], EXPORTED_AT).data.items)).toBe(true);
    expect(buildGearItemsDocument([], EXPORTED_AT).data.items).toEqual([]);
  });

  it('takes the export time as an argument rather than reading the clock', () => {
    // Purity is what lets this file assert on exact bytes at all, and it is what lets the
    // page thread ONE timestamp into both the document and the filename.
    //
    // ASSERTED AGAINST A FIXED PAST DATE, not by calling the function twice and comparing.
    // Two adjacent calls land in the same millisecond, so `a.toEqual(b)` would pass just as
    // happily if this function called `new Date()` internally — a test that cannot fail for
    // the reason it was written. Naming the expected string is what makes it fail.
    expect(buildGearItemsDocument([ROW], EXPORTED_AT).exported_at).toBe('2026-08-16T12:34:56.000Z');
    expect(buildGearItemsDocument([ROW], new Date('2001-01-01T00:00:00.000Z')).exported_at).toBe(
      '2001-01-01T00:00:00.000Z',
    );
  });
});

describe('the item', () => {
  it('writes every field the schema defines, nulls included', () => {
    const item = gearItemToJson({
      ...ROW,
      brand: null,
      category: null,
      description: null,
      price: null,
      currency: null,
      acquired_on: null,
      url: null,
      notes: null,
    });
    expect(Object.keys(item).sort()).toEqual(
      [
        'acquired_on',
        'brand',
        'category',
        'currency',
        'description',
        'name',
        'notes',
        'price',
        'quantity',
        'status',
        'url',
        'weight_grams',
      ].sort(),
    );
    expect(item.brand).toBeNull();
  });

  it('carries no database identifiers, no unit and no dropped column', () => {
    const item = gearItemToJson(ROW) as unknown as Record<string, unknown>;
    for (const absent of [
      'id',
      'user_id',
      'weight',
      'weight_unit',
      'volume_litres',
      'photo_path',
      'created_at',
      'updated_at',
    ]) {
      expect(item).not.toHaveProperty(absent);
    }
  });

  it('carries weight as grams and nothing else', () => {
    expect(gearItemToJson(ROW).weight_grams).toBe(907);
  });

  it('rounds grams to what gear_items.weight can hold exactly, so a re-export settles', () => {
    // 2.3 oz is 65.2039031875 g. Exporting the raw generated value would let Postgres
    // round it at the column on the way back in, and the second export would differ from
    // the first — see the module header's precision argument.
    expect(gearItemToJson({ ...ROW, weight_grams: 65.2039031875 }).weight_grams).toBe(65.204);
  });

  it('treats a missing weight as zero rather than propagating it', () => {
    // The generated type said `number | null` while `weight_grams` was a generated column
    // whose CASE could yield NULL; PK-67 made it the stored, NOT NULL column, so the type
    // is now plainly `number` and this input has to be cast to reach the branch at all.
    //
    // The branch is kept, and so is this test, for the reason `gearItemToJson`'s own
    // comment gives: the value arrives through PostgREST's JSON rather than out of the
    // table, and a serialisation change is enough to hand this function something that is
    // not a number. `0` is the column's own default, so it is the honest fallback.
    const missingWeight = { ...ROW, weight_grams: null } as unknown as typeof ROW;
    expect(gearItemToJson(missingWeight).weight_grams).toBe(0);
  });
});

describe('the bytes', () => {
  it('is indented, newline-terminated and re-readable', () => {
    const text = serialiseGearItemsDocument(buildGearItemsDocument([ROW], EXPORTED_AT));
    expect(text.endsWith('\n')).toBe(true);
    expect(text).toContain('\n  "packsheet": 1');
    expect(JSON.parse(text)).toEqual(buildGearItemsDocument([ROW], EXPORTED_AT));
  });

  it('is byte-identical for the same rows and the same timestamp', () => {
    const once = serialiseGearItemsDocument(buildGearItemsDocument([ROW], EXPORTED_AT));
    const twice = serialiseGearItemsDocument(buildGearItemsDocument([ROW], EXPORTED_AT));
    expect(once).toBe(twice);
  });
});

describe('the filename', () => {
  it('is dated in UTC, so it does not depend on where the request was served', () => {
    expect(gearItemsFilename(new Date('2026-08-16T23:30:00.000Z'))).toBe(
      'packsheet-gear-2026-08-16.json',
    );
  });

  it('carries no quote or path character that could break the Content-Disposition header', () => {
    const name = gearItemsFilename(EXPORTED_AT);
    expect(name).toMatch(/^[a-z0-9-]+\.json$/);
  });
});

describe('the select list', () => {
  it('names exactly the columns GearExportRow declares', () => {
    // The two are written separately and nothing but this keeps them in step: a column
    // added to the type and not to the select arrives as undefined in every file.
    const selected = GEAR_EXPORT_SELECT.split(',').map((column) => column.trim());
    expect(selected.sort()).toEqual(Object.keys(ROW).sort());
  });
});
