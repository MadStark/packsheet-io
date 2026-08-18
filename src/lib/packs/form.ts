/**
 * Parses and validates every form pack list composition (PK-37) puts in front of a
 * visitor — the pack itself, a category, a pack item's per-list settings, and the one-off
 * custom item — and converts stored rows back into the same shapes for those forms to
 * pre-fill. Pure functions over `FormData`; nothing here opens a connection, and nothing
 * here imports an SDK.
 *
 * Modelled on `src/lib/gear/form.ts` deliberately rather than by coincidence. Read that
 * module first: its structure, its message style, its "presence is decided before the
 * value is parsed" shape, and its two hard rules below are all reproduced here, and the
 * places this file DEPARTS from it are called out where they happen rather than left for a
 * reader to notice.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS LIVES IN src/lib/ RATHER THAN IN THE PAGE
 * ---------------------------------------------------------------------------
 *
 * `vitest.config.ts:64` excludes `src/pages/` from the test run, because every file there
 * becomes a route. `src/lib/gear/form.ts`, `src/lib/packs/query.ts`,
 * `src/lib/packs/mutations.ts` and `src/lib/packs/reorder-request.ts` each make this
 * argument for their own layer (`src/lib/packs/routes.ts` does NOT — its header argues
 * dependency-freedom, which is a different rule for a different reason), and it is the
 * same argument here: a rule about what makes a pack, a category or a custom item
 * well-formed that is written in `.astro` frontmatter is a rule no test in this repository
 * can execute. PK-4's independent review found exactly that by mutation testing on the
 * gear pages — mutations to statements living only in frontmatter survived, not because
 * the assertions were weak but because nothing in the suite could reach them. Every rule
 * below is therefore callable, and asserted, directly from `tests/packs-form.test.ts`.
 *
 * ---------------------------------------------------------------------------
 * EVERY VALIDATION NAMES THE EXACT DATABASE CONSTRAINT IT MIRRORS
 * ---------------------------------------------------------------------------
 *
 * The same house rule `src/lib/gear/form.ts` states in capitals and
 * `supabase/migrations/20260812000000_worn_consumable_exclusive.sql` follows for its own
 * application-side pair: each check below names, in its own comment, the exact CHECK
 * constraint (or column type, or the deliberate absence of either) it exists to mirror.
 * This file and `supabase/migrations/20260810120000_core_schema.sql` share no import and
 * nothing mechanical keeps them in step — these comments are the enforcement, and a
 * constraint changed on one side without the other is a bug that shows up as a raw
 * Postgres error string in front of a visitor.
 *
 * THREE VALIDATIONS HERE MIRROR NO DATABASE CONSTRAINT AT ALL, and they are the ones to
 * be careful with, because they are the ones where this parser is the ENTIRE defence:
 * the custom item's `weight`, `price` and `currency`. Those three do not become columns.
 * They become keys inside `pack_items.snapshot`, a `jsonb` column whose contents are
 * constrained only to "an object, with a `captured_at` key and a non-blank `name`"
 * (core_schema.sql:284-291). Postgres will store `{"weight": -400}` or
 * `{"weight": "heavy"}` in that column without complaint. What catches those is
 * `resolveWeightGrams`/`resolvePrice` in `src/lib/totals.ts`, at READ time, by throwing —
 * which turns a bad write made today into a pack that cannot be rendered tomorrow. This
 * parser is what stops the write. It is the same relationship `isAllowedGearUrl` has with
 * `gear_items.url`, which likewise carries no CHECK of its own.
 *
 * ---------------------------------------------------------------------------
 * `worn` AND `consumable` ARE ONE THREE-WAY CHOICE, NOT TWO CHECKBOXES
 * ---------------------------------------------------------------------------
 *
 * The form posts a single `carriage` field whose value is one of `PACK_ITEM_CARRIAGES`
 * (`src/lib/packs/fields.ts`), and `carriageFlags` turns it into the two booleans the
 * columns want. The full argument is on `PACK_ITEM_CARRIAGES` itself; the part that
 * belongs here is what it means for this parser: THE COMBINATION `worn = true, consumable
 * = true` IS NOT VALIDATED AGAINST, IT IS UNREPRESENTABLE. There is no submission this
 * module can be handed — hostile, stale, hand-crafted, repeated-key — that produces it,
 * because there is no input whose value both flags are read from independently. A
 * submission carrying literal `worn=on&consumable=on` fields is not rejected; those field
 * names are simply not read, and the `carriage` field decides the answer on its own.
 *
 * `pack_items_worn_consumable_exclusive` and `computeTotals`'s refusal to total such a row
 * remain the backstop for everything that never came through here — psql, a restore, a
 * future import path — and are not weakened by this. They are just no longer the thing
 * standing between an ordinary visitor and a broken row.
 *
 * ---------------------------------------------------------------------------
 * REQUIRED VS OPTIONAL FOLLOWS THE COLUMNS
 * ---------------------------------------------------------------------------
 *
 * `packs.name` and `pack_categories.name` are `not null` with `check (length(btrim(name))
 * > 0)` and no honest default a form could fall back on, so a blank one blocks the save.
 * `packs.description` and `packs.trip_type` are nullable with no default, so blank means
 * "not provided" and becomes `null` — never `''`, for the reason
 * `src/lib/gear/form.ts`'s `parseOptionalText` gives: two spellings of "absent" is a
 * distinction nobody intends to draw and every later filter has to know about.
 * `pack_items.quantity` is `not null default 1` and `packed` is `not null default false`,
 * so both follow PK-63's relaxation — a blank field resolves to the column's own default
 * rather than erroring, and only a NON-BLANK value that fails to parse is refused.
 *
 * THE CUSTOM ITEM'S `weight` IS THE ONE PLACE THAT REASONING DOES NOT TRANSFER, and it is
 * relaxed anyway, on a different ground. There is no column and therefore no column
 * default to appeal to; what there is instead is `gear_items.weight_grams`'s
 * `default 0` and the fact that a snapshot is meant to be indistinguishable from the gear
 * row it stands in for (see `buildCustomItemSnapshot` in `src/lib/packs/mutations.ts`). A
 * custom item with no weight typed is `0`, exactly as a gear item with no weight typed is,
 * and `computeTotals` treats the two identically because it cannot tell them apart.
 *
 * ---------------------------------------------------------------------------
 * WEIGHT ENTRY IS IN THE ACCOUNT'S BASE UNIT, CONVERTED ONCE (PK-67)
 * ---------------------------------------------------------------------------
 *
 * `parseCustomPackItemForm` takes a `WeightSystem` and converts the typed figure from
 * `WEIGHT_ENTRY_UNIT[system]` — `g` for metric, `oz` for imperial — with `toGrams`,
 * exactly once, precisely as `parseGearItemForm` does. There is no unit field, so a unit
 * cannot be missing, malformed or tampered with in a submission. See `src/lib/units.ts`'s
 * "GRAMS IS THE CANONICAL UNIT" for why one conversion at the boundary is the whole
 * design, and `parseGearItemForm`'s weight call site for the worked example of why the
 * magnitude bound has to be divided by the entry unit's factor rather than applied to the
 * typed number.
 *
 * ---------------------------------------------------------------------------
 * NEVER A RAW POSTGRES OR POSTGREST STRING
 * ---------------------------------------------------------------------------
 *
 * Every message below is a complete, neutral sentence a visitor can read — the house rule
 * `signUpErrorMessage` (`src/lib/auth/index.ts`) follows for the sign-up form and
 * `src/lib/gear/form.ts` follows for the closet. `numeric field overflow`,
 * `new row violates check constraint "pack_items_quantity_check"` and
 * `invalid input syntax for type integer` are all strings this module exists to make
 * unreachable.
 *
 * ---------------------------------------------------------------------------
 * NOT importing src/lib/auth/
 * ---------------------------------------------------------------------------
 *
 * Nothing in `src/lib/packs/` may import `src/lib/auth/`, and this module has no reason to
 * want to: it is handed a `FormData` and a `WeightSystem` and returns a value. The rule is
 * an EDGE rule enforced by Invariant A in `tests/anonymous-read-path.test.ts` — it does not
 * look at what a module contains, only at whether something outside the auth choke point
 * has an import edge into it — and PK-37's Vue island bundles this module's graph into the
 * BROWSER, so an import added here would put an auth SDK in the client bundle of a page
 * anonymous visitors load. `src/lib/packs/routes.ts`'s header makes the same argument at
 * length for the same two reasons.
 */

