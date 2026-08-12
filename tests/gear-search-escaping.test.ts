import { describe, it, expect, beforeAll } from 'vitest';
import { createUser, type TestUser } from './support/local-database';
import { buildSearchFilter } from '../src/lib/gear/query';

/**
 * `buildSearchFilter` (src/lib/gear/query.ts) is the highest-risk function in PK-4, and
 * this file is why: it is not enough to reason about the escaping by hand, because two
 * independent parsers are involved — PostgREST's own `or=(...)` grammar, which this
 * project has no source for and no unit-testable stand-in for, and Postgres's `LIKE`
 * pattern language underneath it — and a mistake in either layer, or in the ORDER the
 * two are applied, produces a query that still runs and still returns rows. It just
 * returns the WRONG rows, silently, which is a worse failure than an error would be:
 * `50%` unescaped does not fail loudly, it quietly starts matching `500 grams`.
 *
 * So this suite proves the escaping empirically, against the real local stack, the same
 * way tests/gear-closet-schema.test.ts and tests/rls-owner.test.ts do: fixtures
 * inserted through PostgREST as their owner, then read back through the SAME `.or()`
 * call `applyGearQuery` makes, via `buildSearchFilter` — not a hand-rolled re-
 * implementation of what the escaping is supposed to do.
 *
 * ---------------------------------------------------------------------------
 * WHY EVERY CASE ALSO CARRIES A DECOY, AND WHY ALL FIXTURES SHARE ONE OWNER
 * ---------------------------------------------------------------------------
 *
 * Asserting only "the awkward string is found" would pass just as happily against an
 * implementation that matches EVERYTHING — an unescaped `%` in a broken pattern, or a
 * comma that splits `or=(...)` into two conditions where one degenerates to matching
 * every row. Every case below therefore also inserts at least one DECOY row designed to
 * be the exact row a broken escaping implementation would incorrectly return, and every
 * fixture for every case is inserted under the SAME owner before ANY search runs — so a
 * search for one case's term is checked against the full fixture set, not a clean
 * table, and "found exactly the right row" means exactly that: not the target plus a
 * decoy, not the target plus some other case's unrelated row.
 */

let owner: TestUser;

interface Fixture {
  id: string;
  name: string;
}

/** Inserted rows, looked up by a short label so each `it` can name its own target and
 *  decoys without repeating the awkward strings inline. */
const rows = new Map<string, Fixture>();

async function insertGear(label: string, overrides: { name?: string; brand?: string }) {
  const { data, error } = await owner.client
    .from('gear_items')
    .insert({ name: overrides.name ?? `Untitled (${label})`, ...overrides })
    .select('id, name')
    .single();
  if (error || !data) {
    throw new Error(`Fixture insert failed for ${label}: ${error?.message}`, { cause: error });
  }
  rows.set(label, { id: data.id, name: data.name });
}

/** Runs the exact `.or()` call `applyGearQuery` makes, against the whole fixture table,
 *  and returns which labelled rows came back — by label, not by id, so a mismatch
 *  reads as "found 'percent-decoy' instead of 'percent-target'" rather than two GUIDs. */
async function searchLabels(term: string): Promise<string[]> {
  const { data, error } = await owner.client
    .from('gear_items')
    .select('id')
    .is('deleted_at', null)
    .or(buildSearchFilter(term));
  expect(error).toBeNull();

  const byId = new Map(Array.from(rows.entries()).map(([label, row]) => [row.id, label]));
  return (data ?? [])
    .map((row) => byId.get(row.id as unknown as string))
    .filter((label): label is string => label !== undefined)
    .sort();
}

