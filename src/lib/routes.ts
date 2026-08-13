/**
 * The site's two front doors, and the one function that decides which of them a visitor
 * gets — on the same dependency-free footing as `src/lib/auth-routes.ts` and
 * `src/lib/gear/routes.ts`, and for the same reason: `src/pages/index.astro` runs on
 * every request to `/`, and nothing it imports may drag an auth SDK behind it. See
 * `src/lib/auth-routes.ts`'s header for the full argument about why a path constant
 * lives out here rather than inside the choke point.
 *
 * WHAT CHANGED AND WHY. `/` was the landing page: a prerendered file, identical for
 * everybody, with a "Sign in" link in the corner. That produced a journey with a dead end
 * in it — sign in, land on the closet, click the wordmark, and you were back on the
 * anonymous marketing page with a "Sign in" link, apparently signed out, with no route
 * back to your own gear but signing in a second time. The wordmark was not broken; `/`
 * simply had no way to know who was asking, because a static file cannot.
 *
 * So `/` is now a router with no markup of its own, the landing page has moved to
 * `WELCOME_PATH`, and the rule is the ordinary one people expect: while you are signed
 * in, you are signed in, and `/` is your own home rather than a stranger's.
 *
 * WHAT THIS COSTS, stated here because it is a real trade and not a free win. `/` can no
 * longer be a prerendered, edge-cached file — it varies by session, so `src/middleware.ts`
 * marks it `no-store` and Cloudflare must invoke the Worker for every visit. Two things
 * hold the bill down. `src/lib/session-cookie.ts` keeps an anonymous visit from making an
 * auth-server round trip, so the common case is a cookie header scan and a 302. And
 * `WELCOME_PATH` — the page that actually has content worth caching, and the one a
 * search engine indexes — stays prerendered exactly as `/` used to be. The redirect hop
 * is the price, and it is paid by anonymous visitors to `/` only.
 */

import { GEAR_PATH } from './gear/routes';

/** The site root. A router since this ticket, not a page: see `homeDestination`. */
export const HOME_PATH = '/';

/**
 * The landing page — what `/` used to serve, at a URL of its own so it can go on being a
 * prerendered file while `/` cannot.
 *
 * `/welcome` and not `/home`, `/start` or `/about`: it is the page a visitor who is not
 * signed in is welcomed by, and it must not read as somewhere a SIGNED-IN person would
 * also want to go — the entire point of the change is that a signed-in person has their
 * own home and this is not it.
 *
 * NOTE FOR LAUNCH, because it is invisible until it matters: this is now the canonical
 * marketing URL. `@astrojs/sitemap` emits prerendered routes only, so the sitemap will
 * list `/welcome` and not `/`, and a link to `packsheet.io` costs a stranger a 302 hop
 * before they see any content. Harmless today — `src/pages/robots.txt.ts` disallows
 * everything outside production — but it is a deliberate consequence to weigh again
 * before the site is indexed, not an oversight.
 */
export const WELCOME_PATH = '/welcome';

/**
 * Where `/` sends this visitor.
 *
 * Takes a boolean rather than a `User` on purpose: it makes the function pure over a
 * value with two states, testable without a Supabase type anywhere near it, and — the
 * reason that matters here — leaves this module with no import edge into `src/lib/auth/`
 * for `tests/anonymous-read-path.test.ts` to object to. The caller already has the
 * answer; `src/middleware.ts` resolved it once for the whole request.
 *
 * MUST NEVER RETURN `HOME_PATH`. `src/pages/index.astro` redirects to whatever this
 * returns, so a `HOME_PATH` on either arm is a redirect loop — `/` sending the browser to
 * `/` until it refuses to follow any further. That reads as the site being down rather
 * than as a routing bug, which is why tests/home-routing.test.ts asserts it directly for
 * both arms rather than trusting the two returns below to be read carefully.
 *
 * This is also the single place that answers "what is a signed-in person's home?". When
 * the dashboard stops being the gear closet, this line is the edit — which is why the
 * post-sign-in default in `safeNextPath` is `HOME_PATH` and not `GEAR_PATH`: every
 * journey that ends "and then send them home" routes through here rather than each
 * naming a destination it would then have to be remembered to update.
 */
export function homeDestination(signedIn: boolean): string {
  return signedIn ? GEAR_PATH : WELCOME_PATH;
}
