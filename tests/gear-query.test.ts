import { describe, expect, it } from 'vitest';
import {
  gearQueryToSearchParams,
  parseGearQuery,
  MAX_GEAR_PAGE,
  type GearQuery,
} from '../src/lib/gear/query';
import { GEAR_STATUSES, MAX_SEARCH_LENGTH, type GearStatus } from '../src/lib/gear/fields';

/**
 * `src/lib/gear/query.ts` is the pure URL <-> PostgREST-query translation layer PK-4
 * needs precisely because `vitest.config.ts:64` excludes `src/pages/` — see that
 * module's own doc comment, and `src/pages/account/index.astro:51-55`, for why this
 * logic could not live in the page's frontmatter and still be tested at all.
 *
 * Same care as `tests/units.test.ts` and `tests/totals.test.ts`: every assertion below
 * names the bug it would catch, not merely what the code does, because a table that
 * "looks full" but only exercises one rejection path is the exact trap
 * `tests/safe-next-path.test.ts` documents (see totals.test.ts's own header for the
 * fuller version of that argument). `buildSearchFilter` and `applyGearQuery` are
 * deliberately NOT tested here — they need a real PostgREST to mean anything, and are
 * covered by `tests/gear-search-escaping.test.ts` against the local stack instead.
 */

const PARAMS = (entries: [string, string][]): URLSearchParams => {
  const params = new URLSearchParams();
  for (const [key, value] of entries) params.append(key, value);
  return params;
};

/** The exact `GearQuery` `parseGearQuery` produces from an empty `URLSearchParams` —
 *  named once so every other test can build off it with `{ ...DEFAULT_QUERY, ... }`
 *  instead of retyping all ten fields, and so "what are the defaults" is answered in
 *  exactly one place. */
const DEFAULT_QUERY: GearQuery = {
  search: '',
  categories: [],
  statuses: [],
  brands: [],
  minGrams: null,
  maxGrams: null,
  weightUnit: 'g',
  sort: 'name',
  direction: 'asc',
  page: 1,
};

describe('parseGearQuery: defaults', () => {
  it('returns every default field for an empty URLSearchParams', () => {
    expect(parseGearQuery(new URLSearchParams())).toEqual(DEFAULT_QUERY);
  });
});

describe('parseGearQuery: search (q)', () => {
  it('trims surrounding whitespace', () => {
    expect(parseGearQuery(PARAMS([['q', '  tent  ']])).search).toBe('tent');
  });

  it('missing q is the empty string, not null or undefined', () => {
    expect(parseGearQuery(new URLSearchParams()).search).toBe('');
  });

  it('a q of only whitespace becomes the empty string, meaning "no search"', () => {
    expect(parseGearQuery(PARAMS([['q', '   ']])).search).toBe('');
  });

  it(`truncates at MAX_SEARCH_LENGTH (${MAX_SEARCH_LENGTH}) rather than passing an unbounded string through`, () => {
    const tooLong = 'x'.repeat(MAX_SEARCH_LENGTH + 50);
    const parsed = parseGearQuery(PARAMS([['q', tooLong]])).search;
    expect(parsed).toHaveLength(MAX_SEARCH_LENGTH);
    expect(parsed).toBe('x'.repeat(MAX_SEARCH_LENGTH));
  });

  it('a string exactly at the limit is not truncated by one character short', () => {
    const exact = 'y'.repeat(MAX_SEARCH_LENGTH);
    expect(parseGearQuery(PARAMS([['q', exact]])).search).toBe(exact);
  });
});

