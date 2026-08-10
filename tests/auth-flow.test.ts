/**
 * The auth flow itself, driven for real: `signUpWithPassword`, `signInWithPassword`,
 * `signOut`, `getUser` and `deleteOwnAccount` in `src/lib/auth/index.ts`, called exactly
 * the way `src/pages/sign-in.astro`, `src/pages/sign-up.astro`,
 * `src/pages/auth/signout.ts` and `src/pages/account/index.astro` call them — real
 * cookies, a real `Request`, and a real round trip through the local GoTrue instance.
 *
 * `tests/support/local-database.ts` explains, in its own header, why the row-level
 * security suite deliberately does NOT do this: it mints a JWT by hand against the
 * stack's signing secret rather than calling `auth.signUp()`, because what RLS cares
 * about is only the token's claims, and a hand-minted token is the same object to
 * Postgres as a real one — with none of the cost of a real sign-up. That file's own
 * words: "The sign-up path itself belongs to Ref 19, which owns authentication. This
 * file tests the boundary, not the door."
 *
 * This file is Ref 19. It tests the door — `signUp`, `signInWithPassword`, real session
 * cookies — because nothing else in this suite does, and a hand-minted token can never
 * stand in for it here: the whole point below is proving that cookies
 * `src/lib/auth/index.ts` actually WRITES carry a session across the gap between one
 * request and the next the way `@supabase/ssr` and GoTrue actually behave, which a
 * fixture that skips both of those has nothing to say about.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS NEVER SKIPS
 * ---------------------------------------------------------------------------
 *
 * Same rule as every other integration suite here (see local-database.ts and
 * global-setup.ts): a skipped test reports green while proving nothing, which is worse
 * than no test. Every function this file imports throws with an actionable message —
 * `requiredEnv` in src/lib/auth/index.ts, or `localDatabase()` in local-database.ts —
 * the moment the local stack or its env vars are missing, and nothing here catches
 * that to turn it into a skip.
 *
 * ---------------------------------------------------------------------------
 * RATE LIMITS
 * ---------------------------------------------------------------------------
 *
 * `auth.rate_limit.sign_in_sign_ups` in supabase/config.toml is 30 sign-up-or-sign-in
 * requests per 5 minutes per IP, shared by every test file, every worker and every
 * re-run — config.toml is UNCHANGED by this file. Each `describe` block below registers
 * its own dedicated user rather than sharing one across blocks (an account touched by
 * an earlier block's sign-out or deletion should never be reused by a later block that
 * assumes a clean session), which puts this file's total at roughly six sign-ups and
 * three additional sign-ins — comfortably inside the limit with room for a full retry.
 * What this file avoids is the shape that actually burns the budget: creating a fresh
 * user inside every individual `it` rather than once per `describe`'s `beforeAll`.
 *
 * ---------------------------------------------------------------------------
 * THE COOKIE DOUBLE
 * ---------------------------------------------------------------------------
 *
 * `tests/support/fake-astro-cookies.ts` supplies `FakeAstroCookies` (a `set()`-only
 * stand-in for `AstroCookies`, since the real class cannot be built from a plain
 * object) and `requestWithCookies` (a real `Request` carrying a `Cookie` header). Read
 * that file's header before changing anything here — the honesty of every "does the
 * session survive" assertion below depends entirely on that double matching how a
 * browser actually treats `Set-Cookie`, especially cookie deletion via `maxAge: 0`.
 */

import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  createAuthClient,
  deleteOwnAccount,
  getUser,
  signInWithPassword,
  signOut,
  signUpWithPassword,
} from '../src/lib/auth';
import { createPack } from './support/fixtures';
import {
  asAstroCookies,
  FakeAstroCookies,
  requestWithCookies,
  type RecordedCookie,
} from './support/fake-astro-cookies';
import { adminSql } from './support/local-database';

/** Meets `minimum_password_length = 6` with room to spare; no character-class policy is configured. */
const PASSWORD = 'CorrectHorseBattery9!';
const WRONG_PASSWORD = 'WrongPassword9!';

/** A fresh, never-used address per call — `enable_confirmations = false` in config.toml means it never needs to receive mail. */
function testEmail(label: string): string {
  return `auth-flow-${label}-${randomUUID()}@packsheet.test`;
}

/** A brand-new visitor: an empty cookie jar and a request carrying no `Cookie` header at all. */
function freshVisit(): { cookies: FakeAstroCookies; request: Request } {
  return { cookies: new FakeAstroCookies(), request: requestWithCookies('') };
}

