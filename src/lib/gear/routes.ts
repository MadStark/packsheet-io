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
 * The detail/edit page for a single gear item. A function rather than a constant
 * because it needs an id; kept here rather than assembled ad hoc at each call site so
 * a future change to the URL shape (nesting, a slug instead of an id) is one edit.
 */
export function gearItemPath(id: string): string {
  return `${GEAR_PATH}/${id}`;
}
