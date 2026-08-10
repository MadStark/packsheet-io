/**
 * The auth choke point.
 *
 * This module is the ONLY place in the codebase that is allowed to import or
 * re-export an authentication SDK. Every other module — every page, every layout,
 * every component, middleware in either spelling Astro accepts (`src/middleware.ts`
 * or `src/middleware/index.ts`) if one is ever added — must reach it by going
 * through here.
 *
 * Why this matters more than the usual "keep your SDK usage in one place" advice:
 * auth providers price by monthly active user, not by request or by compute. This
 * site's entire traffic model is the opposite of what that pricing assumes — most
 * visitors are strangers who click a shared pack-list link from Reddit and never sign
 * in. If the auth SDK were invoked on that path, every one of those anonymous reads
 * would count as a MAU.
 *
 * `tests/anonymous-read-path.test.ts` enforces this at build time: it builds the
 * real site, walks the resulting module graph, and fails if a module outside this
 * directory imports anything inside it — an edge rule, not a "can an anonymous route
 * reach it" rule, because a `client:only` island's import is dropped from the server
 * module and no route-rooted walk can see it.
 *
 * "A module outside this directory" and not "any module": the modules genuinely entitled
 * to import auth are enumerated, one line each with a comment, in AUTH_CONSUMERS in that
 * test file. Everything not on that list fails exactly as everything did before the list
 * existed. Being on it is not a favour granted to a file that wants convenience — it is a
 * claim that the module authenticates somebody AND never reaches a browser, and the second
 * half is checked rather than trusted: a companion rule (Invariant D) fails the build if
 * anything on that list, or anything in this directory, turns up in the client Rollup
 * pass. That is what keeps the list from being a hole. Whatever ends up on it, the auth
 * SDK cannot be served to a visitor, because a module served to a visitor is one the
 * client pass transformed and that rule reports it.
 *
 * It separately fails if `@clerk/*` is imported by ANY module in that graph other than
 * one in this directory — not merely by a first-party module under src/. That scoping
 * is deliberate and was a real hole: `npx astro add @clerk/astro` wires the SDK in
 * through astro.config.mjs and integration-injected middleware, touching no file under
 * src/ at all, so a first-party-scoped rule waves the documented installation straight
 * through. What the module graph cannot see, and what no rule there will ever catch,
 * is an SDK loaded over a `<script src="https://...">` tag or vendored into public/ —
 * that has its own, separate assertion in the same file. Don't delete any of it to
 * make a build go green; read the comment at the top of the test first.
 *
 * ---------------------------------------------------------------------------
 * WHAT CHANGED WITH SUPABASE (Ref 48), AND WHAT NOW GUARDS THE KEY (Ref 55)
 * ---------------------------------------------------------------------------
 *
 * Authentication is Supabase Auth, not Clerk. Clerk was never installed, and the
 * `@clerk/*` assertion stays exactly as it is: it costs nothing and it keeps a
 * provider that has been decided against from arriving by accident.
 *
 * But the rule does NOT simply transfer by swapping the package name, and reading it
 * that way would break the site:
 *
 *   - `@supabase/supabase-js` and `@supabase/ssr` BELONG on the anonymous read path.
 *     Anonymous reads go through PostgREST with the publishable `anon` key, and
 *     row-level security restricts them to public rows. Supabase does not meter
 *     anonymous reads at all, and Auth is $0.00325/MAU. The $6,000/month cliff that
 *     justified banning the SDK outright does not exist here.
 *
 *   - What replaces it is narrower and sharper. The `anon` key is public by design
 *     and safe to ship. `SUPABASE_SERVICE_ROLE_KEY` **bypasses row-level security
 *     entirely** — it is not a stronger key, it is the absence of the authorization
 *     boundary. It must never be reachable from a route an anonymous visitor can
 *     load, because there the database stops being the thing that says no.
 *
 * That second rule is now enforced, in the same test, as Invariant C: the build fails
 * if ANY module in the graph outside this directory so much as names a privileged key —
 * `SUPABASE_SERVICE_ROLE_KEY`, the same name without its prefix, `SUPABASE_SECRET_KEY`,
 * or a pasted `sb_secret_…` value. It is a rule about the key and not about the package.
 * Both Supabase packages are installed now (Ref 49, this file) — `@supabase/supabase-js`
 * at 2.112.2 and `@supabase/ssr` at 0.12.4 — and confirm what was only hoped when the
 * fixture was written: neither contains the string SERVICE_ROLE anywhere, so landing
 * them did not turn the build red. A page that reads `PUBLIC_SUPABASE_URL` and
 * `PUBLIC_SUPABASE_ANON_KEY` and names Supabase in its own copy is still not flagged,
 * and must never become flagged — those two are the public half of the pair this
 * invariant exists to keep separate. The whole build graph is in scope, not just
 * first-party code, for the same reason Invariant B is: a dependency holding the key
 * ships it exactly as our own code would.
 *
 * This directory is the one exemption, which makes it the only place a service-role
 * client could live. It does not hold one, and the intention is that it never does — see
 * `deleteOwnAccount` below for the pattern that removes the reason to want one. If that
 * ever changes, the client goes here and every route that needs privileged data reaches it
 * through this module rather than reading the key itself.
 *
 * READ THIS BEFORE ACTING ON THE PARAGRAPH ABOVE, because it used to say something
 * stronger and the change is worth knowing. Importing this directory from a route was once
 * a build failure with no exceptions — Invariant A was unconditional — so the paragraph
 * above described a destination rather than a thing that could be done. PK-19 changed
 * that: a route may import this module by being named in AUTH_CONSUMERS in
 * tests/anonymous-read-path.test.ts, one line with a comment saying what it does with
 * auth, provided it is server-only. So "reach it through this module" is now literally how
 * it works, and the failure a reader hits is about the allowlist rather than a dead end.
 *
 * What has NOT changed is the answer for a privileged key specifically, and it is not "add
 * an allowlist entry and read the key". This project holds no service-role key at all —
 * see `deleteOwnAccount` below for the pattern that replaces one, a `SECURITY DEFINER`
 * Postgres function that checks `auth.uid()` itself and gets the same guarantee from the
 * database with no elevated credential existing anywhere. Reach for that first. The
 * allowlist is for routes that authenticate a person, not for widening what this directory
 * is allowed to contain.
 *
 * Three limits of that check, so the green build is not read as more than it is.
 *
 * It reads source text, so a name assembled at runtime (`env[segments.join('_')]`) is
 * invisible to it — closing that means evaluating the program. And for the same reason it
 * cannot tell code from a comment: naming the variable in a comment fails the build
 * exactly as an assignment does. This file may spell it out because this directory is
 * exempt; anywhere else, describe the key rather than naming it.
 *
 * And it is NAME-BOUND. It knows the spellings listed in PRIVILEGED_KEY_PATTERNS in that
 * test file and no others, and this project has not yet chosen the name its secret will
 * ship under — there is no Supabase entry in .env.example and no such secret in
 * wrangler.jsonc. Whoever adds one must check the name against that list and add it if it
 * is missing. A name-bound rule that does not know the name in use is not a weaker
 * guardrail; it is a permanently green one, while the key ships.
 *
 * The corollary of an edge rule, and the thing to get right when adding files here:
 * this directory must contain NOTHING that an anonymous route could legitimately
 * want. A pure-types `types.ts`, or a shared `SIGN_IN_PATH` constant that a nav
 * component imports to render a link, would ship zero auth code and still fail CI
 * with a $6,000 message — the kind of false positive that gets a guardrail weakened
 * or deleted rather than obeyed. Shared auth-adjacent *types* and *constants* belong
 * somewhere an anonymous route may import from (src/lib/auth-routes.ts already exists
 * for exactly the path constants, or the consuming module itself). What lives here is
 * only what must never be reachable: the SDK and the code that calls it.
 *
 * The allowlist does not soften that corollary, and reading it as an escape hatch would
 * get the trade backwards. An anonymous nav bar that wants `SIGN_IN_PATH` could in
 * principle be allowlisted; it should not be. Every entry is a module that may then import
 * anything in here, so an entry granted for a string is an entry that would still be there
 * the day somebody adds a real auth call two lines below it. The list is meant to hold
 * routes that authenticate people, and to stay short enough that all of it can be read at
 * once.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE NOW EXPORTS
 * ---------------------------------------------------------------------------
 *
 * The SDK is installed and this file is its only caller, which is what keeps Invariant
 * A meaningful rather than aspirational: everything below reaches Supabase through
 * `createServerClient`, and nothing outside this directory reaches any of it except
 * through the functions exported here — and, today, nothing outside this directory
 * reaches them at all, because AUTH_CONSUMERS is still empty and the routes that will
 * use these functions are a later task's. The API is
 * deliberately thin: build a request-scoped client, perform one auth operation, hand
 * back a result. Nothing here accumulates state across requests, and nothing here is a
 * place to grow a second, parallel copy of what `@supabase/supabase-js` already does.
 *
 * Failures a caller can expect in normal operation — a wrong password, an expired
 * code, a duplicate sign-up — are returned as `{ ok: false, error }` rather than
 * thrown; see `AuthResult` below. Exceptions are reserved for what a caller cannot
 * usefully recover from at the call site: `PUBLIC_SUPABASE_URL` / `_ANON_KEY` missing
 * from the environment is a deployment misconfiguration, not a user-facing outcome,
 * so `requiredEnv` throws for it rather than teaching every caller to check for it.
 *
 * `createAuthClient`'s own comment covers a real limitation worth flagging here too,
 * because it shapes every function below it: Astro's `AstroCookies` has no way to
 * enumerate the cookies on an incoming request, only to look one up by a name you
 * already know, and `@supabase/ssr`'s cookie interface needs exactly the enumeration
 * Astro cannot give it. See `createAuthClient` for how that gap is closed — by reading
 * the raw `Cookie` request header directly instead, which gives true enumeration with
 * no blind spot and no dependence on `@supabase/ssr`'s own chunk-naming scheme staying
 * what it is today. Every exported function below takes `request` alongside `cookies`
 * for exactly this reason.
 */