/**
 * A FOLLOW-UP request from a visitor carrying cookies an earlier call in this file set,
 * with a brand-new outgoing jar for this request's own `Set-Cookie`s. A fresh
 * `FakeAstroCookies` per call mirrors Astro building one new `AstroCookies` per
 * request; reusing an old instance would let a previous response's `Set-Cookie`s leak
 * into this one, which nothing on the real request pipeline does.
 */
function continueWith(cookieHeader: string): { cookies: FakeAstroCookies; request: Request } {
  return { cookies: new FakeAstroCookies(), request: requestWithCookies(cookieHeader) };
}

describe('sign-up then getUser on a fresh request — the round trip', () => {
  const email = testEmail('roundtrip');
  let signUpResult: Awaited<ReturnType<typeof signUpWithPassword>>;
  let signUpCookies: FakeAstroCookies;

  beforeAll(async () => {
    const visit = freshVisit();
    signUpResult = await signUpWithPassword({
      cookies: asAstroCookies(visit.cookies),
      request: visit.request,
      email,
      password: PASSWORD,
    });
    signUpCookies = visit.cookies;
  });

  it('signs the new user up and reports them back', () => {
    expect(signUpResult.ok).toBe(true);
    if (!signUpResult.ok) return;
    expect(signUpResult.user?.email).toBe(email);
  });

  /**
   * The single most important test in this file. Everything else here exercises one
   * function at a time; this is the one that proves the COOKIES `signUpWithPassword`
   * wrote are sufficient, on their own, on a request that shares nothing else with the
   * one that created them, to reconstruct a verified session. `getUser()` — not
   * `getSession()` — is what makes "verified" true rather than "whatever the cookie
   * happens to say"; see the comment on `getUser` in src/lib/auth/index.ts.
   */
  it('a FRESH request carrying only those cookies gets the same user back from getUser', async () => {
    const header = signUpCookies.asRequestCookieHeader();
    // A session that set no cookies at all would make the rest of this assertion
    // vacuously true (an empty Cookie header would also produce a null user).
    expect(header).not.toBe('');

    const next = continueWith(header);
    const user = await getUser({ cookies: asAstroCookies(next.cookies), request: next.request });

    expect(user).not.toBeNull();
    expect(user?.email).toBe(email);
  });
});

/**
 * The defect PK-19's real-browser walkthrough found: sign up with a valid
 * email/password under `enable_confirmations = false`, and the account IS created,
 * IS auto-confirmed, and a session cookie IS written — but sign-up.astro's very next
 * call, `getUser()` in the SAME request, reported no session, so the page rendered
 * "check your inbox" for an email that was never coming while the visitor sat there
 * already signed in.
 *
 * The cause was `createAuthClient`'s `getAll` reading only `request.headers.get
 * ('cookie')` — the INBOUND header, captured before `signUpWithPassword`'s `setAll`
 * ever ran. Every describe block above this one proves cookies survive a hop to a
 * genuinely NEW request (a fresh `FakeAstroCookies`, a fresh `Request` built from the
 * forwarded header) — none of them would have caught this, because the bug is
 * specific to reading cookies back WITHOUT that hop, using the exact SAME `cookies`
 * and `request` objects a real Astro page frontmatter hands to two calls one after
 * another. That is what this block does instead.
 */
describe('cookies written during a request are visible to a later read in the SAME request', () => {
  it('sign-up followed by getUser, same request objects, finds the new session', async () => {
    const email = testEmail('read-after-write');
    const visit = freshVisit();
    const cookies = asAstroCookies(visit.cookies);

    const signUpResult = await signUpWithPassword({
      cookies,
      request: visit.request,
      email,
      password: PASSWORD,
    });
    if (!signUpResult.ok) throw new Error(`Fixture failed to sign up: ${signUpResult.error}`);

    // SAME cookies and SAME request as the call above — nothing here simulates a
    // second request. Against the old adapter this returns null: getAll re-reads
    // visit.request's original (cookie-less) header and never sees what setAll, a
    // moment ago, wrote into the overlay instead.
    const user = await getUser({ cookies, request: visit.request });
    expect(user).not.toBeNull();
    expect(user?.email).toBe(email);
  });

  /**
   * The mirror case, and just as load-bearing as the addition above: an overlay
   * that only ever recorded ADDITIONS (or that mis-detected @supabase/ssr's
   * maxAge: 0 clearing convention) could make the test above pass while still
   * handing back a stale, signed-in user here — getAll would layer the ORIGINAL
   * session cookie's value from the raw header underneath an overlay that never
   * told it to remove it. See createAuthClient's own comment in
   * src/lib/auth/index.ts for how the deletion is detected.
   */
  it('signOut followed by getUser, same request objects, finds no session', async () => {
    const email = testEmail('read-after-write-signout');
    const signUpVisit = freshVisit();
    const signUpResult = await signUpWithPassword({
      cookies: asAstroCookies(signUpVisit.cookies),
      request: signUpVisit.request,
      email,
      password: PASSWORD,
    });
    if (!signUpResult.ok) throw new Error(`Fixture failed to sign up: ${signUpResult.error}`);

    // A single "request" carrying the session, built once and reused for every call
    // below — signOut and the same-request getUser share these exact objects.
    const header = signUpVisit.cookies.asRequestCookieHeader();
    const visit = continueWith(header);
    const cookies = asAstroCookies(visit.cookies);

    // Confirm the session is live before signing out, so a false pass below can't be
    // credited to a session that never worked in the first place.
    const before = await getUser({ cookies, request: visit.request });
    if (!before) throw new Error('Fixture session did not work before sign-out');

    const signOutResult = await signOut({ cookies, request: visit.request });
    expect(signOutResult.ok).toBe(true);

    // SAME cookies and SAME request signOut was just called with.
    const after = await getUser({ cookies, request: visit.request });
    expect(after).toBeNull();
  });
});

