/**
 * The typed-confirmation gate in front of account deletion.
 *
 * `tests/account-deletion.test.ts` proves the SQL function — that `delete_own_account()`
 * removes exactly the caller's rows and nothing else — and `tests/auth-flow.test.ts`
 * proves the module path reaches it with a real session. Neither says anything about what
 * has to be true before either is called, and until this file that was nothing: the gate
 * was three lines of `.astro` frontmatter, which vitest cannot reach at all (`src/pages/`
 * is excluded, because every file under it becomes a route). The one irreversible action
 * in the application was guarded by the only piece of authorization logic in the codebase
 * with no test — not by anybody's decision, but as a side effect of where it was typed.
 *
 * So the gate moved to src/lib/account-deletion.ts, a pure function over two strings, and
 * this is it under test. Read that file's header first for what the gate is FOR, which is
 * what decides how strict each case below ought to be: deliberateness, not secrecy — the
 * correct answer is printed on the page above the box.
 */

import { describe, expect, it } from 'vitest';
import {
  confirmsAccountDeletion,
  CONFIRMATION_MISMATCH_MESSAGE,
  DELETE_ACCOUNT_CONFIRMATION_FIELD,
  DELETE_ACCOUNT_INTENT,
} from '../src/lib/account-deletion';

const EMAIL = 'someone@packsheet.test';

describe('confirmsAccountDeletion', () => {
  it('confirms an exact match', () => {
    expect(confirmsAccountDeletion(EMAIL, EMAIL)).toBe(true);
  });

  /**
   * The cases that MUST NOT delete an account. Every one of them is a thing a browser or a
   * crafted request produces on its own, without a person having decided anything — which
   * is the entire class the gate exists to stop.
   */
  it.each([
    ['a different address', 'someone-else@packsheet.test'],
    ['the local part alone', 'someone'],
    ['a prefix of the address', 'someone@packsheet.tes'],
    ['the address with something appended', `${EMAIL}x`],
    ['an empty string — a form submitted with the field untouched', ''],
    ['whitespace only', '   \t '],
    ['no field on the request at all', null],
    ['a field the form did not carry', undefined],
  ])('refuses %s', (_label, typed) => {
    expect(confirmsAccountDeletion(typed, EMAIL)).toBe(false);
  });

  /**
   * The tolerated differences, and they are tolerated on purpose. A trailing space from a
   * paste and a capital from a phone keyboard are keyboard artefacts, not evidence that
   * somebody did not mean it — and a refusal shown against an address that visibly matches
   * is how a person learns that this dialog's refusals mean nothing.
   */
  it.each([
    ['surrounding whitespace', `  ${EMAIL} `],
    ['a different case', EMAIL.toUpperCase()],
    ['both at once', `\t${EMAIL.toUpperCase()}\n`],
  ])('accepts %s', (_label, typed) => {
    expect(confirmsAccountDeletion(typed, EMAIL)).toBe(true);
  });

  /**
   * The account with no address, which is the case the obvious inline spelling gets wrong
   * in the direction that deletes things. `User.email` is optional in Supabase's own type
   * — a phone sign-up, or an OAuth provider that returned no address — and a check written
   * as `typed !== user.email` is correct today by accident of `'' !== undefined`. Normalise
   * both sides, or compare `String(user.email)`, and "no address on file" becomes "anything
   * matches, including an empty box".
   */
  it.each([
    ['undefined', undefined],
    ['an empty string', ''],
    ['whitespace only', '   '],
  ])('refuses everything when the account’s own email is %s', (_label, email) => {
    expect(confirmsAccountDeletion('', email)).toBe(false);
    expect(confirmsAccountDeletion(null, email)).toBe(false);
    expect(confirmsAccountDeletion('   ', email)).toBe(false);
    expect(confirmsAccountDeletion(EMAIL, email)).toBe(false);
    expect(confirmsAccountDeletion('undefined', email)).toBe(false);
  });
});

/**
 * The form contract, pinned because the page and this file are the only two places that
 * know these names and a typo in either is silent: a POST whose `intent` does not match
 * falls through the delete branch and re-renders the page, which looks exactly like a
 * cancelled deletion rather than like a broken form.
 */
describe('the form contract', () => {
  it('names the fields the account page renders', () => {
    expect(DELETE_ACCOUNT_INTENT).toBe('delete-account');
    expect(DELETE_ACCOUNT_CONFIRMATION_FIELD).toBe('confirmation');
  });

  // The refusal says what to do and does not say how close the attempt was — a message
  // that reported "you typed 12 of 24 characters correctly" would turn a deliberateness
  // check into an oracle for an address the page is already displaying, which is
  // harmless here and is exactly the habit that is not harmless elsewhere.
  it('refuses with a message that says what to do rather than what was wrong', () => {
    expect(CONFIRMATION_MISMATCH_MESSAGE).toMatch(/type it exactly/i);
    expect(CONFIRMATION_MISMATCH_MESSAGE).not.toMatch(/character|letter|close/i);
  });
});
