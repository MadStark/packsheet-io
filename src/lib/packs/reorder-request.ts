/**
 * The wire half of a reorder (PK-37): what a request to `PACK_REORDER_PATH` is allowed to
 * say, and how the rows the server has just read for itself become the `Run`s
 * `src/lib/packs/reorder.ts` plans against.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A MODULE AND NOT THE ENDPOINT'S OWN FRONTMATTER
 * ---------------------------------------------------------------------------
 *
 * `vitest.config.ts:64` excludes `src/pages/**`, so every decision written inside
 * `src/pages/packs/reorder.ts` is a decision no test in this repository can execute — the
 * same argument `src/lib/packs/form.ts`, `query.ts` and `mutations.ts` each make for their
 * own layer, and it applies with more force here than to most of them: this is the one
 * place in the product where a request body from a browser is turned into a database
 * write with no form parser in between. `tests/packs-reorder-request.test.ts` calls every
 * rule below directly; the endpoint that uses them is left with authentication, two
 * awaits and a `Response`.
 *
 * ---------------------------------------------------------------------------
 * THE WIRE CARRIES AN INTENT, NEVER A POSITION
 * ---------------------------------------------------------------------------
 *
 * `src/lib/packs/reorder.ts`'s header states the rule this module implements — "BOTH SIDES
 * CALL THIS, ONLY ONE SIDE IS BELIEVED" — and `src/lib/packs/routes.ts` repeats it for the
 * URL. A request may say WHICH row moved, WHICH run it landed in, and AT WHICH INDEX. It
 * may not say what any position becomes. `parseReorderIntent` below therefore has no field
 * for a plan, a run, or a position, and `planReorderIntent` recomputes the whole move from
 * rows the caller read under its own session moments earlier.
 *
 * That is not merely a validation preference. A payload carrying positions would let a
 * hand-written request express "set every position in this pack to 0" — a statement about
 * rows RLS is perfectly willing to let this visitor write, and therefore one no policy
 * would refuse. The intent shape cannot express it: the worst a hostile body can ask for
 * is a real move of one row this visitor owns to a real index, which is a thing they could
 * have done with the pointer anyway.
 *
 * ---------------------------------------------------------------------------
 * EVERY FAILURE IS A SENTENCE, NEVER AN EXCEPTION AND NEVER A POSTGRES STRING
 * ---------------------------------------------------------------------------
 *
 * `parseReorderIntent` and `planReorderIntent` are total: no body and no tree makes either
 * of them throw. That matters because the functions they wrap are deliberately NOT total —
 * `planItemMove`/`planCategoryMove` throw on an unknown row id, a duplicated id and a
 * non-finite index, which is the right behaviour for a pure function whose caller is the
 * island as well as the server, and the wrong behaviour for an HTTP handler, where it is a
 * 500 on a request that deserves a 4xx. `planReorderIntent` catches exactly those and
 * returns the message instead, so the endpoint has no `try` in it and no way to leak a
 * stack trace or a raw PostgREST string to a client.
 *
 * ---------------------------------------------------------------------------
 * NOT importing src/lib/auth/
 * ---------------------------------------------------------------------------
 *
 * Nothing here opens a connection or authenticates anybody: it is handed a decoded body
 * and a tree of rows, and returns a value. The rule and its two reasons are in
 * `src/lib/packs/routes.ts`'s header — Invariant A in `tests/anonymous-read-path.test.ts`
 * is an EDGE rule, and this module's own dependency (`./reorder`) is bundled into the
 * browser with PK-37's island, `src/components/PackContents.vue`.
 */

import {
  planCategoryMove,
  planItemMove,
  type Positioned,
  type ReorderPlan,
  type Run,
} from './reorder';

// ---------------------------------------------------------------------------
// The intent
// ---------------------------------------------------------------------------

/**
 * The two things that can be dragged. One object rather than two loose constants, so the
 * guard below and the union's own literal types are derived from the same source and
 * cannot enumerate different sets — the shape `BULK_INTENT` in `src/lib/gear/bulk.ts`
 * uses, for the same reason.
 */
export const REORDER_TARGET = {
  item: 'item',
  category: 'category',
} as const;

