import { describe, expect, it } from 'vitest';
import {
  AUTH_CALLBACK_FAILED_MESSAGE,
  AUTH_ERROR_PARAM,
  googleAuthUnavailableMessage,
} from '../src/lib/auth-routes';

/**
 * `AUTH_CALLBACK_FAILED_MESSAGE` (src/lib/auth-routes.ts) is what sign-in.astro and
 * sign-up.astro render when `src/pages/auth/callback.ts` could not complete a callback
 * and bounced the visitor back with `?auth_error=1`.
 *
 * THE BUG THIS PINS, so that the assertions below read as a rule rather than as taste.
 * Before PK-56 exactly one flow reached AUTH_CALLBACK_PATH — Google's OAuth return leg —
 * and both pages hard-coded "Something went wrong signing in with Google", which was
 * true of the only journey that could produce it. PK-56 pointed two more flows at that
 * same route on purpose (one tested exchange rather than three copies of one): the
 * emailed SIGN-UP CONFIRMATION link, and the emailed PASSWORD-RESET link.
 *
 * The reset leg was given its own destination — callback.ts sends a failed exchange whose
 * `next` is UPDATE_PASSWORD_PATH to the update-password page, which already owns the
 * "expired or already used" state and the control to ask for another link. The
 * CONFIRMATION leg was not, and could not be by the same trick: `signUpWithPassword`
 * builds that link with no `?next=` at all (deliberately — see its comment), so `next`
 * falls back to ACCOUNT_PATH, the failed exchange took the other branch, and somebody
 * confirming a brand-new account was told a sign-in with Google had gone wrong. Google
 * was not involved at any point in that journey.
 *
 * WHAT THAT COST, stated exactly, because it decides how strong the fix had to be: the
 * confirmation link points at GoTrue's own `/verify`, which marks the address confirmed
 * BEFORE redirecting here with a one-time code. The account was therefore already usable
 * and signing in was already the right next step. Nobody was locked out — they were told
 * an untrue reason. So what is pinned below is honesty and a route forward, not a new
 * flow.
 *
 * The pairing with `googleAuthUnavailableMessage` is the point of testing them in the
 * same file. That message DOES name Google and must keep doing so: it is shown when the
 * call to Google itself failed, on a page the visitor reached by pressing "Continue with
 * Google". Two messages, one rule each, and the defect was the first quietly inheriting
 * the second's premise.
 */
describe('AUTH_CALLBACK_FAILED_MESSAGE — true for every leg that reaches the callback', () => {
  /**
   * The headline rule. Three flows land on this sentence and only one of them is an OAuth
   * provider, so naming any provider is a claim the message has no way to support.
   */
  it('names no identity provider', () => {
    for (const provider of ['Google', 'google', 'Apple', 'GitHub', 'OAuth', 'oauth']) {
      expect(AUTH_CALLBACK_FAILED_MESSAGE).not.toContain(provider);
    }
  });

  /**
   * Nor may it swing the other way and assert something only true of the email legs. "Your
   * account is confirmed" is true of a failed sign-up confirmation exchange and false of a
   * cancelled Google consent screen; "check your inbox" is false of both. A sentence
   * shared by three flows may only say what holds in all three.
   */
  it('claims nothing that is only true of one of the legs', () => {
    const message = AUTH_CALLBACK_FAILED_MESSAGE.toLowerCase();
    for (const overclaim of [
      'your account is confirmed',
      'has been confirmed',
      'check your inbox',
      'we have sent',
      'your password has been',
    ]) {
      expect(message).not.toContain(overclaim);
    }
  });

  /**
   * A visitor sent here must be able to act. The three real causes are named without any
   * one of them being asserted as what happened — which is the honest shape when the route
   * genuinely cannot tell them apart — and the sign-in form, which is on the page rendering
   * this, is pointed at.
   */
  it('names the real causes and leaves a way forward', () => {
    const message = AUTH_CALLBACK_FAILED_MESSAGE.toLowerCase();
    expect(message).toMatch(/expired/);
    expect(message).toMatch(/already been used/);
    expect(message).toMatch(/different browser/);
    expect(message).toMatch(/sign in below/);
  });

  // Same rule as every other visitor-facing string in this project: our words, never the
  // provider's. See src/lib/auth/index.ts's error-message mappings.
  it('relays no provider or Supabase error text', () => {
    expect(AUTH_CALLBACK_FAILED_MESSAGE).not.toMatch(/error_code|validation_failed|"code":4/);
  });

  /**
   * The parameter name, pinned because it is half of how the defect happened. `oauth_error`
   * was accurate while Google was the only flow, and then quietly became the reason
   * "with Google" kept looking like the right thing to write on a page answering three
   * flows. src/pages/auth/callback.ts sets it and both pages read it, so a rename that
   * missed one end would silently render no message at all.
   */
  it('travels under a name that does not itself claim OAuth', () => {
    expect(AUTH_ERROR_PARAM).toBe('auth_error');
    expect(AUTH_ERROR_PARAM).not.toContain('oauth');
  });
});

/**
 * And the distinction itself, which is what a future edit is most likely to collapse by
 * "unifying the two error messages". They answer different questions and only one of them
 * knows a provider was involved.
 */
describe('the two failure messages stay distinct', () => {
  it('the Google-specific message still names Google, and the callback one still does not', () => {
    expect(googleAuthUnavailableMessage('in')).toContain('Google');
    expect(googleAuthUnavailableMessage('up')).toContain('Google');
    expect(AUTH_CALLBACK_FAILED_MESSAGE).not.toContain('Google');
    expect(AUTH_CALLBACK_FAILED_MESSAGE).not.toBe(googleAuthUnavailableMessage('in'));
  });
});
