/**
 * The import page's submission (PK-65): which of the two steps a POST is, where the file's
 * text came from, and the handful of sentences the page counts things out loud with.
 * `src/lib/gear/json-import.ts` decides what that text MEANS; this module only decides
 * what the visitor handed over and which step they are on.
 *
 * WHY IT IS A SEPARATE MODULE FROM json-import.ts. That one is pure and knows nothing
 * about the web — a string goes in, a report comes out, and it is testable by anybody
 * with a string. This one knows about `FormData`, `File` and byte limits, which are
 * facts about an HTTP request rather than about the format. Keeping the format parser
 * free of them means the format parser stays the thing a future CLI, a paste box or a
 * drag-and-drop handler can all reuse without inheriting a `FormData`. It is the same
 * split `src/lib/gear/bulk.ts` (reads a form) and `src/lib/gear/mutations.ts` (issues the
 * query) already draw, one layer up.
 *
 * WHY IT IS NOT IN THE PAGE, as ever: `vitest.config.ts` excludes `src/pages/**`, so a
 * size cap or a two-step gate written in `.astro` frontmatter is one nothing can execute.
 * The gate below is the same class of thing as `confirmsGearDeletion` — the difference
 * between "show me what this would do" and "do it".
 */

// The item cap, borrowed rather than restated: `importedBannerMessage` refuses any count
// larger than one import could possibly have written, and a second copy of that number
// here would be a second thing to update. One-way dependency — `json-import.ts` knows
// nothing about forms, which is the split this module's own comment describes above.
import { MAX_IMPORT_ITEMS } from './json-import';

// ---------------------------------------------------------------------------
// Fields and intents
// ---------------------------------------------------------------------------

/** The `<input name="…">` values the import form uses. */
export const IMPORT_FORM_FIELD = {
  intent: 'intent',
  /** The uploaded file. */
  file: 'file',
  /** The paste box, and — on the confirm step — the hidden field carrying the exact text
   *  the preview was built from. One field for both, deliberately: the confirm step
   *  re-parses and re-validates that text from scratch, so it travels the same path a
   *  pasted file does and gets the same refusals. Nothing is carried over from the
   *  preview except the bytes themselves; the preview's VERDICT is never trusted on the
   *  way back in. */
  text: 'text',
} as const;

/** The two steps. The first writes nothing and only reports what it read; the second is
 *  the one that inserts. */
export const IMPORT_INTENT = {
  preview: 'import-preview',
  confirm: 'import-confirm',
} as const;

export type ImportIntent = (typeof IMPORT_INTENT)[keyof typeof IMPORT_INTENT];

const IMPORT_INTENT_VALUES: readonly string[] = Object.values(IMPORT_INTENT);

/** Narrows an `intent` field, mirroring `isBulkIntent` in `src/lib/gear/bulk.ts`. */
export function isImportIntent(value: unknown): value is ImportIntent {
  return typeof value === 'string' && IMPORT_INTENT_VALUES.includes(value);
}

// ---------------------------------------------------------------------------
// Size
// ---------------------------------------------------------------------------

/**
 * The largest file this page will read, in bytes.
 *
 * WHY A BYTE CAP EXISTS WHEN `MAX_IMPORT_ITEMS` ALREADY CAPS THE ITEMS. The item cap is
 * applied AFTER parsing, which means a 200 MB file has already been read into memory and
 * handed to `JSON.parse` before anything counts anything. This runs on a Worker with a
 * bounded memory allowance; the item cap protects the database and this cap protects the
 * request. They are two different limits on two different resources and neither implies
 * the other.
 *
 * ONE MEBIBYTE IS DELIBERATELY GENEROUS AGAINST `MAX_IMPORT_ITEMS`. A fully-populated
 * item — every optional field filled, a long description and notes — serialises to a few
 * hundred bytes, so 500 of them is comfortably under 300 KB even indented. The slack is
 * for files that are legitimately fat rather than legitimately long: heavy whitespace, a
 * pretty-printer that indents with tabs, notes with a paragraph in them. A file that
 * exceeds this is not a closet, and telling its author so is more useful than spending a
 * request's memory finding out.
 */
export const MAX_IMPORT_BYTES = 1024 * 1024;

