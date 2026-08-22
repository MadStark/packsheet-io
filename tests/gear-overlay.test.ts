/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MODAL_ATTRIBUTE, type ModalDialog } from '../src/lib/modal';
import { NEXT_PARAM } from '../src/lib/auth-routes';
import { GEAR_IMPORT_PATH, GEAR_NEW_PATH, GEAR_PATH } from '../src/lib/gear/routes';
import {
  GEAR_ITEM_SAVED_EVENT,
  GEAR_OVERLAY_DIALOG_ID,
  GEAR_OVERLAY_FORM_ID,
  OVERLAY_ACTIONS_ATTRIBUTE,
  OVERLAY_BODY_ATTRIBUTE,
  OVERLAY_CANCEL_ATTRIBUTE,
  OVERLAY_FORM_ATTRIBUTE,
  OVERLAY_HEADING_ATTRIBUTE,
  OVERLAY_NOTICE_ATTRIBUTE,
  OVERLAY_SUBMIT_ATTRIBUTE,
  OVERLAY_TITLE_ATTRIBUTE,
  extractOverlayContent,
  initGearItemOverlay,
  isPlainLeftClick,
  overlayTargetFor,
  prepareInjectedForm,
  savedDetailFrom,
  submissionBody,
  type GearItemSavedDetail,
} from '../src/lib/gear/overlay';

/**
 * `src/lib/gear/overlay.ts` (PK-71), tested the way `tests/modal.test.ts` tests its own
 * shell: jsdom via the pragma above, a `render()` that replaces `document.body` wholesale
 * so no test inherits DOM another left behind, `console.warn` captured rather than
 * silenced, real events dispatched rather than handlers called directly, and — because
 * jsdom's `<dialog>` has no `showModal`/`close` at all — a `presentable()` collaborator
 * double copied from that file's own pattern: it stands in for the PLATFORM (a
 * collaborator), never for anything inside `overlay.ts` itself. Every `it()` below names
 * the defect it guards against, in the description rather than in a comment beside it.
 *
 * `fetch` is the other collaborator this module depends on, and `initGearItemOverlay`'s
 * `options.fetch` exists for exactly this reason — see its own comment. `overlayFetch()`
 * below wraps a handler in a `vi.fn` so a test can both drive what the module receives as
 * a response and assert on what it was called with, without a network anywhere in the
 * suite.
 */

// ---------------------------------------------------------------------------
// Collaborator doubles
// ---------------------------------------------------------------------------

/** Replaces the document body with a brand new one, exactly as `tests/modal.test.ts` does
 *  and for the same reason: no test can pass or fail because of what the one before it
 *  left behind (a leaked scroll lock, a stale `document.activeElement`, a stray dialog). */
function render(html: string): HTMLElement {
  const body = document.createElement('body');
  body.innerHTML = html;
  document.documentElement.replaceChild(body, document.body);
  return document.body;
}

/**
 * THE PLATFORM DOUBLE, copied from `tests/modal.test.ts`'s own `presentable()` rather than
 * reinvented — see that file's header for the line between this and a shim: it stands in
 * for the platform's `<dialog>`, which `initModals`/`createModalController` (this module's
 * collaborator, not this module) needs to accept the element at all. Nothing in
 * `src/lib/gear/overlay.ts` calls `showModal()` or `close()` directly — it only reads the
 * dialog's slots and listens for `close` and `submit` — so this double is exercising the
 * shell underneath, never the module under test.
 */
function presentable(dialog: HTMLElement): ModalDialog {
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
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      toJSON: () => ({}),
    }) as DOMRect;

  return dialog as ModalDialog;
}

/*
 * `console.warn` IS CAPTURED RATHER THAN SILENCED, as in `tests/modal.test.ts`: a missing
 * dialog slot is reported ONLY through it, so a test that only checked the return value
 * would pass for a version that leaves a developer nothing to read.
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

interface FakeResponse {
  readonly ok: boolean;
  readonly redirected: boolean;
  readonly url: string;
  text(): Promise<string>;
}

/** The shape `initGearItemOverlay`'s `options.fetch` needs off a `Response`, and nothing
 *  more — the same four members the ticket asks for. */
function okPage(html: string, overrides: Partial<FakeResponse> = {}): FakeResponse {
  return { ok: true, redirected: false, url: '', text: async () => html, ...overrides };
}

/** Wraps a handler in a `vi.fn` so a test can both script what `fetch` answers and assert
 *  on what it was called with — never a real network call anywhere in this file. */
function overlayFetch(handler: (url: string, init?: RequestInit) => Promise<FakeResponse>) {
  const mock = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init),
  );
  return { mock, fetch: mock as unknown as typeof globalThis.fetch };
}

function click(init: MouseEventInit = {}): MouseEvent {
  return new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init });
}

function submit(): SubmitEvent {
  return new SubmitEvent('submit', { bubbles: true, cancelable: true });
}

