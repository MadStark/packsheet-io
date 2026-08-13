/**
 * The auth choke point.
 *
 * This module is the ONLY place in the codebase that is allowed to import or
 * re-export an authentication SDK. Every other module — every page, every layout,
 * every component, and middleware in either spelling Astro accepts (`src/middleware.ts`,
 * which this project now has, or `src/middleware/index.ts`) — must reach it by going
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
 * Invariant D has a second half, added after a review shipped the whole GoTrue stack to
 * every anonymous reader with the rule above green: NO module in the client pass may BE,
 * or import, any `@supabase/*` package. The first half is anchored on this directory and
 * that allowlist, and neither is touched by a component that writes
 * `import { createBrowserClient } from '@supabase/ssr'` and hydrates itself — the SDK is
 * an ordinary runtime dependency now, so the choke point is not the only door to it. Note
 * that this is NOT a ban on `@supabase/*` outside this directory: that would contradict
 * the Ref 55 decision recorded below and break the share page before it is written. It is
 * a rule about the RUNTIME. Nothing needs Supabase in a browser today; when something
 * genuinely does, the failure message says in as many words that it is a deliberate
 * revisit rather than a build to get past.
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
 * test file and no others, and this project still holds no privileged Supabase secret in
 * any environment for it to have been checked against — every Supabase value .env.example
 * and the two deploy workflows carry is a PUBLIC_ one (the project URL and the publishable
 * anon key), and wrangler.jsonc declares no such secret. Whoever introduces one must check its name against that list and
 * add it if it is missing. A name-bound rule that does not know the name in use is not a
 * weaker guardrail; it is a permanently green one, while the key ships.
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
 * through the functions exported here. Eight modules do now — `src/middleware.ts`, the
 * sign-in, sign-up and account pages, the two password-reset pages PK-56 added, and the
 * two `/auth/*` endpoints — each named on AUTH_CONSUMERS with a comment saying what it
 * does with auth, and each server-only. The API is deliberately thin: build a
 * request-scoped client, perform one auth operation, hand back a result. Nothing here
 * accumulates state across requests, and nothing here is a place to grow a second,
 * parallel copy of what `@supabase/supabase-js` already does.
 *
 * Three exports are not operations, and all three are message-shaped for the same reason:
 * `signUpErrorMessage` and `passwordUpdateErrorMessage`, pure functions from an error CODE
 * to the sentence a visitor is shown, and `PASSWORD_RESET_REQUESTED_MESSAGE`, the single
 * sentence the reset-request page shows whatever happened. They are exported because what
 * each of them SAYS is the security rule — an account-enumeration rule in two of the three
 * cases — and a rule that can only be read off the source is one nothing pins.
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
// The one import this directory makes of a first-party module, and it points OUTWARDS —
// src/lib/auth-routes.ts holds no SDK and imports nothing, so this creates no cycle and
// no new edge for Invariant A to see (that rule is about edges INTO this directory).
// Taken rather than duplicated because `authCallbackUrl` below has to name the exact path
// src/pages/auth/callback.ts answers and the exact `?next=` page the recovery link must
// land on; a second spelling of either is a link that silently goes somewhere else.
import { AUTH_CALLBACK_PATH, NEXT_PARAM, UPDATE_PASSWORD_PATH } from '../auth-routes';

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
 * The single message shown for every sign-up this project will not complete, whatever
 * the reason — including, and especially, "that address is already registered".
 *
 * WHY THIS IS NOT THE SAME QUESTION AS THE PARAGRAPH ABOVE, and why an earlier version of
 * this file was wrong to treat it as a milder one. It used to return Supabase's own
 * `error.message` verbatim here, reasoning that a project's "Confirm email" setting
 * already governs whether a duplicate address is disclosed. That reasoning is sound as far
 * as it goes: with confirmations ON, GoTrue deliberately answers a duplicate sign-up with
 * a fake success and sends a "you already have an account" email, so nothing leaks to the
 * form; with them OFF there is nobody to email, so it answers `422 user_already_exists`,
 * and a form that renders that string back is an oracle — type an address, read the
 * answer, learn whether that person has an account here. Free, unauthenticated, one
 * request per guess, on the one page designed to accept a stranger's input. The neutral
 * sign-in message above closed exactly this hole one function down; the sign-up form
 * reopened it.
 *
 * ---------------------------------------------------------------------------
 * THE PREMISE MOVED IN PK-56. THE CONCLUSION DID NOT.
 * ---------------------------------------------------------------------------
 *
 * This comment used to justify itself with one flat fact — "THIS project has
 * confirmations OFF" — and that sentence is now false of the environments that matter
 * most. PK-56 set `enable_confirmations = true` under `[remotes.staging.auth.email]` and
 * `[remotes.production.auth.email]` in supabase/config.toml, so both hosted projects
 * confirm email. What did NOT change is the file's top-level `enable_confirmations =
 * false`, which is the LOCAL stack: `npm run dev`, `npm test`, and every contributor's
 * manual walkthrough still run with confirmations off. There is no single answer to "is
 * this project confirmations-on" any more, and code that assumes either one is wrong
 * somewhere.
 *
 * Re-derived from that split state rather than from the old premise, the mapping stays
 * exactly as it is, for four reasons — none of which was the sentence that expired:
 *
 *   1. THE ORACLE IS STILL LIVE, in dev and in CI. `user_already_exists` is precisely what
 *      the local stack still returns for a duplicate, so a `default` that relayed
 *      `error.message` would put a provider string in front of every contributor's browser
 *      and be pinned as correct by every test run. "Only staging and production are safe"
 *      is not a property worth having when the form is identical in all three.
 *   2. THE POLARITY ARGUMENT NEVER DEPENDED ON THE SETTING. `signUpErrorMessage`'s default
 *      is neutral so that a code nobody has heard of discloses nothing. That is a claim
 *      about unknown futures, not about confirmations, and turning a setting on somewhere
 *      does not make an unrecognised code safe to relay.
 *   3. NEVER RENDERING PROVIDER TEXT is a rule about strings, not about settings. GoTrue's
 *      phrasing changes between versions and is not written for this audience; that is
 *      true of a confirmations-on project too.
 *   4. CONFIRMATIONS-ON ADDS A CODE RATHER THAN REMOVING ONE. With email actually being
 *      sent, `over_email_send_rate_limit` becomes reachable from this form — and it is
 *      reachable SYMMETRICALLY, because a duplicate sign-up and a fresh one both send
 *      mail (the "you already have an account" notice and the confirmation link
 *      respectively), so the rate-limit message distinguishes nothing about the accounts
 *      table. It is already mapped, one switch case down, and it stays mapped.
 *
 * WHAT THAT SPLIT DOES AND DOES NOT CLOSE, stated here rather than left for somebody to
 * discover and treat as a regression. The residual hole this comment used to end on — a
 * duplicate FAILS while a fresh address SUCCEEDS, so the OUTCOME distinguishes them
 * however carefully the message is worded — is now closed on both hosted projects and
 * still open locally. Closing it means answering a duplicate with the same "check your
 * inbox" screen a genuine pending sign-up gets, which is exactly what GoTrue's fake
 * success produces and what `src/pages/sign-up.astro` renders when `getUser` finds no
 * session afterwards. This comment used to say that fix "belongs to whoever turns
 * confirmations on"; PK-56 is that ticket, and it took it, at the cost it named — somebody
 * who already has an account is told to check their inbox, and what arrives is a "you
 * already have an account" email rather than a confirmation link. Locally the outcome
 * still differs, and that is the right way round: the environment where an attacker can
 * probe is the one that is closed.
 *
 * It says "sign in instead" for every failure rather than only for the duplicate one,
 * which is what keeps it from being a hint. A visitor who genuinely does have an account
 * is told the useful thing; a visitor who does not is told the same thing, and learns
 * nothing from being told it. What this constant closes, in every environment, is the
 * free-text half: the response never NAMES the reason, so no provider string reaches a
 * visitor from this path at all.
 */
