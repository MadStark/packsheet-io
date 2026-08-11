import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOCALE,
  formatMoney,
  fromDecimal,
  isCurrencyCode,
  makeMoney,
  sumByCurrency,
  type CurrencyCode,
  type Money,
} from '../src/lib/money';

/**
 * `src/lib/money.ts` is the currency half of the units-and-money engine (Ref 23); read
 * that file's module comment first, in particular "A PRICE WITHOUT A CURRENCY IS NOT A
 * HALF-FILLED MONEY", "CROSS-CURRENCY SUMMING IS IMPOSSIBLE" and "WELL-FORMED BUT NOT
 * REAL" — several tests below exist specifically to hold those decisions in place
 * rather than to restate what the code plainly does.
 *
 * ---------------------------------------------------------------------------
 * ON NOT BUILDING "THE TABLE THAT LOOKED FULL AND TESTED ONE CLAUSE"
 * ---------------------------------------------------------------------------
 *
 * tests/safe-next-path.test.ts describes a real defect: a rejection table that read as
 * thorough but, because every case failed the same first check, exercised only one
 * clause of a four-clause function. `isCurrencyCode` has a single clause (the regexp),
 * so that particular trap does not apply to it directly — but the equivalent mistake
 * here would be a rejection table where every case fails on TYPE (`typeof value ===
 * 'string'`) and none actually reaches the regexp test. The comments on each rejected
 * case below say which part of the guard is the one actually doing the refusing, so
 * that claim is checkable rather than assumed.
 *
 * Helper to normalise `Intl`'s currency-formatted output for assertions. `Intl` inserts
 * U+00A0 (NO-BREAK SPACE) or U+202F (NARROW NO-BREAK SPACE) between a symbol/code and
 * an amount in several locales, both invisible in an ordinary source file. Rather than
 * type the escape into every literal, every assertion below normalises BOTH sides —
 * actual output and expected literal — through the same function, so the normalisation
 * cannot hide a real difference: two strings that differ only by which no-break
 * character they use still compare equal after normalising, which is correct (that
 * distinction is not what any test here is checking), but two strings that differ in
 * digits, symbol or separator placement still fail, because normalising whitespace
 * variants does not touch any of those.
 */
function normaliseSpaces(value: string): string {
  return value.replace(/[\u00A0\u202F]/g, ' ');
}

function expectFormatted(actual: string, expected: string): void {
  expect(normaliseSpaces(actual)).toBe(normaliseSpaces(expected));
}

// A currency already validated once, for tests that only care about Money/formatting
// behaviour and would otherwise repeat the same `as CurrencyCode` cast everywhere.
const GBP = 'GBP' as CurrencyCode;
const USD = 'USD' as CurrencyCode;
const EUR = 'EUR' as CurrencyCode;
const JPY = 'JPY' as CurrencyCode;

describe('isCurrencyCode', () => {
  it.each([
    ['GBP', 'GBP'],
    ['USD', 'USD'],
    ['EUR', 'EUR'],
    ['JPY', 'JPY'],
  ])('accepts %s as a CurrencyCode', (_label, value) => {
    expect(isCurrencyCode(value)).toBe(true);
  });

  // Each case is annotated with the one thing that actually refuses it, so a table that
  // looked thorough but only ever exercised "is it a string at all" would be visible as
  // such: only the first two below fail on typeof, everything after gets past that and
  // is refused by the regexp itself.
  it.each([
    // Fails the length/case regexp: lowercase is not what `^[A-Z]{3}$` matches, and
    // Postgres's own CHECK constraint is exactly as case-sensitive — collation does not
    // lower-case a char(3) column for you.
    ['lowercase', 'gbp'],
    // Fails the regexp on character class: a symbol, not a letter — the precise mistake
    // the migration's column comment names as the reason char(3) exists at all.
    ['a currency symbol', '£'],
    // Fails the regexp on length: one character too many.
    ['a four-letter near-miss', 'GBPX'],
    // Fails the regexp on length: one character too few.
    ['a two-letter near-miss', 'GB'],
    // Fails the regexp: the empty string matches no quantifier requiring 3 characters.
    ['the empty string', ''],
  ])('rejects %s (%s) via the regexp, having passed the typeof check', (_label, value) => {
    expect(typeof value).toBe('string');
    expect(isCurrencyCode(value)).toBe(false);
  });

  // These are refused by `typeof value === 'string'` before the regexp is ever reached
  // — the case the comment above says NOT to let every rejection collapse into.
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a number', 3],
    ['an object', { code: 'GBP' }],
  ])('rejects %s via the typeof check', (_label, value) => {
    expect(isCurrencyCode(value)).toBe(false);
  });
});

