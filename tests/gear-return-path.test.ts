import { describe, expect, it } from 'vitest';
import {
  gearReturnPath,
  gearReturnPathFromForm,
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

  it('refuses a hostile form field, falling back to GEAR_PATH rather than leaking it', () => {
    expect(
      gearReturnPathFromForm(form({ [NEXT_PARAM]: 'https://evil.example/steal' }), url()),
    ).toBe(GEAR_PATH);
  });
});
