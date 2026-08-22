/**
 * The decisions behind the gear closet list updating IN PLACE (PK-70) — everything about
 * that EXCEPT the three calls only a real browser can make: `fetch`, `history.replaceState`,
 * and `Element.scrollIntoView`. Read `src/lib/modal.ts`'s header first; this module exists
 * for the identical reason and follows its shape on purpose — an attribute vocabulary, small
 * pure functions, an init function that wires them to a real document, seams injected as
 * `deps` rather than reached for as globals. `vitest.config.ts:64` excludes `src/pages/**`,
 * so a `<script>` block in `src/pages/gear/index.astro` is code no test in this repository can
 * reach; this module is where that logic goes instead, and its tests are `tests/gear-live-list.test.ts`.
 *
 * ---------------------------------------------------------------------------
 * THE TECHNIQUE, AND WHY IT IS NOT A SECOND RENDERER
 * ---------------------------------------------------------------------------
 *
 * PK-70 is deliberately fetch-the-same-page-and-swap, not a client-side re-implementation of
 * the list. The server in `src/pages/gear/index.astro` is the only thing that knows how to
 * turn a `GearQuery` into rows — `src/lib/gear/query.ts` parses the URL, `format.ts` renders a
 * weight or a price, `fields.ts` says what a valid sort key is — and every one of those stays
 * server-side. Typing a search character, ticking a status, clicking a sort header or a pager
 * link builds the same URL a full navigation would have (`filterFormUrl`, the anchor's own
 * `href`), fetches it, and grafts the parts of the response that changed into the current
 * document. No row formatting is duplicated into client JS, because none exists to duplicate:
 * this module never reads `item.weight_grams` or `item.status`, only markup it did not write.
 *
 * ---------------------------------------------------------------------------
 * WHY EVERY DECISION BELOW IS ARGUED
 * ---------------------------------------------------------------------------
 *
 * The whole reason this is a module and not a `<script>` block is that its wrong answers are
 * SILENT, the same claim `modal.ts` makes and for the same reason: nothing here throws in a
 * way a visitor or a developer would see. A stale response painted over a newer one looks like
 * a list that "sometimes shows the wrong page" with no reproduction. A click handler bound to
 * a link this module itself just replaced looks like a sort header that "stops working after
 * the first click" with no error anywhere — the listener is not broken, it is gone, attached
 * to a node no longer in the document. A swap that returns zero regions on a session-expiry
 * redirect looks like a filter that "just doesn't do anything" instead of the sign-in page the
 * visitor actually needs. Each of those has a rule below that exists only because one of them
 * was the failure mode, not a hypothetical.
 *
 * ---------------------------------------------------------------------------
 * THE PAGE CONTRACT THIS MODULE IS WRITTEN AGAINST
 * ---------------------------------------------------------------------------
 *
 * `src/pages/gear/index.astro` (owned by a separate PK-70 change) renders:
 *
 *   - The filter `<form id="gear-filters" method="GET" action="/gear">` — search (`q`),
 *     three status checkboxes (`status`), hidden `sort`/`dir`, and the hidden re-emitted
 *     filters `unsurfacedFilterParams` already produces (`src/lib/gear/query.ts`). This form
 *     is NEVER one of the swapped regions, which is what lets this module bind directly to
 *     its search input and checkboxes once at init instead of through the delegated listener
 *     the live links need — see `initGearLiveList`'s own note on that split.
 *   - Regions, each carrying `LIVE_REGION_ATTRIBUTE` and a unique `id`. This module swaps
 *     however many it finds; the closet renders three, and the second and third are the ones
 *     worth explaining because neither is the list:
 *       * the list itself — the table, the bulk bar and the pager, or the "no items match"
 *         block that replaces all three;
 *       * the headline figures, which sit in the header sheet and would otherwise go stale
 *         the moment a filter changed the count — a visitor who searches down to 3 items and
 *         still reads "Items 47" above the fold has not been told anything false, but has
 *         been told something IRRELEVANT with total confidence;
 *       * the header's own action links. Those carry `gearFormHrefReturningTo(…, currentView)`
 *         — a `next=` pointing at the view the server rendered — so left unswapped, saving an
 *         item after an in-place filter change would land the visitor back on the view they
 *         had before they filtered. Silent, and only noticed one navigation later.
 *   - Live links: `LIVE_LINK_ATTRIBUTE` set to `sort:<key>` on a column header, `page:prev` /
 *     `page:next` on the pager — real `<a href>`s underneath, so a platform this module never
 *     initialised on (a 404'd bundle, a CSP, an exception earlier in the same bundle — the
 *     same list `modal.ts`'s header gives) still has working navigation. `initModals` calls
 *     this "the degradation inversion"; the pattern here is the same inversion applied to a
 *     list instead of a link.
 *   - A visually-hidden, PERSISTENT `#gear-live-status`, outside every swapped region so it is
 *     never itself replaced (a swap would clear whatever a screen reader had queued to read).
 *   - `LIVE_SUMMARY_ATTRIBUTE` inside the list region, on the "Showing 1–12 of 47" line.
 *
 * Every name above is exported as a constant rather than typed twice, for the exact reason
 * `modal.ts`'s attribute section gives: two literals agreeing by coincidence is one rename
 * away from a feature that is silently dead while every test stays green, because the client
 * finds nothing and the fallback — a real link, a real GET — is indistinguishable from success
 * until someone notices the list never moves.
 */