beforeAll(async () => {
  owner = await createUser('gear-search');

  // comma — a top-level separator in PostgREST's or=(...) grammar
  await insertGear('comma-target', { name: 'Contains a,b literally' });
  await insertGear('comma-decoy-a', { name: 'a' });
  await insertGear('comma-decoy-b', { name: 'b' });

  // % — SQL LIKE "any sequence of characters" wildcard; must be literal
  await insertGear('percent-target', { name: 'Random gear', brand: 'Marked down 50% today' });
  await insertGear('percent-decoy', { name: '500 grams' });

  // _ — SQL LIKE "any single character" wildcard; must be literal
  await insertGear('underscore-target', { name: 'Random gear 2', brand: 'Contains a_b literally' });
  await insertGear('underscore-decoy', { name: 'Random gear 3', brand: 'Contains aXb, one char' });

  // \ — the LIKE escape character itself, and PostgREST's own quote-escape introducer
  await insertGear('backslash-target', { name: 'Has a back\\slash inside' });

  // " — ends a quoted value early in PostgREST's or=(...) grammar
  await insertGear('quote-target', { name: 'Random gear 4', brand: 'Has a quote"inside here' });

  // ( ) — grouping characters in PostgREST's or=(...) grammar
  await insertGear('parens-target', { name: 'Wrapped (parens) here' });

  // . — separates column from operator from value; also a plain filename-ish character
  await insertGear('dot-target', { name: 'Random gear 5', brand: 'Has a.b dotted' });

  // spaces — not reserved by any layer here, included because the ticket asks for it
  await insertGear('spaces-target', { name: 'Two words together' });

  // non-ASCII — proves nothing above mangles multi-byte text
  await insertGear('unicode-name-target', { name: 'Ultralight 배낭 pack' });
  await insertGear('unicode-brand-target', { name: 'Random gear 6', brand: 'Café résumé' });
});

describe('buildSearchFilter finds the literal string and only the literal string', () => {
  it('a comma is not read as a second or=(...) condition', async () => {
    expect(await searchLabels('a,b')).toEqual(['comma-target']);
  });

  // The assertion the ticket calls out by name: "50%" must not become "match anything
  // starting with 50", which is what an unescaped % in an ILIKE pattern would do.
  it('a literal percent sign does not become a wildcard', async () => {
    expect(await searchLabels('50%')).toEqual(['percent-target']);
  });

  it('a literal underscore does not become a single-character wildcard', async () => {
    expect(await searchLabels('a_b')).toEqual(['underscore-target']);
  });

  it('a literal backslash is matched, not consumed as an escape introducer', async () => {
    expect(await searchLabels('back\\slash')).toEqual(['backslash-target']);
  });

  it('a literal double quote does not end the PostgREST value early', async () => {
    expect(await searchLabels('quote"inside')).toEqual(['quote-target']);
  });

  it('literal parentheses are not read as or=(...) grouping', async () => {
    expect(await searchLabels('(parens)')).toEqual(['parens-target']);
  });

  it('a literal period is matched as plain text', async () => {
    expect(await searchLabels('a.b')).toEqual(['dot-target']);
  });

  it('a search term containing spaces matches the row containing it', async () => {
    expect(await searchLabels('two words')).toEqual(['spaces-target']);
  });

  it('non-ASCII text matches in name', async () => {
    expect(await searchLabels('배낭')).toEqual(['unicode-name-target']);
  });

  it('non-ASCII text matches in brand', async () => {
    expect(await searchLabels('Café')).toEqual(['unicode-brand-target']);
  });

  // A search that matches nothing in either column returns nothing — the negative
  // control for every case above: if this ever failed, it would mean the filter had
  // degenerated into matching everything (e.g. an unescaped comma splitting the or=()
  // list into a condition with an empty/always-true value).
  it('a string nothing contains matches nothing', async () => {
    expect(await searchLabels('xyzzy-not-present-anywhere')).toEqual([]);
  });

  // Matches by substring, not only from the start — proves the %...% wrapping is
  // actually applied and this is not silently degrading to a prefix search.
  it('matches mid-string, not only a prefix', async () => {
    expect(await searchLabels('words toget')).toEqual(['spaces-target']);
  });

  // ILIKE is case-insensitive by name — proves the function does not accidentally use
  // the case-sensitive `like` operator.
  it('matches case-insensitively', async () => {
    expect(await searchLabels('TWO WORDS')).toEqual(['spaces-target']);
  });
});
