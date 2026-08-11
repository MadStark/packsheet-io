/**
 * The gate in front of the one irreversible action this application has.
 *
 * WHY THIS IS A MODULE RATHER THAN THREE LINES IN THE PAGE, where it started. It was
 * three lines of `.astro` frontmatter, which is code no test in this repository can
 * reach: a `.astro` file is a component, its frontmatter runs only as part of rendering a
 * route, and vitest excludes `src/pages/` because every file there becomes a route. So
 * the check standing between a mis-click and a deleted account was the one piece of
 * authorization logic in the codebase with no test at all — not by anybody's decision,
 * but as a side effect of where it happened to be typed.
 *
 * Nothing here touches Supabase, an SDK or a session. It is a pure function over two
 * strings, which is also why it lives out here rather than in `src/lib/auth/`: the choke
 * point is for what must never be reachable from an anonymous route, and a string
 * comparison is not that. See src/lib/auth-routes.ts's header for the same reasoning
 * applied to route paths.
 *
 * WHAT THE GATE IS FOR, because it decides how strict the comparison should be. It is not
 * a password and not a second factor — whoever is looking at the page is already
 * authenticated as the account holder, and the typed address is displayed to them on the
 * same screen. Its whole job is DELIBERATENESS: making the destructive step something a
 * person performs on purpose rather than something a stray click, a double-submitted
 * form, or a cross-site POST can produce. That is why a two-step flow exists around it
 * (`?confirm-delete=1` reveals the form; nothing is deleted by loading a URL) and why
 * there is no `confirm()` dialog anywhere near it.
 */

/** The form's `intent` value for the destructive POST. A hidden field rather than a bare
 *  submit button, so a POST to this page that carries no intent at all — a stale form, a
 *  crafted request — does nothing rather than falling into the delete branch. */
export const DELETE_ACCOUNT_INTENT = 'delete-account';

/** The form field carrying the typed address. */
export const DELETE_ACCOUNT_CONFIRMATION_FIELD = 'confirmation';

/** Shown when the typed address does not match. Says what to do rather than what went
 *  wrong, and deliberately does not say how close the attempt was. */
export const CONFIRMATION_MISMATCH_MESSAGE =
  'That did not match your email address. Type it exactly to confirm.';

/**
 * Whether a typed confirmation authorises deleting the account belonging to `email`.
 *
 * Case and surrounding whitespace are ignored, and that is a decision rather than
 * sloppiness. A trailing space from a paste, or a capital letter from a phone keyboard's
 * autocapitalisation, is a keyboard artefact — it is not evidence that the person did not
 * mean it, and treating it as such produces the one outcome this flow must avoid: a
 * visitor who genuinely wants their account gone hammering the button, reading "that did
 * not match" against an address that visibly matches, and losing any sense that the
 * refusal means something. Nothing is protected by strictness here that deliberateness
 * does not already protect, because the correct answer is printed on the page.
 *
 * What is NOT relaxed, because both are the difference between a gate and a formality:
 *
 *   - An empty or whitespace-only entry never confirms, whatever `email` is. That is the
 *     shape of a form submitted without the field being filled in at all — a double
 *     submit, a crafted POST, a browser restoring a page — and it is the single most
 *     likely accidental input there is.
 *   - A missing `email` never confirms, whoever typed what. `User.email` is optional in
 *     Supabase's own type (an account created through a phone or an OAuth provider that
 *     returned none has no address), and the natural spelling of this check —
 *     `typed !== user.email` — QUIETLY INVERTS for such an account: `'' !== undefined` is
 *     true today, but any refactor that normalises both sides, or compares
 *     `String(user.email)`, turns "no address on file" into "anything matches, including
 *     nothing". The guard is written here so that it is one line with a test rather than a
 *     property of how somebody spelled a comparison.
 */
export function confirmsAccountDeletion(typed: string | null | undefined, email?: string): boolean {
  const wanted = (email ?? '').trim().toLowerCase();
  if (wanted === '') return false;
  return (typed ?? '').trim().toLowerCase() === wanted;
}