import { GEAR_DEFAULT_DIRECTION, GEAR_DEFAULT_SORT } from './fields';

// ---------------------------------------------------------------------------
// The attribute vocabulary
// ---------------------------------------------------------------------------

/** The filter form's `id`. `method="GET" action="/gear"` on the element itself is what makes
 *  the no-JS path a plain, bookmarkable navigation; this module never changes either. */
export const GEAR_FILTERS_FORM_ID = 'gear-filters';

/** The persistent, visually-hidden live region an update's result count is announced into.
 *  Outside every element `swapLiveRegions` touches — see this module's header. */
export const GEAR_LIVE_STATUS_ID = 'gear-live-status';

/** Marks an element this module replaces wholesale on every update. An attribute rather than
 *  a class for the same reason `MODAL_ATTRIBUTE` is: nothing should be able to make a
 *  stylesheet depend on it by accident. */
export const LIVE_REGION_ATTRIBUTE = 'data-gear-live-region';

/** The value names what to do: `sort:<key>` or `page:prev` / `page:next` — see
 *  `liveLinkKind`. */
export const LIVE_LINK_ATTRIBUTE = 'data-gear-live-link';

/** Marks the "Showing 1–12 of 47" line inside the list region — the text `liveStatusMessage`
 *  reads and announces. */
export const LIVE_SUMMARY_ATTRIBUTE = 'data-gear-summary';

/**
 * Set on the filter form the moment this module has finished wiring it up — BEFORE anything
 * else below runs, which `initGearLiveList` argues for at its own call site.
 *
 * THE HANDSHAKE THIS ATTRIBUTE IS FOR, which is the single most confusing thing in this file
 * and is written down here as well as there: `src/pages/gear/index.astro` renders an inline,
 * `is:inline` script (so it cannot fail to load — see that file's own comment, which makes
 * the same argument `modal.ts`'s header makes about `<noscript>` guarding the wrong
 * condition) that installs a `change` listener on the status checkboxes and calls
 * `form.requestSubmit()` — the full-page-submit fallback for a bundled module that 404s, is
 * blocked by a CSP, or throws earlier in its own file.
 *
 * THE CHECK HAPPENS WHEN THE CHECKBOX CHANGES, NOT WHEN THE LISTENER IS INSTALLED, and that
 * is the only order that can work. The inline script runs FIRST by construction — it is
 * `is:inline`, at the foot of the document, and therefore executes during parsing, before any
 * bundled module has loaded. At the moment it installs its listener this attribute is
 * ALWAYS absent, so a check there would read "no module" on every single visit and arm the
 * fallback every time, which is precisely the double-fire it exists to prevent. Its handler
 * instead re-reads the attribute each time it fires, by which point this module has either
 * initialised (attribute present — the handler returns and the in-place update below handles
 * the tick) or has genuinely never arrived (attribute absent — the handler submits the form
 * and the visitor gets a full-page navigation, exactly as before PK-70).
 *
 * WHAT THE ORDER INSIDE THIS MODULE STILL BUYS. `initGearLiveList` sets this attribute
 * synchronously, first thing, before it installs a listener of its own. That closes the
 * narrower window where a tick arriving between "this module started initialising" and "this
 * module is ready" would be handled by neither: with the attribute set first, such a tick is
 * swallowed by the fallback's early return and then handled by this module's own listener,
 * rather than being submitted full-page by one and updated in place by the other.
 *
 * AN EARLIER VERSION OF THIS PARAGRAPH DESCRIBED THE OPPOSITE ARRANGEMENT — that the inline
 * script "checks for this attribute before installing its listener" and "reads it exactly
 * once" — and it was wrong in a way worth recording, because it reads as plausible and would
 * have made the fallback fire on every visit alongside the in-place update. It was caught
 * while wiring the page up against it.
 */
