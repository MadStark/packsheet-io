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
 * Every path this middleware treats as "an auth route" for the caching rule below —
 * not for the user lookup, which runs unconditionally (see the comment on `onRequest`).
 * Listed rather than pattern-matched off a shared `/auth/` or `/account/` prefix,
 * because a future on-demand route that happens to share a prefix (an `/account/`
 * settings sub-page, say) should have to earn its way onto this list rather than
 * inherit the no-store rule by accident of URL shape.
 */
const AUTH_ROUTE_PATHS: readonly string[] = [
  SIGN_IN_PATH,
  SIGN_UP_PATH,
  SIGN_OUT_PATH,
  ACCOUNT_PATH,
  AUTH_CALLBACK_PATH,
];

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
 * one of `AUTH_ROUTE_PATHS` regardless of session state (the sign-in page for a
 * signed-out visitor still must not be cached, because the wrong visitor's CSRF-
 * relevant form state or a stale error message is not a page any other stranger's
 * browser should be shown). A prerendered page's build-time render never sets this
 * header at all — `next()` for it produces the response `astro build` writes to a
 * static file, which Cloudflare's assets binding then serves untouched by this
 * function ever again, and Astro's own asset headers govern its caching instead.
 * `@supabase/ssr` already sets a `Cache-Control` on its own responses for the same
 * reason this block exists; this is the belt to that suspenders — it applies at the
 * Astro response level so it covers every route in `AUTH_ROUTE_PATHS`, not only the
 * ones that happen to touch a Supabase call on every request.
 */
export const onRequest = defineMiddleware(async (context, next) => {
  context.locals.user = context.isPrerendered
    ? null
    : await getUser({ cookies: context.cookies, request: context.request });

  const response = await next();

  if (context.locals.user !== null || isAuthRoute(context.url.pathname)) {
    response.headers.set('Cache-Control', 'private, no-store');
  }

  return response;
});
