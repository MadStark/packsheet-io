/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DIALOG_BOUND_ATTRIBUTE,
  DISMISS_ATTRIBUTE,
  MODAL_ATTRIBUTE,
  OPEN_ON_LOAD_ATTRIBUTE,
  TRIGGER_ATTRIBUTE,
  TRIGGER_BOUND_ATTRIBUTE,
  beginModalSession,
  createModalController,
  endModalSession,
  focusFirstWithin,
  focusableWithin,
  initModals,
  isBackdropClick,
  lockScroll,
  pairModalTriggers,
  restoreFocus,
  supportsModalDialog,
  tabTrapTarget,
  upgradeTrigger,
  type ModalDialog,
  type ModalFocusTarget,
  type ModalOpener,
  type ModalRect,
} from '../src/lib/modal';

/**
 * `src/lib/modal.ts` is PK-69's modal shell, and this is the FIRST jsdom test in this
 * repository. Both halves of that sentence need justifying, because the rest of the suite is
 * `environment: 'node'` and stays that way.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EARNS THE EXCEPTION
 * ---------------------------------------------------------------------------
 *
 * Every other test here runs against something that never needed a document: YAML and JSON
 * parsing, a module graph walked after a real build, an APIRoute called as a plain function,
 * SQL run against a real Postgres, and Vue components server-rendered with `renderToString`,
 * which needs no DOM either. `src/lib/packs/drag.ts` states the consequence in its own
 * header — `environment: 'node'` means no `DragEvent`, no `dataTransfer` and no
 * `getBoundingClientRect` — and its answer was to factor every decision into a pure function
 * over plain data, which is the right answer when the decisions ARE about plain data.
 *
 * A modal shell is not that. Half of what it does IS the document: focus really moves,
 * `document.body`'s inline style really has to come back exactly as it was, a listener
 * really has to be attached to the element and not to a copy of it, and a click really has
 * to be left uncancelled so a link can navigate. Those are not decisions about data that
 * happen to touch the DOM; the DOM is the thing being decided about. Asserting them against
 * a hand-rolled object would be asserting the hand-rolled object.
 *
 * ---------------------------------------------------------------------------
 * WHAT JSDOM COULD NOT DO, MEASURED RATHER THAN ASSUMED — AND WHAT THE REVIEW CHANGED
 * ---------------------------------------------------------------------------
 *
 * jsdom 30's `HTMLDialogElement` is a stub: the `open` attribute reflects, and that is the
 * entire implementation. There is no `showModal()`, no `close()`, no top layer, no
 * `::backdrop`, and therefore no `cancel` and no `close` event. The first `describe` below
 * asserts exactly that, against a real `<dialog>` — so if a future jsdom implements the
 * element, this file fails loudly and tells the next person that a whole class of assertion
 * has become available, rather than quietly continuing to test around a gap that closed.
 *
 * THE FIRST VERSION OF THIS FILE STOPPED THERE, AND THAT WAS TOO FAR. Every controller
 * assertion was about the failure path, `initModals` was not covered at all — its body could
 * be replaced with `return []` and all 59 tests stayed green — and five of the defects the
 * PK-69 review went on to find (a drag-release destroying a half-typed form, a session that
 * could never end, a throw between `showModal()` and the session, a scroll lock that does
 * not stack, a second `initModals` pass that is inert) live on exactly the paths nothing was
 * asserting.
 *
 * So `presentable()` below installs `showModal`, `close` and `getBoundingClientRect` ON ONE
 * ELEMENT, IN THE TESTS THAT NEED THEM. That is a collaborator double of the same kind as
 * `recordingOpener` beside it — built by the test, thrown away with it, and never reachable
 * from a browser — and it is emphatically NOT the thing that must never exist: a `showModal`
 * shim inside `src/lib/modal.ts`, which would make every assertion here green while testing
 * the shim. The module has none and must never have one. The line between the two is that a
 * double stands in for a COLLABORATOR so the code under test can be driven; a shim replaces
 * part of the code under test. `presentable` is fourteen lines long and every one of them is
 * the platform's documented behaviour, so what it can hide is bounded and named:
 *
 * STILL NOT TESTED HERE, AND VERIFIED IN A BROWSER: that `showModal()` puts the dialog in
 * the TOP LAYER and that the platform's own focus containment holds; that ESC produces
 * `cancel` and then `close`; that `::backdrop` paints; that a click on the dimmed area
 * really does report the dialog as its target (the premise `isBackdropClick` exists to work
 * around); and that a `<form method="dialog">` submit closes the dialog, which is what the
 * shell's own close button is.
 *
 * WHAT THAT LIST NO LONGER CLAIMS, because the claim was false: the `close` listener
 * `createModalController` installs, the removal of the `keydown` and `click` listeners, the
 * double-open guard, the `open()`-versus-`openFrom(null)` distinction, `close()`'s belt
 * `endSession()` and `destroy()`'s are all asserted below.
 *
 * ---------------------------------------------------------------------------
 * ABOUT THE "Not implemented: navigation to another Document" LINES THIS RUN PRINTS. They
 * are not a failure and they are not noise to be silenced. Several tests below dispatch a
 * real click on a real `<a href="/gear/new">` and assert that nothing cancelled it; jsdom
 * then reaches the anchor's default action, has no navigation to perform, and says so. The
 * message is the assertion restated by the environment — the link really did stay a link.
 *
 * ---------------------------------------------------------------------------
 * Same care as tests/gear-form.test.ts and tests/totals.test.ts: every assertion below names
 * the bug it would catch, not merely what the code does.
 */

/**
 * Replaces the document body with a BRAND NEW ONE, so no test can pass or fail because of
 * what the one before it left behind.
 *
 * Swapping the element rather than resetting `innerHTML` and the inline style is what keeps
 * the scroll lock honest: `lockScroll` counts per element (see its header), and a test that
 * opens a dialog and never closes it would otherwise hand the NEXT test a body whose count
 * has not come back to zero — which shows up as an unrelated assertion about `overflow`
 * failing three files later. The same swap resets `document.activeElement` to a body nothing
 * has focused into.
 */
function render(html: string): HTMLElement {
  const body = document.createElement('body');
  body.innerHTML = html;
  document.documentElement.replaceChild(body, document.body);
  return document.body;
}

/*
 * `console.warn` IS CAPTURED RATHER THAN SILENCED, and the difference matters twice over.
 * Three behaviours in the module ARE the warning — a trigger that is not a link, a dialog
 * with no `id`, two dialogs claiming one `id` — and a test that only checked the visible
 * effect would pass for a version that leaves the developer nothing to read. Capturing also
 * keeps a passing run quiet, which is what makes an unexpected warning worth looking at.
 */
let warnings: unknown[][] = [];

beforeEach(() => {
  warnings = [];
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warnings.push(args);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A `ModalOpener` that records what it was handed and reports whatever the caller wants it
 *  to. It is a collaborator double, NOT a `<dialog>` shim: it stands in for the controller's
 *  two-method interface so the trigger's own behaviour can be driven, and it is never handed
 *  to anything that would try to present it. `'active'` marks a call to `open()`, which is
 *  the "work out the opener yourself" half `openFrom` must not be collapsed into. */
function recordingOpener(result: boolean, destroySignal?: AbortSignal) {
  const openedWith: (ModalFocusTarget | null | 'active')[] = [];
  const opener: ModalOpener = {
    open() {
      openedWith.push('active');
      return result;
    },
    openFrom(from) {
      openedWith.push(from);
      return result;
    },
    destroySignal,
  };
  return { opener, openedWith };
}

/** The rect every geometry assertion in this file is stated against. */
const SHEET: ModalRect = { top: 100, right: 400, bottom: 300, left: 200 };

const INSIDE = { x: 300, y: 200 } as const;
const OUTSIDE = { x: 10, y: 10 } as const;

function mouse(type: string, x: number, y: number, init: MouseEventInit = {}): MouseEvent {
  return new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    detail: 1,
    clientX: x,
    clientY: y,
    ...init,
  });
}

/** A left-button click carrying real coordinates. `detail: 1` is what separates a pointer
 *  click from `element.click()`, and `isBackdropClick` reads it — as it reads the
 *  coordinates, which is why they are set rather than left at the 0,0 a bare `MouseEvent`
 *  defaults to. */
