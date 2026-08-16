import { describe, expect, it } from 'vitest';
import {
  gearFormHrefReturningTo,
  gearReturnPathFromFormOrNull,
  gearReturnPathOrNull,
} from '../src/lib/gear/return-path';
import { GEAR_PATH } from '../src/lib/gear/routes';
import { NEXT_PARAM } from '../src/lib/auth-routes';

/**
 * `src/lib/gear/return-path.ts` is a thin fallback-swap over `safeNextPath`
 * (`src/lib/auth-routes.ts`), not a second open-redirect guard — see that module's own
 * doc comment for the full argument. This file exists to pin two things: that a
 * legitimate gear-closet URL round-trips unchanged, and that every hostile shape
 * `safeNextPath` refuses is refused here too, WITHOUT leaking `HOME_PATH` as though it
 * had been accepted — the exact bug the identity-check trick in `gearReturnPathOrNull`
 * is built to avoid. See `tests/safe-next-path.test.ts` for the guard's own coverage;
 * this file does not re-explain why each shape is dangerous.
 *
 * `/javascript:alert(1)` (leading slash AND a colon) is in every hostile table below for
 * the same reason `tests/safe-next-path.test.ts` carries its own "THE TABLE THAT LOOKED
 * FULL AND TESTED ONE CLAUSE" warning: `'javascript:alert(1)'` (no leading slash) is
 * refused by `safeNextPath`'s FIRST clause and never reaches the colon check, so a table
 * built only from inputs like it can go fully green after the colon check is deleted.
 * `/javascript:alert(1)` gets past the leading-slash check and is refused by nothing
 * else, so it is what actually pins that clause.
 */

describe('gearReturnPathOrNull', () => {
  it('round-trips a normal path with query and page unchanged', () => {
    const target = '/gear?q=tent&sort=name&page=3';
    expect(gearReturnPathOrNull(target)).toBe(target);
  });

  it('accepts "/" — a legitimate same-origin path, not a refusal wearing the fallback spelling', () => {
    expect(gearReturnPathOrNull('/')).toBe('/');
  });

  it.each([
    [null, null],
    [undefined, undefined],
    ['', ''],
  ])('returns null for %s', (_label, input) => {
    expect(gearReturnPathOrNull(input)).toBeNull();
  });

  it.each([
    ['an absolute URL to another origin', 'https://evil.example/steal'],
    ['a protocol-relative URL', '//evil.example'],
    ['a backslash-disguised host', '/\\evil.example'],
    ['a bare host with no leading slash', 'evil.example/x'],
    ['a javascript: scheme', 'javascript:alert(1)'],
    ['a javascript: scheme behind a leading slash', '/javascript:alert(1)'],
  ])('refuses %s (%s) rather than leaking it through', (_label, input) => {
    expect(gearReturnPathOrNull(input)).toBeNull();
  });
});

/**
 * `?? GEAR_PATH` AT THE POINT OF USE, because that is what the pages do. This module
 * briefly exported defaulted wrappers (`gearReturnPath`, `gearReturnPathFromForm`)
 * alongside the `*OrNull` pair; neither ever acquired a caller, because both pages need
 * the `null` — for the hidden `next` field, and for `[id].astro`'s successful-edit fork —
 * so they hold the `*OrNull` result and spell the fallback themselves. The wrappers were
 * deleted; this local mirrors the exact expression `new.astro` and `[id].astro` use for
 * `cancelHref`, so the table below still pins the destination a visitor actually gets.
 */
const returnPathOrDefault = (raw: string | null | undefined): string =>
  gearReturnPathOrNull(raw) ?? GEAR_PATH;

describe('gearReturnPathOrNull, defaulted the way the pages default it', () => {
  it('round-trips a normal path with query and page unchanged', () => {
    const target = '/gear?q=tent&sort=name&page=3';
    expect(returnPathOrDefault(target)).toBe(target);
  });

  it.each([
    [null, null],
    [undefined, undefined],
    ['', ''],
  ])('falls back to GEAR_PATH for %s', (_label, input) => {
    expect(returnPathOrDefault(input)).toBe(GEAR_PATH);
  });

  it('accepts "/" — a legitimate same-origin path', () => {
    expect(returnPathOrDefault('/')).toBe('/');
  });

  it.each([
    ['an absolute URL to another origin', 'https://evil.example/steal'],
    ['a protocol-relative URL', '//evil.example'],
    ['a backslash-disguised host', '/\\evil.example'],
    ['a bare host with no leading slash', 'evil.example/x'],
    ['a javascript: scheme', 'javascript:alert(1)'],
    ['a javascript: scheme behind a leading slash', '/javascript:alert(1)'],
  ])('falls back to GEAR_PATH for %s (%s), never returning it verbatim', (_label, input) => {
    expect(returnPathOrDefault(input)).toBe(GEAR_PATH);
  });
});

