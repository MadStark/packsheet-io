/**
 * Parses and validates the gear item create/edit form for the gear closet (PK-4), and
 * converts a stored row back into the same shape for the edit form to pre-fill.
 *
 * WHY THIS LIVES IN src/lib/ RATHER THAN IN THE PAGE. `vitest.config.ts:64` excludes
 * `src/pages/` from the test run, because every file there becomes a route.
 * `src/pages/account/index.astro:51-55` names the same reasoning for
 * `src/lib/account-deletion.ts`, and `src/lib/gear/query.ts`'s own module comment names
 * it again for the read path: code written in `.astro` frontmatter is code no test in
 * this repository can reach. Every rule below about what makes a gear item well-formed
 * therefore has to live somewhere `tests/gear-form.test.ts` can call directly — this
 * module is that somewhere. The page that calls `parseGearItemForm` is meant to be a
 * thin shell: read the form, call this, either re-render with `.errors`/`.values` or
 * write `.values` to the database.
 *
 * EVERY VALIDATION HERE MIRRORS EITHER A DATABASE CHECK CONSTRAINT ON `gear_items`
 * (`supabase/migrations/20260810120000_core_schema.sql`) OR, WHERE THE COLUMN CARRIES
 * NO CONSTRAINT OF ITS OWN, THE COLUMN'S TYPE OR THE DELIBERATE ABSENCE OF ONE — the
 * same convention `supabase/migrations/20260812000000_worn_consumable_exclusive.sql`
 * uses for its own application-side pair. Each check below names the exact constraint
 * (or type, or absence of one) it mirrors in its own comment, because the two files
 * have no shared import and nothing else keeps them from drifting apart. TWO FIELDS
 * ARE THE EXCEPTIONS TO "MIRRORS A CHECK CONSTRAINT": `url` mirrors nothing at the
 * database at all — `gear_items.url` carries no CHECK constraint, so `isAllowedGearUrl`
 * is the entire defence — and `acquired_on` mirrors its column's TYPE (`date`) rather
 * than a CHECK, plus a future-date rejection (PK-61) that has no database-side mirror
 * whatsoever, CHECK or otherwise.
 *
 * REQUIRED VS OPTIONAL FOLLOWS THE COLUMNS, NOT A GUESS. `name`, `quantity`, `weight`,
 * `weight_unit` and `status` are all `not null` columns on `gear_items` — even where a
 * column also carries a `default` for direct-SQL and other write paths, this form
 * requires the visitor to supply a real value rather than silently substituting the
 * column's default, because the rendered form always carries one (a pre-filled `0`, a
 * selected `g`, a selected `owned`) and an empty submission for one of these can only
 * mean a stale or tampered request. `price`, `currency`, `acquired_on`, `url`, `brand`,
 * `category`, `description` and `notes` are all nullable columns, so an empty
 * submission is treated as "not provided" and becomes `null` rather than an error.
 *
 * NEVER A RAW POSTGRES OR POSTGREST STRING. Every message below is a complete,
 * neutral sentence a visitor can read — the same house rule `signUpErrorMessage` in
 * `src/lib/auth/index.ts` follows for the sign-up form.
 */

import type { Database } from '../database.types';
import { type CurrencyCode, isCurrencyCode } from '../money';
import { type WeightUnit, WEIGHT_DECIMALS, isWeightUnit } from '../units';
import { type GearStatus, isGearStatus } from './fields';

// ---------------------------------------------------------------------------
// Field names
// ---------------------------------------------------------------------------

/** The `<input name="…">`/`<select name="…">` values the gear item form uses — one
 *  name per `gear_items` column the form edits, so the form markup and this parser
 *  cannot silently disagree about what a field is called. Deliberately excludes
 *  `photo_path`, `weight_grams`, `id`, `user_id`, `created_at` and `updated_at` — none
 *  of those are ever supplied by this form. */
export const GEAR_FORM_FIELD = {
  name: 'name',
  quantity: 'quantity',
  weight: 'weight',
  weightUnit: 'weight_unit',
  price: 'price',
  currency: 'currency',
  acquiredOn: 'acquired_on',
  status: 'status',
  url: 'url',
  brand: 'brand',
  category: 'category',
  description: 'description',
  notes: 'notes',
} as const;

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