function pointerClick(): MouseEvent {
  return mouse('click', INSIDE.x, INSIDE.y);
}

/**
 * THE PLATFORM DOUBLE. Three methods, on ONE element, installed by the test that needs them
 * — see this file's header for the line between this and a shim, and for what it still
 * cannot reach.
 *
 * Each method is the platform's documented behaviour and nothing else: `showModal()` sets
 * `open` and throws `InvalidStateError` on a dialog that is already open or not in a
 * document (both of which `openFrom` catches for real reasons); `close()` removes `open` and
 * fires a `close` event, which is the announcement the whole controller is built around; and
 * `getBoundingClientRect` answers a fixed rect, because a headless DOM has no layout and the
 * backdrop hit-test is pure geometry.
 *
 * NOT MODELLED, ON PURPOSE: the top layer, `::backdrop`, ESC-to-`cancel`, and focus
 * containment. Faking those would be faking the answer to the questions this file has always
 * said it cannot ask.
 */
function presentable(dialog: HTMLElement, rect: ModalRect = SHEET): ModalDialog {
  const platform = dialog as unknown as {
    showModal: () => void;
    close: () => void;
    getBoundingClientRect: () => DOMRect;
  };

  platform.showModal = () => {
    if (dialog.hasAttribute('open')) throw new Error('InvalidStateError: the dialog is open');
    if (!dialog.isConnected) throw new Error('InvalidStateError: the dialog is not in a document');
    dialog.setAttribute('open', '');
  };

  platform.close = () => {
    if (!dialog.hasAttribute('open')) return;
    dialog.removeAttribute('open');
    dialog.dispatchEvent(new Event('close'));
  };

  platform.getBoundingClientRect = () =>
    ({
      ...rect,
      x: rect.left,
      y: rect.top,
      width: rect.right - rect.left,
      height: rect.bottom - rect.top,
      toJSON: () => rect,
    }) as DOMRect;

  return dialog as ModalDialog;
}

describe('the environment itself', () => {
  it('has no <dialog> behaviour at all, which is the premise every omission in this file rests on', () => {
    const dialog = render('<dialog id="d"></dialog>').querySelector('dialog');

    // If any of these three start failing, jsdom has grown a real dialog and the comments in
    // this file and in src/lib/modal.ts about what could not be tested are now wrong.
    expect(typeof (dialog as unknown as { showModal?: unknown }).showModal).toBe('undefined');
    expect(typeof (dialog as unknown as { close?: unknown }).close).toBe('undefined');
    expect(dialog?.constructor.name).toBe('HTMLDialogElement');
  });
});

describe('supportsModalDialog', () => {
  it('refuses a real <dialog> on a platform with no showModal — the check that keeps a trigger an ordinary link instead of a dead one', () => {
    // `instanceof HTMLDialogElement` would answer true here, which is precisely why the
    // predicate does not ask that question.
    expect(supportsModalDialog(render('<dialog></dialog>').querySelector('dialog'))).toBe(false);
  });

  it('refuses an element that is not a dialog, so a mis-typed selector cannot produce a controller over a <div>', () => {
    expect(supportsModalDialog(render('<div></div>').querySelector('div'))).toBe(false);
  });

  it('refuses null and undefined rather than throwing, because querySelector answers null on every page that does not render a modal', () => {
    expect(supportsModalDialog(null)).toBe(false);
    expect(supportsModalDialog(undefined)).toBe(false);
  });

  it('accepts anything carrying both methods, so tightening this predicate into a class check cannot quietly refuse every real browser and leave the whole feature off', () => {
    // A duck fed to the PREDICATE, to prove the predicate reads the two methods it claims to
    // read and nothing else. The failure this names is silent in the same direction the rest
    // of the module fails safely in: every trigger would simply navigate, which is what a
    // working degradation path looks like from the outside.
    expect(supportsModalDialog({ showModal: () => {}, close: () => {} })).toBe(true);
  });

  it('refuses a dialog that can open and not close, because a visitor stranded inside one has no way back to the page', () => {
    expect(supportsModalDialog({ showModal: () => {} })).toBe(false);
  });
});

describe('focusableWithin', () => {
  it('returns the tabbable set in document order, because the Tab trap wraps on index and a reordered set wraps to the wrong control', () => {
    const root = render(`
      <dialog>
        <input id="one" />
        <select id="two"></select>
        <textarea id="three"></textarea>
        <a id="four" href="/gear">Cancel</a>
        <button id="five">Save</button>
      </dialog>
    `);
    expect(focusableWithin(root).map((element) => element.id)).toEqual([
      'one',
      'two',
      'three',
      'four',
      'five',
    ]);
  });

  it('skips a disabled control, so Tab does not stop on a button the browser will not focus', () => {
    const root = render('<dialog><input id="a" /><button disabled>Save</button></dialog>');
    expect(focusableWithin(root).map((element) => element.id)).toEqual(['a']);
  });

  it('skips a hidden field, which is the single most common member of a real form and would otherwise swallow a Tab press with nothing visible happening', () => {
    const root = render('<dialog><input type="hidden" name="next" /><input id="a" /></dialog>');
    expect(focusableWithin(root).map((element) => element.id)).toEqual(['a']);
  });

  it('skips [hidden] and aria-hidden, so the trap cannot move focus somewhere a screen reader has been told does not exist', () => {
    const root = render(`
      <dialog>
        <button hidden>Gone</button>
        <button aria-hidden="true">Decorative</button>
        <button id="a">Save</button>
      </dialog>
    `);
    expect(focusableWithin(root).map((element) => element.id)).toEqual(['a']);
  });

  it('skips a field inside a [hidden] ANCESTOR, without which Tab at the wrap edge does nothing at all — preventDefault runs and then focus() lands on an unfocusable element', () => {
    const root = render(`
      <dialog>
        <div hidden><input id="collapsed" /></div>
        <fieldset aria-hidden="true"><input id="announced-gone" /></fieldset>
        <button id="a">Save</button>
      </dialog>
    `);
    // `hidden` hides a subtree and `aria-hidden` removes one from the accessibility tree, so
    // asking the element alone — which is what this did — puts phantom members in the set.
    expect(focusableWithin(root).map((element) => element.id)).toEqual(['a']);
  });

  it('skips a negative tabindex but keeps tabindex="0", because "programmatically focusable" and "in the tab order" are different sets and only the second one wraps', () => {
    const root = render(`
      <dialog>
        <div id="skip" tabindex="-1">Scroll region</div>
        <div id="keep" tabindex="0">Custom control</div>
      </dialog>
    `);
    expect(focusableWithin(root).map((element) => element.id)).toEqual(['keep']);
  });

  it('treats an invalid tabindex as absent on both sides of the question, so a decorated <div> is not tabbable and a decorated <button> still is', () => {
    const root = render(`
      <dialog>
        <div id="not-a-control" tabindex="yes">Decorated</div>
        <button id="a" tabindex="yes">Save</button>
      </dialog>
    `);
    // parseInt('yes') is NaN and `NaN < 0` is false, so reading the attribute with parseInt
    // alone put the div in the tab order. HTML says an invalid value is treated as absent —
    // which excludes the div and keeps the button, because a button is focusable anyway.
    expect(focusableWithin(root).map((element) => element.id)).toEqual(['a']);
  });

  it('skips contenteditable="false", which is markup that exists to say this subtree is NOT editable', () => {
    const root = render(`
      <dialog>
        <div id="frozen" contenteditable="false">Read-only</div>
        <div id="a" contenteditable="true">Notes</div>
      </dialog>
    `);
    expect(focusableWithin(root).map((element) => element.id)).toEqual(['a']);
  });

  it('skips anything inside an [inert] subtree, so a form disabled during a save does not keep taking Tab', () => {
    const root = render(`
      <dialog>
        <fieldset inert><input id="frozen" /></fieldset>
        <button id="a">Save</button>
      </dialog>
    `);
    expect(focusableWithin(root).map((element) => element.id)).toEqual(['a']);
  });

  it('returns HTML elements only, so an inline <svg><a href> cannot enter the set through a cast and be focused as if it were one', () => {
    const root = render(`
      <dialog>
        <svg><a id="svg-link" href="/gear"><text>Icon</text></a></svg>
        <button id="a">Save</button>
      </dialog>
    `);
    // The selector genuinely matches the SVG anchor — `a[href]` does not care which
    // namespace it is in — and the old `querySelectorAll<HTMLElement>` cast told the
    // compiler otherwise. jsdom confirms the match, so this is the filter and not the
    // selector doing the work.
    expect(root.querySelector('#svg-link')?.matches('a[href]')).toBe(true);
    expect(focusableWithin(root).map((element) => element.id)).toEqual(['a']);
  });
});

