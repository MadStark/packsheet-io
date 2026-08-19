/**
 * Packsheet JSON (PK-65): the one fixed, versioned file format this product exports and
 * imports. This module is the SHAPE — the envelope, the item, and the direction that
 * turns a stored row into one. `src/lib/gear/json-import.ts` is the other direction, and
 * it is a much longer file for the obvious reason: writing a file is total by
 * construction, reading one is not.
 *
 * WHAT THIS TICKET SHIPS, AND WHAT IT DELIBERATELY DOES NOT. PK-65's envelope carries a
 * `kind` discriminator with two members, `'pack'` and `'gear_items'`, and this build
 * implements exactly one of them. That is scope, not an oversight, and the asymmetry is
 * load-bearing rather than incidental: a pack file names categories and per-pack
 * overrides that have no UI to come back to yet (PK-37 is still Backlog), so importing
 * one would write rows nothing can display or correct. `GEAR_ITEMS_KIND` is therefore
 * the only kind this build ACCEPTS, and `json-import.ts` refuses a `'pack'` file BY NAME —
 * see `PACK_FILE_MESSAGE` there for the exact wording — rather than with the message it
 * gives a file whose kind is gibberish. Those are different facts about a file, and a
 * visitor holding a real, valid pack export deserves to be told which one they hit.
 *
 * ---------------------------------------------------------------------------
 * WEIGHT TRAVELS AS GRAMS, AND THIS REVERSES WHAT THE TICKET SAYS
 * ---------------------------------------------------------------------------
 *
 * PK-65's written scope says weight travels "as `weight` + `weight_unit` exactly as
 * entered, never as grams", reasoning that `weight_grams` is a generated column and
 * derived data must not round-trip. This module does the opposite, on a direct decision
 * taken when the ticket was implemented: the file carries ONE number, `weight_grams`,
 * and no unit at all. The reason is that `weight_unit` is on its way to being a display
 * -only preference — a per-visitor choice about how a number is RENDERED, not a fact
 * about the item — at which point a unit stored per row is not data the file should be
 * preserving. Writing the file in the unit that is about to stop being authoritative
 * would mean shipping a format whose central field needs a migration almost immediately.
 *
 * WHAT THAT COSTS, STATED PLAINLY BECAUSE IT IS NOT NOTHING. A round-trip preserves the
 * item's WEIGHT and loses the visitor's UNIT: an item entered as `4.4 oz` exports as
 * `124.738 g` and re-imports as `124.738 g`, not as `4.4 oz`. The mass is identical to
 * within the column's own precision; the fact that a person typed ounces is not
 * recovered. Under the "as entered" design that fact survived, so this is a real
 * reduction in fidelity and PK-65's acceptance criterion "weights in their original
 * units" is NOT met by this build — it is met in grams instead. It is the right trade
 * only because of where `weight_unit` is going; if that plan is abandoned, this decision
 * should be revisited with it rather than left standing on its own.
 *
 * PK-67 HAS SINCE LANDED, AND THE BET ABOVE PAID OFF. `weight_unit` is gone; the unit is
 * one account-level metric/imperial setting and `gear_items.weight_grams` is the stored
 * weight. This file format needed no change for that — it already carried one gram number
 * and no unit — which is the outcome the reversal was gambling on. What DID change is
 * that the fidelity cost above is no longer a cost of this format: an item entered as
 * `4.4 oz` is stored as `124.738` g by the item form itself, so exporting grams loses
 * nothing the database was keeping. PK-65's acceptance criterion "weights in their
 * original units" is not merely unmet, it is now unmeetable by anything — there are no
 * original units to preserve.
 *
 * THE PRECISION ARGUMENT IS ALSO NOW MOOT, and it is recorded rather than deleted because
 * the round-trip guarantee it produced still has to hold. It used to run: `weight_grams`
 * was `numeric` with no declared scale (it was `weight * <factor>`, and the oz/lb factors
 * carry nine and five decimals), so `2.3 oz` stored `2.3` and generated `65.2039031875`
 * grams — more precision than the column an import writes back INTO could hold, meaning
 * our own export would not re-import. That was real, and `gearItemToJson`'s rounding to
 * three decimals is what fixed it.
 *
 * Under PK-67 the column IS `numeric(12, 3)` and holds grams directly, so a value read out
 * of it already has at most three decimals and the rounding is a no-op. It is kept anyway:
 * it costs one call, it keeps this module's output well-formed for a value that reached
 * the column by some path this schema did not anticipate, and deleting it would make
 * `tests/gear-json-round-trip.test.ts` the only thing standing between a changed column
 * scale and an export that cannot be imported.
 *
 * THE THOUSAND-TONNE EDGE IS CLOSED, not merely unlikely. It used to be reachable because
 * `weight` was `numeric(12, 3)` in the ENTERED unit, so a legal `1 000 000 kg` row
 * generated 1e9 grams — past the bound the importer enforces. There is no entered unit
 * now: the column stores grams and its own precision caps it just below 1e9, which is the
 * same bound, so a row that exists can always be exported and re-imported.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS NOT IN THE FILE, AND WHY EACH ONE IS ABSENT
 * ---------------------------------------------------------------------------
 *
 * - `id` and `user_id`: import CREATES rows. Carrying an id would invite an importer to
 *   honour it, which is either a collision with somebody else's row or a way to name a
 *   row you do not own; `user_id` defaults to `auth.uid()` on the column and the insert
 *   policy checks the same expression, so a file that carried one could only ever agree
 *   with the database or be refused by it. Neither is worth a field.
 * - `weight_unit`: see above.
 * - `weight_grams` IS in the file and, since PK-67, IS the column an import writes. It
 *   used to be generated `stored`, which Postgres refuses a direct write to, so the
 *   importer converted it into `weight` + `weight_unit: 'g'`; that pair no longer exists
 *   and the importer now writes the gram figure straight through. The file's field name
 *   matching the column's was chosen when the two were merely namesakes — it now matches
 *   because they are the same thing, which is the simpler state this format was betting on.
 * - `photo_path`: a storage key, meaningless outside the bucket it names. Exporting one
 *   would produce a file whose photo reference is dangling on arrival.
 * - `created_at` / `updated_at`: database audit timestamps about the ROW, not claims
 *   about the ITEM. `acquired_on` is the visitor's own claim about when they got the
 *   thing, and it is the one that travels — this is the same distinction PK-61 drew when
 *   it moved the closet's "Added" column off `created_at`.
 * - `volume_litres`: dropped from the product by PK-61. Not absent by accident.
 */