describe('parseGearQuery: category / brand — repeated params', () => {
  it('collects every repeated ?category=', () => {
    const params = PARAMS([
      ['category', 'Shelter'],
      ['category', 'Sleep'],
    ]);
    expect(parseGearQuery(params).categories).toEqual(['Shelter', 'Sleep']);
  });

  it('trims each value and drops empty ones, rather than keeping a blank filter that would match nothing via `in ()`', () => {
    const params = PARAMS([
      ['brand', '  Osprey  '],
      ['brand', ''],
      ['brand', '   '],
    ]);
    expect(parseGearQuery(params).brands).toEqual(['Osprey']);
  });

  it('de-duplicates while preserving first-seen order', () => {
    const params = PARAMS([
      ['category', 'Sleep'],
      ['category', 'Shelter'],
      ['category', 'Sleep'],
    ]);
    // Order matters here specifically: a naive `[...new Set(arr)]` on an array built by
    // pushing every occurrence (duplicates included) still preserves first-seen order,
    // but a version that sorted first would not, and this asserts the ORDER survived,
    // not merely that duplicates are gone.
    expect(parseGearQuery(params).categories).toEqual(['Sleep', 'Shelter']);
  });

  it('two values that only differ after trimming are still treated as duplicates', () => {
    const params = PARAMS([
      ['brand', 'Osprey'],
      ['brand', '  Osprey'],
    ]);
    expect(parseGearQuery(params).brands).toEqual(['Osprey']);
  });

  it('no ?category= at all is an empty array, not null or undefined', () => {
    expect(parseGearQuery(new URLSearchParams()).categories).toEqual([]);
  });
});

describe('parseGearQuery: status — validated against GearStatus', () => {
  it('accepts every real status', () => {
    const params = PARAMS(GEAR_STATUSES.map((status) => ['status', status] as [string, string]));
    expect(parseGearQuery(params).statuses).toEqual([...GEAR_STATUSES]);
  });

  // The case the ticket calls out by name: PK-4's own ticket text names a DIFFERENT set
  // (Available / In use / Maintenance / Retired — see fields.ts's comment on
  // GEAR_STATUSES for why those were not adopted). A URL carrying one of those, or any
  // other near-miss, must be dropped rather than sent to PostgREST as a value `status in
  // (...)` would simply never match — this proves it is dropped, not merely unmatched.
  it('drops unknown statuses rather than passing them through to the query', () => {
    const params = PARAMS([
      ['status', 'owned'],
      ['status', 'in-use'],
      ['status', 'Available'],
      ['status', ''],
    ]);
    expect(parseGearQuery(params).statuses).toEqual(['owned']);
  });

  it('de-duplicates and preserves first-seen order, same as category/brand', () => {
    const params = PARAMS([
      ['status', 'retired'],
      ['status', 'owned'],
      ['status', 'retired'],
    ]);
    expect(parseGearQuery(params).statuses).toEqual(['retired', 'owned']);
  });

  it('the returned array is typed GearStatus[], not string[] — a compile-time check', () => {
    const statuses: readonly GearStatus[] = parseGearQuery(PARAMS([['status', 'owned']])).statuses;
    expect(statuses).toEqual(['owned']);
  });
});

