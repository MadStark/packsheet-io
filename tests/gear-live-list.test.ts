/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GEAR_FILTERS_FORM_ID,
  GEAR_LIVE_STATUS_ID,
  GEAR_SEARCH_DEBOUNCE_MS,
  LIVE_LINK_ATTRIBUTE,
  LIVE_READY_ATTRIBUTE,
  LIVE_REGION_ATTRIBUTE,
  LIVE_SUMMARY_ATTRIBUTE,
  NO_RESULTS_ANNOUNCEMENT,
  filterFormUrl,
  initGearLiveList,
  isModifiedClick,
  liveLinkKind,
  liveStatusMessage,
  swapLiveRegions,
  syncFilterFormToUrl,
  type GearLiveListDeps,
  type LiveClickEvent,
} from '../src/lib/gear/live-list';

/**
 * `src/lib/gear/live-list.ts` is PK-70's in-place-update logic for the gear closet list,
 * extracted out of `src/pages/gear/index.astro`'s `<script>` for the same reason
 * `tests/modal.test.ts` gives for `src/lib/modal.ts`: `vitest.config.ts:64` excludes
 * `src/pages/**`, so code typed in a page's frontmatter or its `<script>` tags is code no
 * test here can reach. Read that file's own header before this one — it argues the jsdom
 * environment choice in more depth than is worth repeating, and this suite makes the
 * identical trade: `environment: 'node'` for the rest of the repository, `jsdom` for this
 * file, because a debounced `input` listener, a delegated `click` listener surviving a DOM
 * replacement, and `history.replaceState` not firing are all facts about a real document,
 * not about data.
 *
 * WHAT THIS SUITE DOES NOT NEED, UNLIKE `tests/modal.test.ts`: no platform double. Nothing
 * here calls `fetch`, `history.replaceState`, or `Element.scrollIntoView` directly —
 * `GearLiveListDeps` exists precisely so this module never has to, and every test below
 * hands it a plain `vi.fn()` instead. The one piece of platform jsdom is short of that this
 * suite DOES lean on is `DOMParser`, which jsdom implements for real — `initGearLiveList`
 * parses a fetched response with it, so `scene()`'s fake `fetchPage` hands back real HTML
 * strings rather than pre-built documents.
 *
 * DEBOUNCING WITHOUT REAL TIMERS: `fakeTimers()` below is a deliberately tiny queue, not
 * `vi.useFakeTimers()`. The module accepts `setTimeoutImpl`/`clearTimeoutImpl` exactly so a
 * test can drive the debounce by hand — schedule, assert nothing fired yet, `flush()`, assert
 * it did — without also having to fake every OTHER timer in the jsdom environment (a real
 * `Promise` microtask queue still needs draining between `flush()` and an assertion, which
 * `tick()` below does with one real macrotask).
 */

// ---------------------------------------------------------------------------
// Fixtures shared by every describe block below
// ---------------------------------------------------------------------------

const LIST_REGION_ID = 'gear-list-region';
const HEADLINE_REGION_ID = 'gear-headline-figures';

/** Replaces the document body wholesale, so no test can pass or fail because of a listener
 *  or an inline style a previous one left behind — the identical technique
 *  `tests/modal.test.ts`'s own `render` uses, for the identical reason. */
function render(html: string): HTMLElement {
  const body = document.createElement('body');
  body.innerHTML = html;
  document.documentElement.replaceChild(body, document.body);
  return document.body;
}

/**
 * A minimal closet page: the filter form the contract describes, the persistent live
 * status element, and the two live regions — each toggleable off (`includeList`/
 * `includeHeadline`) so a test can build a response that is missing one, and each carrying
 * one summary line, one sort link and one pager link so a single fixture covers most tests.
 *
 * ALL THREE STATUS CHECKBOXES, as the page renders them, and not the two this fixture
 * carried before PK-70's review: `syncFilterFormToUrl` now WRITES the boxes back as well as
 * `filterFormUrl` reading them, and with only owned and wishlist present no test could tell
 * "re-ticked to the default pair" from "left exactly as the visitor last clicked them" —
 * the two states this fixture exists to keep apart.
 */
function pageHtml(
  options: {
    summary?: string | null;
    headline?: string;
    sort?: string;
    dir?: string;
    includeList?: boolean;
    includeHeadline?: boolean;
  } = {},
): string {
  const {
    summary = 'Showing 1–12 of 47',
    headline = 'Items 47',
    sort = 'name',
    dir = 'asc',
    includeList = true,
    includeHeadline = true,
  } = options;

  const listRegion = includeList
    ? `<div id="${LIST_REGION_ID}" ${LIVE_REGION_ATTRIBUTE}>
        ${summary === null ? '' : `<p ${LIVE_SUMMARY_ATTRIBUTE}>${summary}</p>`}
        <a href="/gear?sort=price" ${LIVE_LINK_ATTRIBUTE}="sort:price">Price</a>
        <a href="/gear?page=2" ${LIVE_LINK_ATTRIBUTE}="page:next">Next</a>
      </div>`
    : '';
  const headlineRegion = includeHeadline
    ? `<p id="${HEADLINE_REGION_ID}" ${LIVE_REGION_ATTRIBUTE}>${headline}</p>`
    : '';

  return `
    <form id="${GEAR_FILTERS_FORM_ID}" method="GET" action="/gear">
      <input id="q" name="q" type="search" value="" />
      <input type="checkbox" name="status" value="owned" checked />
      <input type="checkbox" name="status" value="wishlist" />
      <input type="checkbox" name="status" value="retired" />
      <input type="hidden" name="sort" value="${sort}" />
      <input type="hidden" name="dir" value="${dir}" />
    </form>
    <div id="${GEAR_LIVE_STATUS_ID}"></div>
    ${headlineRegion}
    ${listRegion}
  `;
}