import { roundWeight } from '../units';
import type { Database } from '../database.types';

// ---------------------------------------------------------------------------
// The envelope
// ---------------------------------------------------------------------------

/**
 * The schema version, and the first field in every file this product writes.
 *
 * VERSIONED FROM DAY ONE, WITH NOTHING TO COMPARE AGAINST YET — which is precisely when
 * a version number has to be added, because the release that needs one and does not have
 * one can never acquire it: a file with no `packsheet` key is indistinguishable from a
 * file written by a future version that renamed it, and every later reader has to guess.
 * `json-import.ts` refuses any value other than this one, naming BOTH the version found
 * and the version understood (`unsupportedVersionMessage`), so the first incompatible
 * change tells its reader the FILE is ahead rather than that their data is broken — and
 * never produces a partially-understood import.
 */
export const PACKSHEET_SCHEMA_VERSION = 1;

/** The `kind` this build reads and writes. The envelope's discriminator exists so a file
 *  says what it is rather than being guessed at from its contents — see this module's
 *  header for why `'pack'` is a named refusal here rather than an unimplemented branch. */
export const GEAR_ITEMS_KIND = 'gear_items';

/** The `kind` PK-65 reserves for a pack export. Named here, and nowhere implemented, so
 *  that `json-import.ts` can tell "a valid Packsheet file this build cannot handle yet"
 *  apart from "not a Packsheet file" — a distinction a visitor holding a real pack export
 *  can act on, and one that a bare unknown-kind message destroys. */