const SIGN_UP_UNAVAILABLE_MESSAGE =
  'We could not create an account with those details. If you already have an account, sign ' +
  'in instead.';

/**
 * The exception, and the reason this is a mapping rather than one flat message. A password
 * the server rejects as too weak is a fact about what the visitor just typed, not about
 * who else is registered here — telling them costs nothing and NOT telling them is a form
 * that refuses without saying why, which people retry with the same password.
 *
 * Written here rather than relayed, for the rule this whole block exists to keep: never
 * put a provider's own error text in front of a visitor. Supabase's phrasing for this
 * changes between versions, is not written for this audience, and — the part that
 * matters — nothing about a string arriving from an auth server makes it safe to render
 * once somebody decides a different branch may reach the same code path.
 *
 * The "6" matches `auth.minimum_password_length` in supabase/config.toml and the
 * `minlength="6"` on the sign-up form. Three copies of one number is worse than one, and
 * the alternative is worse still: the length is a server setting, not something a browser
 * bundle may read, and inventing a way to plumb it here would put a Supabase config lookup
 * on a page render to save a literal.
 */
const WEAK_PASSWORD_MESSAGE =
  'That password is too weak. Use at least 6 characters — length matters more than ' +
  'punctuation.';

/** The other non-enumerating failure worth naming: the address is not a usable one. Says
 *  nothing about whether it is registered, because it is a judgement about the string the
 *  visitor typed rather than about the accounts table. */
