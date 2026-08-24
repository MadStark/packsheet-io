/**
 * The wire half of the add-to-pack dialog's closet page (PK-74): what a request to
 * `PACK_CLOSET_PATH` is allowed to say. Sibling to `src/lib/packs/reorder-request.ts` —
 * same reason for existing, same shape.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A MODULE AND NOT THE ENDPOINT'S OWN FRONTMATTER
 * ---------------------------------------------------------------------------
 *
 * `vitest.config.ts:64` excludes `src/pages/**`, so a decision written inside
 * `src/pages/packs/closet.ts` is a decision no test in this repository can execute —
 * `src/lib/packs/reorder-request.ts`'s header makes the identical argument for its own
 * endpoint. `tests/packs-closet-request.test.ts` calls `parseClosetQuery` directly; the
 * endpoint that uses it is left with authentication and a `Response`.
 *
 * ---------------------------------------------------------------------------
 * OWNS ONLY WHAT `src/lib/gear/query.ts` DOES NOT ALREADY OWN
 * ---------------------------------------------------------------------------
 *
 * The closet list's own filter/sort/page vocabulary — what a `page`, a `q`, a `status`
 * mean — already lives in `parseGearQuery`, which is total over a `URLSearchParams` and
 * defends every field this dialog's request could carry. Re-implementing any of that
 * here would be a second, and inevitably diverging, statement of rules that module
 * already gets right. This module's only job is what is specific to THIS endpoint: it
 * takes the request's `url.searchParams` and hands `parseGearQuery`'s output straight
 * through as a `GearQuery`, so the endpoint has one call to make and one thing to trust.
 *
 * ---------------------------------------------------------------------------
 * NOT importing src/lib/auth/ OR @supabase/*
 * ---------------------------------------------------------------------------
 *
 * Nothing here opens a connection or authenticates anybody: it is handed a
 * `URLSearchParams` and returns a value. The rule and its two reasons are in
 * `src/lib/packs/routes.ts`'s header — Invariant A in `tests/anonymous-read-path.test.ts`
 * is an EDGE rule, and this module may end up in the client Rollup pass alongside the
 * add-to-pack dialog's other pure modules (`src/lib/packs/add-to-pack.ts`).
 */

import { parseGearQuery, type GearQuery } from '../gear/query';

/**
 * Parses the closet endpoint's own request into a `GearQuery`. Total — see
 * `parseGearQuery`'s own "TOTALITY" section — so no shape of hand-edited or hostile query
 * string can make this throw or make the endpoint 500.
 *
 * A THIN WRAPPER, DELIBERATELY. There is currently nothing this endpoint's request needs
 * beyond what `parseGearQuery` already parses — no extra field, no different default. The
 * wrapper exists anyway so that the endpoint imports one name from `src/lib/packs/` rather
 * than reaching into `src/lib/gear/` directly, the same layering `reorder-request.ts`
 * gives `src/pages/packs/reorder.ts` for a single call. If this endpoint ever needs a
 * field `parseGearQuery` has no reason to know about, this is where it is added without
 * widening that module's own contract.
 */
export function parseClosetQuery(params: URLSearchParams): GearQuery {
  return parseGearQuery(params);
}