describe('makeMoney', () => {
  it('pairs an amount and a currency into one value', () => {
    const money = makeMoney(1050, GBP);
    expect(money).toEqual<Money>({ amountMinorUnits: 1050, currency: GBP });
  });

  // Mirrors units.ts's "THROW, NOT RETURN" rule: 0 is not a safe stand-in for "unknown
  // price", and a NaN or Infinity amount would poison a rollup exactly as a bad weight
  // poisons a total. Each bad value is listed separately, as units.test.ts does, so a
  // guard mistakenly written as `Number.isNaN` (which lets both infinities through)
  // could not hide behind a single combined case.
  it.each([
    ['NaN', NaN],
    ['positive Infinity', Infinity],
    ['negative Infinity', -Infinity],
  ])('throws for %s', (_label, value) => {
    expect(() => makeMoney(value, GBP)).toThrow(RangeError);
  });

  it('does not reject ordinary finite values, including zero', () => {
    expect(() => makeMoney(0, GBP)).not.toThrow();
  });
});

describe('fromDecimal', () => {
  // Pins the two-decimal case (GBP/USD/EUR: 100 minor units per major unit) against the
  // zero-decimal case (JPY: 1 minor unit per major unit) in the same table, so a
  // formatter that hardcodes "amount * 100" would pass the first three rows and fail
  // only the one that matters.
  it.each([
    ['GBP', GBP, 12.5, 1250],
    ['USD', USD, 1, 100],
    ['EUR', EUR, 0.01, 1],
    ['JPY (zero-decimal)', JPY, 1050, 1050],
  ])(
    'converts a %s decimal amount to minor units using the currency’s own scale',
    (_label, currency, decimal, expectedMinorUnits) => {
      expect(fromDecimal(decimal, currency).amountMinorUnits).toBe(expectedMinorUnits);
    },
  );

  it.each([
    ['NaN', NaN],
    ['positive Infinity', Infinity],
    ['negative Infinity', -Infinity],
  ])('throws for %s', (_label, value) => {
    expect(() => fromDecimal(value, GBP)).toThrow(RangeError);
  });
});

describe('formatMoney: multi-currency rendering', () => {
  // The currency code alone drives symbol and fraction digits; none of these hand
  // formatMoney anything besides amount + currency, and each renders differently,
  // which is the whole "no hardcoded table of our own" claim made concrete.
  // Under en-GB, USD and JPY render with a "US"/"JP" prefix ahead of the bare $/¥
  // symbol — en-GB's own currency is GBP, so Intl disambiguates a foreign dollar or
  // yen from a reader's own rather than assuming which "$" or "¥" is meant. That is
  // exactly the kind of locale-dependent detail this table exists to pin rather than
  // guess at.
  it.each([
    ['GBP', makeMoney(123_450, GBP), '£1,234.50'],
    ['USD', makeMoney(123_450, USD), 'US$1,234.50'],
    ['EUR', makeMoney(123_450, EUR), '€1,234.50'],
  ])('formats %s with two decimal places', (_label, money, expected) => {
    expectFormatted(formatMoney(money), expected);
  });

  // The zero-decimal-currency requirement, called out explicitly in the ticket: a
  // formatter that hardcodes two decimals looks correct for GBP/USD/EUR above and is
  // wrong here. ¥1,050 stored as 1050 minor units (see fromDecimal's JPY case) must
  // render with NO fractional part, not "JP¥1,050.00".
  it('formats JPY with zero decimal places, not two', () => {
    expectFormatted(formatMoney(makeMoney(1050, JPY)), 'JP¥1,050');
  });

  // A zero amount is not a suspicious value to a formatter — only non-finite amounts
  // are rejected, at makeMoney/fromDecimal, not here.
  it('formats a zero amount', () => {
    expectFormatted(formatMoney(makeMoney(0, GBP)), '£0.00');
  });
});

