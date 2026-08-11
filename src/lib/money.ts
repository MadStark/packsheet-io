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
 * and have the compiler wave it through. `Money` bundles them into one value, and the
 * only way to make one is `makeMoney`, which cannot be handed half a pair.
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
 * that fetches it, same as `weight_unit` before `isWeightUnit`. `isCurrencyCode` is
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
 * currency code, one total per currency actually present, so a pack with two GBP items
 * and one USD item yields `{ GBP: …, USD: … }` — a correct answer to the question that
 * was actually asked, rather than a single plausible-looking number that answers a
 * question nobody could have posed correctly in the first place. `src/lib/totals.ts`
 * is expected to render that map as several lines (or an explicit "mixed currencies"
 * notice) rather than collapsing it — but that rendering choice belongs to that module,
 * not to this one, which only has to make the wrong shortcut impossible to reach for.
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
 * `WEIGHT_UNITS` and its own CHECK constraint are kept in step in `units.ts`.
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
 * integer a formatter divides by 10^fractionDigits) and a `CurrencyCode`. This is the
 * ONLY constructor this module exports for a reason: `Money` is meant to be
 * unconstructable except as a matched pair, and a second entry point would just be a
 * second place that pairing could be gotten wrong. `amount` is validated the same way
 * `units.ts` validates a weight — see that file's "THROW, NOT RETURN" section, which
 * applies here unchanged: 0 is not a safe stand-in for "unknown", and a NaN or
 * Infinity price would poison every rollup it touches exactly as a NaN weight would.
 */
export function makeMoney(amountMinorUnits: number, currency: CurrencyCode): Money {
  if (!Number.isFinite(amountMinorUnits)) {
    throw new RangeError(`amountMinorUnits must be a finite number, got ${amountMinorUnits}`);
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
 * uses — the same source of truth `formatMoney` renders with — rather than hardcoding
 * 2 here and being wrong for the currencies that are not GBP, USD or EUR. See the
 * zero-decimal-currency test for the case this exists to get right.
 */
export function fromDecimal(amount: number, currency: CurrencyCode): Money {
  if (!Number.isFinite(amount)) {
    throw new RangeError(`amount must be a finite number, got ${amount}`);
  }
  return makeMoney(
    Math.round(amount * 10 ** currencyFractionDigits(currency, DEFAULT_LOCALE)),
    currency,
  );
}

/**
 * How many fraction digits `Intl.NumberFormat` uses for `currency` — 2 for GBP/USD/EUR,
 * 0 for JPY/KRW, and so on, read from `Intl` itself rather than a table this module
 * would have to keep in step with ISO 4217's own minor-unit assignments. Both
 * `fromDecimal` and `formatMoney` go through this one function so the two agree with
 * each other about what a currency's minor unit is, by construction, rather than by
 * each separately calling `Intl.NumberFormat` and hoping the results line up.
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
 * has been observed to omit it.
 */
function currencyFractionDigits(currency: CurrencyCode, locale: string): number {
  return (
    new Intl.NumberFormat(locale, { style: 'currency', currency }).resolvedOptions()
      .maximumFractionDigits ?? 2
  );
}

/**
 * The locale `formatMoney` uses when no locale is passed explicitly.
 *
 * WHY AN EXPLICIT DEFAULT RATHER THAN LETTING THE RUNTIME DECIDE. This app
 * server-renders on Cloudflare Workers, and the public share page — where a pack's
 * gear prices are rendered for anyone holding the link, no sign-in required — is its
 * most-visited surface. `Intl.NumberFormat` called with `undefined` as its locale
 * argument does not mean "no formatting preference"; it means "use the JavaScript
 * runtime's default locale", which is read from the operating environment
 * (`ICU_DEFAULT_LOCALE`, container locale settings, or the Worker runtime's own
 * default) rather than from anything about the visitor or the request. That default is
 * NOT guaranteed identical between `astro dev` on a developer's own machine, a CI
 * runner, and the actual Cloudflare Workers production environment — so the exact same
 * `Money` value could render as `£1,234.50` in one place and `£1.234,50` in another,
 * and because the divergence lives in environment configuration rather than in code or
 * data, it would never reproduce locally: a developer investigating a bug report of
 * "the wrong decimal separator" would run the same function against the same `Money`
 * value on their own machine, see the correct output, and conclude the report was
 * mistaken.
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
 * the same code path and the same two-decimal-stored value, and come out as `£10.50`
 * and `¥1,050` respectively, because `Intl` — not this function — knows JPY has no
 * minor unit. See `fromDecimal` for the corresponding entry-side half of that fact.
 *
 * `amountMinorUnits` is converted to the currency's major unit before formatting
 * (`Intl.NumberFormat`'s `style: 'currency'` expects a major-unit number and applies
 * its own fraction-digit rounding — it does not take a minor-unit integer), reading
 * `resolvedOptions().maximumFractionDigits` the same way `currencyFractionDigits`
 * (which `fromDecimal` calls) does, so the two functions agree on what "minor unit"
 * means for any given currency without this module maintaining a currency-to-scale
 * table of its own.
 */
export function formatMoney(money: Money, locale: string = DEFAULT_LOCALE): string {
  const formatter = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: money.currency,
  });
  // `?? 2` here for the same reason as in currencyFractionDigits above — this is a
  // second, separately-configured formatter (locale can differ from DEFAULT_LOCALE),
  // so its own resolvedOptions() is read directly rather than reusing that helper,
  // which would otherwise construct a third Intl.NumberFormat for no benefit.
  const fractionDigits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
  return formatter.format(money.amountMinorUnits / 10 ** fractionDigits);
}

/**
 * A per-currency rollup: sums a list of `Money` into a map from currency code to total
 * minor units for that currency. See the module comment, "CROSS-CURRENCY SUMMING IS
 * IMPOSSIBLE, NOT MERELY DISCOURAGED", for why this is the only summing function this
 * module offers and why a `sum(): Money` collapsing every currency into one must never
 * be added beside it.
 *
 * An empty list returns an empty map rather than, say, a zero `Money` in some assumed
 * currency — there is no currency to assume, and an empty pack legitimately has no
 * total to report in any currency at all.
 */
export function sumByCurrency(monies: readonly Money[]): ReadonlyMap<CurrencyCode, number> {
  const totals = new Map<CurrencyCode, number>();
  for (const money of monies) {
    totals.set(money.currency, (totals.get(money.currency) ?? 0) + money.amountMinorUnits);
  }
  return totals;
}
