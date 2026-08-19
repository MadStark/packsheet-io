import { defineMiddleware } from 'astro:middleware';
import { getUser } from './lib/auth';
import {
  ACCOUNT_PATH,
  AUTH_CALLBACK_PATH,
  FORGOT_PASSWORD_PATH,
  SIGN_IN_PATH,
  SIGN_OUT_PATH,
  SIGN_UP_PATH,
  UPDATE_PASSWORD_PATH,
} from './lib/auth-routes';
// Dependency-free, same footing as ./lib/auth-routes — see that file's own module
// comment, and src/lib/gear/routes.ts's, for why a path constant lives one door away
// from the auth choke point rather than inside it.
import { GEAR_PATH } from './lib/gear/routes';
// Also dependency-free, and deliberately so — its own header explains that this import is
// one of the two reasons it holds nothing but strings, the other being the reorder island
// that ships it to the browser.
import { PACKS_PATH } from './lib/packs/routes';
import { HOME_PATH } from './lib/routes';
// Also dependency-free, and load-bearing for what this file costs rather than for what
// it decides: see the gate on the user lookup in `onRequest` below.
import { hasSupabaseAuthCookie } from './lib/session-cookie';

/**
 * Every path this middleware treats as "an auth route" for the caching rule below — not
 * for the user lookup, which is gated on `isPrerendered` instead (see the comment on
 * `onRequest`).
 *
 * ENUMERATED ROOTS, INHERITED SUB-PATHS, and the two halves of that are a deliberate
 * pair rather than an accident of how `isAuthRoute` was written. This comment used to
 * say the opposite of the code — that a future `/account/` sub-page "should have to earn
 * its way onto this list rather than inherit the no-store rule by accident of URL shape"
 * — while `isAuthRoute` matched every sub-path of every entry. One of the two had to go,
 * and it was the comment, because the code is right:
 *
 *   - The two failures are not symmetric. Over-applying `no-store` costs a route its edge
 *     cacheability, and every path below is on-demand and session-shaped anyway, so the
 *     bill is close to nothing. UNDER-applying it means a response that depends on who is
 *     asking is handed to a shared cache — one visitor's account screen served to
 *     another. A default that has to be remembered is the wrong way round for a pair like
 *     that.
 *   - The route that would be forgotten is exactly the one that matters. `/account/`
 *     sub-pages are where a signed-in person's data goes; the argument for making them
 *     opt in is tidiness, and the cost of forgetting is a cross-visitor cache hit.
 *
 * The ROOTS stay enumerated for the reason the comment originally reached for: nothing
 * here matches a bare `/auth/` or `/account/` prefix by pattern, so a new top-level route
 * is a line somebody adds on purpose. What is inherited is only what sits UNDER a path
 * already on the list, which is a place a session-bearing page genuinely belongs.
 *
 * A route that must be publicly cacheable therefore must not live under one of these
 * prefixes — which is the right constraint anyway, since these are the prefixes whose
 * whole meaning is "this is about who you are".
 */
