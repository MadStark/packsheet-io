/**
 * Reading a Packsheet gear file (PK-65). `src/lib/gear/json-schema.ts` is the shape this
 * validates against and the direction that writes one; this module is the direction that
 * accepts one from outside, which is the direction that has to survive being handed
 * anything at all.
 *
 * TOTAL, LIKE EVERY OTHER PARSER IN THIS DIRECTORY. `parseGearItemsFile` never throws,
 * for any string, of any length, containing anything — the same promise `parseGearQuery`
 * makes over `URLSearchParams` and `parseBulkAction` makes over `FormData`. A file is
 * the most obviously hostile input this product accepts (it is the only one a visitor
 * composes in a text editor rather than through controls we rendered), so "no input may
 * 500 the request" is not a nicety here. `JSON.parse` throws on most of the strings that
 * exist; every call to it below is wrapped.
 *
 * WHY THIS IS IN src/lib/ AND NOT IN THE IMPORT PAGE. `vitest.config.ts` excludes
 * `src/pages/**` and `ci.yml` fails the build if a test file appears there, so validation
 * written in `.astro` frontmatter is validation nothing can execute. Every module in this
 * directory makes this argument for itself and this one is the sharpest case of it: what
 * a truncated file, a file of the wrong kind, or a file with one bad row out of two
 * hundred does is exactly the behaviour a test needs to pin, and none of it is reachable
 * through rendering a route.
 *
 * ---------------------------------------------------------------------------
 * THE FOUR SHAPES THIS ACCEPTS, AND WHY IT ACCEPTS MORE THAN IT WRITES
 * ---------------------------------------------------------------------------
 *
 * Export writes exactly one shape — the versioned envelope. Import accepts four:
 *
 *   1. the envelope        {"packsheet":1,"kind":"gear_items","data":{"items":[…]}}
 *   2. a bare array        [{…},{…}]
 *   3. a bare single item  {…}
 *   4. JSONL               one item object per line, no commas, no enclosing brackets
 *
 * That asymmetry is deliberate and it is not "be liberal in what you accept" as a
 * reflex. Shape 1 is what this product produces and is the only one that can carry a
 * version, so it is the only one a round-trip claim is ever made about. Shapes 2 to 4 are
 * what a PERSON produces: the output of a `jq` expression, a hand-written file, a dump
 * from another tool, a log-style append-only list. Refusing them would mean the answer to
 * "I have my gear as a JSON array, can I import it" is "not until you wrap it", which is
 * a format serving itself rather than the person holding the data. The cost of accepting
 * them is that shapes 2 to 4 carry no version, so a future incompatible change cannot
 * warn their authors — which is precisely why export never writes them.
 *
 * HOW A SHAPE IS TOLD FROM ANOTHER, in the one order that is unambiguous. The whole text
 * is offered to `JSON.parse` FIRST. If it parses, the file is JSON and shapes 1 to 3 are
 * separated by what the value is (an array, an envelope-ish object, or anything else,
 * which is treated as one item). Only if the whole text does NOT parse is JSONL tried,
 * because a JSONL file of one line is also valid JSON — and both readings of that file
 * produce the same single item, so there is no case where the order changes the answer.
 * A multi-line JSONL file cannot parse as JSON (the second line follows a complete value)
 * so it always falls through to the JSONL branch, which is the whole reason the fallback
 * is sound rather than a guess.
 *
 * ---------------------------------------------------------------------------
 * A FIELD MAY BE TEXT, A NUMBER, OR NULL — AND NOTHING ELSE
 * ---------------------------------------------------------------------------
 *
 * Every value is flattened to a string and handed to `parseGearFormValues`
 * (`src/lib/gear/form.ts`), which is the SAME function the add/edit form validates
 * through. That is the central decision in this module: there is no second set of rules
 * about what a valid gear item is. Every CHECK constraint mirror, the both-or-neither
 * pairing of price and currency, the strict calendar-date test and future cutoff on
 * `acquired_on`, the `http:`/`https:`-only URL rule, the `numeric(12,3)` and
 * `numeric(12,2)` bounds — all of it applies to an imported item because it is literally
 * the same code path, not because someone kept two copies in step.
 *
 * The flattening accepts a string or a number for any field and treats `null` and an
 * absent key alike as "not provided". It refuses a boolean, an array and a nested object
 * outright. Two different judgements are behind that one rule:
 *
 * - ACCEPTING A NUMBER WHERE TEXT IS EXPECTED, and a numeric string where a number is
 *   expected, is forgiveness aimed at a real author. This file is meant to be hand-edited
 *   — `PacksheetGearItem`'s own comment commits to that — and `"quantity": "2"` from a
 *   spreadsheet export, or `"name": 2024` from a closet of numbered dry bags, are a
 *   person being imprecise in a way that has exactly one sensible reading. The value
 *   still has to survive `parseGearFormValues` afterwards, so forgiveness here buys no
 *   invalid data: it only decides whether the refusal says "this is not text" or says
 *   what is actually wrong with the value.
 * - REFUSING A BOOLEAN, ARRAY OR OBJECT is not the same call. `"name": ["a","b"]` and
 *   `"price": {"amount":10}` have no single obvious reading, and `String()` would give
 *   them a confident wrong one (`'a,b'`, `'[object Object]'`) that then passes validation
 *   and is written to the database. This is the coercion `confirmsGearDeletion` refuses
 *   for the same reason in a much smaller place: a value that merely stringifies into
 *   something acceptable is the one case where being liberal produces silent corruption
 *   rather than a clear refusal.
 *
 * ---------------------------------------------------------------------------
 * UNKNOWN KEYS ARE REFUSED, WHICH IS THE UNUSUAL CHOICE HERE
 * ---------------------------------------------------------------------------
 *
 * The reflex for a document format is to ignore keys it does not recognise, and this
 * module does the opposite: an item carrying a key that is not one of the twelve is a bad
 * row, named. The reason is specific rather than a general taste for strictness. PK-65's
 * own written scope describes weight travelling as `weight` + `weight_unit`, and this
 * build ships `weight_grams` instead (see `json-schema.ts`'s header for that reversal).
 * Anyone who writes a file from the ticket text, from an older export, or from memory of
 * how the add-item form is laid out, will produce `{"weight": 4.4, "weight_unit": "oz"}`.
 * Ignoring unknown keys means that file imports CLEANLY, as an item weighing nothing at
 * all — a silent, plausible, entirely wrong result across every row, discovered whenever
 * somebody next looks at a pack total. `WEIGHT_KEY_MESSAGE` below exists to turn that
 * exact mistake into a sentence naming the field to use instead.
 *
 * The general form of that argument is why the rule is not narrowed to those two keys: a
 * misspelled `"catagory"` silently drops a category, a stale `"volume_litres"` silently
 * drops nothing but tells the author their file is fine when it is not, and neither is
 * distinguishable from a typo the author would want to know about. A format that accepts
 * a file and quietly keeps a subset of it is not a format anybody can trust a migration
 * to.
 */

