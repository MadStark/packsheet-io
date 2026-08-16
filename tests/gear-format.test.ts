import { describe, expect, it } from 'vitest';
import { formatGearAcquiredOn, formatGearPrice, formatGearStatus } from '../src/lib/gear/format';
import { GEAR_STATUSES } from '../src/lib/gear/fields';

/**
 * `src/lib/gear/format.ts`'s `formatGearPrice` — see that module's own comment for why
 * each of the three no-price cases is real and reachable rather than defensive
 * paranoia, and `tests/money.test.ts` for the `formatMoney`/`fromDecimal` behaviour
 * this wraps rather than re-implements.
 */

describe('formatGearPrice', () => {
  it('renders a GBP price using formatMoney/fromDecimal', () => {
    expect(formatGearPrice(129.99, 'GBP')).toBe('£129.99');
  });

  it('renders a zero-decimal currency (JPY) without inventing a decimal point', () => {
    expect(formatGearPrice(1050, 'JPY')).toBe('JP¥1,050');
  });

  it('returns the no-price label when price is null', () => {
    expect(formatGearPrice(null, null)).toBe('—');
  });

  it('returns the no-price label when currency is null but price is not (defensive — not reachable through gear_items_price_has_currency)', () => {
    expect(formatGearPrice(10, null)).toBe('—');
  });

  it('returns the no-price label for a currency that fails isCurrencyCode rather than throwing', () => {
    expect(formatGearPrice(10, 'gbp')).toBe('—');
    expect(formatGearPrice(10, '£')).toBe('—');
    expect(formatGearPrice(10, 'GBPX')).toBe('—');
    expect(formatGearPrice(10, '')).toBe('—');
  });
});

describe('formatGearStatus', () => {
  it('renders the human label for every declared GearStatus', () => {
    for (const status of GEAR_STATUSES) {
      expect(formatGearStatus(status)).toBeTruthy();
    }
    expect(formatGearStatus('owned')).toBe('Owned');
    expect(formatGearStatus('wishlist')).toBe('Wishlist');
    expect(formatGearStatus('retired')).toBe('Retired');
  });

  it('falls back to the raw string for a value isGearStatus rejects, rather than throwing', () => {
    expect(formatGearStatus('in-use')).toBe('in-use');
    expect(formatGearStatus('')).toBe('');
  });
});

/**
 * `formatGearAcquiredOn` (PK-61). Unlike `formatGearPrice`'s three no-price cases —
 * each one guarding against a value that is well-formed-but-suspect — `acquired_on`
 * has exactly one no-value case, and it is not suspect at all: the column is nullable
 * with no database default, so `null` is the ordinary "I don't know when I got this"
 * answer, not a data problem to defend against. See that function's own module comment
 * for why this still earns a named function rather than being inlined at the call site.
 */
describe('formatGearAcquiredOn', () => {
  it('renders a present date as-is, with no reformatting', () => {
    expect(formatGearAcquiredOn('2026-08-13')).toBe('2026-08-13');
  });

  it('renders null as the no-date em dash', () => {
    expect(formatGearAcquiredOn(null)).toBe('—');
  });
});