/** What a session-expiry redirect to sign-in looks like: real HTML, no filter form, no
 *  region carrying `LIVE_REGION_ATTRIBUTE` anywhere in it — see `swapLiveRegions`'s own
 *  note on why a zero-match response is read as exactly this. */
function signInPageHtml(): string {
  return '<h1>Sign in</h1><form id="sign-in"><input name="email" /></form>';
}

/**
 * A hand-rolled timer queue, injected as `deps.setTimeoutImpl`/`clearTimeoutImpl`. `flush()`
 * runs every still-pending callback and clears the queue; tests use it to fire a debounced
 * update on demand instead of waiting out `GEAR_SEARCH_DEBOUNCE_MS` for real.
 */
function fakeTimers() {
  let nextId = 1;
  const pending = new Map<number, () => void>();
  const delays: number[] = [];
  const setTimeoutImpl = ((fn: () => void, delay?: number) => {
    const id = nextId++;
    pending.set(id, fn);
    delays.push(delay ?? 0);
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  const clearTimeoutImpl = ((id: unknown) => {
    pending.delete(id as number);
  }) as typeof clearTimeout;
  const flush = () => {
    const due = [...pending.values()];
    pending.clear();
    for (const fn of due) fn();
  };
  return { setTimeoutImpl, clearTimeoutImpl, flush, pendingCount: () => pending.size, delays };
}

/** One real macrotask — enough for every microtask this suite produces (an injected
 *  `fetchPage`'s own `async` wrapper, plus the single `await` inside `initGearLiveList`'s
 *  `update`) to have run. Deliberately a REAL `setTimeout`, never the injected one: it is
 *  draining the JS engine's own promise queue, which the fake timer queue above has no
 *  part in and cannot substitute for. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Builds a fresh document plus a `GearLiveListDeps` whose four platform calls are
 *  `vi.fn()`s, so a test can assert what this module tried to do without any of them being
 *  real. */
function scene(html: string = pageHtml()) {
  const body = render(html);
  const form = body.querySelector<HTMLFormElement>(`#${GEAR_FILTERS_FORM_ID}`);
  const timers = fakeTimers();
  const fetchPage = vi.fn<(url: string) => Promise<string | null>>();
  const navigate = vi.fn();
  const replaceUrl = vi.fn();
  const scrollIntoView = vi.fn();
  const deps: GearLiveListDeps = {
    fetchPage,
    navigate,
    replaceUrl,
    scrollIntoView,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
  };
  return {
    doc: document,
    body,
    form: form as HTMLFormElement,
    fetchPage,
    navigate,
    replaceUrl,
    scrollIntoView,
    timers,
    deps,
  };
}

let warnings: unknown[][] = [];

beforeEach(() => {
  warnings = [];
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warnings.push(args);
  });
});

/*
 * initGearLiveList's DELEGATED CLICK LISTENER LIVES ON `document`, NOT ON THE BODY `render()`
 * REPLACES. That is the whole point of it (see the module's own comment on point (d)) — but
 * it means nothing here undoes it automatically between tests the way swapping the body undoes
 * an inline style or a focused element. Without this cleanup, every `initGearLiveList` call in
 * a LATER test would run behind however many earlier tests' listeners are still attached, and
 * `event.defaultPrevented` set true by a STALE listener (still holding a previous test's
 * `deps`) would make this test's own listener bail out at its own `if (event.defaultPrevented)
 * return` — silently starving it of the click it was supposed to see. `initLiveList` below is
 * the only supported way to call `initGearLiveList` in this file for exactly that reason: it
 * is the one call site that cannot forget to register its own teardown.
 */
const activeTeardowns: Array<() => void> = [];

function initLiveList(doc: Document, deps: GearLiveListDeps): (() => void) | null {
  const teardown = initGearLiveList(doc, deps);
  if (teardown !== null) activeTeardowns.push(teardown);
  return teardown;
}

