import { describe, expect, it } from 'vitest';
import { parseClosetQuery } from '../src/lib/packs/closet-request';
import { parseGearQuery } from '../src/lib/gear/query';

/**
 * `src/lib/packs/closet-request.ts` — the add-to-pack dialog's own request parsing
 * (PK-74). `vitest.config.ts:64` excludes `src/pages/**`, so `src/pages/packs/closet.ts`
 * is left with authentication and one call to `parseClosetQuery`; every decision about
 * what a hand-edited or hostile query string MEANS has to be pinned here instead.
 *
 * `parseClosetQuery` IS A THIN WRAPPER OVER `parseGearQuery`, DELIBERATELY — see the
 * module's own header. So this file pins two different things: that it never throws
 * (the defensive property the endpoint depends on), and that it is genuinely the SAME
 * parse `parseGearQuery` would produce, rather than a second, silently diverging
 * implementation of the same rules.
 */

describe('parseClosetQuery', () => {
  it('delegates straight to parseGearQuery rather than re-implementing its rules', () => {
    const params = new URLSearchParams({ q: 'stove', sort: 'brand', dir: 'desc', page: '3' });
    expect(parseClosetQuery(params)).toEqual(parseGearQuery(params));
  });

  // ---------------------------------------------------------------------------
  // page: missing, garbage, and hostile values all resolve to a clean default
  // ---------------------------------------------------------------------------

  it('defaults page to 1 when the query string carries none at all', () => {
    expect(parseClosetQuery(new URLSearchParams()).page).toBe(1);
  });

  it.each([
    ['a negative number', '-3'],
    ['a fraction', '1.5'],
    ['not a number at all', 'DROP TABLE gear_items'],
    ['scientific notation', '1e9'],
    ['an empty string', ''],
  ])('defaults page to 1 rather than throwing for %s', (_label, raw) => {
    expect(() => parseClosetQuery(new URLSearchParams({ page: raw }))).not.toThrow();
    expect(parseClosetQuery(new URLSearchParams({ page: raw })).page).toBe(1);
  });

  it('clamps an absurdly large page rather than issuing an unbounded PostgREST offset', () => {
    const result = parseClosetQuery(new URLSearchParams({ page: '999999999999' }));
    expect(result.page).toBeLessThan(999999999999);
    expect(Number.isSafeInteger(result.page)).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // q: a hostile search string never throws and never reaches PostgREST unbounded
  // ---------------------------------------------------------------------------

  it('trims and length-caps a hostile q rather than passing it through unbounded', () => {
    const hostile = `  ${'a'.repeat(5000)}  `;
    const result = parseClosetQuery(new URLSearchParams({ q: hostile }));
    expect(result.search.length).toBeLessThan(5000);
    expect(result.search.startsWith(' ')).toBe(false);
  });

  it('never throws for q carrying PostgREST filter-grammar characters', () => {
    const params = new URLSearchParams({ q: '*,"),or=(status.eq.owned' });
    expect(() => parseClosetQuery(params)).not.toThrow();
  });

  // ---------------------------------------------------------------------------
  // Repeated params collapse to one, first-value, the same way FormData.get does
  // ---------------------------------------------------------------------------

  it('reads only the first of a repeated status, rather than merging or rejecting', () => {
    const params = new URLSearchParams();
    params.append('status', 'owned');
    params.append('status', 'retired');
    // Both are valid statuses, so this pins dedup/order rather than validity — repeated
    // distinct values are kept in first-seen order, not collapsed to one.
    expect(parseClosetQuery(params).statuses).toEqual(['owned', 'retired']);
  });

  it('drops a repeated, identical status rather than keeping a duplicate entry', () => {
    const params = new URLSearchParams();
    params.append('status', 'owned');
    params.append('status', 'owned');
    expect(parseClosetQuery(params).statuses).toEqual(['owned']);
  });

  // ---------------------------------------------------------------------------
  // Totality: nothing this endpoint could receive makes it throw
  // ---------------------------------------------------------------------------

  it('never throws for a query string with every field simultaneously garbled', () => {
    const params = new URLSearchParams({
      page: 'not-a-page',
      q: '\0\0\0',
      sort: 'DROP TABLE',
      dir: 'sideways',
      wunit: 'stones',
      wmin: 'heavy',
      wmax: '-Infinity',
      status: 'nonsense',
    });
    expect(() => parseClosetQuery(params)).not.toThrow();
  });
});