export type ReorderTarget = (typeof REORDER_TARGET)[keyof typeof REORDER_TARGET];

/** The field names a request body uses. Named here so PK-37's island (`src/components/PackContents.vue`)
 *  and the parser that reads it cannot drift — the same job `PACK_FORM_FIELD` does for a
 *  `FormData`, for a body that happens to be JSON rather than a form. */
export const REORDER_FIELD = {
  target: 'target',
  packId: 'packId',
  itemId: 'itemId',
  categoryId: 'categoryId',
  toCategoryId: 'toCategoryId',
  toIndex: 'toIndex',
} as const;

/**
 * A validated "this item moved" request.
 *
 * `toCategoryId` IS ALWAYS PRESENT, INCLUDING FOR A MOVE THAT STAYED PUT. A same-category
 * drag sends the category the item is already in. That mirrors `move_pack_item`'s own
 * required `p_to_category_id` argument and closes the trap
 * `src/lib/packs/reorder.ts` describes: `reparent` is set on every cross-category move
 * even when both runs' position lists come back empty, so a protocol that let the
 * destination be omitted would have a spelling for "moved, but I did not say where".
 */
export interface ItemMoveIntent {
  readonly target: typeof REORDER_TARGET.item;
  readonly packId: string;
  readonly itemId: string;
  readonly toCategoryId: string;
  readonly toIndex: number;
}

/** A validated "this category moved" request. There is no destination: a category belongs
 *  to its pack and cannot move to another one, which is why `planCategoryMove` returns a
 *  plan whose `reparent` is always null. */
export interface CategoryMoveIntent {
  readonly target: typeof REORDER_TARGET.category;
  readonly packId: string;
  readonly categoryId: string;
  readonly toIndex: number;
}

export type ReorderIntent = ItemMoveIntent | CategoryMoveIntent;

/** The result shape both functions here return: a value, or a sentence a client may be
 *  shown. Modelled on `FormResult` in `src/lib/packs/form.ts` — same three-word discriminant,
 *  no exceptions, no error object with a code nobody maps. */
export type ReorderResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export const REORDER_BODY_MESSAGE = 'That reorder request was not in a shape we understand.';
export const REORDER_TARGET_MESSAGE = 'A reorder must move either an item or a category.';
export const REORDER_ID_MESSAGE = 'That reorder request named something that is not an id.';
export const REORDER_INDEX_MESSAGE = 'A reorder must land on a whole position of zero or more.';
export const REORDER_ITEM_MISSING_MESSAGE = 'That item is no longer in this pack.';
export const REORDER_CATEGORY_MISSING_MESSAGE = 'That category is no longer in this pack.';
/** What `planReorderIntent` reports when `reorder.ts` refuses the rows it was given —
 *  a duplicated id across the two runs, or a row that vanished between the read and the
 *  plan. Deliberately one message for all of them: each is either a race the visitor can
 *  resolve by reloading or a defect they cannot act on, and neither is improved by naming
 *  a row id at them. The distinction stays legible to a maintainer because the thrown
 *  error's own text says which, and this function is the only thing that swallows it. */
export const REORDER_UNPLANNABLE_MESSAGE =
  'That move no longer fits this pack. Reload the pack and try again.';

// ---------------------------------------------------------------------------
// parseReorderIntent
// ---------------------------------------------------------------------------

/** Case-insensitive, and deliberately not checking the version/variant nibbles — the same
 *  rule and the same reasoning as `parseIds` in `src/lib/gear/bulk.ts`: an id still has to
 *  name a row this visitor owns before anything is touched, so a well-formed id that
 *  matches nothing is no more dangerous than one that does. What this refuses is raw,
 *  caller-controlled text reaching a query as an id at all. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Reads one field as a UUID, lower-cased so two spellings of one id cannot be two ids —
 *  `compareByPosition` in `src/lib/packs/reorder.ts` compares lower-cased strings for the
 *  matching reason, and its comment explains what an upper-cased uuid does to the ordering
 *  the two sides agree on. */
function readId(body: Record<string, unknown>, key: string): string | null {
  const raw = body[key];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return UUID_PATTERN.test(trimmed) ? trimmed.toLowerCase() : null;
}

