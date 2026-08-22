/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MODAL_ATTRIBUTE, TRIGGER_ATTRIBUTE } from '../src/lib/modal';
import { parseGearQuery } from '../src/lib/gear/query';
import { PACK_EDITOR_FIELD } from '../src/lib/packs/editor';
import { PACK_CLOSET_PATH } from '../src/lib/packs/routes';
import { CLOSET_LOAD_FAILED_MESSAGE } from '../src/lib/packs/closet-response';
import {
  ADD_CATEGORY_PARAM,
  ADD_TAB_PARAM,
  ADD_TO_PACK_FIELD,
  ADD_TO_PACK_MODAL_ID,
  addToPackHref,
  alsoAddToClosetKey,
  parseAddToPackRequest,
} from '../src/lib/packs/add-to-pack';
import { CUSTOM_PACK_ITEM_FORM_FIELD } from '../src/lib/packs/form';
import { formatWeight } from '../src/lib/units';
import {
  ADD_TO_PACK_CATEGORY_ATTRIBUTE,
  ADD_TO_PACK_CATEGORY_NAME_ATTRIBUTE,
  ADD_TO_PACK_PAGE_ATTRIBUTE,
  ADD_TO_PACK_PART,
  ADD_TO_PACK_PART_ATTRIBUTE,
  ADD_TO_PACK_PATH_ATTRIBUTE,
  ADD_TO_PACK_REMEMBER_ATTRIBUTE,
  ADD_TO_PACK_TAB_ATTRIBUTE,
  ADD_TO_PACK_TOTAL_PAGES_ATTRIBUTE,
  ADD_TO_PACK_USER_ATTRIBUTE,
  ADD_TO_PACK_WEIGHT_SYSTEM_ATTRIBUTE,
  CLOSET_EMPTY_MESSAGE,
  CLOSET_NO_MATCHES_MESSAGE,
  CLOSET_PAGE_PARAM,
  CLOSET_ROW_CLASS,
  CLOSET_ROW_NO_BRAND,
  CLOSET_SEARCH_PARAM,
  acceptsClosetResponse,
  categoryFromTrigger,
  closetCountLabel,
  closetListState,
  closetPageHref,
  closetRequestUrl,
  initAddToPackDialog,
  nextTabIndex,
  pagerState,
  readClosetResponse,
  type AddToPackDialogHandle,
} from '../src/lib/packs/add-to-pack-dialog';

/**
 * `src/lib/packs/add-to-pack-dialog.ts` (PK-74) — the browser half of the add-to-pack dialog.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE IS jsdom AND WHAT IT DOES NOT NEED
 * ---------------------------------------------------------------------------
 *
 * The second jsdom file in this repository, after `tests/modal.test.ts`, and it earns the
 * environment the same way that one argues for: half of what this module does IS the
 * document. A capturing listener really has to run before a target-phase one, a `hidden`
 * panel's fields really have to stop being part of a form's submission, and a rendered row
 * really has to carry the same classes the server-rendered one does. Asserting any of those
 * against a hand-rolled object would be asserting the hand-rolled object.
 *
 * WHAT IT DOES NOT NEED IS `tests/modal.test.ts`'s `presentable()` PLATFORM DOUBLE, and the
 * reason is worth stating because it is a property of this module rather than an omission
 * here: nothing below ever opens, closes or presents the dialog. `Modal.astro`'s own script
 * owns all of that, and this module deliberately holds no `ModalController` — it only ever
 * rewrites the contents of a `<dialog>` element, which jsdom models completely. jsdom's
 * `HTMLDialogElement` being a stub (no `showModal`, no top layer, no `::backdrop`) therefore
 * costs this file nothing.
 *
 * ---------------------------------------------------------------------------
 * THE FIXTURE IS BUILT OUT OF THE EXPORTED CONSTANTS, NOT TYPED AS LITERALS
 * ---------------------------------------------------------------------------
 *
 * `markup()` below writes every `data-` attribute by interpolating the constant the module
 * itself queries with, so this file cannot drift from the module. What it COULD drift from is
 * `src/components/AddToPackDialog.astro`, which is the real markup — and that is exactly what
 * `tests/add-to-pack-dialog-component.test.ts` is for: it renders the component and asserts
 * its markup against those same constants. The two files meet at the constants, which is the
 * only join either of them can hold.
 *
 * ---------------------------------------------------------------------------
 * ABOUT THE "Not implemented: navigation to another Document" LINES THIS RUN PRINTS
 * ---------------------------------------------------------------------------
 *
 * Not a failure, and not noise to be silenced — the same situation `tests/modal.test.ts`
 * documents. Several tests below dispatch a real click on a real `<a href="/packs/…">` and
 * assert that nothing cancelled it; jsdom then reaches the anchor's default action, has no
 * navigation to perform, and says so. The message is the assertion restated by the
 * environment: the link really did stay a link.
 *
 * Same care as `tests/gear-form.test.ts` and `tests/modal.test.ts`: every assertion names the
 * bug it would catch, not merely what the code does.
 */

const PACK_PATH = '/packs/11111111-1111-4111-8111-111111111111';
const FIRST_CATEGORY = { id: 'cat-shelter', name: 'Shelter' };
const OTHER_CATEGORY = { id: 'cat-cooking', name: 'Cooking' };
const USER_ID = 'user-1';

const ROWS = [
  { id: 'gear-1', name: 'Stakes', brand: 'MSR', weightGrams: 56 },
  { id: 'gear-2', name: 'Groundsheet', brand: null, weightGrams: 120 },
];

const part = (name: string): string => `${ADD_TO_PACK_PART_ATTRIBUTE}="${name}"`;

interface MarkupOptions {
  readonly page?: number;
  readonly totalPages?: number;
  readonly search?: string;
  readonly remember?: boolean;
}

/** The dialog as `src/components/AddToPackDialog.astro` renders it, reduced to the parts this
 *  module touches. Every attribute is interpolated from the module's own exports. */
