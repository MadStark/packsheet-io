/**
 * Bulk actions for the gear closet list (PK-4) — set category, set status, soft
 * delete — plus the trash page's restore and permanent-delete, and the undo token that
 * connects a bulk soft delete back to the "Undo" link on the redirect it produces.
 *
 * WHY THIS LIVES IN src/lib/ RATHER THAN IN THE PAGE. Same reasoning as
 * `src/lib/gear/form.ts` and `src/lib/gear/query.ts`: `vitest.config.ts:64` excludes
 * `src/pages/` from the test run, and a bulk action form posts ids straight from a URL
 * -adjacent, visitor-controlled `FormData` — exactly the kind of input that has to be
 * validated somewhere `tests/gear-bulk.test.ts` can reach directly, not somewhere that
 * only runs as part of rendering a route.
 *
 * WHAT THIS MODULE DOES NOT DO. It does not run a query. `parseBulkAction` decides
 * WHICH ids and WHAT action; the calling page is responsible for issuing the actual
 * `.update()`/`.delete()` against `gear_items`, scoped by RLS to that visitor's own
 * rows the same way every other write in this product is. See "THE UNDO TOKEN" below
 * for the one piece of query shape this module does dictate, because getting it wrong
 * silently breaks Undo rather than failing loudly.
 */

import { isGearStatus, type GearStatus } from './fields';

// ---------------------------------------------------------------------------
// Intent
// ---------------------------------------------------------------------------

/** The five bulk actions the closet and trash pages offer, as the `intent` value a
 *  bulk-action form posts. One object rather than five loose exported constants, so
 *  `isBulkIntent` and `BulkAction`'s own literal types are both derived from the same
 *  source and cannot enumerate a different set from each other. */
export const BULK_INTENT = {
  setCategory: 'bulk-set-category',
  setStatus: 'bulk-set-status',
  delete: 'bulk-delete',
  restore: 'bulk-restore',
  deletePermanently: 'bulk-delete-permanently',
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
  // re-submitted with the same ids and `confirm=1`, is the one that actually writes
  // `deleted_at`. There is no BULK_INTENT for "confirm" — it is the same intent,
  // gated by this one extra field, so the id-parsing rules above apply identically to
  // both submissions rather than needing a second, parallel validation path.
  confirm: 'confirm',
} as const;

/** The query-string parameter the closet list is redirected to after a bulk soft
 *  delete, carrying the stamp `parseUndoToken` validates back on the "Undo" link. */
export const UNDO_PARAM = 'undo';

/** The `intent` value the undo banner's own form posts. Distinct from `BULK_INTENT`
 *  (and not added to it) because undo does not select ids from the row checkboxes the
 *  way every `BulkAction` does — it names a token instead, so `parseBulkAction` is not
 *  the right validator for it and a caller branches on this constant before ever
 *  reaching that function. */
export const UNDO_INTENT = 'undo';

/** The query-string parameter carrying how many items a bulk soft delete moved to the
 *  trash, alongside `UNDO_PARAM`, so the banner can say "12 items moved to the trash"
 *  without a second database round trip just to count them back. Read through
 *  `parseUndoCount` before being rendered — see that function for why a value the
 *  visitor's own address bar can edit is not trusted merely for being a number. */
export const UNDO_COUNT_PARAM = 'count';

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
  | { readonly intent: typeof BULK_INTENT.restore; readonly ids: readonly string[] }
  | { readonly intent: typeof BULK_INTENT.deletePermanently; readonly ids: readonly string[] };

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

  // delete, restore, deletePermanently: ids only, nothing further to validate.
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, action: { intent, ids } };
}

// ---------------------------------------------------------------------------
// The undo token
// ---------------------------------------------------------------------------

