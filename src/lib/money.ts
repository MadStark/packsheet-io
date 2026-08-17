/**
 * The currency and formatting engine (Ref 23 — "Units and weight engine (pure
 * functions)"). `src/lib/units.ts` is the weight half of that promise; this is the
 * money half. Read that file's module comment first — the two are meant to read as one
 * engine, and this one repeats none of the reasoning that carries over unchanged: pure
 * functions only, no I/O, no framework import, no Supabase client.
 *
 * ---------------------------------------------------------------------------
 * A PRICE WITHOUT A CURRENCY IS NOT A HALF-FILLED MONEY, IT IS NOT A MONEY
 * ---------------------------------------------------------------------------
 *
 * `supabase/migrations/20260810120000_core_schema.sql` puts it plainly on
 * `gear_items`: "A price without its currency is a number no formatter can render, and
 * a currency without a price is a unit with nothing to measure." The schema enforces
 * that at rest with `gear_items_price_has_currency check ((price is null) = (currency
 * is null))` — a row can have both or neither, never one. This module enforces the
 * same invariant in memory, and it does so with a type rather than a convention: there
 * is no function anywhere below that takes an `amount: number` and a `currency:
 * string` as two loose, independently-omittable arguments, because two arguments that
 * must agree are a standing invitation for a call site to pass one without the other
 * and have the compiler wave it through. `Money` bundles them into one value.
 *
 * WHAT ACTUALLY DOES THE ENFORCING IS THE `CurrencyCode` BRAND, not the number of
 * constructors — and that is worth being exact about, because the tempting claim ("the
 * only way to make a `Money` is `makeMoney`") is not true and would mislead anyone
 * relying on it. `fromDecimal` returns one too, and `Money` is an ordinary exported
 * interface, so an object literal with the right two fields satisfies it structurally
 * and no amount of constructor discipline can stop that. What such a literal CANNOT do
 * is name a currency: `currency` is `CurrencyCode`, a branded string, so the only route
 * from a database `string | null` to something that type-checks runs through
 * `isCurrencyCode`. An `as CurrencyCode` cast still gets past it — nothing in
 * TypeScript can stop that — but a cast is a deliberate act sitting in the diff, which
 * is exactly what an accidentally-omitted currency is not. A half-pair is
 * unrepresentable because the currency half cannot be arrived at by accident, not
 * because the pair has one door.
 *
 * ---------------------------------------------------------------------------
 * WHY A CURRENCY-CODE GUARD, GIVEN THAT THE DATABASE ALREADY CHECKS IT
 * ---------------------------------------------------------------------------
 *
 * `gear_items.currency` is `char(3) check (currency ~ '^[A-Z]{3}$')` — ISO 4217
 * alphabetic codes, chosen (per that column's comment) "so a currency symbol or a
 * stray name fails on entry instead of reaching a formatter that has to guess." That
 * defends the database. It does nothing for a value that has already left it: a row
 * read back through the Data API is typed merely as `string | null` by every client
 * that fetches it, same as `profiles.weight_units` before `isWeightSystem`. `isCurrencyCode` is
 * this module's half of that same defence, mirroring the CHECK constraint's own regexp
 * so the two cannot silently drift apart — see the comment on the constant below.
 *
 * ---------------------------------------------------------------------------
 * CROSS-CURRENCY SUMMING IS IMPOSSIBLE, NOT MERELY DISCOURAGED
 * ---------------------------------------------------------------------------
 *
 * A pack can hold gear priced in GBP, USD and EUR at once — nothing stops a user
 * buying a tent in one currency and a stove in another. This product carries no
 * exchange rates, and it never should acquire an implicit one: a rate goes stale the
 * moment it is fetched, and a total computed from a stale rate is not an estimate that
 * happens to be imprecise, it is a specific wrong number rendered with exactly the same
 * confidence as a correct one — the same failure mode `units.ts` describes for a bad
 * weight, except here there is no "loudly stop" available, because summing £10 and $10
 * is not an invalid computation, it is a computation with no single right answer.
 *
 * The API reflects that by construction: there is no `sum(monies: Money[]): Money`
 * anywhere in this file, and there must never be one added, because such a function
 * would have to invent a currency to return the total in — pick the first item's
 * currency and silently mislabel the rest, pick the most common one, or throw on sight
 * of a second currency and take away the ability to even inspect a mixed pack's costs.
 * All three are worse than the truth. `sumByCurrency` instead returns a map keyed by
 * currency code, one `Money` total per currency actually present, so a pack with two GBP
 * items and one USD item yields `{ GBP: …, USD: … }` — a correct answer to the question that
 * was actually asked, rather than a single plausible-looking number that answers a
 * question nobody could have posed correctly in the first place. `src/lib/totals.ts`
 * renders nothing at all: it carries that map through to its own `PackTotals` and
 * leaves the choice between several lines and an explicit "mixed currencies" notice to
 * whatever eventually shows a pack's cost. This module only has to make the wrong
 * shortcut impossible to reach for.
 *
 * A later contributor WILL look at this and be tempted to "simplify" it into a single
 * total, especially once every pack in a test fixture happens to hold one currency.
 * Resist that. The one-currency case is exactly the case where the difference is
 * invisible in testing and the multi-currency case is exactly the case a silent
 * shortcut gets wrong.
 *
 * ---------------------------------------------------------------------------
 * WELL-FORMED BUT NOT REAL: WHAT HAPPENS TO 'ZZZ'
 * ---------------------------------------------------------------------------
 *
 * `isCurrencyCode` and the database CHECK it mirrors both validate SHAPE — three
 * uppercase letters — not membership of the actual ISO 4217 currency list. `'ZZZ'` is
 * reserved by the standard precisely so it never becomes a real currency, but it
 * passes `^[A-Z]{3}$` exactly as `'GBP'` does, and so does any three-letter code ISO
 * 4217 has not (yet, or ever) assigned. `Intl.NumberFormat` does not throw for these —
 * confirmed directly: `new Intl.NumberFormat('en-GB', { style: 'currency', currency:
 * 'ZZZ' }).format(10)` returns `'ZZZ 10.00'`, the code itself standing in as its own
 * symbol, with a default of two fraction digits.
 *
 * This module lets that pass through rather than refusing it, for two reasons taken
 * together. First, refusing it would require this module to carry its own table of
 * "real" ISO 4217 codes, kept in step with a standard that is amended by an
 * international body on its own schedule — exactly the kind of hand-maintained table
 * `units.ts` argues against for unit-conversion factors, for the same reason: a table
 * that can drift from the truth it is meant to encode is worse than deferring to the
 * one piece of the platform whose job that already is. `Intl.NumberFormat`'s own
 * currency data is maintained by ICU and updated with the runtime, which a bespoke
 * allowlist in this repository never would be. Second, and more fundamentally, `'ZZZ'`
 * reaching this function at all means it already passed the database CHECK constraint
 * on write — refusing it here, downstream, would not stop a bad value from being
 * stored, it would only make it un-renderable once stored, turning a data-entry
 * mistake into a rendering crash on every future read. If tighter validation is wanted,
 * it belongs where the value is first accepted (the entry form, or a future CHECK
 * constraint enumerating real codes), not silently in the formatter three steps later.
 * `'ZZZ 10.00'` rendered plainly is an honest, debuggable symptom of bad input; a thrown
 * exception on the public share page is an outage.
 */

