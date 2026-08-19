import { describe, it, expect } from 'vitest';
import {
  MAX_IMPORT_ITEMS,
  gearImportIsClean,
  gearImportRows as rows,
  gearImportProblemCount,
  importableGearItems,
  parseGearItemsFile,
} from '../src/lib/gear/json-import';
import {
  GEAR_ITEMS_KIND,
  PACKSHEET_SCHEMA_VERSION,
  buildGearItemsDocument,
  serialiseGearItemsDocument,
} from '../src/lib/gear/json-schema';

/**
 * Reading a Packsheet gear file (PK-65).
 *
 * The claims under test are the ones the ticket's acceptance makes and the ones the
 * module's own header commits to: four accepted shapes, a total parser that never throws
 * for any input, a whole-file refusal that writes nothing, and validation that is
 * literally the add/edit form's validation rather than a second copy of it.
 */

/** A minimal item that validates. Every test that is not about a particular field starts
 *  from this and changes the one thing it is about, so a failure names the change. */
const VALID = { name: 'Nemo Hornet 2P', weight_grams: 907 };

function parse(value: unknown): ReturnType<typeof parseGearItemsFile> {
  return parseGearItemsFile(typeof value === 'string' ? value : JSON.stringify(value));
}

function envelope(items: readonly unknown[]): string {
  return JSON.stringify({
    packsheet: PACKSHEET_SCHEMA_VERSION,
    kind: GEAR_ITEMS_KIND,
    exported_at: '2026-08-16T00:00:00.000Z',
    data: { items },
  });
}

describe('the four accepted shapes', () => {
  it('reads the versioned envelope this product exports', () => {
    const report = parse(envelope([VALID, { ...VALID, name: 'Katadyn BeFree' }]));
    expect(report.fileError).toBeNull();
    expect(report.format).toBe('envelope');
    expect(rows(report)).toHaveLength(2);
    expect(gearImportIsClean(report)).toBe(true);
  });

  it('reads a bare array of items', () => {
    const report = parse([VALID, VALID]);
    expect(report.format).toBe('array');
    expect(gearImportIsClean(report)).toBe(true);
    expect(rows(report)).toHaveLength(2);
  });

  it('reads a single bare item object', () => {
    const report = parse(VALID);
    expect(report.format).toBe('object');
    expect(gearImportIsClean(report)).toBe(true);
    expect(rows(report)).toHaveLength(1);
  });

  it('reads JSONL, one item per line', () => {
    const report = parse(`${JSON.stringify(VALID)}\n${JSON.stringify(VALID)}\n`);
    expect(report.format).toBe('jsonl');
    expect(gearImportIsClean(report)).toBe(true);
    expect(rows(report)).toHaveLength(2);
  });

  it('skips blank lines in JSONL rather than failing on the trailing newline every editor writes', () => {
    const report = parse(`\n${JSON.stringify(VALID)}\n\n${JSON.stringify(VALID)}\n\n`);
    expect(gearImportIsClean(report)).toBe(true);
    expect(rows(report)).toHaveLength(2);
    // Positions count ITEMS, not lines, so a blank line in the middle does not shift the
    // numbering against the items a person can count.
    expect(rows(report).map((row) => row.position)).toEqual([1, 2]);
  });

  it('reads a one-line JSONL file identically to the same single object as JSON', () => {
    // The order of the two attempts (whole-text JSON first, JSONL second) is only sound
    // because these two readings agree. This is that claim, asserted rather than argued.
    const asJson = parse(VALID);
    const asJsonl = parse(`${JSON.stringify(VALID)}\n`);
    expect(rows(asJsonl)).toEqual(rows(asJson));
  });

  it('reports a truncated JSONL file by the line it broke on', () => {
    const report = parse(`${JSON.stringify(VALID)}\n${JSON.stringify(VALID)}\n{"name": "cut`);
    expect(report.fileError).toContain('line 3');
    expect(rows(report)).toEqual([]);
  });

  it('reports a file that never looked like JSONL as a file problem, not a line problem', () => {
    // Line 1 failing means nothing about the file ever parsed, so naming a line would
    // point at the wrong thing — see parseJsonl's own comment.
    const report = parse('this is not json at all');
    // Not "does not contain the word line" — the message legitimately says "one item per
    // line" while describing the format. The claim is that it names no line NUMBER, which
    // is what would send its reader to a line when the problem is the whole file.
    expect(report.fileError).not.toMatch(/line \d/);
    expect(report.fileError).toContain('JSONL');
  });
});

