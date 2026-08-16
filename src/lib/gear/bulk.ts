/**
 * Bulk actions for the gear closet list (PK-4) — set category, set status, and delete,
 * which really deletes: the row leaves `gear_items` and does not come back. There is no
 * trash to fish it out of and no undo to press, so the two-step confirmation
 * `confirmsGearDeletion` decides is the whole of what stands between a selection and its
 * removal; see that function's own comment.
 *
 * That gate is the one thing in here that is NOT only about the closet LIST.
 * `src/pages/gear/[id].astro` deletes a single item through the same reveal-then-confirm
 * step, so it imports `BULK_FORM_FIELD.confirm`, `GEAR_DELETE_CONFIRMATION_VALUE` and
 * `confirmsGearDeletion` from here rather than spelling any of the three out again —
 * PK-60 review, F1: it did spell the field and the value out again, privately, and two
 * copies of the only guard in front of an irreversible write are two copies nothing
 * keeps in step.
 *
 * WHY THIS LIVES IN src/lib/ RATHER THAN IN THE PAGE. Same reasoning as
 * `src/lib/gear/form.ts` and `src/lib/gear/query.ts`: `vitest.config.ts:64` excludes
 * `src/pages/` from the test run, and a bulk action form posts ids straight from a URL
 * -adjacent, visitor-controlled `FormData` — exactly the kind of input that has to be
 * validated somewhere `tests/gear-bulk.test.ts` can reach directly, not somewhere that
 * only runs as part of rendering a route. The delete gate is the sharpest case of that
 * rule and was, until PK-60's review, the one place it was not being followed: an inline
 * `form.get('confirm') === '1'` in each of the two gear pages, in the one directory the
 * test runner cannot reach. `src/lib/account-deletion.ts` had already been through
 * exactly this (see its header, and `tests/account-deletion-gate.test.ts`); the gate
 * below is that same move made for gear.
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
  // PK-65. Export is a bulk action rather than a page of its own because it acts on a
  // SELECTION, and the closet list is the only place a selection exists — the checkboxes,
  // the select-all, the id validation and the cap are all already here, and a separate
  // export page would have to grow its own copy of every one of them. Import is the
  // opposite case and is deliberately NOT here: it takes a file, not a selection, so it
  // has its own page (src/pages/gear/import.astro) modelled on new.astro instead.
  //
  // IT IS THE ONE INTENT THAT WRITES NOTHING. Everything in this module is about deciding
  // which rows an action may touch, and that question is identical for a read; what
  // differs is on the page, where this is the only branch that answers with a Response
  // rather than a redirect or a re-render. See src/pages/gear/index.astro's own comment
  // at that branch for why it does not — and must not — follow the 303 rule the other
  // three do.
  export: 'bulk-export',
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
  // The field carrying the second, confirming step of a delete — read through
  // `confirmsGearDeletion` below, which is where what counts as confirmation is decided
  // and why. There is no BULK_INTENT for "confirm": it is the same intent, gated by this
  // one extra field, so the id-parsing rules above apply identically to both
  // submissions rather than needing a second, parallel validation path.
  confirm: 'confirm',
} as const;

// ---------------------------------------------------------------------------
// The delete gate
// ---------------------------------------------------------------------------

/**
 * The value `BULK_FORM_FIELD.confirm` has to carry for a delete to go ahead.
 *
 * Exported so that the hidden input which WRITES it and `confirmsGearDeletion` which
 * READS it are the same string rather than two literals that agree today. Both gear
 * pages render `value={GEAR_DELETE_CONFIRMATION_VALUE}`; with a bare `value="1"` in the
 * markup instead, changing what the reader accepts silently turns every rendered
 * confirmation button into a no-op — a delete that reports success and does nothing, or
 * (changed the other way) a first submission that deletes without confirming.
 */
export const GEAR_DELETE_CONFIRMATION_VALUE = '1';