const NAME_MESSAGE = 'Enter a name for this item.';
const QUANTITY_MESSAGE = 'Enter a whole number greater than zero for quantity.';
const WEIGHT_MESSAGE = 'Enter a weight of zero or more, with up to three decimal places.';
const WEIGHT_UNIT_MESSAGE = 'Choose a weight unit.';
const STATUS_MESSAGE = 'Choose a status.';
const PRICE_MISSING_MESSAGE = 'Enter a price for this currency, or clear the currency.';
const CURRENCY_MISSING_MESSAGE = 'Select a currency for this price.';
const PRICE_INVALID_MESSAGE = 'Enter a price of zero or more, with up to two decimal places.';
const CURRENCY_INVALID_MESSAGE = 'Enter a valid three-letter currency code, like GBP or USD.';
const URL_MESSAGE = 'Enter a valid web address, starting with http:// or https://.';
const ACQUIRED_ON_MESSAGE =
  'Enter a valid date, or leave this blank if you do not know when you got it.';
// Deliberately a SEPARATE message from ACQUIRED_ON_MESSAGE above, not a reuse of it —
// see isAcquiredOnInFuture's own comment for why a future date needs a message that
// does not call a real, valid date "invalid".
const ACQUIRED_ON_FUTURE_MESSAGE = 'An acquired date cannot be in the future.';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** A validated, ready-to-write gear item. Every field here has already passed the
 *  check that mirrors its `gear_items` column, so a caller can hand this straight to
 *  `.insert()`/`.update()` without re-validating any of it. */
export interface GearItemInput {
  name: string;
  quantity: number;
  weight: number;
  weight_unit: WeightUnit;
  price: number | null;
  currency: CurrencyCode | null;
  acquired_on: string | null;
  status: GearStatus;
  url: string | null;
  brand: string | null;
  category: string | null;
  description: string | null;
  notes: string | null;
}

/** The form's raw string fields — what a `<form>` re-render needs, whether or not the
 *  submission validated. Every field is a bare string, exactly one per
 *  `GEAR_FORM_FIELD` entry, so `gearItemToFormValues` and a failed `parseGearItemForm`
 *  produce the identical shape and a page never has to branch on which one it got. */
export interface GearFormValues {
  name: string;
  quantity: string;
  weight: string;
  weight_unit: string;
  price: string;
  currency: string;
  acquired_on: string;
  status: string;
  url: string;
  brand: string;
  category: string;
  description: string;
  notes: string;
}

/** On failure, `values` carries back exactly what the visitor typed — unvalidated,
 *  untrimmed — so the page can re-render the form with their own input still in it
 *  rather than clearing it back to blank. */
export type GearFormResult =
  | { readonly ok: true; readonly values: GearItemInput }
  | {
      readonly ok: false;
      readonly errors: Readonly<Record<string, string>>;
      readonly values: GearFormValues;
    };

/** The `gear_items` columns the edit form needs to pre-fill itself, read back from the
 *  database. Picked from `Database` rather than hand-written, so this type can never
 *  drift from what the table actually has — see `src/lib/gear/query.ts`'s own comment
 *  on `GearItemsQueryBuilder` for the same reasoning applied to the read path. */
export type GearItemRow = Pick<
  Database['public']['Tables']['gear_items']['Row'],
  | 'name'
  | 'brand'
  | 'category'
  | 'description'
  | 'weight'
  | 'weight_unit'
  | 'price'
  | 'currency'
  | 'acquired_on'
  | 'url'
  | 'notes'
  | 'status'
  | 'quantity'
>;

// ---------------------------------------------------------------------------
// Numeric parsing
// ---------------------------------------------------------------------------

/** `numeric(12, 3)`'s exclusive upper bound: 12 total digits, 3 of them after the
 *  point, leaves 9 before it — `10**9`. Used by `weight`, the one `numeric(12, 3)`
 *  column this form still writes (PK-61 dropped the other, `volume_litres`; this
 *  constant is kept because `weight` still needs it, not out of caution). Kept here
 *  rather than trusting Postgres to enforce it, because an overflow there is a raw
 *  `numeric field overflow` error — exactly the kind of string this module exists to
 *  never let a visitor see. */
const NUMERIC_12_3_MAX = 10 ** 9;

/** Same reasoning as `NUMERIC_12_3_MAX`, for `price numeric(12, 2)`: 12 digits, 2
 *  after the point, 10 before it. */
const NUMERIC_12_2_MAX = 10 ** 10;

