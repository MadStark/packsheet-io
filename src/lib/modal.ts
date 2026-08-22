/**
 * The decisions behind `src/components/Modal.astro` (PK-69) — everything the modal shell
 * does EXCEPT the three calls that only a real browser can make.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A MODULE AND NOT THE COMPONENT'S OWN <script> BLOCK
 * ---------------------------------------------------------------------------
 *
 * The same argument `src/lib/account-deletion.ts` and `src/lib/packs/drag.ts` each make for
 * their own layer. `vitest.config.ts:64` excludes `src/pages/**` because every file there is
 * a route, and nothing in this repository reaches into an `.astro` file's `<script>` block at
 * all — not a page's and not a component's. Logic typed there is logic with no test, not by
 * anybody's decision but as a side effect of where it happened to be typed.
 *
 * Every decision below is one whose wrong answer is SILENT. A focus that is never restored
 * leaves a keyboard visitor at the top of the document with no error anywhere. A scroll lock
 * that clears `overflow` instead of restoring what it found un-sets a value some other
 * stylesheet was relying on. A backdrop hit-test that reads a zero-area rect as "the pointer
 * is outside" dismisses the dialog on every click INSIDE it. None of those throw, none of
 * them log, and all three were reachable from a `<script>` block nothing can execute.
 *
 * ---------------------------------------------------------------------------
 * WHAT JSDOM CANNOT DO, AND WHAT THAT COST
 * ---------------------------------------------------------------------------
 *
 * `tests/modal.test.ts` is the first jsdom test in this codebase. It is worth knowing what
 * that bought and what it did not, because the shape of this module is a direct consequence.
 *
 * jsdom 30 ships an `HTMLDialogElement` whose entire implementation is the reflected `open`
 * attribute. There is no `showModal()`, no `close()`, no top layer, no `::backdrop`, and
 * therefore no `cancel` and no `close` event — measured, not assumed (`typeof
 * dialog.showModal === 'undefined'`, which is exactly what `supportsModalDialog` below
 * reports).
 *
 * The response is to make the platform's own lines as close to nothing as possible, and to
 * put everything they surround on either side of them where a real DOM can execute it:
 * `beginModalSession` is the whole of "the dialog just opened" minus `showModal()`, and
 * `endModalSession` is the whole of "the dialog just closed" minus the event that announced
 * it. Both run against a real element in `tests/modal.test.ts`, really locking a real body's
 * scroll and really moving a real `document.activeElement`.
 *
 * WHAT WAS DELIBERATELY NOT DONE: no `showModal` polyfill in THIS module, anywhere, for any
 * reason. A shim shipped here would make every assertion in the test file green while
 * testing the shim rather than this module — the one failure mode a first-of-its-kind test
 * environment is most likely to introduce and least likely to have caught. What the test
 * file does instead, after the PK-69 review found `initModals` entirely unverified (its body
 * could be replaced with `return []` and the suite stayed green), is install `showModal`,
 * `close` and `getBoundingClientRect` ON ONE ELEMENT IN ONE TEST — a collaborator double of
 * the same kind as the `ModalOpener` double beside it, built and thrown away by the test
 * that needs it, and never reachable from a browser. The distinction is the whole of why
 * `initModals`, the controller's success path and every regression below can now be
 * asserted while nothing here has been softened to make them assertable. What is STILL out
 * of reach is named where it is: see this file's list beside `createModalController` and the
 * matching one in the test file's header.
 *
 * ---------------------------------------------------------------------------
 * THE DEGRADATION INVERSION, WHICH IS THE POINT OF THE WHOLE FILE
 * ---------------------------------------------------------------------------
 *
 * `src/pages/gear/index.astro:710-720` records the rule and the four-way failure list behind
 * it: `<noscript>` guards SCRIPTING BEING ENABLED, not THIS SCRIPT HAVING RUN, and every way
 * those two diverge — a hashed bundle 404ing after a deploy, a CSP refusing it, an
 * extension, an exception thrown earlier in the same bundle — left a dead control on the
 * page. The house fix is to render the working thing unconditionally and delete or upgrade
 * it only on the success path.
 *
 * Applied here, that means a consumer's trigger is an ordinary `<a href="/gear/new">`. It
 * navigates to the real page when nothing below ever runs. `upgradeTrigger` turns it into a
 * modal opener, and — this is the part that is easy to get wrong — the click handler it
 * installs cancels the navigation ONLY IF the dialog actually opened. `openFrom()` returns a
 * boolean for that single reason. An `event.preventDefault()` on the optimistic assumption
 * that `showModal()` is about to work is how you turn a working link into a control that
 * does nothing at all, which is the exact defect this pattern exists to prevent, reproduced
 * one layer further in.
 *
 * IT IS ALSO WHY `upgradeTrigger` REFUSES ANYTHING BUT AN ANCHOR WITH AN `href`. A
 * `<button data-modal-open="x">` has nowhere to fall through TO: on every platform where
 * `supportsModalDialog` says no, or where the controller has been destroyed, or where
 * `showModal()` throws, it is a permanently dead control — the precise defect above, wearing
 * the costume of the fix. The invariant the whole ticket exists to protect is enforced at
 * that boundary rather than described in prose here.
 *
 * ---------------------------------------------------------------------------
 * NOT importing src/lib/auth/, and not being an island
 * ---------------------------------------------------------------------------
 *
 * This module is bundled into the browser by `Modal.astro`'s `<script>`, so two separate
 * rules apply and they are not the same rule. Invariant A in
 * `tests/anonymous-read-path.test.ts` is an EDGE rule: no module outside `src/lib/auth/` may
 * import anything under it, except the modules enumerated in `AUTH_CONSUMERS`. Invariant D1
 * is the one about the client pass: nothing named in `AUTH_CONSUMERS` may appear in the
 * Rollup pass a browser downloads. This module imports nothing at all, which settles both.
 * The component that uses it is a plain `.astro` component with no `client:*` directive, for
 * the reason `src/components/GearNav.astro`'s header gives.
 */

// ---------------------------------------------------------------------------
// The attribute vocabulary
// ---------------------------------------------------------------------------

/*
 * EXPORTED, WHICH THEY WERE NOT, AND THE PK-69 REVIEW WAS RIGHT ABOUT WHY. These six strings
 * were private constants here while `Modal.astro` retyped the same literals into its markup.
 * Rename either side and every test in the suite stays green while the feature is silently
 * dead: the component renders `data-modal` and the script looks for something else, so no
 * dialog is ever found, no trigger is ever upgraded, and the only symptom is that clicking a
 * link navigates — which is exactly what the degradation path is supposed to look like.
 * `tests/modal-component.test.ts` renders the component and asserts the markup against these
 * constants, so the join is checked rather than assumed.
 */