import {
  parseGearFormValues,
  type GearFormValues,
  type GearItemInput,
  EMPTY_GEAR_FORM_VALUES,
} from './form';
import {
  GEAR_ITEMS_KIND,
  PACKSHEET_SCHEMA_VERSION,
  PACK_KIND,
  type PacksheetGearItem,
} from './json-schema';

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/**
 * The most items one file will import.
 *
 * MATCHES `MAX_BULK_IDS` (`src/lib/gear/bulk.ts`) ON PURPOSE, at 500, and for the same
 * reason that constant gives: the gear-closet migration's own "Deliberately no new
 * indexes" section puts a per-user closet at "a few hundred rows" in practice, so 500
 * covers importing an unusually large closet whole with room to spare. The two constants
 * are deliberately equal but deliberately separate — export is bounded by how many rows a
 * visitor can SELECT, import by how many rows a file can CONTAIN, and those are different
 * questions that happen to have the same answer today. Tying them together with one
 * constant would mean a later decision to raise one silently raises the other.
 *
 * PK-65's acceptance names 200 items as the size that must not time out; 500 is the cap,
 * not the target, and a single multi-row INSERT of 500 rows is one statement either way.
 *
 * OVER THE CAP IS A WHOLE-FILE REFUSAL, not a truncation. Importing the first 500 items
 * of a 900-item file and reporting success is the partial write this feature's entire
 * transactional promise exists to make impossible.
 */
export const MAX_IMPORT_ITEMS = 500;

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------
//
// Every string below is a complete, neutral sentence a visitor can read, and none of
// them is a raw JSON.parse message — `SyntaxError: Unexpected token } in JSON at position
// 417` is the exact class of string `src/lib/gear/form.ts`'s "NEVER A RAW POSTGRES OR
// POSTGREST STRING" rule exists to keep out of the interface, and a parser's own message
// is no better for having come from the standard library. The position it names is real
// and useful, so where one exists it is reported as a LINE, which is a thing a person can
// find in an editor, rather than as a character offset, which is not.

const EMPTY_FILE_MESSAGE = 'That file is empty.';
const NOT_JSON_MESSAGE =
  'We could not read that file. It needs to be JSON, or JSONL with one item per line.';