describe('formatMoney: locale determinism', () => {
  // Pins DEFAULT_LOCALE's actual value AND that formatMoney genuinely uses it when no
  // locale is passed, rather than merely documenting an intention. If a future edit
  // changed the fallback to `undefined` (i.e. "let Intl.NumberFormat pick the runtime's
  // own default"), this is the test that would catch it turning nondeterministic —
  // though only on a machine whose runtime default differs from en-GB, which is
  // exactly the failure mode the module comment describes as never reproducing
  // locally. The comparison against an explicit `en-GB` call below is what makes this
  // test meaningful regardless of the machine it runs on.
  it('is en-GB', () => {
    expect(DEFAULT_LOCALE).toBe('en-GB');
  });

  it('formats identically with no locale argument and with an explicit en-GB argument', () => {
    const money = makeMoney(123_450, GBP);
    expect(formatMoney(money)).toBe(formatMoney(money, 'en-GB'));
  });

  // A different explicit locale genuinely changes the rendering — proving the default
  // is not merely ignored in favour of some other fixed behaviour, and that a caller
  // who does have a real per-visitor locale can actually use it.
  it('renders differently under an explicit non-default locale', () => {
    const money = makeMoney(123_450, EUR);
    const enGB = formatMoney(money, 'en-GB');
    const deDE = formatMoney(money, 'de-DE');
    expect(normaliseSpaces(enGB)).not.toBe(normaliseSpaces(deDE));
    // de-DE uses a period as the thousands separator and a comma as the decimal point
    // — the exact "£1,234.50 on one machine, £1.234,50 on another" divergence the
    // module comment warns a runtime-default locale would introduce silently.
    expectFormatted(deDE, '1.234,50 €');
  });
});

describe('formatMoney: well-formed but not real currency codes', () => {
  // 'ZZZ' is reserved by ISO 4217 precisely so it is never assigned to a real
  // currency, but it passes isCurrencyCode's shape check exactly as 'GBP' does. This
  // pins the documented decision: passthrough, not a thrown error, with the code
  // itself standing in as its own symbol.
  it('renders the code itself as the symbol, without throwing', () => {
    const money = makeMoney(1000, 'ZZZ' as CurrencyCode);
    expect(() => formatMoney(money)).not.toThrow();
    expectFormatted(formatMoney(money), 'ZZZ 10.00');
  });
});

describe('sumByCurrency', () => {
  it('returns an empty map for an empty list', () => {
    const totals = sumByCurrency([]);
    expect(totals.size).toBe(0);
  });

  it('sums same-currency amounts into a single entry', () => {
    const totals = sumByCurrency([makeMoney(1000, GBP), makeMoney(500, GBP)]);
    expect(totals.get(GBP)).toBe(1500);
    expect(totals.size).toBe(1);
  });

  // The load-bearing case: a genuinely mixed-currency list. Nothing here collapses to
  // one number in one currency — each currency present gets its own untouched total,
  // which is the entire reason sum(): Money must not exist alongside this function (see
  // the module comment).
  it('keeps a genuinely mixed-currency list separated by currency, never combined', () => {
    const totals = sumByCurrency([
      makeMoney(1000, GBP),
      makeMoney(2500, USD),
      makeMoney(1000, GBP),
      makeMoney(750, EUR),
      makeMoney(500, USD),
    ]);
    expect(totals.get(GBP)).toBe(2000);
    expect(totals.get(USD)).toBe(3000);
    expect(totals.get(EUR)).toBe(750);
    expect(totals.size).toBe(3);
  });

  // A single-currency list is the case a silent "just add a sum()" shortcut would get
  // away with — pinned here so it stays correct, not as evidence the shortcut is safe.
  it('handles a single-currency list', () => {
    const totals = sumByCurrency([makeMoney(100, JPY)]);
    expect(totals.get(JPY)).toBe(100);
    expect(totals.size).toBe(1);
  });
});