afterEach(() => {
  // Idempotent even for the one test that already called its own teardown explicitly —
  // AbortController.abort() and this module's own guards both tolerate a second call.
  for (const teardown of activeTeardowns.splice(0)) teardown();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// filterFormUrl
// ---------------------------------------------------------------------------

describe('filterFormUrl', () => {
  it('builds the URL a real form would have navigated to, with repeated status params in the order the boxes appear', () => {
    render(`
      <form id="f" method="GET" action="/gear">
        <input name="q" value="boots" />
        <input type="checkbox" name="status" value="owned" checked />
        <input type="checkbox" name="status" value="wishlist" checked />
        <input type="checkbox" name="status" value="retired" />
        <input type="hidden" name="sort" value="price" />
        <input type="hidden" name="dir" value="desc" />
      </form>
    `);
    const form = document.querySelector('form') as HTMLFormElement;

    const url = new URL(filterFormUrl(form));

    expect(url.pathname).toBe('/gear');
    expect(url.searchParams.get('q')).toBe('boots');
    // Both order and multiplicity matter: URLSearchParams.append (not set) is what keeps
    // three checkboxes sharing one `name` from collapsing into a single status param.
    expect(url.searchParams.getAll('status')).toEqual(['owned', 'wishlist']);
    expect(url.searchParams.get('sort')).toBe('price');
    expect(url.searchParams.get('dir')).toBe('desc');
  });

  it('SKIPS A FILE VALUE RATHER THAN COERCING IT, or a file input silently becomes the literal text "[object File]" in the query string', () => {
    render(`
      <form id="f" method="GET" action="/gear">
        <input name="q" value="boots" />
        <input type="file" name="photo" />
      </form>
    `);
    const form = document.querySelector('form') as HTMLFormElement;

    const url = new URL(filterFormUrl(form));

    // An unselected file input still contributes a FormData entry (an empty File), which is
    // exactly the case this guard exists for — there is no user action that skips it.
    expect(url.searchParams.has('photo')).toBe(false);
    expect(url.searchParams.get('q')).toBe('boots');
  });

  it('carries no page param, because the form itself never has one — a fresh search always lands on page 1', () => {
    render(`
      <form id="f" method="GET" action="/gear">
        <input name="q" value="tent" />
      </form>
    `);
    const form = document.querySelector('form') as HTMLFormElement;

    expect(new URL(filterFormUrl(form)).searchParams.has('page')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isModifiedClick
// ---------------------------------------------------------------------------

describe('isModifiedClick', () => {
  const plain: LiveClickEvent = {
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
  };

  it('reports false for a plain left click, the only click this module is allowed to intercept', () => {
    expect(isModifiedClick(plain)).toBe(false);
  });

  it.each(['metaKey', 'ctrlKey', 'shiftKey', 'altKey'] as const)(
    'reports true for %s, because swallowing it breaks the browser\'s own "open elsewhere" gesture with no error anywhere',
    (modifier) => {
      expect(isModifiedClick({ ...plain, [modifier]: true })).toBe(true);
    },
  );

  it('reports true for any button other than the primary one, so a middle click still opens a new tab', () => {
    expect(isModifiedClick({ ...plain, button: 1 })).toBe(true);
    expect(isModifiedClick({ ...plain, button: 2 })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// liveLinkKind
// ---------------------------------------------------------------------------

describe('liveLinkKind', () => {
  it('parses a sort link', () => {
    expect(liveLinkKind('sort:price')).toEqual({ kind: 'sort', key: 'price' });
  });

  it('parses both pager edges', () => {
    expect(liveLinkKind('page:prev')).toEqual({ kind: 'page', edge: 'prev' });
    expect(liveLinkKind('page:next')).toEqual({ kind: 'page', edge: 'next' });
  });

  it('returns null for null, empty, and unrecognised values RATHER THAN THROWING, so one link with an out-of-date value cannot take down the delegated listener every other live link shares', () => {
    expect(liveLinkKind(null)).toBe(null);
    expect(liveLinkKind('')).toBe(null);
    expect(liveLinkKind('bogus')).toBe(null);
    expect(liveLinkKind('page:middle')).toBe(null);
    // "sort:" with nothing after it names no column — not the same as a missing attribute,
    // and still not a value this function can act on.
    expect(liveLinkKind('sort:')).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// swapLiveRegions
// ---------------------------------------------------------------------------

describe('swapLiveRegions', () => {
  function scene() {
    const current = render(`
      <p id="a" ${LIVE_REGION_ATTRIBUTE}>old a</p>
      <p id="b" ${LIVE_REGION_ATTRIBUTE}>old b</p>
      <p id="c" ${LIVE_REGION_ATTRIBUTE}>old c, unmatched below</p>
    `);
    const next = document.createElement('div');
    next.innerHTML = `
      <p id="a" ${LIVE_REGION_ATTRIBUTE}>new a</p>
      <p id="b" ${LIVE_REGION_ATTRIBUTE}>new b</p>
    `;
    return { current, next };
  }

  it('replaces the innerHTML of every region with a match in next, and reports exactly those ids', () => {
    const { current, next } = scene();

    expect(swapLiveRegions(current, next).sort()).toEqual(['a', 'b']);
    expect(current.querySelector('#a')?.innerHTML).toBe('new a');
    expect(current.querySelector('#b')?.innerHTML).toBe('new b');
  });

  it('LEAVES AN UNMATCHED REGION COMPLETELY ALONE, not blanked and not in the returned list', () => {
    const { current, next } = scene();

    const swapped = swapLiveRegions(current, next);

    expect(current.querySelector('#c')?.innerHTML).toBe('old c, unmatched below');
    expect(swapped).not.toContain('c');
  });

  it('returns an empty array when nothing in next matches any region — the signal a caller reads as "this was not a closet page at all"', () => {
    const current = render(`<p id="a" ${LIVE_REGION_ATTRIBUTE}>old</p>`);
    const next = document.createElement('div');
    next.innerHTML = signInPageHtml();

    expect(swapLiveRegions(current, next)).toEqual([]);
    expect(current.querySelector('#a')?.innerHTML).toBe('old');
  });

  it('keeps the element itself, not just its content, so LIVE_REGION_ATTRIBUTE and the id survive a second swap', () => {
    const { current, next } = scene();
    const before = current.querySelector('#a');

    swapLiveRegions(current, next);

    expect(current.querySelector('#a')).toBe(before);
    expect(current.querySelector('#a')?.hasAttribute(LIVE_REGION_ATTRIBUTE)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// liveStatusMessage
// ---------------------------------------------------------------------------

describe('liveStatusMessage', () => {
  it('reads the summary line, trimmed and with internal whitespace collapsed — the JSX line-wrapping between {rangeStart} and {rangeEnd} otherwise announces raw newlines', () => {
    const region = document.createElement('div');
    region.innerHTML = `<p ${LIVE_SUMMARY_ATTRIBUTE}>
      Showing   1–12
      of 47
    </p>`;

    expect(liveStatusMessage(region)).toBe('Showing 1–12 of 47');
  });

  it('announces NO_RESULTS_ANNOUNCEMENT when there is no summary element, which is what the "no items match" block genuinely renders', () => {
    const region = document.createElement('div');
    region.innerHTML = '<p>No items match these filters.</p>';

    expect(liveStatusMessage(region)).toBe(NO_RESULTS_ANNOUNCEMENT);
  });
});

// ---------------------------------------------------------------------------
// syncFilterFormToUrl
// ---------------------------------------------------------------------------

describe('syncFilterFormToUrl', () => {
  function scene() {
    const body = render(`
      <form id="f" method="GET" action="/gear">
        <input id="q" name="q" value="boo" />
        <input type="checkbox" name="status" value="owned" />
        <input type="checkbox" name="status" value="wishlist" />
        <input type="checkbox" name="status" value="retired" />
        <input type="hidden" name="sort" value="name" />
        <input type="hidden" name="dir" value="asc" />
      </form>
    `);
    return {
      form: body.querySelector('form') as HTMLFormElement,
      search: body.querySelector<HTMLInputElement>('#q') as HTMLInputElement,
      statusBoxes: [...body.querySelectorAll<HTMLInputElement>('input[name="status"]')],
    };
  }

  /** The values of the boxes that are ticked, in document order — "what the visitor can see
   *  is selected", which is the whole of what the assertions below are about. */
  const ticked = (boxes: HTMLInputElement[]): string[] =>
    boxes.filter((box) => box.checked).map((box) => box.value);

  it('copies sort and dir from the URL into the hidden inputs', () => {
    const { form } = scene();

    syncFilterFormToUrl(form, 'http://localhost/gear?sort=price&dir=desc');

    expect((form.elements.namedItem('sort') as HTMLInputElement).value).toBe('price');
    expect((form.elements.namedItem('dir') as HTMLInputElement).value).toBe('desc');
  });

  it('falls back to the parseGearQuery defaults when the URL omits sort/dir, because an omitted param there means "the default column and direction", not "leave this input as it was"', () => {
    const { form } = scene();
    (form.elements.namedItem('sort') as HTMLInputElement).value = 'price';
    (form.elements.namedItem('dir') as HTMLInputElement).value = 'desc';

    syncFilterFormToUrl(form, 'http://localhost/gear?q=tent');

    expect((form.elements.namedItem('sort') as HTMLInputElement).value).toBe('name');
    expect((form.elements.namedItem('dir') as HTMLInputElement).value).toBe('asc');
  });

  it('RE-TICKS THE STATUS BOXES TO THE DEFAULT THE SERVER ACTUALLY APPLIED when the URL names no status, so unticking every box cannot leave three empty boxes over a list of owned and wishlist rows', () => {
    const { form, statusBoxes } = scene();
    // EXACTLY THE FAILURE STATE PK-70's REVIEW FOUND, reproduced as a starting condition
    // rather than described: the visitor unticked Owned, then unticked Wishlist. Every box
    // is clear, so `filterFormUrl` finds no checked `status` box and the URL it built —
    // the one this update actually asked the server for — carries no `status` param at all.
    for (const box of statusBoxes) box.checked = false;

    syncFilterFormToUrl(form, 'http://localhost/gear?q=boots');

    // `effectiveGearStatuses` resolves an empty selection to GEAR_DEFAULT_STATUSES, so that
    // URL returned owned and wishlist rows. Before this sync the boxes stayed clear and
    // claimed the opposite of what the visitor was looking at.
    expect(ticked(statusBoxes)).toEqual(['owned', 'wishlist']);
  });

  it('ticks EXACTLY the statuses the URL names when it names any, so the default resolution above cannot quietly override a real selection', () => {
    const { form, statusBoxes } = scene();
    statusBoxes[0].checked = true;

    syncFilterFormToUrl(form, 'http://localhost/gear?status=retired');

    expect(ticked(statusBoxes)).toEqual(['retired']);
  });

  it('ignores a status value the vocabulary does not recognise, resolving to the default pair exactly as parseGearQuery does server-side for the same URL', () => {
    const { form, statusBoxes } = scene();

    syncFilterFormToUrl(form, 'http://localhost/gear?status=borrowed');

    expect(ticked(statusBoxes)).toEqual(['owned', 'wishlist']);
  });

  it("DOES NOT TOUCH THE SEARCH INPUT, even though the URL carries a q — writing it back would move a mid-word visitor's caret on every update", () => {
    const { form, search } = scene();
    search.value = 'boo';
    search.setSelectionRange(1, 1);

    syncFilterFormToUrl(form, 'http://localhost/gear?q=boots&sort=price&dir=desc');

    expect(search.value).toBe('boo');
  });
});

// ---------------------------------------------------------------------------
// initGearLiveList
// ---------------------------------------------------------------------------

describe('initGearLiveList', () => {
  it("returns null when there is no filter form, which is the closet's own empty state and not an error", () => {
    const { doc, deps } = scene('<main><p>Your closet is empty.</p></main>');
    expect(initGearLiveList(doc, deps)).toBe(null);
  });

  it('returns null when there is no live region, for the same reason', () => {
    const { doc, deps } = scene(
      `<form id="${GEAR_FILTERS_FORM_ID}" method="GET" action="/gear"></form>`,
    );
    expect(initGearLiveList(doc, deps)).toBe(null);
  });

  it('sets LIVE_READY_ATTRIBUTE on the form, which is the handshake that stands the inline no-JS fallback down', () => {
    const { doc, form, deps } = scene();

    initLiveList(doc, deps);

    expect(form.hasAttribute(LIVE_READY_ATTRIBUTE)).toBe(true);
  });

  it('DEBOUNCES THE SEARCH FIELD, so typing "boots" issues exactly one fetch rather than one per keystroke', async () => {
    const { doc, form, fetchPage, replaceUrl, timers, deps } = scene();
    fetchPage.mockResolvedValue(pageHtml());
    initLiveList(doc, deps);
    const search = form.querySelector<HTMLInputElement>('#q') as HTMLInputElement;

    for (const partial of ['b', 'bo', 'boo', 'boot', 'boots']) {
      search.value = partial;
      search.dispatchEvent(new Event('input', { bubbles: true }));
    }
    expect(fetchPage).not.toHaveBeenCalled();
    // Each keystroke re-scheduled the timer rather than adding a second one — five keystrokes,
    // one still-pending timer — and it was scheduled for the module's own published delay
    // rather than some other value nothing here declares.
    expect(timers.pendingCount()).toBe(1);
    expect(timers.delays.at(-1)).toBe(GEAR_SEARCH_DEBOUNCE_MS);

    timers.flush();
    await tick();

    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(new URL(fetchPage.mock.calls[0][0]).searchParams.get('q')).toBe('boots');
    // The address bar is rewritten for THIS path too, not only for a sort click. A search
    // and a status tick build their URL through `filterFormUrl` rather than off a link's
    // `href` — a genuinely different route to the same `replaceUrl`, and until PK-70's
    // review only the link route was pinned. A search that updates the list and leaves the
    // URL naming the previous query is a page nobody can bookmark or reload back into.
    expect(replaceUrl).toHaveBeenCalledWith(fetchPage.mock.calls[0][0]);
  });

  it('fetches IMMEDIATELY on a status change, with no debounce, and rewrites the URL to match', async () => {
    const { doc, form, fetchPage, replaceUrl, timers, deps } = scene();
    fetchPage.mockResolvedValue(pageHtml());
    initLiveList(doc, deps);
    const owned = form.querySelector<HTMLInputElement>('input[name="status"][value="owned"]');

    owned!.checked = false;
    owned!.dispatchEvent(new Event('change', { bubbles: true }));

    // No timers.flush() here at all — the assertion is that this needed none.
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(timers.pendingCount()).toBe(0);

    await tick();
    // The other `filterFormUrl` path (see the search test above) — same argument, and it is
    // the one whose URL a visitor is most likely to want to keep.
    expect(replaceUrl).toHaveBeenCalledWith(fetchPage.mock.calls[0][0]);
  });

  it('UPDATES IMMEDIATELY ON SUBMIT, so pressing Enter in the search field is an in-place update rather than the full-page GET implicit submission would otherwise perform', async () => {
    const { doc, form, fetchPage, timers, deps } = scene();
    fetchPage.mockResolvedValue(pageHtml({ summary: 'Showing 1–2 of 2' }));
    initLiveList(doc, deps);
    const search = form.querySelector<HTMLInputElement>('#q') as HTMLInputElement;

    // A keystroke first, so there is a debounce pending for Enter to supersede: the module
    // only ever listened for `input`, so before PK-70's review this form still had exactly
    // one text-like field, no submit button, and therefore a live implicit submission that
    // navigated away mid-debounce.
    search.value = 'boots';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    expect(timers.pendingCount()).toBe(1);

    const submitted = new Event('submit', { bubbles: true, cancelable: true });
    form.dispatchEvent(submitted);

    // Cancelled, not raced: leaving the timer to fire would issue a second fetch for the
    // query this one already carries.
    expect(submitted.defaultPrevented).toBe(true);
    expect(timers.pendingCount()).toBe(0);
    // No flush anywhere above — an explicit Enter means "go now".
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(new URL(fetchPage.mock.calls[0][0]).searchParams.get('q')).toBe('boots');
    await tick();
  });

  it("intercepts a plain click on a live link: preventDefault, and a fetch from that link's href", async () => {
    const { doc, fetchPage, deps } = scene();
    fetchPage.mockResolvedValue(pageHtml({ summary: 'Showing 1–1 of 1' }));
    initLiveList(doc, deps);
    const link = doc.querySelector(`a[${LIVE_LINK_ATTRIBUTE}="sort:price"]`) as HTMLAnchorElement;

    const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    link.dispatchEvent(event);
    await tick();

    expect(event.defaultPrevented).toBe(true);
    expect(fetchPage).toHaveBeenCalledWith(link.href);
  });

  it('LEAVES A META-CLICK ON A LIVE LINK ALONE, so Cmd/Ctrl-click still opens the sort column in a new tab', async () => {
    const { doc, fetchPage, deps } = scene();
    initLiveList(doc, deps);
    const link = doc.querySelector(`a[${LIVE_LINK_ATTRIBUTE}="sort:price"]`) as HTMLAnchorElement;

    const event = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0,
      metaKey: true,
    });
    link.dispatchEvent(event);
    await tick();

    expect(event.defaultPrevented).toBe(false);
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it('SURVIVES ITS OWN SWAP: a live link rendered by a PREVIOUS update is still intercepted, because the listener is delegated to the document rather than bound to a node that update just replaced', async () => {
    const { doc, fetchPage, deps } = scene();
    fetchPage.mockResolvedValue(pageHtml({ summary: 'Showing 1–1 of 1' }));
    initLiveList(doc, deps);

    // First click swaps the list region's innerHTML — including the pager link the second
    // click below targets, which therefore did not exist when initGearLiveList ran.
    doc
      .querySelector(`a[${LIVE_LINK_ATTRIBUTE}="sort:price"]`)
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    await tick();

    const pagerLink = doc.querySelector(
      `a[${LIVE_LINK_ATTRIBUTE}="page:next"]`,
    ) as HTMLAnchorElement;
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    pagerLink.dispatchEvent(event);
    await tick();

    // A per-link listener bound at init time would be dead here: this anchor is a fresh
    // node the first update's swapLiveRegions call created.
    expect(event.defaultPrevented).toBe(true);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it('DISCARDS AN OUT-OF-ORDER RESPONSE, so a fast keystroke followed by a slow one cannot paint a stale result set over a fresher one', async () => {
    const { doc, form, fetchPage, deps } = scene();
    let resolveFirst!: (html: string) => void;
    let resolveSecond!: (html: string) => void;
    fetchPage
      .mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)))
      .mockImplementationOnce(() => new Promise((resolve) => (resolveSecond = resolve)));
    initLiveList(doc, deps);
    const owned = form.querySelector<HTMLInputElement>('input[name="status"][value="owned"]');
    const wishlist = form.querySelector<HTMLInputElement>('input[name="status"][value="wishlist"]');

    // Two overlapping updates in flight — status changes are immediate, so both fetches are
    // issued before either resolves.
    owned!.dispatchEvent(new Event('change', { bubbles: true }));
    wishlist!.dispatchEvent(new Event('change', { bubbles: true }));
    expect(fetchPage).toHaveBeenCalledTimes(2);

    // The SECOND request's response arrives FIRST and is applied.
    resolveSecond(pageHtml({ summary: 'Showing 1–2 of 2' }));
    await tick();
    expect(liveStatusMessage(doc)).toBe('Showing 1–2 of 2');

    // The FIRST request's response arrives LAST and must be dropped: applying it now would
    // overwrite the newer, already-displayed result with an older one.
    resolveFirst(pageHtml({ summary: 'Showing 1–1 of 1' }));
    await tick();
    expect(liveStatusMessage(doc)).toBe('Showing 1–2 of 2');
  });

  it('FALLS BACK TO navigate() WHEN fetchPage RESOLVES null, so a failed request never leaves the control looking dead', async () => {
    const { doc, form, fetchPage, navigate, replaceUrl, deps } = scene();
    fetchPage.mockResolvedValue(null);
    initLiveList(doc, deps);
    const owned = form.querySelector<HTMLInputElement>('input[name="status"][value="owned"]');

    owned!.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();

    expect(navigate).toHaveBeenCalledTimes(1);
    expect(replaceUrl).not.toHaveBeenCalled();
  });

  it('FALLS BACK TO navigate() WHEN THE SWAP MATCHES ZERO REGIONS, the realistic shape of a session-expiry redirect to sign-in', async () => {
    const { doc, form, fetchPage, navigate, replaceUrl, deps } = scene();
    fetchPage.mockResolvedValue(signInPageHtml());
    initLiveList(doc, deps);
    const owned = form.querySelector<HTMLInputElement>('input[name="status"][value="owned"]');

    owned!.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();

    expect(navigate).toHaveBeenCalledTimes(1);
    expect(replaceUrl).not.toHaveBeenCalled();
  });

  it('FALLS BACK TO navigate() WHEN THE SWAP REFRESHED ONLY SOME OF THE REGIONS, because a page that answers 200 with the header actions and no list is a load error, not a closet', async () => {
    const { doc, form, fetchPage, navigate, replaceUrl, deps } = scene();
    // The load-error render's shape: `#gear-actions` is emitted by EVERY branch of
    // src/pages/gear/index.astro including the error one, `#gear-figures` and `#gear-list`
    // by none of it — and the whole thing still comes back 200 OK with a role="alert" note.
    // `includeList: false` is that shape in this fixture's vocabulary, the headline region
    // standing in for the one region that is always there.
    fetchPage.mockResolvedValue(pageHtml({ includeList: false }));
    initLiveList(doc, deps);
    const owned = form.querySelector<HTMLInputElement>('input[name="status"][value="owned"]');

    owned!.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();

    // One region matched, which is NOT zero — the gate this replaced. Treated as success it
    // would sync the form, rewrite the address bar and announce a count read back off the
    // list it had just failed to replace, leaving the visitor's rows unchanged under a URL
    // claiming otherwise and the server's own error note parsed and discarded.
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(replaceUrl).not.toHaveBeenCalled();
  });

  it('ANNOUNCES THE NEW RANGE, clearing the live region first so an identical message still counts as a content change', async () => {
    const { doc, fetchPage, timers, deps } = scene();
    fetchPage.mockResolvedValue(pageHtml({ summary: 'Showing 1–12 of 47' }));
    initLiveList(doc, deps);
    const liveStatus = doc.getElementById(GEAR_LIVE_STATUS_ID) as HTMLElement;
    // The case this technique exists for, set up rather than described: a sort changes the
    // order and not the range, so the message about to be written is the one already here.
    liveStatus.textContent = 'Showing 1–12 of 47';

    doc
      .querySelector(`a[${LIVE_LINK_ATTRIBUTE}="sort:price"]`)
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    await tick();

    // Assigning the same string to a role="status" region is not reliably re-announced by
    // NVDA or JAWS; blanking it first is what makes the settled value below a real change.
    expect(liveStatus.textContent).toBe('');
    timers.flush();
    expect(liveStatus.textContent).toBe('Showing 1–12 of 47');
  });

  it('ANNOUNCES NO_RESULTS_ANNOUNCEMENT when the swapped list carries no summary line at all, which is what the "no items match" block genuinely renders', async () => {
    const { doc, form, fetchPage, timers, deps } = scene();
    fetchPage.mockResolvedValue(pageHtml({ summary: null }));
    initLiveList(doc, deps);
    const liveStatus = doc.getElementById(GEAR_LIVE_STATUS_ID) as HTMLElement;

    form
      .querySelector<HTMLInputElement>('input[name="status"][value="owned"]')
      ?.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();
    timers.flush();

    // Without this pair of tests the announcement — the only thing a screen-reader visitor
    // gets told about an update that changed nothing they can see — could be deleted
    // outright with the suite green.
    expect(liveStatus.textContent).toBe(NO_RESULTS_ANNOUNCEMENT);
  });

  it("CANCELS A PENDING DEBOUNCED SEARCH ON A LIVE-LINK CLICK, and writes the clicked link's sort into the form before fetching, so a slower search cannot silently undo the sort", async () => {
    const { doc, form, fetchPage, timers, deps } = scene();
    fetchPage.mockResolvedValue(pageHtml({ sort: 'price', dir: 'asc' }));
    initLiveList(doc, deps);
    const search = form.querySelector<HTMLInputElement>('#q') as HTMLInputElement;
    const link = doc.querySelector(`a[${LIVE_LINK_ATTRIBUTE}="sort:price"]`) as HTMLAnchorElement;

    search.value = 'boots';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    expect(timers.pendingCount()).toBe(1);

    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));

    // (a) The debounce is gone rather than left to fire behind this click — the status
    // handler already did this and the click handler did not.
    expect(timers.pendingCount()).toBe(0);
    // (b) SYNCHRONOUSLY, before the fetch has resolved anything: any update that starts in
    // this window reads these hidden inputs through `filterFormUrl`, and reading the
    // pre-click order there is how a click gets undone by nothing but response timing.
    expect((form.elements.namedItem('sort') as HTMLInputElement).value).toBe('price');
    expect(new URL(filterFormUrl(form)).searchParams.get('sort')).toBe('price');
    await tick();
  });

  it('FALLS BACK TO navigate() WHEN replaceUrl ITSELF THROWS, because everything past the fetch used to run outside the guard — and WebKit rate-limits replaceState to a SecurityError that sustained typing can reach', async () => {
    const { doc, form, fetchPage, navigate, replaceUrl, deps } = scene();
    fetchPage.mockResolvedValue(pageHtml());
    replaceUrl.mockImplementation(() => {
      throw new DOMException('rate limit', 'SecurityError');
    });
    initLiveList(doc, deps);

    form
      .querySelector<HTMLInputElement>('input[name="status"][value="owned"]')
      ?.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();

    // The alternative is an unhandled promise rejection and a control that silently does
    // nothing — the exact "dead control" this module's header says it is written against.
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('SCROLLS THE LIST REGION INTO VIEW after a page: link, and NOT after a sort: link', async () => {
    const { doc, fetchPage, scrollIntoView, deps } = scene();
    fetchPage.mockResolvedValue(pageHtml({ summary: 'Showing 13–24 of 47' }));
    initLiveList(doc, deps);
    const listRegion = doc.getElementById(LIST_REGION_ID);

    const sortLink = doc.querySelector(
      `a[${LIVE_LINK_ATTRIBUTE}="sort:price"]`,
    ) as HTMLAnchorElement;
    sortLink.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    await tick();
    expect(scrollIntoView).not.toHaveBeenCalled();

    const pagerLink = doc.querySelector(
      `a[${LIVE_LINK_ATTRIBUTE}="page:next"]`,
    ) as HTMLAnchorElement;
    pagerLink.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }),
    );
    await tick();

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenCalledWith(listRegion);
  });

  it("replaceUrl()s rather than pushing, and syncs the form's sort/dir hidden inputs, on a successful update", async () => {
    const { doc, form, fetchPage, replaceUrl, deps } = scene();
    fetchPage.mockResolvedValue(pageHtml());
    initLiveList(doc, deps);
    const link = doc.querySelector(`a[${LIVE_LINK_ATTRIBUTE}="sort:price"]`) as HTMLAnchorElement;

    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    await tick();

    // syncFilterFormToUrl reads sort/dir from the REQUEST url (the link's own href), not
    // from anything in the fetched response — the hidden inputs mirror what was asked for.
    expect(replaceUrl).toHaveBeenCalledWith(link.href);
    expect((form.elements.namedItem('sort') as HTMLInputElement).value).toBe('price');
  });

  it('the teardown removes every listener it installed, so a click or a keystroke after it does nothing', async () => {
    const { doc, form, fetchPage, deps } = scene();
    fetchPage.mockResolvedValue(pageHtml());
    const teardown = initGearLiveList(doc, deps);

    teardown?.();

    const link = doc.querySelector(`a[${LIVE_LINK_ATTRIBUTE}="sort:price"]`) as HTMLAnchorElement;
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    link.dispatchEvent(event);
    const owned = form.querySelector<HTMLInputElement>('input[name="status"][value="owned"]');
    owned!.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();

    expect(event.defaultPrevented).toBe(false);
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it('the teardown ALSO INVALIDATES AN UPDATE ALREADY IN FLIGHT, so a request that resolves after the feature was switched off cannot navigate the visitor somewhere they did not ask to go', async () => {
    const { doc, form, fetchPage, navigate, replaceUrl, deps } = scene();
    let resolveFetch!: (html: string | null) => void;
    fetchPage.mockImplementation(() => new Promise((resolve) => (resolveFetch = resolve)));
    const teardown = initGearLiveList(doc, deps);

    // In flight, past its `await`, when teardown runs: removing listeners says nothing about
    // a request that has already been issued.
    form
      .querySelector<HTMLInputElement>('input[name="status"][value="owned"]')
      ?.dispatchEvent(new Event('change', { bubbles: true }));
    expect(fetchPage).toHaveBeenCalledTimes(1);

    teardown?.();
    // `null` is the failure path, which is the one with teeth: applied after teardown it
    // calls `navigate` and yanks the visitor to a new page for a feature that was explicitly
    // stopped. Bumping the token makes this response fail the module's own staleness check.
    resolveFetch(null);
    await tick();

    expect(navigate).not.toHaveBeenCalled();
    expect(replaceUrl).not.toHaveBeenCalled();
  });
});
