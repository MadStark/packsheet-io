/**
 * `src/middleware.ts` — the two rules it exists for, neither of which had a test.
 *
 * It is one of the six modules on AUTH_CONSUMERS, it runs ahead of EVERY route this site
 * serves, and until this file the only thing pinning either of its behaviours was the
 * comment describing them. That is worse here than in most places, because both failures
 * are silent:
 *
 *   - `Cache-Control: private, no-store` is what stops a response that depends on WHO IS
 *     ASKING from being handed to Cloudflare's edge cache and served to somebody else.
 *     Delete the header and every test in this repository stays green, the site works
 *     perfectly for one visitor at a time, and the defect appears only as a stranger
 *     seeing an account page that is not theirs. Nothing in a local run can produce that.
 *   - `context.isPrerendered` is what stops `getUser()` — an auth-server round trip — from
 *     running during the build-time render of every static page. Its absence DID break
 *     the build once (`npm run build` failing with `PUBLIC_SUPABASE_URL is not set` while
 *     prerendering robots.txt, which has nothing to do with Supabase), so that half at
 *     least fails loudly — but only while the environment happens to be unconfigured. Set
 *     the variables and the same mistake becomes an auth call on the anonymous read path,
 *     which is the thing tests/anonymous-read-path.test.ts exists for and cannot see: its
 *     build-graph analysis is about which MODULE ships, not about which RENDER a shipped
 *     module performs.
 *
 * HOW THIS IS DRIVEN. `onRequest` is an ordinary async function of `(context, next)`, so
 * it is called directly with a hand-built context rather than through a server. Only the
 * properties it actually reads are supplied — `locals`, `isPrerendered` and `url`, which
 * it branches on, plus the `cookies` and `request` it forwards untouched — and `getUser`
 * is mocked, because what is under test is the branching, not Supabase. The real `getUser` has its own end-to-end coverage in
 * tests/auth-flow.test.ts; mocking it here is what lets a signed-in request be expressed
 * as a fact rather than as a sign-up.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@supabase/supabase-js';
import { ACCOUNT_PATH, AUTH_CALLBACK_PATH, SIGN_IN_PATH } from '../src/lib/auth-routes';
import { HOME_PATH } from '../src/lib/routes';

// Hoisted by vitest above the import below, which is why `getUser` is declared through
// `vi.hoisted` rather than as an ordinary const: the factory runs before module scope.
const { getUser } = vi.hoisted(() => ({ getUser: vi.fn() }));
vi.mock('../src/lib/auth', () => ({ getUser }));

const { onRequest } = await import('../src/middleware');

const SIGNED_IN = { id: 'user-1', email: 'someone@packsheet.test' } as unknown as User;

interface Context {
  locals: { user: User | null };
  isPrerendered: boolean;
  url: URL;
  cookies: unknown;
  request: Request;
}

/** A cookie header of the shape a signed-in visitor's browser sends. Supplied by DEFAULT
 *  below, because every test in this file that predates the fast path is about the
 *  `isPrerendered` gate or the caching rule — none of them is about cookie presence, and
 *  all of them mean "a request the middleware has reason to look up". The requests with
 *  no cookie are the new ones, and they say so explicitly. */
const SESSION_COOKIE = 'sb-lkqwertyuiopasdfghjk-auth-token=payload';

function contextFor(
  pathname: string,
  { isPrerendered = false, cookie = SESSION_COOKIE as string | null } = {},
): Context {
  const url = new URL(pathname, 'https://packsheet.io');
  return {
    locals: { user: null },
    isPrerendered,
    url,
    cookies: { marker: 'the AstroCookies for this request' },
    request: new Request(url, cookie === null ? undefined : { headers: { cookie } }),
  };
}

/** `next()` as Astro supplies it: a function returning the response the route rendered.
 *  A fresh `Response` per call, because the middleware MUTATES its headers. */
const next = () => Promise.resolve(new Response('<html></html>', { status: 200 }));

/** The middleware as this file calls it. The real `APIContext` has dozens of members
 *  this middleware never touches, and building one would be a fixture whose only purpose
 *  is to satisfy a type — so the cast is to the shape actually invoked, and WHICH members
 *  it reads is asserted below rather than declared here. */
type Handler = (context: Context, next: () => Promise<Response>) => Promise<Response>;
const handler = onRequest as unknown as Handler;

const run = (context: Context) => handler(context, next);

beforeEach(() => {
  getUser.mockReset();
  getUser.mockResolvedValue(null);
});