import { createServerClient } from '@supabase/ssr';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import type { AstroCookies, AstroCookieSetOptions } from 'astro';

/**
 * The result shape for every operation below that can fail in a way a caller should
 * show to a user rather than crash on. `T` carries whatever the successful case hands
 * back — nothing, for something like `signOut`, or `{ user }` for something that
 * authenticates one. Modelled as a discriminated union rather than a thrown error so
 * that "the password was wrong" is a value a page can branch on and render, not an
 * exception it has to remember to catch.
 */
export type AuthResult<T = unknown> = ({ ok: true } & T) | { ok: false; error: string };

/**
 * The single message shown for every rejected sign-in, regardless of which half of
 * the credential pair was wrong or whether the account exists at all. Supabase's own
 * `error.message` for this case can differ by cause, and relaying it verbatim is
 * exactly how an account-enumeration leak happens by accident: "no account with that
 * email" and "wrong password" are two different sentences that together tell a caller
 * which emails are registered. One neutral sentence for both closes that gap; it costs
 * nothing else, because a legitimate user with the wrong password does not need to be
 * told which half was wrong to try again.
 */
const BAD_CREDENTIALS_MESSAGE = 'Incorrect email or password.';

/**
 * Reads a public Supabase configuration value at CALL time rather than at module load.
 * `npm test` and CI both build the whole site to run their suites, and this module is
 * in that build graph regardless of whether anything calls into it yet — a throw at
 * module scope here would fail every one of those builds for every contributor who has
 * not set up a `.env`, which is the opposite of "fail fast" done usefully. Deferring
 * the check to the moment a caller actually needs the value means the failure lands on
 * the one request that needed Supabase and names exactly what to fix.
 */
