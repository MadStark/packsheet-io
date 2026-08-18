import type { APIRoute } from 'astro';
import { createAuthClient } from '../../lib/auth';
import { NEXT_PARAM, SIGN_IN_PATH } from '../../lib/auth-routes';
import { loadPackForEdit } from '../../lib/packs/query';
import { movePackCategory, movePackItem } from '../../lib/packs/mutations';
import {
  REORDER_BODY_MESSAGE,
  REORDER_TARGET,
  parseReorderIntent,
  planChangesAnything,
  planReorderIntent,
} from '../../lib/packs/reorder-request';

// On-demand: this endpoint requires a session, reads a request body and writes
// pack_items/pack_categories — none of which a prerendered file can do. It needs no entry
// of its own in src/middleware.ts's AUTH_ROUTE_PATHS: PACK_REORDER_PATH sits under
// PACKS_PATH, which is on that list, and sub-paths inherit the rule (see that list's own
// comment on enumerated roots, and src/lib/packs/routes.ts's on why this URL is parked
// here rather than at a top-level /api/...).
export const prerender = false;

/**
 * Applies one drag: an item moved within or between categories, or a category moved among
 * its siblings. POST only, JSON in and JSON out.
 *
 * ---------------------------------------------------------------------------
 * WHAT AUTHORISES THE MOVE, IN ORDER, AND WHAT EACH LAYER IS FOR
 * ---------------------------------------------------------------------------
 *
 * 1. THE SESSION. `Astro.locals.user`, resolved once per request by src/middleware.ts with
 *    a verified `getUser()` call. No session, no request — and this endpoint never reads a
 *    user id out of the body, so there is no spelling of "act as someone else".
 * 2. THE READ, UNDER THE CALLER'S OWN SESSION AND SCOPED TO THEM. `loadPackForEdit` issues
 *    `.eq('id', packId).eq('user_id', user.id)` through a client built from this request's
 *    cookies. The owner filter is load-bearing rather than belt-and-braces:
 *    `packs_select_public` would hand back any stranger's public pack for the id alone —
 *    see that function's own comment. A pack that is not this visitor's is `{ data: null }`
 *    here and the request is over before anything is planned.
 * 3. THE PLAN, RECOMPUTED FROM THOSE ROWS. The body says WHICH item, WHICH destination
 *    category and WHICH index; `planReorderIntent` derives every position from the rows
 *    step 2 just read. Nothing a client sends becomes a position — see
 *    src/lib/packs/reorder.ts's "BOTH SIDES CALL THIS, ONLY ONE SIDE IS BELIEVED" and
 *    src/lib/packs/routes.ts's note on why the pack id travels in the body rather than the
 *    path (a pack id in a URL LOOKS like it authorised something and does not).
 * 4. THE RPC, WHICH RE-DERIVES ALL OF IT ANYWAY. `move_pack_item`/`move_pack_category` are
 *    `security invoker` and their first statement is
 *    `select 1 from public.packs where id = p_pack_id and user_id = auth.uid() for update` —
 *    simultaneously the row lock and the authorisation check. They then prove every id in
 *    the payload belongs to that pack and refuse to commit unless the number of rows
 *    updated matches the number of pairs sent. Steps 2 and 3 exist to give the visitor a
 *    sentence instead of an exception; step 4 is what actually says no.
 *
 * Row level security sits under all four: every write policy on `pack_categories` and
 * `pack_items` requires `user_id = auth.uid()` AND an unlocked parent pack, so a locked
 * pack fails inside the transaction with the trigger's own `pack % is locked` rather than
 * needing a check here that would be a second copy of the rule.
 *
 * ---------------------------------------------------------------------------
 * CSRF, AND WHY THERE IS NOTHING NEW HERE
 * ---------------------------------------------------------------------------
 *
 * The same pair every other mutating route in this project relies on: Astro's on-demand
 * origin check (`security.checkOrigin`, set explicitly in astro.config.mjs) plus the
 * session cookie's `sameSite: 'lax'`. The cookie is what does the work for this endpoint
 * specifically — a cross-site POST carries no `sb-` cookie at all, so middleware resolves
 * no user and step 1 above ends the request. Worth stating because the origin check alone
 * would not: it refuses a cross-origin POST with a FORM-LIKE content type, and this
 * endpoint's is `application/json`, which a browser cannot send cross-origin without a
 * CORS preflight this Worker never answers. Two mechanisms, and the one that always
 * applies is the cookie.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS RETURNS
 * ---------------------------------------------------------------------------
 *
 * JSON, always, except for the signed-out redirect below. On success, the plan that was
 * actually applied — `runs` and `reparent` — because that is what the island (PK-41)
 * re-renders from when its own optimistic prediction and the server's answer disagree:
 * `ReorderPlan` is a PREDICTION on the client and a RESULT here, from identical code, and
 * this is the side that gets written.
 *
 * A failed write reports one of the sentences below and never the PostgREST error itself —
 * the house rule stated in src/lib/gear/form.ts's "NEVER A RAW POSTGRES OR POSTGREST
 * STRING". `move_pack_item` raises `pack % is not yours to reorder` and
 * `p_runs renumbers an item that is not in pack %`, both of which name internals and
 * neither of which a client has any use for.
 */