/**
 * Reads `toIndex`, refusing everything a correct client cannot produce.
 *
 * AN OUT-OF-RANGE INDEX IS ACCEPTED HERE AND CLAMPED LATER, which is the one case that
 * looks like a validation gap and is not. `src/lib/packs/reorder.ts` argues it at length:
 * "index 9 of a 4-row category" is what an ordinary race produces — a sibling deleted in
 * another tab, an item moved while the pointer was down — and it has an honest reading, as
 * far towards the end as the run goes. Refusing it here would turn a benign race into an
 * error on a drag the visitor would swear worked.
 *
 * EVERYTHING ELSE IS REFUSED RATHER THAN COERCED. A string, a fraction, a negative, `NaN`
 * and the infinities are none of them a stale index; they are a client that computed
 * something other than an index, and `clampTargetIndex` would silently turn three of the
 * five into "move it to the very top" — a real, wrong write. `Number.isSafeInteger` covers
 * the non-finite cases and the fractional ones in one test, and the `>= 0` is what stops a
 * negative being clamped into a position nobody dropped on.
 */
function readIndex(body: Record<string, unknown>): number | null {
  const raw = body[REORDER_FIELD.toIndex];
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) return null;
  return raw;
}

/**
 * Validates a decoded request body into a `ReorderIntent`. Total: no value — including
 * `undefined`, an array, a string, or an object with every field of the wrong type —
 * makes this throw.
 *
 * THE CALLER DECODES THE JSON, not this function, so that a body which is not JSON at all
 * fails in the endpoint's own `await request.json()` rather than by this module having to
 * take a string and guess at an encoding. `unknown` is the honest parameter type for what
 * comes back from that call.
 *
 * FIELDS THIS DOES NOT READ ARE FIELDS THAT DO NOT EXIST. A body carrying `runs`,
 * `position`, `positions` or a whole `ReorderPlan` is not rejected — those names are
 * simply never looked at, exactly as `src/lib/packs/form.ts` never looks at a submitted
 * `worn=on`. There is nothing to reject, because there is no code path that could read
 * them; see this module's header on why the intent shape is the protection rather than a
 * check on top of it.
 */
export function parseReorderIntent(body: unknown): ReorderResult<ReorderIntent> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, message: REORDER_BODY_MESSAGE };
  }

  const fields = body as Record<string, unknown>;

  const packId = readId(fields, REORDER_FIELD.packId);
  if (packId === null) return { ok: false, message: REORDER_ID_MESSAGE };

  const toIndex = readIndex(fields);
  if (toIndex === null) return { ok: false, message: REORDER_INDEX_MESSAGE };

  const target = fields[REORDER_FIELD.target];

  if (target === REORDER_TARGET.item) {
    const itemId = readId(fields, REORDER_FIELD.itemId);
    const toCategoryId = readId(fields, REORDER_FIELD.toCategoryId);
    if (itemId === null || toCategoryId === null) {
      return { ok: false, message: REORDER_ID_MESSAGE };
    }
    return {
      ok: true,
      value: { target: REORDER_TARGET.item, packId, itemId, toCategoryId, toIndex },
    };
  }

  if (target === REORDER_TARGET.category) {
    const categoryId = readId(fields, REORDER_FIELD.categoryId);
    if (categoryId === null) return { ok: false, message: REORDER_ID_MESSAGE };
    return { ok: true, value: { target: REORDER_TARGET.category, packId, categoryId, toIndex } };
  }

  return { ok: false, message: REORDER_TARGET_MESSAGE };
}

// ---------------------------------------------------------------------------
// planReorderIntent
// ---------------------------------------------------------------------------

/**
 * The two columns this module needs from a category row, and the two it needs from an item
 * row — structural types over the tree `loadPackForEdit` returns rather than an import of
 * its row type.
 *
 * STRUCTURAL, DELIBERATELY. `PackTreeRow` is derived from `PACK_TREE_SELECT`, so typing
 * these parameters as that row would mean this module could only ever be handed a pack
 * fetched with that exact select — and would drag a `PacksheetClient`-shaped type into a
 * file whose whole value is being pure. Everything here needs is `id` and `position` at
 * two levels, which is precisely what `Positioned` already says.
 */