export const PACK_KIND = 'pack';

/**
 * One gear item as it appears in a file. Every field is present on every item, including
 * the null ones.
 *
 * WHY NULLS ARE WRITTEN RATHER THAN OMITTED. An omitted key and a null key mean the same
 * thing to the importer (both are "not provided"), so this is a choice about the file as
 * a DOCUMENT, not about parsing. A file where every item has the same twelve keys is one
 * a person can read down a column of, diff against another export, and hand-edit without
 * having to know which fields exist — and "hand-edit a file and import it back" is a
 * workflow PK-65 explicitly supports rather than merely tolerates. The cost is a larger
 * file; the file is JSON either way and this is not a format where bytes are the
 * constraint.
 */
export interface PacksheetGearItem {
  readonly name: string;
  readonly brand: string | null;
  readonly category: string | null;
  readonly description: string | null;
  readonly quantity: number;
  /** Grams. See the header's "WEIGHT TRAVELS AS GRAMS" section — there is no unit field
   *  and this number is already rounded to what `gear_items.weight` can hold exactly. */
  readonly weight_grams: number;
  readonly price: number | null;
  readonly currency: string | null;
  readonly acquired_on: string | null;
  readonly status: string;
  readonly url: string | null;
  readonly notes: string | null;
}

/** The whole file. `data` is an object with an `items` array rather than the array
 *  itself, so that a later kind can add a sibling key (a pack file needs `pack` AND
 *  `categories`) without the envelope changing shape between kinds. */
export interface PacksheetGearItemsDocument {
  readonly packsheet: typeof PACKSHEET_SCHEMA_VERSION;
  readonly kind: typeof GEAR_ITEMS_KIND;
  readonly exported_at: string;
  readonly data: { readonly items: readonly PacksheetGearItem[] };
}

// ---------------------------------------------------------------------------
// Row -> file
// ---------------------------------------------------------------------------

/** The `gear_items` columns an export reads. Picked from the generated `Database` types
 *  rather than hand-written, for the reason `GearItemRow` in `src/lib/gear/form.ts`
 *  gives for doing the same: a column renamed in a migration becomes a BUILD failure
 *  here instead of a silently-absent field in every file written afterwards. */
export type GearExportRow = Pick<
  Database['public']['Tables']['gear_items']['Row'],
  | 'name'
  | 'brand'
  | 'category'
  | 'description'
  | 'quantity'
  | 'weight_grams'
  | 'price'
  | 'currency'
  | 'acquired_on'
  | 'status'
  | 'url'
  | 'notes'
>;

/** The PostgREST column list matching `GearExportRow`. Kept beside the type it describes
 *  so the two cannot drift — the same pairing `GEAR_SELECT`/`GearListRow` uses in
 *  `src/lib/gear/query.ts`. */
export const GEAR_EXPORT_SELECT =
  'name, brand, category, description, quantity, weight_grams, price, currency, acquired_on, status, url, notes';

/**
 * Turns one stored row into one file item.
 *
 * `weight_grams` IS NO LONGER NULLABLE IN THE GENERATED TYPES, and the null-handling
 * below is kept anyway. It used to be nullable because the column was
 * `generated always as (case weight_unit when 'g' then … end) stored`, and a `CASE` with
 * no `ELSE` yields NULL for a unit outside the CHECK constraint — a shape the constraint
 * made unreachable, but which the generated type was honest about. PK-67 dropped that
 * column and renamed the real one into its place, so the type is now plainly `number`.
 *
 * The `?? 0` stays because the reason for it was never really the generated column: the
 * value arrives through PostgREST's JSON, not out of the table, and the paragraph below
 * sets out why this export path must not throw for anything it is handed. `0` remains the
 * right fallback — it is the column's own default, so it is a value this schema already
 * means "no weight recorded" by.
 */