/** Never a raw PostgREST/Postgres string; see the module comment. This one covers the read
 *  and the RPC alike, because from a client's side they are the same event — the move did
 *  not happen and the pack on screen is no longer trustworthy. */
const REORDER_FAILED_MESSAGE = 'That move could not be saved. Reload the pack and try again.';
/** A pack this visitor does not own, a pack that no longer exists, and a malformed id all
 *  collapse here — the same collapse `loadPackForEdit` performs and for the same reason:
 *  none of the three is a distinction somebody probing this endpoint should be able to
 *  tell apart from outside. */
const PACK_MISSING_MESSAGE = 'That pack could not be found.';

function json(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Every failure answers in one shape, so a client has one thing to read rather than a
 *  status-code table. `ok` is present on both branches deliberately: a `fetch` that lands
 *  on an unexpected 500 page still parses as "no `ok: true`". */
const fail = (message: string, status: number) => json({ ok: false, message }, status);

export const POST: APIRoute = async ({ locals, cookies, request, url, redirect }) => {
  // The signed-out case, answered exactly as the two pack pages answer it — a 303 to
  // sign-in with `next` set to this URL, path and query. It is a redirect rather than a
  // bare 401 because that is this ticket's rule for every route under /packs, and the
  // island can tell: `fetch` follows the redirect, so `response.redirected` is true and
  // `response.ok` describes the sign-in page rather than a move. There is no useful
  // interactive destination to send a browser to here — this URL answers POST and nothing
  // else — so a visitor who arrives at sign-in from a reorder lands back on a path that
  // will 405 a GET. That is accepted rather than papered over with a different target:
  // inventing one would make this the single route whose `next` points somewhere the
  // visitor was not, and the case only arises for a session that expired with the editor
  // still open, where the pack's own URL is one back-button away.
  const user = locals.user;
  if (!user) {
    const next = `${url.pathname}${url.search}`;
    return redirect(`${SIGN_IN_PATH}?${NEXT_PARAM}=${encodeURIComponent(next)}`, 303);
  }

  // A body that is not JSON at all — a form post, a truncated upload, an empty body — is
  // this failure rather than an exception. `parseReorderIntent` takes `unknown` and is
  // total over it, so everything past this line is one function's decision.
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(REORDER_BODY_MESSAGE, 400);
  }

  const parsed = parseReorderIntent(body);
  if (!parsed.ok) return fail(parsed.message, 400);
  const intent = parsed.value;

  const client = createAuthClient(cookies, request);

  // The endpoint's own read — step 2 of the module comment. Not the tree the island is
  // rendering from, not a tree in the body: rows fetched now, under this request's own
  // session, which is the only thing that makes step 3's arithmetic mean anything.
  const { data: pack, error: loadError } = await loadPackForEdit(client, user.id, intent.packId);
  if (loadError) return fail(REORDER_FAILED_MESSAGE, 500);
  if (pack === null) return fail(PACK_MISSING_MESSAGE, 404);

  const planned = planReorderIntent(pack, intent);
  // 409 rather than 400: the request was well formed and was refused by the state of the
  // pack, which is a distinction worth keeping because it is the one a client can act on
  // by reloading rather than by fixing what it sent.
  if (!planned.ok) return fail(planned.message, 409);
  const plan = planned.value;

  // A drag that ended where it began. No write at all — see `planChangesAnything` for why
  // the check is on the plan rather than on `runs` alone, and why an empty transaction is
  // the wrong way to express "nothing moved".
  if (!planChangesAnything(plan)) return json({ ok: true, ...plan }, 200);

  const { error } =
    intent.target === REORDER_TARGET.item
      ? await movePackItem(
          client,
          user.id,
          intent.packId,
          intent.itemId,
          intent.toCategoryId,
          plan.runs,
        )
      : await movePackCategory(client, user.id, intent.packId, plan.runs);

  if (error) return fail(REORDER_FAILED_MESSAGE, 500);

  // The plan as applied, for the island to re-render from. Spread rather than rebuilt, so
  // what is reported is the object that was written from and not a second description of
  // it that could describe it wrongly.
  return json({ ok: true, ...plan }, 200);
};
