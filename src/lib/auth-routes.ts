/**
 * Route paths that an anonymous page is allowed to know about: a nav bar linking to
 * "Sign in", a share page offering "Claim this pack" pointing at sign-up, a 404 page
 * linking back to the account screen. None of that is auth code — it is a handful of
 * strings — but if it lived in src/lib/auth/ it would still sink any anonymous route
 * that imported it, because Invariant A in tests/anonymous-read-path.test.ts is an EDGE
 * rule: it does not look at what a module contains, only at whether something outside the
 * choke point has an import edge into it. A `types.ts` of pure constants would ship zero
 * auth code and still fail the build with a message about a $6,000/month bill, which is
 * exactly the kind of false positive that gets a guardrail weakened rather than obeyed.
 *
 * That rule stopped being UNCONDITIONAL in PK-19 — it now consults an enumerated
 * allowlist, AUTH_CONSUMERS — and this file is no less necessary for it. An allowlist
 * entry is standing permission for one module to import ANYTHING in the choke point, so
 * granting one to a nav bar that wanted a string is a far worse trade than moving the
 * string; the list is meant to hold routes that authenticate people and to stay short
 * enough to read at once. Everything below is here so that wanting a path never becomes a
 * reason to ask for a line on it. See the "corollary of an edge rule" paragraph in
 * src/lib/auth/index.ts's own doc comment — this file is what that paragraph is for.
 *
 * So the constants live out here, one door away from the choke point, where any page
 * or component may import them without tripping Invariant A. Nothing in this file
 * touches an auth SDK or a Supabase client; it is safe by construction rather than by
 * being carefully reviewed each time something new is added to it.
 */

// The one import this file has, and it stays safe by the same construction: src/lib/
// routes.ts is another dependency-free path module (it imports only src/lib/gear/
// routes.ts, which is one too), so the edge added here reaches no SDK and Invariant A in
// tests/anonymous-read-path.test.ts has nothing to object to. `safeNextPath` needs it for
// its fallback — see that function's own comment for why the destination moved.
import { HOME_PATH } from './routes';

export const SIGN_IN_PATH = '/sign-in';
export const SIGN_UP_PATH = '/sign-up';

/**
 * `/auth/signout`, not `/sign-out` — moved here from the original `/sign-out` when
 * PK-19 landed the route itself, to sit next to `AUTH_CALLBACK_PATH` under `/auth/`:
 * both are POST-or-redirect *actions*, not pages a visitor lands on directly, and
 * grouping them makes that shape visible from the path alone. Nothing consumed the
 * old constant yet (this file predates every route that would have), so there was
 * no call site to leave behind.
 */
export const SIGN_OUT_PATH = '/auth/signout';
export const ACCOUNT_PATH = '/account';

/**
 * Where Google's redirect lands after `getGoogleAuthorizationUrl`'s authorization URL
 * sends the visitor away and back. `src/pages/auth/callback.ts` answers this path and
 * calls `exchangeCodeForSession` to complete the flow. The path is a public contract — it
 * has to match the redirect URI configured in the OAuth provider and in the Supabase
 * dashboard — so it is named here rather than written inline in the route that serves it.
 */
export const AUTH_CALLBACK_PATH = '/auth/callback';

/**
 * The two halves of the password-reset journey (PK-56): the page that asks for an
 * address and the page that takes the new password.
 *
 * WHY OUT HERE rather than beside the functions that serve them. Every module that names
 * these today — the two pages, `src/middleware.ts`, and `src/pages/sign-in.astro` for the
 * "Forgot your password?" link — happens to be on AUTH_CONSUMERS already, so no
 * anonymous route is saved an allowlist line by this file TODAY. That is not the reason,
 * and treating it as one gets the file's argument backwards: the next module to want one
 * of these strings is a nav bar, a 404 page, or the "you have been signed out" screen,
 * none of which authenticates anybody, and the moment a path lives in the choke point the
 * cheapest way for that module to get it is to ask for a standing permission to import
 * the auth SDK. The header above is what that trade is about. Paths go here; nothing here
 * touches an SDK.
 *
 * UPDATE_PASSWORD_PATH is additionally a value that TRAVELS, which is the thing to know
 * before renaming it. `requestPasswordReset` (src/lib/auth/index.ts) puts it in the
 * `?next=` of the `redirectTo` it hands GoTrue, GoTrue puts that URL in an email, and it
 * comes back days later through `src/pages/auth/callback.ts`, where `safeNextPath` below
 * re-validates it exactly like any other `next` — the recovery link deliberately goes
 * through the same, already-tested exchange route Google sign-in uses rather than a
 * second copy of it. One constant is what closes that round trip: a hand-typed duplicate
 * at either end does not fail loudly, it lands the visitor on `HOME_PATH` — and from
 * there, since a recovery session IS a session, straight into their gear closet with a
 * live recovery session and no password form anywhere in sight.
 */