/**
 * The regexp `gear_items.currency` is checked against in
 * `supabase/migrations/20260810120000_core_schema.sql`: `check (currency ~
 * '^[A-Z]{3}$')`. Named here, once, exactly as that migration spells it, rather than
 * re-derived — the two files have no shared import, so keeping the pattern textually
 * identical is the only thing that keeps them from drifting apart the way
 * `WEIGHT_SYSTEMS` and `profiles.weight_units`' CHECK constraint are kept in step in
 * `units.ts`. (That pairing was `WEIGHT_UNITS` and `gear_items.weight_unit` until PK-67
 * removed the column.)
 */
const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;

/**
 * An ISO 4217 alphabetic currency code, narrowed from `string` by `isCurrencyCode`.
 * This says nothing about whether the code names a currency that actually exists —
 * see `isCurrencyCode`'s own comment for why that question is deliberately left to
 * `Intl.NumberFormat` rather than answered here.
 */
export type CurrencyCode = string & { readonly __brand: 'CurrencyCode' };

/**
 * `currency` arrives from the database — and from any form field before it ever
 * reaches the database — typed merely as `string | null`. This is the narrowing guard
 * that turns that string into a `CurrencyCode` the compiler will hold `makeMoney` to,
 * mirroring the CHECK constraint exactly: three uppercase ASCII letters, no more, no
 * fewer. `'gbp'` (lowercase — the CHECK constraint's `[A-Z]` is case-sensitive, and
 * Postgres collation does not lower-case a `char(3)` for you), `'£'` (a symbol, the
 * exact mistake the column comment names), `'GBPX'` and `'GB'` (wrong length) and `''`
 * are all the kind of near-miss a human types into a free-text field, and all of them
 * must fail this exactly as a bare typo would.
 */