describe('parseGearQuery: weight range (wmin/wmax/wunit)', () => {
  it('defaults weightUnit to g when wunit is absent', () => {
    expect(parseGearQuery(PARAMS([['wmin', '100']])).weightUnit).toBe('g');
  });

  it('falls back to g for an unknown unit rather than converting with a bogus factor', () => {
    const parsed = parseGearQuery(
      PARAMS([
        ['wmin', '5'],
        ['wunit', 'stones'],
      ]),
    );
    expect(parsed.weightUnit).toBe('g');
    expect(parsed.minGrams).toBe(5);
  });

  // The anchor the ticket names explicitly, checked against the exact factor
  // GRAMS_PER_UNIT['lb'] uses (453.59237, the 1959 international pound) — not a
  // rounded 453.6, which would make this pass against a subtly wrong conversion.
  it('converts 2 lb to exactly 907.18474 g, the same factor units.ts uses', () => {
    const parsed = parseGearQuery(
      PARAMS([
        ['wmin', '2'],
        ['wunit', 'lb'],
      ]),
    );
    expect(parsed.minGrams).toBe(2 * 453.59237);
    expect(parsed.minGrams).toBe(907.18474);
  });

  it('converts kg correctly', () => {
    const parsed = parseGearQuery(
      PARAMS([
        ['wmax', '1.5'],
        ['wunit', 'kg'],
      ]),
    );
    expect(parsed.maxGrams).toBe(1500);
  });

  it('converts oz using the exact 1959 factor (not a rounded 28.35)', () => {
    const parsed = parseGearQuery(
      PARAMS([
        ['wmin', '4'],
        ['wunit', 'oz'],
      ]),
    );
    expect(parsed.minGrams).toBe(4 * 28.349523125);
  });

  it('missing wmin/wmax is null, not zero — zero is a real, different filter value', () => {
    const parsed = parseGearQuery(new URLSearchParams());
    expect(parsed.minGrams).toBeNull();
    expect(parsed.maxGrams).toBeNull();
  });

  it('a wmin of exactly 0 is kept as 0, not treated as "missing"', () => {
    expect(parseGearQuery(PARAMS([['wmin', '0']])).minGrams).toBe(0);
  });

  // NaN, Infinity and negative values all fail toGrams's own guard (see units.ts's
  // "THROW, NOT RETURN" section) or this module's own pre-check — every one of them
  // must become null, not a thrown error that would 500 the page.
  it.each([
    ['not a number at all', 'abc'],
    ['the literal string "NaN"', 'NaN'],
    ['positive Infinity', 'Infinity'],
    ['negative Infinity', '-Infinity'],
    ['a negative number', '-5'],
    ['the empty string', ''],
    ['whitespace only', '   '],
  ])('wmin=%s (%s) becomes null rather than a bad number or a throw', (_label, raw) => {
    expect(() => parseGearQuery(PARAMS([['wmin', raw]]))).not.toThrow();
    expect(parseGearQuery(PARAMS([['wmin', raw]])).minGrams).toBeNull();
  });

  it('rejects trailing garbage rather than reading a leading numeric prefix', () => {
    // parseFloat('12abc') is 12; this module deliberately parses with Number(), which
    // is NaN for the same input — see parseWeightBoundary's own comment for why a
    // half-read value is worse than an honest null.
    expect(parseGearQuery(PARAMS([['wmin', '12abc']])).minGrams).toBeNull();
  });

  // A conversion whose PRODUCT overflows to Infinity — not just a bad argument — must
  // also become null. toGrams(1e308, 'kg') throws for exactly this reason (see
  // units.ts's "THE PRODUCT IS CHECKED AS WELL AS THE ARGUMENT").
  it('a value whose conversion overflows to Infinity becomes null, not Infinity', () => {
    const parsed = parseGearQuery(
      PARAMS([
        ['wmin', '1e308'],
        ['wunit', 'kg'],
      ]),
    );
    expect(parsed.minGrams).toBeNull();
  });

  // THE CASE THE TICKET NAMES: min > max is kept exactly as given, never swapped or
  // dropped. See parseGearQuery's own "MIN > MAX IS KEPT, NEVER FIXED" comment for why:
  // swapping silently answers a different question than the one the visitor asked, and
  // the honest result of `weight_grams >= 10000 and weight_grams <= 5000` is an empty
  // list the UI can explain, not a populated one answering something else.
  it('keeps minGrams > maxGrams exactly as given, rather than swapping or dropping either bound', () => {
    const parsed = parseGearQuery(
      PARAMS([
        ['wmin', '10'],
        ['wmax', '5'],
      ]),
    );
    expect(parsed.minGrams).toBe(10);
    expect(parsed.maxGrams).toBe(5);
    // Not swapped:
    expect(parsed.minGrams).not.toBe(5);
    expect(parsed.maxGrams).not.toBe(10);
  });
});