const TOO_LARGE_MESSAGE = 'That file is larger than 1 MiB, which is larger than we import.';
const NOTHING_SUBMITTED_MESSAGE = 'Choose a file to import, or paste one in.';

/** A file WAS chosen and could not be read — a stream that died mid-upload, a file removed
 *  from disk between the picker and the submit. Deliberately NOT
 *  `NOTHING_SUBMITTED_MESSAGE`: telling somebody who has just chosen a file to choose a
 *  file describes a state they are not in, and the only action it suggests (pick it again)
 *  is the one they already took. This names what happened and suggests the thing that
 *  might actually work. */
const UNREADABLE_FILE_MESSAGE =
  'We could not read that file. It may not have finished uploading — try choosing it again, or paste its contents in below.';

// ---------------------------------------------------------------------------
// Reading a submission
// ---------------------------------------------------------------------------

/**
 * What a POST to the import page turned out to be: the step, and the file's text.
 * `error` and `text` are mutually exclusive — a submission either produced bytes to parse
 * or a reason it did not.
 */
export type ImportSubmission =
  | {
      readonly ok: true;
      readonly intent: ImportIntent;
      readonly text: string;
      /** Which control the bytes came from. The page needs this to decide whether it can
       *  put the text back on a re-render: a paste box can be re-filled from the server, a
       *  file input cannot, and echoing a file's whole contents into a textarea the
       *  visitor never typed in would be a surprise rather than a courtesy. */
      readonly source: 'file' | 'text';
    }
  | { readonly ok: false; readonly error: string };

/**
 * Reads a submission. Never throws — total over any `FormData`, the same promise
 * `parseBulkAction` makes.
 *
 * THE FILE WINS OVER THE PASTE BOX when both carry something. The tie has to be broken
 * somehow because ONE form on the import page offers both controls, and a visitor who
 * picks a file and then pastes something — or pastes, then picks — sends both. Refusing
 * that submission would be a refusal to make an obvious choice. The file is taken as the
 * more deliberate act: choosing one is a decision made in a dialog, while text can end up
 * in a textarea by autofill, by a restored session, or by a paste the visitor has since
 * thought better of and not cleared.
 *
 * IT IS NOT ABOUT THE CONFIRM STEP, which an earlier version of this comment claimed. The
 * confirm form (`src/pages/gear/import.astro`) contains only the hidden `text` field and
 * its button — there is no file input on it at all — so the "both present" case cannot
 * arise there and the precedence never applies to it. The rule is right; that was the
 * wrong justification for it.
 *
 * `File.size` IS CHECKED BEFORE `File.text()` IS AWAITED, WHICH SAVES LESS THAN IT LOOKS
 * LIKE — and the limit of that is worth stating plainly rather than leaving a reader to
 * assume this is a real upload guard. By the time this function runs, the caller has
 * already awaited `Astro.request.formData()`, which buffers the ENTIRE multipart body.
 * The bytes are in memory before anything here gets a say. Checking `size` first avoids
 * only the SECOND copy — the decoded string — which is roughly half the cost and not
 * nothing, but it does not stop a large upload being received.
 *
 * A guard that genuinely refused one would have to test `Content-Length` before touching
 * `formData()`, which belongs in the page or in middleware rather than here, and is not
 * in this change. What this cap really is: a bound on what this feature will PROCESS, so
 * a 900 MB file fails with a sentence rather than by exhausting the Worker mid-parse.
 * Recorded as the honest description rather than the flattering one.
 *
 * The pasted text is measured after the fact for the same reason and with the same
 * caveat — it has already been read by the time `formData()` resolved, so the check keeps
 * the two paths' limits identical rather than protecting anything.
 *
 * BYTES, NOT CHARACTERS. `File.size` is a byte count and `TextEncoder` gives the pasted
 * text the same measure. Comparing a `File`'s bytes against a string's `.length` would
 * apply two different limits to the same content and let a paste of multi-byte text (any
 * non-ASCII gear name) through at up to four times the cap.
 */