function markup(options: MarkupOptions = {}): string {
  const { page = 1, totalPages = 2, search = '', remember = true } = options;
  const rows = ROWS.map(
    (row) => `
      <li>
        <label class="${CLOSET_ROW_CLASS.label}">
          <input type="checkbox" name="${PACK_EDITOR_FIELD.gearItemId}" value="${row.id}"
                 class="${CLOSET_ROW_CLASS.checkbox}">
          <span class="${CLOSET_ROW_CLASS.name}">${row.name}</span>
          <span class="${CLOSET_ROW_CLASS.brand}">${row.brand ?? CLOSET_ROW_NO_BRAND}</span>
          <span class="${CLOSET_ROW_CLASS.weight}">${formatWeight(row.weightGrams, 'metric')}</span>
        </label>
      </li>`,
  ).join('');

  return `
    <a id="trigger-other"
       href="${addToPackHref(PACK_PATH, OTHER_CATEGORY.id)}"
       ${TRIGGER_ATTRIBUTE}="${ADD_TO_PACK_MODAL_ID}"
       ${ADD_TO_PACK_CATEGORY_ATTRIBUTE}="${OTHER_CATEGORY.id}"
       ${ADD_TO_PACK_CATEGORY_NAME_ATTRIBUTE}="${OTHER_CATEGORY.name}">Add item</a>
    <a id="plain-link" href="/packs">Back</a>

    <dialog id="${ADD_TO_PACK_MODAL_ID}" ${MODAL_ATTRIBUTE}>
      <h2 id="${ADD_TO_PACK_MODAL_ID}-title">
        Add to <span ${part(ADD_TO_PACK_PART.categoryName)}>${FIRST_CATEGORY.name}</span>
      </h2>
      <div ${part(ADD_TO_PACK_PART.root)}
           ${ADD_TO_PACK_PATH_ATTRIBUTE}="${PACK_PATH}"
           ${ADD_TO_PACK_USER_ATTRIBUTE}="${USER_ID}"
           ${ADD_TO_PACK_WEIGHT_SYSTEM_ATTRIBUTE}="metric"
           ${ADD_TO_PACK_PAGE_ATTRIBUTE}="${page}"
           ${ADD_TO_PACK_TOTAL_PAGES_ATTRIBUTE}="${totalPages}">
        <div role="tablist" aria-label="Where this item comes from">
          <a id="tab-closet" href="${addToPackHref(PACK_PATH, FIRST_CATEGORY.id, 'closet')}"
             role="tab" aria-selected="true" aria-controls="panel-closet" tabindex="0"
             ${part(ADD_TO_PACK_PART.tab)} ${ADD_TO_PACK_TAB_ATTRIBUTE}="closet">From closet</a>
          <a id="tab-new" href="${addToPackHref(PACK_PATH, FIRST_CATEGORY.id, 'new')}"
             role="tab" aria-selected="false" aria-controls="panel-new" tabindex="-1"
             ${part(ADD_TO_PACK_PART.tab)} ${ADD_TO_PACK_TAB_ATTRIBUTE}="new">New item</a>
        </div>

        <div id="panel-closet" role="tabpanel" aria-labelledby="tab-closet"
             ${part(ADD_TO_PACK_PART.panel)} ${ADD_TO_PACK_TAB_ATTRIBUTE}="closet">
          <p role="status" ${part(ADD_TO_PACK_PART.status)} hidden></p>
          <form method="GET" action="${PACK_PATH}" ${part(ADD_TO_PACK_PART.searchForm)}>
            <input type="hidden" name="${ADD_CATEGORY_PARAM}" value="${FIRST_CATEGORY.id}"
                   ${part(ADD_TO_PACK_PART.categoryInput)}>
            <input type="hidden" name="${ADD_TAB_PARAM}" value="closet">
            <input name="${CLOSET_SEARCH_PARAM}" type="search" value="${search}"
                   ${part(ADD_TO_PACK_PART.searchInput)}>
            <button type="submit">Search</button>
          </form>
          <p ${part(ADD_TO_PACK_PART.empty)} hidden>${CLOSET_EMPTY_MESSAGE}</p>
          <form method="POST" ${part(ADD_TO_PACK_PART.listForm)}>
            <input type="hidden" name="intent" value="add-gear">
            <input type="hidden" name="${PACK_EDITOR_FIELD.categoryId}" value="${FIRST_CATEGORY.id}"
                   ${part(ADD_TO_PACK_PART.categoryInput)}>
            <fieldset>
              <ul ${part(ADD_TO_PACK_PART.list)}>${rows}</ul>
            </fieldset>
            <button type="submit">Add selected</button>
          </form>
          <nav aria-label="Closet pages" ${part(ADD_TO_PACK_PART.pager)}>
            <a href="${closetPageHref(PACK_PATH, FIRST_CATEGORY.id, search, Math.max(1, page - 1))}"
               ${part(ADD_TO_PACK_PART.pagePrevious)} ${ADD_TO_PACK_PAGE_ATTRIBUTE}="${Math.max(1, page - 1)}"
               ${page > 1 ? '' : 'hidden'}>Previous</a>
            <p ${part(ADD_TO_PACK_PART.pagerLabel)}>Page ${page} of ${totalPages}</p>
            <a href="${closetPageHref(PACK_PATH, FIRST_CATEGORY.id, search, Math.min(totalPages, page + 1))}"
               ${part(ADD_TO_PACK_PART.pageNext)} ${ADD_TO_PACK_PAGE_ATTRIBUTE}="${Math.min(totalPages, page + 1)}"
               ${page < totalPages ? '' : 'hidden'}>Next</a>
          </nav>
          <p ${part(ADD_TO_PACK_PART.count)}>${closetCountLabel(2, search)}</p>
        </div>

        <div id="panel-new" role="tabpanel" aria-labelledby="tab-new"
             ${part(ADD_TO_PACK_PART.panel)} ${ADD_TO_PACK_TAB_ATTRIBUTE}="new" hidden>
          <form method="POST" id="new-item-form">
            <input type="hidden" name="intent" value="add-custom-item">
            <input type="hidden" name="${PACK_EDITOR_FIELD.categoryId}" value="${FIRST_CATEGORY.id}"
                   ${part(ADD_TO_PACK_PART.categoryInput)}>
            <input name="${CUSTOM_PACK_ITEM_FORM_FIELD.name}" value="Tarp">
            <label>
              <input type="checkbox" name="${ADD_TO_PACK_FIELD.alsoAddToCloset}" value="on"
                     ${part(ADD_TO_PACK_PART.toggle)} ${remember ? ADD_TO_PACK_REMEMBER_ATTRIBUTE : ''}>
              Also add to closet
            </label>
            <button type="submit">Save</button>
          </form>
        </div>
      </div>
    </dialog>`;
}