function formIn(dialog: Element): HTMLFormElement | null {
  return dialog.querySelector<HTMLFormElement>(`form[${OVERLAY_FORM_ATTRIBUTE}]`);
}

/** jsdom's own default `Location`, read rather than assumed — vitest-environment-jsdom
 *  defaults to `http://localhost:3000/`, not the bare `http://localhost/` a literal in
 *  this file would silently disagree with the moment that default changed. */
const ORIGIN = window.location.origin;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const GEAR_PAGE_TITLE = 'Add gear';

function noticeHtml(message: string): string {
  return `<div class="note note-danger" role="alert" ${OVERLAY_NOTICE_ATTRIBUTE}><p>${message}</p></div>`;
}

/**
 * A realistic stand-in for what `src/pages/gear/new.astro` and `src/pages/gear/[id].astro`
 * answer a GET (or a re-rendered failed POST) with: the page's own `<h1>`, zero or more
 * error banners in document order, and the form `GearItemForm.astro` renders — a few named
 * inputs, a hidden `next`, a submit button and a Cancel link, carrying every attribute
 * `overlay.ts` looks for. `includeDeleteForm` stands in for `[id].astro`'s own separate
 * delete `<form>`, which the real page deliberately renders with NONE of those attributes
 * — see `extractOverlayContent`'s own comment for why that distinction matters.
 */
function gearFormFixture(
  opts: {
    title?: string;
    notices?: readonly string[];
    next?: string;
    includeDeleteForm?: boolean;
  } = {},
): string {
  const { title = GEAR_PAGE_TITLE, notices = [], next, includeDeleteForm = false } = opts;
  return `
    <!doctype html>
    <html>
      <head><title>${title} — Packsheet</title></head>
      <body>
        <h1 ${OVERLAY_TITLE_ATTRIBUTE}>${title}</h1>
        ${notices.map(noticeHtml).join('')}
        <form method="POST" ${OVERLAY_FORM_ATTRIBUTE}>
          ${next === undefined ? '' : `<input type="hidden" name="${NEXT_PARAM}" value="${next}" />`}
          <input id="name" name="name" type="text" value="Tent" />
          <input id="quantity" name="quantity" type="text" value="1" />
          <button type="submit" ${OVERLAY_SUBMIT_ATTRIBUTE}>Save</button>
          <a ${OVERLAY_CANCEL_ATTRIBUTE} href="/gear">Cancel</a>
        </form>
        ${
          includeDeleteForm
            ? `<form method="POST">
                 <input type="hidden" name="intent" value="delete-item" />
                 <button type="submit">Delete</button>
               </form>`
            : ''
        }
      </body>
    </html>
  `;
}

/** The markup `src/layouts/Layout.astro` renders once for the whole site: the dialog with
 *  its heading/body/actions slots, wired to the platform double so `initModals` accepts
 *  it. `bodyHtml` stands in for whatever page happens to be mounted around it. */
function site(bodyHtml = ''): { root: HTMLElement; dialog: ModalDialog } {
  const root = render(`
    ${bodyHtml}
    <dialog id="${GEAR_OVERLAY_DIALOG_ID}" ${MODAL_ATTRIBUTE} tabindex="-1">
      <span ${OVERLAY_HEADING_ATTRIBUTE}>Gear item</span>
      <div ${OVERLAY_BODY_ATTRIBUTE}></div>
      <div ${OVERLAY_ACTIONS_ATTRIBUTE}></div>
    </dialog>
  `);
  const dialog = presentable(root.querySelector('dialog') as HTMLElement);
  return { root, dialog };
}

/** `site()` plus one ordinary gear link, which is the scene almost every wiring test
 *  needs. */
function scene(linkHtml = `<a id="add" href="${GEAR_NEW_PATH}">Add item</a>`) {
  const { root, dialog } = site(linkHtml);
  return { root, dialog, link: root.querySelector<HTMLAnchorElement>('a') as HTMLAnchorElement };
}

/** `scene()`, mounted, and clicked through to an injected form — the starting point for
 *  every test about SUBMITTING it. `handler` sees every fetch this drives, GET and POST
 *  alike, told apart by `init?.method`. */
async function opened(
  handler: (url: string, init?: RequestInit) => Promise<FakeResponse>,
): Promise<{
  dialog: ModalDialog;
  form: HTMLFormElement;
  calls: readonly { readonly url: string; readonly init?: RequestInit }[];
}> {
  const { dialog, link } = scene();
  const calls: { url: string; init?: RequestInit }[] = [];
  const { fetch } = overlayFetch(async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  });
  initGearItemOverlay(document, { fetch });

  link.dispatchEvent(click());
  await vi.waitFor(() => {
    expect(formIn(dialog)).not.toBeNull();
  });

  return { dialog, form: formIn(dialog) as HTMLFormElement, calls };
}

// ---------------------------------------------------------------------------
// overlayTargetFor
// ---------------------------------------------------------------------------