import { type CurrencyCode, isCurrencyCode } from '../money';
import {
  GRAMS_PER_UNIT,
  WEIGHT_DECIMALS,
  WEIGHT_ENTRY_UNIT,
  roundWeight,
  toGrams,
  type WeightSystem,
} from '../units';
import {
  carriageFlags,
  isPackItemCarriage,
  packItemCarriage,
  type PackItemCarriage,
  type PackItemCarriageColumns,
  type PackItemCarriageFlags,
} from './fields';

// ---------------------------------------------------------------------------
// Field names
// ---------------------------------------------------------------------------

/** The `<input name="…">` values the pack form uses — one per `packs` column this form
 *  edits, so the markup and this parser cannot silently disagree about what a field is
 *  called. Deliberately excludes `slug`, `visibility`, `locked_at`, `id`, `user_id`,
 *  `created_at` and `updated_at`: publishing, locking and slug choice are their own
 *  decisions with their own tickets, and none of them is a field on this form. */
export const PACK_FORM_FIELD = {
  name: 'name',
  description: 'description',
  tripType: 'trip_type',
} as const;

/** The category form is one field wide. It is still a named constant rather than a bare
 *  `'name'` at two call sites, for the reason every other field map here exists: the
 *  markup and the parser must not be able to disagree. */
export const PACK_CATEGORY_FORM_FIELD = {
  name: 'name',
} as const;

/** The per-item settings a pack item carries in ONE list: how many, how it is carried, and
 *  whether it is already packed. `position` is absent on purpose — positions are computed
 *  by `src/lib/packs/reorder.ts` from a drag, never typed into a field — and so is
 *  `gear_item_id`, which is a reference the caller supplies rather than a value a visitor
 *  edits. `overrides` is absent because per-list divergence from the closet is its own
 *  feature with its own shape (`pack_items.overrides`, core_schema.sql:272). */
export const PACK_ITEM_FORM_FIELD = {
  quantity: 'quantity',
  carriage: 'carriage',
  packed: 'packed',
} as const;

/** The one-off custom item: the pack-item settings above, plus the fields that will become
 *  the snapshot standing in for a gear row that does not exist. The names match
 *  `private.gear_item_snapshot()`'s own keys wherever there is one to match — see
 *  `buildCustomItemSnapshot` in `src/lib/packs/mutations.ts` for why that correspondence is
 *  load-bearing rather than tidy — with the single deliberate exception of `weight`, which
 *  is the key's name and NOT the column's (`gear_items.weight_grams`), because the entry
 *  field holds the account's base unit and the key holds grams. */
export const CUSTOM_PACK_ITEM_FORM_FIELD = {
  name: 'name',
  brand: 'brand',
  category: 'category',
  description: 'description',
  weight: 'weight',
  price: 'price',
  currency: 'currency',
  quantity: 'quantity',
  carriage: 'carriage',
  packed: 'packed',
} as const;

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

const PACK_NAME_MESSAGE = 'Enter a name for this pack.';
const CATEGORY_NAME_MESSAGE = 'Enter a name for this category.';
const ITEM_NAME_MESSAGE = 'Enter a name for this item.';
const QUANTITY_MESSAGE = 'Enter a whole number greater than zero for quantity.';
const CARRIAGE_MESSAGE = 'Choose whether this is in the pack, worn, or a consumable.';
const WEIGHT_MESSAGE = 'Enter a weight of zero or more, with up to three decimal places.';
const PRICE_MISSING_MESSAGE = 'Enter a price for this currency, or clear the currency.';
const CURRENCY_MISSING_MESSAGE = 'Select a currency for this price.';
const PRICE_INVALID_MESSAGE = 'Enter a price of zero or more, with up to two decimal places.';
const CURRENCY_INVALID_MESSAGE = 'Enter a valid three-letter currency code, like GBP or USD.';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** A validated, ready-to-write pack. Every field has already passed the check mirroring its
 *  `packs` column, so a caller hands this straight to `createPack`/`updatePack` in
 *  `src/lib/packs/mutations.ts` without re-validating any of it. */
export interface PackInput {
  name: string;
  description: string | null;
  trip_type: string | null;
}

/** A validated pack category. One field, and it is required — see `parsePackCategoryForm`. */
export interface PackCategoryInput {
  name: string;
}