const INVALID_EMAIL_MESSAGE = 'That does not look like an email address we can use.';

/** Rate limiting, which a visitor can act on (wait) and which discloses nothing. Without
 *  this the neutral message above would send somebody who has simply tried three times in
 *  a minute to a sign-in page they have no account on. */
const TOO_MANY_ATTEMPTS_MESSAGE = 'Too many attempts just now. Wait a minute and try again.';

/**
 * What a visitor is told about a failed sign-up, chosen from the error's CODE and never
 * from its text.
 *
 * The default is the neutral message, so a code this function has not heard of — a new
 * one, a provider-specific one, anything GoTrue adds later — discloses nothing rather
 * than falling through to whatever the server happened to say. That polarity is the whole
 * design: an unrecognised failure must be silent about the accounts table, not verbose.
 *
 * `user_already_exists` and `email_exists` are deliberately absent from the switch. They
 * are the enumeration case, they take the default, and they are named here so that
 * somebody adding a case for them has to read this sentence first.
 *
 * Exported, unlike everything else in this file that is not an operation, so that
 * tests/auth-flow.test.ts can assert the mapping from OUTSIDE the module — that an
 * unrecognised code and the duplicate-address code produce the identical sentence is the
 * property that matters, and reading it off the source is not the same as pinning it.
 */
export function signUpErrorMessage(code: string | undefined): string {
  switch (code) {
    case 'weak_password':
      return WEAK_PASSWORD_MESSAGE;
    case 'email_address_invalid':
      return INVALID_EMAIL_MESSAGE;
    case 'over_email_send_rate_limit':
    case 'over_request_rate_limit':
      return TOO_MANY_ATTEMPTS_MESSAGE;
    default:
      return SIGN_UP_UNAVAILABLE_MESSAGE;
  }
}