export const FORGOT_PASSWORD_PATH = '/forgot-password';
export const UPDATE_PASSWORD_PATH = '/update-password';

/**
 * Validates a `?next=`/`redirectTo` query parameter against open-redirect abuse —
 * "the classic bug in exactly this code" per the ticket that added it. A sign-in page
 * that redirects wherever `next` says, unchecked, is a phishing primitive: an attacker
 * sends `/sign-in?next=https://evil.example/steal`, the victim signs in on the real
 * site (so nothing about the domain in the address bar looks wrong), and lands on the
 * attacker's page immediately afterwards with a fresh sense of trust.
 *
 * The fix is to accept only a same-origin, absolute *path* and reject everything else
 * back to `HOME_PATH` — never by trying to enumerate bad inputs, which is a list
 * that is never finished, but by defining the one shape a same-origin path is allowed
 * to take and refusing anything that doesn't match it:
 *
 *   - Must start with a single `/`. No leading slash at all means a scheme-relative or
 *     absolute URL (`evil.example/...`, `https://evil.example/...`) rather than a path.
 *   - Must NOT start with `//`. `//evil.example` is a PROTOCOL-RELATIVE URL — browsers
 *     resolve it against the current scheme but a DIFFERENT host — and a same-origin
 *     check on the string alone has no host to compare it against, so the only safe
 *     move is to refuse the shape outright.
 *   - Must contain no backslash. Some browsers normalise a leading `\` to `/` before
 *     resolving a URL, so `/\evil.example` is the same trick as `//` wearing a
 *     disguise this function would otherwise miss.
 *   - Must contain no `:`. A colon is how a scheme gets introduced (`javascript:`,
 *     `https:`); no legitimate same-origin path needs one, so refusing it outright is
 *     cheaper and safer than trying to parse for just the dangerous schemes.
 *
 * Anything that fails any of those — including empty input, a full URL, or nothing at
 * all — falls back to `HOME_PATH` rather than being rejected as an error: this runs
 * on the happy path for a great many sign-ins that never set `next` at all, so "no
 * value" and "bad value" both have to resolve to somewhere safe rather than a 400.
 *
 * THE FALLBACK IS `HOME_PATH`, NOT `ACCOUNT_PATH`, and the change is not cosmetic. It
 * used to be the account page — a settings screen — so a sign-in carrying no `?next=`
 * (which is most of them: every visitor who reached the form by choice rather than by
 * being bounced off a page they wanted) landed somewhere nobody had asked to go, while
 * the gear closet they actually came for sat one nav click away. `/` now answers that
 * question for the whole site through `homeDestination` in src/lib/routes.ts, so pointing
 * the fallback here costs one extra 302 and buys the property that changing where a
 * signed-in person lands is one edit in one file rather than an edit plus a hunt for
 * every default that had quietly hard-coded the old answer.
 */
export function safeNextPath(raw: string | null | undefined): string {
  if (
    typeof raw === 'string' &&
    raw.startsWith('/') &&
    !raw.startsWith('//') &&
    !raw.includes('\\') &&
    !raw.includes(':')
  ) {
    return raw;
  }
  return HOME_PATH;
}

/** The form field, and the query parameter, that carry the post-sign-in destination.
 *  One constant for both because they are the same value at two moments of the same
 *  journey, and a form whose field name disagreed with the query parameter would fail
 *  silently — the value simply would not be found, and the visitor would land on the
 *  default. */
export const NEXT_PARAM = 'next';

/**
 * The destination a POSTed sign-in or sign-up form should return the visitor to.
 *
 * WHY THE FORM FIELD IS READ AT ALL, given that it worked without this. The four forms in
 * sign-in.astro and sign-up.astro each carry `<input type="hidden" name="next">`, and
 * nothing read it: a `<form method="POST">` with no `action` posts to the CURRENT URL,
 * query string included, so the value survived by being in the URL rather than by being
 * in the form. The field was inert, and its comment described it as the mechanism.
 *
 * Two ways to fix that, and this is the one that keeps the more robust behaviour rather
 * than the smaller diff. Deleting the fields would leave the journey resting on a detail
 * of HTML form submission that is invisible at the call site — give any of those forms an
 * `action`, for any reason, and `?next=` is silently dropped and every visitor lands on
 * `/account` instead of where they were going. Reading the field makes the carrier
 * explicit and the fallback the safety net.
 *
 * Both are passed through `safeNextPath`, so a crafted POST setting `next` to an
 * off-site URL is refused exactly as a crafted query string is — the field being
 * `hidden` says nothing about who filled it in.
 */
export function nextFromForm(form: FormData, url: URL): string {
  const field = form.get(NEXT_PARAM);
  return safeNextPath(typeof field === 'string' ? field : url.searchParams.get(NEXT_PARAM));
}