describe('parseGearQuery: sort / dir', () => {
  it.each([
    ['name', 'name'],
    ['weight', 'weight'],
    ['price', 'price'],
    ['added', 'added'],
  ])('accepts sort=%s', (raw, expected) => {
    expect(parseGearQuery(PARAMS([['sort', raw]])).sort).toBe(expected);
  });

  it('falls back to name for an unknown sort key', () => {
    expect(parseGearQuery(PARAMS([['sort', 'DROP TABLE gear_items']])).sort).toBe('name');
  });

  it('sort is case-sensitive — "Name" is not "name"', () => {
    expect(parseGearQuery(PARAMS([['sort', 'Name']])).sort).toBe('name');
  });

  it.each([
    ['asc', 'asc'],
    ['desc', 'desc'],
  ])('accepts dir=%s', (raw, expected) => {
    expect(parseGearQuery(PARAMS([['dir', raw]])).direction).toBe(expected);
  });

  it('falls back to asc for an unrecognised direction', () => {
    expect(parseGearQuery(PARAMS([['dir', 'sideways']])).direction).toBe('asc');
  });

  it('missing sort/dir default to name/asc', () => {
    const parsed = parseGearQuery(new URLSearchParams());
    expect(parsed.sort).toBe('name');
    expect(parsed.direction).toBe('asc');
  });
});

describe('parseGearQuery: page', () => {
  it('missing page defaults to 1', () => {
    expect(parseGearQuery(new URLSearchParams()).page).toBe(1);
  });

  it('parses an ordinary positive integer', () => {
    expect(parseGearQuery(PARAMS([['page', '3']])).page).toBe(3);
  });

  it.each([
    ['a fractional page', '1.5'],
    ['a negative page', '-3'],
    ['zero, which is not a valid 1-based page', '0'],
    ['non-numeric garbage', 'abc'],
    ['scientific notation, not a plain digit string', '1e9'],
    ['a leading-plus-signed number', '+5'],
    ['whitespace only', '   '],
  ])('page=%s (%s) defaults to 1 rather than throwing', (_label, raw) => {
    expect(() => parseGearQuery(PARAMS([['page', raw]]))).not.toThrow();
    expect(parseGearQuery(PARAMS([['page', raw]])).page).toBe(1);
  });

  it(`clamps an absurdly large but syntactically valid page to MAX_GEAR_PAGE (${MAX_GEAR_PAGE}), rather than requesting an unbounded offset`, () => {
    expect(parseGearQuery(PARAMS([['page', '999999999']])).page).toBe(MAX_GEAR_PAGE);
  });

  it('a page exactly at MAX_GEAR_PAGE is not clamped down further', () => {
    expect(parseGearQuery(PARAMS([['page', String(MAX_GEAR_PAGE)]])).page).toBe(MAX_GEAR_PAGE);
  });

  it('a page one below MAX_GEAR_PAGE is left untouched', () => {
    expect(parseGearQuery(PARAMS([['page', String(MAX_GEAR_PAGE - 1)]])).page).toBe(
      MAX_GEAR_PAGE - 1,
    );
  });
});

describe('parseGearQuery: hostile input, all at once', () => {
  // The exact URL the ticket names: every field simultaneously hostile. The only
  // acceptable outcome is the same defaults an empty URLSearchParams would produce —
  // never a throw, and never a 500 downstream of one.
  it('?page=-1&sort=DROP TABLE&dir=sideways&wmin=NaN&wunit=stones produces clean defaults', () => {
    const params = PARAMS([
      ['page', '-1'],
      ['sort', 'DROP TABLE'],
      ['dir', 'sideways'],
      ['wmin', 'NaN'],
      ['wunit', 'stones'],
    ]);
    expect(() => parseGearQuery(params)).not.toThrow();
    expect(parseGearQuery(params)).toEqual(DEFAULT_QUERY);
  });

  it('an empty-string value for every repeated-list param produces empty arrays, not arrays of empty strings', () => {
    const params = PARAMS([
      ['category', ''],
      ['brand', ''],
      ['status', ''],
    ]);
    const parsed = parseGearQuery(params);
    expect(parsed.categories).toEqual([]);
    expect(parsed.brands).toEqual([]);
    expect(parsed.statuses).toEqual([]);
  });
});