describe('tabTrapTarget', () => {
  it('wraps forward off the last control to the first, which is the whole point of the trap', () => {
    expect(tabTrapTarget(3, 2, false)).toBe(0);
  });

  it('wraps backward off the first control to the last, the half that is easy to leave out because Shift+Tab is not how anyone tests by hand', () => {
    expect(tabTrapTarget(3, 0, true)).toBe(2);
  });

  it('returns null in the middle of the set, so the browser keeps its own sequential navigation instead of a re-implementation that gets radio groups and selects wrong', () => {
    expect(tabTrapTarget(3, 1, false)).toBe(null);
    expect(tabTrapTarget(3, 1, true)).toBe(null);
  });

  it('enters the set from the matching end when focus is on the dialog itself, rather than letting the first Tab after showModal() walk into the page behind it', () => {
    expect(tabTrapTarget(3, -1, false)).toBe(0);
    expect(tabTrapTarget(3, -1, true)).toBe(2);
  });

  it('keeps focus on a lone control in both directions, where both edges are the same index and a wrap that only handled one of them would let Tab escape', () => {
    // This used to be described as the case a "naive edge check" would answer `null` for,
    // and it is not: both edge branches answer 0 here, which is why the `count === 1`
    // special case they sat behind was deleted as unreachable-by-effect rather than kept.
    expect(tabTrapTarget(1, 0, false)).toBe(0);
    expect(tabTrapTarget(1, 0, true)).toBe(0);
  });

  it('returns null when there is nothing to trap onto, because cancelling the keypress instead would leave a visitor with a Tab key that silently does nothing', () => {
    expect(tabTrapTarget(0, -1, false)).toBe(null);
    expect(tabTrapTarget(0, -1, true)).toBe(null);
  });
});

describe('isBackdropClick', () => {
  it('reports a point outside the sheet on every side, which is the only way to tell a backdrop click from one on the dialog padding — both report the dialog as the event target', () => {
    expect(isBackdropClick(SHEET, { clientX: 199, clientY: 200, detail: 1 })).toBe(true);
    expect(isBackdropClick(SHEET, { clientX: 401, clientY: 200, detail: 1 })).toBe(true);
    expect(isBackdropClick(SHEET, { clientX: 300, clientY: 99, detail: 1 })).toBe(true);
    expect(isBackdropClick(SHEET, { clientX: 300, clientY: 301, detail: 1 })).toBe(true);
  });

  it('does not report a point inside the sheet, or the visitor loses a half-typed form every time they click their own text field', () => {
    expect(isBackdropClick(SHEET, { clientX: 300, clientY: 200, detail: 1 })).toBe(false);
  });

  it('treats the boundary as inside, so a click on the sheet edge is not a dismissal', () => {
    expect(isBackdropClick(SHEET, { clientX: 200, clientY: 100, detail: 1 })).toBe(false);
    expect(isBackdropClick(SHEET, { clientX: 400, clientY: 300, detail: 1 })).toBe(false);
  });

  it('refuses a keyboard-synthesised click, whose coordinates are 0,0 — otherwise pressing Enter on Save dismisses the dialog instead of submitting the form', () => {
    expect(isBackdropClick(SHEET, { clientX: 0, clientY: 0, detail: 0 })).toBe(false);
  });

  it('refuses a zero-area rect, because every coordinate is outside one and the unguarded version makes a dialog with no layout yet impossible to click at all', () => {
    const empty = { top: 0, right: 0, bottom: 0, left: 0 } as const;
    expect(isBackdropClick(empty, { clientX: 10, clientY: 10, detail: 1 })).toBe(false);
    expect(isBackdropClick(empty, { clientX: 0, clientY: 0, detail: 1 })).toBe(false);
  });
});

describe('lockScroll', () => {
  it('writes overflow:hidden on the element it was handed, without which the page scrolls behind the sheet and the visitor loses their place in it', () => {
    render('');
    lockScroll(document.body);
    expect(document.body.style.overflow).toBe('hidden');
  });

  it('restores the inline value it found rather than clearing it, which is the difference between putting a page back and silently deleting a declaration something else set', () => {
    render('');
    document.body.style.overflow = 'auto';
    const release = lockScroll(document.body);
    expect(document.body.style.overflow).toBe('hidden');
    release();
    expect(document.body.style.overflow).toBe('auto');
  });

  it('leaves no inline overflow behind when there was none, so a closed dialog cannot be detected by inspecting the body', () => {
    render('');
    lockScroll(document.body)();
    expect(document.body.style.overflow).toBe('');
  });

  it('ignores a second release, because the close path can be reached twice for one open — a backdrop click that calls close(), and the platform close event behind it', () => {
    render('');
    const release = lockScroll(document.body);
    release();
    document.body.style.overflow = 'auto';
    release();
    expect(document.body.style.overflow).toBe('auto');
  });

  it('KEEPS THE PAGE LOCKED WHILE A SECOND LOCK IS STILL HELD, so closing the first of two open dialogs does not let the page scroll behind the one still on screen', () => {
    render('');
    const first = lockScroll(document.body);
    const second = lockScroll(document.body);

    first();

    expect(document.body.style.overflow).toBe('hidden');
    second();
    expect(document.body.style.overflow).toBe('');
  });

  it('restores what the page had before ANY lock, not what the previous lock wrote — the un-counted version restored "hidden" permanently, with nothing on screen to explain it', () => {
    render('');
    document.body.style.overflow = 'auto';

    const first = lockScroll(document.body);
    const second = lockScroll(document.body);
    first();
    second();

    expect(document.body.style.overflow).toBe('auto');
  });

  it('counts per element, so a lock on one document body cannot release another', () => {
    const root = render('<div id="other"></div>');
    const other = root.querySelector<HTMLElement>('#other') as HTMLElement;

    const onBody = lockScroll(document.body);
    lockScroll(other);
    onBody();

    expect(document.body.style.overflow).toBe('');
    expect(other.style.overflow).toBe('hidden');
  });
});

describe('restoreFocus', () => {
  it('puts focus back on the control that opened the dialog, which is the whole of what a keyboard visitor notices when it is missing', () => {
    const root = render('<button id="opener">Add item</button><button id="other">Other</button>');
    const opener = root.querySelector<HTMLElement>('#opener');
    root.querySelector<HTMLElement>('#other')?.focus();

    expect(restoreFocus(opener)).toBe(true);
    expect(document.activeElement?.id).toBe('opener');
  });

  it('does nothing for an opener the page has since removed, the ordinary case for an Edit modal whose save re-renders the row its own trigger sat in', () => {
    const root = render('<button id="opener">Edit</button>');
    const opener = root.querySelector<HTMLElement>('#opener');
    opener?.focus();
    opener?.remove();

    // A detached element still HAS focus(); calling it does not throw and does not work
    // either, so a version without the isConnected check would report success and leave
    // focus on <body> with nothing anywhere saying so.
    expect(restoreFocus(opener)).toBe(false);
    expect(document.activeElement).toBe(document.body);
  });

  it('tolerates a null opener, which is what a dialog opened on load by a URL visit genuinely has', () => {
    render('');
    expect(restoreFocus(null)).toBe(false);
  });

  it('restores focus to an SVG opener, which an instanceof HTMLElement test dropped on the floor — an inline icon button is not an HTMLElement and focus simply never came back', () => {
    const root = render(
      '<svg id="icon" tabindex="0"><text>Edit</text></svg><button id="other">x</button>',
    );
    const icon = root.querySelector('#icon') as unknown as ModalFocusTarget;
    root.querySelector<HTMLElement>('#other')?.focus();

    expect(restoreFocus(icon)).toBe(true);
    expect(document.activeElement?.id).toBe('icon');
  });
});