export const LIVE_READY_ATTRIBUTE = 'data-gear-live-ready';

/** How long a keystroke in the search field waits before it fetches, so that typing "boots"
 *  does not issue seven overlapping requests for "b", "bo", "boo", … — see `initGearLiveList`
 *  point (b) and the stale-response handling in `swapLiveRegions`'s caller. */
export const GEAR_SEARCH_DEBOUNCE_MS = 250;

/** What `liveStatusMessage` announces when the swapped list carries no `LIVE_SUMMARY_ATTRIBUTE`
 *  at all — the "no items match these filters" state, which renders no "Showing…" line
 *  because there is nothing to show a range of. */
export const NO_RESULTS_ANNOUNCEMENT = 'No items match these filters.';

// ---------------------------------------------------------------------------
// filterFormUrl
// ---------------------------------------------------------------------------

/**
 * The absolute URL the filter form would have navigated to, built from its own fields rather
 * than from `location.search` — which is what lets this run from the search field's `input`
 * event, mid-keystroke, before the value that matters has been committed to anything but the
 * DOM.
 *
 * `form.action` RATHER THAN A HAND-ROLLED JOIN. The `action` IDL attribute is a reflected URL
 * attribute: the platform resolves the content attribute's `"/gear"` against the document's
 * own URL and hands back an absolute string, which is exactly "the form's action resolved
 * against the document" the contract asks for, with no path-joining logic here to get wrong.
 *
 * `FormData` VALUES ARE `string | File`, AND A FILE IS SKIPPED RATHER THAN COERCED. There is
 * no file input on this form today, but `FormData` is a general contract and `String(file)`
 * silently produces the literal text `"[object File]"` as a query value — a request that
 * "succeeds" against a query the visitor never asked for, with nothing anywhere to say a
 * filename went missing. Skipping is the only answer that cannot manufacture a wrong filter.
 *
 * `page` IS DELIBERATELY ABSENT FROM THE FORM, not filtered out here — there is no field
 * named `page` for `FormData` to find. That is `src/pages/gear/index.astro`'s own choice,
 * carried over unchanged from `sortLinkSearchParams`'s reasoning in `src/lib/gear/query.ts`:
 * a new search or a newly ticked status changes what "page 3" even means, so a fresh filter
 * always lands on page 1 rather than an honest-looking but wrong slice of a different result
 * set. This function does not need to enforce that; it only needs not to invent a `page` the
 * form was never given.
 *
 * REPEATED FIELDS ARE PRESERVED IN ORDER. `URLSearchParams.append` is used rather than `set`,
 * so three ticked status checkboxes — all named `status` — produce three `status=` params
 * rather than the form's own multiplicity collapsing to one on the way through this function.
 */
export function filterFormUrl(form: HTMLFormElement): string {
  const url = new URL(form.action);
  const params = new URLSearchParams();
  for (const [name, value] of new FormData(form)) {
    if (typeof value !== 'string') continue; // a File — see the comment above.
    params.append(name, value);
  }
  url.search = params.toString();
  return url.toString();
}

// ---------------------------------------------------------------------------
// isModifiedClick
// ---------------------------------------------------------------------------

/** The four fields `isModifiedClick` reads off a click, structural so a test can state one
 *  without dispatching a real `MouseEvent` — the same reasoning `ModalPointer` in `modal.ts`
 *  gives for not asking for a whole `MouseEvent`. */
export interface LiveClickEvent {
  readonly button: number;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}

/**
 * True for any click that is not a plain left click — the browser's own "open this
 * somewhere else" gestures: Cmd/Ctrl-click and a middle click open a new tab, Shift-click a
 * new window. `upgradeTrigger` in `modal.ts` makes the identical check for the identical
 * reason, restated here rather than imported, because this module has to stay reachable from
 * a page that never touches `src/lib/modal.ts` and importing across features for six lines of
 * boolean logic would only be coupling with no payoff.
 *
 * GETTING THIS WRONG IS SILENT IN A SPECIFIC WAY: swallowing a modified click does not throw
 * and does not visibly fail. The tab that should have opened simply never does, and the
 * visitor is left thinking Cmd-click stopped working on this one page — with every other
 * signal (the link still has its `href`, the click still "did something") suggesting nothing
 * is wrong.
 */
export function isModifiedClick(event: LiveClickEvent): boolean {
  return event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
}

