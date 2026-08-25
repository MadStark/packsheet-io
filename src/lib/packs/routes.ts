/**
 * Route paths for pack list composition (PK-37), on exactly the same footing as
 * `src/lib/gear/routes.ts` and `src/lib/auth-routes.ts`: a handful of strings,
 * dependency-free, so that any page, component, island or middleware can import them
 * without pulling anything heavier along behind them.
 *
 * WHY DEPENDENCY-FREE MATTERS HERE SPECIFICALLY, AND WHAT ACTUALLY ENFORCES IT.
 * `src/middleware.ts` imports `GEAR_PATH` from `src/lib/gear/routes.ts` to add it to
 * `AUTH_ROUTE_PATHS` (the paths that require a signed-in session and are served
 * `no-store`), and `PACKS_PATH` joins that list for the same reason. But middleware's
 * reach is NOT why the rule bites here, and it is worth being exact about that, because
 * the tempting version of this paragraph is wrong.
 *
 * Invariant A in `tests/anonymous-read-path.test.ts` is "no module outside `src/lib/auth/`
 * may import anything under `src/lib/auth/`, EXCEPT the modules enumerated in
 * `AUTH_CONSUMERS`". Its own comment insists on the distinction: it is "an EDGE rule with
 * a named exemption list, not a reachability rule, and the difference is the whole point".
 * So it says nothing whatever about what middleware can reach, and nothing about what a
 * module contains. What it says about THIS file is narrow and absolute: `src/lib/packs/
 * routes.ts` is not on `AUTH_CONSUMERS`, so a single import edge from here into
 * `src/lib/auth/` fails the build, with no argument available about the import being
 * type-only or the code being harmless.
 *
 * AND THIS FILE CAN NEVER BUY ITS WAY ONTO THAT LIST, which is the part worth writing
 * down, because it is what makes "import nothing" a structural fact rather than a habit.
 * PK-37's reorder UI is a Vue island (`src/components/PackContents.vue`) and it imports
 * `PACK_REORDER_PATH` from here, so this module is in the build's CLIENT Rollup pass — the
 * pass a browser downloads. Invariant D1 forbids any module named in `AUTH_CONSUMERS` from
 * appearing in that pass. The exemption door is therefore bolted from the other side: add
 * this file to the allowlist to legalise an auth import and D1 fails instead. D2 closes the
 * remaining gap by forbidding anything in the client pass from being, or importing, any
 * `@supabase/*` package at runtime.
 *
 * A WORKED EXAMPLE, SO THE RULE IS NOT MISREMEMBERED AS A BROADER ONE THAN IT IS.
 * Importing `src/lib/packs/query.ts` from here would NOT trip Invariant A: that module
 * gets `PacksheetClient` from `../supabase`, not from `src/lib/auth/`, so there is no edge
 * into the choke point to find. It would still be the wrong thing to do, and for reasons
 * this file has to supply itself rather than borrow from the guardrail — a strings module
 * that drags a query layer behind it stops being importable by middleware, by a
 * prerendered page and by an island alike, which is the entire property the file exists to
 * have. That is why the rule below is "imports nothing", full stop, rather than "imports
 * nothing the invariants would catch": the invariants are a floor, and this file is
 * deliberately well above it.
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
 * `tests/packs-routes.test.ts` pins THAT half — the half a schema change could break — by
 * asserting that `reorder` does not match the UUID shape and that `packPath` of a UUID is
 * never this constant. The other half, Astro's static-before-dynamic resolution, is pinned
 * by nothing here: it is framework behaviour this repository does not own and cannot
 * assert without booting a router, so it is documented and relied on rather than tested.
 * The unreachability of the collision is what makes that acceptable.
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

/**
 * The query parameter that opens the pack-details dialog, and the two hrefs that carry
 * it (PK-72).
 *
 * WHY A QUERY PARAMETER AND NOT A ROUTE. `src/components/Modal.astro` upgrades a real
 * `<a href>` into a popup and refuses anything else, so that the control still works with
 * JavaScript off — with no script, the anchor simply navigates, and the page it lands on
 * renders the dialog already open. That means the trigger needs somewhere real to point,
 * and the two candidates were a pair of new routes (`/packs/new`, `/packs/{id}/edit`) or
 * a parameter on the pages that already exist.
 *
 * The parameter wins on one concrete ground rather than on taste: the dialog's failure
 * path. A rejected save re-renders the page it posted to, and must re-open the dialog
 * with the visitor's text and the errors still in it. On a parameter that is one boolean
 * OR at the top of the page (`has the param` OR `did this post fail`). With a separate
 * route the form would have to post back to that route, which then has to load and render
 * the list or the pack behind the dialog as well — a second page rendering the first
 * page's content, for no gain the visitor can see.
 *
 * THE VALUE IS IGNORED; PRESENCE IS THE SIGNAL. `?new` and `?new=1` and `?new=anything`
 * all open the dialog, because `URLSearchParams.has` is what reads it. Nothing is parsed,
 * so there is nothing here for a hostile value to reach.
 */
export const PACK_CREATE_PARAM = 'new';

/** The same, for the pack page's *Edit details* button. */
export const PACK_EDIT_PARAM = 'edit';

/** The packs list, with the create-pack dialog open. */
export function packCreateHref(): string {
  return `${PACKS_PATH}?${PACK_CREATE_PARAM}`;
}

/** A pack's page, with its details dialog open. */
export function packEditHref(id: string): string {
  return `${packPath(id)}?${PACK_EDIT_PARAM}`;
}

/**
 * Where the add-to-pack dialog (PK-74) fetches one page of the signed-in visitor's
 * closet from. An ACTION, not a page, on the same footing as `PACK_REORDER_PATH` above
 * and for the same reason: it answers a GET and returns JSON, nobody navigates to it.
 *
 * UNDER `/packs`, DELIBERATELY, for the identical reason `PACK_REORDER_PATH` gives: the
 * single prefix `src/middleware.ts` already treats as session-shaped covers this
 * endpoint too, so it needs no entry of its own in `AUTH_ROUTE_PATHS`.
 *
 * IT SHADOWS `packPath('closet')`, AND THAT IS SAFE FOR THE SAME REASON
 * `PACK_REORDER_PATH` IS. Astro resolves a static segment ahead of a dynamic one, so
 * `/packs/closet` reaches the endpoint and never `/packs/[id]`, and the pack it would
 * otherwise hide cannot exist: `packs.id` is a UUID, and the literal string `closet` is
 * not one. See `PACK_REORDER_PATH`'s own comment for the full argument and where it is
 * pinned in tests.
 */
export const PACK_CLOSET_PATH = '/packs/closet';