/**
 * The plain-English message shown when `getGoogleAuthorizationUrl` (src/lib/auth/index.ts)
 * fails — Supabase unreachable, the provider disabled again in the dashboard, a
 * malformed redirect URI. Google is configured and enabled on both hosted Supabase
 * projects (verified: the authorize endpoint 302s to `accounts.google.com` with the
 * right client ID and redirect URI), so this is no longer the everyday path it once
 * was, but the call still crosses the network and can still fail, and a visitor who
 * hits that must never see Supabase's or Google's own error text — a raw
 * `{"code":400,...}` body, or a redirect into a JSON error page — rendered straight at
 * them. Centralised here rather than typed out separately in sign-in.astro and
 * sign-up.astro's frontmatter so the two pages cannot drift into two different
 * wordings for the same failure, and so the rule that matters lives in one function
 * this file's own test can pin, rather than only in two hand-read `.astro` files.
 */
export function googleAuthUnavailableMessage(action: 'in' | 'up'): string {
  return `Google sign-${action} is not available right now. Use email and password below.`;
}

/**
 * The query parameter `src/pages/auth/callback.ts` sets on its bounce back to
 * SIGN_IN_PATH when it could not complete a callback, and which sign-in.astro and
 * sign-up.astro render AUTH_CALLBACK_FAILED_MESSAGE for.
 *
 * `auth_error`, not `oauth_error`, and the rename is the actual fix rather than tidying
 * (PK-56 review). The old name was accurate when Google's return leg was the only thing
 * that reached that route; since PK-56 the same route also completes the SIGN-UP
 * CONFIRMATION link and the PASSWORD-RESET link, neither of which involves an OAuth
 * provider at all. A parameter called `oauth_error` is what made naming Google in the
 * copy look reasonable to write and then survive review — see the message below.
 */
export const AUTH_ERROR_PARAM = 'auth_error';

/**
 * What a visitor is told when `src/pages/auth/callback.ts` could not complete the
 * callback and sent them to the sign-in page.
 *
 * IT MUST NOT NAME GOOGLE, and that is the defect this constant exists to fix rather
 * than a preference. Before PK-56, one flow reached AUTH_CALLBACK_PATH — Google's return
 * leg — and both pages hard-coded "Something went wrong signing in with Google", which
 * was true. PK-56 pointed two more flows at the same route: the emailed SIGN-UP
 * CONFIRMATION link and the emailed PASSWORD-RESET link. The reset leg got its own
 * destination (callback.ts routes a failed exchange whose `next` is UPDATE_PASSWORD_PATH
 * to the update-password page, which renders the expired-link state it already owns), but
 * the confirmation leg did not and could not: `signUpWithPassword` deliberately builds
 * that link with NO `?next=` (see its own comment for why a stale destination is worse
 * than none), so `next` falls back to the default — ACCOUNT_PATH when PK-56 landed,
 * HOME_PATH since `/` became the router that answers that question — and a failed
 * confirmation exchange landed on the sign-in page being told about Google. Google was not
 * involved anywhere in that journey. Which default it is has never mattered to this
 * argument: what puts the visitor here is that `next` is not UPDATE_PASSWORD_PATH.
 *
 * THAT WAS MISLEADING COPY AND NOT A LOCKOUT, which is worth stating because it decides
 * how much this needed to change. The confirmation link points at GoTrue's own `/verify`
 * endpoint, which marks the address confirmed and only THEN redirects to this project's
 * callback route with a one-time code. So by the time anything here can fail, the account
 * is already confirmed and the person can simply sign in with the password they chose;
 * what was broken was being told an untrue reason for it. Hence a wording fix rather than
 * a new route.
 *
 * WHY ONE SENTENCE FOR EVERY LEG rather than a message per flow. This route cannot tell
 * the legs apart at the point of failure without a marker travelling in the emailed link,
 * and adding one is not free: the local `additional_redirect_urls` in supabase/config.toml
 * are EXACT URLs with no `?*` wildcard, so a new query parameter on a confirmation link
 * would be rejected by GoTrue's allow-list and silently fall back to `site_url`. The
 * honest alternative is a sentence that is true whichever leg failed, which is what this
 * is: it names the real causes (expired, already used, opened in another browser, or
 * cancelled at a provider) without asserting which one happened, claims nothing about
 * whether an account was confirmed, and always leaves the sign-in form as the way
 * forward. Pinned by tests/auth-callback-failed-message.test.ts, alongside
 * `googleAuthUnavailableMessage` above — which DOES name Google, correctly, because it is
 * shown only when the call to Google itself failed.
 */
export const AUTH_CALLBACK_FAILED_MESSAGE =
  'We could not finish signing you in. That happens when a link has expired, has already ' +
  'been used, or was opened in a different browser from the one that asked for it — and ' +
  'when a sign-in is cancelled on the provider’s own screen. Sign in below to continue.';