/**
 * A validated pack item's per-list settings.
 *
 * `worn` and `consumable` STILL APPEAR AS THE TWO SEPARATE COLUMNS THEY ARE, so `mutations.ts`
 * can pass this to `.update()` unchanged with no field-by-field translation step in between
 * for a bug to live in — but as `PackItemCarriageColumns`, the three-arm union, rather than
 * as two independent booleans. PK-37's independent review was right that the version this
 * replaces gave the invariant away: the type could spell `{ worn: true, consumable: true }`,
 * and the only things standing between that value and a write were three runtime checks
 * (`carriageFlags` producing the pair, `packItemCarriage`, `classifyPackItem`). The rule is
 * representable, so it is represented; the three checks remain, now as backstops against
 * rows this module never wrote. See `PackItemCarriageColumns` in `./fields` for the argument
 * in full, including why each arm still spreads into `.update()` unchanged.
 *
 * A TYPE ALIAS INTERSECTION RATHER THAN AN INTERFACE, mechanically: an interface cannot
 * extend a union.
 */
export type PackItemInput = {
  quantity: number;
  packed: boolean;
} & PackItemCarriageColumns;

/**
 * A validated one-off custom item: its per-list settings, plus the display fields that
 * become `pack_items.snapshot`.
 *
 * `weight_grams` IS NAMED FOR THE COLUMN IT MIRRORS, not for the snapshot key it ends up
 * under. The snapshot writes `'weight'` — because `private.gear_item_snapshot()` does, and
 * `src/lib/totals.ts` merges overrides over that vocabulary — while `gear_items` calls the
 * column `weight_grams`. Naming it `weight_grams` here says what the NUMBER is (grams,
 * already converted) rather than where it is about to be written, which is the fact a
 * caller can get wrong. `buildCustomItemSnapshot` performs the one rename, in one place.
 *
 * AN INTERSECTION RATHER THAN `extends PackItemInput`, and the reason is mechanical rather
 * than a change of intent: `PackItemInput` is a union now (see its own comment), and an
 * interface cannot extend one. The resulting type is the same set of values it would have
 * been — the three carriage arms, each carrying the display fields below.
 */
export type CustomPackItemInput = PackItemInput & {
  name: string;
  brand: string | null;
  category: string | null;
  description: string | null;
  weight_grams: number;
  price: number | null;
  currency: CurrencyCode | null;
};

/** The pack form's raw strings — what a re-render needs whether or not the submission
 *  validated, one per `PACK_FORM_FIELD` entry, so a failed parse and a stored row produce
 *  the identical shape and no page has to branch on which one it got. */
export interface PackFormValues {
  name: string;
  description: string;
  trip_type: string;
}

export interface PackCategoryFormValues {
  name: string;
}

export interface PackItemFormValues {
  quantity: string;
  carriage: string;
  packed: string;
}

export interface CustomPackItemFormValues extends PackItemFormValues {
  name: string;
  brand: string;
  category: string;
  description: string;
  weight: string;
  price: string;
  currency: string;
}

/**
 * The result shape every parser here returns, generic over its own pair of types.
 *
 * A GENERIC WHERE `src/lib/gear/form.ts` HAS ONE HAND-WRITTEN UNION, and that is the one
 * structural departure from it worth flagging up front. That module parses exactly one
 * form and so has exactly one result type; this module parses four, and four copies of the
 * same two-branch `ok: true | ok: false` union would be three opportunities for one of them
 * to acquire a slightly different `errors` type. The semantics are identical, field for field: on
 * failure, `values` carries back exactly what the visitor typed — unvalidated, untrimmed —
 * so the page re-renders the form with their own input still in it rather than clearing it
 * back to blank.
 */
export type FormResult<TInput, TValues> =
  | { readonly ok: true; readonly values: TInput }
  | {
      readonly ok: false;
      readonly errors: Readonly<Record<string, string>>;
      readonly values: TValues;
    };

export type PackFormResult = FormResult<PackInput, PackFormValues>;
export type PackCategoryFormResult = FormResult<PackCategoryInput, PackCategoryFormValues>;
export type PackItemFormResult = FormResult<PackItemInput, PackItemFormValues>;
export type CustomPackItemFormResult = FormResult<CustomPackItemInput, CustomPackItemFormValues>;

// ---------------------------------------------------------------------------
// Numeric parsing
// ---------------------------------------------------------------------------

/**
 * THE NUMERIC PARSERS BELOW ARE A SECOND COPY OF `src/lib/gear/form.ts`'s, AND THE
 * DUPLICATION IS DELIBERATE BUT NOT COMFORTABLE. Read this before changing either copy.
 *
 * `parseNonNegativeDecimal` and `parseQuantity` are module-private in `src/lib/gear/form.ts`
 * — not exported, and exporting them is a change to a file this ticket does not own. The
 * honest options were therefore to copy them or to widen that module's surface, and copying
 * is the one that does not touch a shipped, reviewed file for a caller it was not written
 * for. The extraction both copies want — a shared `src/lib/form-numbers.ts` — belongs to a
 * ticket that owns both files and can move the tests with them.
 *
 * WHAT WOULD MAKE THIS COPY WRONG, so it is checked rather than assumed: the regexp gate is
 * what refuses the strings `'NaN'`, `'Infinity'`, `'1e3'`, `'0x10'` and `' 12 '` BEFORE
 * `Number()` is ever called — see the original's own comment for why `Number.isFinite` alone
 * is the weaker check, and for why Postgres orders NaN ABOVE every numeric value so a
 * database-side `>= 0` does not catch it. THIS COPY GUARDS THE MORE EXPOSED VALUE OF THE
 * TWO. The gear copy protects `gear_items.weight_grams numeric(12, 3) check (weight_grams
 * >= 0 and weight_grams < 'Infinity'::numeric)`, which would refuse a bad value even if the
 * parser let one through. This copy protects a key inside `pack_items.snapshot`, a `jsonb`
 * column with NO constraint on its numbers at all, where the only thing downstream is
 * `resolveWeightGrams` throwing at read time on a pack the visitor can no longer open. If
 * the two copies drift, this is the copy where the drift costs something.
 *
 * `maxDecimals` mirrors the scale of the numeric column the value stands in for (3 for a
 * weight, mirroring `gear_items.weight_grams`; 2 for a price, mirroring `gear_items.price`)
 * and `exclusiveMax` mirrors its precision.
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
  // Defensive rather than load-bearing, exactly as in the original: the regexp already
  // refuses anything that is not plain digits and a single point, so `value` cannot be NaN
  // or infinite here. Kept as a second layer for the reason `toGrams` in src/lib/units.ts
  // asserts its own result as well as its argument.
  if (!Number.isFinite(value) || value >= exclusiveMax) return null;
  return value;
}

/**
 * The bound a custom item's weight is held to, in GRAMS, exclusive.
 *
 * IT MIRRORS A COLUMN THE VALUE NEVER REACHES, and that is the point rather than an
 * oversight. `10 ** 9` is `numeric(12, 3)`'s exclusive maximum — twelve digits, three after
 * the point, nine before it — which is the bound on `gear_items.weight_grams`. A custom
 * item's weight goes into `pack_items.snapshot`, a `jsonb` column, where Postgres imposes no
 * magnitude limit whatsoever: `{"weight": 1e300}` stores without complaint.
 *
 * The bound is applied anyway because a snapshot exists to be INDISTINGUISHABLE from the
 * gear row it stands in for. `src/lib/totals.ts` reads both through the same
 * `resolveWeightGrams` and cannot tell which writer produced the object it is holding; a
 * custom item permitted a weight no gear item could ever hold would be a line in a pack
 * total that the closet could not have produced, and the first thing to notice would be a
 * total that is wrong by a factor nobody can account for. Holding both writers to the same
 * bound keeps "a custom item is a gear item that only exists here" true.
 */