/**
 * The one and only sentence `src/pages/forgot-password.astro` shows after a reset request
 * — for an address that has an account, for an address that does not, and for a request
 * that failed outright (PK-56).
 *
 * The wording carries the whole rule, which is why it is a named constant here beside the
 * other messages rather than a literal in the page: it must be true in every case without
 * asserting any of them. "If there is an account" is not politeness, it is the entire
 * design — a page that said "we have emailed you" would be an account-enumeration oracle
 * in one sentence, the same shape as the sign-up one described at length above, and on a
 * page whose whole purpose is to accept an address from somebody who is not signed in.
 *
 * See `requestPasswordReset` for the other half, which is the half that is easy to get
 * wrong: a message that never varies is worth nothing if the ERROR HANDLING around it
 * varies instead.
 */
export const PASSWORD_RESET_REQUESTED_MESSAGE =
  'If there is a Packsheet account for that address, a link to choose a new password is ' +
  'on its way. The link can only be used once, so ask again if you need another.';

/** Shown when the visitor's new password is the one they already have. Says nothing about
 *  anybody else's account — it is a fact about the account they are already signed in to —
 *  and telling them is what stops a "nothing happened" retry loop. */
const SAME_PASSWORD_MESSAGE = 'That is already your password. Choose a different one.';

/** The neutral fallback for a password update this project could not complete. Recovery
 *  sessions are short-lived and single-use, so by far the likeliest cause is a link that
 *  expired or was already spent — which is actionable, and which is why this points at
 *  starting over rather than at trying the same form again. */
const PASSWORD_UPDATE_UNAVAILABLE_MESSAGE =
  'We could not change your password. The reset link may have expired or already been ' +
  'used — request a new one and try again.';

/**
 * What a visitor is told about a failed `updatePassword`, chosen from the error's CODE and
 * never from its text — the same rule as `signUpErrorMessage`, for the same reason, with
 * one difference worth being explicit about (PK-56).
 *
 * ACCOUNT ENUMERATION IS NOT THE THREAT HERE, and pretending it is would produce a worse
 * page rather than a safer one. Everyone who reaches this function is already holding a
 * verified session for the account they are about to change — they clicked a link that was
 * mailed to that address and exchanged it for a session at `AUTH_CALLBACK_PATH`. There is
 * no unregistered address to be told apart from a registered one, because there is no
 * address on the form at all. So the useful failures are named: too weak, unchanged,
 * rate-limited.
 *
 * The default is still neutral and still points somewhere the visitor can act, because the
 * OTHER rule has not moved: a code this function has not heard of must produce a
 * hand-written sentence, never GoTrue's own. `session_not_found` and friends land there
 * deliberately — "your session is gone" and "your link expired" are the same event to
 * somebody who followed a link from an email, and `PASSWORD_UPDATE_UNAVAILABLE_MESSAGE`
 * says the thing that gets them a working link.
 *
 * Exported for the same reason `signUpErrorMessage` is: the mapping is the rule, and a
 * rule that is only readable in the source is one nothing pins.
 */