const AUTH_ROUTE_PATHS: readonly string[] = [
  SIGN_IN_PATH,
  SIGN_UP_PATH,
  SIGN_OUT_PATH,
  ACCOUNT_PATH,
  AUTH_CALLBACK_PATH,
  // PK-56's two password-reset pages, added here as the deliberate lines this list's
  // comment asks for rather than inherited from a prefix. Both are session-shaped even
  // though only one of them requires a session: /update-password renders the address the
  // recovery session belongs to, and /forgot-password renders either a blank form or a
  // just-submitted confirmation — two states of one URL, and a shared cache handing the
  // second to the next visitor is the failure this rule exists to prevent.
  FORGOT_PASSWORD_PATH,
  UPDATE_PASSWORD_PATH,
  // PK-4's gear closet, added as the same kind of deliberate line as the two above
  // rather than inherited from a prefix that did not previously exist. GEAR_PATH
  // (`/gear`) is itself session-shaped — it lists, filters and bulk-edits the
  // signed-in visitor's own gear_items, and redirects a signed-out visitor to sign-in
  // before rendering anything else — and every sub-path this ticket and the ones after
  // it add (`/gear/new`, `/gear/<id>`) is exactly the kind of thing this list's own
  // comment says belongs under an enumerated root: a page where a shared
  // cache handing one visitor's closet to the next visitor is the failure this rule
  // exists to prevent. One line here covers all of them, the same way ACCOUNT_PATH
  // covers every future `/account/` sub-page without each one earning its own entry.
  GEAR_PATH,
  // PK-37's pack list, editor and reorder endpoint, added as one more deliberate line
  // rather than inherited from a prefix. PACKS_PATH (`/packs`) lists the signed-in
  // visitor's own packs and redirects a signed-out one to sign-in before rendering
  // anything; `/packs/<id>` is that visitor's composition editor. Both are exactly the
  // shape this rule exists for — a shared cache handing one visitor's packs to the next
  // visitor — and both would be as wrong to cache as the closet is.
  //
  // AND THE REORDER ENDPOINT COMES WITH THEM, WITHOUT ITS OWN LINE. `/packs/reorder`
  // (PACK_REORDER_PATH) sits under this root on purpose: src/lib/packs/routes.ts's own
  // comment argues that an endpoint parked at a top-level `/api/...` would be a second
  // root somebody has to remember to add here, whereas one under `/packs` inherits the
  // rule — which is precisely the enumerated-roots-with-inherited-sub-paths trade this
  // list's comment above sets out. One line covers all three routes, the same way
  // ACCOUNT_PATH covers every `/account/` sub-page.
  PACKS_PATH,
  // `/` — the site root, which stopped being a static landing page and became a router
  // that answers differently depending on who is asking (src/pages/index.astro). Its
  // response is a 302 whose Location is the visitor's session in one header, and a 302 is
  // exactly the kind of small, cheap response a shared cache is happy to keep and re-serve
  // — so without this line the first anonymous visitor to reach an edge could pin every
  // later signed-in visitor to the landing page, and vice versa.
  //
  // NOTE WHAT THIS ONE ENTRY DOES NOT DO, because `HOME_PATH` is `'/'` and the prefix rule
  // below looks alarming with it: `isAuthRoute` degenerates to an EXACT match here. The
  // second arm tests `pathname.startsWith('/' + '/')` — that is, `'//'` — and a pathname
  // beginning `//` is not something a URL this Worker serves can produce. So `/` is marked
  // and nothing beneath it is, which is the intent: `/gear` and `/account` are on this
  // list on their own merits, and a genuinely public page added at `/pack/<id>` tomorrow
  // must stay cacheable.
  HOME_PATH,
];

/** The path itself, or anything beneath it. `${path}/` and not `path` as a bare prefix:
 *  without the separator, `/accountant` would inherit `/account`'s rule — the same
 *  trailing-separator bug the auth choke-point check has its own fixture for. */