describe('whole-file refusals write nothing', () => {
  it('refuses an empty file', () => {
    expect(parse('').fileError).toBe('That file is empty.');
    expect(parse('   \n  ').fileError).toBe('That file is empty.');
  });

  it('refuses a schema version this build does not read, naming both versions', () => {
    const report = parse(
      JSON.stringify({ packsheet: 2, kind: GEAR_ITEMS_KIND, data: { items: [VALID] } }),
    );
    expect(report.fileError).toContain('version 2');
    expect(report.fileError).toContain(`version ${PACKSHEET_SCHEMA_VERSION}`);
    expect(rows(report)).toEqual([]);
  });

  it('checks the version before the kind, so a newer file is reported as newer', () => {
    // A file from a future schema may well use a kind this build has never heard of.
    // "This file is newer than this Packsheet" is the useful half of that pair.
    const report = parse(
      JSON.stringify({ packsheet: 99, kind: 'trip_reports', data: { items: [] } }),
    );
    expect(report.fileError).toContain('version 99');
  });

  it('refuses a pack file by name rather than as an unknown kind', () => {
    const report = parse(
      JSON.stringify({ packsheet: PACKSHEET_SCHEMA_VERSION, kind: 'pack', data: {} }),
    );
    expect(report.fileError).toContain('pack file');
    expect(report.fileError).toContain('gear items');
  });

  it('names an unrecognised kind', () => {
    const report = parse(
      JSON.stringify({ packsheet: PACKSHEET_SCHEMA_VERSION, kind: 'recipes', data: {} }),
    );
    expect(report.fileError).toContain('"recipes"');
  });

  it('refuses an envelope whose data holds no items array', () => {
    expect(
      parse(JSON.stringify({ packsheet: 1, kind: GEAR_ITEMS_KIND, data: { items: 'nope' } }))
        .fileError,
    ).not.toBeNull();
    expect(
      parse(JSON.stringify({ packsheet: 1, kind: GEAR_ITEMS_KIND, data: null })).fileError,
    ).not.toBeNull();
  });

  it('refuses valid JSON that is not a gear item or a list of them', () => {
    for (const body of ['123', '"a string"', 'true', 'null']) {
      expect(parse(body).fileError).not.toBeNull();
    }
  });

  it('refuses a file holding no items', () => {
    expect(parse([]).fileError).toBe('That file holds no gear items.');
    expect(parse(envelope([])).fileError).toBe('That file holds no gear items.');
  });

  it('refuses a file over the item cap whole, rather than importing the first of it', () => {
    const report = parse(Array.from({ length: MAX_IMPORT_ITEMS + 1 }, () => VALID));
    expect(report.fileError).toContain(String(MAX_IMPORT_ITEMS));
    expect(rows(report)).toEqual([]);
    expect(importableGearItems(report)).toBeNull();
  });

  it('accepts a file exactly at the cap', () => {
    const report = parse(Array.from({ length: MAX_IMPORT_ITEMS }, () => VALID));
    expect(report.fileError).toBeNull();
    expect(gearImportIsClean(report)).toBe(true);
  });
});

