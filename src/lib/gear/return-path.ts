/**
 * "Saving returns you where you were" (PK-63) for the gear closet's create and edit
 * pages: same filters, same sort, same page, and Cancel lands in the same place. This
 * module exists to answer exactly one question — "what gear-closet URL does `raw`
 * carry?" — and deliberately answers nothing else.
 *
 * WHY NOT A SECOND VALIDATOR. The ticket's own callout is explicit: `safeNextPath`
 * (`src/lib/auth-routes.ts`) already solves the open-redirect problem a `?next=`
 * parameter creates, and it must stay the ONLY thing in this codebase that makes that
 * security decision. A second same-origin-path check here — even one that happened to
 * agree with `safeNextPath` on every input today — would be a second place a future
 * edit to the accepted shape could forget to touch, and the whole reason `safeNextPath`
 * carries the long "THE TABLE THAT LOOKED FULL AND TESTED ONE CLAUSE" warning in its own
 * test file is that this class of guard rots exactly that way. So this module never
 * inspects `raw` itself; it only ever asks `safeNextPath` and reads the answer —
 * everything below is a thin wrapper that keeps its verdict and swaps only the fallback
 * destination.
 *
 * WHY THIS MODULE NEEDS ITS OWN FALLBACK AT ALL. `safeNextPath` cannot be handed one —
 * it always resolves a refusal to `HOME_PATH` (`/`), the right default for a sign-in/
 * sign-up journey with no gear-specific meaning. The gear closet pages want `GEAR_PATH`
 * instead. That is NOT because `/` would strand a signed-in visitor: `homeDestination
 * (true)` (`src/lib/routes.ts:94-96`) already resolves `/` to `GEAR_PATH` for anyone
 * signed in, so redirecting there would cost one extra hop, not a wrong destination.
 * `src/lib/routes.ts:88-92` states the house rule this departs from — a journey that
 * wants to "send the visitor home" should route through `homeDestination` rather than
 * hard-coding a destination, so that changing what "home" means is one edit in one
 * place. This module hard-codes `GEAR_PATH` anyway because that rule is about a generic
 * "and then send them home" step; every caller here is a gear-closet page whose fallback
 * is not "home" in that general sense, it is "back to the closet list a moment ago",
 * which is `GEAR_PATH` regardless of what `/` means for anyone else. One redirect fewer
 * for the common case is the actual reason, not a stranding this file used to claim.
 *
 * HOW `gearReturnPathOrNull` TELLS "ACCEPTED" FROM "REFUSED" WITHOUT RE-VALIDATING.
 * `safeNextPath` returns its input VERBATIM when it accepts, and `HOME_PATH` when it
 * refuses — see that function's own doc comment. So:
 *
 *   const validated = safeNextPath(raw);
 *   return validated === raw ? validated : null;
 *
 * is sound because "the output equals the input" and "the input was accepted unchanged"
 * are the same fact, restated. This DEPENDS on `safeNextPath` echoing its input exactly
 * rather than normalising it (trimming, lower-casing a host, re-encoding). If a future
 * edit ever makes it return a normalised form of an accepted path, the identity check
 * above starts failing for every legitimate input, `gearReturnPathOrNull` starts
 * returning `null` for paths it used to accept, and every gear-closet return-to-caller
 * breaks LOUDLY — a visitor who typed a real filtered URL lands back on plain
 * `GEAR_PATH` instead — rather than silently widening what this module treats as
 * accepted. A loud, visible regression is the safe failure mode for a wrapper sitting
 * next to a security boundary; a silent one is not.
 *
 * THE `raw === '/'` EDGE CASE is exactly what makes this trick correct rather than
 * merely convenient. `/` starts with a single `/`, is not `//`, contains no backslash
 * and no colon, so `safeNextPath('/')` legitimately accepts it and returns `'/'`
 * unchanged — same-origin root is a perfectly good same-origin path. The identity check
 * sees `validated === raw` (`'/' === '/'`) and correctly reports "accepted", not
 * "refused" — a naive implementation that instead compared `raw` against `HOME_PATH`
 * (`'/'`) to detect a refusal would get this one case backwards, reading a legitimate
 * accept as a refusal purely because the accepted value and the refusal fallback happen
 * to share a spelling. The identity check never makes that comparison; it only ever
 * asks "did `safeNextPath` hand back what I gave it".
 */