export function isCurrencyCode(value: unknown): value is CurrencyCode {
  return typeof value === 'string' && CURRENCY_CODE_PATTERN.test(value);
}

/**
 * A price inseparable from the currency it is denominated in — see the module comment
 * for why this is a single value object rather than two arguments. `amountMinorUnits`
 * is not, despite the name, always cents: it is the smallest unit `Intl.NumberFormat`
 * treats the currency as having, which is what `formatMoney` needs and what
 * `gear_items.price numeric(12, 2)` already stores (two decimal places, i.e. minor
 * units, for every currency the schema accepts — see `fromDecimal` below for the
 * zero-decimal-currency wrinkle that follows from storing everything at scale 2
 * regardless of the currency's own convention).
 */
export interface Money {
  readonly amountMinorUnits: number;
  readonly currency: CurrencyCode;
}

/**
 * Builds a `Money` from an amount already expressed in minor units (pence, cents — the
 * integer a formatter divides by 10^fractionDigits) and a `CurrencyCode`.
 *
 * `fromDecimal` is the other exported constructor — this module has two, one per scale —
 * and it does not build a `Money` of its own: it converts and then calls this function,
 * so everything guarded below is guarded on both entry paths. Adding a third constructor
 * that assembles the object literal directly is the thing to refuse, not a second name.
 * What makes the PAIRING safe is neither of them but the `CurrencyCode` parameter type;
 * see the module comment's first section. `amount` is validated the same way
 * `units.ts` validates a weight — see that file's "THROW, NOT RETURN" section, which
 * applies here unchanged: 0 is not a safe stand-in for "unknown", and a NaN or
 * Infinity price would poison every rollup it touches exactly as a NaN weight would.
 *
 * MINOR UNITS ARE INTEGERS, AND THAT IS ENFORCED HERE RATHER THAN ASSUMED. Two doc
 * comments in this codebase already REASON FROM the integrality of a `Money` amount:
 * `computeItemTotals` in `src/lib/totals.ts` says a line price "needs no rounding of
 * its own" because an integer times an integer quantity stays one, and `sumByCurrency`
 * below is described as exact and order-independent for the same reason. Neither claim
 * survives a fractional amount, and until this check existed nothing made either true.
 *
 * The failure it stops is the decimal/minor-unit confusion arriving through the
 * constructor meant to be the safe one: `makeMoney(42.50, GBP)` reads as "forty-two
 * pounds fifty" to anybody writing it, and renders as `£0.43` — the same 100× error
 * `fromDecimal` exists to prevent, entered one function to the left. A decimal amount
 * has a constructor of its own; this one takes the integer.
 *
 * NEGATIVE AMOUNTS ARE REFUSED, mirroring `gear_items.price check (price >= 0 and price
 * < 'Infinity'::numeric)` the way `isCurrencyCode` mirrors that column's regexp. This
 * product prices gear; it has no refunds, no credits and no liabilities, so there is no
 * legitimate negative `Money` for it to construct today. If one ever exists — a
 * discount line, say — it should arrive as a deliberate change to this guard and to the
 * column it mirrors, not as a value that slipped past both.
 */