/**
 * Replaces the document body with a BRAND NEW ONE, so no test can pass or fail because of
 * what the one before it left behind — the same swap `tests/modal.test.ts` makes, and for the
 * same reason: it also resets `document.activeElement` to a body nothing has focused into.
 */
function render(html: string): HTMLElement {
  const body = document.createElement('body');
  body.innerHTML = html;
  document.documentElement.replaceChild(body, document.body);
  return document.body;
}

/*
 * `console.warn` IS CAPTURED RATHER THAN SILENCED. This module is deliberately quiet — it has
 * no warning of its own, because everything it might complain about (a missing part, a dialog
 * that is not there) is a case where the un-upgraded markup still works. Capturing is what
 * makes an unexpected warning from anything it calls worth looking at, and keeps a passing run
 * silent.
 */
let warnings: unknown[][] = [];

/** Every handle a test opened, torn down after it. The document-level capture listener
 *  outlives a body swap, so a handle left running would keep rewriting the NEXT test's inputs
 *  — which shows up as an unrelated assertion failing two tests later. */
let handles: AddToPackDialogHandle[] = [];

function start(options: Parameters<typeof initAddToPackDialog>[1] = {}): AddToPackDialogHandle {
  const handle = initAddToPackDialog(document, { debounceMs: 0, storage: null, ...options });
  if (handle === null) throw new Error('the fixture did not produce a dialog');
  handles.push(handle);
  return handle;
}

beforeEach(() => {
  warnings = [];
  handles = [];
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warnings.push(args);
  });
});