/**
 * Matches a plain non-negative decimal the way a number field's value looks when a
 * person typed it: digits, optionally a point and more digits. This is deliberately a
 * regexp gate BEFORE `Number()` is ever called, not `Number.isFinite(Number(raw))`
 * alone, because `Number()` parses far more than that shape accepts and this module
 * must not be the weaker of the two validation layers guarding `gear_items`:
 *
 *   - `Number('NaN')` is `NaN` and `Number('Infinity')`/`Number('-Infinity')` are the
 *     two signed infinities. `weight < 'Infinity'::numeric` exists specifically
 *     because Postgres orders NaN ABOVE every numeric value, so a plain `>= 0` check
 *     on the database side lets NaN through (see the comment at
 *     `core_schema.sql:67-72`) — this parser refuses the STRINGS "NaN" and "Infinity"
 *     outright, rather than leaning on `Number.isFinite` to catch the numeric value
 *     they parse to, so a future refactor that swaps the finiteness check for a bare
 *     `>= 0` comparison (which happens to also reject JS's own NaN, unlike Postgres's)
 *     cannot quietly reopen the gap this comment is about.
 *   - `Number('1e3')` is `1000`, scientific notation a visitor did not type by hand
 *     into a plain number field — refused the same way `parseGearItemForm`'s quantity
 *     check refuses it.
 *   - `Number(' 12 ')`, `Number('')` and `Number('0x10')` all parse to something
 *     `Number.isFinite` alone would accept; none of them are the shape this function
 *     exists to accept.
 *
 * `maxDecimals` mirrors the column's scale (3 for `weight`, 2 for `price`) and
 * `exclusiveMax` mirrors the column's precision via `NUMERIC_12_3_MAX`/
 * `NUMERIC_12_2_MAX` above.
 */
function parseNonNegativeDecimal(
  raw: string,
  maxDecimals: number,
  exclusiveMax: number,
): number | null {
  const trimmed = raw.trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (match === null) return null;

  const decimals = match[2] ?? '';
  if (decimals.length > maxDecimals) return null;

  const value = Number(trimmed);
  // Number.isFinite is defensive rather than load-bearing here: the regexp above
  // already refuses anything that is not plain digits and a single point, so `value`
  // cannot itself be NaN or infinite. It stays as a second layer for the same reason
  // toGrams in src/lib/units.ts asserts its own result as well as its argument.
  if (!Number.isFinite(value) || value >= exclusiveMax) return null;
  return value;
}

/** Postgres `integer`'s maximum value. `quantity` has no CHECK constraint bounding its
 *  magnitude — only `quantity > 0` — so without this, a quantity larger than 2^31 - 1
 *  would reach the database and fail with a raw `integer out of range` error instead of
 *  this module's own message. */
const POSTGRES_INTEGER_MAX = 2147483647;

/** `\d+` only — no sign, no point, no exponent — so `0`, `-1`, `1.5` and `1e3` are all
 *  refused by shape before the `> 0` check even runs; pairs with `quantity > 0`. */
const QUANTITY_PATTERN = /^\d+$/;

function parseQuantity(raw: string): number | null {
  const trimmed = raw.trim();
  if (!QUANTITY_PATTERN.test(trimmed)) return null;

  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value <= 0 || value > POSTGRES_INTEGER_MAX) return null;
  return value;
}

// ---------------------------------------------------------------------------
// URL
// ---------------------------------------------------------------------------

/**
 * The only two schemes `url` may use. `gear_items.url` carries no CHECK constraint at
 * all (see `core_schema.sql:92`), so this parser is the ONLY thing standing between a
 * pasted `javascript:alert(1)` and an `<a href>` on a page that renders it back —
 * `javascript:` and `data:` both parse successfully as a `URL` (WHATWG's parser does
 * not restrict schemes), so `new URL(raw)` succeeding is not itself proof of safety.
 */
const ALLOWED_URL_SCHEMES = new Set(['http:', 'https:']);

/** Whether `trimmed` (already non-empty) is a URL this form will store. Stored EXACTLY
 *  as typed on success — see the module's "NO REWRITING" note on `parseGearItemForm`
 *  for why the caller never sees a normalised `.href` out of this. */
function isAllowedGearUrl(trimmed: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  return ALLOWED_URL_SCHEMES.has(parsed.protocol);
}

// ---------------------------------------------------------------------------
// Acquired date
// ---------------------------------------------------------------------------