// ---------------------------------------------------------------------------
// liveLinkKind
// ---------------------------------------------------------------------------

/** What a `LIVE_LINK_ATTRIBUTE` value means: a column header naming the sort key it toggles,
 *  or a pager edge. */
export type LiveLinkKind =
  | { readonly kind: 'sort'; readonly key: string }
  | { readonly kind: 'page'; readonly edge: 'prev' | 'next' };

/**
 * Parses a `LIVE_LINK_ATTRIBUTE` value, or answers `null` for anything it does not recognise
 * — NEVER by throwing.
 *
 * `null` HAS TO FALL THROUGH TO A NORMAL NAVIGATION, NOT TO NOTHING. Every live link is a
 * real `<a href>` underneath the attribute — the same degradation-inversion argument
 * `modal.ts`'s header makes about a trigger's own `href`. If a future sort key or page edge
 * this function has not been taught yet ships on the markup side before this module does,
 * the honest answer is "I don't understand this value" — which the caller in
 * `initGearLiveList` reads as "do not intercept this click", letting the anchor's own href
 * carry the visitor to a real, freshly-rendered page. Throwing here would take down every
 * OTHER live link on the page too, since this runs inside one shared delegated listener; the
 * one link with an out-of-date value costs nothing beyond itself.
 *
 * `key` IS RETURNED AS A BARE `string`, NOT VALIDATED AGAINST `GearSortKey`. That validation
 * already happens, once, on the server: `parseGearQuery` in `src/lib/gear/query.ts` falls
 * back to `'name'` for anything `isGearSortKey` refuses. Re-checking it here would be a
 * second copy of a rule this module has no way to keep in sync with the first.
 */
export function liveLinkKind(value: string | null): LiveLinkKind | null {
  if (value === null) return null;
  if (value === 'page:prev') return { kind: 'page', edge: 'prev' };
  if (value === 'page:next') return { kind: 'page', edge: 'next' };
  if (value.startsWith('sort:')) {
    const key = value.slice('sort:'.length);
    if (key === '') return null; // "sort:" with nothing after it names no column.
    return { kind: 'sort', key };
  }
  return null;
}

// ---------------------------------------------------------------------------
// swapLiveRegions
// ---------------------------------------------------------------------------

/** Finds the element carrying `id` anywhere under `root`, by comparing the `id` PROPERTY
 *  rather than interpolating it into a selector. `next` is a document freshly parsed from a
 *  server response, never a selector this module composed itself, so there is no injection
 *  risk to guard against — this is a plainer tool than `CSS.escape` plus a template string,
 *  not a safer one, and it works identically whether `root` is a `Document` (which has its
 *  own faster `getElementById`) or a `ParentNode` that is not, which is what the exported
 *  signature below promises callers. */
function findElementById(root: ParentNode, id: string): Element | null {
  for (const candidate of root.querySelectorAll('[id]')) {
    if (candidate.id === id) return candidate;
  }
  return null;
}

/**
 * Grafts every region of `next` onto the matching region of `current`, in place, and reports
 * which ids it actually touched.
 *
 * MATCHED BY `id`, NOT BY POSITION OR COUNT. The list region and the headline figures are not
 * siblings and do not appear in the same order in every state (the "no items match" block
 * replaces the table entirely), so the only correspondence that means anything is "these two
 * elements are the same region" — which is what an `id` states and a DOM position does not.
 *
 * AN id IN `current` WITH NO MATCH IN `next` IS LEFT ALONE, NOT BLANKED, AND NOT COUNTED.
 * The realistic way to reach this is a markup drift between what this module was built
 * against and what actually shipped — not a case to paper over with an empty region, which
 * would replace working content with nothing for a reason nobody could see. Leaving it alone
 * means the worst case is a region that did not update, which is recoverable (a full
 * navigation still works) rather than a list that visibly vanished.
 *
 * AN EMPTY RETURN IS THE CALLER'S SIGNAL THAT `next` WAS NOT A CLOSET PAGE AT ALL. The
 * realistic way to reach zero matches for EVERY region at once is a redirect to sign-in after
 * a session expired mid-visit: the fetched HTML is real, parses fine, and shares not one
 * region id with the page that requested it. `initGearLiveList` reads that as "fall back to
 * `navigate(url)`" — see its own note (g) — rather than silently leaving the last good list on
 * screen while the visitor is actually signed out.
 *
 * `innerHTML` IS REPLACED, NOT THE ELEMENT ITSELF. Swapping the whole node would drop
 * `LIVE_REGION_ATTRIBUTE` and the `id` along with it — both live ON the element this function
 * was told to find by that same `id` — silently un-registering the region for every update
 * after the first.
 */