const NOT_A_GEAR_FILE_MESSAGE =
  'That file is not a Packsheet gear file. It needs to hold a gear item, or a list of them.';
const NO_ITEMS_MESSAGE = 'That file holds no gear items.';
const TOO_MANY_ITEMS_MESSAGE = `That file holds more than ${MAX_IMPORT_ITEMS} items, which is more than we import at once.`;
const PACK_FILE_MESSAGE =
  'That is a Packsheet pack file. This version can only import gear items, not packs.';
const ITEM_NOT_AN_OBJECT_MESSAGE = 'This is not a gear item.';

/** Names the version that was found AND the one this build understands, because "we
 *  cannot read this file" without either number is a dead end: a person holding a file
 *  from a newer Packsheet needs to know it is the file that is ahead, not the data that
 *  is broken. */
function unsupportedVersionMessage(found: unknown): string {
  const version = typeof found === 'number' || typeof found === 'string' ? String(found) : 'none';
  return `That file uses Packsheet schema version ${version}, and this version of Packsheet reads version ${PACKSHEET_SCHEMA_VERSION}.`;
}

/** Names the kind found, so an unrecognised one is distinguishable from a corrupt file.
 *  `'pack'` never reaches this — it has `PACK_FILE_MESSAGE`, which says something true
 *  and specific about a file that is perfectly valid and merely early. */
function unknownKindMessage(found: unknown): string {
  const kind = typeof found === 'string' && found.trim() !== '' ? `"${found}"` : 'nothing';
  return `That file says it holds ${kind}, and this version of Packsheet imports "${GEAR_ITEMS_KIND}".`;
}

/** The line a JSONL file first failed on. One-based, because that is what an editor's
 *  gutter shows — a zero-based index here would send somebody to the wrong line. */
function jsonlLineMessage(line: number): string {
  return `We could not read line ${line} of that file. Each line needs to be one complete gear item.`;
}

const TYPE_MESSAGE = 'This field needs to be text, a number, or empty.';

/** Names the characters rather than the encoding rule, because "unpaired UTF-16
 *  surrogate" is not a sentence anybody can act on. See `isStorableText`. */
const UNSTORABLE_TEXT_MESSAGE =
  'This field contains a character we cannot store. Remove any unusual invisible characters and try again.';

/** The one unknown-key case that gets its own sentence rather than the generic one. See
 *  this module's "UNKNOWN KEYS ARE REFUSED" section: a file written from PK-65's ticket
 *  text, or from an older export, carries `weight` and `weight_unit`, and the generic
 *  message would tell its author a true thing that does not tell them what to do. */
const WEIGHT_KEY_MESSAGE =
  'Weight travels as "weight_grams", a number of grams. Remove "weight" and "weight_unit" and give the weight in grams.';