/** The only shape this module will accept for `acquired_on`: four digits, a literal
 *  `-`, two digits, a literal `-`, two digits. A gate BEFORE the calendar check below,
 *  for the same reason `parseNonNegativeDecimal` gates with a regexp before calling
 *  `Number()` — it rules out `2026-2-3`, `26-02-03`, `13/08/2026` and anything else
 *  `new Date()` might parse leniently that nobody typing into a `YYYY-MM-DD` field
 *  would actually produce.
 *
 *  THIS IS THE MODULE CHOOSING TO BE STRICTER THAN POSTGRES — NOT POSTGRES FORCING IT.
 *  It is tempting to justify this single shape as "what Postgres's own `date` input
 *  function requires", and that claim is false: verified against the local stack,
 *  `select '2026-2-3'::date` is ACCEPTED and yields `2026-02-03` — Postgres's date
 *  parser tolerates a single-digit month or day under the session's `datestyle`. (
 *  `'26-02-03'::date`, the two-digit-year case, genuinely IS rejected — that is where
 *  Postgres's own leniency actually runs out, not at `2026-2-3`.) PostgREST does not
 *  impose a stricter shape either: it passes the literal straight through to Postgres
 *  unmodified, and `'2026-02-03T00:00:00'::date` is accepted there too. The real
 *  reason this module refuses everything Postgres would tolerate except one exact
 *  shape is that Postgres's tolerance depends on `datestyle`, a SESSION SETTING this
 *  module has no way to see or control from here — accepting whatever Postgres
 *  currently happens to allow would let "what a visitor typed" and "what ends up
 *  stored" quietly diverge the moment that setting were ever different. One
 *  unambiguous shape removes that possibility outright rather than trusting a setting
 *  this code never touches. Being stricter than the database is the right call here;
 *  it is just not a call Postgres is making for it. */