export function swapLiveRegions(current: ParentNode, next: ParentNode): string[] {
  const swapped: string[] = [];
  for (const region of current.querySelectorAll(`[${LIVE_REGION_ATTRIBUTE}]`)) {
    const id = region.id;
    if (id === '') continue; // Nothing can be matched to it — see findElementById.
    const match = findElementById(next, id);
    if (match === null) continue; // Left alone; see this function's own header.
    region.innerHTML = match.innerHTML;
    swapped.push(id);
  }
  return swapped;
}

// ---------------------------------------------------------------------------
// liveStatusMessage
// ---------------------------------------------------------------------------

/**
 * The text to announce after an update: the "Showing 1–12 of 47" line inside `region`,
 * trimmed and with internal whitespace collapsed, or `NO_RESULTS_ANNOUNCEMENT` when there is
 * none.
 *
 * TEXT, NOT A RE-DERIVATION OF THE COUNT. `region` is server-rendered markup this module
 * never wrote — the number in it came from `rangeStart`/`rangeEnd`/`totalCount` in
 * `src/pages/gear/index.astro`, computed against `count` from the actual query. Recomputing
 * that here from whatever this module happens to know would be a second implementation with
 * no way to stay honest against the first; reading the rendered text is the whole of "no row
 * formatting duplicated into client JS" applied to the summary line too.
 *
 * WHITESPACE IS COLLAPSED BECAUSE THE SOURCE MARKUP WRAPS ACROSS JSX EXPRESSIONS: `Showing
 * {rangeStart}–{rangeEnd} of {totalCount}` renders with the newlines and indentation the
 * template itself carries between expressions, which `textContent` reports verbatim. A screen
 * reader announcing a wall of raw whitespace between digits is a worse outcome than reading
 * nothing.
 *
 * `NO_RESULTS_ANNOUNCEMENT` FOR "NO SUMMARY FOUND", NOT FOR "EMPTY TEXT FOUND". Those are
 * different conditions: the "no items match" block genuinely renders no `LIVE_SUMMARY_ATTRIBUTE`
 * element at all, which is the only case this constant is for. An element that carries the
 * attribute but happens to be empty is a markup bug on the page side, and returning the empty
 * string for it — the honest reading of "the text of this element" — is what lets a test
 * catch that bug instead of this function quietly disguising it as "no results".
 */
export function liveStatusMessage(region: ParentNode): string {
  const summary = region.querySelector(`[${LIVE_SUMMARY_ATTRIBUTE}]`);
  if (summary === null) return NO_RESULTS_ANNOUNCEMENT;
  return (summary.textContent ?? '').trim().replace(/\s+/g, ' ');
}

// ---------------------------------------------------------------------------
// syncFilterFormToUrl
// ---------------------------------------------------------------------------

/**
 * WHY A URL WITH NO `sort` PARAM STILL HAS TO WRITE ONE INTO THE FORM.
 * `gearQueryToSearchParams` omits `sort`/`dir` entirely when they equal the defaults —
 * `/gear?q=boots` carries no `sort` at all if the visitor is on the default order — so a
 * missing param does not mean "leave the hidden input alone", it means "this query IS the
 * default column and direction", and the input has to be set to that explicitly. Left
 * unwritten, a sort back to the default would strand the previous sort in the form and the
 * next keystroke would silently reorder the list.
 *
 * IMPORTED FROM `fields.ts`, NOT RESTATED HERE. An earlier draft of this module wrote the two
 * values as its own literals, on the argument that importing `query.ts` would drag the
 * Supabase-shaped module graph behind it into a client bundle. That argument was right about
 * `query.ts` and wrong about the conclusion: `fields.ts` is the closet's VOCABULARY module,
 * it imports one erased type and nothing else, and it is where the rest of this vocabulary
 * (`GEAR_SORT_KEYS`, `GEAR_STATUSES`) already lives. Restating the pair would have left the
 * server rendering one default and this module writing another the moment either changed —
 * silently, since both halves would still be individually valid.
 */