export function makeMoney(amountMinorUnits: number, currency: CurrencyCode): Money {
  if (!Number.isFinite(amountMinorUnits)) {
    throw new RangeError(`amountMinorUnits must be a finite number, got ${amountMinorUnits}`);
  }
  // `Number.isFinite` above would be redundant under `Number.isInteger` alone, which is
  // false for NaN and both infinities too. It is kept because it is the check that
  // produces the RIGHT MESSAGE for those three: "42.5 is not a whole number of minor
  // units" would be a confusing thing to be told about NaN.
  if (!Number.isInteger(amountMinorUnits)) {
    throw new RangeError(
      `amountMinorUnits must be a whole number of minor units, got ${amountMinorUnits}. ` +
        `A decimal major-unit amount such as 42.50 goes through fromDecimal, which asks Intl ` +
        `how many minor units the currency actually has; passing it here would render as £0.43.`,
    );
  }
  if (amountMinorUnits < 0) {
    throw new RangeError(
      `amountMinorUnits must not be negative, got ${amountMinorUnits}. ` +
        `gear_items.price carries check (price >= 0), and this product has no refunds, ` +
        `credits or liabilities for a negative price to mean.`,
    );
  }
  return { amountMinorUnits, currency };
}

/**
 * Builds a `Money` from a decimal amount as `gear_items.price numeric(12, 2)` actually
 * stores it — e.g. `12.50`, meaning twelve pounds fifty — converting to the minor-unit
 * integer `makeMoney` and `formatMoney` work with. This is deliberately NOT the same
 * scale-2-always assumption the column makes: `numeric(12, 2)` stores every currency
 * at two decimal places regardless of that currency's own minor-unit convention, which
 * is exactly right for GBP/USD/EUR (100 minor units to 1 major unit) and WRONG for a
 * zero-decimal currency such as JPY or KRW, where 1 major unit already IS the smallest
 * unit — ¥100 is ¥100, not ¥1.00 of something smaller. Multiplying every stored price
 * by 100 to reach "minor units" would silently turn a ¥100 row into ¥10,000 the first
 * time a JPY gear item was priced.
 *
 * The fix is to ask `Intl.NumberFormat` how many fraction digits the currency actually
 * uses — through `currencyFormat`, literally the same call `formatMoney` renders with —
 * rather than hardcoding 2 here and being wrong for the currencies that are not GBP, USD
 * or EUR. See the zero-decimal-currency test for the case this exists to get right.
 *
 * `Math.round` is what makes the result an INTEGER, and it is load-bearing rather than
 * defensive tidying: `1.10 * 100` is `110.00000000000001` in binary floating point, which
 * `makeMoney`'s integrality check would refuse outright — and, if it did not, would break
 * the two comments that reason from minor units being integers (a line price needing no
 * rounding of its own, and `sumByCurrency` being exact and order-independent). Prices
 * arrive from `numeric(12, 2)`, so the rounding never has more than a representation
 * error to absorb; tests/money.test.ts pins `1.1` for exactly that reason.
 */
export function fromDecimal(amount: number, currency: CurrencyCode): Money {
  if (!Number.isFinite(amount)) {
    throw new RangeError(`amount must be a finite number, got ${amount}`);
  }
  return makeMoney(
    Math.round(amount * 10 ** currencyFormat(currency, DEFAULT_LOCALE).fractionDigits),
    currency,
  );
}

