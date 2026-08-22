/** @vitest-environment jsdom */

import { describe, expect, it } from 'vitest';
import {
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
  type ModalOpener,
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
 * header — "`environment: 'node'` means no `DragEvent`, no `dataTransfer` and no
 * `getBoundingClientRect`, and neither `@vue/test-utils` nor `jsdom` is a dependency to
 * supply them" — and its answer was to factor every decision into a pure function over
 * plain data, which is the right answer when the decisions ARE about plain data.
 *
 * A modal shell is not that. Half of what it does IS the document: focus really moves,
 * `document.body`'s inline style really has to come back exactly as it was, a listener
 * really has to be attached to the element and not to a copy of it, and a click really has
 * to be left uncancelled so a link can navigate. Those are not decisions about data that
 * happen to touch the DOM; the DOM is the thing being decided about. Asserting them against
 * a hand-rolled object would be asserting the hand-rolled object.
 *
 * ---------------------------------------------------------------------------
 * WHAT JSDOM COULD NOT DO, MEASURED RATHER THAN ASSUMED
 * ---------------------------------------------------------------------------
 *
 * jsdom 30's `HTMLDialogElement` is a stub: the `open` attribute reflects, and that is the
 * entire implementation. There is no `showModal()`, no `close()`, no top layer, no
 * `::backdrop`, and therefore no `cancel` and no `close` event. The first `describe` below
 * asserts exactly that, against a real `<dialog>` — so if a future jsdom implements the
 * element, this file fails loudly and tells the next person that a whole class of assertion
 * has become available, rather than quietly continuing to test around a gap that closed.
 *
 * NOTHING HERE IS SHIMMED. There is no `showModal` polyfill in this file, and there must
 * never be one: a shim would turn every assertion below green while testing the shim, which
 * is the single most likely way a first-of-its-kind test environment produces a suite that
 * cannot fail. What is untestable is named as untestable, in the test that gets closest to
 * it.
 *
 * SO THESE ARE NOT TESTED, AND ARE VERIFIED IN A BROWSER: that `showModal()` puts the dialog
 * in the top layer; that ESC produces `cancel` and then `close`; that the platform's own
 * focus containment holds; that `::backdrop` paints; and that the `close` listener
 * `createModalController` installs runs `endModalSession`. What IS tested is everything on
 * either side of those — including `endModalSession` itself, which is the whole of what ESC
 * causes once the platform has announced it.
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

/** Replaces the document body and clears the inline style the scroll lock writes to, so no
 *  test can pass because of what the one before it left behind. */
function render(html: string): HTMLElement {
  document.body.innerHTML = html;
  document.body.removeAttribute('style');
  return document.body;
}

/** A `ModalOpener` that records what it was handed and reports whatever the caller wants it
 *  to. It is a collaborator double, NOT a `<dialog>` shim: it stands in for the controller's
 *  one-method interface so the trigger's own behaviour can be driven, and it is never handed
 *  to anything that would try to present it. */
function recordingOpener(result: boolean) {
  const openedWith: (HTMLElement | null | undefined)[] = [];
  const opener: ModalOpener = {
    open(from) {
      openedWith.push(from);
      return result;
    },
  };
  return { opener, openedWith };
}

/** A left-button click with real coordinates — `detail: 1` is what separates a pointer click
 *  from `element.click()`, and `isBackdropClick` reads it. */
function pointerClick(): MouseEvent {
  return new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, detail: 1 });
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

  it('accepts an object carrying both methods — the branch every real browser takes', () => {
    // A duck fed to the PREDICATE, to prove the predicate reads the two methods it claims to
    // read. It is never handed to createModalController: that would be shimming <dialog>.
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

  it('skips a negative tabindex but keeps tabindex="0", because "programmatically focusable" and "in the tab order" are different sets and only the second one wraps', () => {
    const root = render(`
      <dialog>
        <div id="skip" tabindex="-1">Scroll region</div>
        <div id="keep" tabindex="0">Custom control</div>
      </dialog>
    `);
    expect(focusableWithin(root).map((element) => element.id)).toEqual(['keep']);
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

  it('keeps focus on a lone control in both directions, where a modulo-only wrap would have been right by accident and a naive edge check would return null and let Tab escape', () => {
    expect(tabTrapTarget(1, 0, false)).toBe(0);
    expect(tabTrapTarget(1, 0, true)).toBe(0);
  });

  it('returns null when there is nothing to trap onto, because cancelling the keypress instead would leave a visitor with a Tab key that silently does nothing', () => {
    expect(tabTrapTarget(0, -1, false)).toBe(null);
    expect(tabTrapTarget(0, -1, true)).toBe(null);
  });
});

describe('isBackdropClick', () => {
  const rect = { top: 100, right: 400, bottom: 300, left: 200 } as const;

  it('reports a point outside the sheet on every side, which is the only way to tell a backdrop click from one on the dialog padding — both report the dialog as the event target', () => {
    expect(isBackdropClick(rect, { clientX: 199, clientY: 200, detail: 1 })).toBe(true);
    expect(isBackdropClick(rect, { clientX: 401, clientY: 200, detail: 1 })).toBe(true);
    expect(isBackdropClick(rect, { clientX: 300, clientY: 99, detail: 1 })).toBe(true);
    expect(isBackdropClick(rect, { clientX: 300, clientY: 301, detail: 1 })).toBe(true);
  });

  it('does not report a point inside the sheet, or the visitor loses a half-typed form every time they click their own text field', () => {
    expect(isBackdropClick(rect, { clientX: 300, clientY: 200, detail: 1 })).toBe(false);
  });

  it('treats the boundary as inside, so a click on the sheet edge is not a dismissal', () => {
    expect(isBackdropClick(rect, { clientX: 200, clientY: 100, detail: 1 })).toBe(false);
    expect(isBackdropClick(rect, { clientX: 400, clientY: 300, detail: 1 })).toBe(false);
  });

  it('refuses a keyboard-synthesised click, whose coordinates are 0,0 — otherwise pressing Enter on Save dismisses the dialog instead of submitting the form', () => {
    expect(isBackdropClick(rect, { clientX: 0, clientY: 0, detail: 0 })).toBe(false);
  });

  it('refuses a zero-area rect, because every coordinate is outside one and the unguarded version makes a dialog with no layout yet impossible to click at all', () => {
    const empty = { top: 0, right: 0, bottom: 0, left: 0 } as const;
    expect(isBackdropClick(empty, { clientX: 10, clientY: 10, detail: 1 })).toBe(false);
    expect(isBackdropClick(empty, { clientX: 0, clientY: 0, detail: 1 })).toBe(false);
  });
});

describe('lockScroll', () => {
  it('stops the page scrolling behind the dialog', () => {
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

  it('falls back to the first tabbable control when nothing claims autofocus', () => {
    const root = render('<dialog open><input id="name" /><button id="save">Save</button></dialog>');
    const dialog = root.querySelector<HTMLElement>('dialog');
    expect(focusFirstWithin(dialog as HTMLElement)?.id).toBe('name');
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

  it('unlocks the scroll and returns focus to the opener — the whole of "it closed", and therefore the whole of what ESC causes once the platform has fired cancel and close', () => {
    const { opener, dialog } = scene();
    opener.focus();

    const session = beginModalSession(dialog, opener);
    endModalSession(session);

    expect(document.body.style.overflow).toBe('');
    expect(document.activeElement?.id).toBe('opener');
  });

  it('restores the exact inline overflow the page had, not an empty one, across a full open and close', () => {
    const { opener, dialog } = scene();
    document.body.style.overflow = 'clip';

    endModalSession(beginModalSession(dialog, opener));

    expect(document.body.style.overflow).toBe('clip');
  });

  it('still unlocks the scroll when the opener has gone, so a save that re-renders the trigger cannot leave the page permanently unscrollable', () => {
    const { opener, dialog } = scene();
    const session = beginModalSession(dialog, opener);
    opener.remove();

    endModalSession(session);

    expect(document.body.style.overflow).toBe('');
    // Focus is left where the browser's own post-close behaviour will find it, rather than
    // pushed into a detached tree — an element that has been removed still HAS focus(), and
    // calling it neither throws nor works, so the bug this names is a silent one: focus that
    // reports as restored and is on nothing. (In a browser the dialog leaves the top layer
    // here and focus lands on <body>; jsdom has no top layer, so what is asserted is the
    // narrower and still-load-bearing half.)
    expect(opener.contains(document.activeElement)).toBe(false);
    expect(document.activeElement?.isConnected).toBe(true);
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
    expect(upgradeTrigger(link, opener)).toBe(true);

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

  it('refuses to bind twice, so a second init pass over the same document does not open the dialog twice per click', () => {
    const link = trigger();
    const first = recordingOpener(true);
    const second = recordingOpener(true);

    expect(upgradeTrigger(link, first.opener)).toBe(true);
    expect(upgradeTrigger(link, second.opener)).toBe(false);

    link.dispatchEvent(pointerClick());
    expect(first.openedWith).toHaveLength(1);
    expect(second.openedWith).toHaveLength(0);
  });

  it('ignores a modified click, because Cmd/Ctrl/Shift-click means "open this somewhere else" and a modal cannot honour it on a control that still is a link', () => {
    const link = trigger();
    const { opener, openedWith } = recordingOpener(true);
    upgradeTrigger(link, opener);

    for (const modifier of ['metaKey', 'ctrlKey', 'shiftKey', 'altKey'] as const) {
      const event = new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        button: 0,
        detail: 1,
        [modifier]: true,
      });
      link.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(openedWith).toHaveLength(0);
  });

  it('ignores a middle click, which is open-in-new-tab on every platform that does not use a modifier for it', () => {
    const link = trigger();
    const { opener, openedWith } = recordingOpener(true);
    upgradeTrigger(link, opener);

    const event = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 1,
      detail: 1,
    });
    link.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(openedWith).toHaveLength(0);
  });

  it('ignores a link with a target, whose author has already said the destination belongs somewhere other than this document', () => {
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
      <a id="add" href="/gear/new" data-modal-open="add-item">Add</a>
      <a id="edit" href="/gear/1" data-modal-open="edit-item">Edit</a>
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
    const root = render('<a id="t" href="/gear/new" data-modal-open="typo">Add</a>');

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
      <a href="/gear/1" data-modal-open="edit">Edit</a>
      <a href="/gear/2" data-modal-open="edit">Edit</a>
    `);
    expect(pairModalTriggers(root, new Map([['edit', recordingOpener(true).opener]]))).toBe(2);
  });
});

describe('createModalController', () => {
  function scene() {
    const root = render(`
      <button id="opener">Add item</button>
      <dialog id="d" data-modal tabindex="-1"><input id="name" /></dialog>
    `);
    return {
      opener: root.querySelector<HTMLElement>('#opener') as HTMLElement,
      dialog: root.querySelector('dialog') as HTMLDialogElement,
    };
  }

  /*
   * EVERY ASSERTION IN THIS BLOCK IS ABOUT THE FAILURE PATH, and that is not a gap in the
   * coverage — it is the only path this environment can reach. `open()` here always ends in
   * the `catch`, because jsdom has no `showModal()` to call (see the first describe). The
   * successful path is `beginModalSession` and `endModalSession`, which are tested directly
   * above, plus the three platform lines named in this file's header.
   *
   * The failure path is worth this much attention on its own account. It is what runs on a
   * browser too old for `<dialog>`, and every assertion below names a way that a shell which
   * "tried anyway" would leave the page worse than if it had never loaded.
   */

  it('reports failure rather than throwing when the platform cannot present a dialog, so the trigger that called it can fall through to its own href', () => {
    const { dialog, opener } = scene();
    expect(createModalController(dialog).open(opener)).toBe(false);
  });

  it('leaves the page exactly as it found it after a failed open — no scroll lock and no moved focus, because showModal() is called BEFORE the session begins and not after', () => {
    const { dialog, opener } = scene();
    opener.focus();

    createModalController(dialog).open(opener);

    // The bug this names is one line of ordering: lock the scroll first and a visitor whose
    // browser cannot open the dialog gets a page that cannot be scrolled, with nothing on
    // screen to explain it and no dialog to close.
    expect(document.body.getAttribute('style')).toBe(null);
    expect(document.activeElement?.id).toBe('opener');
  });

  it('never claims to be open after a failed open, so close() and a second click cannot act on a session that does not exist', () => {
    const { dialog, opener } = scene();
    const controller = createModalController(dialog);
    controller.open(opener);
    expect(controller.isOpen).toBe(false);
  });

  it('PUTS THE SERVER-RENDERED open ATTRIBUTE BACK when the promotion fails, or a direct URL visit ends on a blank page because the script deleted the form it could not replace', () => {
    const root = render('<dialog id="d" data-modal open><input id="name" /></dialog>');
    const dialog = root.querySelector('dialog') as HTMLDialogElement;

    expect(createModalController(dialog).open(null)).toBe(false);
    expect(dialog.hasAttribute('open')).toBe(true);
  });

  it('does not invent an open attribute on a dialog the server rendered closed', () => {
    const { dialog } = scene();
    createModalController(dialog).open(null);
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

describe('initModals', () => {
  /*
   * THE WHOLE PIPELINE'S DEGRADATION, END TO END, ON A REAL DOCUMENT. jsdom is genuinely a
   * platform without modal dialogs, so this is not a simulation of the failure — it IS the
   * failure, and the assertion is that a visitor on such a platform is handed a working page
   * rather than a decorated one.
   */

  it('leaves every trigger an ordinary link when the platform cannot open a modal dialog, which is the entire degradation contract in one assertion', () => {
    const root = render(`
      <a id="t" href="/gear/new" data-modal-open="add-item">Add item</a>
      <dialog id="add-item" data-modal><input id="name" /></dialog>
    `);

    expect(initModals(root)).toEqual([]);

    const link = root.querySelector<HTMLElement>('#t') as HTMLElement;
    const event = pointerClick();
    link.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(link.getAttribute('href')).toBe('/gear/new');
    expect(link.getAttribute('aria-haspopup')).toBe(null);
  });

  it('leaves an open-on-load dialog rendered when it cannot promote it, so the form a direct URL visit asked for is still on the page', () => {
    const root = render(`
      <dialog id="add-item" data-modal data-modal-open-on-load open>
        <input id="name" />
      </dialog>
    `);

    initModals(root);

    const dialog = root.querySelector('dialog') as HTMLDialogElement;
    expect(dialog.hasAttribute('open')).toBe(true);
  });

  it('returns an empty list for a page with no modals on it, which is every page in the product until PK-71 lands and is what the component ships into', () => {
    // Note what is NOT asserted here: that a <dialog> WITHOUT `data-modal` is skipped. The
    // selector is scoped to our own marker so a consumer page's own dialog cannot acquire a
    // controller it never asked for, but on this platform an unmarked dialog and a marked one
    // are both refused by `supportsModalDialog` first, so no assertion here could tell the
    // two rejections apart. Browser-verified.
    expect(initModals(render('<main><p>Nothing here.</p></main>'))).toEqual([]);
  });
});