/**
 * After a SORT swap the list is now ordered by a different column, but the form's own hidden
 * `sort`/`dir` inputs were rendered for the PREVIOUS order and nothing else updates them —
 * they are inside `#gear-filters`, which is never one of the swapped regions. Left alone, the
 * next keystroke in the search box would silently discard the sort the visitor just chose:
 * `filterFormUrl` reads those hidden inputs as part of the form's own fields, so a stale `dir`
 * would ride along into a request that has nothing to do with sorting at all.
 *
 * ONLY `sort` AND `dir` ARE TOUCHED. In particular the search input's OWN value is never
 * written here, even though `url` may carry a `q` this function could read. A visitor mid-word
 * in the search box — which is exactly when an `input`-triggered update fires — has their
 * caret position tied to that field's value; overwriting it out from under them, even with the
 * text they themselves just typed, would move the caret to the end of the field on every
 * keystroke and make the search box unusable while it has focus. `filterFormUrl` already reads
 * the field's live value directly, so there is nothing this function needs to write back for
 * search to keep working.
 */
export function syncFilterFormToUrl(form: HTMLFormElement, url: string): void {
  const parsed = new URL(url, form.action);
  const sort = form.elements.namedItem('sort');
  const direction = form.elements.namedItem('dir');
  if (sort instanceof HTMLInputElement)
    sort.value = parsed.searchParams.get('sort') ?? GEAR_DEFAULT_SORT;
  if (direction instanceof HTMLInputElement)
    direction.value = parsed.searchParams.get('dir') ?? GEAR_DEFAULT_DIRECTION;
}

// ---------------------------------------------------------------------------
// initGearLiveList
// ---------------------------------------------------------------------------

/**
 * The seams a real browser has and jsdom does not fake for free — the same role
 * `ModalDialog`'s two methods play in `modal.ts`, generalised to a whole handful of platform
 * calls instead of two. Injecting them is what lets `tests/gear-live-list.test.ts` drive a
 * debounce without a real timer, assert a fetch happened without a real network, and assert a
 * scroll happened without a real layout engine — none of which jsdom can do (see `modal.ts`'s
 * header on what jsdom 30 measurably lacks; the same gap applies to `fetch` and
 * `history.replaceState`, neither of which this module calls directly for that reason).
 */
export interface GearLiveListDeps {
  /** Fetches `url` and resolves to the response body as text, or `null` for anything that is
   *  not a plain, same-document success: a thrown network error, a non-OK status, or a
   *  response that redirected somewhere this module did not ask for (a session-expiry
   *  redirect to sign-in is the realistic case — see `swapLiveRegions`'s own note on the zero
   *  -region fallback this feeds). `null` is a value, not an exception, precisely so
   *  `initGearLiveList` never needs a `try`/`catch` around ordinary control flow to tell "the
   *  server said no" apart from "a bug in this module". */
  fetchPage(url: string): Promise<string | null>;
  /** A real, full-page navigation — the fallback every failure path below converges on. */
  navigate(url: string): void;
  /** `history.replaceState`, specifically NOT `pushState` — see point (e) below for why the
   *  distinction is the ticket's own explicit choice and not an oversight. */
  replaceUrl(url: string): void;
  /** `Element.scrollIntoView`, called with no options — DESIGN.md §11 forbids animating it
   *  (point (h) below), and exposing it as a seam is what lets a test assert it happened
   *  without a layout engine to make a real scroll observable. */
  scrollIntoView(element: Element): void;
  /** Defaults to the real globals. Only ever overridden by a test, so the debounce in (b) can
   *  be driven by a fake clock instead of a real 250ms wait. */
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
}