describe('gearReturnPathFromFormOrNull', () => {
  const url = (query = '') => new URL(`https://packsheet.io/gear/new${query}`);
  const form = (entries: Record<string, string>) => {
    const data = new FormData();
    for (const [name, value] of Object.entries(entries)) data.append(name, value);
    return data;
  };

  it('returns null when neither the form nor the query carries a value', () => {
    expect(gearReturnPathFromFormOrNull(form({}), url())).toBeNull();
  });

  it('returns the carried path when the form field is a valid same-origin path', () => {
    expect(gearReturnPathFromFormOrNull(form({ [NEXT_PARAM]: '/gear?sort=name' }), url())).toBe(
      '/gear?sort=name',
    );
  });

  it.each([
    ['an absolute URL to another origin', 'https://evil.example/steal'],
    ['a javascript: scheme behind a leading slash', '/javascript:alert(1)'],
  ])('returns null for a hostile carried value (%s)', (_label, value) => {
    expect(gearReturnPathFromFormOrNull(form({ [NEXT_PARAM]: value }), url())).toBeNull();
  });

  it('prefers the form field over the query string', () => {
    expect(
      gearReturnPathFromFormOrNull(
        form({ [NEXT_PARAM]: '/gear?sort=name' }),
        url('?next=/gear?page=2'),
      ),
    ).toBe('/gear?sort=name');
  });

  it('falls back to the query string when the form carries no field', () => {
    expect(gearReturnPathFromFormOrNull(form({}), url('?next=/gear?page=2'))).toBe('/gear?page=2');
  });

  it('returns null when the form field is absent and the query value is hostile', () => {
    expect(gearReturnPathFromFormOrNull(form({}), url('?next=/javascript:alert(1)'))).toBeNull();
  });

  // A file upload under that name is not a string. FormData.get returns a File for one,
  // and this must fall through to the query string rather than being handed to
  // safeNextPath as if it were the next value — mirrors nextFromForm's own
  // "ignores a non-string entry under that name" case in tests/safe-next-path.test.ts.
  it('falls through to the query string when the next field is a File, not a string', () => {
    const data = new FormData();
    data.append(NEXT_PARAM, new File(['x'], 'next.txt'));
    expect(gearReturnPathFromFormOrNull(data, url('?next=/gear?page=2'))).toBe('/gear?page=2');
  });
});

describe('gearFormHrefReturningTo', () => {
  it('appends with "?" when path has no query yet', () => {
    const href = gearFormHrefReturningTo('/gear/new', '/gear');
    expect(href).toBe(`/gear/new?${NEXT_PARAM}=%2Fgear`);
  });

  it('appends with "&" when path already carries a query', () => {
    const href = gearFormHrefReturningTo('/gear/new?foo=1', '/gear');
    expect(href).toBe(`/gear/new?foo=1&${NEXT_PARAM}=%2Fgear`);
  });

  it('round-trips a currentView containing "&", "#" and a space through the encoded param', () => {
    const currentView = '/gear?q=tent & poles#frag more';
    const href = gearFormHrefReturningTo('/gear/new', currentView);
    const roundTripped = new URL(href, 'https://packsheet.io').searchParams.get(NEXT_PARAM);
    expect(roundTripped).toBe(currentView);
  });
});

/**
 * PK-63 acceptance, criterion 3: "saving from page 3 of a search returns to page 3 of
 * that search." Every piece of that was already covered ALONE — the href builder encodes,
 * the reader validates — and the seam between them was covered by nothing, which is where
 * a feature like this actually breaks. This walks the whole path the way the pages do:
 * the closet builds the link, the browser hands the query back, the form page reads it.
 */
describe('the full return-path round trip (PK-63 acceptance criterion 3)', () => {
  it.each([
    ['a searched, sorted, paged closet view', '/gear?q=tent&sort=name&page=3'],
    ['a status-filtered view', '/gear?status=wishlist&status=retired'],
    ['a multi-word search, whose SPACE must survive both hops', '/gear?q=Alpha Tent&page=2'],
    ['the bare closet', '/gear'],
  ])('%s survives link-build -> parse -> validate', (_label, currentView) => {
    // 1. The closet list builds the link (index.astro's "Add item" / item-name links).
    const href = gearFormHrefReturningTo('/gear/new', currentView);

    // 2. The browser follows it; the form page reads `next` off its own URL.
    const carried = new URL(href, 'https://packsheet.io').searchParams.get(NEXT_PARAM);

    // 3. The form page validates it before ever redirecting there.
    expect(gearReturnPathOrNull(carried)).toBe(currentView);
  });

  it('refuses a hostile currentView at the far end, even though the builder encoded it happily', () => {
    // `gearFormHrefReturningTo` is not a guard and does not pretend to be — it encodes
    // whatever it is handed. The refusal has to come from the READ side, which is the
    // half this composition exists to prove is actually wired up.
    const href = gearFormHrefReturningTo('/gear/new', '//evil.example');
    const carried = new URL(href, 'https://packsheet.io').searchParams.get(NEXT_PARAM);
    expect(carried).toBe('//evil.example');
    expect(gearReturnPathOrNull(carried)).toBeNull();
  });
});
