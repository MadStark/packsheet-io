import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  gearImportIsClean,
  gearImportProblemCount,
  gearImportRows as rows,
  importableGearItems,
  parseGearItemsFile,
} from '../src/lib/gear/json-import';

/**
 * The example files in `samples/` are documentation, and documentation that has stopped
 * being true is worse than none — someone hands the importer the file we shipped, it is
 * refused, and the format looks broken rather than the example. These tests are what stop
 * that: every sample is run through the real parser, and each one asserts the thing it
 * exists to demonstrate.
 *
 * `samples/gear-items-broken.json` is the interesting one. It is deliberately invalid, and
 * asserting WHICH refusal each of its rows earns is the only way that file keeps working
 * as an example of the refusals rather than decaying into a file that fails for some new
 * reason nobody intended.
 */

const SAMPLES = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'samples');

function sample(name: string): string {
  return readFileSync(join(SAMPLES, name), 'utf8');
}

describe('the shipped examples import cleanly', () => {
  it('the versioned envelope — what export writes', () => {
    const report = parseGearItemsFile(sample('packsheet-gear-sample.json'));
    expect(report.fileError).toBeNull();
    expect(report.format).toBe('envelope');
    expect(gearImportIsClean(report)).toBe(true);
    expect(importableGearItems(report)).toHaveLength(6);
  });

  it('a bare array of items', () => {
    const report = parseGearItemsFile(sample('gear-items-array.json'));
    expect(report.format).toBe('array');
    expect(gearImportIsClean(report)).toBe(true);
    expect(importableGearItems(report)).toHaveLength(3);
  });

  it('a single bare item', () => {
    const report = parseGearItemsFile(sample('gear-item-single.json'));
    expect(report.format).toBe('object');
    expect(gearImportIsClean(report)).toBe(true);
    expect(importableGearItems(report)).toHaveLength(1);
  });

  it('JSONL, one item per line', () => {
    const report = parseGearItemsFile(sample('gear-items.jsonl'));
    expect(report.format).toBe('jsonl');
    expect(gearImportIsClean(report)).toBe(true);
    expect(importableGearItems(report)).toHaveLength(4);
  });

  it('carries a mixed-currency closet, which the schema allows and totals do not', () => {
    // src/lib/money.ts argues at length that cross-currency summing is impossible rather
    // than merely discouraged. The FILE is allowed to hold both; this pins that.
    const items = importableGearItems(parseGearItemsFile(sample('packsheet-gear-sample.json')));
    const currencies = new Set((items ?? []).map((item) => item.currency).filter(Boolean));
    expect(currencies).toContain('GBP');
    expect(currencies).toContain('USD');
  });

  it('covers all three statuses, so the example exercises the whole vocabulary', () => {
    const items = importableGearItems(parseGearItemsFile(sample('packsheet-gear-sample.json')));
    expect(new Set((items ?? []).map((item) => item.status))).toEqual(
      new Set(['owned', 'wishlist', 'retired']),
    );
  });
});

describe('the deliberately broken example earns the refusals it demonstrates', () => {
  const report = parseGearItemsFile(sample('gear-items-broken.json'));

  it('is refused whole, with the one good row unimportable', () => {
    expect(report.fileError).toBeNull();
    expect(gearImportIsClean(report)).toBe(false);
    expect(importableGearItems(report)).toBeNull();
  });

  it('accepts the first row and refuses the other seven', () => {
    expect(rows(report)).toHaveLength(8);
    expect(rows(report)[0]?.ok).toBe(true);
    expect(gearImportProblemCount(report)).toBe(7);
  });

  it('names the reason for each row, one demonstrated refusal at a time', () => {
    const reasons = rows(report).map((row) => (row.ok ? null : Object.keys(row.errors).sort()));
    expect(reasons[1]).toEqual(['currency']); // a price with no currency
    expect(reasons[2]).toEqual(['weight_grams']); // weight + weight_unit from the ticket text
    expect(reasons[3]).toEqual(['acquired_on']); // a date in the future
    expect(reasons[4]).toEqual(['item']); // "catagory"
    expect(reasons[5]).toEqual(['name']); // no name at all
    expect(reasons[6]).toEqual(['status']); // not one of the three
    // `weight_grams`, NOT `weight` — the shared validator raises this under the FORM's
    // field name and it is translated back to the file's. Row 3 above tells its reader
    // that `weight` is not a field of this format; a row blaming `weight` three lines
    // later would contradict it in the same table.
    expect(reasons[7]).toEqual(['weight_grams']);
  });

  it('reports every problem against a field name the format actually has', () => {
    const fields = new Set(rows(report).flatMap((row) => (row.ok ? [] : Object.keys(row.errors))));
    // `item` is this module's own key for a whole-row problem; everything else must be a
    // field a reader can find in their file.
    const known = new Set([
      'item',
      'name',
      'brand',
      'category',
      'description',
      'quantity',
      'weight_grams',
      'price',
      'currency',
      'acquired_on',
      'status',
      'url',
      'notes',
    ]);
    for (const field of fields) expect(known).toContain(field);
  });

  it('points the ticket-text mistake at the field to use instead', () => {
    const row = rows(report)[2];
    expect(row?.ok).toBe(false);
    if (row && !row.ok) expect(row.errors.weight_grams).toContain('weight_grams');
  });
});