export interface ReorderCategoryRows extends Positioned {
  readonly pack_items: readonly Positioned[];
}

export interface ReorderPackRows {
  readonly pack_categories: readonly ReorderCategoryRows[];
}

/**
 * Turns a validated intent plus the pack's CURRENT rows into the plan to apply.
 *
 * THE ROWS MUST BE THE SERVER'S OWN READ. Nothing here can tell a tree the endpoint just
 * fetched under the caller's session from one a request body supplied, so nothing here
 * defends against the second — the endpoint does, by never accepting one. This function's
 * contract is only that, given rows, the plan is computed from THOSE rows and from the
 * intent's index, and never from anything else the caller might have believed.
 *
 * A CATEGORY THE PACK DOES NOT HAVE, OR AN ITEM IT DOES NOT HOLD, IS A MESSAGE RATHER THAN
 * A THROW — and it is checked here rather than left to `indexOfRow`'s exception because
 * the two cases are ordinary: the pack was edited in another tab, or the drag finished
 * against a page rendered before a delete. The RPC would refuse them a second time
 * (`item % is not in pack %`), and that refusal is the backstop rather than the gate.
 *
 * THE SOURCE RUN IS FOUND, NOT SUPPLIED. A request says where an item is GOING; where it
 * is coming FROM is a fact about the database, so it is read out of the tree. Trusting a
 * client-supplied `fromCategoryId` would let a request nominate the wrong siblings and get
 * a plan renumbered against a run the item was never in — `planItemMove` would compute it
 * perfectly and the answer would still be wrong.
 */
export function planReorderIntent(
  pack: ReorderPackRows,
  intent: ReorderIntent,
): ReorderResult<ReorderPlan> {
  try {
    if (intent.target === REORDER_TARGET.category) {
      if (!pack.pack_categories.some((category) => category.id === intent.categoryId)) {
        return { ok: false, message: REORDER_CATEGORY_MISSING_MESSAGE };
      }
      const run: Run = { parentId: intent.packId, rows: pack.pack_categories };
      return { ok: true, value: planCategoryMove(run, intent.categoryId, intent.toIndex) };
    }

    const from = pack.pack_categories.find((category) =>
      category.pack_items.some((item) => item.id === intent.itemId),
    );
    if (from === undefined) return { ok: false, message: REORDER_ITEM_MISSING_MESSAGE };

    const to = pack.pack_categories.find((category) => category.id === intent.toCategoryId);
    if (to === undefined) return { ok: false, message: REORDER_CATEGORY_MISSING_MESSAGE };

    return {
      ok: true,
      value: planItemMove(
        { parentId: from.id, rows: from.pack_items },
        { parentId: to.id, rows: to.pack_items },
        intent.itemId,
        intent.toIndex,
      ),
    };
  } catch {
    // See REORDER_UNPLANNABLE_MESSAGE. The three throwing cases in `src/lib/packs/reorder.ts`
    // are a duplicated id, an unknown id and a non-finite index; the first is a defect in
    // the rows, the second is a race the checks above did not catch (a run that changed
    // between the two `find`s and the plan), and the third cannot arrive through
    // `readIndex`. None of them is worth a 500, and none of their messages — which name row
    // ids and internal functions — is worth showing to a client.
    return { ok: false, message: REORDER_UNPLANNABLE_MESSAGE };
  }
}

/**
 * Whether a plan asks for any write at all.
 *
 * `reparent` IS CHECKED FIRST AND IS NOT REDUNDANT WITH `runs`, which is the whole reason
 * this is a named function rather than `plan.runs.length > 0` at the call site.
 * `src/lib/packs/reorder.ts` spells the case out: drag the only item of one category into
 * an empty one and its position is 0 before and 0 after, so both runs' update lists come
 * back empty while the move is entirely real. A caller reading an empty `runs` as "nothing
 * to do" loses that move.
 *
 * The opposite case is worth an empty transaction being avoided rather than an error: a
 * drag that ends where it began produces no reparent and no updates, and the honest answer
 * is to write nothing and report success, not to send a round trip that renumbers a run to
 * the numbers it already has.
 */
export function planChangesAnything(plan: ReorderPlan): boolean {
  return plan.reparent !== null || plan.runs.length > 0;
}
