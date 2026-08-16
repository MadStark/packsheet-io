/**
 * `hasSupabaseAuthCookie` — the cheap "is it even worth asking?" check that keeps
 * `src/middleware.ts` from making an auth-server round trip for a visitor who plainly
 * has no session.
 *
 * WHY THIS EXISTS AT ALL. `/` used to be a prerendered file, so an anonymous visit to
 * the site's front door cost nothing: no Worker, no `getUser()`, one cached response for
 * everybody. Making `/` session-aware ends that — it is on-demand now, and without this
 * check every anonymous visit would send a request to Supabase's auth server and wait
 * for it, purely to be told what the absence of a cookie already said, before issuing a
 * 302 to the landing page. On the front door of a site whose entire architecture is
 * organised around not paying auth costs on the anonymous read path (see
 * tests/anonymous-read-path.test.ts, and the LATENCY and CACHE-ABILITY arguments in its
 * header), that is the wrong default to ship.
 *
 * WHICH DIRECTION IT IS ALLOWED TO BE WRONG IN, which is the whole design of the
 * function and the reason the cases below are lopsided. A false POSITIVE — saying "maybe"
 * for a request with no real session — costs one round trip and nothing else: the slow
 * path runs, `getUser()` returns null, and the visitor is treated exactly as before. A
 * false NEGATIVE is a signed-in person told they are signed out, on the front door, with
 * no error anywhere. So the check is deliberately broad: any cookie whose NAME begins
 * `sb-` is enough to fall through to the real check. It is not trying to identify the
 * session cookie; it is trying to rule out requests that cannot possibly have one.
 *
 * WHAT PINS THE `sb-` ASSUMPTION. Not this file — every case here is hand-written, so
 * they would all keep passing if `@supabase/ssr` renamed its cookies tomorrow, and the
 * failure would be silent in the one direction that matters. tests/auth-flow.test.ts
 * closes that: it performs a REAL sign-in against the local Supabase and asserts that the
 * cookies it actually wrote are recognised here. This file pins the parsing; that one
 * pins the premise.
 */

import { describe, expect, it } from 'vitest';
import { hasSupabaseAuthCookie } from '../src/lib/session-cookie';

/** A realistic cookie name for a project ref, as `@supabase/ssr` builds it from its
 *  `storageKey` default of `sb-<project-ref>-auth-token`. */
const AUTH_COOKIE = 'sb-lkqwertyuiopasdfghjk-auth-token';

describe('requests that cannot have a session', () => {
  it.each([
    ['no Cookie header at all', null],
    ['a header this request did not carry', undefined],
    ['an empty header', ''],
    ['whitespace only', '   '],
    ['a single unrelated cookie', 'theme=dark'],
    ['several unrelated cookies', 'theme=dark; locale=en-GB; consent=1'],
    ['a stray separator', ';'],
    ['a cookie with no value', 'theme='],
  ])('answers no for %s', (_label, header) => {
    expect(hasSupabaseAuthCookie(header)).toBe(false);
  });

  /**
   * The prefix is matched against the cookie's NAME, not against the header text. A
   * check written as `header.includes('sb-')` — which is the obvious one-liner, and
   * passes every case above — would let any visitor turn the fast path off for
   * themselves by putting `sb-` in a value the site sets, and more importantly would
   * make this function's answer depend on data a stranger controls.
   */
  it.each([
    ['a value that merely contains the prefix', `theme=${AUTH_COOKIE}`],
    ['a value quoted around it', `analytics="sb-x-auth-token"`],
    ['the prefix appearing after the name', `id=1; note=see sb-foo-auth-token`],
  ])('does not mistake %s for a session', (_label, header) => {
    expect(hasSupabaseAuthCookie(header)).toBe(false);
  });

  // `sb-` has to START the name. A cookie called `mysb-thing` is somebody else's.
  it('requires the prefix at the start of the name', () => {
    expect(hasSupabaseAuthCookie('xsb-lk-auth-token=abc')).toBe(false);
    expect(hasSupabaseAuthCookie('my_sb-lk-auth-token=abc')).toBe(false);
  });
});

describe('requests that might have one', () => {
  it('answers yes for the session cookie itself', () => {
    expect(hasSupabaseAuthCookie(`${AUTH_COOKIE}=base64-payload`)).toBe(true);
  });

  /**
   * The chunked form, which is the everyday shape rather than an edge case: a session
   * carrying a provider token routinely exceeds the 4 KB per-cookie limit, and
   * `@supabase/ssr` splits it into `<name>.0`, `<name>.1` and so on — at which point the
   * unchunked name is not present on the request at all. A check written against the
   * exact name `sb-<ref>-auth-token` would answer "no session" for precisely the
   * longest-lived, most-signed-in visitors.
   */
  it.each([
    ['the first chunk', `${AUTH_COOKIE}.0=part-one`],
    ['a later chunk', `${AUTH_COOKIE}.1=part-two`],
    ['both chunks', `${AUTH_COOKIE}.0=part-one; ${AUTH_COOKIE}.1=part-two`],
  ])('answers yes for %s', (_label, header) => {
    expect(hasSupabaseAuthCookie(header)).toBe(true);
  });

  /**
   * Mid-OAuth cookies count too, and that is the false-positive direction being chosen
   * on purpose. `sb-<ref>-auth-token-code-verifier` is written when a visitor leaves for
   * Google and is still there when they come back; treating it as "maybe" costs one round
   * trip on a journey that is about to sign somebody in anyway.
   */
  it('answers yes for a PKCE code-verifier cookie', () => {
    expect(hasSupabaseAuthCookie(`${AUTH_COOKIE}-code-verifier=v`)).toBe(true);
  });

  it.each([
    ['first', `${AUTH_COOKIE}=abc; theme=dark`],
    ['last', `theme=dark; ${AUTH_COOKIE}=abc`],
    ['in the middle', `theme=dark; ${AUTH_COOKIE}=abc; locale=en-GB`],
  ])('finds it when it appears %s among other cookies', (_label, header) => {
    expect(hasSupabaseAuthCookie(header)).toBe(true);
  });

  // Browsers send `; ` between pairs, but the separator's spacing is not guaranteed by
  // anything this code controls, and a proxy that re-serialised the header without
  // spaces must not sign everybody out.
  it.each([
    ['no space after the separator', `theme=dark;${AUTH_COOKIE}=abc`],
    ['extra spaces', `theme=dark;   ${AUTH_COOKIE}=abc`],
    ['a trailing separator', `${AUTH_COOKIE}=abc;`],
    ['a tab', `theme=dark;\t${AUTH_COOKIE}=abc`],
  ])('tolerates %s', (_label, header) => {
    expect(hasSupabaseAuthCookie(header)).toBe(true);
  });
});