describe('per-row validation is the add/edit form’s validation', () => {
  it('reports a missing name with the form’s own message', () => {
    const report = parse([{ weight_grams: 100 }]);
    expect(gearImportIsClean(report)).toBe(false);
    const row = rows(report)[0];
    expect(row?.ok).toBe(false);
    if (row && !row.ok) expect(row.errors.name).toBe('Enter a name for this item.');
  });

  it('enforces the price/currency both-or-neither constraint', () => {
    const withPriceOnly = parse([{ ...VALID, price: 42 }]);
    const row = rows(withPriceOnly)[0];
    expect(row?.ok).toBe(false);
    if (row && !row.ok) expect(row.errors.currency).toBe('Select a currency for this price.');

    const withCurrencyOnly = parse([{ ...VALID, currency: 'GBP' }]);
    const other = rows(withCurrencyOnly)[0];
    expect(other?.ok).toBe(false);
    if (other && !other.ok) {
      expect(other.errors.price).toBe('Enter a price for this currency, or clear the currency.');
    }

    expect(gearImportIsClean(parse([{ ...VALID, price: 42, currency: 'GBP' }]))).toBe(true);
  });

  it('refuses a future acquired_on and a date that is not a real calendar day', () => {
    expect(gearImportIsClean(parse([{ ...VALID, acquired_on: '2099-01-01' }]))).toBe(false);
    expect(gearImportIsClean(parse([{ ...VALID, acquired_on: '2026-02-30' }]))).toBe(false);
    expect(gearImportIsClean(parse([{ ...VALID, acquired_on: '2020-02-29' }]))).toBe(true);
  });

  it('refuses a URL that is not http or https', () => {
    expect(gearImportIsClean(parse([{ ...VALID, url: 'javascript:alert(1)' }]))).toBe(false);
    expect(gearImportIsClean(parse([{ ...VALID, url: 'https://example.com/tent' }]))).toBe(true);
  });

  it('refuses a status outside the three the column allows', () => {
    expect(gearImportIsClean(parse([{ ...VALID, status: 'active' }]))).toBe(false);
    expect(gearImportIsClean(parse([{ ...VALID, status: 'Owned' }]))).toBe(false);
    for (const status of ['owned', 'wishlist', 'retired']) {
      expect(gearImportIsClean(parse([{ ...VALID, status }]))).toBe(true);
    }
  });

  it('refuses a weight with more precision than numeric(12,3) can hold, rather than rounding it', () => {
    // Refusing is what keeps "what you exported is what you get back" exact rather than
    // approximate — see FILE_FIELDS' own comment.
    expect(gearImportIsClean(parse([{ ...VALID, weight_grams: 124.7381 }]))).toBe(false);
    expect(gearImportIsClean(parse([{ ...VALID, weight_grams: 124.738 }]))).toBe(true);
  });

  it('refuses a negative weight, a zero quantity and a fractional quantity', () => {
    expect(gearImportIsClean(parse([{ ...VALID, weight_grams: -1 }]))).toBe(false);
    expect(gearImportIsClean(parse([{ ...VALID, quantity: 0 }]))).toBe(false);
    expect(gearImportIsClean(parse([{ ...VALID, quantity: 1.5 }]))).toBe(false);
  });

  it('reports every problem in a row at once rather than the first', () => {
    const report = parse([{ name: '', status: 'nope', url: 'ftp://x' }]);
    const row = rows(report)[0];
    expect(row?.ok).toBe(false);
    if (row && !row.ok) expect(Object.keys(row.errors).length).toBeGreaterThanOrEqual(3);
  });
});

describe('defaults a file may leave out', () => {
  it('defaults status to owned when the file does not say, unlike the form', () => {
    const report = parse([VALID]);
    const row = rows(report)[0];
    expect(row?.ok).toBe(true);
    if (row?.ok) expect(row.values.status).toBe('owned');
  });

  it('treats an explicit null status the same as an absent one', () => {
    const report = parse([{ ...VALID, status: null }]);
    const row = rows(report)[0];
    expect(row?.ok).toBe(true);
    if (row?.ok) expect(row.values.status).toBe('owned');
  });

  it('defaults quantity and weight to the column defaults when absent', () => {
    const report = parse([{ name: 'A bag' }]);
    const row = rows(report)[0];
    expect(row?.ok).toBe(true);
    if (row?.ok) {
      expect(row.values.quantity).toBe(1);
      expect(row.values.weight_grams).toBe(0);
    }
  });

  it('always stores grams, since the file has no unit to carry', () => {
    const report = parse([{ ...VALID, weight_grams: 907 }]);
    const row = rows(report)[0];
    expect(row?.ok).toBe(true);
    if (row?.ok) {
      expect(row.values.weight_grams).toBe(907);
      // PK-67: there is no `weight_unit` to assert. The guarantee it used to carry — the
      // file's number reaches the column unconverted — is now that `validateItem` passes
      // `'metric'`, whose entry unit is `g`. `907` in, 907 g stored.
      expect(row.values.weight_grams).toBe(907);
    }
  });
});