export function passwordUpdateErrorMessage(code: string | undefined): string {
  switch (code) {
    case 'weak_password':
      return WEAK_PASSWORD_MESSAGE;
    case 'same_password':
      return SAME_PASSWORD_MESSAGE;
    case 'over_email_send_rate_limit':
    case 'over_request_rate_limit':
      return TOO_MANY_ATTEMPTS_MESSAGE;
    default:
      return PASSWORD_UPDATE_UNAVAILABLE_MESSAGE;
  }
}

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
 * The absolute URL a link in an email must send the visitor back to: `AUTH_CALLBACK_PATH`
 * on the origin this request arrived at, optionally carrying a `?next=` for the callback
 * to forward them to afterwards (PK-56).
 *
 * WHY IT HAS TO BE ABSOLUTE, and why passing nothing is not the neutral choice it looks
 * like. `signUp` and `resetPasswordForEmail` both accept a redirect and both fall back to
 * the Supabase project's own `site_url` when given none — so the link in the email lands
 * on the HOMEPAGE, carrying a one-time `?code=` that nothing on that page will ever
 * exchange, and the visitor arrives still signed out with no indication anything went
 * wrong. `src/pages/auth/callback.ts` is the only route in this project that exchanges a
 * code, so every email link has to name it. A relative path cannot: the URL is assembled
 * by the auth server and opened from a mail client, where there is nothing for it to be
 * relative to.
 *
 * THE ORIGIN COMES FROM THE REQUEST, which is not a new way of computing one — it is the
 * existing way, moved one call inwards. `sign-in.astro` and `sign-up.astro` already build
 * the `redirectTo` they hand `getGoogleAuthorizationUrl` as `new URL(AUTH_CALLBACK_PATH,
 * Astro.url.origin)`, and `Astro.url` is this same request's URL; the only difference here
 * is that these two operations are given no `redirectTo` parameter to build, so the module
 * reads the origin off the `request` every function here already takes. Deliberately NOT a
 * configured site URL or an environment variable: a second source of truth for the origin
 * is a value that is right in production and wrong on a preview deployment, a
 * `wrangler dev` on 8787 and a contributor's `astro dev` on 4321 — i.e. wrong in exactly
 * the places nobody is watching for it.
 *
 * What this does NOT decide is whether the redirect is permitted. That is the Supabase
 * project's `additional_redirect_urls` allow-list (supabase/config.toml), which is
 * checked by GoTrue and silently falls back to `site_url` for a URL that is not on it —
 * so a new origin needs a line there as well as this function being correct.
 */
function authCallbackUrl(request: Request, next?: string): string {
  const url = new URL(AUTH_CALLBACK_PATH, request.url);
  if (next !== undefined) url.searchParams.set(NEXT_PARAM, next);
  return url.toString();
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

/**
 * Registers a new account.
 *
 * `emailRedirectTo` is not optional decoration (PK-56). Both hosted projects confirm email
 * now, so this call sends a confirmation link — and without this option GoTrue builds that
 * link from the project's `site_url`, which drops the visitor on the homepage holding a
 * code no route there exchanges. See `authCallbackUrl` for why the origin comes from the
 * request rather than from configuration.
 *
 * DELIBERATELY WITHOUT A `?next=`, unlike the reset link below, which is the one asymmetry
 * between the two. A confirmation link is opened whenever the person gets round to their
 * inbox — an hour later, on a different device, in a webmail client's own browser — so the
 * `next` that was meaningful when they submitted the form ("claim this pack") is a
 * destination they may well no longer be looking at, on a device that never saw the page
 * that set it. `AUTH_CALLBACK_PATH` with no `next` resolves through `safeNextPath` to
 * `HOME_PATH`, and `/` sends a newly confirmed visitor — who by then has a session — to
 * their own gear closet. That is a better landing than the `ACCOUNT_PATH` this used to
 * resolve to (a settings screen nobody had asked for), and it needed no change here: the
 * destination moved because `safeNextPath`'s fallback did. See src/lib/routes.ts.
 */
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
    options: { emailRedirectTo: authCallbackUrl(params.request) },
  });
  // Mapped from the error CODE, never relayed from its text — see signUpErrorMessage and
  // SIGN_UP_UNAVAILABLE_MESSAGE above. This function used to return `error.message`
  // verbatim on the reasoning that sign-up is not the enumeration-sensitive case sign-in
  // is; with `enable_confirmations = false` it is exactly that case, and the form was an
  // account-enumeration oracle for as long as it was.
  if (error) return { ok: false, error: signUpErrorMessage(error.code) };
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