/**
 * A currency-style `Intl.NumberFormat` and the number of fraction digits it resolved to,
 * built together and returned together — 2 for GBP/USD/EUR, 0 for JPY/KRW, 3 for BHD,
 * read from `Intl` itself rather than from a table this module would have to keep in step
 * with ISO 4217's own minor-unit assignments.
 *
 * THE TWO ARE RETURNED TOGETHER BECAUSE THE SCALE MUST BE THE ONE THE FORMATTER ITSELF
 * WILL USE. `fromDecimal` multiplies a major-unit decimal UP by 10^n on the way in and
 * `formatMoney` divides a minor-unit integer back DOWN by 10^n on the way out, so the two
 * are inverses only while they agree about n. This function is the single place n is ever
 * decided; the alternative it replaces had `formatMoney` construct its own
 * `Intl.NumberFormat` and read `resolvedOptions().maximumFractionDigits` itself, which
 * was two independent resolutions of the same question and a 100× error the day they
 * answered it differently.
 *
 * The locale is a parameter but does not change the answer: a currency's minor-unit count
 * comes from the currency, not from the reader — GBP resolves to 2 and JPY to 0 under
 * `en-GB`, `de-DE`, `ja-JP`, `ar-EG` and `en-US` alike. That is what lets `fromDecimal`
 * resolve under `DEFAULT_LOCALE` and still be the exact inverse of a `formatMoney` call
 * made for some other locale. It is passed rather than hardcoded because it is the
 * formatter's locale that must be right for the SYMBOL and the separators.
 *
 * `maximumFractionDigits` is typed as optional on `resolvedOptions()` because the
 * underlying type is shared with `style: 'decimal'` and `style: 'percent'`, where a
 * caller can omit both `minimumFractionDigits` and `maximumFractionDigits` and let
 * `Intl` fall back to `notation`-dependent defaults that do not fit a single number.
 * `style: 'currency'` always resolves a concrete value from the currency's own ISO
 * 4217 minor-unit data — confirmed directly against `'ZZZ'`, the one code this module
 * accepts that names no real currency (see the module comment), which still resolves
 * to `2`, `Intl`'s fallback for a currency it has no minor-unit data for. The `?? 2`
 * below exists only to satisfy that wider type, not because a currency-style format
 * has been observed to omit it — and it is written once, here, so the fallback cannot
 * differ between the two sides either.
 */
function currencyFormat(
  currency: CurrencyCode,
  locale: string,
): { readonly format: Intl.NumberFormat; readonly fractionDigits: number } {
  const format = new Intl.NumberFormat(locale, { style: 'currency', currency });
  return { format, fractionDigits: format.resolvedOptions().maximumFractionDigits ?? 2 };
}

/**
 * The locale `formatMoney` uses when no locale is passed explicitly.
 *
 * WHY AN EXPLICIT DEFAULT RATHER THAN LETTING THE RUNTIME DECIDE. This app
 * server-renders on Cloudflare Workers, and the public share page (Ref 26, not written
 * yet) — where a pack's gear prices will be rendered for anyone holding the link, no
 * sign-in required — will be its most-visited surface. `Intl.NumberFormat` called with
 * `undefined` as its locale argument does not mean "no formatting preference"; it
 * means "use the JavaScript runtime's default locale", which is read from the
 * operating environment (`ICU_DEFAULT_LOCALE`, container locale settings, or the Worker
 * runtime's own default) rather than from anything about the visitor or the request.
 * That default is NOT guaranteed identical between `astro dev` on a developer's own
 * machine, a CI runner, and the actual Cloudflare Workers production environment — so
 * the exact same `Money` value could render as `£1,234.50` in one place and `£1.234,50`
 * in another, and because the divergence lives in environment configuration rather than
 * in code or data, it would never reproduce locally: a developer investigating a bug
 * report of "the wrong decimal separator" would run the same function against the same
 * `Money` value on their own machine, see the correct output, and conclude the report
 * was mistaken.
 *
 * `en-GB` rather than `en-US` because this product is a UK-registered outfit
 * (Queensway Studios Limited, per package.json) and `en-GB`'s number formatting — comma
 * thousands separator, period decimal point, symbol before the amount — is also what
 * every one of GBP/USD/EUR render as under it, so the choice does not privilege one of
 * the three currencies the ticket names over the others. A caller rendering for a
 * specific visitor (once the product has visitor locale detection at all) passes that
 * locale explicitly; this constant is only ever the fallback for a value that reaches
 * `formatMoney` with no better answer.
 */
