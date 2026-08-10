import { describe, it, expect, afterEach, vi } from 'vitest';

/**
 * Defect 2 from PK-19's real-browser walkthrough: clicking "Continue with Google"
 * navigated to Supabase's own authorize endpoint, which rendered its raw JSON error
 * straight to the visitor — `{"code":400,"error_code":"validation_failed","msg":
 * "Unsupported provider: provider is not enabled"}` — because no Google OAuth client
 * exists in any environment yet. The fix is `GOOGLE_AUTH_ENABLED` in
 * src/lib/auth-routes.ts: sign-in.astro and sign-up.astro both use it to (a) decide
 * whether to render the "Continue with Google" button at all, and (b) decide, in
 * their POST handler, whether to attempt the OAuth call or refuse with
 * `googleAuthUnavailableMessage` outright.
 *
 * WHAT LAYER THIS TESTS, AND WHY. Neither sign-in.astro nor sign-up.astro is
 * something this suite can render and inspect — nothing in this codebase renders an
 * `.astro` page directly (Astro's own container API exists but needs `Astro.site`
 * wired through `astroConfig`, which this project's Layout.astro depends on, and
 * getting that working is a page-rendering test harness this repository does not
 * otherwise have; introducing one for a single flag was not worth the risk of a
 * flaky, half-supported experimental API). What this file tests instead is the exact
 * pattern this codebase already uses for the identical shape of problem —
 * tests/robots-txt.test.ts pins PUBLIC_SITE_ENV's fail-safe branching the same way,
 * with the same comment about why a real build's static substitution is not what is
 * being pinned here — and it is honest about what that covers: both pages are thin,
 * single-branch consumers of GOOGLE_AUTH_ENABLED and googleAuthUnavailableMessage
 * (`{GOOGLE_AUTH_ENABLED && (<google form>)}` for rendering, `if (!GOOGLE_AUTH_ENABLED)
 * { errorMessage = googleAuthUnavailableMessage(...) }` before ANY network call in the
 * POST handler), so pinning those two exports pins the only two things either page's
 * Google-gating logic actually depends on. With the flag proven false-by-default and
 * true only for the literal string "true", and the message proven to never be
 * Supabase's or Google's own text, there is no remaining code path in either page
 * that could still reach the authorize endpoint or redirect into its JSON error.
 */

/**
 * The module captures GOOGLE_AUTH_ENABLED in a top-level `const` at import time —
 * same reason robots-txt.test.ts resets the module registry between values: without
 * it, every case after the first would read the first one's answer.
 */
async function googleAuthEnabledFor(value: string | undefined): Promise<boolean> {
  vi.resetModules();
  vi.stubEnv('PUBLIC_GOOGLE_AUTH_ENABLED', value);
  const { GOOGLE_AUTH_ENABLED } = await import('../src/lib/auth-routes');
  return GOOGLE_AUTH_ENABLED;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('GOOGLE_AUTH_ENABLED — the Google button gate', () => {
  it('is off when the variable is unset — the default for every environment today', async () => {
    expect(await googleAuthEnabledFor(undefined)).toBe(false);
  });

  it('is on for exactly the literal string "true"', async () => {
    expect(await googleAuthEnabledFor('true')).toBe(true);
  });

  // Fail-safe, the same shape PUBLIC_SITE_ENV is pinned for in robots-txt.test.ts:
  // the regression this guards is the check drifting from `=== 'true'` to something
  // permissive (truthy-string coercion, a `!== 'false'`), which would silently turn
  // the button on for a typo instead of keeping it off.
  it.each(['TRUE', 'True', '1', 'yes', ' true', 'true ', ''])(
    'is off for %j — anything other than the exact literal is refused, not coerced',
    async (value) => {
      expect(await googleAuthEnabledFor(value)).toBe(false);
    },
  );
});

describe("googleAuthUnavailableMessage — never Supabase's or Google's own text", () => {
  it('renders a plain-English sentence for sign-in, not the raw provider error', async () => {
    vi.resetModules();
    const { googleAuthUnavailableMessage } = await import('../src/lib/auth-routes');
    const message = googleAuthUnavailableMessage('in');

    expect(message).toBe(
      'Google sign-in is not available right now. Use email and password below.',
    );
    // The exact failure this exists to prevent: Supabase's own answer for an
    // unconfigured provider, rendered straight to a visitor instead of this sentence.
    expect(message).not.toMatch(/error_code|validation_failed|"code":400/);
  });

  it('renders the sign-up wording for the sign-up page', async () => {
    vi.resetModules();
    const { googleAuthUnavailableMessage } = await import('../src/lib/auth-routes');
    expect(googleAuthUnavailableMessage('up')).toBe(
      'Google sign-up is not available right now. Use email and password below.',
    );
  });
});