/**
 * Sends a password-reset email, and reports the SAME thing whatever happens (PK-56).
 *
 * ---------------------------------------------------------------------------
 * THE RETURN TYPE IS THE POINT
 * ---------------------------------------------------------------------------
 *
 * `Promise<{ ok: true }>` rather than the `AuthResult` every other operation in this file
 * hands back, and that is a deliberate narrowing rather than an oversight. This operation
 * has exactly one outcome a caller may observe, so the type says exactly one outcome, and
 * a page cannot branch on something it was never given. The alternative — return an
 * `AuthResult` and rely on `forgot-password.astro` to ignore the `false` arm — is a rule
 * that has to be remembered by every future editor of that page, on a page where
 * forgetting it is a security bug rather than a rendering bug. `{ ok: true }` is still
 * assignable to `AuthResult`, so nothing about the shape of this module changes for a
 * caller that treats it uniformly.
 *
 * WHY IT MUST NOT VARY, which is the whole of the threat model here. This is the one form
 * on the site that takes an email address from somebody who is not signed in and acts on
 * it. `resetPasswordForEmail` itself is careful — GoTrue answers 200 for an address it has
 * never seen, and sends nothing — so Supabase does not leak. THE ERROR HANDLING IS WHERE
 * THE LEAK WOULD BE, and it is not hypothetical:
 *
 *   - `over_email_send_rate_limit` can only be reached by a request that actually TRIED to
 *     send mail, and mail is only sent for an address that HAS an account. A page that
 *     renders "too many attempts just now" for that code and "check your inbox" otherwise
 *     has published the accounts table one address at a time, using an error message that
 *     looks, in isolation, like exactly the helpful thing to say — and `signUpErrorMessage`
 *     one screen up maps that same code to that same helpful sentence, correctly, because
 *     on that form it distinguishes nothing.
 *   - `max_frequency` (60s per address on both hosted projects) is the same shape at a
 *     different scale: ask twice in a minute and the second answer differs, but only for an
 *     address that got an email the first time.
 *   - An unrecognised failure — Supabase unreachable, SMTP down, a code that does not exist
 *     yet — is not enumerating anything, but a page that renders "something went wrong" for
 *     it and a confirmation otherwise still gives an attacker a signal to compare, and
 *     nobody auditing this later can tell which of the two kinds of failure they are
 *     looking at from the outside. Collapsing all of them is what makes the property
 *     checkable rather than argued.
 *
 * WHAT IS GIVEN UP, said plainly rather than left as a surprise: a genuine outage is
 * invisible to the visitor AND to this codebase. Somebody whose reset email never arrives
 * because SMTP is down is shown the same reassuring sentence as somebody whose email is on
 * its way. That is the accepted cost — the alternative reintroduces the oracle — and it is
 * why the observability for this path is deliberately elsewhere: Supabase's auth logs and
 * Resend's own delivery dashboard see every one of these failures, and neither is reachable
 * from a page a stranger can load. Do not "improve" this by surfacing the error; improve it
 * by looking there.
 *
 * The `redirectTo` sends the visitor through `AUTH_CALLBACK_PATH` — the SAME PKCE exchange
 * route Google sign-in uses, already tested, already re-validating its `next` through
 * `safeNextPath` — with `?next=` set to `UPDATE_PASSWORD_PATH`, so a recovery link arrives
 * at the new-password form with a live session already written to cookies. A second
 * code-exchange implementation living on the update-password page is the thing this
 * deliberately does not do.
 */
export async function requestPasswordReset(params: {
  cookies: AstroCookies;
  request: Request;
  email: string;
}): Promise<{ ok: true }> {
  const client = createAuthClient(params.cookies, params.request);
  // The result is dropped, on purpose and in the one place where dropping it is the
  // security property rather than a lapse — see this function's own comment. Awaited
  // rather than left floating: an unawaited promise here would let the response be sent
  // before the request to GoTrue was made, and a Worker is free to stop executing once it
  // has answered.
  await client.auth.resetPasswordForEmail(params.email, {
    redirectTo: authCallbackUrl(params.request, UPDATE_PASSWORD_PATH),
  });
  return { ok: true };
}

