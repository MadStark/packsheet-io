import { defineMiddleware } from 'astro:middleware';
import { getUser } from './lib/auth';
import {
  ACCOUNT_PATH,
  AUTH_CALLBACK_PATH,
  SIGN_IN_PATH,
  SIGN_OUT_PATH,
  SIGN_UP_PATH,
} from './lib/auth-routes';

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
 * WHY `getUser()` and not `getSession()`, covered again here because it is the one
 * line most likely to be "simplified" back to the unsafe form: see the identical
 * comment on `getUser` itself in `src/lib/auth/index.ts`. It verifies the session
 * against the auth server rather than trusting whatever the cookie claims.
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
  context.locals.user = context.isPrerendered
    ? null
    : await getUser({ cookies: context.cookies, request: context.request });

  const response = await next();

  if (
    !context.isPrerendered &&
    (context.locals.user !== null || isAuthRoute(context.url.pathname))
  ) {
    response.headers.set('Cache-Control', 'private, no-store');
  }

  return response;
});