function isAuthRoute(pathname: string): boolean {
  return AUTH_ROUTE_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

/**
 * Resolves the signed-in user once per request and enforces the one caching rule
 * `@supabase/ssr` cannot enforce on its own: a response that depends on who is asking
 * must never be handed to Cloudflare's edge cache to serve to somebody else.
 *
 * WHY `context.isPrerendered` GATES THE USER LOOKUP, AND WHAT BUILDING THIS FILE
 * ACTUALLY CAUGHT. Astro middleware runs for every route it renders, and that
 * includes a PRERENDERED page's build-time render — `npm run build` calls this
 * function once for robots.txt and once for the landing page too, not only for the
 * on-demand auth routes, because generating their static HTML goes through the same
 * request pipeline as a live request does. An earlier version of this file called
 * `getUser()` unconditionally and broke exactly that: every `npm run build` started
 * failing outright — not merely the auth routes — with `PUBLIC_SUPABASE_URL is not
 * set`, because prerendering robots.txt now demanded Supabase credentials it has
 * nothing to do with. That is precisely the anonymous-read-path auth call
 * `src/lib/auth/index.ts` and `tests/anonymous-read-path.test.ts` both exist to keep
 * off this site, arriving through a route neither of them is positioned to catch —
 * their build-graph analysis is about which MODULE ships, not about which RENDER a
 * shipped module's own code performs at build time.
 *
 * `context.isPrerendered` is Astro's own signal for exactly this distinction — true
 * for a static page's build-time render, false for a request the Worker actually
 * handles — and it is not an improvised fix: Astro's built-in `security.checkOrigin`
 * middleware (`createOriginCheckMiddleware` in `astro/dist/core/app/origin-check.js`)
 * gates its own check on the identical property for the identical reason. Gating on
 * `AUTH_ROUTE_PATHS` instead — "only call getUser() on a path this file already
 * lists" — would have the same blind spot Invariant A's own comment warns about for a
 * reachability-based rule: a future PRENDERED route this list does not enumerate
 * would silently start paying the cost the moment it existed, with nothing here to
 * notice. `isPrerendered` has no such gap, because it asks what the CURRENT render
 * is, not what this file happened to remember to list.
 *
 * THE SECOND GATE, AND WHY IT ARRIVED WITH `/`. `isPrerendered` is about which RENDER is
 * happening; `hasSupabaseAuthCookie` is about whether this particular request could
 * possibly have a session at all. Until `/` became an on-demand route, the second gate
 * would have bought little — every path that reached this function was one a visitor had
 * gone out of their way to open, and most of them belonged to somebody signed in. `/` is
 * different in kind: it is the busiest URL on the site, the one every stranger and every
 * crawler arrives at first, and its answer for all of them is a 302 to the landing page.
 * Paying a network round trip to Supabase's auth server before issuing that redirect —
 * on every one of those visits, to be told what the absence of a cookie already said —
 * is the cost this gate refuses.
 *
 * It is safe in the only direction that matters because middleware runs BEFORE any route,
 * so the inbound `Cookie` header is the entire evidence available: the per-request
 * overlay `createAuthClient` maintains (src/lib/auth/index.ts) is necessarily empty at
 * this point, because nothing has had a chance to write a cookie yet. A request with no
 * `sb-` cookie on it is a request `getUser()` would have resolved to `null` after a round
 * trip. See src/lib/session-cookie.ts for why the check is deliberately broad, and which
 * way it is tuned to be wrong.
 *
 * WHY `getUser()` and not `getSession()`, covered again here because it is the one
 * line most likely to be "simplified" back to the unsafe form: see the identical
 * comment on `getUser` itself in `src/lib/auth/index.ts`. It verifies the session
 * against the auth server rather than trusting whatever the cookie claims. Note that the
 * gate above does NOT weaken this: it decides whether to ASK, never what the answer is.
 * A forged or expired `sb-` cookie reaches `getUser()` exactly as before and is refused
 * by the auth server, not by anything in this file.
 *
 * THE CACHING RULE ITSELF. `Cache-Control: private, no-store` is set whenever either
 * is true: the request resolved to a signed-in user (so the response is personal —
 * the account page and any future page that adapts to who is asking), or the route is
 * one of `AUTH_ROUTE_PATHS` — or anything beneath one — regardless of session state (the
 * sign-in page for a signed-out visitor still must not be cached, because the wrong
 * visitor's CSRF-relevant form state or a stale error message is not a page any other
 * stranger's browser should be shown). A prerendered page's build-time render never sets
 * this header at all — `next()` for it produces the response `astro build` writes to a
 * static file, which Cloudflare's assets binding then serves untouched by this function
 * ever again, and Astro's own asset headers govern its caching instead. That last
 * sentence used to be a description of behaviour the code did not have: the header was
 * set for any listed path, prerendered or not, which is unobservable today only because
 * every path on the list is on-demand. `isPrerendered` gates both halves now, so the
 * comment is the specification rather than an aspiration.
 *
 * `@supabase/ssr` already sets a `Cache-Control` on its own responses for the same reason
 * this block exists; this is the belt to that suspenders — it applies at the Astro
 * response level so it covers every route in `AUTH_ROUTE_PATHS`, not only the ones that
 * happen to touch a Supabase call on every request.
 */
export const onRequest = defineMiddleware(async (context, next) => {
  const worthAsking =
    !context.isPrerendered && hasSupabaseAuthCookie(context.request.headers.get('cookie'));

  context.locals.user = worthAsking
    ? await getUser({ cookies: context.cookies, request: context.request })
    : null;

  const response = await next();

  if (
    !context.isPrerendered &&
    (context.locals.user !== null || isAuthRoute(context.url.pathname))
  ) {
    response.headers.set('Cache-Control', 'private, no-store');
  }

  return response;
});
