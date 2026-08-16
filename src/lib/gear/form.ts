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
 * EVERY VALIDATION HERE MIRRORS A DATABASE CHECK CONSTRAINT ON `gear_items`
 * (`supabase/migrations/20260810120000_core_schema.sql`), the same convention
 * `supabase/migrations/20260812000000_worn_consumable_exclusive.sql` uses for its own
 * application-side pair. Each check below names the exact constraint it mirrors in its
 * own comment, because the two files have no shared import and nothing else keeps them
 * from drifting apart.
 *
 * REQUIRED VS OPTIONAL FOLLOWS THE COLUMNS, NOT A GUESS. `name`, `quantity`, `weight`,
 * `weight_unit` and `status` are all `not null` columns on `gear_items` — even where a
 * column also carries a `default` for direct-SQL and other write paths, this form
 * requires the visitor to supply a real value rather than silently substituting the
 * column's default, because the rendered form always carries one (a pre-filled `0`, a
 * selected `g`, a selected `owned`) and an empty submission for one of these can only
 * mean a stale or tampered request. `price`, `currency`, `volume_litres`, `url`,
 * `brand`, `category`, `description` and `notes` are all nullable columns, so an empty
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
 *  `photo_path`, `weight_grams`, `id`, `user_id`, `deleted_at`, `created_at` and
 *  `updated_at` — none of those are ever supplied by this form. */
export const GEAR_FORM_FIELD = {
  name: 'name',
  quantity: 'quantity',
  weight: 'weight',
  weightUnit: 'weight_unit',
  price: 'price',
  currency: 'currency',
  volumeLitres: 'volume_litres',
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
const VOLUME_MESSAGE = 'Enter a volume of zero or more litres, with up to three decimal places.';
const URL_MESSAGE = 'Enter a valid web address, starting with http:// or https://.';

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
  volume_litres: number | null;
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
  volume_litres: string;
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
  | 'volume_litres'
  | 'url'
  | 'notes'
  | 'status'
  | 'quantity'
>;

// ---------------------------------------------------------------------------
// Numeric parsing
// ---------------------------------------------------------------------------

/** `numeric(12, 3)`'s exclusive upper bound: 12 total digits, 3 of them after the
 *  point, leaves 9 before it — `10**9`. Shared by `weight` and `volume_litres`, the
 *  two `numeric(12, 3)` columns this form writes. Kept here rather than trusting
 *  Postgres to enforce it, because an overflow there is a raw `numeric field overflow`
 *  error — exactly the kind of string this module exists to never let a visitor see. */
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
 * `maxDecimals` mirrors the column's scale (3 for `weight`/`volume_litres`, 2 for
 * `price`) and `exclusiveMax` mirrors the column's precision via `NUMERIC_12_3_MAX`/
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
    volume_litres: getFormString(form, GEAR_FORM_FIELD.volumeLitres),
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
 * `FormData` (a missing field, a field submitted twice, a `javascript:` URL) always
 * produces `{ ok: false, errors, values }`, mirroring `parseGearQuery`'s totality
 * promise on the read side of this same module family.
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

  // pairs with: volume_litres numeric(12, 3)
  //             check (volume_litres >= 0 and volume_litres < 'Infinity'::numeric)
  const volumeRaw = values.volume_litres.trim();
  let volumeLitres: number | null = null;
  if (volumeRaw !== '') {
    volumeLitres = parseNonNegativeDecimal(volumeRaw, WEIGHT_DECIMALS, NUMERIC_12_3_MAX);
    if (volumeLitres === null) errors.volume_litres = VOLUME_MESSAGE;
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
      volume_litres: volumeLitres,
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
    volume_litres: row.volume_litres === null ? '' : String(row.volume_litres),
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
 */
export const EMPTY_GEAR_FORM_VALUES: GearFormValues = {
  name: '',
  quantity: '1',
  weight: '0',
  weight_unit: 'g',
  price: '',
  currency: '',
  volume_litres: '',
  status: 'owned',
  url: '',
  brand: '',
  category: '',
  description: '',
  notes: '',
};