/**
 * THE UNDO TOKEN — how a bulk soft delete and the "Undo" link that follows it agree on
 * exactly which rows to restore, without a table of its own.
 *
 * THE FLOW, in order:
 *
 *   1. The page calls `makeUndoToken()` ONCE for the whole batch and writes that exact
 *      string to `deleted_at` for every id in the selection — one UPDATE statement, one
 *      value, every affected row.
 *   2. The page redirects to the closet list with that same string as the `undo` query
 *      parameter (`UNDO_PARAM`).
 *   3. "Undo" posts that value back. The page calls `parseUndoToken` on it and, if it
 *      validates, issues `update gear_items set deleted_at = null where deleted_at =
 *      $token` — scoped to the signed-in visitor by RLS, exactly like every other
 *      write on this table.
 *
 * WHY MATCHING ON THE TIMESTAMP ITSELF IS SOUND, not merely convenient:
 *
 *   - One UPDATE statement stamps every row in the batch with the IDENTICAL value —
 *     `now()` is not re-evaluated per row, and `makeUndoToken` is called once, before
 *     the update, not once per id — so `deleted_at = $token` is exactly "every row this
 *     batch touched", neither more nor fewer.
 *   - `deleted_at = $token` alone says nothing about WHOSE rows; RLS is what makes it
 *     safe. `gear_items_update_own` (core_schema.sql) restricts every UPDATE to
 *     `user_id = auth.uid()`, so two different users soft-deleting a batch in the same
 *     millisecond and producing the same token cannot restore each other's rows — the
 *     token is a millisecond, not a secret, and does not need to be one.
 *   - The one theoretical collision — the SAME user issuing two distinct bulk deletes
 *     within the same millisecond, whose Undo links would then restore each other's
 *     batch too — is not reachable by anything this product's UI can produce: it needs
 *     two separate form submissions from one browser tab landing in the same
 *     millisecond, which is not a race a person or this codebase's own retry logic can
 *     produce.
 *
 * THE CALLER MUST GUARD THE SOFT-DELETE UPDATE WITH `.is('deleted_at', null)`. Without
 * it, re-submitting a delete action (a double click, a retried request) would re-stamp
 * rows that are already in the trash from an EARLIER batch with the NEW token — which
 * does not change what is in the trash, but silently WIDENS what the new batch's Undo
 * restores: a later Undo would then resurrect items an earlier, unrelated delete had
 * already put away. `applyGearQuery` in `src/lib/gear/query.ts` guards its own list
 * query with the same `.is('deleted_at', null)` for the same class of reason — a row
 * already in one state must not be silently re-claimed by a second write meant for a
 * different one.
 */

/** Stamps one ISO-8601 UTC instant for a bulk soft-delete batch. Always the exact
 *  shape `parseUndoToken` accepts back — see that function for why the two are kept
 *  to a byte-for-byte format rather than "any date this batch happened to run at". */
export function makeUndoToken(): string {
  return new Date().toISOString();
}

/** `new Date().toISOString()`'s exact, invariant output shape:
 *  `YYYY-MM-DDTHH:mm:ss.sssZ`, milliseconds always three digits, always UTC. Matching
 *  this shape is necessary but not sufficient — see `parseUndoToken`'s round-trip
 *  check for the near-misses this pattern alone lets through. */
const ISO_UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Validates a raw `undo` query parameter before it can reach a query. `raw` arrives
 * from the URL and is therefore untrusted in exactly the way `parseGearQuery`'s inputs
 * are: a bookmark, a shared link, or a deliberately crafted request.
 *
 * TWO LAYERS, NOT ONE. The regexp above rejects anything that does not even have the
 * right shape (a plain date with no time, an offset other than `Z`, a truncated
 * fraction). The round-trip below catches the PLAUSIBLE-LOOKING near-misses the
 * regexp cannot: `Date`'s own parser silently ROLLS OVER an out-of-range component
 * rather than refusing it — `new Date('2024-02-30T00:00:00.000Z')` parses to March 1st
 * without error, and `new Date('2024-01-01T24:00:00.000Z')` parses to January 2nd.
 * Re-serialising the parsed date and comparing it BYTE-FOR-BYTE against the original
 * string is what catches both: a rolled-over date always re-serialises to a DIFFERENT
 * string than the one that named the impossible instant, so `raw` is refused rather
 * than silently reinterpreted as some other, nearby timestamp — which matters
 * precisely because this value is about to be matched for an EXACT equality against
 * `deleted_at`, where "close" restores nothing at all.
 */
