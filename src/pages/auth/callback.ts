import type { APIRoute } from 'astro';
import { exchangeCodeForSession } from '../../lib/auth';
import { safeNextPath, SIGN_IN_PATH } from '../../lib/auth-routes';

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
    // Never render a raw Supabase error string — bounce to sign-in, which renders its
    // own neutral message for `?oauth_error=1`.
    return redirect(`${SIGN_IN_PATH}?oauth_error=1`, 303);
  }

  return redirect(next, 303);
};
