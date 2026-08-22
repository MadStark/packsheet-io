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
 * reports). So the three lines that drive the platform — `showModal()`, `close()`, and the
 * `close` listener that the platform fires — are NOT unit-tested and cannot be. They are
 * verified in a browser.
 *
 * The response is to make those three lines as close to nothing as possible, and to put
 * everything they surround on either side of them where a real DOM can execute it:
 * `beginModalSession` is the whole of "the dialog just opened" minus `showModal()`, and
 * `endModalSession` is the whole of "the dialog just closed" minus the event that announced
 * it. Both run against a real element in `tests/modal.test.ts`, really locking a real body's
 * scroll and really moving a real `document.activeElement`.
 *
 * WHAT WAS DELIBERATELY NOT DONE: no `showModal` polyfill, anywhere, for any reason. A shim
 * would have made every assertion in the test file green while testing the shim rather than
 * this module — the one failure mode a first-of-its-kind test environment is most likely to
 * introduce and least likely to have caught.
 *
 * ---------------------------------------------------------------------------
 * THE DEGRADATION INVERSION, WHICH IS THE POINT OF THE WHOLE FILE
 * ---------------------------------------------------------------------------
 *
 * `src/pages/gear/index.astro:624` records the rule and the failure behind it: `<noscript>`
 * guards SCRIPTING BEING ENABLED, not THIS SCRIPT HAVING RUN, and every way those two
 * diverge — a hashed bundle 404ing after a deploy, a CSP refusing it, an extension, an
 * exception thrown earlier in the same bundle — left a dead control on the page. The house
 * fix is to render the working thing unconditionally and delete or upgrade it only on the
 * success path.
 *
 * Applied here, that means a consumer's trigger is an ordinary `<a href="/gear/new">`. It
 * navigates to the real page when nothing below ever runs. `upgradeTrigger` turns it into a
 * modal opener, and — this is the part that is easy to get wrong — the click handler it
 * installs cancels the navigation ONLY IF the dialog actually opened. `open()` returns a
 * boolean for that single reason. An `event.preventDefault()` on the optimistic assumption
 * that `showModal()` is about to work is how you turn a working link into a control that
 * does nothing at all, which is the exact defect this pattern exists to prevent, reproduced
 * one layer further in.
 *
 * ---------------------------------------------------------------------------
 * NOT importing src/lib/auth/, and not being an island
 * ---------------------------------------------------------------------------
 *
 * This module is bundled into the browser by `Modal.astro`'s `<script>`, so Invariant A in
 * `tests/anonymous-read-path.test.ts` applies: nothing outside `src/lib/auth/` may import
 * into it, and nothing on `AUTH_CONSUMERS` may reach the client pass. It imports nothing at
 * all, which settles that. The component that uses it is a plain `.astro` component with no
 * `client:*` directive, for the reason `src/components/GearNav.astro`'s header gives.
 */

// ---------------------------------------------------------------------------
// supportsModalDialog
// ---------------------------------------------------------------------------

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
export function supportsModalDialog(node: unknown): node is HTMLDialogElement {
  if (node === null || typeof node !== 'object') return false;
  const candidate = node as { showModal?: unknown; close?: unknown };
  return typeof candidate.showModal === 'function' && typeof candidate.close === 'function';
}

// ---------------------------------------------------------------------------
// focusableWithin
// ---------------------------------------------------------------------------

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
 */
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button',
  'input',
  'select',
  'textarea',
  'iframe',
  'audio[controls]',
  'video[controls]',
  '[contenteditable]',
  '[tabindex]',
].join(',');