describe('unknown keys are refused', () => {
  it('names the weight/weight_unit pair specifically, because that is the mistake the ticket text invites', () => {
    const report = parse([{ name: 'A tent', weight: 4.4, weight_unit: 'oz' }]);
    const row = rows(report)[0];
    expect(row?.ok).toBe(false);
    if (row && !row.ok) {
      expect(row.errors.weight_grams).toContain('weight_grams');
      expect(row.errors.weight_grams).toContain('grams');
    }
  });

  it('names volume_litres, which PK-61 removed from the product', () => {
    const report = parse([{ ...VALID, volume_litres: 12 }]);
    expect(gearImportIsClean(report)).toBe(false);
  });

  it('refuses a misspelled field rather than silently dropping it', () => {
    const report = parse([{ ...VALID, catagory: 'Shelter' }]);
    const row = rows(report)[0];
    expect(row?.ok).toBe(false);
    if (row && !row.ok) expect(row.errors.item).toContain('"catagory"');
  });

  it('refuses the database identifiers the schema deliberately does not carry', () => {
    for (const key of ['id', 'user_id', 'created_at', 'photo_path']) {
      expect(gearImportIsClean(parse([{ ...VALID, [key]: 'x' }]))).toBe(false);
    }
  });
});

describe('field types', () => {
  it('accepts a number where text is expected and a numeric string where a number is', () => {
    const numericName = parse([{ name: 2024, weight_grams: 907 }]);
    expect(gearImportIsClean(numericName)).toBe(true);

    const stringQuantity = parse([{ ...VALID, quantity: '2' }]);
    const row = rows(stringQuantity)[0];
    expect(row?.ok).toBe(true);
    if (row?.ok) expect(row.values.quantity).toBe(2);
  });

  it('refuses a boolean, an array and a nested object rather than stringifying them', () => {
    // String() would give each of these a confident wrong reading ('true', 'a,b',
    // '[object Object]') that then passes validation and reaches the database.
    expect(gearImportIsClean(parse([{ ...VALID, name: true }]))).toBe(false);
    expect(gearImportIsClean(parse([{ ...VALID, name: ['a', 'b'] }]))).toBe(false);
    expect(gearImportIsClean(parse([{ ...VALID, price: { amount: 10 } }]))).toBe(false);
  });

  it('refuses a row that is not an object at all', () => {
    const report = parse([VALID, 'not an item', 42]);
    expect(gearImportIsClean(report)).toBe(false);
    expect(gearImportProblemCount(report)).toBe(2);
  });
});

describe('all or nothing', () => {
  it('returns no items at all when a single row of many is bad', () => {
    const file = [VALID, VALID, { name: '' }, VALID];
    const report = parse(file);
    expect(rows(report)).toHaveLength(4);
    expect(gearImportProblemCount(report)).toBe(1);
    expect(gearImportIsClean(report)).toBe(false);
    // The whole point: there is no exported way to reach the three good rows.
    expect(importableGearItems(report)).toBeNull();
  });

  it('reports good rows alongside bad ones so a file can be fixed in one pass', () => {
    const report = parse([VALID, { name: '' }, VALID]);
    expect(rows(report).map((row) => row.ok)).toEqual([true, false, true]);
  });

  it('labels a row by its own name where it has one, and by its position where it does not', () => {
    const report = parse([{ ...VALID, name: 'Katadyn BeFree' }, { weight_grams: 1 }]);
    expect(rows(report)[0]?.label).toBe('Katadyn BeFree');
    expect(rows(report)[1]?.label).toBe('Item 2');
  });

  it('never reports a file with no rows as clean', () => {
    // A "clean" empty report would let a caller issue an empty import and report success.
    const report = parse([]);
    expect(gearImportIsClean(report)).toBe(false);
    expect(importableGearItems(report)).toBeNull();
  });
});