describe('signing in with a password', () => {
  const email = testEmail('signin');
  let signedInUser: Awaited<ReturnType<typeof getUser>>;
  let wrongPasswordResult: Awaited<ReturnType<typeof signInWithPassword>>;
  let noSuchAccountResult: Awaited<ReturnType<typeof signInWithPassword>>;

  beforeAll(async () => {
    const signUpVisit = freshVisit();
    const signUp = await signUpWithPassword({
      cookies: asAstroCookies(signUpVisit.cookies),
      request: signUpVisit.request,
      email,
      password: PASSWORD,
    });
    if (!signUp.ok) throw new Error(`Fixture failed to register ${email}: ${signUp.error}`);

    // The successful path: sign in, then prove the resulting cookies work on a later request.
    const signInVisit = freshVisit();
    const signIn = await signInWithPassword({
      cookies: asAstroCookies(signInVisit.cookies),
      request: signInVisit.request,
      email,
      password: PASSWORD,
    });
    if (!signIn.ok) throw new Error(`Fixture failed to sign in as ${email}: ${signIn.error}`);
    const header = signInVisit.cookies.asRequestCookieHeader();
    const next = continueWith(header);
    signedInUser = await getUser({ cookies: asAstroCookies(next.cookies), request: next.request });

    // The two refused paths, captured here so the enumeration test below compares
    // them without making either of its own network calls.
    const wrongPasswordVisit = freshVisit();
    wrongPasswordResult = await signInWithPassword({
      cookies: asAstroCookies(wrongPasswordVisit.cookies),
      request: wrongPasswordVisit.request,
      email,
      password: WRONG_PASSWORD,
    });

    const noSuchAccountVisit = freshVisit();
    noSuchAccountResult = await signInWithPassword({
      cookies: asAstroCookies(noSuchAccountVisit.cookies),
      request: noSuchAccountVisit.request,
      email: testEmail('never-registered'),
      password: WRONG_PASSWORD,
    });
  });

  it('the right password returns a session that getUser confirms on a later request', () => {
    expect(signedInUser).not.toBeNull();
    expect(signedInUser?.email).toBe(email);
  });

  it('the wrong password is refused', () => {
    expect(wrongPasswordResult.ok).toBe(false);
  });

  it('signing in as an account that does not exist is refused too', () => {
    expect(noSuchAccountResult.ok).toBe(false);
  });

  /**
   * The property that matters most here: a caller — or an attacker probing for
   * registered addresses — cannot tell "wrong password" from "no such account" apart
   * by the error text. `signInWithPassword` routes every rejection through the same
   * `BAD_CREDENTIALS_MESSAGE` regardless of which half of the credential pair was the
   * problem; this is what proves that from OUTSIDE the module rather than by reading
   * its source.
   */
  it('is indistinguishable from a wrong password on an existing account — no enumeration', () => {
    if (wrongPasswordResult.ok || noSuchAccountResult.ok) {
      throw new Error('fixture assumption violated: both sign-in attempts were meant to fail');
    }
    expect(wrongPasswordResult.error).toBeTruthy();
    expect(noSuchAccountResult.error).toBe(wrongPasswordResult.error);
  });
});