describe('focusFirstWithin', () => {
  it('prefers an autofocus field over the first control, so a form modal opens on its first input rather than on Cancel', () => {
    const root = render(`
      <dialog open>
        <a id="close" href="/gear">Close</a>
        <input id="name" autofocus />
      </dialog>
    `);
    const dialog = root.querySelector<HTMLElement>('dialog');
    expect(focusFirstWithin(dialog as HTMLElement)?.id).toBe('name');
    expect(document.activeElement?.id).toBe('name');
  });

  it('falls back to the first tabbable control when nothing claims autofocus, so a modal never opens with focus still on the page behind it', () => {
    const root = render('<dialog open><input id="name" /><button id="save">Save</button></dialog>');
    const dialog = root.querySelector<HTMLElement>('dialog');
    expect(focusFirstWithin(dialog as HTMLElement)?.id).toBe('name');
  });

  it('steps over the shell’s own close button, without which every modal opens focused on Close because the header happens to come first in the DOM', () => {
    const root = render(`
      <dialog open>
        <header><button id="dismiss" ${DISMISS_ATTRIBUTE} aria-label="Close">x</button></header>
        <input id="name" />
      </dialog>
    `);
    const dialog = root.querySelector<HTMLElement>('dialog');
    expect(focusFirstWithin(dialog as HTMLElement)?.id).toBe('name');
    // Stepped over, not excluded: it is one Tab away, which is the point of putting it there.
    expect(focusableWithin(dialog as HTMLElement).map((element) => element.id)).toEqual([
      'dismiss',
      'name',
    ]);
  });

  it('still focuses the close button when it is the only control, rather than falling all the way back to the dialog and leaving a Tab-less sheet', () => {
    const root = render(`
      <dialog open id="d" tabindex="-1">
        <button id="dismiss" ${DISMISS_ATTRIBUTE} aria-label="Close">x</button>
        <p>Nothing else here.</p>
      </dialog>
    `);
    const dialog = root.querySelector<HTMLElement>('dialog');
    expect(focusFirstWithin(dialog as HTMLElement)?.id).toBe('dismiss');
  });

  it('falls back to the dialog itself when it holds nothing focusable, rather than leaving focus on the page behind it', () => {
    const root = render('<dialog open id="d" tabindex="-1"><p>Nothing here.</p></dialog>');
    const dialog = root.querySelector<HTMLElement>('dialog');
    expect(focusFirstWithin(dialog as HTMLElement)?.id).toBe('d');
  });
});

describe('beginModalSession / endModalSession', () => {
  /** The markup a consumer produces: a trigger on the page, and a dialog holding a form. */
  function scene() {
    const root = render(`
      <button id="opener">Add item</button>
      <dialog open id="d" tabindex="-1">
        <input id="name" />
        <button id="save">Save</button>
      </dialog>
    `);
    return {
      opener: root.querySelector<HTMLElement>('#opener') as HTMLElement,
      dialog: root.querySelector<HTMLElement>('#d') as HTMLElement,
    };
  }

  it('locks the page scroll and moves focus into the dialog — the whole of "it opened", minus the showModal() call jsdom has no implementation of', () => {
    const { opener, dialog } = scene();
    opener.focus();

    beginModalSession(dialog, opener);

    expect(document.body.style.overflow).toBe('hidden');
    expect(document.activeElement?.id).toBe('name');
  });

  it('unlocks the scroll and returns focus to the opener, without which ESC leaves a keyboard visitor at the top of a document that can no longer scroll', () => {
    const { opener, dialog } = scene();
    opener.focus();

    const session = beginModalSession(dialog, opener);
    endModalSession(session);

    expect(document.body.style.overflow).toBe('');
    expect(document.activeElement?.id).toBe('opener');
  });

  it('restores the inline overflow the page arrived with, so opening a modal cannot silently delete a declaration another stylesheet set', () => {
    const { opener, dialog } = scene();
    document.body.style.overflow = 'clip';

    endModalSession(beginModalSession(dialog, opener));

    expect(document.body.style.overflow).toBe('clip');
  });

  it('GIVES THE SCROLL LOCK BACK WHEN THE FOCUS STEP THROWS, or the releaser dies with the stack frame and the page is locked for the rest of the visit', () => {
    const { opener, dialog } = scene();
    const name = dialog.querySelector<HTMLElement>('#name') as HTMLElement;
    // A consumer's element whose `focus` raises. The lock is taken BEFORE focus moves, so
    // this is the whole of the window in which a throw strands it.
    name.focus = () => {
      throw new Error('boom');
    };

    expect(() => beginModalSession(dialog, opener)).toThrow('boom');
    expect(document.body.style.overflow).toBe('');
  });

  it('still unlocks the scroll when the opener has gone, so a save that re-renders the trigger cannot leave the page permanently unscrollable', () => {
    const { opener, dialog } = scene();
    const session = beginModalSession(dialog, opener);
    opener.remove();

    endModalSession(session);

    // The bug this names is the ORDER inside endModalSession: the unlock happens first, so a
    // focus restore that fails — or throws — cannot take the scroll lock down with it.
    // (Whether focus is restored at all for a detached opener is restoreFocus's own test
    // above, which asserts the isConnected guard directly; nothing observable here could
    // tell that guard's presence from its absence, because focus() on a detached element
    // neither throws nor moves anything.)
    expect(document.body.style.overflow).toBe('');
    expect(opener.contains(document.activeElement)).toBe(false);
  });

  it('records a null opener for a dialog nothing clicked, which is what open-on-load is, and closes without trying to focus anything', () => {
    const { dialog } = scene();
    const session = beginModalSession(dialog, null);
    expect(session.opener).toBe(null);

    endModalSession(session);
    expect(document.body.style.overflow).toBe('');
  });
});