function unknownKeyMessage(keys: readonly string[]): string {
  const named = keys.map((key) => `"${key}"`).join(', ');
  return keys.length === 1
    ? `This item has a field we do not recognise: ${named}.`
    : `This item has fields we do not recognise: ${named}.`;
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

/** Which of the four shapes a file turned out to be. Reported so the preview can say what
 *  it read — a person who meant to hand over JSONL and sees "a single item" has learned
 *  something about their file before importing it, not after. */
export type GearImportFormat = 'envelope' | 'array' | 'object' | 'jsonl';

/** One row of the file, validated. `position` is ONE-BASED and is the item's place among
 *  the ITEMS — deliberately not a line number, even for JSONL, because blank lines are
 *  skipped and a file with one would report numbers that do not match the lines they came
 *  from. (`jsonlLineMessage` DOES name a real line, because a parse failure is genuinely
 *  about a line rather than about an item; the two numbers can differ, and each is the
 *  right one for the thing it describes.) `label` is the item's own name where it has a
 *  usable one, so a problem reads "Katadyn BeFree" rather than "row 7" wherever it can. */
interface GearImportRowBase {
  readonly position: number;
  readonly label: string;
}

export interface GearImportRowOk extends GearImportRowBase {
  readonly ok: true;
  readonly values: GearItemInput;
}

export interface GearImportRowProblem extends GearImportRowBase {
  readonly ok: false;
  readonly errors: Readonly<Record<string, string>>;
}

export type GearImportRow = GearImportRowOk | GearImportRowProblem;

/**
 * What a file turned out to be.
 *
 * A DISCRIMINATED UNION ON `fileError`, NOT A RECORD WITH THREE INDEPENDENT FIELDS. An
 * earlier shape had `fileError: string | null` alongside `rows`, and described them as
 * mutually exclusive "in practice" — which is another way of saying the type permitted a
 * state the producer promised never to build, and left every consumer to take that promise
 * on trust. `{fileError: '…', rows: [aCleanRow]}` type-checked. Splitting the union means
 * a whole-file refusal HAS no `rows` field to read, so the impossible state cannot be
 * written down, and `importableGearItems` below narrows instead of casting.
 *
 * BOTH GOOD AND BAD ROWS ARE RETURNED on the readable branch, rather than the first
 * failure or only the failures. A preview that shows a visitor only what is wrong makes
 * them import blind; one that stops at the first bad row makes fixing a file an
 * n-round-trip exercise. This is the same reasoning `parseGearFormValues` gives for
 * validating all thirteen fields rather than returning at the first bad one, one level up.
 */
export type GearImportReport =
  | {
      readonly fileError: string;
      readonly format: GearImportFormat | null;
      readonly rows?: undefined;
    }
  | {
      readonly fileError: null;
      readonly format: GearImportFormat;
      readonly rows: readonly GearImportRow[];
    };

/** Every row the file yielded, or `[]` for a whole-file refusal. A helper rather than a
 *  field so that callers which only want to iterate do not each have to narrow first. */
export function gearImportRows(report: GearImportReport): readonly GearImportRow[] {
  return report.fileError === null ? report.rows : [];
}

/** Whether every row validated. A whole-file refusal is never clean, and neither is a
 *  readable file with no rows in it — a "clean" empty report would let a caller issue an
 *  empty import and report success. */
export function gearImportIsClean(
  report: GearImportReport,
): report is Extract<GearImportReport, { fileError: null }> {
  return report.fileError === null && report.rows.length > 0 && report.rows.every((row) => row.ok);
}

/**
 * The items to write, or `null` if the file is not clean.
 *
 * RETURNS null RATHER THAN THE GOOD ROWS, and that is the all-or-nothing rule made
 * structural instead of documented. PK-65's acceptance is "a truncated or hand-edited
 * file is rejected whole; nothing is written" — if this returned the valid subset, every
 * caller would be one forgotten check away from a partial import that reports success,
 * and the type system would not have an opinion. There is deliberately no exported way to
 * get at the good rows of a bad file.
 *
 * NO CAST. `gearImportIsClean` is a type PREDICATE, so after it returns true the compiler
 * knows `report.rows` exists — and `everyRowOk` below narrows each row to the `ok: true`
 * member. The previous version asserted `row as GearImportRowOk` on the strength of a
 * `boolean` the compiler could not connect to the rows, which meant the guarantee this
 * comment calls "structural" rested on an unchecked assertion. It does not any more.
 */
export function importableGearItems(report: GearImportReport): readonly GearItemInput[] | null {
  if (!gearImportIsClean(report)) return null;
  const items: GearItemInput[] = [];
  for (const row of report.rows) {
    if (!row.ok) return null;
    items.push(row.values);
  }
  return items;
}

/** How many rows failed. For the preview's summary line; counts rows, not errors, since a
 *  row with three bad fields is one row to fix. */
export function gearImportProblemCount(report: GearImportReport): number {
  return gearImportRows(report).reduce((count, row) => count + (row.ok ? 0 : 1), 0);
}

// ---------------------------------------------------------------------------
// Flattening one item
// ---------------------------------------------------------------------------

/**
 * The file's field names, mapped to the `GearFormValues` key each one fills.
 *
 * `weight_grams` MAPS TO `weight`, AND THAT IS THE WHOLE OF THE UNIT CONVERSION. The file
 * carries grams, and `validateItem` hands the shared validator `'metric'`, whose entry
 * unit is `g` — so the number reaching the column is the number in the file and no
 * arithmetic happens at all. (Before PK-67 the same guarantee was bought by setting
 * `values.weight_unit = 'g'`; the column is gone, the guarantee is not.) A conversion that is a constant is
 * not a conversion worth a function — and, more to the point, converting here would
 * reintroduce exactly the rounding this schema went to grams to avoid (see
 * `json-schema.ts`'s precision argument). The value is NOT rounded on the way in either:
 * `parseGearFormValues` enforces `numeric(12,3)`'s three decimal places itself, so a
 * hand-written `124.7381` is REFUSED rather than quietly rounded to `124.738`. Refusing
 * it is what keeps "what you exported is what you get back" a true statement instead of
 * an approximate one.
 */
const FILE_FIELDS: Readonly<Record<keyof PacksheetGearItem, keyof GearFormValues>> = {
  name: 'name',
  brand: 'brand',
  category: 'category',
  description: 'description',
  quantity: 'quantity',
  weight_grams: 'weight',
  price: 'price',
  currency: 'currency',
  acquired_on: 'acquired_on',
  status: 'status',
  url: 'url',
  notes: 'notes',
};

/**
 * The keys `FILE_FIELDS` knows, as a Set for the unknown-key sweep.
 *
 * A `Set`, NOT `key in FILE_FIELDS` OR A TRUTHY LOOKUP, and that is load-bearing rather
 * than stylistic. `JSON.parse` makes `__proto__` an ORDINARY OWN PROPERTY (unlike an
 * object literal, where it sets the prototype), so `{"__proto__": …}`, `{"constructor":
 * …}` and `{"toString": …}` all arrive as real keys this loop will see. A `Set` answers
 * `has` for exactly the twelve strings put into it and nothing else. `'toString' in
 * FILE_FIELDS` answers TRUE, and `FILE_FIELDS['toString']` is a Function — truthy — so
 * the obvious future tidy-up (one loop, `const formKey = FILE_FIELDS[key]; if (!formKey)
 * continue;`) type-checks, reads as equivalent, and silently reopens the hole. The
 * `Record<keyof PacksheetGearItem, …>` annotation above is the other half of that guard:
 * it makes `FILE_FIELDS['toString']` a type error rather than a plausible expression.
 */
const KNOWN_KEYS = new Set<string>(Object.keys(FILE_FIELDS));

/** Maps a `GearFormValues` key back to the FILE key that fills it, so an error raised by
 *  the shared validator is reported against the field name the file actually uses. Built
 *  by inverting `FILE_FIELDS` rather than written out, so the two cannot disagree — see
 *  `fileFieldFor` for why the translation is needed at all. */
const FORM_TO_FILE_FIELD: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(FILE_FIELDS).map(([fileKey, formKey]) => [formKey, fileKey]),
);