export async function readImportSubmission(form: FormData): Promise<ImportSubmission> {
  const intentRaw = form.get(IMPORT_FORM_FIELD.intent);
  const intent = typeof intentRaw === 'string' ? intentRaw.trim() : '';
  if (!isImportIntent(intent)) return { ok: false, error: NOTHING_SUBMITTED_MESSAGE };

  const file = form.get(IMPORT_FORM_FIELD.file);
  if (file instanceof File && file.size > 0) {
    if (file.size > MAX_IMPORT_BYTES) return { ok: false, error: TOO_LARGE_MESSAGE };
    // A `File` whose bytes cannot be read (a stream that died mid-upload) rejects rather
    // than resolving to a short string, and this module promises not to throw.
    try {
      return { ok: true, intent, text: await file.text(), source: 'file' };
    } catch {
      return { ok: false, error: UNREADABLE_FILE_MESSAGE };
    }
  }

  const pasted = form.get(IMPORT_FORM_FIELD.text);
  if (typeof pasted === 'string' && pasted.trim() !== '') {
    if (new TextEncoder().encode(pasted).length > MAX_IMPORT_BYTES) {
      return { ok: false, error: TOO_LARGE_MESSAGE };
    }
    return { ok: true, intent, text: pasted, source: 'text' };
  }

  return { ok: false, error: NOTHING_SUBMITTED_MESSAGE };
}

// ---------------------------------------------------------------------------
// Counting things out loud
// ---------------------------------------------------------------------------

/**
 * `"1 item"` / `"6 items"`.
 *
 * A HELPER RATHER THAN A TERNARY AT EACH CALL SITE because there are four of them on the
 * import page — two headings and two button labels — and they were not agreeing. The
 * first version of that page rendered "7 of 8 items needs fixing", which is wrong twice
 * over: the verb agrees with the COUNT OF PROBLEMS, not with the total, and the noun
 * agrees with whichever number it follows. It read as broken English in the one place a
 * visitor is already being told their file is broken. Both are decided below, once.
 */
export function itemCount(count: number): string {
  return `${count} ${count === 1 ? 'item' : 'items'}`;
}

/** The preview's heading when everything in the file validated. */
export function readyHeading(total: number): string {
  return `Ready to import ${itemCount(total)}`;
}

/**
 * The preview's heading when something did not. The verb agrees with `problems` — "1 of 8
 * items NEEDS fixing", "7 of 8 items NEED fixing" — because that is the subject of the
 * sentence; the noun after "of" agrees with `total`.
 */
export function problemHeading(problems: number, total: number): string {
  return `${problems} of ${itemCount(total)} ${problems === 1 ? 'needs' : 'need'} fixing`;
}

/**
 * The closet's "you just imported N items" banner, or `null` for any value that is not a
 * count this application wrote.
 *
 * TOTAL OVER A HAND-EDITED QUERY STRING, like every other parser in this directory. The
 * parameter arrives in a URL a visitor can type, so `?imported=abc`, `?imported=-4`,
 * `?imported=1e9`, `?imported=` and a repeated parameter all have to mean "no banner"
 * rather than a rendered `NaN` or a sentence claiming a negative number of items. `0` is
 * refused too, and that is the interesting one: a successful import always writes at
 * least one row (`importableGearItems` refuses an empty file), so `imported=0` cannot
 * have come from this application, and "0 items imported" is a confusing thing to
 * congratulate somebody with.
 *
 * THE CEILING IS `MAX_IMPORT_ITEMS` because that is the most a single import can write,
 * so any larger number is likewise not ours. That keeps the banner honest against a
 * bookmarked or shared link without the closet having to re-count anything.
 *
 * WHY IT IS HERE AND NOT A TERNARY IN THE PAGE: `vitest.config.ts` excludes
 * `src/pages/**`. Every rule above is a rule about a visitor-controlled string, which is
 * exactly the class of logic this directory exists to keep testable.
 */
export function importedBannerMessage(raw: string | null): string | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  // Digits only: `Number('1e3')`, `Number(' 12 ')` and `Number('0x10')` all produce a
  // number, and none of them is a count this application put in a URL.
  if (!/^\d+$/.test(trimmed)) return null;
  const count = Number(trimmed);
  if (count < 1 || count > MAX_IMPORT_ITEMS) return null;
  return `Imported ${itemCount(count)} into your closet.`;
}
