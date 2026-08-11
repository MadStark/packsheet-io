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

function contextFor(pathname: string, { isPrerendered = false } = {}): Context {
  const url = new URL(pathname, 'https://packsheet.io');
  return {
    locals: { user: null },
    isPrerendered,
    url,
    cookies: { marker: 'the AstroCookies for this request' },
    request: new Request(url),
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

describe('the no-edge-cache rule', () => {
  const cacheControl = async (context: Context) =>
    (await run(context)).headers.get('cache-control');

  /**
   * A response that depends on who is asking must never become one cached response every
   * reader shares. This is the arm that covers a page which is not an auth route at all —
   * any future page that adapts to a signed-in visitor gets it without being listed
   * anywhere.
   */
  it('marks a signed-in response private and uncacheable, on any path', async () => {
    getUser.mockResolvedValue(SIGNED_IN);
    expect(await cacheControl(contextFor('/'))).toBe('private, no-store');
    expect(await cacheControl(contextFor('/some/future/page'))).toBe('private, no-store');
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
  ])('marks %s uncacheable even with no session', async (_label, path) => {
    expect(await cacheControl(contextFor(path))).toBe('private, no-store');
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
    expect(await cacheControl(contextFor('/'))).toBeNull();
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