describe('cookie attributes', () => {
  let recorded: [string, RecordedCookie][];

  beforeAll(async () => {
    const email = testEmail('cookie-attrs');
    const visit = freshVisit();
    const result = await signUpWithPassword({
      cookies: asAstroCookies(visit.cookies),
      request: visit.request,
      email,
      password: PASSWORD,
    });
    if (!result.ok) throw new Error(`Fixture failed to sign up: ${result.error}`);
    recorded = visit.cookies.entries();
  });

  it('sets at least one cookie', () => {
    // Otherwise every assertion in the next test runs zero times and passes for free.
    expect(recorded.length).toBeGreaterThan(0);
  });

  /**
   * REQUIRED_COOKIE_ATTRIBUTES in src/lib/auth/index.ts is spread in LAST specifically
   * so nothing `@supabase/ssr` supplies can loosen it — this is what pins that promise
   * from outside the module. A session cookie that is not `httpOnly` is readable by
   * any script on the page, including an XSS payload; `sameSite: 'lax'` is half of this
   * project's CSRF protection (see the comment on sign-in.astro's POST handler); `path:
   * '/'` keeps a refresh on one route from orphaning the cookie for another. Checking
   * EVERY recorded cookie, not just one, matters because `@supabase/ssr` may split a
   * large session across several cookies — a check that only looked at the first would
   * miss a later chunk shipped without the same guarantee.
   */
  it('every cookie is httpOnly, sameSite lax, and scoped to the whole site', () => {
    for (const [name, { options }] of recorded) {
      expect(options?.httpOnly, `${name} must be httpOnly`).toBe(true);
      expect(options?.sameSite, `${name} must be sameSite: 'lax'`).toBe('lax');
      expect(options?.path, `${name} must be scoped to path '/'`).toBe('/');
    }
  });
});

describe('sign out clears the session', () => {
  let sessionCookieHeader: string;

  beforeAll(async () => {
    const email = testEmail('signout');
    const visit = freshVisit();
    const result = await signUpWithPassword({
      cookies: asAstroCookies(visit.cookies),
      request: visit.request,
      email,
      password: PASSWORD,
    });
    if (!result.ok) throw new Error(`Fixture failed to sign up: ${result.error}`);
    sessionCookieHeader = visit.cookies.asRequestCookieHeader();

    // Prove the session works BEFORE sign-out touches it, so the assertion below shows
    // sign-out caused the loss rather than the fixture never having had a working
    // session to lose.
    const check = continueWith(sessionCookieHeader);
    const userBefore = await getUser({
      cookies: asAstroCookies(check.cookies),
      request: check.request,
    });
    if (!userBefore)
      throw new Error('Fixture session did not work before sign-out — nothing to prove');
  });

  it('a request carrying the resulting cookies has no user', async () => {
    const signOutVisit = continueWith(sessionCookieHeader);
    const result = await signOut({
      cookies: asAstroCookies(signOutVisit.cookies),
      request: signOutVisit.request,
    });
    expect(result.ok).toBe(true);

    // asRequestCookieHeader() honours maxAge: 0 by dropping the cookie entirely — see
    // that method's own comment for why that, and not merely "carry forward whatever
    // value was written", is what a real browser would do.
    const clearedHeader = signOutVisit.cookies.asRequestCookieHeader();
    const after = continueWith(clearedHeader);
    const user = await getUser({ cookies: asAstroCookies(after.cookies), request: after.request });
    expect(user).toBeNull();
  });
});