/** The dialog's own marker. An attribute rather than a class so no stylesheet can be made to
 *  depend on it by accident. */
export const MODAL_ATTRIBUTE = 'data-modal';
/** Set by `Modal.astro` when the server rendered the dialog already open — see `openFrom`. */
export const OPEN_ON_LOAD_ATTRIBUTE = 'data-modal-open-on-load';
/** The value of a trigger's `data-modal-open` is the `id` of the dialog it opens. */
export const TRIGGER_ATTRIBUTE = 'data-modal-open';
/** The shell's own dismiss control, which `focusFirstWithin` steps over when it chooses the
 *  initial focus — see there. */
export const DISMISS_ATTRIBUTE = 'data-modal-dismiss';
/** Marks a trigger this module has already bound, so a second `initModals` pass over the
 *  same document does not install a second click handler on it. Removed again by the unbind
 *  `upgradeTrigger` returns, so a re-run after a `destroy()` can re-upgrade the same link. */
export const TRIGGER_BOUND_ATTRIBUTE = 'data-modal-bound';
/** Marks a dialog with a live controller. OBSERVATIONAL: the decision is made against the
 *  registry below, which is the thing that can hand the existing controller back. The
 *  attribute is here so a page, a test or a person with an inspector can see the wiring. */
export const DIALOG_BOUND_ATTRIBUTE = 'data-modal-ready';

// ---------------------------------------------------------------------------
// supportsModalDialog
// ---------------------------------------------------------------------------

/**
 * The half of `HTMLDialogElement` this module actually uses, as a STRUCTURAL type.
 *
 * `HTMLDialogElement` still assigns to it — it has both methods and extends `HTMLElement` —
 * so no production call site changed when this replaced it. What it buys is that the
 * module's central duck-typing argument (below) becomes checkable rather than merely
 * argued: the predicate's return type now says exactly what the predicate tests, and a test
 * can hand `createModalController` an element carrying the two methods without an
 * `as HTMLDialogElement` cast asserting something the compiler has been told is false.
 */
export interface ModalDialog extends HTMLElement {
  showModal(): void;
  close(): void;
}

/**
 * Whether this thing can actually present a modal dialog — the gate the whole degradation
 * story hangs off.
 *
 * A DUCK-TYPE RATHER THAN `instanceof HTMLDialogElement`, and the difference is the entire
 * value of the function. The question a trigger needs answered is not "is the markup right",
 * it is "will `showModal()` work" — and those come apart in precisely the environments that
 * matter. jsdom answers `true` to the class check and has no `showModal` at all. So does
 * every browser predating dialog support that nonetheless parses `<dialog>` into an
 * `HTMLUnknownElement`-adjacent object. Asking for the two methods asks the real question.
 *
 * `close` is checked as well as `showModal` even though only `showModal` is needed to OPEN,
 * because a dialog that opens and cannot be closed is worse than one that never opened: the
 * link would have been cancelled and there would be no way back to the page.
 */
export function supportsModalDialog(node: unknown): node is ModalDialog {
  if (node === null || typeof node !== 'object') return false;
  const candidate = node as { showModal?: unknown; close?: unknown };
  return typeof candidate.showModal === 'function' && typeof candidate.close === 'function';
}

// ---------------------------------------------------------------------------
// focusableWithin
// ---------------------------------------------------------------------------

/**
 * Anything this module is willing to move focus TO: an element that has a `focus` method.
 *
 * `HTMLElement` was the type here and it was wrong in one direction that costs real
 * behaviour. `document.activeElement` can perfectly well be an `SVGElement` — an inline icon
 * with `tabindex="0"`, or an `<svg><a href>` — and an `instanceof HTMLElement` test answers
 * `null` for it. That silently lost the focus restore (the opener recorded as "nothing") AND
 * jammed the Tab trap, because `activeIndex` came back `-1` and every Tab re-entered the set
 * from the top instead of advancing. The capability is what matters, so the capability is
 * what is asked for.
 */
export type ModalFocusTarget = Element & { focus: (options?: FocusOptions) => void };

/**
 * The elements the Tab trap cycles between. Nothing here invents a definition of "focusable"
 * — it is the standard tabbable set, minus the members that are provably out of the tab
 * order from their attributes alone.
 *
 * THE EXCLUSIONS ARE ATTRIBUTE-ONLY, WHICH IS A REAL LIMIT AND IS WRITTEN DOWN RATHER THAN
 * PAPERED OVER. A complete answer needs layout — an element inside a `display: none`
 * ancestor is not tabbable and no attribute on it says so — and layout is exactly what a
 * headless DOM does not have, so a `getComputedStyle` pass here would be untested in the
 * suite and would also be the slowest thing the trap does, on every Tab. What is checked
 * instead is what actually occurs in the surfaces this shell was built for (PK-71/72/74, all
 * of them forms): `disabled`, `hidden`, `type="hidden"`, a negative `tabindex`, an `inert`
 * ancestor, and `aria-hidden`. A form field hidden with CSS rather than with one of those is
 * a gap; it would cost a Tab press landing somewhere invisible, not a lost dialog, and the
 * browser's own top-layer focus containment still holds underneath.
 *
 * THREE OF THOSE CHECKS USED TO BE ASKED OF THE ELEMENT AND NOT OF ITS ANCESTORS, which is
 * how the PK-69 review found a `<div hidden>` yielding its inputs into the tabbable set.
 * `hidden` and `aria-hidden` are inherited by rendering and by the accessibility tree
 * respectively — hiding a fieldset hides everything in it — so both are now `closest()`
 * questions, the way `inert` always was. The cost of getting it wrong was not theoretical:
 * a hidden input in the set put a phantom member at the wrap edge, and because
 * `preventDefault()` runs BEFORE the focus call, Tab did nothing at all.
 *
 * A `tabindex` THAT IS NOT AN INTEGER IS TREATED AS ABSENT, per HTML's attribute parsing
 * rules — so `<div tabindex="foo">` is out of the set (nothing else about a div is
 * focusable) while `<button tabindex="foo">` stays in it (the button is focusable on its
 * own account). Reading it as `parseInt` alone put the div in the set; reading it as
 * "invalid means excluded" took the button out.
 */
const INHERENTLY_FOCUSABLE = [
  'a[href]',
  'area[href]',
  'button',
  'input',
  'select',
  'textarea',
  'iframe',
  'audio[controls]',
  'video[controls]',
  // `[contenteditable]` alone matched `contenteditable="false"`, which is markup that exists
  // for exactly one purpose: saying this subtree is NOT editable.
  '[contenteditable]:not([contenteditable="false"])',
];
const INHERENTLY_FOCUSABLE_SELECTOR = INHERENTLY_FOCUSABLE.join(',');
const FOCUSABLE_SELECTOR = [...INHERENTLY_FOCUSABLE, '[tabindex]'].join(',');