/**
 * The name to report a problem under.
 *
 * WITHOUT THIS, THE PREVIEW CONTRADICTS ITSELF IN ONE TABLE. `parseGearFormValues` is the
 * add/edit FORM's validator and raises its errors under the FORM's field names, so a bad
 * weight comes back keyed `weight` — the exact field name this file format refuses, and
 * whose refusal message (`WEIGHT_KEY_MESSAGE`) tells the reader to use `weight_grams`
 * instead. Reported untranslated, a file with a too-precise weight and a leftover
 * `weight` key showed one row saying "weight: enter a weight with up to three decimal
 * places" directly above another saying "weight is not a field, use weight_grams" — both
 * true of different things, and together unactionable. Anything with no file-side name
 * (`item`, which is this module's own) is passed through unchanged.
 */
function fileFieldFor(formKey: string): string {
  return FORM_TO_FILE_FIELD[formKey] ?? formKey;
}

/** The keys that get `WEIGHT_KEY_MESSAGE` instead of the generic unknown-key sentence:
 *  the two a file written from PK-65's own ticket text, or from an older export, carries.
 *  `volume_litres` is deliberately NOT here — PK-61 removed it from the product, so it is
 *  neither a weight field to redirect nor something this schema has an alternative for,
 *  and telling its author "use weight_grams instead" would be advice about the wrong
 *  field. It earns the generic unknown-key sentence, which is the true one. */
const RETIRED_WEIGHT_KEYS = new Set(['weight', 'weight_unit']);

/**
 * One JSON value as the string `parseGearFormValues` expects, or `null` for a value whose
 * type has no honest reading. See the module header's "A FIELD MAY BE TEXT, A NUMBER, OR
 * NULL" section for why the line falls exactly here.
 *
 * A NON-FINITE NUMBER CAN ARRIVE THROUGH `JSON.parse`, WHICH IS NOT OBVIOUS AND IS WHY IT
 * IS GUARDED. JSON has no literal for `NaN` or `Infinity`, so the natural conclusion is
 * that neither can reach this function — but a finite literal that OVERFLOWS a double
 * does: `JSON.parse('1e400')` is `Infinity`, and `-1e400` is `-Infinity`. For the numeric
 * fields that would merely fail validation downstream. For a TEXT field it would not:
 * `String(Infinity)` is `'Infinity'`, so `{"name": 1e400}` would import as an item
 * genuinely named "Infinity" — the confident-wrong-`String()` coercion this module's
 * header refuses for arrays and objects, arriving by the one route the guard-free version
 * assumed was closed. Refused here instead, with the same type message, because a number
 * too large to represent is not a value with an honest reading either.
 */
function fieldToString(value: unknown): string | null {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  return null;
}

