/**
 * Route paths for the gear closet (PK-4), on the same footing as
 * `src/lib/auth-routes.ts`: a handful of strings, dependency-free, so that any page,
 * component or middleware can import them without pulling in anything heavier.
 *
 * WHY DEPENDENCY-FREE MATTERS HERE SPECIFICALLY. `src/middleware.ts` imports
 * `GEAR_PATH` to add it to `AUTH_ROUTE_PATHS` (the list of paths that require a signed
 * -in session), and middleware runs on every request this Worker serves, including the
 * anonymous read path a shared pack link uses. `tests/anonymous-read-path.test.ts`
 * enforces that no `@supabase/*` import reaches that path — so this file must not
 * import `src/lib/gear/query.ts` (which types against `PacksheetClient`) or anything
 * else that does. It is safe by construction, the same way `src/lib/auth-routes.ts` is:
 * nothing in it touches an SDK, so nothing needs to be reviewed each time a path is
 * added to it.
 */

/** The gear closet list: search, filter, sort and paginate a user's `gear_items`. */
export const GEAR_PATH = '/gear';

/** The form for adding a new gear item. */
export const GEAR_NEW_PATH = '/gear/new';

/**
 * The JSON import page (PK-65): upload a file, read the preview, then confirm.
 *
 * IMPORT HAS A PATH AND EXPORT DOES NOT, and that asymmetry is worth a line here because
 * it looks like an omission. Export is a bulk action on the closet list — it POSTs to
 * `GEAR_PATH` with a selection, exactly as the other three do, and answers with a file
 * rather than a page. There is no URL a visitor can navigate to that produces an export,
 * deliberately: the thing being exported IS the selection, and a selection does not
 * survive a GET.
 */
export const GEAR_IMPORT_PATH = '/gear/import';

/**
 * The query parameter a finished import redirects with, carrying how many items it wrote,
 * so the closet can confirm it (PK-65).
 *
 * A HINT, NOT STATE. The closet renders it and nothing else — it does not filter, sort or
 * fetch from it, so a hand-edited `?imported=9999` produces a wrong sentence and no wrong
 * data. It lives here beside the paths for the reason this whole module exists: it is a
 * string two files have to agree on, and a literal in each of them is two strings that
 * agree today. `parseGearQuery` does not know this parameter, which is deliberate — it is
 * not part of the closet's filter state and must not survive into the links the list
 * rebuilds, so the banner disappears on the visitor's next click rather than following
 * them around.
 */
export const GEAR_IMPORTED_PARAM = 'imported';

/**
 * The detail/edit page for a single gear item. A function rather than a constant
 * because it needs an id; kept here rather than assembled ad hoc at each call site so
 * a future change to the URL shape (nesting, a slug instead of an id) is one edit.
 */
export function gearItemPath(id: string): string {
  return `${GEAR_PATH}/${id}`;
}