describe('upgradeTrigger', () => {
  function trigger(markup = '<a id="t" href="/gear/new">Add item</a>'): HTMLElement {
    return render(markup).querySelector<HTMLElement>('#t') as HTMLElement;
  }

  it('leaves an un-upgraded link completely alone, which is the state the page ships in and the one every failure mode falls back to', () => {
    const link = trigger();
    const event = pointerClick();
    link.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(link.getAttribute('href')).toBe('/gear/new');
    expect(link.getAttribute('aria-haspopup')).toBe(null);
  });

  it('opens the modal and cancels the navigation, handing the trigger itself over so focus has somewhere to come back to', () => {
    const link = trigger();
    const { opener, openedWith } = recordingOpener(true);
    expect(upgradeTrigger(link, opener)).not.toBe(null);

    const event = pointerClick();
    link.dispatchEvent(event);

    expect(openedWith).toEqual([link]);
    expect(event.defaultPrevented).toBe(true);
    expect(link.getAttribute('aria-haspopup')).toBe('dialog');
    expect(link.getAttribute('href')).toBe('/gear/new');
  });

  it('LETS THE NAVIGATION HAPPEN when the dialog did not open — cancelling first and hoping is how a working link becomes a control that does nothing', () => {
    const link = trigger();
    const { opener } = recordingOpener(false);
    upgradeTrigger(link, opener);

    const event = pointerClick();
    link.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(link.getAttribute('href')).toBe('/gear/new');
  });

  it('REFUSES A <button>, which has nowhere to fall through to and is therefore a permanently dead control on every platform the dialog cannot open on', () => {
    const control = render(`<button id="t" ${TRIGGER_ATTRIBUTE}="add-item">Add item</button>`);
    const button = control.querySelector<HTMLElement>('#t') as HTMLElement;
    const { opener, openedWith } = recordingOpener(true);

    expect(upgradeTrigger(button, opener)).toBe(null);

    button.dispatchEvent(pointerClick());
    expect(openedWith).toHaveLength(0);
    expect(button.getAttribute('aria-haspopup')).toBe(null);
    expect(button.hasAttribute(TRIGGER_BOUND_ATTRIBUTE)).toBe(false);
    // Refusing silently would leave the author with a control that does nothing and no
    // reason anywhere; the refusal is the only feedback this mistake ever gets.
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0]?.[0])).toContain(TRIGGER_ATTRIBUTE);
  });

  it('refuses an anchor with no href, which is a <button> wearing an <a> and degrades exactly as badly', () => {
    const link = trigger('<a id="t">Add item</a>');
    expect(upgradeTrigger(link, recordingOpener(true).opener)).toBe(null);
    expect(link.getAttribute('aria-haspopup')).toBe(null);
  });

  it('refuses to bind twice, so a second init pass over the same document does not open the dialog twice per click', () => {
    const link = trigger();
    const first = recordingOpener(true);
    const second = recordingOpener(true);

    expect(upgradeTrigger(link, first.opener)).not.toBe(null);
    expect(upgradeTrigger(link, second.opener)).toBe(null);

    link.dispatchEvent(pointerClick());
    expect(first.openedWith).toHaveLength(1);
    expect(second.openedWith).toHaveLength(0);
  });

  it('puts the link back exactly as it was when unbound, so a destroyed controller cannot leave an aria-haspopup promising a dialog nothing will open', () => {
    const link = trigger();
    const { opener, openedWith } = recordingOpener(true);
    const unbind = upgradeTrigger(link, opener);

    unbind?.();

    link.dispatchEvent(pointerClick());
    expect(openedWith).toHaveLength(0);
    expect(link.getAttribute('aria-haspopup')).toBe(null);
    expect(link.hasAttribute(TRIGGER_BOUND_ATTRIBUTE)).toBe(false);
    expect(link.getAttribute('href')).toBe('/gear/new');
  });

  it('unbinds itself when the controller behind it is destroyed, which is what stops a destroyed controller from cancelling navigations forever', () => {
    const link = trigger();
    const destruction = new AbortController();
    const { opener, openedWith } = recordingOpener(true, destruction.signal);
    upgradeTrigger(link, opener);

    destruction.abort();

    const event = pointerClick();
    link.dispatchEvent(event);
    expect(openedWith).toHaveLength(0);
    expect(event.defaultPrevented).toBe(false);
    expect(link.getAttribute('aria-haspopup')).toBe(null);
  });

  it('refuses to bind to an already-destroyed controller, so a re-init after a teardown does not hand a link to something that opens nothing', () => {
    const link = trigger();
    const destruction = new AbortController();
    destruction.abort();

    expect(upgradeTrigger(link, recordingOpener(true, destruction.signal).opener)).toBe(null);
    expect(link.getAttribute('aria-haspopup')).toBe(null);
  });

  it('ignores a modified click, because Cmd/Ctrl/Shift-click means "open this somewhere else" and a modal cannot honour it on a control that still is a link', () => {
    const link = trigger();
    const { opener, openedWith } = recordingOpener(true);
    upgradeTrigger(link, opener);

    for (const modifier of ['metaKey', 'ctrlKey', 'shiftKey', 'altKey'] as const) {
      const event = mouse('click', INSIDE.x, INSIDE.y, { [modifier]: true });
      link.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(openedWith).toHaveLength(0);
  });

  it('ignores a middle click, which is open-in-new-tab on every platform that does not use a modifier for it', () => {
    const link = trigger();
    const { opener, openedWith } = recordingOpener(true);
    upgradeTrigger(link, opener);

    const event = mouse('click', INSIDE.x, INSIDE.y, { button: 1 });
    link.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(openedWith).toHaveLength(0);
  });

  it('ignores a link with a target, so a modal cannot swallow the open-in-another-window its author already asked for', () => {
    const link = trigger('<a id="t" href="/gear/new" target="_blank">Add item</a>');
    const { opener, openedWith } = recordingOpener(true);
    upgradeTrigger(link, opener);

    const event = pointerClick();
    link.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(openedWith).toHaveLength(0);
  });

  it('stands aside for a click something else already cancelled, so it cannot resurrect a navigation another handler deliberately stopped', () => {
    const link = trigger();
    const { opener, openedWith } = recordingOpener(true);
    upgradeTrigger(link, opener);
    link.addEventListener('click', (event) => event.preventDefault(), true);

    link.dispatchEvent(pointerClick());
    expect(openedWith).toHaveLength(0);
  });
});

describe('pairModalTriggers', () => {
  it('joins each trigger to the dialog its data-modal-open names, and only that one', () => {
    const root = render(`
      <a id="add" href="/gear/new" ${TRIGGER_ATTRIBUTE}="add-item">Add</a>
      <a id="edit" href="/gear/1" ${TRIGGER_ATTRIBUTE}="edit-item">Edit</a>
    `);
    const add = recordingOpener(true);
    const edit = recordingOpener(true);

    expect(
      pairModalTriggers(
        root,
        new Map([
          ['add-item', add.opener],
          ['edit-item', edit.opener],
        ]),
      ),
    ).toBe(2);

    root.querySelector<HTMLElement>('#add')?.dispatchEvent(pointerClick());
    expect(add.openedWith).toHaveLength(1);
    expect(edit.openedWith).toHaveLength(0);
  });

  it('LEAVES A TRIGGER NAMING A DIALOG THAT IS NOT THERE COMPLETELY UNTOUCHED — a typo in an id, or a dialog the platform refused, must produce a working link and not a control announcing a dialog it cannot open', () => {
    const root = render(`<a id="t" href="/gear/new" ${TRIGGER_ATTRIBUTE}="typo">Add</a>`);

    expect(pairModalTriggers(root, new Map([['add-item', recordingOpener(true).opener]]))).toBe(0);

    const link = root.querySelector<HTMLElement>('#t') as HTMLElement;
    const event = pointerClick();
    link.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(link.getAttribute('aria-haspopup')).toBe(null);
    expect(link.getAttribute('href')).toBe('/gear/new');
  });

  it('joins every trigger that names the same dialog, because a list page has one Edit link per row and all of them open the one shell', () => {
    const root = render(`
      <a href="/gear/1" ${TRIGGER_ATTRIBUTE}="edit">Edit</a>
      <a href="/gear/2" ${TRIGGER_ATTRIBUTE}="edit">Edit</a>
    `);
    expect(pairModalTriggers(root, new Map([['edit', recordingOpener(true).opener]]))).toBe(2);
  });
});

describe('createModalController on a platform with no modal dialogs', () => {
  function scene() {
    const root = render(`
      <button id="opener">Add item</button>
      <dialog id="d" ${MODAL_ATTRIBUTE} tabindex="-1"><input id="name" /></dialog>
    `);
    return {
      opener: root.querySelector<HTMLElement>('#opener') as HTMLElement,
      dialog: root.querySelector('dialog') as HTMLDialogElement,
    };
  }

  /*
   * EVERY ASSERTION IN THIS BLOCK IS ABOUT THE FAILURE PATH, reached with no double of any
   * kind: `openFrom()` here always ends in the `catch`, because jsdom has no `showModal()`
   * to call (see the first describe). It is what runs on a browser too old for `<dialog>`,
   * and every assertion below names a way that a shell which "tried anyway" would leave the
   * page worse than if it had never loaded. The success path is the block after this one.
   */

  it('reports failure rather than throwing when the platform cannot present a dialog, so the trigger that called it can fall through to its own href', () => {
    const { dialog, opener } = scene();
    expect(createModalController(dialog).openFrom(opener)).toBe(false);
  });

  it('says so once in the console, because a silent false is a link that navigated — which is also what success at every other layer looks like', () => {
    const { dialog, opener } = scene();
    createModalController(dialog).openFrom(opener);

    expect(warnings).toHaveLength(1);
    expect(String(warnings[0]?.[0])).toContain('showModal()');
  });

  it('leaves the page exactly as it found it after a failed open — no scroll lock and no moved focus, because showModal() is called BEFORE the session begins and not after', () => {
    const { dialog, opener } = scene();
    opener.focus();

    createModalController(dialog).openFrom(opener);

    // The bug this names is one line of ordering: lock the scroll first and a visitor whose
    // browser cannot open the dialog gets a page that cannot be scrolled, with nothing on
    // screen to explain it and no dialog to close.
    expect(document.body.getAttribute('style')).toBe(null);
    expect(document.activeElement?.id).toBe('opener');
  });

  it('never claims to be open after a failed open, so close() and a second click cannot act on a session that does not exist', () => {
    const { dialog, opener } = scene();
    const controller = createModalController(dialog);
    controller.openFrom(opener);
    expect(controller.isOpen).toBe(false);
  });

  it('PUTS THE SERVER-RENDERED open ATTRIBUTE BACK when the promotion fails, or a direct URL visit ends on a blank page because the script deleted the form it could not replace', () => {
    const root = render(`<dialog id="d" ${MODAL_ATTRIBUTE} open><input id="name" /></dialog>`);
    const dialog = root.querySelector('dialog') as HTMLDialogElement;

    expect(createModalController(dialog).openFrom(null)).toBe(false);
    expect(dialog.hasAttribute('open')).toBe(true);
  });

  it('does not invent an open attribute on a dialog the server rendered closed', () => {
    const { dialog } = scene();
    createModalController(dialog).openFrom(null);
    expect(dialog.hasAttribute('open')).toBe(false);
  });

  it('does nothing on close() when nothing opened, so a stray dismissal cannot release a scroll lock some other dialog is holding', () => {
    const { dialog } = scene();
    document.body.style.overflow = 'hidden';

    createModalController(dialog).close();

    expect(document.body.style.overflow).toBe('hidden');
  });

  it('destroys cleanly without an open session, which is what a page unload does to every controller it made', () => {
    const { dialog } = scene();
    const controller = createModalController(dialog);
    expect(() => controller.destroy()).not.toThrow();
    expect(controller.isOpen).toBe(false);
  });
});