/**
 * Whether a string is one Postgres will accept into a `text` column.
 *
 * MIRRORS A LIMIT THAT IS NOT A CHECK CONSTRAINT, which is why it is easy to miss.
 * Postgres `text` cannot hold a NUL byte (`U+0000`) at all, and PostgREST cannot transport
 * an unpaired UTF-16 surrogate — the first fails with `22P05 unsupported Unicode escape
 * sequence`, the second with `22P02 invalid input syntax for type json`. Neither is
 * expressible as a CHECK constraint, so neither has a mirror in `src/lib/gear/form.ts`,
 * and a form cannot produce either (a browser will not submit a lone surrogate). A FILE
 * can: `{"name": "a\u0000b"}` is well-formed JSON that `JSON.parse` accepts happily.
 *
 * Without this, such a file previewed as CLEAN — "Ready to import 1 item" — and then died
 * at the INSERT, where the only thing the page can say is that it could not confirm
 * whether the write went through. That is the worst possible place for it to fail: the
 * whole point of the preview is that a file which will not import is refused BEFORE
 * anything is attempted, with the row and the reason named. This moves the refusal back
 * to where every other refusal lives.
 */
function isStorableText(value: string): boolean {
  if (value.includes('\u0000')) return false;
  // Well-formed surrogate PAIRS are fine — they are ordinary astral characters, and gear
  // names carry emoji routinely. Removing every valid pair first leaves only unpaired
  // halves, so what still matches the surrogate range is exactly what PostgREST cannot
  // transport. `String.prototype.isWellFormed` says this in one call but is too recent to
  // rely on across every runtime this ships to.
  return !/[\uD800-\uDFFF]/.test(value.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ''));
}

/**
 * Reads one item object into a `GearFormValues`, collecting the type and unknown-key
 * problems that are this module's own rather than the shared validator's.
 *
 * STATUS DEFAULTS TO `'owned'` WHEN THE FILE DOES NOT SAY, and this is the one place an
 * imported item is treated differently from a submitted form. `parseGearFormValues`
 * REQUIRES a status, because the form's status control is a radio group that always posts
 * something, so a blank one there means a stale or tampered submission. A file is not a
 * radio group: omitting a key is the ordinary way a hand-written document declines to
 * express a field, and `gear_items.status` carries a real column default (`'owned'`) that
 * direct-SQL writes already rely on. This is the identical judgement PK-63 made for
 * `quantity` and `weight` — a real column default means blank is "did not say, use the
 * default" rather than an error — applied to the one field whose form control made it
 * look mandatory. An explicitly WRONG status ('Owned', 'active') still fails, through the
 * shared validator, exactly as it does on the form — but note that an EMPTY one ('', or
 * whitespace) does NOT: it is indistinguishable from "did not say" after trimming, and is
 * defaulted rather than refused. That is the intended reading for a document, where a
 * blank value and an absent key mean the same thing, and it is the opposite of the form's
 * reading, where a blank status can only mean a tampered submission.
 */
function itemToFormValues(item: Record<string, unknown>): {
  readonly values: GearFormValues;
  readonly errors: Record<string, string>;
} {
  const values: GearFormValues = { ...EMPTY_GEAR_FORM_VALUES };
  const errors: Record<string, string> = {};

  const unknown: string[] = [];
  for (const key of Object.keys(item)) {
    if (KNOWN_KEYS.has(key)) continue;
    if (RETIRED_WEIGHT_KEYS.has(key)) {
      errors.weight_grams = WEIGHT_KEY_MESSAGE;
      continue;
    }
    unknown.push(key);
  }
  if (unknown.length > 0) errors.item = unknownKeyMessage(unknown);

  for (const [fileKey, formKey] of Object.entries(FILE_FIELDS)) {
    // `Object.prototype.hasOwnProperty.call`, not `fileKey in item`: `in` walks the
    // prototype chain, so it answers true for any field name that collides with an
    // `Object.prototype` member. None of the twelve does today, which is the only reason
    // the `in` form was not already a bug — add a field called `constructor` or
    // `toString` and every item in every file would silently inherit a value from the
    // prototype. An own-property test cannot acquire that failure mode later.
    if (!Object.prototype.hasOwnProperty.call(item, fileKey)) continue;
    const flattened = fieldToString(item[fileKey]);
    if (flattened === null) {
      errors[fileKey] = TYPE_MESSAGE;
      continue;
    }
    // Refused HERE rather than left to the database — see `isStorableText` for why this
    // one limit has no CHECK constraint to mirror and so no mirror in `form.ts` either.
    if (!isStorableText(flattened)) {
      errors[fileKey] = UNSTORABLE_TEXT_MESSAGE;
      continue;
    }
    values[formKey] = flattened;
  }

  // See this function's own comment. Applied after the loop so an explicitly present
  // `"status": null` — "I have no opinion" — defaults the same way an absent key does,
  // while an explicitly present `"status": "wishlist"` is untouched.
  if (values.status.trim() === '') values.status = 'owned';

  // PK-67 removed `values.weight_unit`, which this function used to set to `'g'` here so
  // the shared validator would read the file's number as grams. The guarantee it bought is
  // unchanged and now lives at the call site instead: `validateItem` passes `'metric'` to
  // `parseGearFormValues`, whose entry unit is `g` with a factor of 1. See that call, and
  // `parseGearFormValues`' own comment on why the importer must never pass the importing
  // account's preference.
  return { values, errors };
}

