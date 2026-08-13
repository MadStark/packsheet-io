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
 * inspects `raw` itself; it only ever asks `safeNextPath` and reads the answer.
 *
 * THE ONLY REASON THIS MODULE EXISTS AT ALL is that `safeNextPath` cannot be handed a
 * fallback — it always resolves a refusal to `HOME_PATH` (`/`), because that is the
 * right default for a sign-in/sign-up journey with no gear-specific meaning. The gear
 * closet pages need a different fallback: `GEAR_PATH`. Redirecting a refused or absent
 * `next` on `/gear/new` or `/gear/:id` to `/` would silently strand the visitor on the
 * generic router in `src/lib/routes.ts` instead of back on their own closet list — one
 * hop worse than simply landing on `GEAR_PATH` directly, for no benefit. Everything
 * below is a thin wrapper that keeps `safeNextPath`'s verdict and swaps only its
 * fallback destination.
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

import { safeNextPath, NEXT_PARAM } from '../auth-routes';
import { GEAR_PATH } from './routes';

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
 * `gearReturnPathOrNull(raw) ?? GEAR_PATH` — the gear closet's own equivalent of
 * `safeNextPath`, for every caller that just wants a URL to send the visitor to and has
 * no use for telling "absent" apart from "refused". Both new.astro and [id].astro use
 * this for their GET-render `cancelHref`/`next`, and new.astro also uses it for its
 * POST-success redirect, since a fresh item has no row of its own to fall back to
 * showing a confirmation on the way `[id].astro` does.
 */
export function gearReturnPath(raw: string | null | undefined): string {
  return gearReturnPathOrNull(raw) ?? GEAR_PATH;
}

/**
 * Mirrors `nextFromForm`'s (`src/lib/auth-routes.ts`) field-then-query precedence —
 * read the hidden `NEXT_PARAM` field off the POSTed form first, falling back to the
 * URL's own query string — with the gear closet's `GEAR_PATH` fallback in place of
 * `HOME_PATH`.
 *
 * WHY NOT CALL `nextFromForm` DIRECTLY. Only the fallback destination differs between
 * the two; the precedence (field, then query) and the security decision (`safeNextPath`)
 * are identical and must stay identical, since `nextFromForm` already delegates to
 * `safeNextPath` for that decision. But `nextFromForm` bakes `HOME_PATH` into its own
 * return value with no way for a caller to ask for a different fallback — it calls
 * `safeNextPath` and returns the result directly, so by the time this function saw that
 * return value, "refused" and "not supplied" would already have collapsed into
 * `HOME_PATH` with no way to tell them apart from a value that legitimately validated to
 * `/`. Duplicating the two-line field-then-query read here, then handing the raw result
 * to `gearReturnPath` above, keeps the ONE security decision in `safeNextPath` while
 * still landing on `GEAR_PATH` rather than `HOME_PATH` for this form.
 */
export function gearReturnPathFromForm(form: FormData, url: URL): string {
  const field = form.get(NEXT_PARAM);
  const raw = typeof field === 'string' ? field : url.searchParams.get(NEXT_PARAM);
  return gearReturnPath(raw);
}