describe('gearQueryToSearchParams: emits only non-default values', () => {
  it('the all-default query serialises to an empty URLSearchParams', () => {
    expect(gearQueryToSearchParams(DEFAULT_QUERY).toString()).toBe('');
  });

  it('a search-only query emits only q', () => {
    const params = gearQueryToSearchParams({ ...DEFAULT_QUERY, search: 'tent' });
    expect(Array.from(params.keys())).toEqual(['q']);
    expect(params.get('q')).toBe('tent');
  });

  it('a weight range at the default unit (g) does not emit wunit', () => {
    const params = gearQueryToSearchParams({ ...DEFAULT_QUERY, minGrams: 100, weightUnit: 'g' });
    expect(params.has('wunit')).toBe(false);
    expect(params.get('wmin')).toBe('100');
  });

  it('a non-default weight unit is emitted even with no range set, so the form does not forget the visitor’s unit choice', () => {
    const params = gearQueryToSearchParams({ ...DEFAULT_QUERY, weightUnit: 'lb' });
    expect(params.get('wunit')).toBe('lb');
    expect(params.has('wmin')).toBe(false);
    expect(params.has('wmax')).toBe(false);
  });
});

describe('gearQueryToSearchParams / parseGearQuery: round trip', () => {
  // Representative queries spanning every field this module owns. Each is fed through
  // parseGearQuery -> gearQueryToSearchParams -> parseGearQuery and must come back
  // identical to the first parse — not merely "close enough" — because a URL a visitor
  // bookmarks or shares must reproduce exactly the list they were looking at.
  const CASES: [label: string, params: [string, string][]][] = [
    ['every field at its default', []],
    ['search only', [['q', 'merino base layer']]],
    [
      'multiple categories, brands and statuses',
      [
        ['category', 'Shelter'],
        ['category', 'Sleep'],
        ['brand', 'Osprey'],
        ['status', 'owned'],
        ['status', 'wishlist'],
      ],
    ],
    [
      'a weight range entered in lb',
      [
        ['wmin', '2'],
        ['wmax', '5'],
        ['wunit', 'lb'],
      ],
    ],
    [
      'a weight range entered in oz',
      [
        ['wmin', '4.4'],
        ['wunit', 'oz'],
      ],
    ],
    [
      'only a max weight, in kg',
      [
        ['wmax', '1.75'],
        ['wunit', 'kg'],
      ],
    ],
    [
      'min greater than max, kept as given',
      [
        ['wmin', '10'],
        ['wmax', '5'],
      ],
    ],
    [
      'sort by weight descending',
      [
        ['sort', 'weight'],
        ['dir', 'desc'],
      ],
    ],
    [
      'sort by price ascending on page 4',
      [
        ['sort', 'price'],
        ['page', '4'],
      ],
    ],
    [
      'every field at once',
      [
        ['q', 'quilt'],
        ['category', 'Sleep'],
        ['brand', 'Enlightened Equipment'],
        ['status', 'owned'],
        ['wmin', '400'],
        ['wmax', '900'],
        ['wunit', 'g'],
        ['sort', 'added'],
        ['dir', 'desc'],
        ['page', '2'],
      ],
    ],
  ];

  it.each(CASES)('round-trips: %s', (_label, entries) => {
    const first = parseGearQuery(PARAMS(entries));
    const reparsed = parseGearQuery(gearQueryToSearchParams(first));
    expect(reparsed).toEqual(first);
  });

  it('round-trips a page clamped to MAX_GEAR_PAGE', () => {
    const first = parseGearQuery(PARAMS([['page', '999999999']]));
    expect(first.page).toBe(MAX_GEAR_PAGE);
    const reparsed = parseGearQuery(gearQueryToSearchParams(first));
    expect(reparsed).toEqual(first);
  });

  it('round-trips a search string truncated to MAX_SEARCH_LENGTH', () => {
    const first = parseGearQuery(PARAMS([['q', 'z'.repeat(MAX_SEARCH_LENGTH + 20)]]));
    const reparsed = parseGearQuery(gearQueryToSearchParams(first));
    expect(reparsed).toEqual(first);
  });
});
