/**
 * A test double for Astro's `AstroCookies`, scoped to exactly what
 * `src/lib/auth/index.ts` calls on it: `set()`. Nothing in that module ever calls
 * `get`, `has`, `delete`, `merge`, `headers()` or `consume()` on the cookies it is
 * handed — it reads incoming cookies straight off the `Cookie` request header instead
 * (see `parseCookieHeader` and the comment on `createAuthClient`) — so a double that
 * only implements `set()` is not a shortcut, it is the whole interface this module
 * actually uses.
 *
 * WHY A DOUBLE AT ALL, RATHER THAN THE REAL THING. `AstroCookies` cannot be built from
 * a plain object typed as one: it declares private (`#`) fields, and TypeScript's
 * structural typing treats a class with private members as effectively nominal — only
 * a real instance (or something built the same way) satisfies the type. Astro's own
 * implementation is not an option to import directly either: `astro/dist/core/cookies/
 * cookies.js` is not on the package's public `package.json#exports` map, so a deep
 * import happens to resolve in this checkout today and is not a promise the package
 * makes to keep resolving after an upgrade. `new FakeAstroCookies()` cast with
 * `asAstroCookies()` below is the honest alternative: build the minimal surface this
 * codebase depends on, and be explicit — in comments a future reader can check against
 * Astro's own source — about every place it could quietly diverge from the real thing.
 *
 * THE WHOLE VALUE OF auth-flow.test.ts RESTS ON THIS FILE BEING FAITHFUL. Every "does a
 * session survive the hop" assertion in that file is only as true as the cookie jar
 * simulated here. Get one browser behaviour wrong and a test can pass while proving
 * nothing — see `asRequestCookieHeader()` below for the two behaviours that matter most
 * and were checked against source rather than assumed.
 */

import type { AstroCookieSetOptions, AstroCookies } from 'astro';

export interface RecordedCookie {
  value: string;
  options: AstroCookieSetOptions | undefined;
}

export class FakeAstroCookies {
  readonly #outgoing = new Map<string, RecordedCookie>();

  /**
   * Matches `AstroCookies#set(key, value, options)` exactly. Real `AstroCookies`
   * stringifies a non-string `value` (see cookies.js's `#ensureOutgoingMap` branch for
   * an object/number/boolean); `@supabase/ssr` only ever calls `setAll` with string
   * values, and `src/lib/auth/index.ts` never calls `.set()` with anything else, so
   * this double narrows the signature to `string` rather than reimplementing that
   * stringification for a case that cannot occur through the module under test.
   */
  set(name: string, value: string, options?: AstroCookieSetOptions): void {
    // A Map, keyed by name, overwritten on repeat calls — the same structure
    // `#ensureOutgoingMap()` uses in cookies.js. A second `.set()` for the same name
    // (e.g. `@supabase/ssr` re-chunking a session across a token refresh) must replace
    // the earlier value for that name, not accumulate two, exactly as it would for a
    // real `Set-Cookie` header the browser re-applies to the same cookie.
    this.#outgoing.set(name, { value, options });
  }

  /** Every cookie this instance recorded `.set()` for, latest write per name. For attribute assertions. */
  entries(): [string, RecordedCookie][] {
    return [...this.#outgoing.entries()];
  }

  /**
   * The `Cookie:` header a browser would send on its NEXT request, after obeying every
   * `Set-Cookie` this instance recorded. Two browser behaviours a naive
   * "just join name=value" join would miss, and that this suite specifically needs
   * faithful:
   *
   *   - A cookie whose `Set-Cookie` carried `maxAge: 0`, or an `expires` already in the
   *     past, is DELETED the instant a browser sees it and is never sent again. This is
   *     exactly how `@supabase/ssr` clears a session on sign-out — both removal paths in
   *     node_modules/@supabase/ssr/dist/main/cookies.js (`removeItem`) and
   *     clearAuthCookiesAtScopes.js set `maxAge: 0` on the cookies they want gone, and
   *     REQUIRED_COOKIE_ATTRIBUTES in src/lib/auth/index.ts is spread in AFTER whatever
   *     `@supabase/ssr` supplies, but it does not set `maxAge` itself, so that `0`
   *     survives untouched. A round trip that ignored expiry would have the sign-out
   *     test in auth-flow.test.ts pass by accident, still carrying the dead session
   *     cookie forward as if a browser had kept it.
   *   - The `Cookie` header carries `name=value` pairs only, never attributes.
   *     `httpOnly` / `sameSite` / `path` / `secure` govern when and to whom the BROWSER
   *     sends the cookie; they are never echoed back on the wire, which is exactly why
   *     the cookie-attributes test in auth-flow.test.ts reads them off `entries()`
   *     instead — there is nowhere else they could be read from at this layer.
   *
   * ENCODING. Real `AstroCookies.set()` serialises through the `cookie` package's
   * `stringifySetCookie`, whose default encoder leaves RFC 6265-safe bytes alone and
   * percent-encodes the rest; the production `parseCookieHeader` in
   * src/lib/auth/index.ts always decodes with plain `decodeURIComponent`, regardless of
   * which encoder produced the value. `encodeURIComponent` here percent-encodes a
   * strict SUPERSET of what the real encoder would touch, and `decodeURIComponent`
   * inverts either output identically — so this header round-trips through the exact
   * decode function the production code runs, which is the honesty this helper commits
   * to. It is not a reimplementation of `stringifySetCookie`, and does not need to be:
   * nothing here asserts the literal bytes of a `Set-Cookie` header, only that whatever
   * this double serialises comes back out the other side the way the real parser reads it.
   */
  asRequestCookieHeader(): string {
    const parts: string[] = [];
    for (const [name, { value, options }] of this.#outgoing) {
      const deleted =
        options?.maxAge === 0 ||
        (options?.expires !== undefined && options.expires.getTime() <= Date.now());
      if (deleted) continue;
      parts.push(`${name}=${encodeURIComponent(value)}`);
    }
    return parts.join('; ');
  }
}

/**
 * The cast every caller needs: `FakeAstroCookies` is a deliberately different class
 * from `AstroCookies` (see the file header for why a real one cannot be built from a
 * plain object), so it can never be a structural match — going through `unknown` is
 * the honest way to say "this satisfies the parts of the interface this codebase
 * actually calls", not an accident of a loose type.
 */
export function asAstroCookies(cookies: FakeAstroCookies): AstroCookies {
  return cookies as unknown as AstroCookies;
}

/**
 * A real `Request`, carrying the given `Cookie` header — the same object every Astro
 * route and this module's exported functions are handed, built without standing up a
 * server. An empty `cookieHeader` omits the header entirely rather than sending
 * `cookie: ""`, matching a first-time visitor who has never had a cookie set.
 */
export function requestWithCookies(
  cookieHeader: string,
  init: { method?: string; url?: string } = {},
): Request {
  const headers = new Headers();
  if (cookieHeader) headers.set('cookie', cookieHeader);
  return new Request(init.url ?? 'http://localhost:4321/', {
    method: init.method ?? 'GET',
    headers,
  });
}