const SNAPSHOT_WEIGHT_EXCLUSIVE_MAX_GRAMS = 10 ** 9;

/** `numeric(12, 2)`'s exclusive maximum — ten digits before the point — mirroring
 *  `gear_items.price` for the same reason `SNAPSHOT_WEIGHT_EXCLUSIVE_MAX_GRAMS` mirrors
 *  `gear_items.weight_grams`: the snapshot's `price` key is read by the same
 *  `resolvePrice` that reads a gear row's column, and must not be able to hold a value the
 *  column could not. */
const SNAPSHOT_PRICE_EXCLUSIVE_MAX = 10 ** 10;

/** Postgres `integer`'s maximum. `pack_items.quantity` carries `check (quantity > 0)` and
 *  nothing bounding its magnitude, so without this a quantity above 2^31 - 1 would reach
 *  the database and come back as a raw `integer out of range` — one of the strings this
 *  module exists to make unreachable. */
const POSTGRES_INTEGER_MAX = 2147483647;

/** `\d+` only — no sign, no point, no exponent — so `0`, `-1`, `1.5` and `1e3` are refused
 *  by shape before the `> 0` check runs; pairs with `check (quantity > 0)`. */
const QUANTITY_PATTERN = /^\d+$/;

function parseQuantity(raw: string): number | null {
  const trimmed = raw.trim();
  if (!QUANTITY_PATTERN.test(trimmed)) return null;

  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value <= 0 || value > POSTGRES_INTEGER_MAX) return null;
  return value;
}

// ---------------------------------------------------------------------------
// Free text, checkboxes and field reading
// ---------------------------------------------------------------------------

/** Trims and converts `''` to `null` — pairs the nullable, unconstrained columns
 *  (`packs.description`, `packs.trip_type`) and the nullable snapshot keys with "not
 *  provided". Storing `null` rather than `''` is the same decision `src/lib/gear/form.ts`
 *  argues for: otherwise "has no description" and "has an empty-string description" become
 *  two states every later reader has to know about separately, for a distinction nobody
 *  intends to draw. */
