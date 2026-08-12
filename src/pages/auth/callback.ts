import type { APIRoute } from 'astro';
import { exchangeCodeForSession } from '../../lib/auth';
import { safeNextPath, SIGN_IN_PATH, UPDATE_PASSWORD_PATH } from '../../lib/auth-routes';

// On-demand: this is the PKCE/OAuth return leg. It reads a query param and writes
// session cookies, neither of which a prerendered file can do.
export const prerender = false;

/**
 * The route named by AUTH_CALLBACK_PATH in src/lib/auth-routes.ts. Google redirects
 * the browser here with `?code=...` on success, or with no `code` at all (typically
 * `?error=access_denied&...`) when the visitor cancels on Google's own consent screen
 * — both are handled here rather than left to fall through to a generic 404 or 500,
 * because both are routine outcomes of starting the flow, not exceptional ones.
 *
 * SINCE PK-56 THIS IS NOT ONLY GOOGLE'S RETURN LEG. `requestPasswordReset` and
 * `signUpWithPassword` (src/lib/auth/index.ts) both point their emailed links here too,
 * deliberately, so that one tested exchange serves every flow that hands back a one-time
 * code rather than each growing its own copy. Nothing about the success path had to
 * change for that — a code is a code — but the FAILURE path did; see below.
 *
 * `next` is re-validated with safeNextPath even though sign-in.astro and sign-up.astro
 * already validated it once before putting it in the `redirectTo` URL they gave
 * Google: this route trusts nothing about the URL it was actually called with, because
 * the callback URL passing through a third party (Google) and back is precisely the
 * kind of hop a value should not be assumed to have survived unmodified.
 */
export const GET: APIRoute = async ({ url, cookies, request, redirect }) => {
  const code = url.searchParams.get('code');
  const next = safeNextPath(url.searchParams.get('next'));

  if (!code) {
    return redirect(`${SIGN_IN_PATH}?oauth_error=1`, 303);
  }

  const result = await exchangeCodeForSession({ cookies, request, code });
  if (!result.ok) {
    // Never render a raw Supabase error string — bounce somewhere that renders its own
    // neutral message. WHICH somewhere is decided by where this leg was going, and that
    // is a fix rather than a flourish (PK-56, found by walking the flow with two cookie
    // jars): a password-reset link opened in a DIFFERENT browser from the one that asked
    // for it has no PKCE verifier to present, so the exchange fails — and that is the
    // single most ordinary way for it to fail, because people request a reset on a laptop
    // and open their mail on a phone. Sent to `?oauth_error=1`, those people were told
    // "something went wrong signing in with Google", about a link that has nothing to do
    // with Google, on a page with no way back into the reset flow.
    //
    // /update-password with no session renders exactly the right thing instead — "this
    // link has expired or was already used", plus the control to ask for another — so the
    // failure lands on the page that already owns this outcome. `next` has been through
    // safeNextPath, and this compares it to the constant rather than trusting the URL to
    // name a page to bounce to: a redirect target chosen by whatever arrived in the query
    // string is the open redirect safeNextPath exists to prevent, re-invented on the
    // error path.
    if (next === UPDATE_PASSWORD_PATH) return redirect(UPDATE_PASSWORD_PATH, 303);
    return redirect(`${SIGN_IN_PATH}?oauth_error=1`, 303);
  }

  return redirect(next, 303);
};
