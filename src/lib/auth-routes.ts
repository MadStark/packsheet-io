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
 * Validates a `?next=`/`redirectTo` query parameter against open-redirect abuse —
 * "the classic bug in exactly this code" per the ticket that added it. A sign-in page
 * that redirects wherever `next` says, unchecked, is a phishing primitive: an attacker
 * sends `/sign-in?next=https://evil.example/steal`, the victim signs in on the real
 * site (so nothing about the domain in the address bar looks wrong), and lands on the
 * attacker's page immediately afterwards with a fresh sense of trust.
 *
 * The fix is to accept only a same-origin, absolute *path* and reject everything else
 * back to `ACCOUNT_PATH` — never by trying to enumerate bad inputs, which is a list
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
 * all — falls back to `ACCOUNT_PATH` rather than being rejected as an error: this runs
 * on the happy path for a great many sign-ins that never set `next` at all, so "no
 * value" and "bad value" both have to resolve to somewhere safe rather than a 400.
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
  return ACCOUNT_PATH;
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
 * Whether the "Continue with Google" control should be offered at all, and whether a
 * POST claiming `intent=google` should be honoured rather than refused outright.
 *
 * Google OAuth credentials do not exist in any environment yet — no Google Cloud OAuth
 * client, and the provider is not switched on in either Supabase project — so before
 * this flag existed, clicking the button sent every visitor to Supabase's own
 * authorize endpoint, which rendered its raw JSON straight to them:
 * `{"code":400,"error_code":"validation_failed","msg":"Unsupported provider: provider
 * is not enabled"}`. The PKCE construction that gets a visitor there
 * (`getGoogleAuthorizationUrl` in `src/lib/auth/index.ts`) is correct; the problem is
 * purely that nothing is configured to answer it yet. An offered control that always
 * fails is worse than an absent one, so sign-in.astro and sign-up.astro gate both the
 * button and the POST branch behind this rather than relying on the error message to
 * paper over a state that is, today, universal rather than exceptional.
 *
 * A plain constant rather than a function, and read here rather than separately in
 * each page, for the same reason `SIGN_IN_PATH` and friends are constants above: it is
 * `PUBLIC_`-prefixed, so Vite inlines it into both the server and client bundle at
 * BUILD time (see `.env.example` for what has to exist before it may be turned on, and
 * the README's "Database" section for the two deploy workflows it is wired into
 * alongside `PUBLIC_SUPABASE_URL` / `PUBLIC_SUPABASE_ANON_KEY`) — there is no request-
 * time check left to perform, and reading it once here rather than twice keeps the two
 * pages from ever being able to disagree about it.
 *
 * Compared against the literal string `"true"` and nothing else — unset, misspelled,
 * or any other value all resolve to `false` — matching `PUBLIC_SITE_ENV`'s own fail-
 * safe pattern in `src/pages/robots.txt.ts` for the same reason: the safe side of a
 * typo here is "no button", not "button that silently starts sending visitors into a
 * JSON error page".
 */
export const GOOGLE_AUTH_ENABLED = import.meta.env.PUBLIC_GOOGLE_AUTH_ENABLED === 'true';

/**
 * The plain-English message shown in place of attempting Google OAuth when
 * `GOOGLE_AUTH_ENABLED` is `false`. Reached either because the button was never
 * rendered and something POSTed `intent=google` anyway — a stale cached form, a
 * crafted request — or, once the flag IS on, because Supabase itself refused the
 * request for some other reason once a real provider exists to refuse things.
 * Centralised here rather than typed out separately in sign-in.astro and
 * sign-up.astro's frontmatter so the two pages cannot drift into two different
 * wordings for the same failure, and so the rule that matters — NEVER relay
 * Supabase's or Google's own error text to a visitor — lives in one function this
 * file's own test can pin, rather than only in two hand-read `.astro` files.
 */
export function googleAuthUnavailableMessage(action: 'in' | 'up'): string {
  return `Google sign-${action} is not available right now. Use email and password below.`;
}