/** The name to show for a row. Falls back to its place in the file, so every row has
 *  something a person can find it by even when `name` is the field that is wrong. */
function rowLabel(item: Record<string, unknown>, position: number): string {
  const name = item.name;
  if (typeof name === 'string' && name.trim() !== '') return name.trim();
  return `Item ${position}`;
}

/** Validates one item, merging this module's own problems (bad types, unknown keys) with
 *  the shared validator's. Both are reported together rather than short-circuiting, so a
 *  row with a stray `weight_unit` AND a missing name lists both. */
function validateItem(value: unknown, position: number): GearImportRow {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {
      ok: false,
      position,
      label: `Item ${position}`,
      errors: { item: ITEM_NOT_AN_OBJECT_MESSAGE },
    };
  }

  const item = value as Record<string, unknown>;
  const label = rowLabel(item, position);
  const { values, errors } = itemToFormValues(item);
  // `'metric'` UNCONDITIONALLY, never the importing account's setting: the file carries
  // `weight_grams`, and metric's entry unit is `g`, so the number is stored exactly as the
  // file gave it. An imperial account importing the same file must get the same closet —
  // see `parseGearFormValues`' comment for what passing a preference here would do.
  const parsed = parseGearFormValues(values, 'metric');

  if (parsed.ok && Object.keys(errors).length === 0) {
    return { ok: true, position, label, values: parsed.values };
  }

  // The shared validator raises its errors under the FORM's field names; this report is
  // about a FILE, so they are translated back before being merged. See `fileFieldFor` for
  // the contradiction that appears in the preview when they are not. This module's own
  // errors are already keyed by file name and are spread last, so a specific complaint
  // (a stray `weight` key) wins over a generic one about the same field.
  const translated: Record<string, string> = {};
  if (!parsed.ok) {
    for (const [formKey, message] of Object.entries(parsed.errors)) {
      translated[fileFieldFor(formKey)] = message;
    }
  }

  return {
    ok: false,
    position,
    label,
    errors: { ...translated, ...errors },
  };
}

// ---------------------------------------------------------------------------
// Reading the file
// ---------------------------------------------------------------------------

/** `JSON.parse` as a total function. Every caller below needs "did this parse" rather
 *  than the thrown `SyntaxError`, whose message is not something to show anybody. */
function tryParseJson(text: string): { readonly ok: true; readonly value: unknown } | null {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return null;
  }
}

/** Whether an object is claiming to BE an envelope rather than to be a single gear item.
 *  Keyed on `packsheet`/`kind` rather than on `data`, because those two are the fields no
 *  gear item has and every envelope does — an object carrying either is a file that meant
 *  to be an envelope, and telling its author their version or kind is wrong is far more
 *  use than telling them a gear item has some unrecognised fields. */
function looksLikeEnvelope(value: Record<string, unknown>): boolean {
  return 'packsheet' in value || 'kind' in value;
}

/** Unwraps an envelope to its items, or reports why it cannot be. Version is checked
 *  BEFORE kind, deliberately: a file from a future schema may well use a `kind` this
 *  build has never heard of, and "this file is newer than this Packsheet" is the useful
 *  half of that pair — reporting the unknown kind first would send its author looking for
 *  a problem in their data. */
function unwrapEnvelope(
  envelope: Record<string, unknown>,
): { readonly items: readonly unknown[] } | { readonly fileError: string } {
  if (envelope.packsheet !== PACKSHEET_SCHEMA_VERSION) {
    return { fileError: unsupportedVersionMessage(envelope.packsheet) };
  }
  if (envelope.kind === PACK_KIND) return { fileError: PACK_FILE_MESSAGE };
  if (envelope.kind !== GEAR_ITEMS_KIND) return { fileError: unknownKindMessage(envelope.kind) };

  const data = envelope.data;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { fileError: NOT_A_GEAR_FILE_MESSAGE };
  }
  const items = (data as Record<string, unknown>).items;
  if (!Array.isArray(items)) return { fileError: NOT_A_GEAR_FILE_MESSAGE };
  return { items };
}