describe('createModalController on a platform that can present one', () => {
  /**
   * The scene every assertion below is stated against: a trigger, a control to open from,
   * and a dialog whose three platform methods are the double described at the top of this
   * file. The `<textarea>` is not decoration — it is where the drag that used to destroy a
   * half-typed form starts.
   */
  function scene() {
    const root = render(`
      <a id="t" href="/gear/new" ${TRIGGER_ATTRIBUTE}="d">Add item</a>
      <button id="opener">Add item</button>
      <dialog id="d" ${MODAL_ATTRIBUTE} tabindex="-1">
        <button id="dismiss" ${DISMISS_ATTRIBUTE} aria-label="Close">x</button>
        <textarea id="notes"></textarea>
        <button id="save">Save</button>
      </dialog>
    `);
    const dialog = presentable(root.querySelector('dialog') as HTMLElement);
    return {
      root,
      dialog,
      link: root.querySelector<HTMLElement>('#t') as HTMLElement,
      opener: root.querySelector<HTMLElement>('#opener') as HTMLElement,
      notes: root.querySelector<HTMLElement>('#notes') as HTMLElement,
      controller: createModalController(dialog),
    };
  }

  it('presents the dialog, locks the scroll and moves focus past the close button into the form', () => {
    const { controller, dialog, opener } = scene();
    opener.focus();

    expect(controller.openFrom(opener)).toBe(true);

    expect(dialog.hasAttribute('open')).toBe(true);
    expect(controller.isOpen).toBe(true);
    expect(document.body.style.overflow).toBe('hidden');
    expect(document.activeElement?.id).toBe('notes');
  });

  it('tidies up on the platform close event whoever fired it, which is what makes ESC and a <form method="dialog"> submit end on the same path as close()', () => {
    const { controller, dialog, opener } = scene();
    opener.focus();
    controller.openFrom(opener);

    // The platform's own announcement, not a call into the controller. This is the event ESC
    // produces, and the one the header's close button produces on submit.
    dialog.close();

    expect(controller.isOpen).toBe(false);
    expect(document.body.style.overflow).toBe('');
    expect(document.activeElement?.id).toBe('opener');
  });

  it('closes on its own close(), and a second close() does nothing rather than releasing a lock the next dialog is holding', () => {
    const { controller, dialog } = scene();
    controller.openFrom(null);

    controller.close();
    expect(dialog.hasAttribute('open')).toBe(false);
    expect(controller.isOpen).toBe(false);

    document.body.style.overflow = 'hidden';
    controller.close();
    expect(document.body.style.overflow).toBe('hidden');
  });

  it('REFUSES A SECOND OPEN while one is up, because showModal() throws on an open dialog and a second session would take a second scroll lock nothing would ever release', () => {
    const { controller, opener } = scene();
    document.body.style.overflow = 'auto';

    expect(controller.openFrom(opener)).toBe(true);
    expect(controller.openFrom(opener)).toBe(true);

    controller.close();
    expect(document.body.style.overflow).toBe('auto');
    expect(warnings).toHaveLength(0);
  });

  it('takes the opener from whatever had focus for open(), and from nobody for openFrom(null) — the distinction one `?? null` at a call site would have erased', () => {
    const { controller, opener } = scene();
    opener.focus();

    controller.open();
    controller.close();
    expect(document.activeElement?.id).toBe('opener');

    opener.focus();
    controller.openFrom(null);
    controller.close();
    // Nothing opened it, so nothing is focused on the way out: focus is left wherever the
    // dialog's own closing put it, which is not the button that happened to have it before.
    expect(document.activeElement?.id).not.toBe('opener');
  });

  it('traps Tab at the end of the set and wraps to the first control, skipping the members no ancestor lets anyone reach', () => {
    const { controller, dialog, root } = scene();
    const save = root.querySelector<HTMLElement>('#save') as HTMLElement;
    dialog.insertAdjacentHTML('beforeend', '<div hidden><input id="collapsed" /></div>');
    controller.openFrom(null);
    save.focus();

    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    dialog.dispatchEvent(tab);

    // The wrap goes to the close button, which is first in the DOM — and NOT to the hidden
    // input, which the old element-only `hidden` check would have put at the end of the set,
    // where preventDefault() ran and focus() then landed on nothing at all.
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement?.id).toBe('dismiss');
  });

  it('CLOSES ON A BACKDROP PRESS THAT IS ALSO RELEASED ON THE BACKDROP, which is what a dismissal actually is', () => {
    const { controller, dialog } = scene();
    controller.openFrom(null);

    dialog.dispatchEvent(mouse('mousedown', OUTSIDE.x, OUTSIDE.y));
    dialog.dispatchEvent(mouse('click', OUTSIDE.x, OUTSIDE.y));

    expect(controller.isOpen).toBe(false);
  });

  it('DOES NOT CLOSE WHEN A DRAG STARTED INSIDE THE SHEET AND ENDED OVER THE BACKDROP, which is drag-selecting a textarea and releasing past the edge — the reproduction that cost a half-typed form', () => {
    const { controller, dialog, notes } = scene();
    controller.openFrom(null);

    // A `click` is dispatched at the nearest common inclusive ancestor of mousedown and
    // mouseup and carries the MOUSEUP coordinates — so the event the handler sees names the
    // dialog and points outside it, which is indistinguishable from a dismissal unless the
    // press was recorded.
    notes.dispatchEvent(mouse('mousedown', INSIDE.x, INSIDE.y));
    dialog.dispatchEvent(mouse('click', OUTSIDE.x, OUTSIDE.y));

    expect(controller.isOpen).toBe(true);
    expect(dialog.hasAttribute('open')).toBe(true);
  });

  it('does not close when the press started on the backdrop and finished inside the sheet, the same gesture in the other direction', () => {
    const { controller, dialog } = scene();
    controller.openFrom(null);

    dialog.dispatchEvent(mouse('mousedown', OUTSIDE.x, OUTSIDE.y));
    dialog.dispatchEvent(mouse('click', INSIDE.x, INSIDE.y));

    expect(controller.isOpen).toBe(true);
  });

  it('forgets the press after every click, so one backdrop press cannot dismiss on some later click and quietly turn the two-endpoint check back into a one-endpoint one', () => {
    const { controller, dialog, notes } = scene();
    controller.openFrom(null);

    dialog.dispatchEvent(mouse('mousedown', OUTSIDE.x, OUTSIDE.y));
    dialog.dispatchEvent(mouse('click', INSIDE.x, INSIDE.y));

    notes.dispatchEvent(mouse('mousedown', INSIDE.x, INSIDE.y));
    dialog.dispatchEvent(mouse('click', OUTSIDE.x, OUTSIDE.y));

    expect(controller.isOpen).toBe(true);
  });

  it('ignores a keyboard-activated click, which carries no mousedown at all and 0,0 coordinates — otherwise Enter on Save dismisses the form instead of submitting it', () => {
    const { controller, dialog } = scene();
    controller.openFrom(null);

    dialog.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }));

    expect(controller.isOpen).toBe(true);
  });

  it('ENDS THE SESSION WHEN THE DIALOG IS REMOVED FROM THE DOCUMENT, which fires no close event at all and used to leave a session nothing could ever end', () => {
    const { controller, dialog, opener } = scene();
    opener.focus();
    controller.openFrom(opener);

    // HTML's removing steps take the dialog out of the top layer and fire NOTHING — no
    // cancel, no close. A hydrated island re-rendering its container reaches this without
    // doing anything unusual.
    dialog.remove();

    expect(controller.isOpen).toBe(false);
    expect(document.body.style.overflow).toBe('');
  });

  it('opens for real again after the dialog it lost has been put back, rather than answering true forever on the strength of a session that is over', () => {
    const { controller, dialog, root } = scene();
    controller.openFrom(null);
    dialog.remove();
    // Reading `isOpen` is what reconciles the stale session; removal itself announces
    // nothing, which is the whole of C2a.
    expect(controller.isOpen).toBe(false);

    root.append(dialog);

    expect(controller.openFrom(null)).toBe(true);
    // The `true` alone proves nothing: the broken version returned `true` from the stale
    // session without presenting anything. Focus having moved into the dialog is what says
    // a new session really began — removal had left it on <body>.
    expect(document.activeElement?.id).toBe('notes');
    expect(controller.isOpen).toBe(true);
  });

  it('PUTS THE DIALOG BACK DOWN when the session cannot begin, so a throw between showModal() and the bookkeeping cannot leave a modal on screen that nothing on the page can dismiss', () => {
    const { controller, dialog, notes } = scene();
    // The reproduction: `focusFirstWithin` calling `.focus()` on something that turns out
    // not to have a usable one. It threw after `showModal()` had presented the dialog and
    // after the scroll lock had been taken, and outside the only `try` there was.
    notes.focus = () => {
      throw new Error('boom');
    };

    expect(controller.openFrom(null)).toBe(false);

    expect(dialog.hasAttribute('open')).toBe(false);
    expect(controller.isOpen).toBe(false);
    expect(document.body.style.overflow).toBe('');
    expect(String(warnings[0]?.[0])).toContain('could not begin');
  });

  it('restores the server-rendered open attribute when the session throws, for the same reason a failed showModal() does — the no-JS form must not be deleted by a promotion that did not happen', () => {
    const root = render(`
      <dialog id="d" ${MODAL_ATTRIBUTE} ${OPEN_ON_LOAD_ATTRIBUTE} open tabindex="-1">
        <input id="name" />
      </dialog>
    `);
    const dialog = presentable(root.querySelector('dialog') as HTMLElement);
    const controller = createModalController(dialog);
    const name = root.querySelector<HTMLElement>('#name') as HTMLElement;
    name.focus = () => {
      throw new Error('boom');
    };

    expect(controller.openFrom(null)).toBe(false);
    expect(dialog.hasAttribute('open')).toBe(true);
  });

  it('CLOSES BEFORE IT UNBINDS on destroy(), or focus is moved to the opener while the dialog is still in the top layer — onto a control the visitor can neither see nor use', () => {
    const { controller, dialog, opener } = scene();
    opener.focus();
    controller.openFrom(opener);

    controller.destroy();

    expect(dialog.hasAttribute('open')).toBe(false);
    expect(document.body.style.overflow).toBe('');
    expect(document.activeElement?.id).toBe('opener');
  });

  it('OPENS NOTHING AFTER destroy() AND SAYS SO, so the trigger falls through to its href instead of cancelling a navigation for a dialog that will never appear', () => {
    const { controller, link, dialog } = scene();
    upgradeTrigger(link, controller);
    controller.destroy();

    const event = pointerClick();
    link.dispatchEvent(event);

    expect(controller.openFrom(null)).toBe(false);
    expect(dialog.hasAttribute('open')).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    // The listener is gone, not merely inert: `destroy()` used to have no removal path for
    // it at all, so the link stayed cancelled and the dialog reopened onto a controller that
    // had stopped listening for its own close event.
    expect(link.getAttribute('aria-haspopup')).toBe(null);
  });

  it('stops trapping Tab and stops hit-testing clicks after destroy(), because a removed listener is the only kind that cannot fire', () => {
    const { controller, dialog } = scene();
    controller.openFrom(null);
    controller.destroy();

    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    dialog.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);

    dialog.dispatchEvent(mouse('mousedown', OUTSIDE.x, OUTSIDE.y));
    const click = mouse('click', OUTSIDE.x, OUTSIDE.y);
    dialog.dispatchEvent(click);
    expect(controller.isOpen).toBe(false);
  });

  it('is idempotent on destroy(), which is what a second teardown pass over the same page does', () => {
    const { controller } = scene();
    controller.destroy();
    expect(() => controller.destroy()).not.toThrow();
  });

  it('keeps the page locked while a second modal is still up, so closing one of two open dialogs does not let the page scroll behind the other', () => {
    const { controller } = scene();
    const root = document.body;
    root.insertAdjacentHTML(
      'beforeend',
      `<dialog id="second" ${MODAL_ATTRIBUTE} tabindex="-1"><input id="other" /></dialog>`,
    );
    const second = createModalController(presentable(root.querySelector('#second') as HTMLElement));

    controller.openFrom(null);
    second.openFrom(null);
    controller.close();

    expect(document.body.style.overflow).toBe('hidden');
    second.close();
    expect(document.body.style.overflow).toBe('');
  });
});

