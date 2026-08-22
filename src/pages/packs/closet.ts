import type { APIRoute } from 'astro';
import { createAuthClient } from '../../lib/auth';
import { NEXT_PARAM, SIGN_IN_PATH } from '../../lib/auth-routes';
import { loadGearCloset } from '../../lib/gear/query';
import { parseClosetQuery } from '../../lib/packs/closet-request';
import { CLOSET_LOAD_FAILED_MESSAGE, closetPagePayload } from '../../lib/packs/closet-response';

// On-demand: this endpoint requires a session and reads gear_items under the caller's own
// client — neither of which a prerendered file can do. Like src/pages/packs/reorder.ts, it
// needs no entry of its own in src/middleware.ts's AUTH_ROUTE_PATHS: PACK_CLOSET_PATH sits
// under PACKS_PATH, which is on that list, and sub-paths inherit the rule (see that list's
// own comment on enumerated roots, and src/lib/packs/routes.ts's on why this URL is parked
// here rather than at a top-level /api/...).
export const prerender = false;

/**
 * One page of the signed-in visitor's closet, as JSON, for the add-to-pack dialog (PK-74)
 * to render without navigating or reloading the pack page. GET only, JSON out.
 *
 * ---------------------------------------------------------------------------
 * WHAT AUTHORISES THE READ
 * ---------------------------------------------------------------------------
 *
 * Exactly the same two layers as `src/pages/packs/reorder.ts`'s steps 1 and 2, with no
 * plan or RPC to follow because this endpoint never writes anything.
 *
 * 1. THE SESSION. `Astro.locals.user`, resolved once per request by `src/middleware.ts`
 *    with a verified `getUser()` call. No session, no request — and this endpoint never
 *    reads a user id from the query string, only from that resolved session.
 * 2. THE READ, SCOPED TO THE CALLER'S OWN ID. `loadGearCloset(client, user.id, query)`
 *    issues `.eq('user_id', userId)` — load-bearing, not belt-and-braces, because
 *    `gear_items` carries a second SELECT policy granted to `anon, authenticated` alike so
 *    a shared pack link can render the gear on it (see that function's own comment in
 *    `src/lib/gear/query.ts`). Without this filter a plain select would return this
 *    visitor's own rows UNIONED with any row sitting on anyone's public pack — the add-to-
 *    pack dialog silently offering a stranger's gear as this visitor's own closet.
 *
 * ---------------------------------------------------------------------------
 * WHAT A REQUEST MAY SAY
 * ---------------------------------------------------------------------------
 *
 * The same filter/sort/page vocabulary the gear closet page itself accepts:
 * `parseClosetQuery` (`src/lib/packs/closet-request.ts`) is a thin wrapper over
 * `parseGearQuery`, which is total over a `URLSearchParams` and never throws. There is no
 * second read of `gear_items` for this dialog to diverge from the closet page's own —
 * `loadGearCloset` is the one function both call.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS RETURNS
 * ---------------------------------------------------------------------------
 *
 * JSON, always, except for the signed-out redirect below — see that branch's own comment
 * for why a redirect is still the right answer for a `fetch()` caller here, matching
 * `reorder.ts`'s precedent rather than inventing a bare 401. On success, a page of items
 * with their weights in raw grams (`closetPagePayload`, `src/lib/packs/closet-response.ts`)
 * — never a formatted string, because formatting needs the visitor's `WeightSystem`, which
 * this endpoint does not know and the browser already does from the page's own render.
 *
 * A failed read reports `CLOSET_LOAD_FAILED_MESSAGE` and never the PostgrestError itself —
 * the house rule stated in `src/lib/packs/form.ts`'s "NEVER A RAW POSTGRES OR POSTGREST
 * STRING", the same rule `reorder.ts` follows for its own failures.
 *
 * ---------------------------------------------------------------------------
 * CACHING
 * ---------------------------------------------------------------------------
 *
 * `private, no-store`: the response is one visitor's own closet, scoped by session, and
 * must never be served from a shared cache to anybody else — the same rule
 * `src/middleware.ts` enforces for every route under `/packs` at the edge, restated here on
 * the response itself because this is the one thing that response actually carries.
 */
export const GET: APIRoute = async ({ locals, cookies, request, url, redirect }) => {
  // The signed-out case, answered exactly as reorder.ts answers its own: a 303 to sign-in
  // with `next` set to this URL, path and query.
  //
  // WHY A REDIRECT IS STILL RIGHT FOR A `fetch()` CALLER, RATHER THAN A BARE 401. This
  // endpoint exists only to be fetched by the add-to-pack dialog's own script — there is no
  // plain navigation that lands here — so the choice is between matching reorder.ts's
  // precedent and inventing a new shape for the identical situation. A redirect wins for
  // the same reason `sendReorder` (`src/lib/packs/reorder-response.ts`) already knows how
  // to read one: `fetch` follows it, `response.redirected` becomes true, and a caller can
  // tell "this session has expired" apart from "the read failed" without this endpoint
  // having to invent a second vocabulary reorder's own caller does not use. A bare 401
  // would still be readable, but it would be a THIRD shape (after reorder's JSON failure
  // and its redirect) for what is, from a caller's side, the same fact reorder.ts already
  // has a name for.
  const user = locals.user;
  if (!user) {
    const next = `${url.pathname}${url.search}`;
    return redirect(`${SIGN_IN_PATH}?${NEXT_PARAM}=${encodeURIComponent(next)}`, 303);
  }

  const client = createAuthClient(cookies, request);
  const query = parseClosetQuery(url.searchParams);

  const { items, count, page, error } = await loadGearCloset(client, user.id, query);

  const headers = { 'content-type': 'application/json', 'cache-control': 'private, no-store' };

  if (error) {
    return new Response(JSON.stringify({ ok: false, message: CLOSET_LOAD_FAILED_MESSAGE }), {
      status: 500,
      headers,
    });
  }

  return new Response(JSON.stringify(closetPagePayload(items, page, count)), {
    status: 200,
    headers,
  });
};