function requiredEnv(name: 'PUBLIC_SUPABASE_URL' | 'PUBLIC_SUPABASE_ANON_KEY'): string {
  const value: string | undefined = import.meta.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. See .env.example for what this should contain — for local ` +
        'development, run `npm run db:start` and copy PUBLISHABLE_KEY/API_URL from its ' +
        'output into your own .env, since each git worktree runs its own Supabase stack ' +
        'on its own ports.',
    );
  }
  return value;
}

/**
 * The cookie attributes this module guarantees on every cookie it writes, regardless
 * of what `@supabase/ssr` itself would have chosen. Spread in LAST wherever a cookie is
 * set below, so a future version of the library changing its own defaults cannot
 * silently loosen what ships:
 *
 *   - `httpOnly: true` — client-side JavaScript, including an XSS payload, cannot read
 *     the access or refresh token out of `document.cookie`.
 *   - `secure`, everywhere except the `astro dev` server. Browsers refuse to store a
 *     `Secure` cookie set over plain HTTP, and `npm run dev` (see the README) serves
 *     `http://localhost:4321` — a hard `secure: true` here would make sign-in silently
 *     fail to persist for every contributor running the dev server. `import.meta.env.DEV`
 *     is true for exactly that server and false for every built artifact (`astro build`,
 *     `astro preview`, and everything the deploy workflows ship), which is the same
 *     distinction the README draws between "day-to-day work" and a build that leaves
 *     this machine.
 *   - `sameSite: 'lax'` — sent on top-level navigation (so the OAuth and email-callback
 *     redirects in this module still carry the session) but not on cross-site
 *     subrequests, which is what CSRF protection for a cookie-based session rests on.
 *   - `path: '/'` — scoped to the whole site rather than to whatever route happened to
 *     set it, so a token refresh from one page does not orphan the cookie for another.
 */
const REQUIRED_COOKIE_ATTRIBUTES: AstroCookieSetOptions = {
  httpOnly: true,
  secure: !import.meta.env.DEV,
  sameSite: 'lax',
  path: '/',
};

/**
 * Parses the raw `Cookie` request header into every `{ name, value }` pair on it —
 * true enumeration, which is the whole reason `createAuthClient` reads this header
 * instead of going through `AstroCookies`. Cookie pairs are separated by `;`, and
 * within a pair the name and value are split on the FIRST `=` only: a cookie's value
 * is free to contain further `=` characters, and a base64-encoded session chunk
 * routinely does, so splitting on every `=` would silently truncate exactly the
 * values this module most needs intact. Decoded with `decodeURIComponent`, matching
 * how the `cookie` package `AstroCookies` itself uses internally decodes a request's
 * cookies (see `#parse()` in Astro 7.2.0's `cookies.js`) — this function reads the
 * identical header that call reads, it just also hands back what it found instead of
 * hiding it behind a private field.
 *
 * A malformed percent-escape in one cookie's value must not take down every other
 * cookie on the request, so a `decodeURIComponent` failure falls back to the raw
 * value for that pair alone rather than throwing out of the whole parse.
 */
function parseCookieHeader(header: string): { name: string; value: string }[] {
  return header
    .split(';')
    .map((pair): { name: string; value: string } | null => {
      const separator = pair.indexOf('=');
      if (separator === -1) return null;
      const name = pair.slice(0, separator).trim();
      if (!name) return null;
      const rawValue = pair.slice(separator + 1).trim();
      try {
        return { name, value: decodeURIComponent(rawValue) };
      } catch {
        return { name, value: rawValue };
      }
    })
    .filter((cookie): cookie is { name: string; value: string } => cookie !== null);
}

/**
 * Per-request overlay of cookies written by `setAll` DURING the request the given
 * `AstroCookies` instance belongs to — the fix for a read-after-write bug a real
 * sign-up walkthrough found: `sign-up.astro` calls `signUpWithPassword` (whose
 * `setAll` writes the new session cookies) and then, in the SAME request, calls
 * `getUser` to ask whether a session now exists. Each of those calls builds its OWN
 * client via `createAuthClient`, so a `getAll` that only ever re-read
 * `request.headers.get('cookie')` — the INBOUND header, captured before any of this
 * ran — could never see what an earlier call in the same request had just written.
 * `getUser` came back `null` even though the visitor was, in fact, signed in, and
 * sign-up.astro rendered "check your inbox" for an email that was never coming.
 *
 * Keyed by the `AstroCookies` instance itself rather than by nothing (a single
 * module-level `Map`) or by something invented (a request id nobody hands this
 * function). Astro allocates a fresh `AstroCookies` for exactly one incoming request
 * and every call this module makes within that request is handed the SAME instance —
 * `Astro.cookies` in a page, `cookies` in an `APIRoute` — so keying by its identity
 * scopes an overlay to exactly the calls that share a request, automatically, with no
 * separate bookkeeping. THIS IS WHY A `WeakMap` AND NOT A `Map`: a `Map` would hold a
 * strong reference to every `AstroCookies` this module ever sees, for the lifetime of
 * the process, in a request-scoped module that otherwise keeps no cross-request state
 * at all — a slow, silent leak. A `WeakMap` lets each entry be collected the moment
 * nothing outside this module still holds that request's cookies jar, which is
 * exactly when the overlay stops being useful anyway.
 *
 * What this is NOT, and the distinction matters: it is not a cache of session state
 * shared across visitors. A `Map` with no key at all — "the last session `setAll`
 * wrote, globally" — is the shape of bug that would leak one visitor's cookies into
 * another's concurrent request, which is a worse defect than the one this fixes. Every
 * entry here is reachable only through a specific request's own `AstroCookies`
 * instance, so there is no way for one visitor's overlay to answer another visitor's
 * `getAll`.
 */
const cookieOverlaysByRequest = new WeakMap<AstroCookies, Map<string, string | null>>();

/**
 * Builds a Supabase client scoped to one request. Never share the return value across
 * requests — a client built from one visitor's cookies must never answer a question
 * for another visitor, and the request-scoped construction is what makes that a
 * non-issue rather than a rule to remember.
 *
 * `@supabase/ssr` wants `cookies: { getAll, setAll }`: read every cookie on the
 * request in one call, write every cookie it wants to set in one call. Astro's
 * `AstroCookies` cannot supply the first half — `cookies.get(name)` answers for a name
 * you already know, but there is no `cookies.getAll()` and no way to list what names
 * exist on the incoming request at all, confirmed against Astro 7.2.0's own
 * implementation, where `#parse()` reads the raw `Cookie` header into a private map
 * that nothing public exposes.
 *
 * THE BASE: read that header ourselves, which is why this function takes `request`
 * alongside `cookies`. `request.headers.get('cookie')` is on every `Request` Astro
 * hands a route; it IS the wire format a `Cookie` header actually is — a
 * `;`-separated list of `name=value` pairs, exactly what `AstroCookies` parses
 * internally to build the private map it will not hand out — so reading it costs
 * nothing: no extra request, no guessing which names might be Supabase's, and no
 * coupling to `@supabase/ssr`'s own chunk-naming scheme staying what it is today (an
 * earlier version of this function pinned a fixed storage key and looked up a bounded
 * number of numbered chunk suffixes by name; that traded a real enumeration for an
 * assumption about library internals for no reason once the header was available).
 * `parseCookieHeader` above does the parsing and hands back every cookie on the
 * request — deciding which of them are actually its own is `@supabase/ssr`'s job, not
 * this module's, so the base list includes everything rather than pre-filtering.
 *
 * That base is correct for what the BROWSER sent, and it is deliberately still where
 * `getAll` starts — it is the one part of this function with no way to be wrong, since
 * it is reading the actual bytes the request arrived with. What it cannot reflect is a
 * write this SAME request already made: the header was captured when the request
 * landed, and nothing mutates it afterwards. THE OVERLAY closes exactly that gap —
 * `getAll` layers `cookieOverlaysByRequest`'s entries for this `cookies` instance on
 * top of the base list before returning, and `setAll` is what populates that overlay,
 * in addition to writing through to `AstroCookies.set()` as it always did. A later
 * `getAll` call in the same request — from a different `createAuthClient` call, as
 * `getUser` makes after `signUpWithPassword` — now sees what the earlier call wrote,
 * because it reads the same overlay entry rather than only the frozen header. See
 * `cookieOverlaysByRequest`'s own comment for why keying by the `AstroCookies`
 * instance is what scopes this to one request rather than leaking across visitors.
 *
 * DELETIONS, not just additions, have to be honoured — the mirror-image bug is a
 * `getAll` that keeps returning a session cookie for the rest of the request after
 * `signOut` just cleared it. `@supabase/ssr` clears a cookie by calling `setAll` with
 * `maxAge: 0` (see `removeItem` / `applyServerStorage` in
 * `node_modules/@supabase/ssr/dist/main/cookies.js` — it never uses a distinct
 * "delete" verb, and never sets a past `expires` on its own, though one is checked for
 * too since that is the other way a `Set-Cookie` can express a deletion). `setAll`
 * recognises that shape and records `null` in the overlay for that name rather than
 * the literal empty string `@supabase/ssr` also passes — `getAll` treats a `null`
 * entry as "omit this cookie from the result", which is what lets a same-request
 * `getUser` after `signOut` see NO session, not a stale one.
 *
 * `setAll` also still writes each cookie through to `AstroCookies.set()`, with
 * `REQUIRED_COOKIE_ATTRIBUTES` enforced LAST so nothing `@supabase/ssr` passes can
 * loosen what ships — that half is unchanged by any of the above.
 */
export function createAuthClient(cookies: AstroCookies, request: Request): SupabaseClient {
  let overlay = cookieOverlaysByRequest.get(cookies);
  if (!overlay) {
    overlay = new Map<string, string | null>();
    cookieOverlaysByRequest.set(cookies, overlay);
  }
  // Rebinding lets the closures below capture a value TypeScript knows is non-nullable
  // — `overlay` above is `Map | undefined` until this point, `resolvedOverlay` never is.
  const resolvedOverlay = overlay;

  return createServerClient(
    requiredEnv('PUBLIC_SUPABASE_URL'),
    requiredEnv('PUBLIC_SUPABASE_ANON_KEY'),
    {
      cookies: {
        getAll: () => {
          const merged = new Map(
            parseCookieHeader(request.headers.get('cookie') ?? '').map(
              ({ name, value }): [string, string] => [name, value],
            ),
          );
          for (const [name, value] of resolvedOverlay) {
            if (value === null) {
              merged.delete(name);
            } else {
              merged.set(name, value);
            }
          }
          return [...merged].map(([name, value]) => ({ name, value }));
        },
        setAll: (cookiesToSet) => {
          for (const { name, value, options } of cookiesToSet) {
            cookies.set(name, value, { ...options, ...REQUIRED_COOKIE_ATTRIBUTES });
            const deleted =
              options?.maxAge === 0 ||
              (options?.expires !== undefined && options.expires.getTime() <= Date.now());
            resolvedOverlay.set(name, deleted ? null : value);
          }
        },
      },
    },
  );
}

/**
 * The authenticated user for this request, or `null` if there is not one — a missing,
 * expired or otherwise invalid session is not an error to this function, only an
 * absent user.
 *
 * This calls `supabase.auth.getUser()` and NOT `supabase.auth.getSession()`, and the
 * difference is the classic mistake in exactly this kind of code. `getSession()` reads
 * the JWT out of the cookie/storage and returns its claims without checking anything —
 * it answers instantly because it does no network call, but that also means it returns
 * whatever the cookie says even if the cookie has been forged, replayed, or the
 * session has since been revoked. `getUser()` sends the token to the Supabase auth
 * server and returns the user only once the server confirms it is still valid. Every
 * server-side "is this request authenticated" check must go through `getUser()`; the
 * moment `getSession()`'s contents inform an authorization decision, the cookie itself
 * has become the authority instead of the server that issued it.
 */
export async function getUser({
  cookies,
  request,
}: {
  cookies: AstroCookies;
  request: Request;
}): Promise<User | null> {
  const client = createAuthClient(cookies, request);
  const {
    data: { user },
    error,
  } = await client.auth.getUser();
  if (error) return null;
  return user;
}

export async function signUpWithPassword(params: {
  cookies: AstroCookies;
  request: Request;
  email: string;
  password: string;
}): Promise<AuthResult<{ user: User | null }>> {
  const client = createAuthClient(params.cookies, params.request);
  const { data, error } = await client.auth.signUp({
    email: params.email,
    password: params.password,
  });
  // Not routed through BAD_CREDENTIALS_MESSAGE: sign-up failures (a weak password, a
  // rate limit) are not the enumeration-sensitive case sign-in is, and Supabase's own
  // "Confirm email" setting already governs whether a duplicate address is disclosed
  // here — that is a project setting, not something this function should second-guess.
  if (error) return { ok: false, error: error.message };
  return { ok: true, user: data.user };
}

export async function signInWithPassword(params: {
  cookies: AstroCookies;
  request: Request;
  email: string;
  password: string;
}): Promise<AuthResult<{ user: User }>> {
  const client = createAuthClient(params.cookies, params.request);
  const { data, error } = await client.auth.signInWithPassword({
    email: params.email,
    password: params.password,
  });
  if (error) return { ok: false, error: BAD_CREDENTIALS_MESSAGE };
  return { ok: true, user: data.user };
}

/**
 * Starts the Google OAuth flow and returns the provider's authorization URL for the
 * caller to redirect to, rather than redirecting itself — this module has no notion
 * of a Response, only of cookies, so issuing the 302 is left to the route that calls
 * it. `skipBrowserRedirect: true` is what makes `signInWithOAuth` return the URL
 * instead of attempting a browser-only redirect that has no meaning on the server.
 */
export async function getGoogleAuthorizationUrl(params: {
  cookies: AstroCookies;
  request: Request;
  redirectTo: string;
}): Promise<AuthResult<{ url: string }>> {
  const client = createAuthClient(params.cookies, params.request);
  const { data, error } = await client.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: params.redirectTo, skipBrowserRedirect: true },
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true, url: data.url };
}