describe('initModals on a platform with no modal dialogs', () => {
  /*
   * THE WHOLE PIPELINE'S DEGRADATION, END TO END, ON A REAL DOCUMENT AND WITH NO DOUBLE OF
   * ANY KIND. jsdom is genuinely a platform without modal dialogs, so this is not a
   * simulation of the failure — it IS the failure, and the assertion is that a visitor on
   * such a platform is handed a working page rather than a decorated one.
   */

  it('leaves every trigger an ordinary link when the platform cannot open a modal dialog, which is the entire degradation contract in one assertion', () => {
    const root = render(`
      <a id="t" href="/gear/new" ${TRIGGER_ATTRIBUTE}="add-item">Add item</a>
      <dialog id="add-item" ${MODAL_ATTRIBUTE}><input id="name" /></dialog>
    `);

    expect(initModals(root).size).toBe(0);

    const link = root.querySelector<HTMLElement>('#t') as HTMLElement;
    const event = pointerClick();
    link.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(link.getAttribute('href')).toBe('/gear/new');
    expect(link.getAttribute('aria-haspopup')).toBe(null);
  });

  it('leaves an open-on-load dialog rendered when it cannot promote it, so the form a direct URL visit asked for is still on the page', () => {
    const root = render(`
      <dialog id="add-item" ${MODAL_ATTRIBUTE} ${OPEN_ON_LOAD_ATTRIBUTE} open>
        <input id="name" />
      </dialog>
    `);

    initModals(root);

    const dialog = root.querySelector('dialog') as HTMLDialogElement;
    expect(dialog.hasAttribute('open')).toBe(true);
  });

  it('returns an empty map for a page with no modals on it, which is every page in the product until PK-71 lands and is what the component ships into', () => {
    expect(initModals(render('<main><p>Nothing here.</p></main>')).size).toBe(0);
  });
});