describe('text Postgres cannot store is refused at the preview, not at the insert', () => {
  // Neither of these is expressible as a CHECK constraint, so neither has a mirror in
  // form.ts — and a browser cannot produce either, so the form path never meets them. A
  // FILE can. Before this guard they previewed as CLEAN and then died at the INSERT, where
  // the only thing the page can honestly say is that it could not confirm what happened.
  it('refuses a NUL byte in any text field', () => {
    expect(gearImportIsClean(parse([{ name: 'a\u0000b', weight_grams: 1 }]))).toBe(false);
    expect(gearImportIsClean(parse([{ ...VALID, notes: 'x\u0000' }]))).toBe(false);
  });

  it('refuses an unpaired surrogate', () => {
    expect(gearImportIsClean(parse([{ name: '\ud800', weight_grams: 1 }]))).toBe(false);
    expect(gearImportIsClean(parse([{ ...VALID, brand: 'a\udc00b' }]))).toBe(false);
  });

  it('still accepts ordinary astral characters, which are well-formed pairs', () => {
    // Emoji are surrogate PAIRS. Refusing those would refuse a great many real gear names.
    const report = parse([{ name: '🏕 Tent 帳篷 čäé', weight_grams: 1 }]);
    expect(gearImportIsClean(report)).toBe(true);
    const row = rows(report)[0];
    if (row?.ok) expect(row.values.name).toBe('🏕 Tent 帳篷 čäé');
  });

  it('names the field the file uses, not the form field behind it', () => {
    // The shared validator raises `weight`; this format has no `weight` field and refuses
    // one by name, so reporting under it would contradict the refusal two rows above.
    const report = parse([{ ...VALID, weight_grams: 124.7381 }]);
    const row = rows(report)[0];
    expect(row?.ok).toBe(false);
    if (row && !row.ok) {
      expect(Object.keys(row.errors)).toEqual(['weight_grams']);
      expect(row.errors.weight).toBeUndefined();
    }
  });
});

describe('a leading byte-order mark is stripped', () => {
  it('reads an export saved by an editor that writes a BOM', () => {
    // Notepad does this. Without the strip, a visitor who opened their own export to fix
    // one line is told it is not a Packsheet file.
    const report = parse(`\uFEFF${envelope([VALID])}`);
    expect(report.fileError).toBeNull();
    expect(gearImportIsClean(report)).toBe(true);
  });

  it('leaves a U+FEFF inside a value alone', () => {
    const report = parse([{ name: `Tent\uFEFFwith mark`, weight_grams: 1 }]);
    const row = rows(report)[0];
    expect(row?.ok).toBe(true);
    if (row?.ok) expect(row.values.name).toContain('\uFEFF');
  });
});

describe('numbers that overflow a double', () => {
  // WRITTEN AS RAW TEXT, NOT THROUGH `parse([...])`. `JSON.stringify(Infinity)` is the
  // literal `null`, so building these through an object would never put `1e400` in the
  // file at all — the assertions would pass for the wrong reason (a null name is refused
  // as a MISSING name) and would keep passing with the guard removed. Verified: they do.
  // The overflow has to happen inside `JSON.parse`, which means it has to be in the bytes.
  it('refuses 1e400 in a text field rather than importing an item named Infinity', () => {
    expect(JSON.parse('1e400')).toBe(Infinity);
    const report = parseGearItemsFile('[{"name": 1e400, "weight_grams": 1}]');
    expect(gearImportIsClean(report)).toBe(false);
    const row = rows(report)[0];
    if (row && !row.ok) expect(row.errors.name).toBeDefined();
  });

  it('refuses it in a numeric field too', () => {
    expect(gearImportIsClean(parseGearItemsFile('[{"name":"A tent","weight_grams": 1e400}]'))).toBe(
      false,
    );
    expect(
      gearImportIsClean(
        parseGearItemsFile('[{"name":"A tent","price": -1e400, "currency": "GBP"}]'),
      ),
    ).toBe(false);
  });
});