describe('overlayTargetFor', () => {
  const base = 'https://packsheet.io/gear';

  it('matches /gear/new with itemId null, the one URL that names the create form', () => {
    expect(overlayTargetFor(GEAR_NEW_PATH, base)).toEqual({
      url: 'https://packsheet.io/gear/new',
      itemId: null,
    });
  });

  it('matches /gear/{id} with the id, the one URL that names the edit form', () => {
    expect(overlayTargetFor('/gear/abc-123', base)).toEqual({
      url: 'https://packsheet.io/gear/abc-123',
      itemId: 'abc-123',
    });
  });

  it('refuses /gear, /gear/, /gear/import and /gear/1/edit — none of the four is a single-item form a modal can present', () => {
    expect(overlayTargetFor(GEAR_PATH, base)).toBeNull();
    expect(overlayTargetFor(`${GEAR_PATH}/`, base)).toBeNull();
    expect(overlayTargetFor(GEAR_IMPORT_PATH, base)).toBeNull();
    expect(overlayTargetFor(`${GEAR_PATH}/1/edit`, base)).toBeNull();
  });

  it('refuses another origin and mailto:/javascript: hrefs, so a link the page never wrote as same-site cannot be fetched or POSTed to', () => {
    expect(overlayTargetFor('https://evil.example/gear/new', base)).toBeNull();
    expect(overlayTargetFor('mailto:someone@example.com', base)).toBeNull();
    expect(overlayTargetFor('javascript:alert(1)', base)).toBeNull();
  });

  it('drops the fragment, so a #notes anchor is never sent to the server', () => {
    expect(overlayTargetFor('/gear/abc-123?flavour=salty#notes', base)).toEqual({
      url: 'https://packsheet.io/gear/abc-123?flavour=salty',
      itemId: 'abc-123',
    });
  });

  /*
   * THIS ONE WAS WRITTEN AFTER A BROWSER FOUND THE BUG, and it is worth saying what the
   * bug was because the assertion looks like mere tidiness otherwise.
   *
   * The closet links to the form as `/gear/new?next=%2Fgear`. Dropping only the hidden
   * `next` FIELD from the POST body left the parameter sitting in the URL being posted
   * to, and both pages resolve the return path with `gearReturnPathFromFormOrNull(form,
   * url)` — form field first, then FALLING BACK TO THE QUERY STRING. So the server still
   * found `next`, still redirected to `/gear` instead of to the new item, and a save that
   * genuinely happened read back as "this redirect names no gear item": no
   * `packsheet:gear-item-saved` was dispatched and the visitor was bounced to the closet.
   * Every unit test passed throughout. Stripping it here, where the URL is decided once,
   * is what makes the body and the query string agree by construction.
   */
  it('strips next from the URL entirely, so the server redirects to the saved item rather than back to the view the link came from', () => {
    expect(overlayTargetFor('/gear/new?next=%2Fgear%3Fstatus%3Downed', base)).toEqual({
      url: 'https://packsheet.io/gear/new',
      itemId: null,
    });
    expect(overlayTargetFor('/gear/abc-123?next=%2Fgear&flavour=salty', base)).toEqual({
      url: 'https://packsheet.io/gear/abc-123?flavour=salty',
      itemId: 'abc-123',
    });
  });
});

// ---------------------------------------------------------------------------
// isPlainLeftClick
// ---------------------------------------------------------------------------