/**
 * `weight_grams` as a number this schema can write, for any value the column hands back.
 *
 * WHY THIS IS NOT JUST `roundWeight(grams ?? 0)`. `roundWeight` ASSERTS: it throws a
 * `RangeError` for `NaN`, `Infinity`, a negative, or anything that is not a number (see
 * `src/lib/units.ts`'s "THROW, NOT RETURN" section, which argues for that at length and is
 * right to). Every one of those is unreachable for a row that is actually in the table —
 * the CHECK constraints see to it. But this value does not come from the table directly,
 * it comes from PostgREST's JSON, the generated type for it is `number | null`, and the
 * export path has no try/catch anywhere above it: one such value and the visitor gets an
 * unhandled 500 instead of the page's own load error, on a route whose entire promise is
 * "your data is always exportable".
 *
 * The realistic way that happens is not corrupt data — it is a serialisation change.
 * PostgREST can be configured to send `numeric` as a STRING to preserve precision, and the
 * round-trip tests already hedge against it with `Number(data?.weight_grams)`. Under that
 * setting `roundWeight('907')` throws and EVERY export in the product fails at once. So
 * this coerces first and falls back to `0` — the same value the column itself defaults to,
 * and the same value a null already maps to — rather than letting a formatting decision
 * taken elsewhere become an outage here.
 */
function gramsForExport(grams: unknown): number {
  const value = typeof grams === 'string' ? Number(grams) : grams;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;
  return roundWeight(value);
}

export function gearItemToJson(row: GearExportRow): PacksheetGearItem {
  return {
    name: row.name,
    brand: row.brand,
    category: row.category,
    description: row.description,
    quantity: row.quantity,
    weight_grams: gramsForExport(row.weight_grams),
    price: row.price,
    currency: row.currency,
    acquired_on: row.acquired_on,
    status: row.status,
    url: row.url,
    notes: row.notes,
  };
}

/**
 * Builds the document for a set of rows. `exportedAt` is a parameter rather than a
 * `new Date()` inside this function so the whole module stays pure and a test can assert
 * on the exact bytes — the same reason `acquiredOnFutureCutoff` in
 * `src/lib/gear/form.ts` is a function a caller invokes rather than a captured constant.
 *
 * ALWAYS AN ARRAY, EVEN FOR ONE ITEM, and always the same envelope. A format that
 * degenerates to a bare object when a selection happens to have one member is a format
 * every consumer has to branch on, and the branch is only exercised by the rarest input —
 * which is exactly the branch that is wrong in production. One shape, always.
 */
export function buildGearItemsDocument(
  rows: readonly GearExportRow[],
  exportedAt: Date,
): PacksheetGearItemsDocument {
  return {
    packsheet: PACKSHEET_SCHEMA_VERSION,
    kind: GEAR_ITEMS_KIND,
    exported_at: exportedAt.toISOString(),
    data: { items: rows.map(gearItemToJson) },
  };
}

/** The file's bytes. Two-space indented and newline-terminated because this is a
 *  document a person is expected to open, read and hand-edit — see `PacksheetGearItem`'s
 *  own comment on writing nulls rather than omitting them, which is the same decision
 *  applied to the same reader. */
export function serialiseGearItemsDocument(document: PacksheetGearItemsDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

/**
 * The filename the download is offered under. Dated, so that a closet exported twice
 * does not silently overwrite itself in a downloads folder, and dated in UTC via
 * `toISOString` rather than in the visitor's zone: this string is generated on the
 * server, where the visitor's zone is not known, and a date that shifts by one depending
 * on where the request was served from is worse than one that is consistently UTC.
 */
export function gearItemsFilename(exportedAt: Date): string {
  return `packsheet-gear-${exportedAt.toISOString().slice(0, 10)}.json`;
}

// (An earlier draft re-exported `WEIGHT_DECIMALS` from here as
// `GEAR_JSON_WEIGHT_DECIMALS`, "so a caller rounds at the schema's own scale". Nothing
// ever called it: `gearItemToJson` rounds on every caller's behalf, so there is no caller
// left with a gram figure to round. Deleted rather than kept for symmetry — an export with
// no consumer is a claim about the module's surface that nothing keeps true.)
