/**
 * Bulk actions for the gear closet list (PK-4) — set category, set status, and delete,
 * which really deletes: the row leaves `gear_items` and does not come back. There is no
 * trash to fish it out of and no undo to press, so the two-step confirmation
 * `BULK_FORM_FIELD.confirm` implements is the whole of what stands between a selection
 * and its removal; see that field's own comment.
 *
 * WHY THIS LIVES IN src/lib/ RATHER THAN IN THE PAGE. Same reasoning as
 * `src/lib/gear/form.ts` and `src/lib/gear/query.ts`: `vitest.config.ts:64` excludes
 * `src/pages/` from the test run, and a bulk action form posts ids straight from a URL
 * -adjacent, visitor-controlled `FormData` — exactly the kind of input that has to be
 * validated somewhere `tests/gear-bulk.test.ts` can reach directly, not somewhere that
 * only runs as part of rendering a route.
 *
 * WHAT THIS MODULE DOES NOT DO. It does not run a query. `parseBulkAction` decides
 * WHICH ids and WHAT action; `src/lib/gear/mutations.ts` is what issues the actual
 * `.update()`/`.delete()` against `gear_items` for both the pages and their tests,
 * scoped by an explicit `.eq('user_id', …)` alongside RLS the same way every other
 * write in this product is (see that module's own comment for why both).
 */

import { isGearStatus, type GearStatus } from './fields';

// ---------------------------------------------------------------------------
// Intent
// ---------------------------------------------------------------------------

/** The three bulk actions the closet list offers, as the `intent` value a bulk-action
 *  form posts. One object rather than three loose exported constants, so `isBulkIntent`
 *  and `BulkAction`'s own literal types are both derived from the same source and
 *  cannot enumerate a different set from each other. */
export const BULK_INTENT = {
  setCategory: 'bulk-set-category',
  setStatus: 'bulk-set-status',
  delete: 'bulk-delete',
} as const;

export type BulkIntent = (typeof BULK_INTENT)[keyof typeof BULK_INTENT];

const BULK_INTENT_VALUES: readonly string[] = Object.values(BULK_INTENT);

/** `intent` arrives from a form field typed merely as `string`. Mirrors `isGearStatus`
 *  in `src/lib/gear/fields.ts`: a value that merely looks plausible fails this exactly
 *  as a bare typo would, rather than being coerced or silently accepted. */
export function isBulkIntent(value: unknown): value is BulkIntent {
  return typeof value === 'string' && BULK_INTENT_VALUES.includes(value);
}

// ---------------------------------------------------------------------------
// Form field names
// ---------------------------------------------------------------------------

/** The `<input name="…">` values a bulk-action form uses. `id` is repeated — one
 *  `<input type="checkbox" name="id" value="…">` per selected row — hence
 *  `form.getAll(BULK_FORM_FIELD.id)` rather than `form.get`. */
export const BULK_FORM_FIELD = {
  intent: 'intent',
  id: 'id',
  category: 'category',
  status: 'status',
  // The closet list's two-step bulk delete (mirroring the confirm-delete pattern in
  // src/pages/account/index.astro): the first `bulk-delete` submission carries no
  // `confirm` field and only reveals a confirmation naming the selection; the second,
  // re-submitted with the same ids and `confirm=1`, is the one that actually issues the
  // DELETE. That reveal-then-confirm step is the ONLY thing in front of an irreversible
  // write — `deleteGearItems` (src/lib/gear/mutations.ts) removes the rows outright, so
  // there is nothing downstream of this field to catch a selection the visitor did not
  // mean, and nothing afterwards to put back. There is no BULK_INTENT for "confirm" —
  // it is the same intent, gated by this one extra field, so the id-parsing rules above
  // apply identically to both submissions rather than needing a second, parallel
  // validation path.
  confirm: 'confirm',
} as const;

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

/** Case-insensitive: `gen_random_uuid()` always produces lowercase, but a hand-crafted
 *  or copy-pasted id could arrive in any case, and case is not a meaningful
 *  distinction for a UUID. Deliberately does not check the version/variant nibbles —
 *  the value still has to exist as a row this visitor owns for a query to touch
 *  anything, RLS included, so accepting a WELL-FORMED id that happens to name no row is
 *  no more dangerous than accepting one that does; the regexp's job is only to refuse
 *  the shapes that could otherwise reach a query as raw, attacker-controlled text. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The most ids one bulk action will act on. `supabase/migrations/20260813000000_gear_
 * closet.sql`'s "Deliberately no new indexes" section puts a per-user closet at "a few
 * hundred rows" in practice, so 500 covers selecting every row in an unusually large
 * closet with room to spare, while still bounding how large a single `.in('id', […])`
 * an adversarial request can force — without a cap, `?id=…` repeated thousands of times
 * is a request this module would otherwise pass straight through to a query.
 */
export const MAX_BULK_IDS = 500;