describe('prototype keys reach the unknown-key refusal, not the prototype', () => {
  it.each(['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty'])(
    'refuses %s as an unknown field',
    (key) => {
      // JSON.parse makes __proto__ an ORDINARY OWN property, so Object.keys sees it and
      // the Set-backed KNOWN_KEYS refuses it. A truthy lookup against FILE_FIELDS would
      // not — see KNOWN_KEYS' own comment.
      const report = parseGearItemsFile(`[{"name":"A tent","weight_grams":1,"${key}":"x"}]`);
      expect(gearImportIsClean(report)).toBe(false);
    },
  );

  it('does not pollute Object.prototype', () => {
    parseGearItemsFile('[{"__proto__":{"polluted":true}}]');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('totality — no input may throw', () => {
  const hostile: readonly string[] = [
    '',
    ' ',
    '\0',
    '{',
    '[',
    '[[[[[[[[[[',
    '{"a":',
    'undefined',
    'NaN',
    '{"packsheet":1}',
    '{"kind":"gear_items"}',
    '{"packsheet":"1","kind":"gear_items","data":{"items":[]}}',
    '\uFEFF{"name":"bom"}',
    '[{"name":"\\u0000"}]',
    '{"name":"x","weight_grams":1e400}',
    '[]\n[]',
    'null\nnull',
  ];

  it.each(hostile)('does not throw on %j', (input) => {
    expect(() => parseGearItemsFile(input)).not.toThrow();
  });

  it('does not throw on a deeply nested value', () => {
    // Deep enough to be awkward, shallow enough that JSON.parse itself does not blow the
    // stack — the point is that whatever JSON.parse does, this module reports it.
    const deep = `${'['.repeat(2000)}${']'.repeat(2000)}`;
    expect(() => parseGearItemsFile(deep)).not.toThrow();
  });

  it('does not throw on a long string', () => {
    expect(() => parseGearItemsFile('x'.repeat(500_000))).not.toThrow();
  });
});

describe('round trip, in memory', () => {
  it('reads back what the exporter wrote, field for field', () => {
    // The database half of this claim is tests/gear-json-round-trip.test.ts. This half
    // pins the pure part: serialise -> parse produces the same values, with no database
    // in the way to explain a difference.
    const rows = [
      {
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
      },
      {
        name: 'Katadyn BeFree',
        brand: null,
        category: null,
        description: null,
        quantity: 2,
        weight_grams: 65.204,
        price: null,
        currency: null,
        acquired_on: null,
        status: 'wishlist',
        url: null,
        notes: null,
      },
    ];

    const text = serialiseGearItemsDocument(
      buildGearItemsDocument(rows, new Date('2026-08-16T12:00:00.000Z')),
    );
    const report = parseGearItemsFile(text);
    expect(report.fileError).toBeNull();
    expect(gearImportIsClean(report)).toBe(true);

    const items = importableGearItems(report);
    expect(items).not.toBeNull();
    expect(items?.[0]).toEqual({
      name: 'Nemo Hornet 2P',
      brand: 'Nemo',
      category: 'Shelter',
      description: 'Two-person tent',
      quantity: 1,
      // One field where there were two (PK-67). `GearItemInput` carries the gram figure
      // the file gave, and there is no unit beside it to be right or wrong about.
      weight_grams: 907,
      price: 429.99,
      currency: 'GBP',
      acquired_on: '2024-05-01',
      status: 'owned',
      url: 'https://example.com/hornet',
      notes: 'Fly pitches first',
    });
    expect(items?.[1]?.weight_grams).toBe(65.204);
    expect(items?.[1]?.status).toBe('wishlist');
  });
});