describe('resolving the user', () => {
  it('resolves it once per request into locals, from the request’s own cookies', async () => {
    getUser.mockResolvedValue(SIGNED_IN);
    const context = contextFor('/');

    await run(context);

    expect(context.locals.user).toBe(SIGNED_IN);
    // Once, not once per consumer: doing it here is the whole reason
    // src/pages/account/index.astro reads `Astro.locals.user` rather than asking again.
    expect(getUser).toHaveBeenCalledTimes(1);
    // With THIS request's cookies and THIS request — a middleware that built its own, or
    // reused something module-scoped, would answer one visitor's question with another's
    // session.
    expect(getUser).toHaveBeenCalledWith({
      cookies: context.cookies,
      request: context.request,
    });
  });

  it('records a null user when there is no session, rather than leaving locals unset', async () => {
    const context = contextFor('/');
    await run(context);
    // `null` and not `undefined`: pages branch on it, and `undefined` is what an
    // unassigned property looks like too.
    expect(context.locals.user).toBeNull();
  });

  /**
   * The gate that broke `npm run build`, and the reason it is `isPrerendered` rather than
   * a path list.
   *
   * Astro runs middleware for a PRERENDERED page's build-time render as well as for a
   * live request — generating the static HTML goes through the same request pipeline. An
   * earlier version called `getUser()` unconditionally, so every `npm run build` demanded
   * Supabase credentials in order to prerender robots.txt.
   *
   * Asserted as "not called AT ALL", not as "returned null". A version that called it and
   * discarded the result would still pay the round trip, still fail a build with no
   * credentials, and still be an auth call on the anonymous read path — while passing any
   * assertion written about `locals.user`.
   */
  it('never calls the auth server during a prerendered page’s build-time render', async () => {
    const context = contextFor('/', { isPrerendered: true });

    await run(context);

    expect(getUser).not.toHaveBeenCalled();
    expect(context.locals.user).toBeNull();
  });

  // The gate is about the RENDER, not about the route, so it applies to a prerendered
  // render of any path — including one on the auth list, which is what a route changing
  // to `prerender = true` would produce.
  it('applies that gate by render and not by path', async () => {
    await run(contextFor(SIGN_IN_PATH, { isPrerendered: true }));
    expect(getUser).not.toHaveBeenCalled();
  });
});

/**
 * The second gate: a request carrying no Supabase cookie is answered without asking the
 * auth server.
 *
 * This is not an optimisation in search of a problem. `/` became an on-demand route when
 * it stopped being a static landing page, so this middleware now runs for every stranger
 * and every crawler that opens the site's front door, and the answer for all of them is a
 * 302 to `/welcome`. Without this gate each of those visits would wait on a network call
 * to Supabase first. See src/lib/session-cookie.ts for why the check is deliberately
 * broad and which way it is tuned to be wrong.
 */
describe('the no-cookie fast path', () => {
  /**
   * Asserted as "not called AT ALL", for the same reason the prerender gate above is: a
   * version that called `getUser()` and discarded the result would still pay the round
   * trip this exists to avoid, while passing any assertion written about `locals.user`.
   */
  it.each([
    ['no Cookie header at all', null],
    ['an empty one', ''],
    ['only cookies belonging to something else', 'theme=dark; locale=en-GB'],
  ])('does not call the auth server for a request with %s', async (_label, cookie) => {
    const context = contextFor(HOME_PATH, { cookie });

    await run(context);

    expect(getUser).not.toHaveBeenCalled();
    // `null`, not `undefined` — pages branch on it, and the fast path must produce the
    // same value the slow path would have produced for the same request.
    expect(context.locals.user).toBeNull();
  });

  /**
   * The direction this must not be wrong in. A signed-in visitor whose request carries a
   * Supabase cookie has to reach the real check, whatever else is on the header and
   * whatever shape the cookie is in — the chunked form is what a long-lived session
   * actually looks like, and skipping it would sign those visitors out on the front door
   * with no error anywhere.
   */
  it.each([
    ['the session cookie alone', 'sb-lkqwertyuiopasdfghjk-auth-token=payload'],
    ['it alongside others', 'theme=dark; sb-lkqwertyuiopasdfghjk-auth-token=payload'],
    ['the chunked form', 'sb-lkqwertyuiopasdfghjk-auth-token.0=part; theme=dark'],
  ])('still asks the auth server when the request carries %s', async (_label, cookie) => {
    getUser.mockResolvedValue(SIGNED_IN);
    const context = contextFor(HOME_PATH, { cookie });

    await run(context);

    expect(getUser).toHaveBeenCalledTimes(1);
    expect(context.locals.user).toBe(SIGNED_IN);
  });

  /**
   * The gate decides whether to ASK, never what the answer is. A cookie that merely looks
   * like a session — forged, expired, or left behind by a revoked one — must still be
   * refused by the auth server rather than by this middleware, which is the difference
   * between a cheap pre-filter and an authorization decision made on the cookie's say-so.
   */
  it('never treats the presence of a cookie as a session', async () => {
    getUser.mockResolvedValue(null);
    const context = contextFor(ACCOUNT_PATH, { cookie: 'sb-anything-auth-token=forged' });

    await run(context);

    expect(getUser).toHaveBeenCalledTimes(1);
    expect(context.locals.user).toBeNull();
  });
});