const EMPTY_SELECTION_MESSAGE = 'Select at least one item.';
const TOO_MANY_IDS_MESSAGE = `Select at most ${MAX_BULK_IDS} items at a time.`;
const INVALID_INTENT_MESSAGE = 'Choose a valid bulk action.';
const INVALID_STATUS_MESSAGE = 'Choose a status.';

/** Reads every `id` field, keeping only well-formed UUIDs, lower-cased and
 *  de-duplicated in first-seen order — mirroring `parseStringList` in
 *  `src/lib/gear/query.ts`. Anything that is not a UUID (a stray empty checkbox value,
 *  a crafted `id=1%20OR%201=1`) is silently dropped rather than surfaced as a per-id
 *  error: the selection is a checkbox list the visitor never typed into directly, so a
 *  malformed entry is a client bug or a crafted request, not something to ask them to
 *  fix. */
function parseIds(form: FormData): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const raw of form.getAll(BULK_FORM_FIELD.id)) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!UUID_PATTERN.test(trimmed)) continue;
    const normalised = trimmed.toLowerCase();
    if (seen.has(normalised)) continue;
    seen.add(normalised);
    ids.push(normalised);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// parseBulkAction
// ---------------------------------------------------------------------------

/** The validated action a bulk-action form asked for. A discriminated union on
 *  `intent`, so a caller's `switch` over `action.intent` gets the right payload type
 *  narrowed for free — `action.category` only exists to type-check when `action.intent
 *  === BULK_INTENT.setCategory`, and likewise for `status`. */
export type BulkAction =
  | {
      readonly intent: typeof BULK_INTENT.setCategory;
      readonly ids: readonly string[];
      readonly category: string | null;
    }
  | {
      readonly intent: typeof BULK_INTENT.setStatus;
      readonly ids: readonly string[];
      readonly status: GearStatus;
    }
  | { readonly intent: typeof BULK_INTENT.delete; readonly ids: readonly string[] };

export type BulkActionResult =
  | { readonly ok: true; readonly action: BulkAction }
  | { readonly ok: false; readonly errors: Readonly<Record<string, string>> };

/**
 * Validates a bulk-action submission: the `intent`, the selected ids, and whichever
 * extra field that intent needs. Never throws — total over any `FormData`, the same
 * promise `parseGearQuery` makes over `URLSearchParams`.
 *
 * IDS ARE VALIDATED BEFORE THEY EVER REACH A QUERY. Every id `parseIds` keeps has
 * already passed `UUID_PATTERN`, so nothing downstream of a successful `BulkActionResult`
 * ever hands raw form text to `.in('id', …)`.
 *
 * An empty selection and an over-cap selection are both reported under the `ids` key,
 * and — unlike a malformed individual id — ARE surfaced as errors rather than silently
 * dropped: submitting a bulk action with nothing selected, or with more selected than
 * this module will act on, is a real thing to tell the visitor about, not a stray
 * artefact of how checkboxes serialise.
 */
export function parseBulkAction(form: FormData): BulkActionResult {
  const intentRaw = form.get(BULK_FORM_FIELD.intent);
  const intent = typeof intentRaw === 'string' ? intentRaw.trim() : '';
  if (!isBulkIntent(intent)) {
    return { ok: false, errors: { intent: INVALID_INTENT_MESSAGE } };
  }

  const ids = parseIds(form);
  const errors: Record<string, string> = {};
  if (ids.length === 0) {
    errors.ids = EMPTY_SELECTION_MESSAGE;
  } else if (ids.length > MAX_BULK_IDS) {
    errors.ids = TOO_MANY_IDS_MESSAGE;
  }

  if (intent === BULK_INTENT.setCategory) {
    const raw = form.get(BULK_FORM_FIELD.category);
    // Same rule as parseOptionalText in form.ts: '' becomes null, mirroring
    // gear_items.category being an unconstrained nullable column, and letting this
    // action also mean "clear the category from every selected item".
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    if (Object.keys(errors).length > 0) return { ok: false, errors };
    return { ok: true, action: { intent, ids, category: trimmed === '' ? null : trimmed } };
  }

  if (intent === BULK_INTENT.setStatus) {
    const raw = form.get(BULK_FORM_FIELD.status);
    const statusRaw = typeof raw === 'string' ? raw.trim() : '';
    // pairs with: status text not null check (status in ('owned', 'wishlist', 'retired'))
    if (!isGearStatus(statusRaw)) {
      return { ok: false, errors: { ...errors, status: INVALID_STATUS_MESSAGE } };
    }
    if (Object.keys(errors).length > 0) return { ok: false, errors };
    return { ok: true, action: { intent, ids, status: statusRaw } };
  }

  // delete: ids only, nothing further to validate here. Whether the visitor has
  // confirmed is `BULK_FORM_FIELD.confirm`'s business, read by the page on the way to
  // deciding whether to re-render the confirmation or issue the write — this function
  // answers only WHICH rows and WHAT action, exactly as it does for the other two.
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, action: { intent, ids } };
}