export function focusableWithin(root: ParentNode): HTMLElement[] {
  const found: HTMLElement[] = [];
  for (const element of root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)) {
    if (element.hasAttribute('disabled')) continue;
    if (element.hasAttribute('hidden')) continue;
    if (element.getAttribute('type') === 'hidden') continue;
    if (element.getAttribute('aria-hidden') === 'true') continue;
    const tabindex = element.getAttribute('tabindex');
    if (tabindex !== null && Number.parseInt(tabindex, 10) < 0) continue;
    if (element.closest('[inert]') !== null) continue;
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
 */
export function tabTrapTarget(
  count: number,
  activeIndex: number,
  backwards: boolean,
): number | null {
  if (count <= 0) return null;
  if (activeIndex < 0) return backwards ? count - 1 : 0;
  if (count === 1) return 0;
  if (!backwards && activeIndex >= count - 1) return 0;
  if (backwards && activeIndex === 0) return count - 1;
  return null;
}

// ---------------------------------------------------------------------------
// isBackdropClick
// ---------------------------------------------------------------------------

/** The four edges this module needs off a `DOMRect`, structural so a test can state one
 *  without a layout engine — the same factoring `src/lib/packs/drag.ts` uses to keep
 *  `getBoundingClientRect` out of the decisions it makes. */
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
 * Whether a click that named the dialog as its target actually landed on the backdrop.
 *
 * THE TEST IS NEEDED BECAUSE THE EVENT TARGET LIES, in a way that is specific to `<dialog>`
 * and catches everyone once. The backdrop is a pseudo-element of the dialog, so a click
 * anywhere in the dimmed area reports `event.target === dialog` — the same value a click on
 * the dialog's own padding reports. `target` cannot separate them; only geometry can.
 *
 * TWO GUARDS, BOTH OF WHICH FAIL CLOSED — that is, both answer "not a backdrop click" when
 * they cannot tell, because the cost of a false positive is a visitor's half-typed form
 * vanishing and the cost of a false negative is one click that does nothing.
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
 * THE RESTORE IS IDEMPOTENT because the close path can be reached more than once for one
 * open — a backdrop click that calls `close()` and the platform's own `close` event that
 * follows it are the ordinary example. Running the restore twice would be harmless today
 * and is guarded anyway, because the day it stops being harmless is the day someone adds a
 * counter to it.
 */
export function lockScroll(element: HTMLElement): () => void {
  const previous = element.style.overflow;
  element.style.overflow = 'hidden';
  let released = false;
  return () => {
    if (released) return;
    released = true;
    element.style.overflow = previous;
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
 */
export function focusFirstWithin(dialog: HTMLElement): HTMLElement | null {
  const focusable = focusableWithin(dialog);
  const preferred = focusable.find((element) => element.hasAttribute('autofocus'));
  const target = preferred ?? focusable[0] ?? dialog;
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
export function restoreFocus(opener: HTMLElement | null): boolean {
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
 */
export interface ModalSession {
  readonly dialog: HTMLElement;
  readonly opener: HTMLElement | null;
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
 */
export function beginModalSession(dialog: HTMLElement, opener: HTMLElement | null): ModalSession {
  const releaseScroll = lockScroll(dialog.ownerDocument.body);
  focusFirstWithin(dialog);
  return { dialog, opener, releaseScroll };
}

/**
 * Everything "the dialog just closed" means, minus the platform event that announced it.
 *
 * ONE PATH, NOT THREE. ESC (which the platform turns into `cancel` and then `close`), a
 * backdrop click, a `<form method="dialog">` submission and a programmatic `close()` all end
 * here, because the controller listens for the `close` event rather than teaching each
 * dismissal how to tidy up after itself. Three copies of "unlock the scroll and put the
 * focus back" is three chances for one of them to be forgotten, and the one that is
 * forgotten leaves a page that cannot be scrolled with nothing on screen explaining it.
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
  /** `true` when the dialog is now up. `false` means nothing happened and the caller must
   *  not cancel whatever it was going to do instead — see the header. */
  open(opener?: HTMLElement | null): boolean;
}

export interface ModalController extends ModalOpener {
  readonly dialog: HTMLDialogElement;
  /** Whether a session is currently in progress. Reads the controller's own bookkeeping
   *  rather than the element's `open` attribute, which is also set by the server-rendered
   *  open-on-load fallback the controller has not adopted yet. */
  readonly isOpen: boolean;
  close(): void;
  /** Detaches every listener. The dialog is left in the DOM and any open session is ended,
   *  so a destroyed controller cannot leave the page scroll-locked. */
  destroy(): void;
}

function ownerActiveElement(dialog: HTMLElement): HTMLElement | null {
  const active = dialog.ownerDocument.activeElement;
  return active instanceof HTMLElement ? active : null;
}

/**
 * Wires one `<dialog>` up: open, close, ESC, the Tab trap, the backdrop hit-test and the
 * scroll lock, all converging on the single close path `endModalSession` describes.
 *
 * IT DOES NOT PROBE FOR SUPPORT. `initModals` does that once, with `supportsModalDialog`,
 * before it gets here — and `open()` still guards `showModal()` with a `try`, because the
 * two failures are different. The probe answers "does this platform have modal dialogs";
 * the `try` catches the calls that are legal on a platform that does and still throw:
 * `showModal()` on a dialog that is already open, and on one that is not in a document. A
 * controller for a dialog a page later detaches is the ordinary way to reach the second.
 */
export function createModalController(dialog: HTMLDialogElement): ModalController {
  let session: ModalSession | null = null;

  const endSession = () => {
    if (session === null) return;
    const ending = session;
    session = null;
    endModalSession(ending);
  };

  /*
   * The platform's own announcement that the dialog is down, whoever put it down. This is
   * the ONLY place `endSession` is reached from in the normal course of things: `close()`
   * below calls `dialog.close()` and lets this listener do the work, so a dismissal the
   * shell never sees — ESC, or a `<form method="dialog">` submit button in a consumer's
   * markup — tidies up on exactly the same path as one it did.
   */
  const onClose = () => endSession();

  const onKeydown = (event: KeyboardEvent) => {
    if (session === null) return;
    if (event.key !== 'Tab') return;
    const focusable = focusableWithin(dialog);
    const active = ownerActiveElement(dialog);
    const target = tabTrapTarget(
      focusable.length,
      active === null ? -1 : focusable.indexOf(active),
      event.shiftKey,
    );
    if (target === null) return;
    event.preventDefault();
    focusable[target]?.focus();
  };

  /*
   * ESCAPE IS NOT HANDLED HERE, AND ITS ABSENCE IS THE DECISION. `<dialog>` already turns
   * ESC into `cancel` and then `close`, which reaches `onClose` above. Adding a keydown
   * branch for it would put a second implementation of "ESC dismisses this" beside the
   * platform's, running in the same tick, and the two would have to agree forever about a
   * `cancel` that a consumer is entitled to `preventDefault()`. See tests/modal.test.ts for
   * how far that path is verified without a browser.
   */

  const onClick = (event: MouseEvent) => {
    if (session === null) return;
    if (event.target !== dialog) return;
    if (isBackdropClick(dialog.getBoundingClientRect(), event)) close();
  };

  function open(opener?: HTMLElement | null): boolean {
    if (session !== null) return true;

    /*
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
     */
    const wasRenderedOpen = dialog.hasAttribute('open');
    dialog.removeAttribute('open');

    try {
      dialog.showModal();
    } catch {
      if (wasRenderedOpen) dialog.setAttribute('open', '');
      return false;
    }

    /*
     * `undefined` AND `null` MEAN DIFFERENT THINGS HERE, which is why this is not `??`.
     * Omitting the argument means "work out what opened this" and the honest answer is
     * whatever had focus. Passing `null` means "nothing opened this" — which is exactly what
     * `initModals` says for a dialog opened on load by a URL visit, and coalescing it to
     * `document.activeElement` would silently make `<body>` the opener and put a focus
     * restore in front of a dialog that has nothing to restore to.
     */
    session = beginModalSession(dialog, opener === undefined ? ownerActiveElement(dialog) : opener);
    return true;
  }

  function close(): void {
    if (session === null) return;
    dialog.close();
    // Belt on top of the platform's braces. `dialog.close()` fires `close` synchronously and
    // `onClose` ends the session, so this is normally a no-op. It is here because the one
    // thing worse than a dialog that will not close is a page left scroll-locked underneath
    // a dialog that did.
    endSession();
  }

  dialog.addEventListener('close', onClose);
  dialog.addEventListener('keydown', onKeydown);
  dialog.addEventListener('click', onClick);

  return {
    dialog,
    get isOpen() {
      return session !== null;
    },
    open,
    close,
    destroy() {
      dialog.removeEventListener('close', onClose);
      dialog.removeEventListener('keydown', onKeydown);
      dialog.removeEventListener('click', onClick);
      endSession();
    },
  };
}

// ---------------------------------------------------------------------------
// upgradeTrigger
// ---------------------------------------------------------------------------

/** Marks a trigger this module has already bound, so a second `initModals` pass over the
 *  same document does not install a second click handler on it. */
const TRIGGER_BOUND_ATTRIBUTE = 'data-modal-bound';

/**
 * Turns an ordinary link into a modal opener — and only ever after the controller that will
 * serve it exists, which the signature makes unavoidable rather than merely advised.
 *
 * THE TRIGGER IS A REAL LINK BEFORE THIS RUNS AND STAYS ONE AFTER IT. Nothing here changes
 * the `href`, and the click handler cancels the navigation ONLY when `open()` reports that
 * the dialog is actually up. Every other outcome falls through to the browser and the
 * visitor lands on the page the link named. That is the whole of the degradation contract,
 * and it is three lines rather than a `<noscript>` for the reason
 * `src/pages/gear/index.astro:711` sets out at length.
 *
 * MODIFIED CLICKS ARE LEFT ALONE. Cmd/Ctrl-click, Shift-click, middle-click and a click on a
 * link with a `target` are the browser's "open this somewhere else" gestures, and a modal
 * cannot honour any of them. Swallowing them would break open-in-new-tab on a control that
 * still looks exactly like a link — which it is.
 *
 * `aria-haspopup="dialog"` IS SET HERE RATHER THAN IN THE MARKUP, on the same principle: it
 * is a promise to a screen-reader user that activating this opens a dialog, and until this
 * function has run that promise is not true.
 */
export function upgradeTrigger(trigger: HTMLElement, opener: ModalOpener): boolean {
  if (trigger.hasAttribute(TRIGGER_BOUND_ATTRIBUTE)) return false;
  trigger.setAttribute(TRIGGER_BOUND_ATTRIBUTE, '');
  trigger.setAttribute('aria-haspopup', 'dialog');

  trigger.addEventListener('click', (event) => {
    if (event.defaultPrevented) return;
    if (event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (trigger.getAttribute('target') !== null) return;
    if (opener.open(trigger)) event.preventDefault();
  });

  return true;
}

// ---------------------------------------------------------------------------
// pairModalTriggers / initModals
// ---------------------------------------------------------------------------

/** The dialog's own marker. An attribute rather than a class so no stylesheet can be made to
 *  depend on it by accident. */
const MODAL_ATTRIBUTE = 'data-modal';
/** Set by `Modal.astro` when the server rendered the dialog already open — see `open()`. */
const OPEN_ON_LOAD_ATTRIBUTE = 'data-modal-open-on-load';
/** The value of a trigger's `data-modal-open` is the `id` of the dialog it opens. */
const TRIGGER_ATTRIBUTE = 'data-modal-open';
/** Marks a dialog already wired, so a re-run is a no-op rather than a second controller. */
const DIALOG_BOUND_ATTRIBUTE = 'data-modal-ready';

/**
 * Joins every trigger in a root to the modal it names, and returns how many were upgraded.
 *
 * A TRIGGER WHOSE `data-modal-open` NAMES NOTHING IS LEFT COMPLETELY ALONE — no listener, no
 * `aria-haspopup`, no attribute of any kind — and that is the case this function exists to
 * get right rather than an edge of it. The name can miss for three ordinary reasons: a typo
 * in an `id`, a dialog rendered only for signed-in visitors while its trigger renders for
 * everyone, and a dialog whose platform `supportsModalDialog` refused. All three end with a
 * trigger that has no modal behind it, and in all three the right outcome is the link the
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
  for (const trigger of root.querySelectorAll<HTMLElement>(`[${TRIGGER_ATTRIBUTE}]`)) {
    const opener = openers.get(trigger.getAttribute(TRIGGER_ATTRIBUTE) ?? '');
    if (opener === undefined) continue;
    if (upgradeTrigger(trigger, opener)) upgraded += 1;
  }
  return upgraded;
}

/**
 * Wires every modal in a document and returns the controllers, keyed by dialog `id`. This is
 * the whole of `Modal.astro`'s `<script>`, which is why that block is one import and one
 * call: a `<script>` block is unreachable from the suite, so anything typed there is
 * untested by construction.
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
 * whole-pipeline behaviour `tests/modal.test.ts` can verify end to end without a browser,
 * because jsdom is genuinely such a platform.
 */
export function initModals(root: ParentNode): ModalController[] {
  const controllers = new Map<string, ModalController>();
  const openOnLoad: ModalController[] = [];

  for (const element of root.querySelectorAll(`dialog[${MODAL_ATTRIBUTE}]`)) {
    if (element.hasAttribute(DIALOG_BOUND_ATTRIBUTE)) continue;
    if (!supportsModalDialog(element)) continue;
    element.setAttribute(DIALOG_BOUND_ATTRIBUTE, '');
    const controller = createModalController(element);
    if (element.id !== '') controllers.set(element.id, controller);
    if (element.hasAttribute(OPEN_ON_LOAD_ATTRIBUTE)) openOnLoad.push(controller);
  }

  pairModalTriggers(root, controllers);

  for (const controller of openOnLoad) controller.open(null);

  return [...controllers.values()];
}
