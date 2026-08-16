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
 * THAT WAS NOT ENOUGH, AND THE GAP IS WORTH RECORDING because the paragraph above reads
 * as if it were. A throw is not a skip, but WHERE it throws decides what vitest reports.
 * `requiredEnv` fires on the first Supabase call, and most of the first Supabase calls
 * in this file are made from a `beforeAll` — and a `beforeAll` that throws makes vitest
 * report every remaining test in its `describe` as SKIPPED. On PK-19's CI, which had no
 * `PUBLIC_SUPABASE_URL` at all, the summary line read `3 failed | 12 skipped` for the
 * file whose header is this paragraph. The run was red, so nothing shipped; but the
 * reporting said "twelve optional cases did not apply", when what it meant was "the
 * entire auth suite did not execute".
 *
 * `requireAuthEnvironment()` below closes it at the only point where "skipped" is not an
 * available outcome: module scope, before a single `describe` is registered. A missing
 * configuration is a collection failure — one error, naming both the local fix and the
 * CI one, and no test reported as anything at all. The stack being DOWN rather than
 * unconfigured is caught earlier still, by the global setup in
 * tests/support/global-setup.ts, which fails the whole run before any file loads.
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
 * assumes a clean session), which puts this file's total at fourteen sign-up requests and
 * five additional sign-ins — inside the limit of thirty, with room for a full retry but
 * not for much growth. Three of the fourteen are the enumeration block's, which is
 * inherently sign-up-heavy: it registers an address, registers it AGAIN to get the
 * refusal, and makes one more attempt with a password GoTrue will reject. There is no
 * cheaper way to observe either outcome.
 *
 * PK-56's two blocks add two of those sign-ups and two of those sign-ins. The reset
 * REQUESTS themselves are not on that budget at all — `/recover` is not a sign-in or a
 * sign-up, so `sign_in_sign_ups` never sees one — and what governs them instead is
 * `[auth.email] max_frequency`, a per-ADDRESS floor between sends: 1 second locally, 60 on
 * both hosted projects. That is deliberate rather than incidental to the reset block
 * below, which asks twice for the same address on purpose.
 *
 * `[auth.rate_limit] email_sent = 2` is the OTHER limit that would bite here if it applied
 * — it is the one project-wide cap that does cover `/recover` — and it does not apply,
 * because the CLI never passes this file's value to the local GoTrue. That is now VERIFIED
 * rather than inferred, and the correction is worth recording: this paragraph used to rest
 * on the config comment's "Requires auth.email.smtp to be enabled", read as "the local
 * stack has no SMTP". The local stack DOES have SMTP wired into GoTrue — Mailpit, via
 * `[local_smtp]` — so that reading was wrong even though the conclusion was right. What
 * the container is actually running, with `email_sent = 2` in supabase/config.toml and
 * Supabase CLI 2.113.0:
 *
 *     $ docker inspect supabase_auth_<stack> \
 *         --format '{{range .Config.Env}}{{println .}}{{end}}' \
 *       | grep -E 'EMAIL_SENT|SMTP_HOST|SMTP_MAX_FREQ'
 *     GOTRUE_SMTP_HOST=supabase_inbucket_<stack>
 *     GOTRUE_SMTP_MAX_FREQUENCY=1s
 *     GOTRUE_RATE_LIMIT_EMAIL_SENT=360000
 *
 * 360000, not 2. SMTP is present and `max_frequency` passes through verbatim, which is
 * exactly why the paragraph above rests on THAT limit and not on this one; the hourly cap
 * is the single value the CLI substitutes, because the sender is Mailpit rather than a
 * configured `[auth.email.smtp]`. The claim here is only what that output shows — not that
 * the CLI is contractually obliged to keep doing it. If a future CLI stops substituting,
 * this file's reset block is where it will go red first, and re-running the command above
 * is how to confirm that is what happened.
 *
 * So a fresh random address per run never inherits a previous run's budget, and nothing in
 * this file goes red on a third `npm test` within an hour.
 *
 * What this file avoids is the shape that actually burns the budget: creating a fresh
 * user inside every individual `it` rather than once per `describe`'s `beforeAll`. If a
 * future block pushes this over the limit, the answer is to share a user within a block,
 * not to relax config.toml — the limit is production's too.
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
  passwordUpdateErrorMessage,
  requestPasswordReset,
  signInWithPassword,
  signOut,
  signUpErrorMessage,
  signUpWithPassword,
  updatePassword,
} from '../src/lib/auth';
// Not auth code — a pure function over a Cookie header. Imported here because this is the
// only file that produces a REAL one, which is what makes it the right place to pin the
// assumption src/middleware.ts's fast path rests on. See the test at the end of the
// password sign-in block.
import { hasSupabaseAuthCookie } from '../src/lib/session-cookie';
import { createPack } from './support/fixtures';
import {
  asAstroCookies,
  FakeAstroCookies,
  requestWithCookies,
  type RecordedCookie,
} from './support/fake-astro-cookies';
import { adminSql } from './support/local-database';