export function parseUndoToken(raw: string | null): string | null {
  if (raw === null) return null;
  if (!ISO_UTC_TIMESTAMP_PATTERN.test(raw)) return null;

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  if (parsed.toISOString() !== raw) return null;

  return raw;
}

/**
 * Validates the `count` query parameter (`UNDO_COUNT_PARAM`) the undo banner reads
 * back — total over any string, the same promise every other parser in this module
 * family makes over untrusted input from a URL a visitor's own address bar can edit.
 *
 * This value is NEVER used to decide which rows to touch — only `parseUndoToken`'s
 * result is, in the `deleted_at = $token` update — so a forged or nonsensical count
 * cannot widen what Undo restores. Its only job is display: "N items moved to the
 * trash" on a banner. Validating it anyway, rather than rendering whatever string
 * arrived, keeps a hand-edited `?count=-1` or `?count=Infinity` from reaching that
 * sentence as literal text; `null` here means the page falls back to a generic
 * message that says nothing wrong.
 */
export function parseUndoCount(raw: string | null): number | null {
  if (raw === null) return null;
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) return null;
  return value;
}

// ---------------------------------------------------------------------------
// The permanent-delete confirmation gate
// ---------------------------------------------------------------------------

/**
 * The gate in front of `BULK_INTENT.deletePermanently` on `src/pages/gear/trash.astro`
 * — the one truly irreversible action anywhere in the gear closet. Everything else this
 * module validates (`parseBulkAction`, the undo token) is about WHICH rows a request
 * may touch; this is about whether the visitor meant to touch them at all, mirroring
 * `confirmsAccountDeletion` in `src/lib/account-deletion.ts` — see that module's own
 * "WHAT THE GATE IS FOR" section, which applies unchanged here: this is not a password,
 * it is deliberateness.
 *
 * WHY A FIXED WORD RATHER THAN THE ACCOUNT PAGE'S OWN EMAIL-ADDRESS PATTERN. That
 * pattern works because there is exactly one natural string to type back — the visitor's
 * own address, already on screen. A permanent-delete selection here names no single
 * thing: it can be one item or an arbitrary batch of them, with no shared name, and
 * asking for "the name of the first selected item" would make the gate about spelling a
 * near-arbitrary string correctly rather than about meaning it. Typing the fixed word
 * `DELETE` — the same convention GitHub's own repository-deletion dialog uses for the
 * batch case — asks for exactly one deliberate act, independent of what or how much is
 * selected, while the page itself still names the count and the pack-freezing
 * consequence next to the input (see `trash.astro`).
 */
export const PERMANENT_DELETE_CONFIRMATION_FIELD = 'confirmation';

/** The exact word `confirmsPermanentDeletion` requires — see that function for the case
 *  and whitespace tolerance applied around it. */
export const PERMANENT_DELETE_CONFIRMATION_WORD = 'DELETE';

/** Shown when the typed word does not match. Says what to do, not how close the typed
 *  text came — same reasoning as `CONFIRMATION_MISMATCH_MESSAGE` in
 *  `src/lib/account-deletion.ts`. */
export const PERMANENT_DELETE_CONFIRMATION_MISMATCH_MESSAGE =
  'Type DELETE to confirm. This cannot be undone.';

/**
 * Whether a typed confirmation authorises a permanent delete. Case and surrounding
 * whitespace are ignored — a trailing space from a paste, or autocapitalisation turning
 * `delete` into `Delete`, is a keyboard artefact, not evidence the visitor did not mean
 * it, mirroring `confirmsAccountDeletion`'s identical tolerance for the identical
 * reason. An empty or whitespace-only entry never confirms: that is the shape of a form
 * submitted without the field being filled in at all (a double submit, a crafted POST,
 * a browser restoring a page), and it is the single most likely accidental input there
 * is.
 */
export function confirmsPermanentDeletion(typed: string | null | undefined): boolean {
  return (typed ?? '').trim().toUpperCase() === PERMANENT_DELETE_CONFIRMATION_WORD;
}
