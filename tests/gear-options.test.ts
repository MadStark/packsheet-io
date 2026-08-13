import { describe, expect, it } from 'vitest';
import { extractGearOptions, type GearOptionRow } from '../src/lib/gear/options';

/**
 * `src/lib/gear/options.ts` shapes the closet list's "category / brand" filter
 * options query into de-duplicated, sorted lists — see that module's own comment for
 * why the shaping and not the query itself is what lives behind a test.
 */

const row = (category: string | null, brand: string | null): GearOptionRow => ({
  category,
  brand,
});

describe('extractGearOptions', () => {
  it('returns empty lists for no rows', () => {
    expect(extractGearOptions([])).toEqual({ categories: [], brands: [] });
  });

  it('de-duplicates repeated values', () => {
    const result = extractGearOptions([
      row('Shelter', 'Big Agnes'),
      row('Shelter', 'MSR'),
      row('Shelter', 'Big Agnes'),
    ]);
    expect(result.categories).toEqual(['Shelter']);
    expect(result.brands).toEqual(['Big Agnes', 'MSR']);
  });

  it('drops null values rather than rendering an unlabelled option', () => {
    const result = extractGearOptions([row(null, null), row('Sleep', null), row(null, 'MSR')]);
    expect(result.categories).toEqual(['Sleep']);
    expect(result.brands).toEqual(['MSR']);
  });

  it('drops empty-string and whitespace-only values the same way as null', () => {
    const result = extractGearOptions([row('', 'MSR'), row('   ', 'MSR'), row('Sleep', '')]);
    expect(result.categories).toEqual(['Sleep']);
    expect(result.brands).toEqual(['MSR']);
  });

  it('trims surrounding whitespace before comparing and returning a value', () => {
    const result = extractGearOptions([row('  Sleep  ', null), row('Sleep', null)]);
    expect(result.categories).toEqual(['Sleep']);
  });

  it('preserves case rather than folding two differently-cased values together', () => {
    const result = extractGearOptions([row('Tent', null), row('tent', null)]);
    expect(result.categories).toEqual(['Tent', 'tent'].sort((a, b) => a.localeCompare(b)));
    expect(result.categories).toHaveLength(2);
  });

  it('sorts the result alphabetically regardless of input order', () => {
    const result = extractGearOptions([
      row('Water', null),
      row('Cooking', null),
      row('Sleep', null),
    ]);
    expect(result.categories).toEqual(['Cooking', 'Sleep', 'Water']);
  });

  it('categories and brands are independent — a value in one column does not leak into the other', () => {
    const result = extractGearOptions([row('Shelter', null), row(null, 'Shelter')]);
    expect(result.categories).toEqual(['Shelter']);
    expect(result.brands).toEqual(['Shelter']);
  });
});