/**
 * Fail the FILE, not a test inside it, when the two variables `src/lib/auth/index.ts`
 * needs are absent. See "WHY THIS NEVER SKIPS" above for the reporting shape this
 * exists to eliminate.
 *
 * Read off `import.meta.env` rather than `process.env`, because that is what
 * `requiredEnv` reads: Vite exposes `PUBLIC_`-prefixed variables from a `.env` file AND
 * from the ambient environment, and checking the other one would pass in exactly the
 * arrangement CI uses (an exported variable, no `.env` file) or fail in exactly the one
 * a contributor uses (a `.env` file, nothing exported).
 *
 * The message names both fixes because the two audiences are different and neither can
 * act on the other's: a contributor has a `.env` to write, and CI has an action that is
 * supposed to have written the variables already.
 */
function requireAuthEnvironment(): void {
  const missing = (['PUBLIC_SUPABASE_URL', 'PUBLIC_SUPABASE_ANON_KEY'] as const).filter(
    (name) => !import.meta.env[name],
  );
  if (missing.length === 0) return;
  throw new Error(
    `${missing.join(' and ')} not set, so the auth suite cannot run — and it must never ` +
      'be reported as skipped, which is why this fails at module scope rather than in a ' +
      'hook. Locally: run `npm run db:start`, then copy API_URL and PUBLISHABLE_KEY from ' +
      "`npm run db:status` into this worktree's own .env as PUBLIC_SUPABASE_URL and " +
      'PUBLIC_SUPABASE_ANON_KEY (each git worktree runs its own stack on its own ports). ' +
      'In CI: .github/actions/local-database exports exactly those two from the stack it ' +
      'starts, so a job that reaches this line either skipped that action or ran `npm ' +
      'test` before it.',
  );
}

requireAuthEnvironment();

/** Meets `minimum_password_length = 6` with room to spare; no character-class policy is configured. */
const PASSWORD = 'CorrectHorseBattery9!';
const WRONG_PASSWORD = 'WrongPassword9!';