/**
 * Reads a JSONL body: one complete item per non-blank line. Blank lines are skipped
 * rather than refused — a trailing newline is what every text editor writes, and a file
 * that fails because it ends the way files end would be indefensible.
 *
 * THE FIRST LINE FAILING MEANS SOMETHING DIFFERENT FROM A LATER ONE FAILING, and the two
 * get different messages. This function is only ever reached because the whole text did
 * not parse as JSON, so if the very first item also does not parse, nothing about the
 * file ever looked like JSONL and "we could not read line 1" would be a misleading
 * diagnosis — it points at a line when the problem is the file. `NOT_JSON_MESSAGE` names
 * both formats instead. A failure at line 12 of a file whose first eleven lines parsed IS
 * a line problem, and naming the line is the single most useful thing to say about a
 * truncated append-only file, which is the way JSONL files usually break.
 */
function parseJsonl(
  text: string,
): { readonly items: readonly unknown[] } | { readonly fileError: string } {
  const items: unknown[] = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || line.trim() === '') continue;
    const parsed = tryParseJson(line);
    if (parsed === null) {
      return { fileError: items.length === 0 ? NOT_JSON_MESSAGE : jsonlLineMessage(index + 1) };
    }
    items.push(parsed.value);
  }
  return { items };
}

/**
 * Reads a file and reports every item in it, validated. Never throws.
 *
 * THE ORDER OF THE CHECKS IS THE ORDER A PERSON CAN ACT ON. Whole-file problems are
 * settled first and alone — an unreadable file, a version this build cannot read, a pack
 * file, an empty list, a list over the cap — because none of them has a per-row answer
 * and reporting row problems underneath one of them would bury it. Only once the file is
 * known to be a list of gear items of a readable version does anything look at a row.
 */
export function parseGearItemsFile(input: string): GearImportReport {
  // A LEADING BYTE-ORDER MARK IS STRIPPED, NOT REFUSED. Several Windows editors — Notepad
  // among them — write one when saving UTF-8, so a visitor who exported their closet,
  // opened the file to edit one line and saved it has a file whose first character is
  // U+FEFF rather than `{`. That is not valid JSON and `JSON.parse` refuses it, which
  // would tell the author their
  // Packsheet export is not a Packsheet file and leave them no way forward. The BOM
  // carries no information here (the string has already been decoded as UTF-8 by the time
  // it reaches this function), so dropping it loses nothing. Only a LEADING one: a U+FEFF
  // in the middle of a gear name is that name's business.
  const text = input.startsWith('\uFEFF') ? input.slice(1) : input;

  if (text.trim() === '') {
    return { fileError: EMPTY_FILE_MESSAGE, format: null };
  }

  let format: GearImportFormat;
  let raw: readonly unknown[];

  const whole = tryParseJson(text);
  if (whole === null) {
    // Not JSON as a whole. See the header's "HOW A SHAPE IS TOLD FROM ANOTHER": this is
    // the only remaining shape, because a JSONL file of one line would have parsed above
    // and produced the identical single item.
    const jsonl = parseJsonl(text);
    if ('fileError' in jsonl) return { fileError: jsonl.fileError, format: null };
    format = 'jsonl';
    raw = jsonl.items;
  } else if (Array.isArray(whole.value)) {
    format = 'array';
    raw = whole.value;
  } else if (typeof whole.value === 'object' && whole.value !== null) {
    const object = whole.value as Record<string, unknown>;
    if (looksLikeEnvelope(object)) {
      const unwrapped = unwrapEnvelope(object);
      if ('fileError' in unwrapped) return { fileError: unwrapped.fileError, format: null };
      format = 'envelope';
      raw = unwrapped.items;
    } else {
      format = 'object';
      raw = [object];
    }
  } else {
    // Valid JSON, but a number, a string, a boolean or null — none of which is a gear
    // item or a list of them, however well-formed it is.
    return { fileError: NOT_A_GEAR_FILE_MESSAGE, format: null };
  }

  if (raw.length === 0) return { fileError: NO_ITEMS_MESSAGE, format };
  if (raw.length > MAX_IMPORT_ITEMS) {
    return { fileError: TOO_MANY_ITEMS_MESSAGE, format };
  }

  return {
    fileError: null,
    format,
    rows: raw.map((item, index) => validateItem(item, index + 1)),
  };
}
