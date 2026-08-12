import { describe, expect, it } from 'vitest';
import { PASSWORD_RESET_REQUESTED_MESSAGE, passwordUpdateErrorMessage } from '../src/lib/auth';

/**
 * The two hand-written pieces of copy PK-56's password-reset journey puts in front of a
 * visitor, pinned from OUTSIDE src/lib/auth/ — the same reason `signUpErrorMessage` is
 * exported and asserted from tests/auth-flow.test.ts, and the same shape as
 * tests/google-auth-unavailable-message.test.ts: what these strings SAY is the rule, and a
 * rule that can only be read off the source is one nothing checks.
 *
 * No Supabase stack, no cookies, no network — both are pure. The round trips that prove
 * the FUNCTIONS behave live in tests/auth-flow.test.ts; this file is about the sentences.
 *
 * PASSWORD_RESET_REQUESTED_MESSAGE is the one an account-enumeration bug would show up in
 * first. src/pages/forgot-password.astro renders it for every POST — an address with an
 * account, an address without one, and a request that failed outright — so it has to be
 * true in all three without asserting any of them. The negative assertions below are the
 * ones that fail if somebody "improves" the copy into a claim: "we have sent you an email"
 * is a claim, and on this page it is an oracle.
 */
describe('PASSWORD_RESET_REQUESTED_MESSAGE — the same sentence either way', () => {
  it('is conditional about whether an account exists, and promises nothing that varies', () => {
    expect(PASSWORD_RESET_REQUESTED_MESSAGE).toBe(
      'If there is a Packsheet account for that address, a link to choose a new password is ' +
        'on its way. The link can only be used once, so ask again if you need another.',
    );
  });

  /**
   * The property, rather than the wording. A sentence that states an email WAS sent, or
   * that names an address as unknown, distinguishes a registered address from an
   * unregistered one on the one page that takes an address from a stranger — which is
   * exactly the hole BAD_CREDENTIALS_MESSAGE and SIGN_UP_UNAVAILABLE_MESSAGE close
   * elsewhere in src/lib/auth/index.ts.
   */
  it('never asserts that an email was sent, and never says an address is unknown', () => {
    const message = PASSWORD_RESET_REQUESTED_MESSAGE.toLowerCase();
    expect(message).toMatch(/^if there is /);
    for (const leak of [
      'we have sent',
      'we sent',
      'we have emailed',
      'check your inbox',
      'no account',
      'not registered',
      'we could not find',
      "doesn't exist",
      'does not exist',
    ]) {
      expect(message).not.toContain(leak);
    }
  });
});

/**
 * `passwordUpdateErrorMessage` — what somebody who followed a reset link is told when the
 * new password is refused.
 *
 * The threat model here is deliberately NOT the one above, and the difference is why this
 * mapping names its failures instead of collapsing them: everybody who reaches
 * `updatePassword` is already holding a session for the account they are changing, so
 * there is no unregistered address to be told apart from a registered one — there is no
 * address on the form at all. What has to hold is the other rule, the one that does not
 * depend on any of that: the sentence is chosen from the error's CODE and is never
 * Supabase's own text, and an unrecognised code falls to a neutral sentence rather than to
 * whatever the server happened to say.
 */
describe('passwordUpdateErrorMessage', () => {
  it('tells somebody their password is too weak, in our own words', () => {
    expect(passwordUpdateErrorMessage('weak_password')).toMatch(/password is too weak/i);
    expect(passwordUpdateErrorMessage('weak_password')).not.toBe(
      passwordUpdateErrorMessage(undefined),
    );
  });

  it('tells somebody who retyped their existing password what happened', () => {
    expect(passwordUpdateErrorMessage('same_password')).toMatch(/already your password/i);
    expect(passwordUpdateErrorMessage('same_password')).not.toBe(
      passwordUpdateErrorMessage('weak_password'),
    );
  });

  it('treats the two rate-limit codes as one thing a visitor can act on', () => {
    expect(passwordUpdateErrorMessage('over_request_rate_limit')).toBe(
      passwordUpdateErrorMessage('over_email_send_rate_limit'),
    );
    expect(passwordUpdateErrorMessage('over_request_rate_limit')).not.toBe(
      passwordUpdateErrorMessage(undefined),
    );
  });

  /**
   * The polarity, which is the part a future edit gets wrong. A `default` that relayed
   * `error.message` would satisfy every assertion above and put GoTrue's text on the page
   * for every code this switch has not heard of. The expired-session codes are the
   * concrete ones that land here today, and the sentence they get is the one that helps:
   * go and get a new link.
   */
  it.each([
    ['an unrecognised code', 'a-code-this-project-has-never-seen'],
    ['no code at all', undefined],
    ['a session that has gone', 'session_not_found'],
    ['a session that expired mid-form', 'session_expired'],
    ['a request GoTrue would not authenticate', 'not_authenticated'],
  ])('falls back to the neutral, actionable sentence for %s', (_label, code) => {
    const message = passwordUpdateErrorMessage(code);
    expect(message).toMatch(/expired or already been used/i);
    expect(message).toMatch(/request a new one/i);
  });

  it('never relays provider wording for any code it handles', () => {
    for (const code of [
      'weak_password',
      'same_password',
      'over_request_rate_limit',
      'over_email_send_rate_limit',
      'session_not_found',
      undefined,
    ]) {
      const message = passwordUpdateErrorMessage(code).toLowerCase();
      for (const leak of ['error_code', 'validation_failed', '"code":4', 'gotrue', 'supabase']) {
        expect(message).not.toContain(leak);
      }
    }
  });
});
