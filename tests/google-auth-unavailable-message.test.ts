import { describe, it, expect } from 'vitest';
import { googleAuthUnavailableMessage } from '../src/lib/auth-routes';

/**
 * `googleAuthUnavailableMessage` (src/lib/auth-routes.ts) is what sign-in.astro and
 * sign-up.astro show in place of `getGoogleAuthorizationUrl`'s own answer whenever
 * that call fails — Supabase unreachable, the provider disabled again in the
 * dashboard, a malformed redirect. This used to be the routine path, back when no
 * environment had a Google OAuth client configured at all: PK-19's real-browser
 * walkthrough found that clicking "Continue with Google" reached Supabase's own
 * authorize endpoint and rendered its raw JSON straight to the visitor —
 * `{"code":400,"error_code":"validation_failed","msg":"Unsupported provider: provider
 * is not enabled"}`. A `PUBLIC_`-prefixed build-time flag hid the button and refused
 * the POST outright until that was fixed.
 *
 * Google is now configured and enabled on both hosted Supabase projects — verified:
 * the authorize endpoint 302s to accounts.google.com with the right client ID and
 * redirect URI, and the real button reaches Google's sign-in page in a browser — so
 * the flag was removed rather than flipped on: a value that has to be `true` in every
 * environment or the button silently vanishes is a footgun once there is no longer a
 * reason to gate it. What remains, and what this file pins, is the one thing that can
 * still go wrong even with Google fully configured: the OAuth call is still a network
 * round trip, and a visitor who hits a failure must see a plain-English sentence,
 * never Supabase's or Google's own error text.
 *
 * THIS MESSAGE NAMES GOOGLE AND SHOULD, which is only worth saying because its sibling
 * must not. It is shown when the call to Google ITSELF failed, on a page the visitor
 * reached by pressing "Continue with Google" — the provider is the subject, so naming it
 * is the accurate thing to do. `AUTH_CALLBACK_FAILED_MESSAGE`, the other visitor-facing
 * auth failure in src/lib/auth-routes.ts, answers three flows of which only one is
 * Google's, and tests/auth-callback-failed-message.test.ts pins that it names no provider
 * at all. Do not "unify" the two: the PK-56 review found the confirmation-email leg being
 * answered with this file's premise, and one message covering both is how that comes back.
 */

describe("googleAuthUnavailableMessage — never Supabase's or Google's own text", () => {
  it('renders a plain-English sentence for sign-in, not the raw provider error', () => {
    const message = googleAuthUnavailableMessage('in');

    expect(message).toBe(
      'Google sign-in is not available right now. Use email and password below.',
    );
    // The exact failure this exists to prevent: a provider error, or any other raw
    // Supabase text, rendered straight to a visitor instead of this sentence.
    expect(message).not.toMatch(/error_code|validation_failed|"code":400/);
  });

  it('renders the sign-up wording for the sign-up page', () => {
    expect(googleAuthUnavailableMessage('up')).toBe(
      'Google sign-up is not available right now. Use email and password below.',
    );
  });
});