/**
 * Completes the PKCE/OAuth callback: exchanges the one-time `code` Supabase appended
 * to the redirect URL for a session, writing that session to cookies via the `setAll`
 * wired up in `createAuthClient`. The route that calls this is the one named by
 * `AUTH_CALLBACK_PATH` in src/lib/auth-routes.ts.
 */
export async function exchangeCodeForSession(params: {
  cookies: AstroCookies;
  request: Request;
  code: string;
}): Promise<AuthResult<{ user: User }>> {
  const client = createAuthClient(params.cookies, params.request);
  const { data, error } = await client.auth.exchangeCodeForSession(params.code);
  if (error) return { ok: false, error: error.message };
  return { ok: true, user: data.user };
}

export async function signOut({
  cookies,
  request,
}: {
  cookies: AstroCookies;
  request: Request;
}): Promise<AuthResult> {
  const client = createAuthClient(cookies, request);
  const { error } = await client.auth.signOut();
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/**
 * Deletes the signed-in user's own account by calling the `delete_own_account`
 * Postgres RPC as that user — not via a service-role client, because this project has
 * decided against ever holding one (see the "WHAT CHANGED WITH SUPABASE" section
 * above). A `SECURITY DEFINER` function that starts by checking `auth.uid()` against
 * the row it is about to touch gets the "delete exactly your own account, and nothing
 * else" guarantee from Postgres itself, the same way row-level security gets it for
 * ordinary reads and writes — no elevated key ever has to exist for this to work.
 *
 * The migration that creates `delete_own_account` is another task's job; this function
 * is written against that contract (a zero-argument RPC, callable by `authenticated`,
 * that deletes the calling user and everything RLS says belongs to them) so that both
 * halves can land independently and meet in the middle.
 */
export async function deleteOwnAccount({
  cookies,
  request,
}: {
  cookies: AstroCookies;
  request: Request;
}): Promise<AuthResult> {
  const client = createAuthClient(cookies, request);
  const { error } = await client.rpc('delete_own_account');
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