describe('the no-edge-cache rule', () => {
  const cacheControl = async (context: Context) =>
    (await run(context)).headers.get('cache-control');

  /**
   * A response that depends on who is asking must never become one cached response every
   * reader shares. This is the arm that covers a page which is not an auth route at all —
   * any future page that adapts to a signed-in visitor gets it without being listed
   * anywhere.
   */
  // Both paths here are deliberately NOT on AUTH_ROUTE_PATHS, so this arm keeps testing
  // what it is named for. Using `/` would have made it pass on the strength of the list
  // instead, and stop saying anything about a signed-in response on an unlisted page.
  it('marks a signed-in response private and uncacheable, on any path', async () => {
    getUser.mockResolvedValue(SIGNED_IN);
    expect(await cacheControl(contextFor('/some/future/page'))).toBe('private, no-store');
    expect(await cacheControl(contextFor('/some/shared/pack'))).toBe('private, no-store');
  });

  /**
   * And the other arm: an auth route for a visitor with NO session. The sign-in page a
   * stranger is served still must not be cached — a stale error message, or form state
   * from somebody else's failed attempt, is not a page to hand to the next stranger.
   */
  it.each([
    ['the sign-in page', SIGN_IN_PATH],
    ['the account page', ACCOUNT_PATH],
    ['the OAuth callback', AUTH_CALLBACK_PATH],
    // `/` earns its place here by being a router rather than a page: its whole response
    // is a 302 whose Location depends on the session, and a 302 is precisely what a
    // shared cache is happiest to keep. One cached copy would pin every later visitor to
    // whichever answer the first one got.
    ['the site root', HOME_PATH],
  ])('marks %s uncacheable even with no session', async (_label, path) => {
    expect(await cacheControl(contextFor(path))).toBe('private, no-store');
  });

  /**
   * And the half of that which is easy to lose: `/` is on the list, and nothing BENEATH
   * it is. `HOME_PATH` is `'/'`, so the sub-path arm of `isAuthRoute` tests
   * `startsWith('//')` — which nothing matches — and the entry degenerates to an exact
   * match. Were that ever to change, every public page on the site would silently become
   * uncacheable and the assertion below is the only thing that would say so.
   */
  it('does not extend the site root’s rule to every path under it', async () => {
    expect(await cacheControl(contextFor('/pack/some-shared-pack'))).toBeNull();
    expect(await cacheControl(contextFor('/welcome'))).toBeNull();
  });

  // Sub-paths inherit, which is the behaviour AUTH_ROUTE_PATHS' own comment argues for:
  // the forgettable route is exactly the one that matters, and over-applying no-store
  // costs a session-shaped page its edge cacheability while under-applying it serves one
  // visitor's data to another.
  it('marks a sub-path of an auth route uncacheable too', async () => {
    expect(await cacheControl(contextFor(`${ACCOUNT_PATH}/settings`))).toBe('private, no-store');
  });

  // The separator is load-bearing. As a bare string prefix, `/accountant` inherits
  // `/account`'s rule — harmless for caching, and the same bug that is not harmless where
  // the auth choke-point check makes the identical comparison.
  it('does not treat a path that merely starts with an auth route as one', async () => {
    expect(await cacheControl(contextFor('/accountant'))).toBeNull();
  });

  /**
   * The other half of "not vacuous", and the assertion that fails if the rule ever becomes
   * unconditional: the anonymous read path — a stranger, on a page that is nobody's
   * account — must keep NO cache header from this middleware at all, so the edge can serve
   * one cached copy to everybody. A middleware that set `no-store` on everything would
   * pass every assertion above and quietly cost this site the property its whole
   * architecture is built around.
   */
  it('leaves an anonymous response on a public page untouched', async () => {
    // `/` used to be the example here, and is not any more: it is a session-dependent
    // router now and belongs on the list above. The landing page it redirects to is what
    // inherited the property this assertion is about — a prerendered file, identical for
    // everybody, which the edge should serve to everybody from one copy.
    expect(await cacheControl(contextFor('/welcome'))).toBeNull();
    expect(await cacheControl(contextFor('/some/shared/pack'))).toBeNull();
  });

  // A prerendered render's response is written to a static file and served by the assets
  // binding, which never invokes this middleware again; Astro's own asset headers govern
  // it. Setting no-store on it would bake a header into a file that is, by construction,
  // the same for everybody.
  it('sets nothing during a prerendered render', async () => {
    expect(await cacheControl(contextFor('/', { isPrerendered: true }))).toBeNull();
    expect(await cacheControl(contextFor(SIGN_IN_PATH, { isPrerendered: true }))).toBeNull();
  });

  // The route's own response is returned, headers added rather than replaced — a
  // middleware that built a fresh Response would drop everything the page set, including
  // a redirect's Location.
  it('returns the route’s own response rather than a new one', async () => {
    const redirect = new Response(null, { status: 302, headers: { location: SIGN_IN_PATH } });
    const context = contextFor(ACCOUNT_PATH);

    const response = await handler(context, () => Promise.resolve(redirect));

    expect(response).toBe(redirect);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(SIGN_IN_PATH);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });
});