afterEach(() => {
  for (const handle of handles) handle.destroy();
  handles = [];
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

interface FakeResponseInit {
  readonly status?: number;
  readonly redirected?: boolean;
}

function fakeResponse(body: unknown, init: FakeResponseInit = {}): Response {
  return {
    status: init.status ?? 200,
    redirected: init.redirected ?? false,
    json: async () => {
      if (body === undefined) throw new SyntaxError('Unexpected token < in JSON');
      return body;
    },
  } as unknown as Response;
}

/**
 * A `fetch` that hands back a promise per call and lets the test resolve them IN ANY ORDER.
 *
 * IT IGNORES ITS ABORT SIGNAL, DELIBERATELY. That is the whole point: `AbortController` is
 * best effort, and a response already on the wire when a newer request starts still arrives.
 * A double that honoured the signal would make the out-of-order test pass against a module
 * with no ordering guard at all.
 */
function deferredFetch() {
  const urls: string[] = [];
  const settle: ((body: unknown, init?: FakeResponseInit) => void)[] = [];
  const reject: ((error: unknown) => void)[] = [];

  const fetchImpl = ((input: RequestInfo | URL) => {
    urls.push(String(input));
    return new Promise<Response>((resolve, rejectPromise) => {
      settle.push((body, init) => {
        resolve(fakeResponse(body, init));
      });
      reject.push(rejectPromise);
    });
  }) as unknown as typeof fetch;

  return { fetchImpl, urls, settle, reject };
}

/** One real macrotask, which is long enough for a settled fetch promise and the `.json()`
 *  microtask behind it to have been read and written to the document. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function memoryStorage(): Storage {
  const entries = new Map<string, string>();
  return {
    get length() {
      return entries.size;
    },
    clear: () => entries.clear(),
    getItem: (key: string) => entries.get(key) ?? null,
    key: (index: number) => [...entries.keys()][index] ?? null,
    removeItem: (key: string) => {
      entries.delete(key);
    },
    setItem: (key: string, value: string) => {
      entries.set(key, value);
    },
  } as Storage;
}

/** Safari private mode and "block all cookies": every call throws, including the READ. */
function throwingStorage(): Storage {
  const boom = (): never => {
    throw new Error('SecurityError: the operation is insecure');
  };
  return {
    get length(): number {
      return boom();
    },
    clear: boom,
    getItem: boom,
    key: boom,
    removeItem: boom,
    setItem: boom,
  } as unknown as Storage;
}

// ---------------------------------------------------------------------------
// Element lookups
// ---------------------------------------------------------------------------

const find = (name: string): HTMLElement => {
  const element = document.querySelector(`[${part(name)}]`);
  if (!(element instanceof HTMLElement)) throw new Error(`no ${name} in the fixture`);
  return element;
};

const findAll = (name: string): HTMLElement[] =>
  [...document.querySelectorAll(`[${part(name)}]`)].filter(
    (element): element is HTMLElement => element instanceof HTMLElement,
  );

const panelFor = (tab: string): HTMLElement => {
  const panel = findAll(ADD_TO_PACK_PART.panel).find(
    (element) => element.getAttribute(ADD_TO_PACK_TAB_ATTRIBUTE) === tab,
  );
  if (panel === undefined) throw new Error(`no ${tab} panel`);
  return panel;
};

const tabFor = (tab: string): HTMLElement => {
  const found = findAll(ADD_TO_PACK_PART.tab).find(
    (element) => element.getAttribute(ADD_TO_PACK_TAB_ATTRIBUTE) === tab,
  );
  if (found === undefined) throw new Error(`no ${tab} tab`);
  return found;
};

function click(element: Element, init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent('click', {
    bubbles: true,
    cancelable: true,
    button: 0,
    detail: 1,
    ...init,
  });
  element.dispatchEvent(event);
  return event;
}

function submit(form: HTMLElement): Event {
  const event = new Event('submit', { bubbles: true, cancelable: true });
  form.dispatchEvent(event);
  return event;
}

const closetPage = (items: typeof ROWS, page = 1, totalPages = 1, totalCount = items.length) => ({
  ok: true,
  items,
  page,
  totalPages,
  totalCount,
});

// ===========================================================================
// The pure decisions
// ===========================================================================

describe('closetRequestUrl', () => {
  it('OMITS ITS DEFAULTS, so the URL the script fetches is the one the no-script GET form navigates to and the two cannot answer differently', () => {
    expect(closetRequestUrl('', 1)).toBe(PACK_CLOSET_PATH);
    expect(closetRequestUrl('tent', 1)).toBe(`${PACK_CLOSET_PATH}?${CLOSET_SEARCH_PARAM}=tent`);
    expect(closetRequestUrl('', 3)).toBe(`${PACK_CLOSET_PATH}?${CLOSET_PAGE_PARAM}=3`);
  });

  it('IS READ BACK BY THE ENDPOINT’S OWN PARSER, which is what pins `q` and `page` rather than trusting two hand-written strings to stay in step', () => {
    // `src/lib/gear/query.ts` does not export its parameter names, so this round trip is the
    // only join available: rename them there and this fails here, instead of shipping a
    // dialog whose every search is silently ignored.
    const url = new URL(closetRequestUrl('down quilt', 4), 'https://packsheet.test');
    const query = parseGearQuery(url.searchParams);

    expect(query.search).toBe('down quilt');
    expect(query.page).toBe(4);
  });

  it('percent-encodes a search rather than pasting it into a string, so an ampersand is one search and not two parameters', () => {
    const url = new URL(closetRequestUrl('cook & eat', 1), 'https://packsheet.test');

    expect(parseGearQuery(url.searchParams).search).toBe('cook & eat');
  });
});

describe('closetPageHref', () => {
  it('is a REAL URL on the pack page that reopens the same dialog on the same category, because with no script this link is the only way to page', () => {
    const href = closetPageHref(PACK_PATH, FIRST_CATEGORY.id, 'tent', 3);
    const url = new URL(href, 'https://packsheet.test');

    expect(url.pathname).toBe(PACK_PATH);
    const request = parseAddToPackRequest(url.searchParams, [FIRST_CATEGORY.id], 10);
    expect(request.categoryId).toBe(FIRST_CATEGORY.id);
    expect(request.tab).toBe('closet');
    expect(parseGearQuery(url.searchParams).search).toBe('tent');
    expect(parseGearQuery(url.searchParams).page).toBe(3);
  });

  it('drops page 1 and an empty search, so the first page’s link is not a differently-spelled version of the same page', () => {
    expect(closetPageHref(PACK_PATH, FIRST_CATEGORY.id, '', 1)).toBe(
      `${PACK_PATH}?${ADD_CATEGORY_PARAM}=${FIRST_CATEGORY.id}&${ADD_TAB_PARAM}=closet`,
    );
  });
});

describe('closetListState', () => {
  it('SAYS TWO DIFFERENT THINGS, because "your closet is empty" is a fact about the account and "nothing matched" is a fact about the search box', () => {
    expect(closetListState(0, '').emptyMessage).toBe(CLOSET_EMPTY_MESSAGE);
    expect(closetListState(0, 'tnet').emptyMessage).toBe(CLOSET_NO_MATCHES_MESSAGE);
    expect(CLOSET_EMPTY_MESSAGE).not.toBe(CLOSET_NO_MATCHES_MESSAGE);
  });

  it('points an empty closet at the tab that can actually resolve it, by name rather than by a repeated string literal', () => {
    expect(CLOSET_EMPTY_MESSAGE).toContain('New item');
  });

  it('reports rows as rows', () => {
    expect(closetListState(2, '').hasItems).toBe(true);
    expect(closetListState(0, '').hasItems).toBe(false);
  });
});

describe('closetCountLabel', () => {
  it('spells the singular out rather than shipping "1 item(s)"', () => {
    expect(closetCountLabel(1, '')).toBe('1 item in your closet.');
    expect(closetCountLabel(2, '')).toBe('2 items in your closet.');
    expect(closetCountLabel(0, '')).toBe('0 items in your closet.');
  });

  it('describes a filtered count as a match rather than as the size of the closet, which is what stops the line contradicting the list under it', () => {
    expect(closetCountLabel(3, 'tent')).toBe('3 items match that search.');
  });
});

describe('pagerState', () => {
  it('hides itself on a single page, so a one-page closet has no pager at all rather than one with both links dead', () => {
    expect(pagerState(1, 1)).toEqual({
      visible: false,
      previous: null,
      next: null,
      label: 'Page 1 of 1',
    });
  });

  it('drops the link at each end, so neither points off the end of the list', () => {
    expect(pagerState(1, 3).previous).toBeNull();
    expect(pagerState(1, 3).next).toBe(2);
    expect(pagerState(3, 3).previous).toBe(2);
    expect(pagerState(3, 3).next).toBeNull();
  });

  it('names the page it was HANDED, not the page that was asked for — loadGearCloset clamps an over-range page to the last real one and the pager has to say so', () => {
    expect(pagerState(5, 5).label).toBe('Page 5 of 5');
  });
});

describe('nextTabIndex', () => {
  it('wraps at both ends, so the strip never dead-ends on an arrow key', () => {
    expect(nextTabIndex(0, 'ArrowLeft', 2)).toBe(1);
    expect(nextTabIndex(1, 'ArrowRight', 2)).toBe(0);
  });

  it('moves one step in each direction', () => {
    expect(nextTabIndex(0, 'ArrowRight', 2)).toBe(1);
    expect(nextTabIndex(1, 'ArrowLeft', 2)).toBe(0);
  });

  it('takes Home and End to the ends', () => {
    expect(nextTabIndex(1, 'Home', 2)).toBe(0);
    expect(nextTabIndex(0, 'End', 2)).toBe(1);
  });

  it('REFUSES EVERY OTHER KEY, so Tab, Enter and a typed character are left to the browser instead of being swallowed by a handler that called preventDefault first', () => {
    expect(nextTabIndex(0, 'Tab', 2)).toBeNull();
    expect(nextTabIndex(0, 'Enter', 2)).toBeNull();
    expect(nextTabIndex(0, 'a', 2)).toBeNull();
  });

  it('answers null for an empty strip rather than a negative index nothing can look up', () => {
    expect(nextTabIndex(0, 'ArrowRight', 0)).toBeNull();
  });
});

describe('acceptsClosetResponse', () => {
  it('accepts only the response for the request still being waited on', () => {
    expect(acceptsClosetResponse(4, 4)).toBe(true);
    expect(acceptsClosetResponse(3, 4)).toBe(false);
  });
});

describe('readClosetResponse', () => {
  it('reads a page of the closet', () => {
    const outcome = readClosetResponse(200, false, closetPage(ROWS, 2, 5, 210));

    expect(outcome.kind).toBe('page');
    if (outcome.kind !== 'page') throw new Error('unreachable');
    expect(outcome.payload.items).toHaveLength(2);
    expect(outcome.payload.page).toBe(2);
    expect(outcome.payload.totalPages).toBe(5);
  });

  it('prefers the SERVER’S OWN sentence for a failure, which closet-response.ts guarantees is neutral and never a PostgREST string', () => {
    const outcome = readClosetResponse(500, false, {
      ok: false,
      message: CLOSET_LOAD_FAILED_MESSAGE,
    });

    expect(outcome).toEqual({ kind: 'failed', message: CLOSET_LOAD_FAILED_MESSAGE });
  });

  it('TREATS A FOLLOWED REDIRECT AS A FAILURE, because a signed-out fetch lands on the sign-in page with a 200 and reporting that as an empty closet is the silent-empty-list bug', () => {
    const outcome = readClosetResponse(200, true, closetPage([], 1, 1, 0));

    expect(outcome).toEqual({ kind: 'failed', message: CLOSET_LOAD_FAILED_MESSAGE });
  });

  it('never throws on a body it did not write — a proxy’s error page, a parse failure, a truncated payload — because an exception in an event handler is a dialog that silently stops responding', () => {
    expect(readClosetResponse(502, false, null).kind).toBe('failed');
    expect(readClosetResponse(200, false, 'not json at all').kind).toBe('failed');
    expect(readClosetResponse(200, false, { ok: true }).kind).toBe('failed');
    expect(readClosetResponse(200, false, { ok: true, items: 'nope' }).kind).toBe('failed');
    expect(readClosetResponse(200, false, { ok: true, items: [{ id: 1 }] }).kind).toBe('failed');
    expect(
      readClosetResponse(200, false, { ok: true, items: [], page: 'one', totalPages: 1 }).kind,
    ).toBe('failed');
  });

  it('refuses a success body that arrived with a failure status, rather than rendering rows the server said it could not stand behind', () => {
    expect(readClosetResponse(500, false, closetPage(ROWS)).kind).toBe('failed');
  });
});

describe('categoryFromTrigger', () => {
  it('REQUIRES BOTH ATTRIBUTES, because a trigger with an id and no name would blank the heading — which is also the dialog’s accessible name', () => {
    render(markup());

    expect(categoryFromTrigger(document.getElementById('trigger-other'))).toEqual({
      id: OTHER_CATEGORY.id,
      name: OTHER_CATEGORY.name,
    });
    expect(categoryFromTrigger(document.getElementById('plain-link'))).toBeNull();
    expect(categoryFromTrigger(null)).toBeNull();
  });
});

// ===========================================================================
// The DOM
// ===========================================================================

describe('initAddToPackDialog', () => {
  it('does nothing at all on a page with no dialog, which is every page that is not a pack page and every pack with no categories', () => {
    render('<p>no dialog here</p>');

    expect(initAddToPackDialog(document)).toBeNull();
    expect(warnings).toEqual([]);
  });
});

describe('the category the dialog is acting on', () => {
  it('REWRITES THE HEADING AND EVERY HIDDEN INPUT BEFORE THE DIALOG OPENS, or one dialog serving every category files the item under the last one', () => {
    render(markup());
    start();

    const seenDuringTargetPhase: string[] = [];
    const trigger = document.getElementById('trigger-other') as HTMLAnchorElement;
    // A target-phase listener stands in for `upgradeTrigger`'s own, which is where the dialog
    // is actually presented. What it reads is what the visitor would see in the first frame.
    trigger.addEventListener('click', () => {
      seenDuringTargetPhase.push(find(ADD_TO_PACK_PART.categoryName).textContent ?? '');
      for (const input of findAll(ADD_TO_PACK_PART.categoryInput)) {
        seenDuringTargetPhase.push((input as HTMLInputElement).value);
      }
    });

    click(trigger);

    expect(seenDuringTargetPhase).toEqual([
      OTHER_CATEGORY.name,
      OTHER_CATEGORY.id,
      OTHER_CATEGORY.id,
      OTHER_CATEGORY.id,
    ]);
  });

  it('rewrites all three forms, not just the one that happens to be showing — the new-item form is in a hidden panel and is exactly the one that would be missed', () => {
    render(markup());
    start();

    click(document.getElementById('trigger-other') as HTMLAnchorElement);

    const inputs = findAll(ADD_TO_PACK_PART.categoryInput) as HTMLInputElement[];
    expect(inputs).toHaveLength(3);
    expect(inputs.every((input) => input.value === OTHER_CATEGORY.id)).toBe(true);
    // Including the one inside the panel nobody can see.
    expect(
      (
        panelFor('new').querySelector(
          `[${part(ADD_TO_PACK_PART.categoryInput)}]`,
        ) as HTMLInputElement
      ).value,
    ).toBe(OTHER_CATEGORY.id);
  });

  it('re-aims the tab links and the pager at the new category, so a cmd-click on a tab does not open the dialog on the category it is no longer showing', () => {
    render(markup({ page: 2, totalPages: 3 }));
    start();

    click(document.getElementById('trigger-other') as HTMLAnchorElement);

    expect(tabFor('closet').getAttribute('href')).toBe(
      addToPackHref(PACK_PATH, OTHER_CATEGORY.id, 'closet'),
    );
    expect(tabFor('new').getAttribute('href')).toBe(
      addToPackHref(PACK_PATH, OTHER_CATEGORY.id, 'new'),
    );
    expect(find(ADD_TO_PACK_PART.pageNext).getAttribute('href')).toBe(
      closetPageHref(PACK_PATH, OTHER_CATEGORY.id, '', 3),
    );
  });

  it('NEVER CANCELS THE CLICK, because upgradeTrigger refuses an already-prevented event and cancelling here would switch the modal off and leave a bare navigation', () => {
    render(markup());
    start();

    const event = click(document.getElementById('trigger-other') as HTMLAnchorElement);

    expect(event.defaultPrevented).toBe(false);
  });

  it('leaves a modified click alone, because no dialog is about to appear and rewriting it for a category it is not showing is a change nobody asked for', () => {
    render(markup());
    start();

    click(document.getElementById('trigger-other') as HTMLAnchorElement, { metaKey: true });

    expect(find(ADD_TO_PACK_PART.categoryName).textContent).toBe(FIRST_CATEGORY.name);
  });

  it('ignores a link that is not one of its triggers, so an ordinary link on the page cannot blank the heading', () => {
    render(markup());
    start();

    click(document.getElementById('plain-link') as HTMLAnchorElement);

    expect(find(ADD_TO_PACK_PART.categoryName).textContent).toBe(FIRST_CATEGORY.name);
  });
});

describe('the tabs', () => {
  it('switches panels without navigating, keeping aria-selected, tabindex and hidden in step', () => {
    render(markup());
    start();

    const event = click(tabFor('new'));

    expect(event.defaultPrevented).toBe(true);
    expect(tabFor('new').getAttribute('aria-selected')).toBe('true');
    expect(tabFor('new').getAttribute('tabindex')).toBe('0');
    expect(tabFor('closet').getAttribute('aria-selected')).toBe('false');
    expect(tabFor('closet').getAttribute('tabindex')).toBe('-1');
    expect(panelFor('new').hidden).toBe(false);
    expect(panelFor('closet').hidden).toBe(true);
  });

  it('moves and activates on an arrow key, and moves focus with it — a roving tabindex that did not move focus would leave the keyboard on a tab that is no longer selected', () => {
    render(markup());
    start();

    tabFor('closet').focus();
    tabFor('closet').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }),
    );

    expect(document.activeElement).toBe(tabFor('new'));
    expect(panelFor('new').hidden).toBe(false);
  });

  it('wraps round rather than dead-ending at the last tab', () => {
    render(markup());
    start();

    click(tabFor('new'));
    tabFor('new').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }),
    );

    expect(panelFor('closet').hidden).toBe(false);
  });

  it('leaves keys it does not handle to the browser, so Tab still leaves the strip', () => {
    render(markup());
    start();

    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    tabFor('closet').dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });

  it('THE PANEL THAT IS NOT SHOWING IS `hidden`, AND ITS FIELDS ARE NOT SUBMITTED — a panel that were merely off-screen would keep its Save button one Tab away and its fields in the tab order', () => {
    render(markup());
    start();

    click(tabFor('new'));

    const closetPanel = panelFor('closet');
    expect(closetPanel.hidden).toBe(true);
    // `hidden` is the platform's "this subtree is not rendered", which is what actually takes
    // the contents out of the tab order — a class that only moved them off-screen would not.
    for (const field of closetPanel.querySelectorAll('input')) {
      expect(field.closest('[hidden]')).not.toBeNull();
    }

    // And the visible form carries nothing from it: they are two forms, so a tick left behind
    // in the closet list cannot ride along on a new-item save.
    const newForm = document.getElementById('new-item-form') as HTMLFormElement;
    const submitted = [...new FormData(newForm).keys()];
    expect(submitted).toContain(CUSTOM_PACK_ITEM_FORM_FIELD.name);
    expect(submitted).not.toContain(PACK_EDITOR_FIELD.gearItemId);
  });
});