const ACQUIRED_ON_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * `acquired_on` (PK-61): whether `trimmed` (already non-empty) is a real calendar date
 * in `YYYY-MM-DD` form. A regexp shape check alone is not enough — `2026-02-30` and
 * `2026-13-01` both match `ACQUIRED_ON_PATTERN` but name no real day, and Postgres
 * would reject either with a raw `date/time field value out of range` error, exactly
 * the kind of string this module exists to never let a visitor see (see the module
 * comment's "NEVER A RAW POSTGRES OR POSTGREST STRING").
 *
 * Validated by ROUND-TRIPPING through `Date.UTC`, not by hand-rolling a days-per-month
 * table: `Date.UTC(y, m - 1, d)` normalises an out-of-range day or month forward
 * (`Date.UTC(2026, 1, 30)` — February 30th — becomes March 2nd), so feeding the
 * resulting timestamp back through `getUTC{FullYear,Month,Date}` and comparing against
 * the components the visitor actually typed catches every case where the input was not
 * a real date, without this module having to know which months have 30 days, which
 * have 31, or when a given year is a leap year. UTC specifically, not local time — a
 * local-time `Date` constructor call would fold in the server's own time zone offset,
 * turning "the 1st" into "the 30th" depending on where the server happens to run, for a
 * plain `YYYY-MM-DD` string that never named a time of day at all.
 *
 * ONE KNOWN CONSEQUENCE, DOCUMENTED RATHER THAN WORKED AROUND: years `0000`-`0099` are
 * rejected. `Date.UTC` maps a two-digit year argument into the 1900s — `Date.UTC(26, …)`
 * means 1926, not 26 AD — so the round-trip comparison above never matches for those
 * years and `0026-02-03` comes back invalid. That is the right answer for this field
 * anyway: `acquired_on` records when somebody acquired a piece of camping gear, so a
 * first-century date is a typo every time, and it fails with `ACQUIRED_ON_MESSAGE`'s
 * readable sentence rather than being stored. Worth knowing before anyone reuses this
 * helper for a field where antique dates are meaningful.
 */
function isRealCalendarDate(trimmed: string): boolean {
  const match = ACQUIRED_ON_PATTERN.exec(trimmed);
  if (match === null) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  const asDate = new Date(Date.UTC(year, month - 1, day));
  return (
    asDate.getUTCFullYear() === year &&
    asDate.getUTCMonth() === month - 1 &&
    asDate.getUTCDate() === day
  );
}

/**
 * The latest `acquired_on` this module will accept, as a `YYYY-MM-DD` string: today in
 * UTC, PLUS ONE DAY of slack. Computed fresh on every call rather than once at module
 * load, so a long-running server process does not keep validating against the date it
 * happened to start on.
 *
 * Recomputed as a string, and compared lexically rather than as a `Date`, deliberately:
 * `ACQUIRED_ON_PATTERN` already guarantees a fixed-width, zero-padded `YYYY-MM-DD`
 * shape for both sides of the comparison, and a fixed-width zero-padded ISO date
 * string sorts identically whether compared as a string or as a date — so a plain `>`
 * on the strings is exact, with no `Date` object, no time-zone footgun, and no
 * separate parse-then-compare step to keep in sync with `isRealCalendarDate` above.
 *
 * EXPORTED, not module-private like the rest of this section's helpers, so
 * `GearItemForm.astro` can read the same cutoff this validator enforces and set it as
 * the date input's `max` attribute — a client-side hint only (see that component's own
 * comment on why), but one that has to be computed from the exact same rule as the
 * server-side check or the hint and the enforcement could silently disagree.
 */
export function acquiredOnFutureCutoff(): string {
  const now = new Date();
  const tomorrow = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  );
  const year = String(tomorrow.getUTCFullYear()).padStart(4, '0');
  const month = String(tomorrow.getUTCMonth() + 1).padStart(2, '0');
  const day = String(tomorrow.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * `acquired_on` (PK-61): whether `trimmed` (already `isRealCalendarDate`, so a genuine
 * calendar date) names a day strictly after `acquiredOnFutureCutoff()`. Checked
 * SEPARATELY from `isRealCalendarDate`, not folded into it, because the two failures
 * need two different messages: `9999-12-31` is a perfectly real calendar date — the
 * round-trip through `Date.UTC` accepts it without complaint — so telling a visitor who
 * typed it "enter a valid date" (`ACQUIRED_ON_MESSAGE`) would be actively misleading
 * about what is actually wrong with it.
 *
 * `acquired_on` MEANS "WHEN I GOT THIS", WHICH CANNOT BE IN THE FUTURE — and this is not
 * merely implausible, it is incoherent by the schema's own vocabulary: gear that is not
 * yet owned is already modelled as `status = 'wishlist'` (`fields.ts`), so an "owned"
 * item with a future acquisition date is claiming two contradictory things about itself
 * at once. Left unchecked, `9999-12-31` validates and stores today exactly as happily
 * as any real date — and because `GEAR_SORT_COLUMNS.added` now points `acquired_on`
 * (`fields.ts`), one fat-fingered year permanently pins that item to the top of
 * "newest first", for as long as the row exists.
 *
 * THE ONE-DAY TOLERANCE IS DELIBERATE, NOT A ROUNDING CONVENIENCE THAT WOULD BE TIDIER
 * TO DROP. This server computes "today" in UTC, but the visitor typing into the date
 * picker is not necessarily in UTC — someone in UTC+13 or UTC+14 (New Zealand or
 * Kiribati during their local summer) can have a local calendar date up to FOURTEEN
 * HOURS ahead of this server's UTC date. Refuse anything after today-in-UTC with no
 * slack at all, and the instant that visitor's own "today" ticks over, their honest,
 * present-tense "I got this today" is rejected as a future date it was never intended
 * to be — a validation bug wearing a "your input is invalid" message. One day of slack
 * is the smallest margin that covers every real-world UTC offset without admitting a
 * date that is genuinely, meaningfully in the future for anybody: two or more days
 * ahead can no longer be explained by a time-zone difference alone, only by an actual
 * future date.
 */
function isAcquiredOnInFuture(trimmed: string): boolean {
  return trimmed > acquiredOnFutureCutoff();
}

// ---------------------------------------------------------------------------
// Free text
// ---------------------------------------------------------------------------

/** Trims and converts `''` to `null` — pairs `brand`, `category`, `description` and
 *  `notes` with their nullable, unconstrained `gear_items` columns. Storing `null`
 *  rather than `''` for "not provided" is deliberate: otherwise "has no brand" and
 *  "has an empty-string brand" become two distinct states a filter or a `WHERE brand
 *  is null` has to know about separately, for a distinction nobody intends to draw. */
function parseOptionalText(raw: string): string | null {
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Reads one field off `form` as a bare string. TWO KNOWN COERCIONS, DOCUMENTED HERE
 * RATHER THAN FIXED — see `parseGearItemForm`'s own doc comment for why fixing either
 * is out of scope for this ticket — so the next reader does not have to rediscover them
 * from a confusing bug report:
 *
 *   - A field submitted MORE THAN ONCE (`acquired_on=&acquired_on=2026-99-99`, say,
 *     from a hand-crafted or buggy client sending the same key twice) reads back only
 *     the FIRST value — `FormData.get()`'s own documented behaviour — so the second,
 *     possibly-malformed value is silently discarded rather than validated or reported.
 *   - A NON-STRING entry — a `File` part from a multipart POST landing on a field this
 *     form expects to be plain text — folds to `''`, indistinguishable from an empty or
 *     absent field, rather than being treated as a type error.
 */
function getFormString(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === 'string' ? value : '';
}

/**
 * Reads every `GEAR_FORM_FIELD` off `form` as a bare string, with no validation at all
 * — the same extraction `parseGearItemForm` does internally to build the `values` it
 * returns alongside `errors` on a rejected submission, pulled out so a caller can get
 * it WITHOUT re-running validation.
 *
 * WHY THIS IS NEEDED SEPARATELY FROM `parseGearItemForm`. That function only hands back
 * a `GearFormValues` on the `ok: false` branch — a successful validation returns the
 * parsed `GearItemInput` instead, because a page that is about to `.insert()`/`.update()`
 * has no use for the unparsed strings. But a page still needs those exact strings back
 * if validation succeeded and the WRITE itself then failed (a dropped connection, a
 * constraint this parser does not mirror): the visitor's input was fine, the database
 * call was not, and re-rendering the form should show back what they typed, not the
 * blank state `EMPTY_GEAR_FORM_VALUES` would produce or a value reconstructed from the
 * now-stale `GearItemInput` (whose numbers were already reformatted by validation, e.g.
 * `'01'` becoming `1`). Calling `parseGearItemForm` a second time would work only by
 * accident — it is pure, but relying on that accident to fish `values` back out of an
 * `ok: false` result nobody asked it to produce is exactly the kind of coupling this
 * function exists to avoid needing.
 */
export function rawGearFormValues(form: FormData): GearFormValues {
  return {
    name: getFormString(form, GEAR_FORM_FIELD.name),
    quantity: getFormString(form, GEAR_FORM_FIELD.quantity),
    weight: getFormString(form, GEAR_FORM_FIELD.weight),
    weight_unit: getFormString(form, GEAR_FORM_FIELD.weightUnit),
    price: getFormString(form, GEAR_FORM_FIELD.price),
    currency: getFormString(form, GEAR_FORM_FIELD.currency),
    acquired_on: getFormString(form, GEAR_FORM_FIELD.acquiredOn),
    status: getFormString(form, GEAR_FORM_FIELD.status),
    url: getFormString(form, GEAR_FORM_FIELD.url),
    brand: getFormString(form, GEAR_FORM_FIELD.brand),
    category: getFormString(form, GEAR_FORM_FIELD.category),
    description: getFormString(form, GEAR_FORM_FIELD.description),
    notes: getFormString(form, GEAR_FORM_FIELD.notes),
  };
}

// ---------------------------------------------------------------------------
// parseGearItemForm
// ---------------------------------------------------------------------------

/**
 * Validates a gear item create/edit submission. Never throws — a malformed or hostile
 * `FormData` (a missing field, a `javascript:` URL) always produces `{ ok: false,
 * errors, values }` for a genuinely bad value, mirroring `parseGearQuery`'s totality
 * promise on the read side of this same module family.
 *
 * A DOCUMENTED LIMIT ON THAT GUARANTEE, NOT A SILENT GAP: it does NOT hold for a field
 * submitted MORE THAN ONCE, or for a non-string entry — see `getFormString`'s own
 * comment for both. `form.get()` returns only the first value for a repeated key, so
 * `acquired_on=&acquired_on=2026-99-99` reads back as `''`, is treated as "not
 * provided", and comes back `ok: true` with no error at all — the second, malformed
 * value is simply never seen. A `File` part in a multipart POST is folded to `''` the
 * same way. Fixing either is deliberately out of scope here: `getFormString` backs all
 * thirteen fields, and changing it is a cross-cutting change for its own ticket, not a
 * side effect of PK-61 touching `acquired_on`.
 *
 * ALL FIELDS ARE VALIDATED, NOT JUST THE FIRST BAD ONE. A visitor who mistypes both
 * the weight and the price should see both problems on one re-render, not fix one and
 * discover the other on a second submit — the same reason `errors` is a record keyed
 * by field name rather than a single message.
 *
 * `price`/`currency` PAIRING pairs with `gear_items_price_has_currency check ((price
 * is null) = (currency is null))`. Presence is decided independently for each field
 * (empty string after trimming means "not provided") before either is parsed, so a
 * price typed with an invalid currency reports the currency's own message rather than
 * "you must provide a currency" for a currency that was, in fact, provided but wrong.
 */
export function parseGearItemForm(form: FormData): GearFormResult {
  const values: GearFormValues = rawGearFormValues(form);

  const errors: Record<string, string> = {};

  // pairs with: name text not null check (length(btrim(name)) > 0)
  const name = values.name.trim();
  if (name === '') errors.name = NAME_MESSAGE;

  // pairs with: quantity integer not null default 1 check (quantity > 0)
  // (20260813000000_gear_closet.sql)
  const quantity = parseQuantity(values.quantity);
  if (quantity === null) errors.quantity = QUANTITY_MESSAGE;

  // pairs with: weight numeric(12, 3) not null default 0
  //             check (weight >= 0 and weight < 'Infinity'::numeric)
  const weight = parseNonNegativeDecimal(values.weight, WEIGHT_DECIMALS, NUMERIC_12_3_MAX);
  if (weight === null) errors.weight = WEIGHT_MESSAGE;

  // pairs with: weight_unit text not null default 'g'
  //             check (weight_unit in ('g', 'kg', 'oz', 'lb'))
  const weightUnitRaw = values.weight_unit.trim();
  let weightUnit: WeightUnit | null = null;
  if (isWeightUnit(weightUnitRaw)) {
    weightUnit = weightUnitRaw;
  } else {
    errors.weight_unit = WEIGHT_UNIT_MESSAGE;
  }

  // pairs with: status text not null default 'owned'
  //             check (status in ('owned', 'wishlist', 'retired'))
  const statusRaw = values.status.trim();
  let status: GearStatus | null = null;
  if (isGearStatus(statusRaw)) {
    status = statusRaw;
  } else {
    errors.status = STATUS_MESSAGE;
  }

  // pairs with: price numeric(12, 2) check (price >= 0 and price < 'Infinity'::numeric)
  //             currency char(3) check (currency ~ '^[A-Z]{3}$')
  //             constraint gear_items_price_has_currency
  //               check ((price is null) = (currency is null))
  const priceRaw = values.price.trim();
  const currencyRaw = values.currency.trim();
  const priceProvided = priceRaw !== '';
  const currencyProvided = currencyRaw !== '';
  let price: number | null = null;
  let currency: CurrencyCode | null = null;
  if (priceProvided !== currencyProvided) {
    if (priceProvided) {
      errors.currency = CURRENCY_MISSING_MESSAGE;
    } else {
      errors.price = PRICE_MISSING_MESSAGE;
    }
  } else if (priceProvided && currencyProvided) {
    const parsedPrice = parseNonNegativeDecimal(priceRaw, 2, NUMERIC_12_2_MAX);
    if (parsedPrice === null) errors.price = PRICE_INVALID_MESSAGE;

    if (isCurrencyCode(currencyRaw)) {
      if (parsedPrice !== null) {
        price = parsedPrice;
        currency = currencyRaw;
      }
    } else {
      errors.currency = CURRENCY_INVALID_MESSAGE;
    }
  }
  // else: both absent. price and currency stay null; not an error.

  // pairs with: acquired_on date — nullable, no default. Mirrors a TYPE rather than a
  // CHECK constraint: `date` itself rejects anything that is not a real calendar date,
  // so there is no separate constraint clause to name here the way `weight >= 0` or
  // `status in (...)` have one. Not the only exception in this file, either — `url`
  // below mirrors no CHECK constraint at all (gear_items.url has none; see
  // isAllowedGearUrl's own comment), so acquired_on is the file's SECOND column with no
  // CHECK of its own to name, not its only one. The future-date rejection just below
  // has no database-side mirror whatsoever — nothing on this column stops a future date
  // from being written directly; only this form's own check does.
  //
  // Shape follows `url`'s block below, not a bespoke three-way return: presence is
  // decided here, at the call site, with a plain boolean predicate
  // (`isRealCalendarDate`) exactly the way `isAllowedGearUrl` is used for `url` — see
  // the module comment's "REQUIRED VS OPTIONAL" section for why `trimmed !== ''` is
  // "not provided", never an error, for a nullable column with no default.
  const acquiredOnRaw = values.acquired_on.trim();
  let acquiredOn: string | null = null;
  if (acquiredOnRaw !== '') {
    if (!isRealCalendarDate(acquiredOnRaw)) {
      errors.acquired_on = ACQUIRED_ON_MESSAGE;
    } else if (isAcquiredOnInFuture(acquiredOnRaw)) {
      // A real calendar date, just not one that has happened yet — a DIFFERENT problem
      // from "not a real date", so it gets its own message rather than reusing
      // ACQUIRED_ON_MESSAGE, which would tell a visitor who typed a perfectly valid
      // date that it was invalid.
      errors.acquired_on = ACQUIRED_ON_FUTURE_MESSAGE;
    } else {
      acquiredOn = acquiredOnRaw;
    }
  }

  // gear_items.url carries no CHECK constraint — see isAllowedGearUrl's own comment for
  // why this parser is the entire defence against a javascript:/data: URL reaching an
  // <a href>. NOT normalised: a valid http(s) URL is stored EXACTLY as the visitor
  // typed it, per the README's "No affiliate link rewriting" commitment — this parser
  // only ever accepts or rejects, and on acceptance keeps the original string rather
  // than substituting `new URL(trimmed).href`, which can itself rewrite the input
  // (adding a trailing slash, lower-casing the host).
  const urlRaw = values.url.trim();
  let url: string | null = null;
  if (urlRaw !== '') {
    if (isAllowedGearUrl(urlRaw)) {
      url = urlRaw;
    } else {
      errors.url = URL_MESSAGE;
    }
  }

  // brand, category, description: unconstrained, nullable text columns.
  const brand = parseOptionalText(values.brand);
  const category = parseOptionalText(values.category);
  const description = parseOptionalText(values.description);
  const notes = parseOptionalText(values.notes);

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors, values };
  }

  return {
    ok: true,
    values: {
      name,
      // Non-null assertions below are safe, not hopeful: every field that can produce
      // `null` here (quantity, weight, weightUnit, status) also sets an `errors` entry
      // on that same path, and this branch only runs once `errors` is confirmed empty.
      quantity: quantity!,
      weight: weight!,
      weight_unit: weightUnit!,
      price,
      currency,
      acquired_on: acquiredOn,
      status: status!,
      url,
      brand,
      category,
      description,
      notes,
    },
  };
}

// ---------------------------------------------------------------------------
// gearItemToFormValues
// ---------------------------------------------------------------------------

/**
 * The inverse rendering step: turns a stored `gear_items` row into the same
 * `GearFormValues` shape a failed `parseGearItemForm` returns, so the edit page and the
 * new-item page share one form-rendering code path regardless of whether the values
 * came from the database or from a rejected submission.
 *
 * Numbers are rendered with `String()` rather than a fixed number of decimals: `weight`
 * arrives from `Database` typed as `number` (PostgREST serialises `numeric` as a JSON
 * number here, not a string — see `src/lib/database.types.ts`), and `String(4.4)` is
 * `'4.4'`, exactly what a user who entered `4.4` should see back, not `'4.400'`.
 */
export function gearItemToFormValues(row: GearItemRow): GearFormValues {
  return {
    name: row.name,
    quantity: String(row.quantity),
    weight: String(row.weight),
    weight_unit: row.weight_unit,
    price: row.price === null ? '' : String(row.price),
    currency: row.currency ?? '',
    acquired_on: row.acquired_on ?? '',
    status: row.status,
    url: row.url ?? '',
    brand: row.brand ?? '',
    category: row.category ?? '',
    description: row.description ?? '',
    notes: row.notes ?? '',
  };
}

// ---------------------------------------------------------------------------
// EMPTY_GEAR_FORM_VALUES
// ---------------------------------------------------------------------------

/**
 * The blank state `src/pages/gear/new.astro` renders on a plain GET, before the visitor
 * has typed anything. Not all-empty-strings: `quantity`, `weight`, `weight_unit` and
 * `status` are `not null` columns with a database default (`1`, `0`, `'g'`, `'owned'`),
 * and this form REQUIRES the visitor to supply a real value for each of those four
 * rather than silently writing the column's default on an empty submission — see the
 * module comment's "REQUIRED VS OPTIONAL FOLLOWS THE COLUMNS" section. A blank text
 * input for any of the four would make the very first render of this form already
 * invalid, which is a strange way to greet somebody who has not done anything yet; a
 * pre-filled value matching the column's own default is what `parseGearItemForm` will
 * accept unchanged if the visitor never touches that field at all. Every other field is
 * a nullable column with no default, so `''` — "not provided" — is the honest blank.
 *
 * `acquired_on` IS ONE OF THOSE OTHERS, DELIBERATELY, not a fifth pre-filled field —
 * it is a nullable column with no database default, exactly like `price` and `url`, so
 * `''` is the honest blank here too and the NEXT READER SHOULD NOT "FIX" THIS BY
 * PRE-FILLING TODAY'S DATE. A date the visitor did not choose is a guess this product
 * does not make (see the module comment's "REQUIRED VS OPTIONAL" section and PK-61):
 * an empty acquired-date box means "I don't know", not "today". Nothing is lost by
 * leaving it blank, either — the browser's own `<input type="date">` picker already
 * opens on the current month when its value is empty, so a visitor who DID mean "today"
 * is not made to hunt for it.
 */
export const EMPTY_GEAR_FORM_VALUES: GearFormValues = {
  name: '',
  quantity: '1',
  weight: '0',
  weight_unit: 'g',
  price: '',
  currency: '',
  acquired_on: '',
  status: 'owned',
  url: '',
  brand: '',
  category: '',
  description: '',
  notes: '',
};