function parseOptionalText(raw: string): string | null {
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Reads one field off `form` as a bare string. THE SAME TWO KNOWN COERCIONS
 * `src/lib/gear/form.ts`'s `getFormString` documents apply here unchanged, and are recorded
 * rather than fixed for the same reason — fixing them is a cross-cutting change to how
 * every form in this codebase reads a field, not a side effect of this ticket:
 *
 *   - A field submitted MORE THAN ONCE reads back only the FIRST value (`FormData.get()`'s
 *     documented behaviour), so a second, possibly-malformed value is discarded rather than
 *     validated or reported.
 *   - A NON-STRING entry — a `File` part from a multipart POST landing on a field this form
 *     expects to be plain text — folds to `''`, indistinguishable from an empty or absent
 *     field, rather than being treated as a type error.
 */
function getFormString(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === 'string' ? value : '';
}

/**
 * The exact submitted values that mean a checkbox was ticked.
 *
 * AN ALLOW-LIST RATHER THAN "ANY NON-EMPTY STRING", which is the obvious implementation and
 * is wrong in a way that only shows up in a bug report. An unchecked checkbox posts NOTHING
 * at all, and a checked one posts its `value` attribute — `'on'` when the markup does not
 * set one. So a truthiness test on the raw string is correct for every submission a browser
 * produces, and answers TRUE for `packed=false`, `packed=off` and `packed=0` — three
 * strings a hand-written client, an API caller or a test fixture writes when it means the
 * exact opposite. Enumerating the affirmatives means those three are unchecked, which is
 * both the safer answer for a boolean defaulting to false and the one their author meant.
 */
const CHECKBOX_TRUE_VALUES = new Set(['on', 'true', '1', 'yes']);

/** Whether a checkbox field was ticked. Absent, empty and unrecognised all read as false —
 *  pairs with `packed boolean not null default false` (core_schema.sql:265), where absence
 *  is the ordinary case rather than an error, because that is exactly what an unticked box
 *  posts. */
function parseCheckbox(raw: string): boolean {
  return CHECKBOX_TRUE_VALUES.has(raw.trim().toLowerCase());
}

// ---------------------------------------------------------------------------
// Raw value extraction
// ---------------------------------------------------------------------------

/**
 * Reads every field off `form` as a bare string, with no validation at all — the same
 * extraction each parser does internally to build the `values` it returns alongside
 * `errors`, pulled out so a caller can get it WITHOUT re-running validation.
 *
 * WHY THESE ARE NEEDED SEPARATELY FROM THE PARSERS, which `rawGearFormValues` in
 * `src/lib/gear/form.ts` explains at length and which applies here word for word: a parser
 * only hands back raw values on the `ok: false` branch, because a caller about to write has
 * no use for the unparsed strings. But a page still needs those exact strings back if
 * validation SUCCEEDED and the write then failed — a dropped connection, a locked pack, a
 * constraint this parser does not mirror. The visitor's input was fine and the database call
 * was not, and re-rendering should show what they typed rather than a blank form or a value
 * reconstructed from the parsed input (whose numbers have already been reformatted: `'01'`
 * became `1`).
 */
export function rawPackFormValues(form: FormData): PackFormValues {
  return {
    name: getFormString(form, PACK_FORM_FIELD.name),
    description: getFormString(form, PACK_FORM_FIELD.description),
    trip_type: getFormString(form, PACK_FORM_FIELD.tripType),
  };
}

export function rawPackCategoryFormValues(form: FormData): PackCategoryFormValues {
  return { name: getFormString(form, PACK_CATEGORY_FORM_FIELD.name) };
}

export function rawPackItemFormValues(form: FormData): PackItemFormValues {
  return {
    quantity: getFormString(form, PACK_ITEM_FORM_FIELD.quantity),
    carriage: getFormString(form, PACK_ITEM_FORM_FIELD.carriage),
    packed: getFormString(form, PACK_ITEM_FORM_FIELD.packed),
  };
}

export function rawCustomPackItemFormValues(form: FormData): CustomPackItemFormValues {
  return {
    name: getFormString(form, CUSTOM_PACK_ITEM_FORM_FIELD.name),
    brand: getFormString(form, CUSTOM_PACK_ITEM_FORM_FIELD.brand),
    category: getFormString(form, CUSTOM_PACK_ITEM_FORM_FIELD.category),
    description: getFormString(form, CUSTOM_PACK_ITEM_FORM_FIELD.description),
    weight: getFormString(form, CUSTOM_PACK_ITEM_FORM_FIELD.weight),
    price: getFormString(form, CUSTOM_PACK_ITEM_FORM_FIELD.price),
    currency: getFormString(form, CUSTOM_PACK_ITEM_FORM_FIELD.currency),
    quantity: getFormString(form, CUSTOM_PACK_ITEM_FORM_FIELD.quantity),
    carriage: getFormString(form, CUSTOM_PACK_ITEM_FORM_FIELD.carriage),
    packed: getFormString(form, CUSTOM_PACK_ITEM_FORM_FIELD.packed),
  };
}

// ---------------------------------------------------------------------------
// parsePackForm
// ---------------------------------------------------------------------------

/**
 * Validates a pack create/edit submission. Never throws: a missing, malformed or hostile
 * `FormData` produces `{ ok: false, errors, values }` for a genuinely bad value, with the
 * two documented limits on that guarantee that `getFormString` records above.
 *
 * ALL FIELDS ARE VALIDATED, NOT JUST THE FIRST BAD ONE — the same reason `errors` is a
 * record keyed by field name rather than one message. It happens to be moot on this
 * particular form, which has exactly one field that can fail; it is written this way so it
 * stays true when a second one is added.
 */
export function parsePackForm(form: FormData): PackFormResult {
  const values = rawPackFormValues(form);
  const errors: Record<string, string> = {};

  // pairs with: name text not null check (length(btrim(name)) > 0)
  // (20260810120000_core_schema.sql:130)
  //
  // `btrim` in the constraint and `.trim()` here are the same test for every input a form
  // can produce: the constraint rejects a name that is entirely whitespace, and so does
  // this. The value WRITTEN is the trimmed one, so `'  Ultralight  '` is stored as
  // `'Ultralight'` rather than being stored as typed and merely passing a constraint that
  // trims before checking — otherwise two packs whose names differ only in leading spaces
  // would look identical on every screen and sort apart in every list.
  const name = values.name.trim();
  if (name === '') errors.name = PACK_NAME_MESSAGE;

  // pairs with: description text — nullable, no default, NO CHECK constraint. An unbounded
  // text column, so there is no length to enforce and nothing to reject; the only decision
  // is blank-means-null, which parseOptionalText makes for every field of this kind.
  const description = parseOptionalText(values.description);

  // pairs with: trip_type text — nullable, no default, and DELIBERATELY UNCONSTRAINED.
  //
  // THIS IS THE ONE FIELD IN THIS MODULE THAT MUST NOT BE VALIDATED AGAINST ITS OWN
  // VOCABULARY, and doing so would be a data-loss bug rather than a strictness improvement.
  // `PACK_TRIP_TYPES` (src/lib/packs/fields.ts) is a UI convenience — the options a picker
  // offers — and its header says at length why the column has no CHECK behind it: PK-33 and
  // PK-65 import packs from other tools whose trip-type vocabularies are their own, and an
  // imported `'PCT section hike'` or `'vacaciones'` has to survive a round trip through this
  // form byte-identically. `isPackTripType` is explicitly documented as a test for "is there
  // a curated LABEL for this", never for "may this be saved", and nothing in this codebase
  // may branch to a rejection on it. So this field is trimmed, blank-means-null, and
  // otherwise passed through untouched — not lowercased, not slugified, not checked.
  const tripType = parseOptionalText(values.trip_type);

  if (Object.keys(errors).length > 0) return { ok: false, errors, values };

  return { ok: true, values: { name, description, trip_type: tripType } };
}

// ---------------------------------------------------------------------------
// parsePackCategoryForm
// ---------------------------------------------------------------------------

/**
 * Validates a category create/rename submission.
 *
 * A SEPARATE FUNCTION FROM `parsePackForm` DESPITE MIRRORING THE SAME CONSTRAINT, rather
 * than one shared "parse a name" helper the two call. The two names are checked against two
 * different constraints on two different tables that merely happen to be spelled the same
 * today — `packs.name` at core_schema.sql:130 and `pack_categories.name` at :211 — and the
 * messages differ because a visitor being told "enter a name" needs to know which thing is
 * missing one. Folding them together would make a future divergence (a length cap on one, a
 * uniqueness rule on the other) a refactor rather than an edit.
 */
export function parsePackCategoryForm(form: FormData): PackCategoryFormResult {
  const values = rawPackCategoryFormValues(form);
  const errors: Record<string, string> = {};

  // pairs with: name text not null check (length(btrim(name)) > 0)
  // (20260810120000_core_schema.sql:211)
  //
  // Note what is NOT checked: uniqueness. `pack_categories.name` is not unique and has no
  // reason to be — two 'Extras', two 'Day 1' — and `duplicate_pack`'s own comment in
  // 20260818000000_pack_composition_functions.sql explains why anything relying on category
  // names being distinct is a bug waiting to be found (a join on name against a duplicate
  // produces a cross product). Rejecting a duplicate name here would impose an invariant the
  // schema deliberately does not have.
  const name = values.name.trim();
  if (name === '') errors.name = CATEGORY_NAME_MESSAGE;

  if (Object.keys(errors).length > 0) return { ok: false, errors, values };

  return { ok: true, values: { name } };
}

// ---------------------------------------------------------------------------
// Shared pack-item parsing
// ---------------------------------------------------------------------------

/**
 * The three per-item settings, parsed once for both the plain pack item and the custom
 * item — the one place `worn` and `consumable` are decided in this module.
 *
 * SHARED HERE RATHER THAN DUPLICATED INTO THE TWO PARSERS, which is the opposite call to
 * the one `parsePackCategoryForm` above makes about names, and for a reason that survives
 * the comparison: those were two constraints on two tables that happen to agree, while
 * these three settings ARE the same three columns of the same table, `pack_items`, reached
 * by two routes into it. A divergence between them would not be a schema change, it would
 * be a bug — a custom item whose quantity rules differed from a referenced item's.
 *
 * It writes into the caller's `errors` record rather than returning its own, so a custom
 * item reports a bad quantity and a blank name from ONE submission instead of making the
 * visitor fix them in two rounds.
 */
function parsePackItemFields(
  values: PackItemFormValues,
  errors: Record<string, string>,
): PackItemInput | null {
  // pairs with: quantity integer not null default 1 check (quantity > 0)
  // (20260810120000_core_schema.sql:262)
  //
  // A BLANK QUANTITY IS NOT AN ERROR, following PK-63's treatment of the identical column on
  // gear_items: the column carries a real default that a write path in this very ticket
  // already relies on — `addGearItemsToCategory` (src/lib/packs/mutations.ts) inserts
  // `user_id`, `pack_category_id`, `gear_item_id` and `position` and names no quantity at
  // all, so every item added from the closet arrives at the default 1. (`duplicate_pack` is
  // NOT such a path and must not be cited as one: it names `quantity` in its column list and
  // copies the source row's value, because a copy that reset every quantity to 1 would be a
  // different pack.) So a blank field here is "the visitor did not say, use the default"
  // rather than a stale or tampered request, and it produces exactly what the closet-add
  // path produces for the same column. A
  // NON-BLANK value that fails to parse is still refused — '0', '-1', '1.5', '1e3' and 'abc'
  // all produce QUANTITY_MESSAGE — so blank means "no answer" and malformed means "a wrong
  // answer", and only the first is forgiven.
  //
  // THE INSERT-VS-UPDATE CAVEAT `src/lib/gear/form.ts` RECORDS APPLIES HERE TOO and must not
  // be read past: "resolves to the column's own default" is the INSERT-path justification.
  // `updatePackItem` (src/lib/packs/mutations.ts) issues `.update()` with this parser's full
  // output, so on the edit path a cleared quantity writes a literal `1` over a stored 4.
  // That is what the form asks for; the point is only that the default is not "keep what was
  // there".
  const quantityRaw = values.quantity.trim();
  let quantity = 1;
  if (quantityRaw !== '') {
    const parsed = parseQuantity(quantityRaw);
    if (parsed === null) {
      errors.quantity = QUANTITY_MESSAGE;
    } else {
      quantity = parsed;
    }
  }

  // pairs with: worn boolean not null default false
  //             consumable boolean not null default false
  //             constraint pack_items_worn_consumable_exclusive check (not (worn and consumable))
  // (20260810120000_core_schema.sql:263-264, 20260812000000_worn_consumable_exclusive.sql:36)
  //
  // ONE FIELD, THREE VALUES, TWO COLUMNS. See this module's header and `PACK_ITEM_CARRIAGES`
  // in src/lib/packs/fields.ts for the full argument; what matters at this line is that the
  // exclusive constraint has nothing to reject, because `carriageFlags` is the only thing
  // that ever produces the pair and it cannot produce both-true.
  //
  // A BLANK OR UNRECOGNISED VALUE IS AN ERROR, NOT A DEFAULT, and this is the one place this
  // module departs from `packed` and `quantity` immediately around it. Both columns do have
  // a default (`false`, `false`) that a "no answer means carried" reading could appeal to.
  // It is refused anyway, for the reason PK-63 gives for gear's `status` radio group: a radio
  // group with nothing checked posts NOTHING, which a JavaScript-disabled browser, a stale
  // form or a tampered request can all genuinely produce — and silently recording "in the
  // pack" for a visitor who meant "worn" moves weight between two buckets they are looking at
  // on the screen. STATUS_MESSAGE's counterpart here, CARRIAGE_MESSAGE, is what asks them to
  // pick one. `EMPTY_PACK_ITEM_FORM_VALUES` seeds `'carried'` so a first render has an option
  // selected, which is what makes this case rare rather than routine.
  const carriageRaw = values.carriage.trim();
  let carriage: PackItemCarriage | null = null;
  if (isPackItemCarriage(carriageRaw)) {
    carriage = carriageRaw;
  } else {
    errors.carriage = CARRIAGE_MESSAGE;
  }

  // pairs with: packed boolean not null default false (20260810120000_core_schema.sql:265).
  // No CHECK to mirror — a boolean column's type is the constraint — so the only decision is
  // what an absent field means, which parseCheckbox answers with the column's own default.
  const packed = parseCheckbox(values.packed);

  // The `=== null` check is folded into this guard rather than asserted with a `!` below,
  // so TypeScript itself narrows `carriage` to its non-null type: "errors empty implies a
  // carriage was chosen" is then enforced by the compiler rather than promised in a comment,
  // exactly as `parseGearItemForm` does for `status`.
  if (carriage === null || Object.keys(errors).length > 0) return null;

  return { quantity, ...carriageFlags(carriage), packed };
}

// ---------------------------------------------------------------------------
// parsePackItemForm
// ---------------------------------------------------------------------------

/** Validates the per-list settings of a pack item that references the closet — quantity,
 *  carriage, packed. Nothing about the ITEM itself is editable here: it is a reference to a
 *  gear row (rule 1 of the core schema), and its name, weight and price live on that row,
 *  where editing them updates every pack that references it. */
export function parsePackItemForm(form: FormData): PackItemFormResult {
  const values = rawPackItemFormValues(form);
  const errors: Record<string, string> = {};

  const parsed = parsePackItemFields(values, errors);
  if (parsed === null) return { ok: false, errors, values };

  return { ok: true, values: parsed };
}

// ---------------------------------------------------------------------------
// parseCustomPackItemForm
// ---------------------------------------------------------------------------

/**
 * Validates a one-off custom item: something a visitor is taking on this trip that is not
 * in their closet and that they do not want to add to it.
 *
 * WHAT MAKES THIS DIFFERENT FROM EVERY OTHER PARSER IN THIS FILE. Its output does not become
 * a set of columns. It becomes `pack_items.snapshot`, a `jsonb` object built by
 * `buildCustomItemSnapshot` (`src/lib/packs/mutations.ts`) in the exact shape
 * `private.gear_item_snapshot()` produces — which means the checks below are, for `weight`,
 * `price` and `currency`, the ONLY validation those values will ever meet. See this module's
 * header, "THREE VALIDATIONS HERE MIRROR NO DATABASE CONSTRAINT AT ALL". The bounds and
 * shapes they are held to are the ones `gear_items`' own columns carry, so that a custom
 * item and a closet item are the same kind of thing to `src/lib/totals.ts`, which cannot
 * tell them apart and must not need to.
 *
 * `system` IS THE ACCOUNT'S WEIGHT SYSTEM AND THE WEIGHT FIELD IS IN ITS BASE UNIT, exactly
 * as in `parseGearItemForm` — see this module's header for the PK-67 contract and
 * `src/lib/units.ts` for why the conversion happens once, here, and never again downstream.
 *
 * ALL FIELDS ARE VALIDATED, NOT JUST THE FIRST BAD ONE: a visitor who mistypes both the
 * weight and the price sees both on one re-render.
 */
export function parseCustomPackItemForm(
  form: FormData,
  system: WeightSystem,
): CustomPackItemFormResult {
  const values = rawCustomPackItemFormValues(form);
  const errors: Record<string, string> = {};

  // pairs with: check (... length(btrim(coalesce(snapshot ->> 'name', ''))) > 0)
  // (20260810120000_core_schema.sql:289) — part of the `snapshot` column's shape check.
  //
  // THIS IS THE ONE CUSTOM-ITEM FIELD THE DATABASE REALLY DOES CHECK, and the constraint's
  // own comment says why it exists: `snapshot` is an ordinary column with UPDATE granted to
  // its owner, so without a shape check `set snapshot = '{}', gear_item_id = null` would
  // satisfy `pack_items_reference_or_snapshot` and leave a row that displays as nothing.
  // "A pack item must always be able to render itself" is rule 3, and a nameless custom item
  // is precisely the row that cannot. So a blank name here is not a nicety — it is the
  // difference between this write succeeding and it coming back as a raw
  // `violates check constraint "pack_items_snapshot_check"`.
  const name = values.name.trim();
  if (name === '') errors.name = ITEM_NAME_MESSAGE;

  // brand, category, description: snapshot keys standing in for the nullable, unconstrained
  // `gear_items.brand`/`category`/`description` columns. Nothing to mirror but nullability,
  // and blank-means-null keeps a custom item's snapshot the same shape as a frozen gear
  // item's, where those keys are null exactly when the column was.
  const brand = parseOptionalText(values.brand);
  const category = parseOptionalText(values.category);
  const description = parseOptionalText(values.description);

  // pairs with: weight_grams numeric(12, 3) not null default 0
  //             check (weight_grams >= 0 and weight_grams < 'Infinity'::numeric)
  // (20260817120000_gear_weight_in_grams.sql), mirrored ACROSS a jsonb key that carries no
  // constraint of its own — see SNAPSHOT_WEIGHT_EXCLUSIVE_MAX_GRAMS for why the bound is
  // applied to a value the column never receives.
  //
  // A BLANK WEIGHT IS 0, not an error: that is the column's own default, and a custom item
  // whose weight the visitor has not measured yet is an ordinary thing to add to a list.
  // A NON-BLANK malformed value is still refused — 'NaN', 'Infinity', '1e3' and a fourth
  // decimal place all produce WEIGHT_MESSAGE, and the regexp gate in parseNonNegativeDecimal
  // is what refuses the first two as STRINGS rather than trusting a numeric check that
  // Postgres itself would not apply here anyway.
  //
  // THE UPPER BOUND FOLLOWS THE UNIT, which is why the limit is divided rather than passed
  // straight through — the identical move `parseGearItemForm` makes and for the identical
  // reason. The bound has to apply to the number that ends up STORED, not to the one that
  // was typed: 100,000,000 oz is comfortably under 1e9 as typed and is 2.8e9 g once
  // converted. Dividing by the entry unit's factor moves the check back onto the typed
  // value, where WEIGHT_MESSAGE can report it, and leaves the metric case at exactly 1e9.
  //
  // `roundWeight` AFTER converting, never before: three decimals of an ounce is 0.028 g, so
  // an entered `4.4` is 124.73790175 g and has to be rounded to the gram scale that a gear
  // row would have been stored at. Rounding the typed value first would round in ounces,
  // which is a coarser and different question.
  const weightRaw = values.weight.trim();
  const entryUnit = WEIGHT_ENTRY_UNIT[system];
  let weightGrams = 0;
  if (weightRaw !== '') {
    const parsed = parseNonNegativeDecimal(
      weightRaw,
      WEIGHT_DECIMALS,
      SNAPSHOT_WEIGHT_EXCLUSIVE_MAX_GRAMS / GRAMS_PER_UNIT[entryUnit],
    );
    if (parsed === null) {
      errors.weight = WEIGHT_MESSAGE;
    } else {
      weightGrams = roundWeight(toGrams(parsed, entryUnit));
    }
  }

  // pairs with: price numeric(12, 2) check (price >= 0 and price < 'Infinity'::numeric)
  //             currency char(3) check (currency ~ '^[A-Z]{3}$')
  //             constraint gear_items_price_has_currency check ((price is null) = (currency is null))
  // — all three on `gear_items`, mirrored across two jsonb keys that carry none of them.
  //
  // THE PAIRING RULE IS THE IMPORTANT HALF HERE, because `resolvePrice` in
  // `src/lib/totals.ts` THROWS on half a pair: "a currency with nothing usable to measure is
  // not a price", and a snapshot holding one without the other makes the whole pack
  // unrenderable rather than merely mispriced. `gear_items_price_has_currency` makes that
  // state unrepresentable on a gear row; nothing makes it unrepresentable inside a snapshot,
  // so this check is what keeps it from being written.
  //
  // Presence is decided independently for each field before either is parsed, so a price
  // typed with an invalid currency reports the currency's own message rather than "you must
  // provide a currency" for a currency that was provided but wrong.
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
    const parsedPrice = parseNonNegativeDecimal(priceRaw, 2, SNAPSHOT_PRICE_EXCLUSIVE_MAX);
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
  // else: both absent. price and currency stay null, and the item is simply unpriced —
  // which is what `resolvePrice` returns null for, not an error.

  const item = parsePackItemFields(values, errors);

  // `item === null` folded into the same guard as the error count, for the compiler-narrowing
  // reason `parsePackItemFields` records at its own return.
  if (item === null || Object.keys(errors).length > 0) return { ok: false, errors, values };

  return {
    ok: true,
    values: {
      ...item,
      name,
      brand,
      category,
      description,
      weight_grams: weightGrams,
      price,
      currency,
    },
  };
}

// ---------------------------------------------------------------------------
// The inverse renderings
// ---------------------------------------------------------------------------

/** The `packs` columns the edit form pre-fills itself from. Deliberately a structural type
 *  over the three fields this form owns rather than a `Pick<Database…>`: `loadPackForEdit`
 *  returns a PostgREST embed whose row type is derived from `PACK_TREE_SELECT`, and pinning
 *  this to the table's generated Row type would make a caller convert between two shapes
 *  that already agree field for field. */
export interface PackFormRow {
  name: string;
  description: string | null;
  trip_type: string | null;
}

/** Turns a stored pack into the same `PackFormValues` a failed `parsePackForm` returns, so
 *  the edit page and the new-pack page share one form-rendering path regardless of whether
 *  the values came from the database or from a rejected submission — the same role
 *  `gearItemToFormValues` plays for the closet. */
export function packToFormValues(row: PackFormRow): PackFormValues {
  return {
    name: row.name,
    description: row.description ?? '',
    trip_type: row.trip_type ?? '',
  };
}

/** The `pack_items` columns the per-item form pre-fills itself from. */
export interface PackItemFormRow extends PackItemCarriageFlags {
  quantity: number;
  packed: boolean;
}

/**
 * Turns a stored pack item into `PackItemFormValues`.
 *
 * `packItemCarriage` IS WHAT COLLAPSES THE TWO COLUMNS BACK INTO ONE FIELD, and it throws
 * on a row with both flags set rather than picking a winner — see its own comment and
 * `classifyPackItem` in `src/lib/totals.ts`, which refuses the same row for the same reason.
 * A form that silently showed "Worn" for such a row would invite the visitor to save that
 * repair back over whatever the row actually meant, and the state is unreachable from the
 * database anyway.
 *
 * `packed` renders as `'on'` or `''` rather than `'true'`/`'false'`, because the field is a
 * CHECKBOX and `''` is what an unticked one contributes to a submission. Rendering `'false'`
 * would put a non-empty string in a checkbox's value — which `parseCheckbox` reads as
 * unticked, correctly, but only because that string is on neither list. `''` is the honest
 * blank.
 */
export function packItemToFormValues(row: PackItemFormRow): PackItemFormValues {
  return {
    quantity: String(row.quantity),
    carriage: packItemCarriage(row),
    packed: row.packed ? 'on' : '',
  };
}

/**
 * The blank state a "new pack" form renders on a plain GET.
 *
 * Every field is `''`: `name` is required and has no honest default, and `description` and
 * `trip_type` are nullable columns with no database default, so "not provided" is the true
 * blank. `trip_type` in particular MUST NOT be pre-filled with a plausible-looking first
 * option — see `PACK_TRIP_TYPE_BLANK_LABEL` and `packTripTypeOptions` in
 * `src/lib/packs/fields.ts`, where the entire failure mode is a `<select>` showing a value
 * nobody chose and the next unrelated save writing it.
 */
export const EMPTY_PACK_FORM_VALUES: PackFormValues = {
  name: '',
  description: '',
  trip_type: '',
};

/** The blank state a "new category" form renders. One required field, no default. */
export const EMPTY_PACK_CATEGORY_FORM_VALUES: PackCategoryFormValues = {
  name: '',
};

/**
 * The blank state the per-item settings render before a visitor changes anything: the
 * columns' own defaults, `1` / `carried` / unticked.
 *
 * `carriage: 'carried'` IS LOAD-BEARING in a way `quantity: '1'` no longer is. A radio group
 * starts with NOTHING checked unless some option's value matches, so without this seed the
 * first render would show three unselected radios and a submission from that form would be
 * refused by `parsePackItemFields` with CARRIAGE_MESSAGE — asking the visitor to choose the
 * thing the form should already have been showing. `quantity` and `packed` are shown as
 * their defaults because that is what a visitor should see, not because a blank submission
 * would be rejected; PK-63's relaxation means blank is accepted for quantity too.
 */
export const EMPTY_PACK_ITEM_FORM_VALUES: PackItemFormValues = {
  quantity: '1',
  carriage: 'carried',
  packed: '',
};

/**
 * The blank state the "add a custom item" form renders.
 *
 * `weight: '0'` matches `gear_items.weight_grams`'s own `default 0` — the value a closet
 * item with no weight typed gets — for the reason this module's header gives under
 * "REQUIRED VS OPTIONAL": the whole point of a custom item is to be indistinguishable from a
 * gear item to everything downstream, and its blank state is part of that. `price` and
 * `currency` are blank together, which is the only pairing that is not an error.
 *
 * IT IS THE ACCOUNT'S BASE UNIT IN THE WEIGHT BOX, NOT A SCALED ONE — `g` for a metric
 * account and `oz` for an imperial one, rendered as a suffix beside the field rather than as
 * a control, because there is no unit to choose. `src/lib/units.ts`'s `WEIGHT_ENTRY_UNIT`
 * calls this out so it is not later filed as a bug.
 */
export const EMPTY_CUSTOM_PACK_ITEM_FORM_VALUES: CustomPackItemFormValues = {
  name: '',
  brand: '',
  category: '',
  description: '',
  weight: '0',
  price: '',
  currency: '',
  ...EMPTY_PACK_ITEM_FORM_VALUES,
};

/**
 * THERE IS DELIBERATELY NO `customPackItemToFormValues`, and its absence is a scope
 * statement rather than an omission. Re-opening a custom item for editing means REWRITING a
 * snapshot that already exists, and `pack_items.snapshot` is the column two other paths
 * write for entirely different reasons — locking a pack, and deleting the gear an item
 * referenced (rules 2 and 3, core_schema.sql). An edit form that wrote that column would
 * have to answer what happens when the item being edited is a FROZEN gear item rather than
 * an authored one, whether `captured_at` moves, and whether editing a frozen copy is
 * rewriting history — see the column comment in
 * `supabase/migrations/20260818000000_pack_composition_functions.sql`, which now documents
 * both meanings the column carries. PK-37 adds the authoring path; the editing path is a
 * question of its own, and PK-66's promotion-into-the-closet flow is where it is asked.
 */