/** HTML's "valid integer": optional sign, then digits, and nothing else. */
const VALID_INTEGER = /^[+-]?\d+$/;

export function focusableWithin(root: ParentNode): HTMLElement[] {
  const found: HTMLElement[] = [];
  for (const element of root.querySelectorAll(FOCUSABLE_SELECTOR)) {
    // A FILTER RATHER THAN THE `querySelectorAll<HTMLElement>` CAST THIS USED TO CARRY. The
    // selector reaches SVG too (`<svg><a href>` matches `a[href]`), and the cast told the
    // compiler a lie that `focusFirstWithin` then acted on by calling `.focus()`.
    if (!(element instanceof HTMLElement)) continue;
    if (element.hasAttribute('disabled')) continue;
    if (element.getAttribute('type') === 'hidden') continue;
    if (element.closest('[hidden]') !== null) continue;
    if (element.closest('[aria-hidden="true"]') !== null) continue;
    if (element.closest('[inert]') !== null) continue;
    const tabindex = element.getAttribute('tabindex');
    if (tabindex !== null) {
      const value = tabindex.trim();
      if (!VALID_INTEGER.test(value)) {
        if (!element.matches(INHERENTLY_FOCUSABLE_SELECTOR)) continue;
      } else if (Number(value) < 0) continue;
    }
    found.push(element);
  }
  return found;
}

// ---------------------------------------------------------------------------
// tabTrapTarget
// ---------------------------------------------------------------------------

/**
 * Which member of the focusable set Tab must be forced onto, or `null` to let the browser
 * move focus by itself.
 *
 * `null` IS THE COMMON ANSWER AND THAT IS DELIBERATE. A trap that calls `focus()` on every
 * Tab takes over the browser's own sequential navigation — including the parts of it this
 * function has no opinion about, like radio-group arrow semantics and a `<select>`'s
 * internal handling — and gets them subtly wrong. It only intervenes at the two edges, where
 * the browser would otherwise walk out of the dialog.
 *
 * ZERO FOCUSABLE ELEMENTS RETURNS `null` RATHER THAN TRAPPING ON THE DIALOG, which looks
 * like the weaker choice and is the honest one: there is nothing to move focus TO, and
 * cancelling the keypress would leave a visitor with a Tab key that silently does nothing.
 * The browser's own modal-dialog containment already keeps focus off the inert background in
 * that case, and it is the layer that can actually enforce it — see this file's header on
 * what jsdom could not verify.
 *
 * `activeIndex === -1` means focus is somewhere in the dialog that is not in the tabbable
 * set — the dialog element itself right after `showModal()`, most often. The next Tab should
 * enter the set from whichever end the direction implies, not be passed to the browser,
 * which would walk from the dialog into the page behind it.
 *
 * A SINGLE-CONTROL DIALOG HAS NO SPECIAL CASE, and the line that used to provide one
 * (`if (count === 1) return 0`) was deleted rather than kept for clarity: with one control
 * the two edges ARE the same index, so both branches below already answer `0`, and the
 * PK-69 review was right that a line no input can reach is a line no test can defend. The
 * behaviour it described is still asserted — from the two branches that actually produce it.
 */
export function tabTrapTarget(
  count: number,
  activeIndex: number,
  backwards: boolean,
): number | null {
  if (count <= 0) return null;
  if (activeIndex < 0) return backwards ? count - 1 : 0;
  if (!backwards && activeIndex >= count - 1) return 0;
  if (backwards && activeIndex === 0) return count - 1;
  return null;
}

// ---------------------------------------------------------------------------
// isBackdropClick
// ---------------------------------------------------------------------------

/** The four edges this module needs off a `DOMRect`, structural so a test can state one
 *  without a layout engine. (`src/lib/packs/drag.ts` was cited here as "the same factoring"
 *  and is not: it has no rect type and no geometry at all, because its caller computes the
 *  indices and hands them over. The parallel that does hold is narrower — both modules keep
 *  the DOM read at the edge and put the decision behind a plain-data signature.) */
