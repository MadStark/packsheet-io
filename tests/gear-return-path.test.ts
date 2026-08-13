import { describe, expect, it } from 'vitest';
import {
  gearFormHrefReturningTo,
  gearReturnPath,
  gearReturnPathFromForm,
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

describe('gearReturnPath', () => {
  it('round-trips a normal path with query and page unchanged', () => {
    const target = '/gear?q=tent&sort=name&page=3';
    expect(gearReturnPath(target)).toBe(target);
  });

  it.each([
    [null, null],
    [undefined, undefined],
    ['', ''],
  ])('falls back to GEAR_PATH for %s', (_label, input) => {
    expect(gearReturnPath(input)).toBe(GEAR_PATH);
  });

  it('accepts "/" — a legitimate same-origin path', () => {
    expect(gearReturnPath('/')).toBe('/');
  });

  it.each([
    ['an absolute URL to another origin', 'https://evil.example/steal'],
    ['a protocol-relative URL', '//evil.example'],
    ['a backslash-disguised host', '/\\evil.example'],
    ['a bare host with no leading slash', 'evil.example/x'],
    ['a javascript: scheme', 'javascript:alert(1)'],
    ['a javascript: scheme behind a leading slash', '/javascript:alert(1)'],
  ])('falls back to GEAR_PATH for %s (%s), never returning it verbatim', (_label, input) => {
    expect(gearReturnPath(input)).toBe(GEAR_PATH);
  });
});

describe('gearReturnPathFromForm', () => {
  const url = (query = '') => new URL(`https://packsheet.io/gear/new${query}`);
  const form = (entries: Record<string, string>) => {
    const data = new FormData();
    for (const [name, value] of Object.entries(entries)) data.append(name, value);
    return data;
  };

  it('prefers the form field over the query string', () => {
    expect(
      gearReturnPathFromForm(form({ [NEXT_PARAM]: '/gear?sort=name' }), url('?next=/gear?page=2')),
    ).toBe('/gear?sort=name');
  });

  it('falls back to the query string when the form carries no field', () => {
    expect(gearReturnPathFromForm(form({}), url('?next=/gear?page=2'))).toBe('/gear?page=2');
  });

  it('falls back to GEAR_PATH when neither the form nor the query carries one', () => {
    expect(gearReturnPathFromForm(form({}), url())).toBe(GEAR_PATH);
  });

  it('falls back to GEAR_PATH when the form field is absent and the query value is hostile', () => {
    expect(gearReturnPathFromForm(form({}), url('?next=/javascript:alert(1)'))).toBe(GEAR_PATH);
  });

  it.each([
    ['a protocol-relative URL', '//evil.example'],
    ['an absolute URL to another origin', 'https://evil.example/steal'],
    ['a javascript: scheme behind a leading slash', '/javascript:alert(1)'],
    ['a backslash-disguised host', '/\\evil.example'],
  ])(
    'refuses a hostile form field (%s), falling back to GEAR_PATH rather than leaking it',
    (_label, value) => {
      expect(gearReturnPathFromForm(form({ [NEXT_PARAM]: value }), url())).toBe(GEAR_PATH);
    },
  );

  // A file upload under that name is not a string. FormData.get returns a File for one,
  // and this must fall through to the query string rather than being handed to
  // safeNextPath as if it were the next value — mirrors nextFromForm's own
  // "ignores a non-string entry under that name" case in tests/safe-next-path.test.ts.
  it('falls through to the query string when the next field is a File, not a string', () => {
    const data = new FormData();
    data.append(NEXT_PARAM, new File(['x'], 'next.txt'));
    expect(gearReturnPathFromForm(data, url('?next=/gear?page=2'))).toBe('/gear?page=2');
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