/**
 * Sets a new password for whoever this request's session belongs to (PK-56).
 *
 * There is no email, no user id and no "current password" parameter, and all three
 * absences are the same decision: the ONLY account this can change is the one the request
 * is already authenticated as, because that is the account `createAuthClient` built a
 * client for. A recovery link is exchanged into exactly such a session at
 * `AUTH_CALLBACK_PATH` before the visitor ever reaches the form, so the link itself is the
 * proof of address, and the form has nothing left to identify.
 *
 * THE MISSING "CURRENT PASSWORD" IS THE ONE OF THE THREE WITH A SECURITY ARGUMENT ON BOTH
 * SIDES, and it was reviewed rather than defaulted (PK-56 review): holding a session is
 * sufficient here, so a stolen session can change a password and revoke the owner's other
 * sessions. The reasoning for accepting that — chiefly that the same session can already
 * call `deleteOwnAccount` below, and that the forgot-password journey is by definition
 * made of people who do not know their current password — and, more usefully, the two
 * things that would REVERSE it, are written out in full in the doc comment at the top of
 * src/pages/update-password.astro. Read that before adding a second caller: the realistic
 * trigger for change is this function being reached from a signed-in settings screen,
 * where the argument does not hold.
 *
 * That also means a caller must not treat "there is no session" as this function's problem
 * to report: `src/pages/update-password.astro` checks `Astro.locals.user` and renders a
 * neutral expired-link state instead of posting into this at all. What remains for
 * `passwordUpdateErrorMessage` is the narrow set of things that can go wrong WITH a live
 * session — too weak, unchanged, rate-limited — plus a neutral default for a session that
 * expired between the page rendering and the form being submitted.
 *
 * Changing a password revokes this user's other sessions on Supabase's side, which is the
 * "somebody else has my session" remedy `signOut`'s own comment points at rather than
 * overloading the sign-out button with.
 */
export async function updatePassword(params: {
  cookies: AstroCookies;
  request: Request;
  password: string;
}): Promise<AuthResult<{ user: User }>> {
  const client = createAuthClient(params.cookies, params.request);
  const { data, error } = await client.auth.updateUser({ password: params.password });
  // Mapped from the CODE, never relayed — same rule as signUpWithPassword above.
  if (error) return { ok: false, error: passwordUpdateErrorMessage(error.code) };
  return { ok: true, user: data.user };
}

/**
 * Ends THIS device's session and nothing else.
 *
 * `scope: 'local'` is passed explicitly because `supabase-js` defaults to `'global'`,
 * which revokes every refresh token the user holds — so clicking "Sign out" on a library
 * computer would also sign them out of their phone, their laptop and any tab they left
 * open, silently, with no indication that is what the button did. That is not what "sign
 * out" means to the person pressing it, and a default is a poor reason to mean something
 * else.
 *
 * WHAT IS GIVEN UP BY NOT DOING IT GLOBALLY, said plainly because there is a real case for
 * the other choice: a global sign-out is the "I think somebody has my session" button, and
 * this is not it. The thing to build for that is a deliberate, labelled "sign out
 * everywhere" control on the account page — which can call this same module with the other
 * scope — rather than making the ordinary control do it invisibly. Changing a password
 * already revokes other sessions on Supabase's side, which covers the compromise case
 * people actually reach for.
 *
 * `'local'` still revokes this session's own refresh token server-side, so the cookies
 * cleared below cannot be replayed. It is not a client-only forget.
 */
export async function signOut({
  cookies,
  request,
}: {
  cookies: AstroCookies;
  request: Request;
}): Promise<AuthResult> {
  const client = createAuthClient(cookies, request);
  const { error } = await client.auth.signOut({ scope: 'local' });
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
 * The migration that creates it landed with this function, in
 * supabase/migrations/20260811000000_account_deletion.sql — the two were written against
 * one contract (a zero-argument RPC, callable by `authenticated`, that deletes the calling
 * user and everything they own) so they could land independently and meet in the middle,
 * and they have. Read that migration before changing this call: it explains why the
 * function deletes five tables by name rather than letting `auth.users` cascade, and why
 * widening its signature to take a target id would turn a self-service delete into an
 * unauthenticated one.
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