describe('searching the closet in place', () => {
  it('FETCHES INSTEAD OF NAVIGATING, and asks the endpoint for exactly what the search box says', async () => {
    render(markup());
    const { fetchImpl, urls, settle } = deferredFetch();
    start({ fetchImpl });

    (find(ADD_TO_PACK_PART.searchInput) as HTMLInputElement).value = 'tent';
    const event = submit(find(ADD_TO_PACK_PART.searchForm));

    expect(event.defaultPrevented).toBe(true);
    expect(urls).toEqual([closetRequestUrl('tent', 1)]);

    settle[0]?.(closetPage([ROWS[0]!], 1, 1, 1));
    await flush();

    const rows = find(ADD_TO_PACK_PART.list).querySelectorAll('li');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain('Stakes');
  });

  it('renders a row with the same classes and the same weight format the server rendered it with, so a search does not visibly restyle the list or change what a weight reads as', async () => {
    render(markup());
    const { fetchImpl, settle } = deferredFetch();
    start({ fetchImpl });

    submit(find(ADD_TO_PACK_PART.searchForm));
    settle[0]?.(closetPage(ROWS, 1, 1, 2));
    await flush();

    const row = find(ADD_TO_PACK_PART.list).querySelector('li');
    expect(row?.querySelector('label')?.className).toBe(CLOSET_ROW_CLASS.label);
    const box = row?.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(box.name).toBe(PACK_EDITOR_FIELD.gearItemId);
    expect(box.value).toBe('gear-1');
    const cells = [...(row?.querySelectorAll('span') ?? [])].map((span) => [
      span.className,
      span.textContent,
    ]);
    expect(cells).toEqual([
      [CLOSET_ROW_CLASS.name, 'Stakes'],
      [CLOSET_ROW_CLASS.brand, 'MSR'],
      [CLOSET_ROW_CLASS.weight, formatWeight(56, 'metric')],
    ]);
  });

  it('writes a closet item’s name as TEXT, so an item called `<img onerror=…>` is a name and not a script this page runs', async () => {
    render(markup());
    const { fetchImpl, settle } = deferredFetch();
    start({ fetchImpl });

    submit(find(ADD_TO_PACK_PART.searchForm));
    settle[0]?.(
      closetPage([
        { id: 'x', name: '<img src=x onerror="alert(1)">', brand: null, weightGrams: 1 },
      ]),
    );
    await flush();

    const list = find(ADD_TO_PACK_PART.list);
    expect(list.querySelector('img')).toBeNull();
    expect(list.textContent).toContain('<img src=x onerror="alert(1)">');
  });

  it('swaps the empty sentence for the right one of the two when a search matches nothing, and hides the picker rather than showing an empty fieldset with a live Add button', async () => {
    render(markup());
    const { fetchImpl, settle } = deferredFetch();
    start({ fetchImpl });

    (find(ADD_TO_PACK_PART.searchInput) as HTMLInputElement).value = 'tnet';
    submit(find(ADD_TO_PACK_PART.searchForm));
    settle[0]?.(closetPage([], 1, 1, 0));
    await flush();

    expect(find(ADD_TO_PACK_PART.empty).hidden).toBe(false);
    expect(find(ADD_TO_PACK_PART.empty).textContent).toBe(CLOSET_NO_MATCHES_MESSAGE);
    expect(find(ADD_TO_PACK_PART.listForm).hidden).toBe(true);
    expect(find(ADD_TO_PACK_PART.count).textContent).toBe(closetCountLabel(0, 'tnet'));
  });

  it('DEBOUNCES TYPING, so "tent" is one request and not four', async () => {
    vi.useFakeTimers();
    try {
      render(markup());
      const { fetchImpl, urls } = deferredFetch();
      start({ fetchImpl, debounceMs: 200 });

      const input = find(ADD_TO_PACK_PART.searchInput) as HTMLInputElement;
      for (const value of ['t', 'te', 'ten', 'tent']) {
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        vi.advanceTimersByTime(50);
      }

      expect(urls).toEqual([]);
      vi.advanceTimersByTime(200);
      expect(urls).toEqual([closetRequestUrl('tent', 1)]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('AN OUT-OF-ORDER RESPONSE NEVER OVERWRITES A NEWER RESULT — type "tent", then "tents", and the slower first request must not land on top of the second', async () => {
    render(markup());
    const { fetchImpl, urls, settle } = deferredFetch();
    start({ fetchImpl });

    const input = find(ADD_TO_PACK_PART.searchInput) as HTMLInputElement;

    input.value = 'tent';
    submit(find(ADD_TO_PACK_PART.searchForm));
    input.value = 'tents';
    submit(find(ADD_TO_PACK_PART.searchForm));

    expect(urls).toEqual([closetRequestUrl('tent', 1), closetRequestUrl('tents', 1)]);

    // The NEWER request answers first...
    settle[1]?.(closetPage([{ id: 'new', name: 'Tent stakes', brand: null, weightGrams: 10 }]));
    await flush();
    // ...and then the older one arrives, exactly as a slow connection delivers it. The abort
    // signal is ignored by this double on purpose: abort is best effort, and this is the case
    // it cannot cover.
    settle[0]?.(closetPage([{ id: 'old', name: 'Stale result', brand: null, weightGrams: 10 }]));
    await flush();

    const list = find(ADD_TO_PACK_PART.list);
    expect(list.textContent).toContain('Tent stakes');
    expect(list.textContent).not.toContain('Stale result');
  });
});

describe('paging in place', () => {
  it('fetches the page the link names instead of navigating to it, and re-aims the pager at what came back', async () => {
    render(markup({ page: 1, totalPages: 3 }));
    const { fetchImpl, urls, settle } = deferredFetch();
    start({ fetchImpl });

    const event = click(find(ADD_TO_PACK_PART.pageNext));

    expect(event.defaultPrevented).toBe(true);
    expect(urls).toEqual([closetRequestUrl('', 2)]);

    settle[0]?.(closetPage(ROWS, 2, 3, 120));
    await flush();

    expect(find(ADD_TO_PACK_PART.pagerLabel).textContent).toBe('Page 2 of 3');
    expect(find(ADD_TO_PACK_PART.pagePrevious).hidden).toBe(false);
    expect(find(ADD_TO_PACK_PART.pagePrevious).getAttribute(ADD_TO_PACK_PAGE_ATTRIBUTE)).toBe('1');
    expect(find(ADD_TO_PACK_PART.pageNext).getAttribute(ADD_TO_PACK_PAGE_ATTRIBUTE)).toBe('3');
  });

  it('KEEPS THE SEARCH WHEN IT PAGES, or page 2 of a search silently becomes page 2 of the whole closet', async () => {
    render(markup({ page: 1, totalPages: 3 }));
    const { fetchImpl, urls, settle } = deferredFetch();
    start({ fetchImpl });

    (find(ADD_TO_PACK_PART.searchInput) as HTMLInputElement).value = 'tent';
    submit(find(ADD_TO_PACK_PART.searchForm));
    settle[0]?.(closetPage(ROWS, 1, 3, 120));
    await flush();

    click(find(ADD_TO_PACK_PART.pageNext));

    expect(urls[1]).toBe(closetRequestUrl('tent', 2));
  });

  it('hides the pager entirely when what came back is a single page', async () => {
    render(markup({ page: 1, totalPages: 3 }));
    const { fetchImpl, settle } = deferredFetch();
    start({ fetchImpl });

    submit(find(ADD_TO_PACK_PART.searchForm));
    settle[0]?.(closetPage(ROWS, 1, 1, 2));
    await flush();

    expect(find(ADD_TO_PACK_PART.pager).hidden).toBe(true);
  });
});

describe('degrading when the fetch fails', () => {
  it('HANDS THE GET FORM BACK rather than leaving a search box that silently does nothing, and says so in one neutral sentence', async () => {
    render(markup());
    const { fetchImpl, settle } = deferredFetch();
    start({ fetchImpl });

    submit(find(ADD_TO_PACK_PART.searchForm));
    settle[0]?.({ ok: false, message: CLOSET_LOAD_FAILED_MESSAGE }, { status: 500 });
    await flush();

    const status = find(ADD_TO_PACK_PART.status);
    expect(status.hidden).toBe(false);
    expect(status.textContent).toBe(CLOSET_LOAD_FAILED_MESSAGE);

    // The interception is off: the next submit is a real navigation again, which is the only
    // way forward left and was working before the script touched it.
    const second = submit(find(ADD_TO_PACK_PART.searchForm));
    expect(second.defaultPrevented).toBe(false);
    // And the pager links are links again.
    expect(click(find(ADD_TO_PACK_PART.pageNext)).defaultPrevented).toBe(false);
  });

  it('LEAVES THE ROWS THAT ARE THERE ALONE, because blanking the list would report a failed read as an empty closet', async () => {
    render(markup());
    const { fetchImpl, settle } = deferredFetch();
    start({ fetchImpl });

    submit(find(ADD_TO_PACK_PART.searchForm));
    settle[0]?.(null, { status: 502 });
    await flush();

    expect(find(ADD_TO_PACK_PART.list).querySelectorAll('li')).toHaveLength(2);
    expect(find(ADD_TO_PACK_PART.listForm).hidden).toBe(false);
    expect(find(ADD_TO_PACK_PART.status).textContent).toBe(CLOSET_LOAD_FAILED_MESSAGE);
  });

  it('says the same neutral thing when the network throws, rather than putting a TypeError on screen', async () => {
    render(markup());
    const { fetchImpl, reject } = deferredFetch();
    start({ fetchImpl });

    submit(find(ADD_TO_PACK_PART.searchForm));
    reject[0]?.(new TypeError('Failed to fetch'));
    await flush();

    expect(find(ADD_TO_PACK_PART.status).textContent).toBe(CLOSET_LOAD_FAILED_MESSAGE);
  });

  it('treats a session that expired mid-search as a failure with a way forward, not as a closet that has become empty', async () => {
    render(markup());
    const { fetchImpl, settle } = deferredFetch();
    start({ fetchImpl });

    // The endpoint answers a signed-out caller with a 303 to sign-in; `fetch` follows it and
    // hands back the sign-in page with a 200.
    settle.length = 0;
    submit(find(ADD_TO_PACK_PART.searchForm));
    settle[0]?.(closetPage([], 1, 1, 0), { redirected: true });
    await flush();

    expect(find(ADD_TO_PACK_PART.status).textContent).toBe(CLOSET_LOAD_FAILED_MESSAGE);
    expect(find(ADD_TO_PACK_PART.list).querySelectorAll('li')).toHaveLength(2);
  });
});

describe('the remembered "also add to closet" toggle', () => {
  it('applies what this browser last chose', () => {
    const storage = memoryStorage();
    storage.setItem(alsoAddToClosetKey(USER_ID), 'true');
    render(markup());
    start({ storage });

    expect((find(ADD_TO_PACK_PART.toggle) as HTMLInputElement).checked).toBe(true);
  });

  it('remembers a change, under a key scoped to this user so two accounts on one browser do not inherit each other’s choice', () => {
    const storage = memoryStorage();
    render(markup());
    start({ storage });

    const toggle = find(ADD_TO_PACK_PART.toggle) as HTMLInputElement;
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));

    expect(storage.getItem(alsoAddToClosetKey(USER_ID))).toBe('true');
    expect(storage.getItem(alsoAddToClosetKey('someone-else'))).toBeNull();

    toggle.checked = false;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));
    expect(storage.getItem(alsoAddToClosetKey(USER_ID))).toBeNull();
  });

  it('DOES NOT OVERWRITE A ROUND TRIP. A rejected submission comes back with the visitor’s own tick, and a browser that cannot read storage would otherwise silently clear it', () => {
    const storage = throwingStorage();
    render(markup({ remember: false }));
    const toggle = find(ADD_TO_PACK_PART.toggle) as HTMLInputElement;
    toggle.checked = true;

    start({ storage });

    expect(toggle.checked).toBe(true);
  });

  it('NEVER THROWS ON A STORAGE THAT REFUSES TO BE READ, because Safari private mode throws on getItem and a dialog that fails to open over a convenience is the worse bug', () => {
    render(markup());

    expect(() => start({ storage: throwingStorage() })).not.toThrow();
    expect((find(ADD_TO_PACK_PART.toggle) as HTMLInputElement).checked).toBe(false);

    const toggle = find(ADD_TO_PACK_PART.toggle) as HTMLInputElement;
    toggle.checked = true;
    expect(() => toggle.dispatchEvent(new Event('change', { bubbles: true }))).not.toThrow();
  });

  it('works with no storage at all, which is what the server and a locked-down browser both look like', () => {
    render(markup());

    expect(() => start({ storage: null })).not.toThrow();
  });
});

describe('destroy', () => {
  it('detaches everything it attached, leaving markup that still works exactly as the server rendered it', () => {
    render(markup());
    const handle = start();

    handle.destroy();
    handles = [];

    // The tab is a link again...
    expect(click(tabFor('new')).defaultPrevented).toBe(false);
    // ...the search form is a GET form again...
    expect(submit(find(ADD_TO_PACK_PART.searchForm)).defaultPrevented).toBe(false);
    // ...and the trigger no longer rewrites anything.
    click(document.getElementById('trigger-other') as HTMLAnchorElement);
    expect(find(ADD_TO_PACK_PART.categoryName).textContent).toBe(FIRST_CATEGORY.name);
  });
});

describe('the run itself', () => {
  it('logs nothing, so an unexpected warning from this module is worth looking at', () => {
    render(markup());
    start();
    click(tabFor('new'));

    expect(warnings).toEqual([]);
  });
});
