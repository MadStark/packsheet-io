/**
 * A cheap, dependency-free "could this request possibly have a session?" check, so that
 * `src/middleware.ts` does not make an auth-server round trip to answer a question the
 * absence of a cookie already settled.
 *
 * WHY IT IS NEEDED NOW. `/` became an on-demand route when it stopped being the landing
 * page and became a router (see `src/lib/routes.ts`). Middleware runs for every on-demand
 * request, and `getUser()` is a network call to Supabase's auth server — so without this,
 * every anonymous visit to the site's FRONT DOOR would wait on that call before being
 * redirected to a landing page it could have been sent to immediately. That is the exact
 * cost `tests/anonymous-read-path.test.ts` exists to keep off this site, arriving through
 * a door that test cannot see: its analysis is about which MODULE ships, not about which
 * call a shipped module makes at run time.
 *
 * WHY IT IS DELIBERATELY IMPRECISE, which is the only thing to understand before editing
 * it. The two ways of being wrong here are not symmetric, so the function is tuned to be
 * wrong in one direction only:
 *
 *   - A FALSE POSITIVE ("maybe" for a request with no session) costs one round trip. The
 *     slow path runs, `getUser()` returns null, and the visitor is treated exactly as
 *     they were before this function existed. Nothing is incorrect; something is merely
 *     no faster.
 *   - A FALSE NEGATIVE ("no" for a request that HAS a session) tells a signed-in person
 *     they are signed out. On `/`, that is the original defect this whole change set out
 *     to fix, reintroduced one layer lower down and harder to see.
 *
 * So this does not try to identify the session cookie. It rules out requests that cannot
 * have one, and lets everything else through to the real check. Any cookie whose NAME
 * begins `sb-` is enough — the exact name is `sb-<project-ref>-auth-token`, but it is also
 * split into `.0`/`.1` chunks whenever the session exceeds the 4 KB cookie limit, and
 * `@supabase/ssr` writes several `-code-verifier` variants alongside it during an OAuth
 * flow. Matching the prefix covers all of them and every future sibling without this file
 * having to track the SDK's naming.
 *
 * THE PREFIX IS THE ONE ASSUMPTION HERE, and it is pinned by a real sign-in rather than
 * by belief: `tests/auth-flow.test.ts` signs in against the local Supabase and asserts
 * that the cookies actually written are recognised by this function. If `@supabase/ssr`
 * ever renames them, that test fails — a hand-written fixture in
 * `tests/session-cookie.test.ts` never would, because it would be renamed alongside the
 * code and go on agreeing with it.
 */

/** The prefix `@supabase/ssr` gives every cookie it writes, from its `storageKey`
 *  default of `sb-<project-ref>-auth-token`. */
const SUPABASE_COOKIE_PREFIX = 'sb-';

/**
 * True when the request carries at least one cookie that could belong to a Supabase
 * session — which means "ask the auth server", never "this visitor is signed in".
 *
 * Takes the raw `Cookie` header rather than an `AstroCookies` for the same reason
 * `src/lib/auth/index.ts` parses that header itself: `AstroCookies` can look a cookie up
 * by a name you already know, but cannot enumerate what is there, and enumeration is
 * exactly what this needs.
 *
 * Splitting on `;` and taking the text before the FIRST `=` mirrors how the `cookie`
 * package — the one `AstroCookies` uses internally — reads a request's cookies. The name
 * is compared, never the value: `header.includes('sb-')` is the obvious one-liner and is
 * wrong, because a value is data a stranger can influence, and this function's answer
 * must not be theirs to set.
 */
export function hasSupabaseAuthCookie(header: string | null | undefined): boolean {
  if (!header) return false;

  return header
    .split(';')
    .some((pair) => pair.trimStart().split('=', 1)[0].startsWith(SUPABASE_COOKIE_PREFIX));
}