describe('initModals on a platform that can present one', () => {
  /**
   * Everything below was unreachable before the platform double, and the review that asked
   * for it made the point that matters: replacing this function's body with `return []` left
   * all 59 tests green. Nothing covered the three-pass ordering, the id-keyed map, the
   * open-on-load pass or the already-wired guard.
   */
  function page(markup: string): HTMLElement {
    const root = render(markup);
    for (const dialog of root.querySelectorAll('dialog')) presentable(dialog);
    return root;
  }

  it('hands back a controller for each dialog keyed by its id, which is the only supported way a consumer can close its own modal after a save', () => {
    const root = page(`
      <dialog id="add-item" ${MODAL_ATTRIBUTE} tabindex="-1"><input id="a" /></dialog>
      <dialog id="edit-item" ${MODAL_ATTRIBUTE} tabindex="-1"><input id="b" /></dialog>
    `);

    const controllers = initModals(root);

    expect([...controllers.keys()].sort()).toEqual(['add-item', 'edit-item']);
    const add = controllers.get('add-item');
    add?.openFrom(null);
    expect(root.querySelector('#add-item')?.hasAttribute('open')).toBe(true);
    add?.close();
    expect(root.querySelector('#add-item')?.hasAttribute('open')).toBe(false);
  });

  it('ROUTES EACH TRIGGER TO THE DIALOG IT NAMES, so a page with two modals cannot open the wrong one on a click', () => {
    const root = page(`
      <a id="add" href="/gear/new" ${TRIGGER_ATTRIBUTE}="add-item">Add</a>
      <a id="edit" href="/gear/1" ${TRIGGER_ATTRIBUTE}="edit-item">Edit</a>
      <dialog id="add-item" ${MODAL_ATTRIBUTE} tabindex="-1"><input id="a" /></dialog>
      <dialog id="edit-item" ${MODAL_ATTRIBUTE} tabindex="-1"><input id="b" /></dialog>
    `);

    initModals(root);

    const event = pointerClick();
    root.querySelector<HTMLElement>('#edit')?.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(root.querySelector('#edit-item')?.hasAttribute('open')).toBe(true);
    expect(root.querySelector('#add-item')?.hasAttribute('open')).toBe(false);
  });

  it('promotes an open-on-load dialog into a real modal session, so a direct URL visit ends up on the same surface a click would have produced', () => {
    const root = page(`
      <dialog id="add-item" ${MODAL_ATTRIBUTE} ${OPEN_ON_LOAD_ATTRIBUTE} open tabindex="-1">
        <input id="name" />
      </dialog>
    `);

    const controller = initModals(root).get('add-item');

    expect(controller?.isOpen).toBe(true);
    expect(document.body.style.overflow).toBe('hidden');
    expect(document.activeElement?.id).toBe('name');
  });

  it('upgrades the triggers BEFORE it opens anything on load, or the first Tab out of a dialog that opened during this call lands on links that are not yet controls', () => {
    const order: string[] = [];
    const root = page(`
      <a id="t" href="/gear/new" ${TRIGGER_ATTRIBUTE}="add-item">Add</a>
      <dialog id="add-item" ${MODAL_ATTRIBUTE} ${OPEN_ON_LOAD_ATTRIBUTE} open tabindex="-1">
        <input id="name" />
      </dialog>
    `);
    const link = root.querySelector<HTMLElement>('#t') as HTMLElement;
    const dialog = root.querySelector('dialog') as HTMLElement;
    // Both observations are made from the DOM's own point of view: the attribute the trigger
    // pass writes, and the event the open-on-load pass produces.
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.attributeName === 'aria-haspopup') order.push('trigger upgraded');
        if (record.attributeName === 'open' && dialog.hasAttribute('open')) order.push('opened');
      }
    });
    dialog.removeAttribute('open');
    observer.observe(root, { attributes: true, subtree: true });

    initModals(root);
    // MutationObserver callbacks are microtasks; the two attribute writes are recorded in
    // the order they happened whatever order they are delivered in.
    observer.takeRecords().forEach((record) => {
      if (record.attributeName === 'aria-haspopup') order.push('trigger upgraded');
      if (record.attributeName === 'open') order.push('opened');
    });
    observer.disconnect();

    expect(link.getAttribute('aria-haspopup')).toBe('dialog');
    expect(order).toEqual(['trigger upgraded', 'opened']);
  });

  it('does not touch a <dialog> that is not ours, so a consumer page keeps a dialog of its own without acquiring a controller it never asked for', () => {
    // Assertable at last: on a platform with no showModal both rejections looked identical,
    // because `supportsModalDialog` refused the marked and the unmarked alike.
    const root = page('<dialog id="theirs" tabindex="-1"><input id="a" /></dialog>');

    expect(initModals(root).size).toBe(0);
    expect(root.querySelector('#theirs')?.hasAttribute(DIALOG_BOUND_ATTRIBUTE)).toBe(false);
  });

  it('IS ADDITIVE ON A SECOND PASS: the same controller comes back, and a trigger rendered since is upgraded against it', () => {
    const root = page(`
      <dialog id="add-item" ${MODAL_ATTRIBUTE} tabindex="-1"><input id="a" /></dialog>
    `);
    const first = initModals(root).get('add-item');

    // What a hydrated island re-rendering its own container does. The obvious remedy —
    // calling initModals again — used to return an empty array and upgrade nothing, because
    // every dialog already carried the wired marker and was skipped.
    root.insertAdjacentHTML(
      'afterbegin',
      `<a id="late" href="/gear/new" ${TRIGGER_ATTRIBUTE}="add-item">Add</a>`,
    );
    const second = initModals(root).get('add-item');

    expect(second).toBe(first);
    const event = pointerClick();
    root.querySelector<HTMLElement>('#late')?.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(first?.isOpen).toBe(true);
  });

  it('does not re-open an open-on-load dialog the visitor has already closed, which is what a second pass would do if it re-ran that pass', () => {
    const root = page(`
      <dialog id="add-item" ${MODAL_ATTRIBUTE} ${OPEN_ON_LOAD_ATTRIBUTE} open tabindex="-1">
        <input id="name" />
      </dialog>
    `);
    const controller = initModals(root).get('add-item');
    controller?.close();

    initModals(root);

    expect(controller?.isOpen).toBe(false);
    expect(document.body.style.overflow).toBe('');
  });

  it('wires a dialog again after its controller was destroyed, so a teardown does not leave a dead modal on the page forever', () => {
    const root = page(`
      <a id="t" href="/gear/new" ${TRIGGER_ATTRIBUTE}="add-item">Add</a>
      <dialog id="add-item" ${MODAL_ATTRIBUTE} tabindex="-1"><input id="a" /></dialog>
    `);
    const first = initModals(root).get('add-item');
    first?.destroy();

    const second = initModals(root).get('add-item');

    expect(second).not.toBe(first);
    expect(second).toBeDefined();
    const event = pointerClick();
    root.querySelector<HTMLElement>('#t')?.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(second?.isOpen).toBe(true);
  });

  it('SKIPS A DIALOG WITH AN EMPTY id AND SAYS SO, because nothing can name it and — if it also opens on load — nothing can close it either', () => {
    const root = page(`
      <dialog id="" ${MODAL_ATTRIBUTE} ${OPEN_ON_LOAD_ATTRIBUTE} open tabindex="-1">
        <input id="a" />
      </dialog>
    `);

    const controllers = initModals(root);

    expect(controllers.size).toBe(0);
    // The old version wired it, dropped it out of the map (`if (element.id !== '')`) and
    // then opened it anyway: a modal over a scroll-locked page with no handle anywhere.
    expect(document.body.style.overflow).toBe('');
    expect(root.querySelector('dialog')?.hasAttribute(DIALOG_BOUND_ATTRIBUTE)).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0]?.[0])).toContain('no id');
  });

  it('REFUSES THE SECOND OF TWO DIALOGS SHARING AN id, and leaves it unwired so its own triggers stay ordinary links', () => {
    const root = page(`
      <dialog id="add-item" ${MODAL_ATTRIBUTE} tabindex="-1"><input id="first" /></dialog>
      <dialog id="add-item" ${MODAL_ATTRIBUTE} tabindex="-1"><input id="second" /></dialog>
    `);

    const controllers = initModals(root);
    controllers.get('add-item')?.openFrom(null);

    const dialogs = root.querySelectorAll('dialog');
    expect(controllers.size).toBe(1);
    // Map.set used to overwrite silently: the second controller took the key, every trigger
    // opened the wrong dialog, and the first was left wired to nothing.
    expect(dialogs[0].hasAttribute('open')).toBe(true);
    expect(dialogs[1].hasAttribute('open')).toBe(false);
    expect(dialogs[1].hasAttribute(DIALOG_BOUND_ATTRIBUTE)).toBe(false);
    expect(String(warnings[0]?.[0])).toContain('share the id');
  });
});