/**
 * Wires the closet's filter form and live links up to update in place, and returns a
 * teardown, or `null` when there is nothing to wire.
 *
 * `null` FOR A MISSING FORM OR MISSING REGIONS IS AN ORDINARY STATE, NOT AN ERROR. The
 * closet's own empty state (`src/pages/gear/index.astro`'s `closetIsEmpty` branch) renders no
 * filter form and no live region at all — there is nothing to search, sort or page through —
 * so finding neither here is the expected shape of that page, not a markup bug to warn about.
 * Warning on it would train whoever reads the console to ignore a warning that fires on every
 * visit to an empty closet, which is exactly how a warning that matters gets lost in one that
 * does not.
 *
 * BEHAVIOUR, IN THE ORDER IT RUNS:
 *
 *   (a) THE READY HANDSHAKE IS SET FIRST, before a single listener is installed — see
 *       `LIVE_READY_ATTRIBUTE`'s own header for the full argument. It has to be unconditional
 *       on reaching this point at all (not deferred behind, say, a successful first fetch),
 *       because the inline fallback script has already run by the time this module's own
 *       `<script>` executes and reads this attribute exactly once.
 *   (b) Search input is debounced by `GEAR_SEARCH_DEBOUNCE_MS`; each keystroke clears any
 *       pending update and schedules a new one, so only the last keystroke in a burst issues
 *       a fetch.
 *   (c) A status checkbox's `change` updates immediately — no debounce, because a checkbox
 *       does not fire `change` per keystroke; there is nothing to burst.
 *   (d) LIVE LINKS ARE BOUND WITH ONE DELEGATED LISTENER ON `doc`, NOT ONE PER LINK. A sort
 *       header or a pager link lives inside a region THIS MODULE ITSELF REPLACES on every
 *       update — `swapLiveRegions` overwrites the region's `innerHTML`, which detaches every
 *       node inside it, listeners included. A listener attached to the link directly would
 *       work for exactly one click, then silently stop, with nothing about the replaced markup
 *       suggesting why — the same shape of failure `pairModalTriggers` in `modal.ts` was
 *       rewritten to avoid for the identical reason. Delegating to `doc`, which this module
 *       never replaces, is what survives every swap.
 *   (e) ON A SUCCESSFUL UPDATE: swap the regions, sync the form's `sort`/`dir`, then
 *       `replaceUrl(url)` — REPLACE, NOT PUSH. Every keystroke in the search box is a distinct
 *       update; `pushState`-per-keystroke would mean the visitor's browser Back button has to
 *       be pressed once per character typed before it leaves this page at all, which is the
 *       opposite of what Back is for. `replaceState` keeps the address bar honest and
 *       shareable — the URL always names the filtered view currently on screen — without
 *       burying the page the visitor actually navigated FROM under a stack of keystrokes.
 *       Finally the live region's text is set to `liveStatusMessage(doc)`, announcing the new
 *       count.
 *   (f) STALE RESPONSES ARE DISCARDED BY A MONOTONIC TOKEN. Typing fast issues overlapping
 *       fetches ("boo" then "boot" before "boo"'s response has landed) that can resolve in
 *       either order; painting whichever arrives LAST is wrong exactly when the network
 *       reorders them, silently showing a stale result set with nothing on screen to say it is
 *       stale. Every call to `update` takes the next token before it awaits anything; a
 *       response is applied only if its token is still the newest one issued.
 *   (g) FAILURE IS NEVER SILENT: a null/thrown `fetchPage`, or a `swapLiveRegions` that
 *       matched nothing (see that function's own note on what a zero-match response usually
 *       means), both fall back to `navigate(url)`. The alternative — leaving the control
 *       looking like it did nothing — is indistinguishable from "this feature is broken" to
 *       everyone who is not reading this file.
 *   (h) FOR A `page:` LINK ONLY, after the swap the list region's own top is scrolled back
 *       into view — a multi-page list can be taller than the viewport, and without this,
 *       paging from row 50 leaves the visitor's scroll position wherever it was, looking at
 *       whatever rows happen to occupy that position in the NEW page, which is not the top of
 *       anything. `deps.scrollIntoView` is called with no options: DESIGN.md §11 says paper
 *       does not animate, so this is a plain jump, not `{ behavior: 'smooth' }`. A sort click
 *       does NOT scroll — the visitor is already looking at the header row they just clicked,
 *       and moving their view out from under them for a click that did not change how many
 *       rows are on screen has no page to have scrolled away from.
 */
