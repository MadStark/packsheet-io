/**
 * Route paths for pack list composition (PK-37), on exactly the same footing as
 * `src/lib/gear/routes.ts` and `src/lib/auth-routes.ts`: a handful of strings,
 * dependency-free, so that any page, component, island or middleware can import them
 * without pulling anything heavier along behind them.
 *
 * WHY DEPENDENCY-FREE MATTERS HERE SPECIFICALLY. `src/middleware.ts` imports `GEAR_PATH`
 * from `src/lib/gear/routes.ts` to add it to `AUTH_ROUTE_PATHS` (the paths that require a
 * signed-in session and are served `no-store`), and `PACKS_PATH` joins that list for the
 * same reason. Middleware runs on EVERY request this Worker serves — including the
 * anonymous read path a shared pack link uses — so Invariant A in
 * `tests/anonymous-read-path.test.ts` applies to everything reachable from it. That
 * invariant is an EDGE rule: it does not look at what a module contains, only at whether
 * something outside the auth choke point has an import edge into it. A file of pure
 * strings that imported a pack query module (which would type against `PacksheetClient`)
 * would ship zero auth code and still fail the build. So this file imports nothing at
 * all, and is safe by construction rather than by being re-reviewed every time a path is
 * added to it — the same guarantee `src/lib/auth-routes.ts`'s header spells out at
 * length.
 *
 * AND THE ISLAND IMPORTS IT TOO, which is the second, independent reason the rule has to
 * hold. PK-37's reorder UI is a Vue island: its module graph is bundled and shipped to
 * the BROWSER. An import added here that reached `src/lib/auth/` or `@supabase/*` would
 * not merely trip a guardrail, it would put an auth SDK in the client bundle of a page
 * anonymous visitors load. Nothing below may grow such an import. If a value in this file
 * ever needs one, that value does not belong in this file.
 */

/** The list of a signed-in visitor's packs. */
export const PACKS_PATH = '/packs';

/**
 * The composition editor for a single pack: its categories, its items, and the drag
 * handles that reorder both. A function rather than a constant because it needs an id,
 * and kept here rather than assembled ad hoc at each call site for the reason
 * `gearItemPath` gives — a future change to the URL shape (a slug instead of an id, a
 * nesting level) is then one edit rather than a grep.
 */
export function packPath(id: string): string {
  return `${PACKS_PATH}/${id}`;
}

/**
 * Where the reorder island POSTs a move to. An ACTION, not a page — the same shape as
 * `SIGN_OUT_PATH` (`/auth/signout`) and for the same reason: it answers a POST and
 * returns a result, nobody navigates to it.
 *
 * UNDER `/packs`, DELIBERATELY, so that the single prefix `src/middleware.ts` already
 * treats as session-shaped covers the endpoint as well as the pages. An endpoint parked
 * at a top-level `/api/...` would be a second root somebody has to remember to add to
 * `AUTH_ROUTE_PATHS`; putting it here means it inherits the rule (see that list's own
 * comment on enumerated roots and inherited sub-paths, which argues exactly this trade).
 *
 * IT SHADOWS `packPath('reorder')`, AND THAT IS SAFE RATHER THAN LUCKY. Astro resolves a
 * static segment ahead of a dynamic one, so `/packs/reorder` reaches the endpoint and
 * never `/packs/[id]`. The pack it would otherwise hide cannot exist: `packs.id` is
 * `uuid primary key default gen_random_uuid()`
 * (`supabase/migrations/20260810120000_core_schema.sql:127`), so the only ids `packPath`
 * is ever handed are 36-character UUIDs and the literal string `reorder` is not one.
 * `tests/packs-routes.test.ts` pins both halves of that.
 *
 * ONE CONSTANT, NOT A FUNCTION OF THE PACK ID, and that is a decision about trust rather
 * than about URLs. The pack id travels in the POST body along with the item, the target
 * category and the target index, because the server must re-derive the whole move from
 * rows it reads itself under the caller's own session — see the "BOTH SIDES CALL THIS,
 * ONLY ONE SIDE IS BELIEVED" section of `src/lib/packs/reorder.ts`. A pack id in the path
 * would LOOK like it authorised something; it would not, and the row-level policies would
 * still be the only thing that did. Keeping it in the body keeps that honest.
 */
export const PACK_REORDER_PATH = '/packs/reorder';