export const DEFAULT_LOCALE = 'en-GB';

/**
 * Renders a `Money` as a localised, currency-symbol-bearing string via
 * `Intl.NumberFormat`. `locale` defaults to `DEFAULT_LOCALE` — see that constant's
 * comment for why a caller relying on the runtime default is a determinism bug waiting
 * to happen on Cloudflare Workers, and why this function refuses to be that caller by
 * always resolving to a concrete locale before it ever touches `Intl.NumberFormat`.
 *
 * The currency code alone drives both the symbol and the number of fraction digits —
 * never a hardcoded table of this module's own. That is what makes this "multi-currency":
 * `formatMoney(makeMoney(1050, 'GBP'))` and `formatMoney(makeMoney(1050, 'JPY'))` take
 * the same code path and the same stored integer, and come out as `£10.50` and
 * `JP¥1,050` respectively, because `Intl` — not this function — knows JPY has no minor
 * unit. The `JP` prefix is not a typo: under `en-GB` the reader's own currency is GBP, so
 * `Intl` qualifies a foreign yen rather than leaving a bare `¥` to be guessed at, and
 * tests/money.test.ts pins that exact string. See `fromDecimal` for the corresponding
 * entry-side half of the scale.
 *
 * `amountMinorUnits` is converted to the currency's major unit before formatting
 * (`Intl.NumberFormat`'s `style: 'currency'` expects a major-unit number and applies
 * its own fraction-digit rounding — it does not take a minor-unit integer), by the same
 * `currencyFormat` call `fromDecimal` multiplied up with, so the two cannot disagree
 * about what "minor unit" means for any given currency.
 */
export function formatMoney(money: Money, locale: string = DEFAULT_LOCALE): string {
  const { format, fractionDigits } = currencyFormat(money.currency, locale);
  return format.format(money.amountMinorUnits / 10 ** fractionDigits);
}

/**
 * A per-currency rollup: sums a list of `Money` into a map from currency code to the
 * total `Money` for that currency. See the module comment, "CROSS-CURRENCY SUMMING IS
 * IMPOSSIBLE, NOT MERELY DISCOURAGED", for why this is the only summing function this
 * module offers and why a `sum(): Money` collapsing every currency into one must never
 * be added beside it.
 *
 * THE VALUES ARE `Money`, NOT BARE NUMBERS, and that is the point of the map rather than
 * an incidental convenience. Everything above spends sixty lines making an amount
 * unconstructable without its currency, precisely so no call site can hold one half of
 * the pair — and a `ReadonlyMap<CurrencyCode, number>` would give that away again at the
 * exit: the currency survives as the KEY, but the scale survives only in a doc comment,
 * so `£{{ total }}` over the entries of such a map renders £4250 for £42.50. That is the
 * identical 100× error `fromDecimal` and `makeMoney`'s integrality check refuse on the
 * way in, reintroduced on the way out, and a caller cannot even be blamed for it: the
 * value they were handed was an ordinary number that looked ready to print.
 *
 * Every total is built through `makeMoney`, not assembled as an object literal, so the
 * accumulator cannot outgrow the constructor's guards — and the addition itself needs no
 * rounding: minor units are integers (`makeMoney` enforces it), so summing them is exact
 * and independent of the order the list happens to arrive in.
 *
 * An empty list returns an empty map rather than, say, a zero `Money` in some assumed
 * currency — there is no currency to assume, and an empty pack legitimately has no
 * total to report in any currency at all.
 */
export function sumByCurrency(monies: readonly Money[]): ReadonlyMap<CurrencyCode, Money> {
  const totals = new Map<CurrencyCode, Money>();
  for (const money of monies) {
    const running = totals.get(money.currency);
    totals.set(
      money.currency,
      makeMoney((running?.amountMinorUnits ?? 0) + money.amountMinorUnits, money.currency),
    );
  }
  return totals;
}
