/**
 * The response shape for the add-to-pack dialog's closet page (PK-74): what
 * `src/pages/packs/closet.ts` answers with, and the messages it answers with on
 * failure. Sibling to `src/lib/packs/reorder-response.ts` — same reason for existing,
 * same shape — though this endpoint has no branch table to speak of: it is a single GET
 * that either reads a page of the closet or does not, so there is one success shape and
 * one failure shape rather than reorder's seven outcomes.
 *
 * ---------------------------------------------------------------------------
 * WEIGHT TRAVELS AS RAW GRAMS, NOT A FORMATTED STRING
 * ---------------------------------------------------------------------------
 *
 * `ClosetItemPayload.weightGrams` is the bare number `gear_items.weight_grams` holds
 * (PK-67 — every row's weight is stored in grams, full stop). This module does not call
 * `formatWeight`: doing so here would bake a WEIGHT SYSTEM into the response, and the
 * dialog rendering it is client-side script with no access to `Astro.locals` or the
 * request that resolved the visitor's own `WeightSystem` on the server. `formatWeight`
 * (`src/lib/units.ts`) is a pure function of `(grams, system)` that the browser can call
 * directly once it already knows which system to render in — from the page's own
 * server-rendered markup, the same way every other weight on the pack page is decided.
 * Formatting here would also mean there were TWO places on the site that turn grams into
 * a displayed string, which is the exact duplication `formatWeight`'s own module comment
 * argues against ("`formatWeight` derives the displayed unit... rather than from a
 * stored string").
 *
 * ---------------------------------------------------------------------------
 * NEVER A RAW POSTGRES OR POSTGREST STRING
 * ---------------------------------------------------------------------------
 *
 * The house rule `src/lib/packs/form.ts` states under this same heading, and
 * `src/lib/packs/reorder-response.ts`/`reorder-request.ts` both follow for their own
 * endpoint: every message below is a complete, neutral sentence a visitor can read.
 * `loadGearCloset`'s own `error` is postgrest-js's `PostgrestError | null`, and its
 * `.message` is never shown to a visitor — `closetLoadFailedMessage` below is what the
 * endpoint answers with instead.
 *
 * ---------------------------------------------------------------------------
 * NOT importing src/lib/auth/ OR @supabase/*
 * ---------------------------------------------------------------------------
 *
 * Same rule and reasons as `src/lib/packs/closet-request.ts`'s header: this module may
 * ship to the browser alongside the rest of the add-to-pack dialog's pure modules, and
 * it is handed rows and numbers, never a client or a cookie.
 */

import { GEAR_PAGE_SIZE } from '../gear/fields';

// ---------------------------------------------------------------------------
// The success shape
// ---------------------------------------------------------------------------

/**
 * One closet row as the dialog needs it: enough to render a pickable item and nothing
 * it would have to fetch again. `id` is what a "add to pack" action names; `name` and
 * `brand` are what the row displays; `weightGrams` is what `formatWeight` turns into the
 * figure beside it — see this module's header for why that conversion happens in the
 * browser and not here.
 *
 * STRUCTURAL, NOT `GEAR_SELECT`'S OWN ROW TYPE. `closetItemPayload` below takes exactly
 * these four fields off whatever `loadGearCloset` returns, the same reasoning
 * `ReorderCategoryRows`/`ReorderPackRows` give in `reorder-request.ts`: this module's
 * whole value is being independent of the query layer's exact select list, and typing
 * against the full row would mean a column added to `GEAR_SELECT` for some other reason
 * silently became part of this contract too.
 */
export interface ClosetItemPayload {
  readonly id: string;
  readonly name: string;
  readonly brand: string | null;
  readonly weightGrams: number;
}

/**
 * The full page the endpoint answers with on success.
 *
 * `page` AND `totalPages` ARE BOTH PRESENT, DELIBERATELY, rather than leaving the dialog
 * to infer one from `totalCount`/`GEAR_PAGE_SIZE` itself — `page` in particular is not
 * always the page the request asked for: `loadGearCloset`'s own C2 clamp (see that
 * function's comment in `src/lib/gear/query.ts`) can answer a `?page=9` that no longer
 * exists with the real last page instead of a 416, and the dialog has to render the page
 * it actually got rather than the one it asked for.
 */
export interface ClosetPagePayload {
  readonly ok: true;
  readonly items: readonly ClosetItemPayload[];
  readonly page: number;
  readonly totalPages: number;
  readonly totalCount: number;
}

/** The one failure shape, matching `reorder.ts`'s `{ ok: false, message }` — one thing a
 *  client has to read rather than a status-code table, and `ok` present on both branches
 *  so a `fetch` landing on an unexpected error page still parses as "no `ok: true`". */
export interface ClosetFailurePayload {
  readonly ok: false;
  readonly message: string;
}

/**
 * The row shape `closetItemPayload` reads from — see this type's own comment above for
 * why it is structural rather than `GEAR_SELECT`'s row.
 */
export interface ClosetSourceItem {
  readonly id: string;
  readonly name: string;
  readonly brand: string | null;
  readonly weight_grams: number;
}

/** One closet row, reshaped into the wire field names the dialog reads. A pure
 *  reshaping, not a second parse — `weightGrams` is `weight_grams` carried straight
 *  across, unconverted, for the reason this module's header gives. */
export function closetItemPayload(item: ClosetSourceItem): ClosetItemPayload {
  return {
    id: item.id,
    name: item.name,
    brand: item.brand,
    weightGrams: item.weight_grams,
  };
}

/**
 * The total number of pages a closet of `totalCount` rows has, at `GEAR_PAGE_SIZE` rows
 * per page. Mirrors the arithmetic `loadGearCloset` already performs internally to clamp
 * an over-range page (`src/lib/gear/query.ts`) — `Math.max(1, ceil(count / pageSize))`,
 * never zero even for an empty closet, because "page 1 of an empty list" is the honest
 * description of zero items and "page 0" is not a page a pager can point at.
 */
export function closetTotalPages(totalCount: number): number {
  return Math.max(1, Math.ceil(totalCount / GEAR_PAGE_SIZE));
}

/** Builds the success payload from what `loadGearCloset` returned: its items reshaped,
 *  its own (already-clamped) `page` carried through unchanged, and `totalPages` derived
 *  from `totalCount` rather than asked for separately. */
export function closetPagePayload(
  items: readonly ClosetSourceItem[],
  page: number,
  totalCount: number,
): ClosetPagePayload {
  return {
    ok: true,
    items: items.map(closetItemPayload),
    page,
    totalPages: closetTotalPages(totalCount),
    totalCount,
  };
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** What `loadGearCloset`'s own read failure becomes for a visitor — never the
 *  `PostgrestError` itself, per this module's header. Covers the one query this
 *  endpoint issues, so there is only one failure to name: unlike `reorder.ts`, there is
 *  no write here to fail separately and no plan to distinguish an unreadable answer
 *  from. */
export const CLOSET_LOAD_FAILED_MESSAGE = 'Something went wrong loading your closet. Try again.';