export interface ModalRect {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

/** The three fields of a `MouseEvent` the hit-test reads. `detail` is not optional and the
 *  guard below is what it is for. */
export interface ModalPointer {
  readonly clientX: number;
  readonly clientY: number;
  readonly detail: number;
}

/**
 * Whether a pointer event that named the dialog as its target landed outside the sheet.
 *
 * THE TEST IS NEEDED BECAUSE THE EVENT TARGET LIES, in a way that is specific to `<dialog>`
 * and catches everyone once. The backdrop is a pseudo-element of the dialog, so a click
 * anywhere in the dimmed area reports `event.target === dialog` — the same value a click on
 * the dialog's own padding reports. `target` cannot separate them; only geometry can.
 *
 * THIS FUNCTION ANSWERS ABOUT ONE POINT, AND THAT IS NOT THE SAME QUESTION AS "SHOULD THE
 * DIALOG CLOSE". The docstring here used to claim the two guards below "fail closed" and
 * therefore that a false positive was impossible, and the PK-69 review reproduced the case
 * that claim missed: a `click` is dispatched at the nearest common inclusive ancestor of the
 * `mousedown` and `mouseup` targets, carrying the MOUSEUP coordinates. Drag-select inside a
 * `<textarea>` and release over the dimmed area and every input to this function says
 * backdrop — target is the dialog, `detail` is 1, the point is outside the rect — while what
 * actually happened is a text selection. Same for dragging a `range` thumb or a textarea
 * resize handle past the edge. The half-typed form vanished.
 *
 * The fix could not live here, because one point is genuinely not enough information: it
 * lives in `createModalController`, which requires BOTH endpoints to be on the backdrop by
 * recording the `mousedown` and consulting it at the `click`. What survives here are the two
 * guards that are about a single point, and they do both fail closed:
 *
 *   `detail < 1` — a click synthesised by the keyboard (Enter or Space on a button, and
 *   `element.click()`) carries `clientX`/`clientY` of 0 and a `detail` of 0. Zero is outside
 *   any dialog's rect, so without this guard activating a control with the keyboard would
 *   dismiss the dialog. This is the single most likely defect in the whole file.
 *
 *   A zero-or-negative-area rect — no layout yet, a dialog mid-open, or a document that has
 *   no layout engine at all. Every coordinate is outside a zero-area rect, so the unguarded
 *   version reads every click as a backdrop click and the dialog cannot be interacted with.
 */
export function isBackdropClick(rect: ModalRect, pointer: ModalPointer): boolean {
  if (pointer.detail < 1) return false;
  if (rect.right <= rect.left || rect.bottom <= rect.top) return false;
  return (
    pointer.clientX < rect.left ||
    pointer.clientX > rect.right ||
    pointer.clientY < rect.top ||
    pointer.clientY > rect.bottom
  );
}

// ---------------------------------------------------------------------------
// lockScroll
// ---------------------------------------------------------------------------

/** One element's lock: how many sessions are holding it, and the inline `overflow` the FIRST
 *  of them found. Module-scoped so two concurrent sessions share it — see `lockScroll`. */
interface ScrollLock {
  count: number;
  readonly previous: string;
}

/*
 * KEYED BY ELEMENT RATHER THAN A SINGLE MODULE-LEVEL COUNTER, which is one more line than
 * the review asked for and covers one more case: `lockScroll` takes the element to freeze,
 * and two documents (a test's, an iframe's) have two different bodies. A bare counter would
 * let a lock taken on one release the other. A `WeakMap` also cannot keep a detached
 * document alive.
 */
const scrollLocks = new WeakMap<HTMLElement, ScrollLock>();

/**
 * Freezes an element's scrolling and hands back the one function that undoes it.
 *
 * IT SAVES AND RESTORES, RATHER THAN SETTING AND CLEARING. Writing `style.overflow = ''` on
 * the way out is the obvious version and it is wrong whenever anything else had already put
 * an inline `overflow` on `<body>` — the lock would silently delete that declaration, and
 * the page would come back subtly different from how it went in, with nothing anywhere
 * saying why. Restoring the captured string covers both cases at once: an empty capture
 * removes the declaration exactly as it found it.
 *
 * IT COUNTS. This docstring used to anticipate a reference count and decline it ("the day it
 * stops being harmless is the day someone adds a counter to it"), and the PK-69 review
 * reproduced why that was the wrong call: two dialogs can be up at once — an "add to pack"
 * opened from inside an already-open pack editor is PK-74's own screen — and each
 * un-counted lock snapshots what the previous one WROTE. Open A, open B, close A and the
 * page scrolls behind still-open B; close B and `hidden` is restored permanently with
 * nothing on screen. A pre-existing inline value is destroyed outright in the same move. So
 * the snapshot is taken on 0 -> 1 and the restore happens on 1 -> 0, and the value that
 * comes back is the one the page had before any dialog opened.
 *
 * THE RETURNED RELEASER IS STILL IDEMPOTENT, and now it matters more than it did: the close
 * path can be reached more than once for one open — a backdrop click that calls `close()`
 * and the platform's own `close` event behind it are the ordinary example — and a second
 * decrement from one session would drop the count below the number of dialogs actually up.
 */
export function lockScroll(element: HTMLElement): () => void {
  const existing = scrollLocks.get(element);
  const lock: ScrollLock = existing ?? { count: 0, previous: element.style.overflow };
  if (existing === undefined) scrollLocks.set(element, lock);
  lock.count += 1;
  element.style.overflow = 'hidden';

  let released = false;
  return () => {
    if (released) return;
    released = true;
    lock.count -= 1;
    if (lock.count > 0) return;
    scrollLocks.delete(element);
    element.style.overflow = lock.previous;
  };
}

// ---------------------------------------------------------------------------
// focus
// ---------------------------------------------------------------------------

/**
 * Moves focus into a just-opened dialog, preferring an `autofocus` member of the tabbable
 * set and falling back to the dialog element itself.
 *
 * THIS PARTLY DUPLICATES WHAT THE PLATFORM ALREADY DOES — `showModal()` runs its own
 * focusing steps — and it is still worth doing, for a reason that is about the shell rather
 * than about the browser: the initial focus of a form modal is a product decision (PK-71's
 * "Add item" wants its name field, not its Cancel button), and a decision the UA takes is a
 * decision no consumer can state and nothing here can test. Doing it explicitly makes it
 * ours. It also runs identically for a dialog promoted out of the server-rendered
 * open-on-load fallback, which is a path the UA's steps have already been past.
 *
 * THE SHELL'S OWN DISMISS CONTROL IS STEPPED OVER, NOT EXCLUDED. `Modal.astro` renders a
 * close button in the header (PK-69 review M6: at 640px and below the sheet is full-bleed,
 * so there is no backdrop to click, and a touch keyboard has no ESC). It is the first
 * tabbable element in the dialog because the header comes first, so without this it would
 * take the initial focus from every consumer who has not said `autofocus` — and "the modal
 * opens on its Close button" is precisely the product decision this function exists to keep
 * away from an accident of DOM order. It stays IN the tabbable set: Tab reaches it
 * immediately, which is the point of putting it there.
 *
 * The `focus` capability is checked rather than assumed for the same reason `restoreFocus`
 * checks it: this can be handed anything a consumer put in the dialog.
 */
export function focusFirstWithin(dialog: HTMLElement): HTMLElement | null {
  const focusable = focusableWithin(dialog);
  const target =
    focusable.find((element) => element.hasAttribute('autofocus')) ??
    focusable.find((element) => !element.hasAttribute(DISMISS_ATTRIBUTE)) ??
    focusable[0] ??
    dialog;
  if (typeof target.focus !== 'function') return null;
  target.focus();
  return target;
}

/**
 * Returns focus to whatever opened the dialog. `true` when the opener got it.
 *
 * THE OPENER MAY BE GONE, and that is an ordinary case rather than an exotic one: the whole
 * point of an "Edit" modal is to change the row its own trigger sits in, and a save that
 * re-renders the list removes the button that started it. `isConnected` is the check that
 * matters — a detached element still HAS a `focus()` method, it simply focuses nothing, so
 * calling it does not throw and does not work either. Focus would silently stay wherever it
 * was, which after a dialog closes is `<body>`, i.e. the top of the document.
 *
 * NOTHING IS FOCUSED IN THAT CASE, deliberately. Reaching for some other plausible element —
 * the first heading, the list the row was in — would be this module guessing at a page it
 * knows nothing about. Letting the browser's own post-close behaviour stand is the honest
 * answer, and the caller that cares can pass a live `opener` of its own choosing.
 */
export function restoreFocus(opener: ModalFocusTarget | null): boolean {
  if (opener === null) return false;
  if (!opener.isConnected) return false;
  if (typeof opener.focus !== 'function') return false;
  opener.focus();
  return true;
}

// ---------------------------------------------------------------------------
// The session — the two halves of the lifecycle that are not `showModal()`
// ---------------------------------------------------------------------------

/**
 * What one open dialog is: the element it opened over, the element that opened it, and the
 * scroll lock's own undo. Held by the controller for exactly as long as the dialog is up.
 *
 * @internal — exported for tests. A consumer holds a `ModalController`; this is the shape
 * the controller keeps behind it, and it is out here only because the two functions below
 * are (see `createModalController` for what that split buys).
 */
export interface ModalSession {
  readonly dialog: HTMLElement;
  readonly opener: ModalFocusTarget | null;
  readonly releaseScroll: () => void;
}

/**
 * Everything "the dialog just opened" means, minus `showModal()`.
 *
 * The split is not stylistic. `showModal()` is the one line jsdom cannot execute (see the
 * header), so keeping the bookkeeping on this side of it is what lets a real DOM verify that
 * the scroll really locks and the focus really moves. It also fixes the ORDER, which is
 * load-bearing: the controller calls `showModal()` FIRST and this SECOND, so a `showModal()`
 * that throws leaves a page with no scroll lock and no moved focus rather than a page frozen
 * behind a dialog that never appeared.
 *
 * IT UNDOES ITS OWN LOCK IF THE FOCUS STEP THROWS, which is the second half of the same
 * argument and was missing. The scroll lock is taken before focus moves, so anything that
 * throws in between — a consumer's element with a `focus` that raises, most plausibly —
 * left the releaser inside a stack frame nobody kept and the page locked for good. The
 * function that took the lock is the only one that can still give it back, so it does, and
 * then re-throws for `openFrom` to report.
 *
 * @internal — exported for tests.
 */
export function beginModalSession(
  dialog: HTMLElement,
  opener: ModalFocusTarget | null,
): ModalSession {
  const releaseScroll = lockScroll(dialog.ownerDocument.body);
  try {
    focusFirstWithin(dialog);
  } catch (error) {
    releaseScroll();
    throw error;
  }
  return { dialog, opener, releaseScroll };
}

/**
 * Everything "the dialog just closed" means, minus the platform event that announced it.
 *
 * ONE PATH, NOT THREE. ESC (which the platform turns into `cancel` and then `close`), a
 * backdrop click, a `<form method="dialog">` submission — which is what the shell's own
 * close button is — and a programmatic `close()` all end here, because the controller
 * listens for the `close` event rather than teaching each dismissal how to tidy up after
 * itself. Three copies of "unlock the scroll and put the focus back" is three chances for
 * one of them to be forgotten, and the one that is forgotten leaves a page that cannot be
 * scrolled with nothing on screen explaining it.
 *
 * @internal — exported for tests.
 */
export function endModalSession(session: ModalSession): void {
  session.releaseScroll();
  restoreFocus(session.opener);
}

// ---------------------------------------------------------------------------
// The controller
// ---------------------------------------------------------------------------

/** The half of a controller a trigger needs, and all `upgradeTrigger` asks for. Narrow on
 *  purpose: it is what lets a test drive the trigger's own behaviour without a dialog the
 *  environment cannot open. */
export interface ModalOpener {
  /** Opens with "whatever had focus" as the opener. */
  open(): boolean;
  /** Opens with an explicitly named opener, or with `null` for "nothing opened this".
   *
   *  THE TWO METHODS ARE SEPARATE BECAUSE THE DISTINCTION IS LOAD-BEARING AND WAS ONE `??`
   *  AWAY FROM BEING LOST. This was one optional parameter, where `undefined` meant "work it
   *  out" and `null` meant "nothing"; any call site writing `open(opener ?? null)` — the
   *  most natural thing in the world to type — silently converted the first into the second
   *  and put a focus restore in front of a dialog that had nothing to restore to.
   *
   *  Both return `true` when the dialog is now up. `false` means nothing happened and the
   *  caller must not cancel whatever it was going to do instead — see the header. */
  openFrom(opener: ModalFocusTarget | null): boolean;
  /** Fires when the controller behind this opener is destroyed, so a trigger bound to it can
   *  unbind itself. Optional because a test double is a legitimate `ModalOpener` and has no
   *  lifecycle to signal; `ModalController` below narrows it to required. */
  readonly destroySignal?: AbortSignal;
}

export interface ModalController extends ModalOpener {
  /** Whether a session is currently in progress. Reads the controller's own bookkeeping
   *  rather than the element's `open` attribute, which is also set by the server-rendered
   *  open-on-load fallback the controller has not adopted yet — and reconciles it against
   *  the dialog still being in the document, which is the only way a session can end
   *  without the platform saying so. */
  readonly isOpen: boolean;
  readonly destroySignal: AbortSignal;
  close(): void;
  /** Closes the dialog, then detaches every listener this controller installed — including
   *  the click handlers on the triggers upgraded against it. The dialog is left in the DOM,
   *  so a destroyed controller cannot leave the page scroll-locked or a link dead. */
  destroy(): void;
}

/*
 * THE ONE CONTROLLER PER DIALOG REGISTRY, and the reason a second `initModals` pass is now
 * additive rather than inert.
 *
 * It is maintained HERE rather than in `initModals` for one reason: `destroy()` is the only
 * code that knows a controller has stopped being usable, and an entry that outlived its
 * controller would make a re-init hand out a dead one. Registering and retiring in the same
 * place is what keeps "in the map" and "alive" the same statement.
 */
const wiredModals = new WeakMap<Element, ModalController>();

function ownerActiveElement(dialog: HTMLElement): ModalFocusTarget | null {
  const active = dialog.ownerDocument.activeElement;
  if (active === null) return null;
  return typeof (active as Partial<ModalFocusTarget>).focus === 'function'
    ? (active as ModalFocusTarget)
    : null;
}

/**
 * Wires one `<dialog>` up: open, close, ESC, the Tab trap, the backdrop hit-test and the
 * scroll lock, all converging on the single close path `endModalSession` describes.
 *
 * IT DOES NOT PROBE FOR SUPPORT. `initModals` does that once, with `supportsModalDialog`,
 * before it gets here — and `openFrom()` still guards `showModal()` with a `try`, because
 * the two failures are different. The probe answers "does this platform have modal dialogs";
 * the `try` catches the calls that are legal on a platform that does and still throw:
 * `showModal()` on a dialog that is already open, and on one that is not in a document. A
 * controller for a dialog a page later detaches is the ordinary way to reach the second.
 *
 * WHAT IS STILL VERIFIED IN A BROWSER AND NOT HERE, now that a test can install a platform
 * double on one element (see the header): that `showModal()` puts the dialog in the TOP
 * LAYER; that ESC produces `cancel` and then `close`; that the platform's own focus
 * containment holds; that `::backdrop` paints; and that a click on the dimmed area reports
 * the dialog as its target, which is the premise `isBackdropClick` exists to work around.
 * Everything on either side of those is asserted in `tests/modal.test.ts`.
 */
export function createModalController(dialog: ModalDialog): ModalController {
  let session: ModalSession | null = null;
  let destroyed = false;

  /*
   * C1: WHETHER THE PRESS THAT PRECEDED THIS CLICK STARTED ON THE BACKDROP. A `click` is
   * dispatched at the nearest common inclusive ancestor of the `mousedown` and `mouseup`
   * targets and carries the MOUSEUP coordinates, so a drag-select that begins in a
   * `<textarea>` and ends over the dimmed area arrives here as: target the dialog, `detail`
   * 1, coordinates outside the sheet. `isBackdropClick` cannot tell that from a dismissal
   * and neither can any other single-point test; requiring both ENDPOINTS can.
   *
   * `mousedown` RATHER THAN `pointerdown`, deliberately. `pointerdown` carries `detail: 0`
   * in Chromium, which `isBackdropClick`'s keyboard guard reads as "synthesised" and
   * refuses — so a pointerdown-based flag would never be set and the backdrop would stop
   * dismissing at all. `mousedown` carries the click count, is fired for touch after the
   * synthesised sequence, and is absent entirely for a keyboard-activated click, which is
   * one more way this fails closed.
   */
  let pressStartedOnBackdrop = false;

  const endSession = () => {
    if (session === null) return;
    const ending = session;
    session = null;
    endModalSession(ending);
  };

  /*
   * C2a: THE SESSION HAS TO BE RECONCILED WITH REALITY BEFORE IT IS TRUSTED.
   *
   * `session` was cleared by exactly two things: the platform's `close` event, and an
   * explicit `close()`/`destroy()`. HTML's removing steps say a dialog removed from the
   * document while open leaves the top layer and fires NOTHING — no `cancel`, no `close` —
   * which a hydrated island re-rendering its container reaches without doing anything
   * unusual. The session then survived forever: `openFrom()` saw it and returned `true`, so
   * the trigger cancelled its own navigation and nothing appeared, on a page that could no
   * longer scroll, with no way back.
   *
   * `isConnected` is the cheap, honest question, asked at every point that is about to trust
   * a non-null session.
   */
  const currentSession = (): ModalSession | null => {
    if (session === null) return null;
    if (session.dialog.isConnected) return session;
    endSession();
    return null;
  };

  /*
   * The platform's own announcement that the dialog is down, whoever put it down. This is
   * the ONLY place `endSession` is reached from in the normal course of things: `close()`
   * below calls `dialog.close()` and lets this listener do the work, so a dismissal the
   * shell never sees — ESC, or the header's own `<form method="dialog">` close button, or a
   * submit button in a consumer's markup — tidies up on exactly the same path as one it did.
   */
  const onClose = () => endSession();

  const onKeydown = (event: KeyboardEvent) => {
    if (currentSession() === null) return;
    if (event.key !== 'Tab') return;
    const focusable = focusableWithin(dialog);
    const active = ownerActiveElement(dialog);
    const target = tabTrapTarget(
      focusable.length,
      active === null ? -1 : focusable.findIndex((element) => element === active),
      event.shiftKey,
    );
    if (target === null) return;
    event.preventDefault();
    // Indexed directly rather than with `?.`: `tabTrapTarget` only ever answers an index
    // inside the set it was given the size of, so an `undefined` here is a bug in one of
    // these two functions, and swallowing it would show up as a Tab key that is cancelled
    // and then does nothing — the hardest possible symptom to trace back to this line.
    focusable[target].focus();
  };

  /*
   * ESCAPE IS NOT HANDLED HERE, AND ITS ABSENCE IS THE DECISION. `<dialog>` already turns
   * ESC into `cancel` and then `close`, which reaches `onClose` above. Adding a keydown
   * branch for it would put a second implementation of "ESC dismisses this" beside the
   * platform's, running in the same tick, and the two would have to agree forever about a
   * `cancel` that a consumer is entitled to `preventDefault()`. See tests/modal.test.ts for
   * how far that path is verified without a browser.
   */

  const onMousedown = (event: MouseEvent) => {
    pressStartedOnBackdrop =
      currentSession() !== null &&
      event.target === dialog &&
      isBackdropClick(dialog.getBoundingClientRect(), event);
  };

  const onClick = (event: MouseEvent) => {
    // Cleared on EVERY click, first thing: a flag left set by one press must not be able to
    // dismiss on the next click, which is how a "both endpoints" check quietly decays back
    // into a one-endpoint one.
    const pressWasOnBackdrop = pressStartedOnBackdrop;
    pressStartedOnBackdrop = false;
    if (!pressWasOnBackdrop) return;
    if (currentSession() === null) return;
    if (event.target !== dialog) return;
    if (isBackdropClick(dialog.getBoundingClientRect(), event)) close();
  };

  /**
   * Opens the dialog. `true` when it is now up — and only then.
   *
   * THE FALLBACK'S OWN ATTRIBUTE HAS TO GO FIRST, AND HAS TO COME BACK IF THIS FAILS.
   *
   * `Modal.astro` renders `<dialog open>` for open-on-load so that a direct URL visit
   * shows the form with this script never running, and `showModal()` on a dialog that
   * already carries `open` throws `InvalidStateError`. So the attribute has to go — by
   * `removeAttribute` rather than `close()`, because removing it closes a non-modal dialog
   * WITHOUT firing `close`, where `dialog.close()` would fire the event, reach `onClose`,
   * and end a session that has not begun.
   *
   * Restoring it on failure is the half that is easy to leave out and is the whole point.
   * Without it, a `showModal()` that throws has just DELETED the no-JS fallback: the
   * visitor asked for a URL that renders a form, the script ran far enough to take the
   * form off the page and not far enough to put a dialog up, and the result is a blank
   * surface. That is the degradation inversion failing in the one direction that is worse
   * than not enhancing at all.
   *
   * H1: THE SESSION IS INSIDE A `try` AS WELL, and the two are separate on purpose. Only
   * `showModal()` used to be guarded, while `beginModalSession` ran outside — so anything it
   * threw (a `focus` that raises, a document with no `body`) left the dialog PRESENTED, the
   * scroll possibly locked, `isOpen` reporting `false`, `close()` a no-op because there was
   * no session to close, and the visitor looking at a modal nothing on the page could
   * dismiss. The recovery is to put the dialog back down and hand the caller its `false`, so
   * the trigger's own `href` runs and the visitor lands on a working page.
   */
  function openFrom(opener: ModalFocusTarget | null): boolean {
    // A destroyed controller opens NOTHING and says so, so the trigger falls through to its
    // href. `destroy()` used to leave `upgradeTrigger`'s click handler installed with no
    // removal path, and its captured `openFrom` still worked: the link stayed cancelled, the
    // dialog reopened, ESC fired `close` to a listener that had been removed, and the
    // session could never end again. Both halves of that are fixed — the listener is
    // removed now (see `destroy`) — and this is the belt.
    if (destroyed) return false;
    if (currentSession() !== null) return true;
    pressStartedOnBackdrop = false;

    const wasRenderedOpen = dialog.hasAttribute('open');
    dialog.removeAttribute('open');

    try {
      dialog.showModal();
    } catch (error) {
      if (wasRenderedOpen) dialog.setAttribute('open', '');
      // The repository has no logging facility and this is the only line of one in it. It
      // earns the exception because the failure it reports is otherwise entirely silent —
      // the visitor sees a link that navigated, which is also what success at every other
      // layer looks like — and the difference between a ten-minute diagnosis and a
      // three-day one is knowing that `showModal()` was called and threw.
      console.warn(
        `[modal] showModal() failed for #${dialog.id}; falling back to the link.`,
        error,
      );
      return false;
    }

    try {
      session = beginModalSession(dialog, opener);
    } catch (error) {
      console.warn(
        `[modal] #${dialog.id} was presented but its session could not begin; closing it.`,
        error,
      );
      try {
        dialog.close();
      } catch {
        // Nothing further to try: the dialog is up and this controller cannot put it down.
        // The warning above is the whole of what can be reported.
      }
      if (wasRenderedOpen) dialog.setAttribute('open', '');
      return false;
    }

    return true;
  }

  function close(): void {
    if (currentSession() === null) return;
    dialog.close();
    // Belt on top of the platform's braces. `dialog.close()` fires `close` synchronously and
    // `onClose` ends the session, so this is normally a no-op. It is here because the one
    // thing worse than a dialog that will not close is a page left scroll-locked underneath
    // a dialog that did.
    endSession();
  }

  const destruction = new AbortController();

  dialog.addEventListener('close', onClose);
  dialog.addEventListener('keydown', onKeydown);
  dialog.addEventListener('mousedown', onMousedown);
  dialog.addEventListener('click', onClick);
  dialog.setAttribute(DIALOG_BOUND_ATTRIBUTE, '');

  const controller: ModalController = {
    get isOpen() {
      return currentSession() !== null;
    },
    destroySignal: destruction.signal,
    open() {
      return openFrom(ownerActiveElement(dialog));
    },
    openFrom,
    close,
    destroy() {
      if (destroyed) return;
      destroyed = true;

      // M1: DOWN FIRST, THEN UNBIND. This used to unbind and then `endSession()`, which
      // restores focus — so a destroy with a live session moved focus to the opener while
      // the dialog was still in the top layer, i.e. onto a control the visitor could not
      // see and the browser would not let them interact with.
      close();
      // A dialog detached while open never fired `close`, so `close()` above found nothing
      // to do. This is what releases that session's scroll lock.
      endSession();

      dialog.removeEventListener('close', onClose);
      dialog.removeEventListener('keydown', onKeydown);
      dialog.removeEventListener('mousedown', onMousedown);
      dialog.removeEventListener('click', onClick);
      dialog.removeAttribute(DIALOG_BOUND_ATTRIBUTE);
      wiredModals.delete(dialog);
      // Every trigger upgraded against this controller unbinds itself off this signal.
      destruction.abort();
    },
  };

  wiredModals.set(dialog, controller);
  return controller;
}

// ---------------------------------------------------------------------------
// upgradeTrigger
// ---------------------------------------------------------------------------

/**
 * Turns an ordinary link into a modal opener — and only ever after the controller that will
 * serve it exists, which the signature makes unavoidable rather than merely advised.
 * Returns the function that puts the link back exactly as it was, or `null` when nothing
 * was upgraded.
 *
 * IT REFUSES ANYTHING THAT IS NOT AN ANCHOR WITH A NON-EMPTY `href`, and that refusal is the
 * ticket's central invariant rather than a validation nicety. The whole degradation contract
 * is "the navigation is cancelled only once the dialog is genuinely up"; a control with
 * nowhere to navigate has no un-cancelled state to fall back to, so a
 * `<button data-modal-open="add-item">` is a permanently dead control on every platform
 * `supportsModalDialog` refuses, after a `destroy()`, and any time `showModal()` throws. The
 * prose above and in `src/pages/gear/index.astro:710-720` said so; this is the boundary that
 * enforces it. The parameter is typed `Element` because the caller's own `querySelectorAll`
 * cannot know better — the narrowing to `HTMLAnchorElement` happens here, once, where the
 * refusal can be reported.
 *
 * THE TRIGGER IS A REAL LINK BEFORE THIS RUNS AND STAYS ONE AFTER IT. Nothing here changes
 * the `href`, and the click handler cancels the navigation ONLY when `openFrom()` reports
 * that the dialog is actually up. Every other outcome falls through to the browser and the
 * visitor lands on the page the link named.
 *
 * MODIFIED CLICKS ARE LEFT ALONE. Cmd/Ctrl-click, Shift-click, middle-click and a click on a
 * link with a `target` are the browser's "open this somewhere else" gestures, and a modal
 * cannot honour any of them. Swallowing them would break open-in-new-tab on a control that
 * still looks exactly like a link — which it is.
 *
 * `aria-haspopup="dialog"` IS SET HERE RATHER THAN IN THE MARKUP, on the same principle: it
 * is a promise to a screen-reader user that activating this opens a dialog, and until this
 * function has run that promise is not true. The unbind takes it off again, because the
 * promise stops being true when the controller behind it is destroyed.
 */
export function upgradeTrigger(trigger: Element, opener: ModalOpener): (() => void) | null {
  if (trigger.hasAttribute(TRIGGER_BOUND_ATTRIBUTE)) return null;

  if (!(trigger instanceof HTMLAnchorElement) || (trigger.getAttribute('href') ?? '') === '') {
    console.warn(
      `[modal] ${TRIGGER_ATTRIBUTE} is only supported on an <a href="…">, because a control ` +
        `with nowhere to navigate is a dead control wherever the dialog cannot open. ` +
        `Ignoring <${trigger.tagName.toLowerCase()}>.`,
      trigger,
    );
    return null;
  }

  // A controller that has already been destroyed must not acquire new triggers: it opens
  // nothing, and a link left un-upgraded is a link that works.
  if (opener.destroySignal?.aborted === true) return null;

  const bound = new AbortController();

  const unbind = () => {
    bound.abort();
    trigger.removeAttribute(TRIGGER_BOUND_ATTRIBUTE);
    trigger.removeAttribute('aria-haspopup');
  };

  trigger.setAttribute(TRIGGER_BOUND_ATTRIBUTE, '');
  trigger.setAttribute('aria-haspopup', 'dialog');

  trigger.addEventListener(
    'click',
    (event) => {
      if (event.defaultPrevented) return;
      if (event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (trigger.getAttribute('target') !== null) return;
      if (opener.openFrom(trigger)) event.preventDefault();
    },
    { signal: bound.signal },
  );

  opener.destroySignal?.addEventListener('abort', unbind, { once: true });

  return unbind;
}

// ---------------------------------------------------------------------------
// pairModalTriggers / initModals
// ---------------------------------------------------------------------------

/**
 * Joins every trigger in a root to the modal it names, and returns how many were upgraded.
 *
 * A TRIGGER WHOSE `data-modal-open` NAMES NOTHING IS LEFT COMPLETELY ALONE — no listener, no
 * `aria-haspopup`, no attribute of any kind — and that is the case this function exists to
 * get right rather than an edge of it. The name can miss for four ordinary reasons: a typo
 * in an `id`, a dialog rendered only for signed-in visitors while its trigger renders for
 * everyone, a dialog whose platform `supportsModalDialog` refused, and a dialog `initModals`
 * refused to register because its `id` was empty or already taken. All four end with a
 * trigger that has no modal behind it, and in all four the right outcome is the link the
 * markup already is. Upgrading it "so the attribute is consistent" would produce a control
 * that announces a dialog to a screen reader and then navigates instead.
 *
 * The map is keyed by `id` because that is what the markup joins on, and it is
 * `ReadonlyMap<string, ModalOpener>` rather than of controllers because opening is the only
 * thing a trigger ever does — which is also what lets the join be tested without a dialog
 * this environment cannot open.
 */
export function pairModalTriggers(
  root: ParentNode,
  openers: ReadonlyMap<string, ModalOpener>,
): number {
  let upgraded = 0;
  for (const trigger of root.querySelectorAll(`[${TRIGGER_ATTRIBUTE}]`)) {
    const opener = openers.get(trigger.getAttribute(TRIGGER_ATTRIBUTE) ?? '');
    if (opener === undefined) continue;
    if (upgradeTrigger(trigger, opener) !== null) upgraded += 1;
  }
  return upgraded;
}

/**
 * Wires every modal in a root and returns the controllers, keyed by dialog `id`. This is the
 * whole of `Modal.astro`'s `<script>`, which is why that block is one import and one call: a
 * `<script>` block is unreachable from the suite, so anything typed there is untested by
 * construction.
 *
 * A MAP RATHER THAN AN ARRAY, and that is the only supported way for a consumer to get hold
 * of a controller. This built the map and then threw the keys away by returning
 * `[...controllers.values()]`, which left PK-71/72/74 with no way to close their own dialog
 * after a save except `document.querySelector('dialog').close()` — the platform call the
 * shell exists to keep the bookkeeping around. `ModalController` deliberately no longer
 * exposes its `dialog` either: it was the one export that let a consumer reach past every
 * invariant in this file.
 *
 * CALLING IT AGAIN IS THE SUPPORTED WAY TO GET ONE. A second pass used to be entirely inert
 * — every dialog carried `data-modal-ready` and was skipped, so the call returned `[]` and a
 * trigger rendered later by a hydrated island was never upgraded, with the obvious remedy
 * (call `initModals` again) silently doing nothing. It is additive now: a dialog already
 * wired hands back the SAME controller instance, and any trigger not yet bound is upgraded
 * against it. So `initModals(document).get('add-item')` is a complete answer both to "wire
 * the page up" and to "give me the controller for that dialog".
 *
 * THE ORDER OF THE THREE PASSES MATTERS.
 *
 *   1. Controllers first, so a trigger can never be upgraded against a controller that does
 *      not exist yet.
 *   2. Triggers second, and across the whole root in one sweep rather than per dialog — a
 *      per-dialog `querySelectorAll` would have to build a selector out of an author-supplied
 *      `id`, which is a `CSS.escape` waiting to be forgotten.
 *   3. Open-on-load LAST, after the triggers are live. A dialog that opens during this call
 *      immediately moves focus; doing that before the rest of the page is wired would mean a
 *      visitor tabbing into controls that are not yet controls.
 *
 * A DIALOG THE PLATFORM CANNOT OPEN IS SKIPPED ENTIRELY — no controller, and therefore no
 * trigger upgrade for it, so its triggers stay ordinary links. That is the same fact
 * `supportsModalDialog` reports, carried all the way to the visitor. It is also the one
 * whole-pipeline behaviour `tests/modal.test.ts` can verify with no double of any kind,
 * because jsdom is genuinely such a platform.
 *
 * SO IS A DIALOG WITH NO USABLE `id`, and loudly. An `id=""` dialog joins nothing, so no
 * trigger can ever reach it — and if it also carried `data-modal-open-on-load` the old code
 * opened it anyway, producing a modal over a scroll-locked page with no handle in the map to
 * close it. A duplicate `id` is the same story from the other end: `Map.set` quietly
 * replaced the first controller with the second, and every trigger naming that id then
 * opened the wrong dialog while the first was left wired to nothing. The second registration
 * is refused instead, and refused BEFORE the dialog is wired, so its own triggers stay links.
 */
export function initModals(root: ParentNode): ReadonlyMap<string, ModalController> {
  const controllers = new Map<string, ModalController>();
  const openOnLoad: ModalController[] = [];

  for (const element of root.querySelectorAll(`dialog[${MODAL_ATTRIBUTE}]`)) {
    const existing = wiredModals.get(element);
    if (existing !== undefined) {
      // Already wired by an earlier pass. Hand the same controller back — never a second one
      // over the same element, which would mean two sessions, two scroll locks and two Tab
      // traps on one dialog — and do not re-run its open-on-load: that happened when it was
      // wired, and repeating it would re-open a dialog the visitor has since closed.
      if (element.id !== '' && !controllers.has(element.id)) controllers.set(element.id, existing);
      continue;
    }

    if (!supportsModalDialog(element)) continue;

    if (element.id === '') {
      console.warn(
        `[modal] a ${MODAL_ATTRIBUTE} dialog has no id, so no trigger can name it and nothing ` +
          `can hold its controller. Skipping it.`,
        element,
      );
      continue;
    }

    if (controllers.has(element.id)) {
      console.warn(
        `[modal] two ${MODAL_ATTRIBUTE} dialogs share the id "${element.id}". Only the first ` +
          `is wired; the second is left alone and its triggers stay ordinary links.`,
        element,
      );
      continue;
    }

    const controller = createModalController(element);
    controllers.set(element.id, controller);
    if (element.hasAttribute(OPEN_ON_LOAD_ATTRIBUTE)) openOnLoad.push(controller);
  }

  pairModalTriggers(root, controllers);

  // `openFrom(null)`, not `open()`: nothing clicked this one, so there is nothing to restore
  // focus to when it closes. See `ModalOpener`.
  for (const controller of openOnLoad) controller.openFrom(null);

  return controllers;
}