describe('isPlainLeftClick', () => {
  // THIS IS upgradeTrigger's LIST, VERBATIM (src/lib/modal.ts), and the two lists must
  // never be allowed to drift — a visitor who Cmd-clicks a gear link and Cmd-clicks a
  // data-modal-open trigger elsewhere on the site must get the same behaviour from both.
  it('refuses every modifier key upgradeTrigger also refuses, so Cmd/Ctrl/Shift/Alt-click behave identically on both kinds of trigger', () => {
    for (const modifier of ['metaKey', 'ctrlKey', 'shiftKey', 'altKey'] as const) {
      const event = new MouseEvent('click', { button: 0, [modifier]: true });
      expect(isPlainLeftClick(event)).toBe(false);
    }
  });

  it('refuses a non-primary button, which is how a browser opens a link in a new tab on a middle-click', () => {
    const event = new MouseEvent('click', { button: 1 });
    expect(isPlainLeftClick(event)).toBe(false);
  });

  it('refuses an already-defaultPrevented event, so this cannot resurrect a navigation another handler deliberately stopped', () => {
    const event = new MouseEvent('click', { button: 0, cancelable: true });
    event.preventDefault();
    expect(isPlainLeftClick(event)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extractOverlayContent
// ---------------------------------------------------------------------------

describe('extractOverlayContent', () => {
  it('pulls the title, the notices in document order, and the form out of a fetched page', () => {
    render('');
    const html = gearFormFixture({
      notices: ['Fix the following before saving:', 'A second, unrelated notice'],
    });

    const content = extractOverlayContent(html, document);

    expect(content?.title).toBe(GEAR_PAGE_TITLE);
    expect(content?.notices.map((notice) => notice.textContent?.trim())).toEqual([
      'Fix the following before saving:',
      'A second, unrelated notice',
    ]);
    expect(content?.form.matches(`form[${OVERLAY_FORM_ATTRIBUTE}]`)).toBe(true);
  });

  it('returns null when there is no overlay form — what a session-expired bounce to sign-in, or a deleted items 404, actually look like', () => {
    render('');
    const html = `
      <html>
        <body>
          <h1>Sign in</h1>
          <form method="POST"><input name="email" /></form>
        </body>
      </html>
    `;
    expect(extractOverlayContent(html, document)).toBeNull();
  });

  it('never returns the /gear/{id} delete form, which would let a click on an item name open a form whose only job is deleting it', () => {
    render('');
    const html = gearFormFixture({ includeDeleteForm: true });

    const content = extractOverlayContent(html, document);

    expect(content?.form.hasAttribute(OVERLAY_FORM_ATTRIBUTE)).toBe(true);
    expect(content?.form.querySelector('[name="intent"]')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// prepareInjectedForm
// ---------------------------------------------------------------------------

describe('prepareInjectedForm', () => {
  it('assigns the runtime id, points action at the URL passed in rather than the current page, wires the submit button to the form, and removes the Cancel link', () => {
    render('');
    const content = extractOverlayContent(gearFormFixture(), document);
    if (content === null) throw new Error('fixture unexpectedly had no overlay form');

    const submitControl = prepareInjectedForm(content.form, 'https://packsheet.io/gear/new');

    expect(content.form.id).toBe(GEAR_OVERLAY_FORM_ID);
    expect(content.form.action).toBe('https://packsheet.io/gear/new');
    expect(content.form.querySelector(`[${OVERLAY_CANCEL_ATTRIBUTE}]`)).toBeNull();
    expect(submitControl?.getAttribute('form')).toBe(GEAR_OVERLAY_FORM_ID);
  });

  it('returns null when the form has no submit control, the same dead end the caller treats a missing form as', () => {
    render('');
    const html = `
      <html>
        <body>
          <h1 ${OVERLAY_TITLE_ATTRIBUTE}>Add gear</h1>
          <form method="POST" ${OVERLAY_FORM_ATTRIBUTE}><input name="name" /></form>
        </body>
      </html>
    `;
    const content = extractOverlayContent(html, document);
    if (content === null) throw new Error('fixture unexpectedly had no overlay form');

    expect(prepareInjectedForm(content.form, 'https://packsheet.io/gear/new')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// submissionBody
// ---------------------------------------------------------------------------

describe('submissionBody', () => {
  it('includes the typed fields and a hidden intent field the edit page needs, and drops next so the redirect it draws stays legible', () => {
    render(`
      <form id="f">
        <input name="name" value="Tent" />
        <input name="quantity" value="1" />
        <input type="hidden" name="intent" value="edit-item" />
        <input type="hidden" name="${NEXT_PARAM}" value="/gear?status=owned" />
      </form>
    `);
    const form = document.getElementById('f') as HTMLFormElement;

    const body = submissionBody(form);

    expect(body.get('name')).toBe('Tent');
    expect(body.get('quantity')).toBe('1');
    expect(body.get('intent')).toBe('edit-item');
    expect(body.has(NEXT_PARAM)).toBe(false);
  });

  it('serialises as application/x-www-form-urlencoded, byte for byte what a native submit of this form would have sent', () => {
    render(`
      <form id="f">
        <input name="name" value="Big Agnes Tent" />
        <input name="quantity" value="1" />
      </form>
    `);
    const form = document.getElementById('f') as HTMLFormElement;

    expect(submissionBody(form).toString()).toBe('name=Big+Agnes+Tent&quantity=1');
  });
});

// ---------------------------------------------------------------------------
// savedDetailFrom
// ---------------------------------------------------------------------------

describe('savedDetailFrom', () => {
  const base = 'https://packsheet.io/';

  it('reads the id off /gear/{id} and off /gear/{id}?updated=1, the two redirects a successful save can land on', () => {
    expect(savedDetailFrom('https://packsheet.io/gear/abc-123', base, null)).toEqual({
      id: 'abc-123',
      created: true,
    });
    expect(savedDetailFrom('https://packsheet.io/gear/abc-123?updated=1', base, 'abc-123')).toEqual(
      {
        id: 'abc-123',
        created: false,
      },
    );
  });

  it('reports created true when nothing was requested (a create) and false when an item id was (an edit)', () => {
    expect(savedDetailFrom('https://packsheet.io/gear/new-id', base, null)?.created).toBe(true);
    expect(
      savedDetailFrom('https://packsheet.io/gear/abc-123?updated=1', base, 'abc-123')?.created,
    ).toBe(false);
  });

  it('returns null when the redirect landed on /sign-in even though an item id was requested — an expired session must never be reported as a save', () => {
    expect(
      savedDetailFrom('https://packsheet.io/sign-in?next=%2Fgear%2Fabc-123', base, 'abc-123'),
    ).toBeNull();
  });

  /*
   * FOUND IN AN INDEPENDENT REVIEW, NOT REASONED OUT IN ADVANCE. A session that only
   * BLIPS — expired for the one check the middleware makes, good again by the time
   * sign-in's own redirect is followed — writes NOTHING, and lands back on the exact
   * same `/gear/{id}` shape a genuine edit-success redirect does, because that is what
   * sign-in's `next` names. The two are indistinguishable by path shape alone; `updated`
   * is the one string only `[id].astro`'s write branch emits.
   */
  it('returns null for an edit whose redirect landed on the bare /gear/{id} — indistinguishable from a genuine save by path shape alone, which is exactly what a bounce through /sign-in and back produces on a session that turned out to still be good', () => {
    expect(savedDetailFrom('https://packsheet.io/gear/abc-123', base, 'abc-123')).toBeNull();
  });

  it('still accepts the bare /gear/{id} for a CREATE, whose bounce lands on /gear/new (naming no item) rather than on the created item’s own path, so the ambiguity above does not apply', () => {
    expect(savedDetailFrom('https://packsheet.io/gear/abc-123', base, null)).toEqual({
      id: 'abc-123',
      created: true,
    });
  });
});

// ---------------------------------------------------------------------------
// initGearItemOverlay
// ---------------------------------------------------------------------------

describe('initGearItemOverlay', () => {
  describe('mounting', () => {
    it('returns null, installs nothing, and leaves links working when there is no overlay dialog in the document — the ordinary state before Layout.astro mounts one', () => {
      const root = render(`<a id="add" href="${GEAR_NEW_PATH}">Add item</a>`);
      const { fetch, mock } = overlayFetch(async () => {
        throw new Error('must not fetch');
      });

      const teardown = initGearItemOverlay(document, { fetch });

      expect(teardown).toBeNull();

      const link = root.querySelector<HTMLAnchorElement>('#add') as HTMLAnchorElement;
      const event = click();
      link.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
      expect(mock).not.toHaveBeenCalled();
    });

    it('warns and returns null when the dialog exists but lacks its heading, body or actions slot — a Layout.astro wiring bug that would otherwise open onto nothing', () => {
      const root = render(
        `<dialog id="${GEAR_OVERLAY_DIALOG_ID}" ${MODAL_ATTRIBUTE} tabindex="-1"></dialog>`,
      );
      presentable(root.querySelector('dialog') as HTMLElement);
      const { fetch } = overlayFetch(async () => {
        throw new Error('must not fetch');
      });

      const teardown = initGearItemOverlay(document, { fetch });

      expect(teardown).toBeNull();
      expect(warnings).toHaveLength(1);
      expect(String(warnings[0]?.[0])).toContain(GEAR_OVERLAY_DIALOG_ID);
    });
  });

  describe('opening', () => {
    it('opens the dialog, calls preventDefault(), and injects the fetched form on a plain left click — taking the heading from the fetched pages own <h1>', async () => {
      const { dialog, link } = scene();
      const calls: string[] = [];
      const { fetch } = overlayFetch(async (url) => {
        calls.push(url);
        return okPage(gearFormFixture());
      });
      initGearItemOverlay(document, { fetch });

      const event = click();
      link.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(true);
      expect(dialog.hasAttribute('open')).toBe(true);

      await vi.waitFor(() => {
        expect(formIn(dialog)).not.toBeNull();
      });

      expect(calls).toEqual([`${ORIGIN}/gear/new`]);
      expect(dialog.querySelector(`[${OVERLAY_HEADING_ATTRIBUTE}]`)?.textContent).toBe(
        GEAR_PAGE_TITLE,
      );
    });

    it('does NOT call preventDefault() when the dialog fails to open — the single most important behaviour in this module, since cancelling first turns a working link into a control that does nothing', () => {
      const { dialog, link } = scene();
      (dialog as unknown as { showModal: () => void }).showModal = () => {
        throw new Error('boom');
      };
      const { fetch, mock } = overlayFetch(async () => {
        throw new Error('must not fetch');
      });
      initGearItemOverlay(document, { fetch });

      const event = click();
      link.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(false);
      expect(mock).not.toHaveBeenCalled();
    });

    it('leaves a Cmd/Ctrl-click and a link carrying target alone entirely, both being the browser own open-elsewhere gestures', () => {
      const { root } = site(`
        <a id="plain" href="${GEAR_NEW_PATH}">Add item</a>
        <a id="tabbed" href="${GEAR_NEW_PATH}" target="_blank">Add item</a>
      `);
      const { fetch, mock } = overlayFetch(async () => {
        throw new Error('must not fetch');
      });
      initGearItemOverlay(document, { fetch });

      const cmdClick = click({ metaKey: true });
      root.querySelector<HTMLAnchorElement>('#plain')?.dispatchEvent(cmdClick);
      expect(cmdClick.defaultPrevented).toBe(false);

      const tabbedClick = click();
      root.querySelector<HTMLAnchorElement>('#tabbed')?.dispatchEvent(tabbedClick);
      expect(tabbedClick.defaultPrevented).toBe(false);

      expect(mock).not.toHaveBeenCalled();
    });

    it('closes the dialog rather than leaving it open and empty when the GET throws (a network failure)', async () => {
      const { dialog, link } = scene();
      const { fetch } = overlayFetch(async () => {
        throw new Error('offline');
      });
      initGearItemOverlay(document, { fetch });

      link.dispatchEvent(click());
      expect(dialog.hasAttribute('open')).toBe(true);

      await vi.waitFor(() => {
        expect(dialog.hasAttribute('open')).toBe(false);
      });
    });

    it('closes the dialog rather than leaving it open and empty when the GET answers a non-ok status', async () => {
      const { dialog, link } = scene();
      const { fetch } = overlayFetch(async () => okPage('', { ok: false }));
      initGearItemOverlay(document, { fetch });

      link.dispatchEvent(click());

      await vi.waitFor(() => {
        expect(dialog.hasAttribute('open')).toBe(false);
      });
    });
  });

  describe('submitting', () => {
    it('POSTs the injected form to the fetched pages own URL — never wherever the visitor was — with the right method and content-type', async () => {
      const { form, calls } = await opened(async (_url, init) => {
        if (init?.method === 'POST') {
          return okPage('', { redirected: true, url: `${ORIGIN}/gear/new-item-id` });
        }
        return okPage(gearFormFixture());
      });

      form.dispatchEvent(submit());

      await vi.waitFor(() => {
        expect(calls.filter((call) => call.init?.method === 'POST')).toHaveLength(1);
      });

      const post = calls.find((call) => call.init?.method === 'POST');
      expect(post?.url).toBe(`${ORIGIN}/gear/new`);
      expect((post?.init?.headers as Record<string, string> | undefined)?.['content-type']).toBe(
        'application/x-www-form-urlencoded',
      );
    });

    it('closes the dialog and dispatches exactly one packsheet:gear-item-saved with the right detail after a redirected save — and the dialog is already closed by the time the listener runs', async () => {
      const { dialog, form } = await opened(async (_url, init) => {
        if (init?.method === 'POST') {
          return okPage('', { redirected: true, url: `${ORIGIN}/gear/new-item-id` });
        }
        return okPage(gearFormFixture());
      });

      const events: GearItemSavedDetail[] = [];
      let dialogWasOpenInListener: boolean | null = null;
      document.addEventListener(GEAR_ITEM_SAVED_EVENT, (event) => {
        dialogWasOpenInListener = dialog.hasAttribute('open');
        events.push((event as CustomEvent<GearItemSavedDetail>).detail);
      });

      form.dispatchEvent(submit());

      await vi.waitFor(() => {
        expect(events).toHaveLength(1);
      });

      expect(events[0]).toEqual({ id: 'new-item-id', created: true });
      expect(dialogWasOpenInListener).toBe(false);
      expect(dialog.hasAttribute('open')).toBe(false);
    });

    it('keeps the dialog open, dispatches no event, and swaps in the servers own notices when the save is not redirected — a validation failure', async () => {
      const { dialog, form } = await opened(async (_url, init) => {
        if (init?.method === 'POST') {
          return okPage(gearFormFixture({ notices: ['Fix the following before saving:'] }));
        }
        return okPage(gearFormFixture());
      });

      let eventFired = false;
      document.addEventListener(GEAR_ITEM_SAVED_EVENT, () => {
        eventFired = true;
      });

      form.dispatchEvent(submit());

      await vi.waitFor(() => {
        expect(dialog.querySelector(`[${OVERLAY_NOTICE_ATTRIBUTE}]`)).not.toBeNull();
      });

      expect(dialog.hasAttribute('open')).toBe(true);
      expect(eventFired).toBe(false);
    });

    it('keeps the dialog open with the visitor typed values untouched, dispatches no event, and does not navigate when the POST throws', async () => {
      const { dialog, form } = await opened(async (_url, init) => {
        if (init?.method === 'POST') throw new Error('offline');
        return okPage(gearFormFixture());
      });

      const nameInput = form.querySelector<HTMLInputElement>(
        'input[name="name"]',
      ) as HTMLInputElement;
      nameInput.value = 'Edited before the failed save';

      let eventFired = false;
      document.addEventListener(GEAR_ITEM_SAVED_EVENT, () => {
        eventFired = true;
      });

      form.dispatchEvent(submit());

      await vi.waitFor(() => {
        expect(dialog.querySelector('[role="alert"]')?.textContent).toContain(
          'could not reach the server',
        );
      });

      // Not navigated: closing always happens before a fallback navigation (see
      // fallbackToNavigation's own comment), so a dialog still open is proof none occurred.
      expect(dialog.hasAttribute('open')).toBe(true);
      expect(eventFired).toBe(false);
      expect(nameInput.value).toBe('Edited before the failed save');
    });

    it('reports "the server refused this save" rather than "could not reach the server" when the POST gets back a non-ok, non-redirected answer — the request was received and rejected, not lost', async () => {
      const { dialog, form } = await opened(async (_url, init) => {
        if (init?.method === 'POST') return okPage('', { ok: false });
        return okPage(gearFormFixture());
      });

      form.dispatchEvent(submit());

      await vi.waitFor(() => {
        expect(dialog.querySelector('[role="alert"]')?.textContent).toContain('refused');
      });
      expect(dialog.querySelector('[role="alert"]')?.textContent).not.toContain(
        'could not reach the server',
      );
      expect(dialog.hasAttribute('open')).toBe(true);
    });

    it('POSTs only once when the injected form is submitted twice before the first save resolves', async () => {
      const { dialog, form, calls } = await opened(async (_url, init) => {
        if (init?.method === 'POST') {
          return okPage('', { redirected: true, url: `${ORIGIN}/gear/new-item-id` });
        }
        return okPage(gearFormFixture());
      });

      form.dispatchEvent(submit());
      form.dispatchEvent(submit());

      await vi.waitFor(() => {
        expect(dialog.hasAttribute('open')).toBe(false);
      });

      expect(calls.filter((call) => call.init?.method === 'POST')).toHaveLength(1);
    });

    /*
     * BOTH TESTS BELOW WERE WRITTEN AFTER AN INDEPENDENT REVIEW FOUND THIS RACE, NOT
     * BEFORE — the generation counter's own comment claimed checking it "after every
     * await is the whole guard", and neither of these two spots did. `deferred()` gives
     * a test a POST promise it can resolve on its own schedule, which is what lets it
     * park a save mid-flight, move the dialog on to a second item, and only then let the
     * first one land — the exact shape a slow network plus an impatient visitor produces.
     */
    function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((r) => (resolve = r));
      return { promise, resolve };
    }

    it('does not close the dialog or discard what is in it when a save that belonged to a DIFFERENT, already-abandoned session resolves after the visitor moved on to another item — but still dispatches the event, since the write itself really happened', async () => {
      const { root, dialog } = site(`
        <a id="a" href="${GEAR_PATH}/aaa">Item A</a>
        <a id="b" href="${GEAR_PATH}/bbb">Item B</a>
      `);
      const linkA = root.querySelector('#a') as HTMLAnchorElement;
      const linkB = root.querySelector('#b') as HTMLAnchorElement;

      const postA = deferred<FakeResponse>();
      const { fetch } = overlayFetch(async (url, init) => {
        if (init?.method === 'POST') return postA.promise;
        if (url.includes('/aaa')) return okPage(gearFormFixture({ title: 'Item A' }));
        return okPage(gearFormFixture({ title: 'Item B' }));
      });
      initGearItemOverlay(document, { fetch });

      let received: GearItemSavedDetail | null = null;
      document.addEventListener(GEAR_ITEM_SAVED_EVENT, (event) => {
        received = (event as CustomEvent<GearItemSavedDetail>).detail;
      });

      linkA.dispatchEvent(click());
      await vi.waitFor(() => expect(formIn(dialog)).not.toBeNull());
      (formIn(dialog) as HTMLFormElement).dispatchEvent(submit()); // A's save is now in flight

      dialog.close(); // the visitor dismissed A before it answered
      linkB.dispatchEvent(click());
      await vi.waitFor(() => {
        expect(dialog.querySelector(`[${OVERLAY_HEADING_ATTRIBUTE}]`)?.textContent).toBe('Item B');
      });

      // A's write answers now, long after the visitor moved on to B.
      postA.resolve(okPage('', { redirected: true, url: `${ORIGIN}${GEAR_PATH}/aaa?updated=1` }));

      await vi.waitFor(() => expect(received).not.toBeNull());
      expect(received).toEqual({ id: 'aaa', created: false });

      // B's session is untouched: still open, still showing B, not the placeholder a
      // wrongful `controller.close()` would have reset it to.
      expect(dialog.hasAttribute('open')).toBe(true);
      expect(dialog.querySelector(`[${OVERLAY_HEADING_ATTRIBUTE}]`)?.textContent).toBe('Item B');
      expect(formIn(dialog)).not.toBeNull();
    });

    it('does not navigate the visitor away when a save that belonged to an abandoned session resolves with no receipt (a session bounce) after they moved on to another item', async () => {
      const { root, dialog } = site(`
        <a id="a" href="${GEAR_PATH}/aaa">Item A</a>
        <a id="b" href="${GEAR_PATH}/bbb">Item B</a>
      `);
      const linkA = root.querySelector('#a') as HTMLAnchorElement;
      const linkB = root.querySelector('#b') as HTMLAnchorElement;

      const postA = deferred<FakeResponse>();
      const { fetch } = overlayFetch(async (url, init) => {
        if (init?.method === 'POST') return postA.promise;
        if (url.includes('/aaa')) return okPage(gearFormFixture({ title: 'Item A' }));
        return okPage(gearFormFixture({ title: 'Item B' }));
      });
      initGearItemOverlay(document, { fetch });

      const assign = vi.fn();
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: { ...window.location, assign },
      });

      linkA.dispatchEvent(click());
      await vi.waitFor(() => expect(formIn(dialog)).not.toBeNull());
      (formIn(dialog) as HTMLFormElement).dispatchEvent(submit());

      dialog.close();
      linkB.dispatchEvent(click());
      await vi.waitFor(() => {
        expect(dialog.querySelector(`[${OVERLAY_HEADING_ATTRIBUTE}]`)?.textContent).toBe('Item B');
      });

      // A's session bounced to sign-in and wrote nothing — but the visitor is on B now.
      postA.resolve(okPage('', { redirected: true, url: `${ORIGIN}/sign-in?next=%2Fgear%2Faaa` }));
      await vi.waitFor(() => expect(warnings.length).toBeGreaterThan(0));

      // Not navigated away from whatever they are doing with B, and B is untouched.
      expect(assign).not.toHaveBeenCalled();
      expect(dialog.hasAttribute('open')).toBe(true);
      expect(dialog.querySelector(`[${OVERLAY_HEADING_ATTRIBUTE}]`)?.textContent).toBe('Item B');
    });

    it('does not clear the in-flight guard for a NEWER session when an OLDER, abandoned save finally settles — so a second POST for the item still being saved cannot slip through', async () => {
      const { root, dialog } = site(`
        <a id="a" href="${GEAR_PATH}/aaa">Item A</a>
        <a id="b" href="${GEAR_PATH}/bbb">Item B</a>
      `);
      const linkA = root.querySelector('#a') as HTMLAnchorElement;
      const linkB = root.querySelector('#b') as HTMLAnchorElement;

      const postA = deferred<FakeResponse>();
      const postCalls: string[] = [];
      const { fetch } = overlayFetch(async (url, init) => {
        if (init?.method === 'POST') {
          postCalls.push(url);
          if (url.includes('/aaa')) return postA.promise;
          // B's own save never resolves within this test — what matters is whether a
          // SECOND POST for B is ever attempted, not how the first one would end.
          return new Promise<FakeResponse>(() => {});
        }
        if (url.includes('/aaa')) return okPage(gearFormFixture({ title: 'Item A' }));
        return okPage(gearFormFixture({ title: 'Item B' }));
      });
      initGearItemOverlay(document, { fetch });

      linkA.dispatchEvent(click());
      await vi.waitFor(() => expect(formIn(dialog)).not.toBeNull());
      (formIn(dialog) as HTMLFormElement).dispatchEvent(submit()); // A: submitting = true

      dialog.close(); // onClose resets submitting/injectedSubmit for the session that just ended
      linkB.dispatchEvent(click());
      await vi.waitFor(() => {
        expect(dialog.querySelector(`[${OVERLAY_HEADING_ATTRIBUTE}]`)?.textContent).toBe('Item B');
      });
      const formB = formIn(dialog) as HTMLFormElement;
      formB.dispatchEvent(submit()); // B: submitting = true, B's own POST now outstanding

      expect(postCalls.filter((u) => u.includes('/bbb'))).toHaveLength(1);

      // A's abandoned save finally answers. Without the generation check in the
      // `finally`, this clears `submitting` and re-enables B's (still in flight) button.
      postA.resolve(okPage('', { redirected: true, url: `${ORIGIN}${GEAR_PATH}/aaa?updated=1` }));
      await vi.waitFor(() => expect(dialog.hasAttribute('open')).toBe(true)); // let A's handler run

      formB.dispatchEvent(submit()); // the visitor, or a stray Enter, tries again

      expect(postCalls.filter((u) => u.includes('/bbb'))).toHaveLength(1);
    });
  });

  describe('closing', () => {
    it('empties the dialog body on close, so a second open cannot show the previous items values', async () => {
      const { dialog } = await opened(async () => okPage(gearFormFixture()));

      dialog.close();

      expect(formIn(dialog)).toBeNull();
      expect(dialog.querySelector(`[${OVERLAY_HEADING_ATTRIBUTE}]`)?.textContent).toBe('Gear item');
    });
  });

  describe('teardown', () => {
    it('removes the click listener via the returned teardown, so a torn-down overlay no longer intercepts gear links', () => {
      const { link } = scene();
      const { fetch, mock } = overlayFetch(async () => {
        throw new Error('must not fetch');
      });
      const teardown = initGearItemOverlay(document, { fetch });

      teardown?.();

      const event = click();
      link.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(false);
      expect(mock).not.toHaveBeenCalled();
    });
  });
});
