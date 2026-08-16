/**
 * The import page's submission (PK-65): which of the two steps a POST is, and where the
 * file's text came from. `src/lib/gear/json-import.ts` decides what that text MEANS; this
 * module only decides what the visitor handed over and which step they are on.
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

const TOO_LARGE_MESSAGE = 'That file is larger than 1 MB, which is larger than we import.';
const NOTHING_SUBMITTED_MESSAGE = 'Choose a file to import, or paste one in.';

// ---------------------------------------------------------------------------
// Reading a submission
// ---------------------------------------------------------------------------

/**
 * What a POST to the import page turned out to be: the step, and the file's text.
 * `error` and `text` are mutually exclusive — a submission either produced bytes to parse
 * or a reason it did not.
 */
export type ImportSubmission =
  | { readonly ok: true; readonly intent: ImportIntent; readonly text: string }
  | { readonly ok: false; readonly error: string };

/**
 * Reads a submission. Never throws — total over any `FormData`, the same promise
 * `parseBulkAction` makes.
 *
 * THE FILE WINS OVER THE PASTE BOX when both carry something, and the tie is broken that
 * way rather than by refusing the submission because a browser can populate both without
 * the visitor meaning anything by it: the confirm step re-posts the preview's text in the
 * hidden `text` field while the file input, if the browser restored it, still names the
 * file that produced that text. They agree in that case. When they disagree, the file is
 * the more recent, more deliberate act — a person who has just picked a file has said
 * what they want more clearly than the box they filled in beforehand.
 *
 * `File.size` IS CHECKED BEFORE `File.text()` IS AWAITED, which is the entire point of
 * checking it: reading a 200 MB upload into a string in order to discover it is too long
 * is the failure this cap exists to prevent, so a cap applied to the resulting string
 * would be decorative. The pasted text is measured after the fact instead — it has
 * already been read into memory by the time `formData()` resolved, so there is nothing
 * left to save, and the check is there to keep the two paths' limits identical rather
 * than to protect anything.
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
      return { ok: true, intent, text: await file.text() };
    } catch {
      return { ok: false, error: NOTHING_SUBMITTED_MESSAGE };
    }
  }

  const pasted = form.get(IMPORT_FORM_FIELD.text);
  if (typeof pasted === 'string' && pasted.trim() !== '') {
    if (new TextEncoder().encode(pasted).length > MAX_IMPORT_BYTES) {
      return { ok: false, error: TOO_LARGE_MESSAGE };
    }
    return { ok: true, intent, text: pasted };
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