describe('getUser rejects a forged or garbage session cookie', () => {
  let cookieNames: string[];

  beforeAll(async () => {
    const email = testEmail('forged');
    const visit = freshVisit();
    const result = await signUpWithPassword({
      cookies: asAstroCookies(visit.cookies),
      request: visit.request,
      email,
      password: PASSWORD,
    });
    if (!result.ok) throw new Error(`Fixture failed to sign up: ${result.error}`);
    cookieNames = visit.cookies.entries().map(([name]) => name);
    if (cookieNames.length === 0) throw new Error('Fixture set no cookies — nothing to forge');
  });

  /**
   * This is what makes `getUser()` — a real network round trip to the auth server —
   * worth its cost over `getSession()`, which only decodes the cookie and trusts it.
   * Rubbish under the SAME cookie names a real session used must be rejected, not
   * merely rubbish under a name the module has never heard of (the next test covers
   * that separately) — a decoder that only fails on structurally-impossible input
   * would still pass this one if it fell back to trusting an unverifiable claim.
   */
  it('a genuine session cookie name carrying rubbish is rejected, not trusted', async () => {
    const forged = new FakeAstroCookies();
    for (const name of cookieNames) forged.set(name, 'not-a-real-session-token', {});
    const header = forged.asRequestCookieHeader();

    const next = continueWith(header);
    const user = await getUser({ cookies: asAstroCookies(next.cookies), request: next.request });
    expect(user).toBeNull();
  });

  it('an entirely unrelated cookie is also no session at all', async () => {
    const next = continueWith('not-a-real-cookie=whatever');
    const user = await getUser({ cookies: asAstroCookies(next.cookies), request: next.request });
    expect(user).toBeNull();
  });

  /**
   * The sharpest version of "rubbish", and the one that actually distinguishes
   * `getUser()` from `getSession()` rather than merely from a JSON parse failure.
   * Everything about this cookie is exactly what a real session looks like — the JWT's
   * signature is genuinely valid, because it is one GoTrue itself issued a moment ago
   * — except that the row it names is now gone. `getSession()` would decode this
   * locally and hand back a user for an account that no longer exists, because
   * decoding a signature-valid JWT is all it ever does; only a real round trip to the
   * auth server can notice the account underneath it was deleted out from under the
   * token. That is the concrete case the comment on `getUser` in src/lib/auth/index.ts
   * is warning about, pinned rather than taken on faith.
   */
  it('a signature-valid session for a user who no longer exists is rejected too', async () => {
    const email = testEmail('deleted-underneath');
    const visit = freshVisit();
    const result = await signUpWithPassword({
      cookies: asAstroCookies(visit.cookies),
      request: visit.request,
      email,
      password: PASSWORD,
    });
    if (!result.ok) throw new Error(`Fixture failed to sign up: ${result.error}`);
    const userId = result.user?.id;
    if (!userId) throw new Error('Fixture signed up but returned no user id');

    const header = visit.cookies.asRequestCookieHeader();

    // Removes the row directly, by superuser connection — leaving the cookie's JWT
    // exactly as GoTrue issued it. See adminSql's own comment for why this is safe to
    // use for exactly this kind of state manipulation and not for building fixtures.
    await adminSql('delete from auth.users where id = $1', [userId]);

    const next = continueWith(header);
    const user = await getUser({ cookies: asAstroCookies(next.cookies), request: next.request });
    expect(user).toBeNull();
  });
});

/**
 * `tests/account-deletion.test.ts` proves `delete_own_account()` itself — the SQL
 * function, called directly with a hand-minted token, exactly as that file's own
 * comment describes. What it cannot prove is that `deleteOwnAccount()` in
 * src/lib/auth/index.ts — the module path `src/pages/account/index.astro` actually
 * calls — reaches that same function with a real, cookie-carried session. This test is
 * the other half: sign up for real, build something as that user, delete the account
 * through the exported function, and confirm both the account and what it owned are
 * gone.
 */
describe('deleteOwnAccount reaches the module path end to end', () => {
  it('removes both the signed-up user and a pack created as them', async () => {
    const email = testEmail('deletion');
    const signUpVisit = freshVisit();
    const signUpResult = await signUpWithPassword({
      cookies: asAstroCookies(signUpVisit.cookies),
      request: signUpVisit.request,
      email,
      password: PASSWORD,
    });
    if (!signUpResult.ok) throw new Error(`Fixture failed to sign up: ${signUpResult.error}`);
    const userId = signUpResult.user?.id;
    if (!userId) throw new Error('Fixture signed up but returned no user id');

    // A later request, carrying the session signUpWithPassword set — the same shape
    // deleteOwnAccount() itself will be called with below, and the same shape
    // createAuthClient() (exported for exactly this: a request-scoped Supabase client)
    // needs to build a client authenticated as this user.
    const cookieHeader = signUpVisit.cookies.asRequestCookieHeader();
    const authedVisit = continueWith(cookieHeader);
    const authedClient = createAuthClient(asAstroCookies(authedVisit.cookies), authedVisit.request);

    // Built the way createPack always builds a fixture: through PostgREST, as the
    // owner, under RLS — see fixtures.ts's own header for why that matters. This
    // proves deleteOwnAccount() reaches a REAL pack this user really created, not one
    // seeded in as postgres that RLS would never have let them make.
    const pack = await createPack(
      { id: userId, email, client: authedClient },
      { visibility: 'private', itemCount: 1 },
    );

    const deleteVisit = continueWith(cookieHeader);
    const deleteResult = await deleteOwnAccount({
      cookies: asAstroCookies(deleteVisit.cookies),
      request: deleteVisit.request,
    });
    expect(deleteResult.ok).toBe(true);

    const users = await adminSql('select id from auth.users where id = $1', [userId]);
    expect(users).toEqual([]);

    const packs = await adminSql('select id from packs where id = $1', [pack.packId]);
    expect(packs).toEqual([]);
  });
});