/** A fresh, never-used address per call. The local stack keeps `enable_confirmations =
 *  false` (config.toml's top-level value — both hosted projects override it to true since
 *  PK-56), so a sign-up here never waits on mail. A password RESET does generate mail even
 *  locally, into Mailpit, which nothing reads; a fresh address per call is also what keeps
 *  the per-address `max_frequency` floor from carrying between runs. */
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
  /** The Cookie header a really-signed-in browser sends on its next request — captured
   *  here for the fast-path assertion at the bottom of this describe. */
  let signedInCookieHeader: string;

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
    signedInCookieHeader = header;
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
   * THE PREMISE BEHIND `src/middleware.ts`'s FAST PATH, pinned against a real sign-in
   * rather than against a belief about how `@supabase/ssr` names things.
   *
   * That middleware skips its `getUser()` call — an auth-server round trip — when the
   * request carries no cookie whose name starts `sb-`. Every case in
   * tests/session-cookie.test.ts is hand-written, so all of them would go on passing if
   * the SDK renamed its cookies tomorrow: they would be edited alongside the code and
   * keep agreeing with it. This is the assertion that would not, because the header below
   * came out of a genuine `signInWithPassword` against the local Supabase.
   *
   * If this ever fails, the fast path is signing real people out on the site's front door
   * and the fix is in src/lib/session-cookie.ts — not here.
   */
  it('writes cookies the middleware’s fast path recognises as a possible session', () => {
    expect(signedInCookieHeader).not.toBe('');
    expect(hasSupabaseAuthCookie(signedInCookieHeader)).toBe(true);
  });

  // And the other direction, from the same real harness: a browser that has never signed
  // in carries nothing the fast path mistakes for a session. Without this, a function that
  // simply returned `true` would satisfy the assertion above.
  it('leaves a never-signed-in request with nothing that looks like one', () => {
    expect(hasSupabaseAuthCookie(new FakeAstroCookies().asRequestCookieHeader())).toBe(false);
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

/**
 * The sign-up form as an account-enumeration oracle, and the mapping that stops it being
 * one. See SIGN_UP_UNAVAILABLE_MESSAGE in src/lib/auth/index.ts for why "sign-up is not
 * the enumeration-sensitive case sign-in is" — which is what this module used to say, and
 * used to act on — holds only where Supabase's "Confirm email" is ON.
 *
 * It is OFF on the stack this file runs against, which is what keeps the block below
 * meaningful: PK-56 turned confirmations on for both HOSTED projects, so a duplicate
 * sign-up there is answered with a fake success instead of a refusal, and the oracle is
 * closed at the source. Locally it is not, so the refusal below is real and the mapping is
 * the only thing standing between it and a visitor — which is exactly the environment
 * every contributor browses.
 */
describe('signing up with an address that already exists', () => {
  const email = testEmail('duplicate');
  let duplicateResult: Awaited<ReturnType<typeof signUpWithPassword>>;

  beforeAll(async () => {
    const first = freshVisit();
    const created = await signUpWithPassword({
      cookies: asAstroCookies(first.cookies),
      request: first.request,
      email,
      password: PASSWORD,
    });
    if (!created.ok) throw new Error(`Fixture failed to register ${email}: ${created.error}`);

    const second = freshVisit();
    duplicateResult = await signUpWithPassword({
      cookies: asAstroCookies(second.cookies),
      request: second.request,
      email,
      password: PASSWORD,
    });
  });

  // The premise. With confirmations off GoTrue really does refuse — if it ever starts
  // answering with a fake success instead, the oracle is closed at the source and the
  // assertions below are about a branch nothing reaches.
  it('is refused', () => {
    expect(duplicateResult.ok).toBe(false);
  });

  /**
   * The property, taken from OUTSIDE the module: what a visitor is told about a duplicate
   * address is exactly what they are told about a failure the code has never heard of. If
   * those two sentences ever differ, the difference IS the disclosure — that is the whole
   * mechanism, and it does not require the message to say "already registered" in so many
   * words.
   */
  it('says nothing a fresh address would not have been told', () => {
    if (duplicateResult.ok) throw new Error('fixture assumption violated: the duplicate succeeded');
    expect(duplicateResult.error).toBe(signUpErrorMessage('a-code-this-project-has-never-seen'));
    expect(duplicateResult.error).toBe(signUpErrorMessage('user_already_exists'));
  });

  // And no provider text reaches the page. Anchored on GoTrue's own spellings rather than
  // on our message's absence of them, so this fails if the raw string is ever relayed
  // again — which is exactly how it got here.
  it('relays none of Supabase’s own wording for it', () => {
    if (duplicateResult.ok) throw new Error('fixture assumption violated: the duplicate succeeded');
    for (const leak of ['user_already_exists', 'already registered', 'User already', '422']) {
      expect(duplicateResult.error.toLowerCase()).not.toContain(leak.toLowerCase());
    }
  });

  /**
   * The other half of the rule, and the reason it is a mapping rather than one flat
   * message: a password the server calls too weak is a fact about what the visitor just
   * typed, not about who else is registered. Refusing without saying why produces people
   * retrying the same password.
   *
   * Driven through the real call rather than the pure function alone, because "does GoTrue
   * actually report weak_password for a password under minimum_password_length" is the
   * half a table-driven test cannot answer — and if it stops doing so, this project's
   * useful-feedback branch is dead and nothing else would say.
   */
  it('still tells somebody their password is too weak, in our own words', async () => {
    const visit = freshVisit();
    const result = await signUpWithPassword({
      cookies: asAstroCookies(visit.cookies),
      request: visit.request,
      email: testEmail('weak-password'),
      password: 'x',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe(signUpErrorMessage('weak_password'));
    expect(result.error).not.toBe(signUpErrorMessage('user_already_exists'));
    expect(result.error).toMatch(/password/i);
  });

  // The mapping's polarity, which is the part a future edit gets wrong: an unrecognised
  // code must fall to the NEUTRAL message, not to whatever the server said. A `default`
  // that relayed `error.message` would pass every assertion above.
  it('falls back to the neutral message for anything it does not recognise', () => {
    expect(signUpErrorMessage(undefined)).toBe(signUpErrorMessage('user_already_exists'));
    expect(signUpErrorMessage('email_exists')).toBe(signUpErrorMessage('user_already_exists'));
    expect(signUpErrorMessage('signup_disabled')).toBe(signUpErrorMessage('user_already_exists'));
    // And the recognised, non-disclosing codes really are distinguished, or the mapping is
    // one message wearing a switch statement.
    expect(signUpErrorMessage('weak_password')).not.toBe(signUpErrorMessage(undefined));
    expect(signUpErrorMessage('email_address_invalid')).not.toBe(signUpErrorMessage(undefined));
    expect(signUpErrorMessage('over_request_rate_limit')).not.toBe(signUpErrorMessage(undefined));
    expect(signUpErrorMessage('over_email_send_rate_limit')).toBe(
      signUpErrorMessage('over_request_rate_limit'),
    );
  });
});

/**
 * The reset-request form as an account-enumeration oracle, and the reason it is not one
 * (PK-56). See `requestPasswordReset` in src/lib/auth/index.ts for the argument; this is
 * the part of it that has to be measured rather than reasoned about, because the leak
 * would come from GoTrue's behaviour rather than from our copy.
 *
 * The three calls in `beforeAll` are the three cases a stranger can produce from
 * src/pages/forgot-password.astro, and the whole claim is that they are indistinguishable
 * from outside:
 *
 *   - an address that HAS an account, which really does get an email;
 *   - the SAME address again, immediately — the request that trips `[auth.email]
 *     max_frequency` (1s locally, 60s on both hosted projects), and the reason that matters
 *     is that this code is only reachable for an address that got an email in the first
 *     place, so a page that rendered "too many attempts just now" here and a confirmation
 *     elsewhere would be publishing the accounts table one guess at a time;
 *   - an address that has never been registered, which sends nothing at all.
 *
 * Whether the second one actually trips on a given run depends on how fast the two HTTP
 * requests are, and nothing here asserts that it did — that is the point. The assertion is
 * that all three answers are the same value, which holds either way, and which would fail
 * the moment somebody widened `requestPasswordReset`'s return type to let a page see the
 * difference.
 */
describe('asking for a password-reset email', () => {
  const email = testEmail('reset-request');
  let registered: Awaited<ReturnType<typeof requestPasswordReset>>;
  let repeated: Awaited<ReturnType<typeof requestPasswordReset>>;
  let unregistered: Awaited<ReturnType<typeof requestPasswordReset>>;
  let requestJar: FakeAstroCookies;

  beforeAll(async () => {
    const signUpVisit = freshVisit();
    const created = await signUpWithPassword({
      cookies: asAstroCookies(signUpVisit.cookies),
      request: signUpVisit.request,
      email,
      password: PASSWORD,
    });
    if (!created.ok) throw new Error(`Fixture failed to register ${email}: ${created.error}`);

    const requestVisit = freshVisit();
    requestJar = requestVisit.cookies;
    registered = await requestPasswordReset({
      cookies: asAstroCookies(requestJar),
      request: requestVisit.request,
      email,
    });

    const repeatVisit = freshVisit();
    repeated = await requestPasswordReset({
      cookies: asAstroCookies(repeatVisit.cookies),
      request: repeatVisit.request,
      email,
    });

    const strangerVisit = freshVisit();
    unregistered = await requestPasswordReset({
      cookies: asAstroCookies(strangerVisit.cookies),
      request: strangerVisit.request,
      email: testEmail('never-registered-reset'),
    });
  });

  it('answers a registered and an unregistered address with the identical value', () => {
    expect(registered).toEqual({ ok: true });
    expect(unregistered).toEqual(registered);
  });

  it('answers a rate-limited repeat exactly the same way', () => {
    expect(repeated).toEqual(registered);
  });

  /**
   * NOT VACUOUS, and this is the assertion that makes the two above mean something. Three
   * identical values are also what a `requestPasswordReset` that did nothing at all would
   * produce, so something has to show that the call really reached GoTrue for the
   * registered address — and it has to be something the VISITOR cannot see, or it would be
   * the leak.
   *
   * `auth.users.recovery_sent_at` is exactly that: server-side state, set by GoTrue when it
   * issues a recovery link, readable here only through a superuser connection. The
   * asymmetry between a registered address and an unregistered one is real and it lives in
   * the database, which is where it belongs; what the response says is the same either way.
   */
  it('really did issue a recovery link for the registered address', async () => {
    const rows = await adminSql<{ recovery_sent_at: Date | null }>(
      'select recovery_sent_at from auth.users where email = $1',
      [email],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].recovery_sent_at).not.toBeNull();
  });

  /**
   * The other half of "it really ran": the PKCE verifier. `@supabase/ssr` builds a
   * code-challenge for the recovery link and stores its verifier through the same `setAll`
   * every other operation in src/lib/auth/index.ts writes cookies with — and
   * `exchangeCodeForSession` at src/pages/auth/callback.ts cannot complete the link
   * without it. That is also why the expired-link copy on src/pages/update-password.astro
   * says "only in the browser that asked": a reset link opened somewhere else has no
   * verifier to present.
   *
   * ASSERTED BY NAME, which it was not until the PK-56 review. The original assertion was
   * `entries().length > 0` — "some cookie was written" — which is true of a session cookie,
   * a chunked session fragment, or anything else `@supabase/ssr` felt like setting, none
   * of which is a PKCE verifier. The test's name and the comment above were the only place
   * the actual claim existed, and neither is executable.
   *
   * The name to match on is a SUFFIX, because the prefix is not stable: `@supabase/ssr`
   * derives it from the project ref in PUBLIC_SUPABASE_URL, so this stack writes
   * `sb-127-auth-token-code-verifier` (the URL is a loopback address) and a hosted project
   * writes `sb-<ref>-auth-token-code-verifier`. `-code-verifier` is the part that says what
   * the cookie IS rather than which project it belongs to. Observed on this stack, for the
   * record: a reset request writes three names, all ending `-code-verifier`, and no session
   * cookie at all — which is itself the reason the old assertion was so easy to satisfy by
   * accident in the OTHER blocks of this file, where a sign-up does write one.
   */
  it('leaves this browser the PKCE verifier the emailed link will be exchanged against', () => {
    const names = requestJar.entries().map(([name]) => name);
    expect(names, 'the reset request wrote no cookies at all').not.toEqual([]);
    expect(
      names.filter((name) => /^sb-.+-code-verifier$/.test(name)),
      `no PKCE code-verifier cookie among ${JSON.stringify(names)}`,
    ).not.toEqual([]);
  });
});

/**
 * `updatePassword` — the far end of the reset journey, driven exactly as
 * src/pages/update-password.astro drives it: a request carrying a session (there, one the
 * callback route just exchanged a recovery code for; here, one a sign-up wrote, which is
 * the same object to this function) and a new password.
 *
 * What the page cannot be tested for is covered by what this block asserts about the
 * function: that the new password really replaces the old one on the auth server, rather
 * than the call merely returning `{ ok: true }`.
 */
describe('choosing a new password', () => {
  const email = testEmail('update-password');
  const NEW_PASSWORD = 'AnotherCorrectHorse9!';
  let weakResult: Awaited<ReturnType<typeof updatePassword>>;
  let updateResult: Awaited<ReturnType<typeof updatePassword>>;
  let signInWithNew: Awaited<ReturnType<typeof signInWithPassword>>;
  let signInWithOld: Awaited<ReturnType<typeof signInWithPassword>>;

  beforeAll(async () => {
    const signUpVisit = freshVisit();
    const created = await signUpWithPassword({
      cookies: asAstroCookies(signUpVisit.cookies),
      request: signUpVisit.request,
      email,
      password: PASSWORD,
    });
    if (!created.ok) throw new Error(`Fixture failed to register ${email}: ${created.error}`);
    const sessionHeader = signUpVisit.cookies.asRequestCookieHeader();

    // The refusal FIRST, while the old password is still the current one — so the
    // successful change below cannot be what made this fail, and so no extra sign-up is
    // needed to observe it.
    const weakVisit = continueWith(sessionHeader);
    weakResult = await updatePassword({
      cookies: asAstroCookies(weakVisit.cookies),
      request: weakVisit.request,
      password: 'x',
    });

    const updateVisit = continueWith(sessionHeader);
    updateResult = await updatePassword({
      cookies: asAstroCookies(updateVisit.cookies),
      request: updateVisit.request,
      password: NEW_PASSWORD,
    });

    const newVisit = freshVisit();
    signInWithNew = await signInWithPassword({
      cookies: asAstroCookies(newVisit.cookies),
      request: newVisit.request,
      email,
      password: NEW_PASSWORD,
    });

    const oldVisit = freshVisit();
    signInWithOld = await signInWithPassword({
      cookies: asAstroCookies(oldVisit.cookies),
      request: oldVisit.request,
      email,
      password: PASSWORD,
    });
  });

  it('accepts the new password for the session that asked', () => {
    expect(updateResult.ok).toBe(true);
    if (!updateResult.ok) return;
    expect(updateResult.user.email).toBe(email);
  });

  // The claim the assertion above cannot make on its own: `{ ok: true }` is also what a
  // function that called nothing would return. Signing in for real is what proves the
  // auth server changed its mind about this account.
  it('the new password really signs in afterwards', () => {
    expect(signInWithNew.ok).toBe(true);
  });

  it('and the old one no longer does', () => {
    expect(signInWithOld.ok).toBe(false);
  });

  /**
   * Driven through the real call rather than through `passwordUpdateErrorMessage` alone,
   * for the reason the sign-up block gives for the same test: whether GoTrue actually
   * reports `weak_password` for a password under `minimum_password_length` is the half a
   * table-driven test cannot answer, and if it stops doing so this project's
   * useful-feedback branch is dead with nothing else to say so.
   */
  it('refuses a password the server calls too weak, in our own words', () => {
    expect(weakResult.ok).toBe(false);
    if (weakResult.ok) return;
    expect(weakResult.error).toBe(passwordUpdateErrorMessage('weak_password'));
    expect(weakResult.error).not.toBe(passwordUpdateErrorMessage(undefined));
    expect(weakResult.error).toMatch(/password/i);
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

  /**
   * `secure`, which the assertion above deliberately left out and should not have. A
   * review deleted `secure: !import.meta.env.DEV` from REQUIRED_COOKIE_ATTRIBUTES and
   * every test in this file stayed green — so the one attribute that decides whether a
   * session token may cross the network in clear text was the one nothing checked.
   * `@supabase/ssr` sets no `secure` of its own (grep the package: the string does not
   * appear), which is exactly why removing ours leaves `undefined` rather than a weaker
   * value, and why nothing else would ever have noticed.
   *
   * ASSERTED AGAINST `!import.meta.env.DEV` RATHER THAN AGAINST `true`, and the
   * difference is the whole point of the attribute being conditional at all. Browsers
   * refuse to store a `Secure` cookie set over plain HTTP, and `npm run dev` serves
   * `http://localhost:4321` — a hard `secure: true` would make sign-in silently fail to
   * persist for every contributor running the dev server. So the production value is
   * `true` and the dev-server value is `false`, and what this file can honestly pin is
   * that the module derives it from that one signal rather than hardcoding either
   * answer. This suite runs with `DEV` true (vitest's mode is `test`, not a build), so
   * the concrete expectation here is `false` — which is still enough to fail the
   * deletion, because `undefined` is neither.
   *
   * The two halves are asserted separately on purpose. `toBe(expected)` alone would also
   * pass if a future edit hardcoded `secure: false`, which is the mutation that matters
   * most: it is invisible in dev, ships every session token over plain HTTP in
   * production, and reads like a simplification. So the type is pinned too — a boolean,
   * derived, never absent.
   */
  it('every cookie carries secure, set from the dev/production distinction and not hardcoded', () => {
    const expected = !import.meta.env.DEV;
    for (const [name, { options }] of recorded) {
      expect(
        typeof options?.secure,
        `${name} must set secure explicitly, not leave it absent`,
      ).toBe('boolean');
      expect(
        options?.secure,
        `${name} must be secure: ${expected} — this build has import.meta.env.DEV === ${import.meta.env.DEV}`,
      ).toBe(expected);
    }
  });
});

/**
 * Which cookies in `jar` were NOT given a clearing directive, out of the names the
 * session was carried in.
 *
 * THIS IS THE FIX FOR A TEST THAT COULD NOT FAIL, and the shape of the hole is worth
 * keeping written down because it is easy to rebuild by accident. The original version of
 * the block below asserted only the OUTCOME — sign out, forward the outgoing jar as the
 * next request's `Cookie` header, expect no user. `asRequestCookieHeader()` builds that
 * header from cookies the jar was told to SET, so a jar that was told nothing produces an
 * empty header, and an empty header produces no user. "Cleared the session cookie" and
 * "emitted no `Set-Cookie` at all" are therefore the same green. Verified by patching
 * `setAll` in src/lib/auth/index.ts to write nothing on sign-out: all fifteen tests in
 * this file passed, while the real browser — which still holds the cookies nobody told it
 * to drop — stayed signed in.
 *
 * So the assertion has to be about what was WRITTEN. Every name the session arrived under
 * must come back with `maxAge: 0` or an `expires` already past, which are the two ways a
 * `Set-Cookie` says "delete this". That is also what makes PARTIAL clearing a failure:
 * `@supabase/ssr` splits a session that outgrows one cookie into `…auth-token.0`,
 * `…auth-token.1` and so on, and a sign-out that cleared `.0` and left `.1` behind leaves
 * a fragment the browser keeps sending — this returns `.1`, by name, rather than
 * summarising to a count that a half-cleared jar would satisfy.
 *
 * A pure function over the jar, so the partial case can be exercised directly (see the
 * unit test below). It has to be: the local stack's session fits in a single cookie, so
 * no real sign-up here ever produces chunks to half-clear.
 */
function uncleared(names: readonly string[], jar: FakeAstroCookies): string[] {
  const written = new Map(jar.entries());
  return names.filter((name) => {
    const options = written.get(name)?.options;
    if (!options) return true;
    return !(
      options.maxAge === 0 ||
      (options.expires !== undefined && options.expires.getTime() <= Date.now())
    );
  });
}

describe('sign out clears the session', () => {
  let sessionCookieNames: string[];
  let sessionCookieHeader: string;
  let signOutJar: FakeAstroCookies;
  let signOutResult: Awaited<ReturnType<typeof signOut>>;

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
    sessionCookieNames = visit.cookies.entries().map(([name]) => name);
    sessionCookieHeader = visit.cookies.asRequestCookieHeader();

    // Prove the session works BEFORE sign-out touches it, so the assertions below show
    // sign-out caused the loss rather than the fixture never having had a working
    // session to lose.
    const check = continueWith(sessionCookieHeader);
    const userBefore = await getUser({
      cookies: asAstroCookies(check.cookies),
      request: check.request,
    });
    if (!userBefore)
      throw new Error('Fixture session did not work before sign-out — nothing to prove');

    // One sign-out, whose outgoing jar every assertion below reads. Kept rather than
    // rebuilt per test so "what the response actually told the browser" and "what the
    // browser does next" are two questions about the same event.
    const signOutVisit = continueWith(sessionCookieHeader);
    signOutJar = signOutVisit.cookies;
    signOutResult = await signOut({
      cookies: asAstroCookies(signOutJar),
      request: signOutVisit.request,
    });
  });

  it('succeeds', () => {
    expect(signOutResult.ok).toBe(true);
  });

  /**
   * The response TELLS THE BROWSER to drop every cookie the session was carried in. This
   * is the assertion the outcome test below cannot make, because a sign-out that emitted
   * nothing at all looks identical to it — see `uncleared` above.
   */
  it('writes a clearing directive for every cookie the session was carried in', () => {
    // Not vacuous: an empty name list would make the assertion below true for free.
    expect(sessionCookieNames.length).toBeGreaterThan(0);
    expect(uncleared(sessionCookieNames, signOutJar)).toEqual([]);
  });

  it('a request carrying the resulting cookies has no user', async () => {
    // asRequestCookieHeader() honours maxAge: 0 by dropping the cookie entirely — see
    // that method's own comment for why that, and not merely "carry forward whatever
    // value was written", is what a real browser would do.
    const clearedHeader = signOutJar.asRequestCookieHeader();
    const after = continueWith(clearedHeader);
    const user = await getUser({ cookies: asAstroCookies(after.cookies), request: after.request });
    expect(user).toBeNull();
  });

  /**
   * The chunked case, which this stack cannot produce on its own: a local session fits in
   * one cookie, so no sign-up above ever creates a `.0`/`.1` pair for a real sign-out to
   * half-clear. `@supabase/ssr` splits any session that outgrows a browser's ~4kB cookie
   * limit — a longer email, a bigger `user_metadata`, a provider token — so the case is a
   * production one rather than an exotic one, and a sign-out that cleared the first chunk
   * and left the second would leave a fragment the browser keeps sending forever.
   *
   * Exercised against the predicate directly, on a jar built by hand. The alternative is
   * an assertion that reads correctly and, on this stack, is only ever handed one cookie.
   */
  it('counts a half-cleared chunked session as uncleared, by naming the chunk left behind', () => {
    const jar = new FakeAstroCookies();
    jar.set('sb-auth-token.0', '', { maxAge: 0, path: '/' });
    jar.set('sb-auth-token.1', 'still-here', { maxAge: 34560000, path: '/' });

    expect(uncleared(['sb-auth-token.0', 'sb-auth-token.1'], jar)).toEqual(['sb-auth-token.1']);
    // A past `expires` is the other way a Set-Cookie says "delete this", and is accepted
    // as clearing for the same reason FakeAstroCookies honours it.
    jar.set('sb-auth-token.1', '', { expires: new Date(Date.now() - 1000), path: '/' });
    expect(uncleared(['sb-auth-token.0', 'sb-auth-token.1'], jar)).toEqual([]);
    // And a cookie nobody wrote at all is uncleared, which is the whole defect: the
    // browser still holds it.
    expect(uncleared(['sb-auth-token.2'], jar)).toEqual(['sb-auth-token.2']);
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