export function initGearLiveList(doc: Document, deps: GearLiveListDeps): (() => void) | null {
  const formCandidate = doc.getElementById(GEAR_FILTERS_FORM_ID);
  if (!(formCandidate instanceof HTMLFormElement)) return null;

  const liveStatusCandidate = doc.getElementById(GEAR_LIVE_STATUS_ID);
  const hasLiveRegion = doc.querySelector(`[${LIVE_REGION_ATTRIBUTE}]`) !== null;
  if (liveStatusCandidate === null || !hasLiveRegion) return null;

  // Bound to new names, typed explicitly, rather than used as `formCandidate`/
  // `liveStatusCandidate` from here on: TypeScript's control-flow narrowing above does not
  // reach into the nested `update` closure below (it re-widens any captured outer variable
  // to its declared type inside a function body, even a `const` one), so referencing the
  // narrowed names directly inside `update` would need a non-null assertion at every use —
  // an assertion this module's own house rules argue against elsewhere (see `modal.ts`'s
  // header on why a cast that tells the compiler something false is worse than a runtime
  // check). One clean binding here, still backed by the real runtime checks above, keeps
  // every use below honestly typed.
  const form: HTMLFormElement = formCandidate;
  const liveStatus: HTMLElement = liveStatusCandidate;

  const setTimeoutFn = deps.setTimeoutImpl ?? setTimeout;
  const clearTimeoutFn = deps.clearTimeoutImpl ?? clearTimeout;

  // (a) — see LIVE_READY_ATTRIBUTE's own header for the handshake this is half of.
  form.setAttribute(LIVE_READY_ATTRIBUTE, '');

  const abort = new AbortController();
  const { signal } = abort;

  // (f) — bumped before every fetch starts, read back after it resolves. A response is
  // applied only if it is still the newest thing this module asked for.
  let latestToken = 0;
  let pendingSearch: ReturnType<typeof setTimeout> | null = null;

  async function update(url: string, scrollRegionId: string | null): Promise<void> {
    const token = ++latestToken;

    let html: string | null;
    try {
      html = await deps.fetchPage(url);
    } catch {
      html = null;
    }

    if (token !== latestToken) return; // (f) — superseded by a later update; drop this one.

    if (html === null) {
      deps.navigate(url); // (g)
      return;
    }

    const nextDocument = new DOMParser().parseFromString(html, 'text/html');
    const swapped = swapLiveRegions(doc, nextDocument);
    if (swapped.length === 0) {
      deps.navigate(url); // (g) — see swapLiveRegions's own note on what this usually means.
      return;
    }

    syncFilterFormToUrl(form, url);
    deps.replaceUrl(url); // (e) — replaceState, deliberately not pushState.
    liveStatus.textContent = liveStatusMessage(doc);

    if (scrollRegionId !== null) {
      // (h) — only reached for a page: link; see the caller below. Looked up fresh, after
      // the swap, because the swap just replaced this region's own contents (though not the
      // region element itself — swapLiveRegions rewrites innerHTML, not the node — so the id
      // still resolves to the same element it did before the fetch).
      const region = doc.getElementById(scrollRegionId);
      if (region !== null) deps.scrollIntoView(region);
    }
  }

  // (b) — debounced search.
  const search = form.elements.namedItem('q');
  if (search instanceof HTMLInputElement) {
    search.addEventListener(
      'input',
      () => {
        if (pendingSearch !== null) clearTimeoutFn(pendingSearch);
        pendingSearch = setTimeoutFn(() => {
          pendingSearch = null;
          void update(filterFormUrl(form), null);
        }, GEAR_SEARCH_DEBOUNCE_MS);
      },
      { signal },
    );
  }

  // (c) — immediate on a status change. Any pending debounced search is cancelled first,
  // rather than left to fire on top of this: without it, ticking a status while a debounced
  // keystroke is still in flight would issue two fetches with two different windows to have
  // been the "latest", both harmless on their own (the token still resolves it) but wasteful
  // for no benefit — this update already carries the field's current value.
  for (const box of form.querySelectorAll<HTMLInputElement>(
    'input[type="checkbox"][name="status"]',
  )) {
    box.addEventListener(
      'change',
      () => {
        if (pendingSearch !== null) {
          clearTimeoutFn(pendingSearch);
          pendingSearch = null;
        }
        void update(filterFormUrl(form), null);
      },
      { signal },
    );
  }

  // (d) — one delegated listener, because a per-link listener would be dead after the first
  // swap. See this function's own header for the failure that names.
  doc.addEventListener(
    'click',
    (event) => {
      if (!(event instanceof MouseEvent)) return;
      if (event.defaultPrevented) return; // Something else already handled this click.
      const target = event.target;
      if (!(target instanceof Element)) return;
      const link = target.closest(`[${LIVE_LINK_ATTRIBUTE}]`);
      if (link === null) return;

      // Checked AFTER finding the link and BEFORE preventDefault: a modified click on a live
      // link must still behave like the plain <a href> it is (open a new tab, a new window),
      // which only happens if this handler leaves the click's default action alone.
      if (isModifiedClick(event)) return;

      const kind = liveLinkKind(link.getAttribute(LIVE_LINK_ATTRIBUTE));
      if (kind === null) return; // Unrecognised value — fall through to a real navigation.
      if (!(link instanceof HTMLAnchorElement)) return; // Nothing to fetch from.

      event.preventDefault();
      const scrollRegionId =
        kind.kind === 'page' ? (link.closest(`[${LIVE_REGION_ATTRIBUTE}]`)?.id ?? null) : null;
      void update(link.href, scrollRegionId);
    },
    { signal },
  );

  return () => {
    if (pendingSearch !== null) clearTimeoutFn(pendingSearch);
    abort.abort();
  };
}