/**
 * Whether a submission is the confirming half of a two-step gear delete: the first
 * submission carries no `confirm` field and only reveals a confirmation naming what is
 * about to go, and the second — re-posted with the same ids plus this field — is the one
 * that reaches `deleteGearItems` (`src/lib/gear/mutations.ts`) and removes the rows.
 * Both gear pages call this: the closet list for a bulk delete
 * (`src/pages/gear/index.astro`) and the item page for a single item
 * (`src/pages/gear/[id].astro`).
 *
 * WHY THIS IS A FUNCTION IN src/lib/ AND NOT `form.get('confirm') === '1'` IN THE PAGE,
 * where it was until PK-60's review. It is the whole safety net: `deleteGearItems`
 * removes the rows outright, so nothing downstream catches a selection the visitor did
 * not mean and nothing afterwards puts it back — and `vitest.config.ts:64` excludes
 * `src/pages/`, so as page frontmatter it was the only guard in front of the gear
 * closet's one irreversible write, with no test able to execute it. Exactly the
 * argument `src/lib/account-deletion.ts` records for `confirmsAccountDeletion`, which
 * moved out of `.astro` frontmatter for the same reason and is tested in
 * `tests/account-deletion-gate.test.ts`.
 *
 * THE PARAMETER IS WHAT `form.get()` REALLY RETURNS, not `string | null`. A multipart
 * POST can send a `File` under any name it likes, including this one, so the honest type
 * is `FormDataEntryValue | null` — and a strict `===` against a string constant answers
 * `false` for a `File` without a `typeof` dance and, more to the point, without throwing.
 * The natural-looking `value?.toString().trim() === '1'` spelling would turn a crafted
 * multipart body into a 500 rather than a refusal.
 *
 * NOTHING IS TRIMMED, LOWER-CASED OR COERCED, and that is the OPPOSITE decision from
 * `confirmsAccountDeletion`, deliberately. That value is typed by a person into a box,
 * so a trailing space from a paste or a capital from a phone keyboard is a keyboard
 * artefact and refusing it would only teach someone that the refusals mean nothing.
 * Nobody types this one: it is written by a hidden input this application renders
 * itself, from the constant above. `' 1 '`, `'true'`, `'on'` and `'0'` are therefore not
 * a person being imprecise — they are a submission assembled somewhere other than the
 * confirmation we rendered, and there is no visitor to frustrate by refusing them,
 * because the real confirmation is one click away. The bug this shape rules out is the
 * obvious one: a truthiness check (`if (form.get(BULK_FORM_FIELD.confirm))`) confirms on
 * `'0'`, on `'false'`, and on a `File`.
 */
export function confirmsGearDeletion(value: FormDataEntryValue | null): boolean {
  return value === GEAR_DELETE_CONFIRMATION_VALUE;
}

/**
 * What both gear pages say when `deleteGearItems` comes back with an error. It lives
 * beside the gate because the two are halves of one decision the pages make about a
 * delete — what lets it through, and what to say when it does not come back — and
 * because, like the gate, a message about a permanent delete is not something the two
 * pages should each be wording separately.
 *
 * IT DOES NOT SAY "UPDATING" and it does not say "please try again", which is what the
 * generic write error each page keeps for its other write paths says. Neither is true
 * here. "Updating" describes the wrong operation. And "try again" quietly asserts the
 * delete did not happen — but a DELETE that commits and then loses its response (a
 * worker timeout, a reset connection, a 502 between Postgres and here) arrives in this
 * same branch with the rows already gone. This wording claims neither outcome and sends
 * the visitor to the only thing that can actually answer the question: the list, which
 * after PK-60 is the single source of truth for what is still in the closet — there is
 * no trash to check, and no log of what was removed.
 */
export const GEAR_DELETE_FAILED_MESSAGE =
  'We could not confirm whether that delete went through. Check your gear closet to see what is still there.';

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
  | { readonly intent: typeof BULK_INTENT.delete; readonly ids: readonly string[] }
  | { readonly intent: typeof BULK_INTENT.export; readonly ids: readonly string[] };

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

  // delete and export: ids only, nothing further to validate here. Whether the visitor
  // has confirmed a delete is `confirmsGearDeletion`'s business, called by the page on
  // the way to deciding whether to re-render the confirmation or issue the write — this
  // function answers only WHICH rows and WHAT action, exactly as it does for the others.
  //
  // Export shares this branch rather than getting one of its own because it needs exactly
  // what delete needs and nothing else: a validated, de-duplicated, capped list of ids.
  // The two could hardly be less alike in consequence — one removes rows for good, one
  // reads them — and that difference is entirely on the page. `TOO_MANY_IDS_MESSAGE`
  // therefore also bounds an export, which is the intended reading of it: 500 is the most
  // rows any one bulk submission acts on, whatever it then does with them.
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, action: { intent, ids } };
}