// No GEAR_PATH import: this module no longer substitutes a fallback anywhere. Both
// exported readers hand back `null` and the two pages spell `?? GEAR_PATH` at the point
// of use — see the note on `gearReturnPathFromFormOrNull` for why the defaulted wrappers
// that used to live here were deleted rather than kept.
import { safeNextPath, NEXT_PARAM } from '../auth-routes';

/**
 * `raw`, validated by `safeNextPath`, with no fallback substituted — `null` when `raw`
 * was absent or refused, so a caller that needs to tell "nowhere to go back to" apart
 * from "go back to `GEAR_PATH`" can do so. `src/pages/gear/[id].astro` is exactly that
 * caller: on a successful edit it redirects to a carried return target when one exists,
 * but keeps its own `?updated=1` confirmation when none does — see that page's own
 * comment on the fork.
 */
export function gearReturnPathOrNull(raw: string | null | undefined): string | null {
  const validated = safeNextPath(raw);
  return validated === raw ? validated : null;
}

/**
 * Mirrors `nextFromForm`'s (`src/lib/auth-routes.ts`) field-then-query precedence —
 * read the hidden `NEXT_PARAM` field off the POSTed form first, falling back to the
 * URL's own query string — but, like `gearReturnPathOrNull` above, hands back `null`
 * rather than a defaulted destination when neither carries an accepted value. Needed
 * by any caller that has to tell "a valid return target was carried on this submission"
 * apart from "nothing usable was carried" — `src/pages/gear/[id].astro`'s successful-
 * edit fork is exactly that caller: see its own comment for why the two cases redirect
 * differently.
 *
 * WHY NOT CALL `nextFromForm` DIRECTLY. Only the fallback destination differs between
 * the two — `nextFromForm` (`src/lib/auth-routes.ts`) bakes `HOME_PATH` into its own
 * return value with no way for a caller to ask for a different one. Duplicating the
 * two-line field-then-query read here keeps the one security decision in `safeNextPath`
 * (which both this module and `nextFromForm` delegate to) while still letting the gear
 * pages land on `GEAR_PATH`.
 *
 * NO `?? GEAR_PATH` SIBLING. This module used to export defaulted wrappers alongside
 * both `*OrNull` functions, on the argument that call sites would otherwise repeat the
 * fallback. Neither wrapper ever acquired a caller: both pages need the `null` — for the
 * hidden `next` field, and for `[id].astro`'s successful-edit fork — so they hold the
 * `*OrNull` result and spell `?? GEAR_PATH` at the one point of use. The wrappers were
 * deleted rather than left exported with doc comments naming call sites that did not
 * exist. If a caller that genuinely only wants a destination ever appears, add one back.
 */
export function gearReturnPathFromFormOrNull(form: FormData, url: URL): string | null {
  const field = form.get(NEXT_PARAM);
  const raw = typeof field === 'string' ? field : url.searchParams.get(NEXT_PARAM);
  return gearReturnPathOrNull(raw);
}

/**
 * Builds the href a link INTO the gear item form (Add item, an item-name link) must
 * carry so `new.astro`/`[id].astro` can hand `currentView` back to `gearReturnPath` on
 * Cancel and on a successful save (PK-63) — the counterpart to `gearReturnPathFromForm`
 * for the read side of the same round trip. Lives here, rather than as a page-local
 * helper, so a test can reach it: `vitest.config.ts` excludes `src/pages/`, and this is
 * the entry point of this ticket's headline behaviour.
 *
 * Appends with `?` when `path` carries no query yet and `&` when it already does, so a
 * future caller whose `path` argument has its own query string is not silently handed a
 * malformed URL with two `?` characters in it. Built with `URLSearchParams` and
 * `NEXT_PARAM` — never hand-rolled string concatenation for the parameter itself — so
 * `currentView` is correctly percent-encoded regardless of what it contains (an `&`, a
 * `#`, a space).
 */
export function gearFormHrefReturningTo(path: string, currentView: string): string {
  const params = new URLSearchParams();
  params.set(NEXT_PARAM, currentView);
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}${params.toString()}`;
}
