/**
 * The BROWSER half of the add-to-pack dialog (PK-74): everything
 * `src/components/AddToPackDialog.astro` does once a script has actually run, and nothing
 * it does before one has.
 *
 * Sibling to `src/lib/modal.ts` and written for the same reason: `vitest.config.ts:64`
 * excludes `src/pages/**`, and nothing in this repository reaches into an `.astro` file's
 * `<script>` block at all — not a page's and not a component's. Logic typed there is logic
 * with no test, not by anybody's decision but as a side effect of where it was typed. The
 * component's `<script>` is therefore one import and one call, and every decision it makes
 * is below, under `tests/add-to-pack-dialog.test.ts`.
 *
 * The PURE half of the dialog — which tab it opens on, what its trigger links to, what the
 * "also add to closet" checkbox means, what is remembered — is in
 * `src/lib/packs/add-to-pack.ts` and is imported rather than restated. This module owns only
 * what needs a document: the delegated listeners, the fetch, and the rows that come back.
 *
 * ---------------------------------------------------------------------------
 * EVERY BEHAVIOUR HERE IS AN UPGRADE OF SOMETHING THAT ALREADY WORKS
 * ---------------------------------------------------------------------------
 *
 * This is the inversion `src/pages/gear/index.astro:710-720` sets out and `src/lib/modal.ts`
 * follows: render the working thing unconditionally, upgrade it on the success path, never
 * use `<noscript>` (which guards scripting being ENABLED rather than this script having
 * RUN). Concretely, with none of this module loaded:
 *
 *   - the per-category trigger is `<a href="/packs/<id>?add=<categoryId>">`, which navigates,
 *     and the page server-renders the dialog already open on that category;
 *   - the tab strip is two real links carrying `?tab=`, which navigate;
 *   - closet search is a real `<form method="GET">`, which navigates;
 *   - closet paging is real `<a href>` links, which navigate;
 *   - both submits are real `<form method="POST">` to the pack page.
 *
 * NOTHING HERE SUBMITS A FORM, and that is a rule rather than an omission. A failed POST is
 * recovered by a SERVER ROUND TRIP — the page re-renders with the dialog open and the
 * visitor's values and the server's errors in it — so there is no form state cached in
 * JavaScript that a reload, a Back button or a second tab could disagree with.
 *
 * ---------------------------------------------------------------------------
 * DEGRADING A SECOND TIME, AFTER THE SCRIPT HAS ALREADY RUN
 * ---------------------------------------------------------------------------
 *
 * `degrade()` below is the part that is easy to leave out. Once the search box and the pager
 * links have been intercepted, a failed `fetch` leaves a visitor holding a search field that
 * silently does nothing — the worst of both worlds, because the working GET form is still
 * right there underneath and has merely been switched off. So a failure UNBINDS the
 * interception: the next submit navigates, the next page link navigates, and the visitor is
 * told in one neutral sentence (`CLOSET_LOAD_FAILED_MESSAGE`, the endpoint's own) that the
 * read failed. Never a raw error string, and never a silently emptied list.
 *
 * ---------------------------------------------------------------------------
 * NOT importing src/lib/auth/ OR @supabase/*
 * ---------------------------------------------------------------------------
 *
 * Same rule and same reasons as `src/lib/packs/add-to-pack.ts`'s header: this module ships
 * to the browser, Invariant A in `tests/anonymous-read-path.test.ts` forbids an import edge
 * into `src/lib/auth/` from outside its allowlist, and Invariant D2 forbids anything in the
 * client Rollup pass from being, or importing, an `@supabase/*` package at runtime.
 * Everything imported below is either a string table or a pure function.
 */

import { formatWeight, isWeightSystem, type WeightSystem } from '../units';
import { PACK_EDITOR_FIELD } from './editor';
import { PACK_CLOSET_PATH } from './routes';
import {
  CLOSET_LOAD_FAILED_MESSAGE,
  type ClosetItemPayload,
  type ClosetPagePayload,
} from './closet-response';
import {
  ADD_CATEGORY_PARAM,
  ADD_TAB_PARAM,
  ADD_TO_PACK_MODAL_ID,
  ADD_TO_PACK_TAB_LABELS,
  addToPackHref,
  isAddToPackTab,
  readAlsoAddToCloset,
  writeAlsoAddToCloset,
  type AddToPackTab,
} from './add-to-pack';

// ---------------------------------------------------------------------------
// The markup contract
// ---------------------------------------------------------------------------

/**
 * ONE ATTRIBUTE NAME, NOT FIFTEEN. Every element this module needs to find is marked
 * `data-add-to-pack="<part>"`, so the component's markup and this module's selectors join on
 * a single name plus the `ADD_TO_PACK_PART` table below. The alternative — one bespoke
 * `data-` attribute per part — is fifteen strings that can each drift on their own, and
 * drift here is silent: a renamed attribute leaves `querySelector` returning `null`, the
 * upgrade quietly not happening, and the page still working, which is exactly what the
 * intended degradation looks like from the outside.
 *
 * `tests/add-to-pack-dialog-component.test.ts` renders the component and asserts its markup
 * against these constants, which is what stops the two sides drifting: rename either and the
 * render test fails instead of the feature going dead in silence. It is the same join
 * `tests/modal-component.test.ts` makes for `MODAL_ATTRIBUTE`.
 */
export const ADD_TO_PACK_PART_ATTRIBUTE = 'data-add-to-pack';

export const ADD_TO_PACK_PART = {
  /** The one element wrapping the dialog's body, carrying the three configuration
   *  attributes below. */
  root: 'root',
  /** Every place the acting category's NAME is displayed. With JavaScript one dialog serves
   *  every category, so this text is rewritten before the dialog opens — which is also what
   *  keeps the dialog's ACCESSIBLE name correct, since `Modal.astro` labels the dialog by
   *  its own heading. */
  categoryName: 'category-name',
  /** Every hidden input carrying the acting category's ID — one in the closet form, one in
   *  the new-item form, one in the GET search form. All of them are rewritten together. */
  categoryInput: 'category-input',
  /** A tab in the strip. Also carries `ADD_TO_PACK_TAB_ATTRIBUTE`. */
  tab: 'tab',
  /** A tab's panel. Also carries `ADD_TO_PACK_TAB_ATTRIBUTE`. */
  panel: 'panel',
  /** The `<form method="GET">` that searches the closet without a script. */
  searchForm: 'search-form',
  /** That form's `<input name="q">`. */
  searchInput: 'search-input',
  /** The `<ul>` the closet rows are rendered into. */
  list: 'list',
  /** The `<form method="POST">` around the list — hidden when there is nothing to pick. */
  listForm: 'list-form',
  /** The "your closet is empty" / "nothing matched" sentence. */
  empty: 'empty',
  /** The pager `<nav>`, hidden when there is only one page. */
  pager: 'pager',
  /** The pager's "Page 2 of 5". */
  pagerLabel: 'pager-label',
  /** The pager's two links. Both also carry `ADD_TO_PACK_PAGE_ATTRIBUTE`. */
  pagePrevious: 'page-previous',
  pageNext: 'page-next',
  /** "12 items in your closet." Rewritten after every fetch, because a count left at what
   *  the page was rendered with would contradict the list under it the moment a search
   *  narrowed the closet. */
  count: 'count',
  /** The live region a failed fetch speaks through. */
  status: 'status',
  /** The "also add to closet" checkbox. */
  toggle: 'toggle',
} as const;

export type AddToPackPart = (typeof ADD_TO_PACK_PART)[keyof typeof ADD_TO_PACK_PART];

/** Which tab a `tab`/`panel` element belongs to — one of `ADD_TO_PACK_TABS`. */
export const ADD_TO_PACK_TAB_ATTRIBUTE = 'data-add-to-pack-tab';

/**
 * The page number a pager link goes to, read as a number by the delegated click handler —
 * which is what lets one listener serve both links. Also carried by the `root` element, where
 * it means the page currently SHOWING, so that the first click on "Next" asks for the right
 * page without this module having to parse "Page 2 of 5" back out of a sentence.
 *
 * The delegated handler matches `a[…]` specifically, so a click anywhere in the pager cannot
 * walk up past the links to the root and be read as a request for the page already shown.
 */
export const ADD_TO_PACK_PAGE_ATTRIBUTE = 'data-add-to-pack-page';

/** How many pages the closet has, on the `root` element. Alongside the page above, this is
 *  the whole of the pager's server-rendered state, so the first fetch does not have to guess
 *  what it is replacing. */
export const ADD_TO_PACK_TOTAL_PAGES_ATTRIBUTE = 'data-add-to-pack-total-pages';

/** The pack's own URL path (`packPath(id)`), on the `root` element. Needed because every
 *  href this module rewrites is relative to the pack, and a script cannot read a path off a
 *  component's props. */
export const ADD_TO_PACK_PATH_ATTRIBUTE = 'data-add-to-pack-path';

/** The signed-in visitor's id, on the `root` element — the per-user half of
 *  `alsoAddToClosetKey`, so two accounts sharing a browser do not inherit each other's last
 *  choice. */
export const ADD_TO_PACK_USER_ATTRIBUTE = 'data-add-to-pack-user';

/** The visitor's `WeightSystem`, on the `root` element. The closet endpoint answers in raw
 *  grams on purpose (`src/lib/packs/closet-response.ts`), so the browser has to be told
 *  which system to format them in — and it is told by the page's own server render rather
 *  than by a second read of the account setting. */
export const ADD_TO_PACK_WEIGHT_SYSTEM_ATTRIBUTE = 'data-add-to-pack-weight-system';

/**
 * Present on the toggle when the server has NO opinion about its state — an ordinary render,
 * as opposed to one re-rendered after a rejected submission.
 *
 * WITHOUT THIS MARKER THE REMEMBERED VALUE WOULD OVERWRITE THE ROUND TRIP. A rejected POST
 * comes back with the visitor's own choices re-rendered, including this checkbox; applying
 * `readAlsoAddToCloset` on top of that would silently un-tick a box they had ticked whenever
 * storage is unreadable (Safari private mode reads as "remembered nothing", which is
 * indistinguishable from "remembered false"). The marker says which of the two states on
 * screen is authoritative.
 */
export const ADD_TO_PACK_REMEMBER_ATTRIBUTE = 'data-add-to-pack-remember';

// ---------------------------------------------------------------------------
// The trigger contract
// ---------------------------------------------------------------------------

/**
 * The category id a per-category "Add item" trigger acts on. The trigger is an `<a href>`
 * carrying `data-modal-open="add-to-pack"` (`src/lib/modal.ts`'s `TRIGGER_ATTRIBUTE` and
 * `ADD_TO_PACK_MODAL_ID`) and these two attributes, and its `href` is
 * `addToPackHref(packUrlPath, categoryId)` so that following it with no script server-renders
 * the same dialog.
 */
export const ADD_TO_PACK_CATEGORY_ATTRIBUTE = 'data-add-to-pack-category';

/** The category NAME, on the same trigger. Carried on the trigger rather than looked up from
 *  a table in this module, because the page already has the name rendered and a second copy
 *  of the category list in the client bundle is a second thing to keep in step. */
export const ADD_TO_PACK_CATEGORY_NAME_ATTRIBUTE = 'data-add-to-pack-category-name';

/** The selector a delegated click listener matches a trigger with. */
export const ADD_TO_PACK_TRIGGER_SELECTOR =
  `a[data-modal-open="${ADD_TO_PACK_MODAL_ID}"][${ADD_TO_PACK_CATEGORY_ATTRIBUTE}]` as const;

// ---------------------------------------------------------------------------
// The closet request's own query vocabulary
// ---------------------------------------------------------------------------

/**
 * `?q=` and `?page=`, the two fields of `parseGearQuery`'s vocabulary this dialog actually
 * uses. Named here rather than imported because `src/lib/gear/query.ts` does not export its
 * parameter names — and pinned rather than trusted: `tests/add-to-pack-dialog.test.ts` feeds
 * `closetRequestUrl`'s own output back through `parseGearQuery` and asserts the search and
 * page come out the other side, so a rename there fails a test here instead of producing a
 * dialog that silently ignores every search.
 */
export const CLOSET_SEARCH_PARAM = 'q';
export const CLOSET_PAGE_PARAM = 'page';

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/**
 * The two empty states, which are NOT interchangeable — the same distinction the section
 * this dialog replaces already drew. "Your closet is empty" is a fact about the account and
 * points at the other tab; "nothing matched" is a fact about the search box and points at
 * the search box. Collapsing them tells someone with two hundred closet items that their
 * closet is empty because they typo'd a brand.
 *
 * The tab is named through `ADD_TO_PACK_TAB_LABELS` rather than by repeating the string
 * "New item", so a renamed tab cannot leave this sentence pointing at one that no longer
 * exists — the same join `PACK_LINK_FAILED_MESSAGE` makes in `src/lib/packs/add-to-pack.ts`.
 */
export const CLOSET_EMPTY_MESSAGE =
  `Your closet is empty. Anything you add on the "${ADD_TO_PACK_TAB_LABELS.new}" tab stays ` +
  `in this pack only.`;

export const CLOSET_NO_MATCHES_MESSAGE = 'No closet items match that search.';

// ---------------------------------------------------------------------------
// The row's classes, shared by the server render and the client one
// ---------------------------------------------------------------------------

/**
 * A closet row is rendered TWICE — once by the component on the server, once by this module
 * after a search — and the two have to look identical or a search visibly restyles the list.
 * Naming the classes once, here, and having the component import them is what makes that
 * true by construction rather than by two people remembering.
 */
export const CLOSET_ROW_CLASS = {
  label: 'flex flex-wrap items-baseline gap-x-4 gap-y-1 px-3 py-2 text-sm',
  checkbox: 'checkbox',
  name: 'text-ink written font-medium',
  brand: 'text-ink-3 written',
  weight: 'numeric text-ink-2 ml-auto',
} as const;

/** What a row with no brand shows. An em dash, matching the section this replaces — a blank
 *  cell reads as a rendering fault, and "—" reads as "there isn't one". */
export const CLOSET_ROW_NO_BRAND = '—';

// ---------------------------------------------------------------------------
// Pure decisions
// ---------------------------------------------------------------------------

/**
 * The URL one page of the closet is fetched from. Defaults are OMITTED rather than written
 * out — no `q=` for an empty search, no `page=1` — which mirrors `gearQueryToSearchParams`'s
 * own behaviour and keeps the fetched URL identical to the one the no-script GET form
 * navigates to, so the two paths cannot answer differently.
 */
export function closetRequestUrl(search: string, page: number): string {
  const params = new URLSearchParams();
  if (search !== '') params.set(CLOSET_SEARCH_PARAM, search);
  if (page !== 1) params.set(CLOSET_PAGE_PARAM, String(page));
  const query = params.toString();
  return query === '' ? PACK_CLOSET_PATH : `${PACK_CLOSET_PATH}?${query}`;
}

/**
 * The href a pager link points at — a real URL on the pack page, carrying the dialog's own
 * `?add=`/`?tab=` alongside the closet's `?q=`/`?page=`, so that following it with no script
 * lands on the same page of the same closet with the dialog still open on the same category.
 *
 * USED BY BOTH SIDES: the component renders the first pair of links with it, and this module
 * rewrites them with it after every fetch. One function, so a link the script produced and a
 * link the server produced cannot disagree.
 */
export function closetPageHref(
  packUrlPath: string,
  categoryId: string,
  search: string,
  page: number,
): string {
  const params = new URLSearchParams();
  params.set(ADD_CATEGORY_PARAM, categoryId);
  params.set(ADD_TAB_PARAM, 'closet');
  if (search !== '') params.set(CLOSET_SEARCH_PARAM, search);
  if (page !== 1) params.set(CLOSET_PAGE_PARAM, String(page));
  return `${packUrlPath}?${params.toString()}`;
}

/** What the list area says, and whether there is a list at all. Two empty states, never one
 *  — see `CLOSET_EMPTY_MESSAGE`. */
export function closetListState(
  itemCount: number,
  search: string,
): { readonly hasItems: boolean; readonly emptyMessage: string } {
  return {
    hasItems: itemCount > 0,
    emptyMessage: search === '' ? CLOSET_EMPTY_MESSAGE : CLOSET_NO_MATCHES_MESSAGE,
  };
}

/**
 * How many rows the search currently matches, as a sentence. Singular and plural spelled out
 * rather than "1 item(s)", and the total is the SEARCH's total rather than the closet's —
 * which is what `ClosetPagePayload.totalCount` carries, and what makes this line agree with
 * the page of rows under it instead of contradicting it after every search.
 */
export function closetCountLabel(totalCount: number, search: string): string {
  const noun = totalCount === 1 ? 'item' : 'items';
  return search === ''
    ? `${totalCount} ${noun} in your closet.`
    : `${totalCount} ${noun} match that search.`;
}

/**
 * The pager, from the page the server actually answered with. `page` is deliberately not
 * assumed to be the page that was ASKED for: `loadGearCloset` clamps an over-range page to
 * the real last one (`src/lib/gear/query.ts`), and `ClosetPagePayload` carries the clamped
 * value for exactly this reason.
 */
export function pagerState(
  page: number,
  totalPages: number,
): {
  readonly visible: boolean;
  readonly previous: number | null;
  readonly next: number | null;
  readonly label: string;
} {
  return {
    visible: totalPages > 1,
    previous: page > 1 ? page - 1 : null,
    next: page < totalPages ? page + 1 : null,
    label: `Page ${page} of ${totalPages}`,
  };
}

/** Where an arrow key moves focus in the tab strip, or `null` for a key that is not one of
 *  the four this handles. Wraps at both ends, as the ARIA tabs pattern specifies. */
export function nextTabIndex(current: number, key: string, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case 'ArrowLeft':
    case 'ArrowUp':
      return (current - 1 + count) % count;
    case 'ArrowRight':
    case 'ArrowDown':
      return (current + 1) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

/**
 * WHETHER A RESPONSE THAT HAS JUST ARRIVED IS STILL THE ONE BEING WAITED FOR.
 *
 * This is the whole of the out-of-order guard and it is deliberately a function rather than
 * an inline `if`, because the bug it prevents is invisible: type "tent", then "tents"; the
 * first request is slower; it lands second; the visitor sees the results for "tent" under a
 * search box reading "tents", with nothing anywhere reporting a fault. An `AbortController`
 * alone does NOT close this — abort is best-effort and a response already in flight can
 * still resolve — so the token is the thing that actually decides, and the abort is only a
 * courtesy to the network. `tests/add-to-pack-dialog.test.ts` pins this with a fetch double
 * that ignores its signal, which is the case abort cannot help with.
 */
export function acceptsClosetResponse(token: number, latestToken: number): boolean {
  return token === latestToken;
}

/** What a fetch of the closet endpoint amounted to. */
export type ClosetFetchOutcome =
  | { readonly kind: 'page'; readonly payload: ClosetPagePayload }
  | { readonly kind: 'failed'; readonly message: string };

function isClosetItem(value: unknown): value is ClosetItemPayload {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Partial<ClosetItemPayload>;
  return (
    typeof item.id === 'string' &&
    typeof item.name === 'string' &&
    (item.brand === null || typeof item.brand === 'string') &&
    typeof item.weightGrams === 'number'
  );
}

/**
 * Reads what came back, and never throws whatever it is handed.
 *
 * TOTAL OVER `unknown`, because the four things that can arrive here are not all JSON this
 * endpoint wrote: a 500 from the endpoint's own failure branch, a redirect to sign-in that
 * `fetch` followed and turned into an HTML page, a proxy's error page, and a body that
 * failed to parse at all (passed in as `null`). All four have to become the same readable
 * sentence rather than a thrown `TypeError` inside an event handler, where nothing would
 * catch it and the dialog would simply stop responding.
 *
 * A SERVER-SUPPLIED MESSAGE IS PREFERRED, but only from a body that really carries
 * `{ ok: false, message }` — `src/lib/packs/closet-response.ts` guarantees such a message is
 * a complete, neutral sentence and never a PostgREST string. Anything else falls back to
 * `CLOSET_LOAD_FAILED_MESSAGE`, which is that module's own.
 *
 * `redirected` IS A FAILURE HERE, not a success with odd content: the endpoint answers a
 * signed-out caller with a 303 to sign-in (see `src/pages/packs/closet.ts`), `fetch` follows
 * it, and the 200 that results is a sign-in page. Reporting that as an empty closet would be
 * the silent-empty-list failure this dialog must not have.
 */
export function readClosetResponse(
  status: number,
  redirected: boolean,
  body: unknown,
): ClosetFetchOutcome {
  if (typeof body === 'object' && body !== null) {
    const payload = body as { ok?: unknown; message?: unknown; items?: unknown };
    if (payload.ok === false && typeof payload.message === 'string' && payload.message !== '') {
      return { kind: 'failed', message: payload.message };
    }
    if (
      !redirected &&
      status === 200 &&
      payload.ok === true &&
      Array.isArray(payload.items) &&
      payload.items.every(isClosetItem)
    ) {
      const page = body as unknown as ClosetPagePayload;
      if (
        Number.isFinite(page.page) &&
        Number.isFinite(page.totalPages) &&
        Number.isFinite(page.totalCount)
      ) {
        return { kind: 'page', payload: page };
      }
    }
  }
  return { kind: 'failed', message: CLOSET_LOAD_FAILED_MESSAGE };
}

// ---------------------------------------------------------------------------
// The DOM glue
// ---------------------------------------------------------------------------

export interface AddToPackDialogOptions {
  /** Where the "also add to closet" toggle remembers itself. `null` means "nowhere", which
   *  is a supported state rather than an error — see `readAlsoAddToCloset`. Omitted means
   *  "the browser's own `localStorage`, if reading it does not throw". */
  readonly storage?: Storage | null;
  /** The `fetch` to use. Injected so a test can drive the out-of-order case with a double
   *  that ignores its abort signal, which is the case an `AbortController` cannot cover. */
  readonly fetchImpl?: typeof fetch;
  /** How long the search box waits after the last keystroke. */
  readonly debounceMs?: number;
}

export interface AddToPackDialogHandle {
  /** Detaches every listener this call installed. The markup is left exactly as the server
   *  rendered it in every respect that matters without a script — hrefs, forms, methods — so
   *  a destroyed dialog is a working no-script dialog rather than a dead one. */
  destroy(): void;
}

const DEFAULT_DEBOUNCE_MS = 250;

function partSelector(part: AddToPackPart): string {
  return `[${ADD_TO_PACK_PART_ATTRIBUTE}="${part}"]`;
}

function findPart(scope: ParentNode, part: AddToPackPart): HTMLElement | null {
  const found = scope.querySelector(partSelector(part));
  return found instanceof HTMLElement ? found : null;
}

function findParts(scope: ParentNode, part: AddToPackPart): HTMLElement[] {
  return [...scope.querySelectorAll(partSelector(part))].filter(
    (element): element is HTMLElement => element instanceof HTMLElement,
  );
}

/** `localStorage` behind the try/catch its own header demands: in Safari private mode and
 *  under "block all cookies" the ACCESS throws, not merely the write. */
function defaultStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** The category a trigger names, or `null` for an element that is not one. Both attributes
 *  are required: a trigger with an id and no name would rewrite the heading to an empty
 *  string, leaving the dialog with no accessible name at all. */
export function categoryFromTrigger(
  element: Element | null,
): { readonly id: string; readonly name: string } | null {
  if (element === null) return null;
  const id = element.getAttribute(ADD_TO_PACK_CATEGORY_ATTRIBUTE);
  const name = element.getAttribute(ADD_TO_PACK_CATEGORY_NAME_ATTRIBUTE);
  if (id === null || id === '' || name === null || name === '') return null;
  return { id, name };
}

/**
 * Wires the dialog up. Returns `null` — quietly, and having changed nothing — when there is
 * no dialog in this root, which is the ordinary case on every page that is not a pack page
 * and on a pack with no categories to add to.
 *
 * IT DOES NOT CALL `initModals`. `Modal.astro` ships its own call, opening and closing are
 * entirely that shell's business, and this module deliberately holds no controller: nothing
 * here ever closes the dialog, because nothing here ever submits a form.
 */
export function initAddToPackDialog(
  root: ParentNode,
  options: AddToPackDialogOptions = {},
): AddToPackDialogHandle | null {
  const dialog = root.querySelector(`#${ADD_TO_PACK_MODAL_ID}`);
  if (!(dialog instanceof HTMLElement)) return null;

  const shell = findPart(dialog, ADD_TO_PACK_PART.root);
  if (shell === null) return null;

  const packUrlPath = shell.getAttribute(ADD_TO_PACK_PATH_ATTRIBUTE) ?? '';
  const userId = shell.getAttribute(ADD_TO_PACK_USER_ATTRIBUTE) ?? '';
  const rawSystem = shell.getAttribute(ADD_TO_PACK_WEIGHT_SYSTEM_ATTRIBUTE);
  const weightSystem: WeightSystem = isWeightSystem(rawSystem) ? rawSystem : 'metric';

  const storage = options.storage !== undefined ? options.storage : defaultStorage();
  const fetchImpl = options.fetchImpl ?? globalThis.fetch?.bind(globalThis);
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;

  const ownerDocument = dialog.ownerDocument;

  const categoryNames = findParts(dialog, ADD_TO_PACK_PART.categoryName);
  const categoryInputs = findParts(dialog, ADD_TO_PACK_PART.categoryInput).filter(
    (element): element is HTMLInputElement => element instanceof HTMLInputElement,
  );
  const tabs = findParts(dialog, ADD_TO_PACK_PART.tab);
  const panels = findParts(dialog, ADD_TO_PACK_PART.panel);
  const searchForm = findPart(dialog, ADD_TO_PACK_PART.searchForm);
  const searchInputEl = findPart(dialog, ADD_TO_PACK_PART.searchInput);
  const searchInput = searchInputEl instanceof HTMLInputElement ? searchInputEl : null;
  const list = findPart(dialog, ADD_TO_PACK_PART.list);
  const listForm = findPart(dialog, ADD_TO_PACK_PART.listForm);
  const empty = findPart(dialog, ADD_TO_PACK_PART.empty);
  const pager = findPart(dialog, ADD_TO_PACK_PART.pager);
  const pagerLabel = findPart(dialog, ADD_TO_PACK_PART.pagerLabel);
  const pagePrevious = findPart(dialog, ADD_TO_PACK_PART.pagePrevious);
  const pageNext = findPart(dialog, ADD_TO_PACK_PART.pageNext);
  const count = findPart(dialog, ADD_TO_PACK_PART.count);
  const status = findPart(dialog, ADD_TO_PACK_PART.status);
  const toggleEl = findPart(dialog, ADD_TO_PACK_PART.toggle);
  const toggle = toggleEl instanceof HTMLInputElement ? toggleEl : null;

  /* TWO CONTROLLERS, NOT ONE, and the split is the degradation story. `bound` holds
     everything that must live for as long as the dialog does — the trigger listener and the
     tab strip, neither of which touches the network. `enhanced` holds only the two
     interceptions that replace a real navigation with a fetch, so a failed read can abort
     that one alone and hand the visitor back the GET form and the pager links they started
     with, with the tabs still working. */
  const bound = new AbortController();
  const enhanced = new AbortController();

  const readCount = (attribute: string): number => {
    const value = Number(shell.getAttribute(attribute) ?? '');
    return Number.isInteger(value) && value >= 1 ? value : 1;
  };

  let currentCategoryId = categoryInputs[0]?.value ?? '';
  let currentSearch = searchInput?.value ?? '';
  let lastPage = readCount(ADD_TO_PACK_PAGE_ATTRIBUTE);
  let lastTotalPages = Math.max(lastPage, readCount(ADD_TO_PACK_TOTAL_PAGES_ATTRIBUTE));
  let requestToken = 0;
  let inFlight: AbortController | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  // -------------------------------------------------------------------------
  // 1. The category the dialog is acting on
  // -------------------------------------------------------------------------

  const applyCategory = (id: string, name: string): void => {
    currentCategoryId = id;
    for (const node of categoryNames) node.textContent = name;
    for (const input of categoryInputs) input.value = id;
    for (const tab of tabs) {
      if (!(tab instanceof HTMLAnchorElement)) continue;
      const own = tab.getAttribute(ADD_TO_PACK_TAB_ATTRIBUTE);
      tab.href = addToPackHref(packUrlPath, id, isAddToPackTab(own) ? own : undefined);
    }
    updatePager(lastPage, lastTotalPages);
  };

  /* CAPTURE PHASE, ON THE DOCUMENT, AND THAT IS THE WHOLE POINT OF THE ORDERING. The dialog
     is shared by every category, so the heading and the three hidden inputs must already say
     the right thing at the instant `upgradeTrigger`'s own click listener presents it —
     otherwise the first frame of the dialog names the previous category, and a submit made
     before a rerender would file the item under it. A capturing listener on the document
     runs before a target-phase listener on the trigger, which is exactly the guarantee
     needed, and it is why this is not simply a second listener on the same element.

     IT NEVER CALLS `preventDefault`. `upgradeTrigger` refuses to act on an event that has
     already been default-prevented, so cancelling here would switch the modal off entirely
     and leave a link that navigates — the fallback, reached by accident. The modified-click
     guards mirror that function's own: cmd/ctrl/shift/middle-click are "open this elsewhere"
     gestures, no dialog is about to appear, and rewriting this one for a category it is not
     showing would be a change nobody asked for. */
  ownerDocument.addEventListener(
    'click',
    (event) => {
      if (event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const category = categoryFromTrigger(target.closest(ADD_TO_PACK_TRIGGER_SELECTOR));
      if (category === null) return;
      applyCategory(category.id, category.name);
    },
    { capture: true, signal: bound.signal },
  );

  // -------------------------------------------------------------------------
  // 2. Tabs
  // -------------------------------------------------------------------------

  const tabValue = (element: Element): AddToPackTab | null => {
    const own = element.getAttribute(ADD_TO_PACK_TAB_ATTRIBUTE);
    return isAddToPackTab(own) ? own : null;
  };

  const activateTab = (tab: AddToPackTab, moveFocus: boolean): void => {
    for (const element of tabs) {
      const selected = tabValue(element) === tab;
      element.setAttribute('aria-selected', selected ? 'true' : 'false');
      element.setAttribute('tabindex', selected ? '0' : '-1');
      if (selected && moveFocus) element.focus();
    }
    /* `hidden`, NOT a visually-hidden class. A panel that is merely off-screen keeps its
       fields focusable and its controls reachable, so a Tab press walks into the tab that is
       not showing and a submit button nobody can see is still one keystroke away. `hidden`
       is the platform saying the subtree is not rendered, which is the only version of this
       that is true for a screen reader as well as for a sighted visitor. */
    for (const element of panels) element.hidden = tabValue(element) !== tab;
  };

  for (const element of tabs) {
    element.addEventListener(
      'click',
      (event) => {
        if (event.button !== 0) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        const own = tabValue(element);
        if (own === null) return;
        // Only now, once the panel is genuinely showing, is the navigation cancelled — the
        // same "upgrade on the success path" rule `upgradeTrigger` follows.
        activateTab(own, false);
        event.preventDefault();
      },
      { signal: bound.signal },
    );

    element.addEventListener(
      'keydown',
      (event) => {
        const index = tabs.indexOf(element);
        const target = nextTabIndex(index, event.key, tabs.length);
        if (target === null) return;
        const moved = tabs[target];
        const own = moved === undefined ? null : tabValue(moved);
        if (own === null) return;
        event.preventDefault();
        activateTab(own, true);
      },
      { signal: bound.signal },
    );
  }

  // -------------------------------------------------------------------------
  // 3/4. Searching and paging in place
  // -------------------------------------------------------------------------

  const setStatus = (message: string): void => {
    if (status === null) return;
    status.textContent = message;
    status.hidden = message === '';
  };

  function updatePager(page: number, totalPages: number): void {
    lastPage = page;
    lastTotalPages = totalPages;
    const state = pagerState(page, totalPages);
    if (pager !== null) pager.hidden = !state.visible;
    if (pagerLabel !== null) pagerLabel.textContent = state.label;
    for (const [link, target] of [
      [pagePrevious, state.previous],
      [pageNext, state.next],
    ] as const) {
      if (link === null) continue;
      link.hidden = target === null;
      if (target === null) continue;
      link.setAttribute(ADD_TO_PACK_PAGE_ATTRIBUTE, String(target));
      if (link instanceof HTMLAnchorElement) {
        link.href = closetPageHref(packUrlPath, currentCategoryId, currentSearch, target);
      }
    }
  }

  const renderRows = (items: readonly ClosetItemPayload[]): void => {
    if (list === null) return;
    /* Built element by element with `textContent`, never `innerHTML`. A closet item's name
       and brand are text the visitor typed and the database returned verbatim; assembling
       markup out of them would make an item called `<img onerror=…>` a script this page
       runs. The server render escapes for the same reason without having to say so. */
    const rows = items.map((item) => {
      const row = ownerDocument.createElement('li');
      const label = ownerDocument.createElement('label');
      label.className = CLOSET_ROW_CLASS.label;

      const box = ownerDocument.createElement('input');
      box.type = 'checkbox';
      box.name = PACK_EDITOR_FIELD.gearItemId;
      box.value = item.id;
      box.className = CLOSET_ROW_CLASS.checkbox;

      const name = ownerDocument.createElement('span');
      name.className = CLOSET_ROW_CLASS.name;
      name.textContent = item.name;

      const brand = ownerDocument.createElement('span');
      brand.className = CLOSET_ROW_CLASS.brand;
      brand.textContent = item.brand ?? CLOSET_ROW_NO_BRAND;

      const weight = ownerDocument.createElement('span');
      weight.className = CLOSET_ROW_CLASS.weight;
      // `formatWeight` and nothing else: the endpoint answers in raw grams on purpose, and a
      // second way of turning grams into a string is a second answer to "what does 124.738 g
      // read as", which is the duplication that module's own header argues against.
      weight.textContent = formatWeight(item.weightGrams, weightSystem);

      label.append(box, name, brand, weight);
      row.append(label);
      return row;
    });
    list.replaceChildren(...rows);
  };

  const renderPage = (payload: ClosetPagePayload, search: string): void => {
    currentSearch = search;
    renderRows(payload.items);
    const state = closetListState(payload.items.length, search);
    if (listForm !== null) listForm.hidden = !state.hasItems;
    if (empty !== null) {
      empty.textContent = state.emptyMessage;
      empty.hidden = state.hasItems;
    }
    if (count !== null) count.textContent = closetCountLabel(payload.totalCount, search);
    updatePager(payload.page, payload.totalPages);
    setStatus('');
  };

  /* THE SECOND DEGRADATION. See this module's header: an intercepted search box that has
     stopped being able to fetch is worse than no interception at all, because the working
     GET form is still underneath and has merely been switched off. Aborting `enhanced` puts
     the submit and the pager links back to being a navigation, and the sentence says what
     happened without quoting anything the database said. The rows already on screen are left
     alone — replacing them with an empty list would report a failed read as an empty closet. */
  const degrade = (message: string): void => {
    enhanced.abort();
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = null;
    setStatus(message);
  };

  const loadCloset = async (search: string, page: number): Promise<void> => {
    if (fetchImpl === undefined) return;
    requestToken += 1;
    const token = requestToken;
    inFlight?.abort();
    const controller = new AbortController();
    inFlight = controller;

    try {
      const response = await fetchImpl(closetRequestUrl(search, page), {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      // The guard, before anything is written to the document — see `acceptsClosetResponse`.
      if (!acceptsClosetResponse(token, requestToken)) return;
      const outcome = readClosetResponse(response.status, response.redirected, body);
      if (outcome.kind === 'failed') {
        degrade(outcome.message);
        return;
      }
      renderPage(outcome.payload, search);
    } catch {
      // An abort is this module's own doing and is not a failure to report; anything else is
      // the network, and lands on the same neutral sentence a 500 does.
      if (controller.signal.aborted) return;
      if (!acceptsClosetResponse(token, requestToken)) return;
      degrade(CLOSET_LOAD_FAILED_MESSAGE);
    }
  };

  if (searchForm !== null && searchInput !== null) {
    searchForm.addEventListener(
      'submit',
      (event) => {
        event.preventDefault();
        if (debounceTimer !== null) clearTimeout(debounceTimer);
        debounceTimer = null;
        void loadCloset(searchInput.value, 1);
      },
      { signal: enhanced.signal },
    );

    searchInput.addEventListener(
      'input',
      () => {
        if (debounceTimer !== null) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          debounceTimer = null;
          void loadCloset(searchInput.value, 1);
        }, debounceMs);
      },
      { signal: enhanced.signal },
    );
  }

  if (pager !== null) {
    pager.addEventListener(
      'click',
      (event) => {
        if (event.button !== 0) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        const target = event.target;
        if (!(target instanceof Element)) return;
        const link = target.closest(`a[${ADD_TO_PACK_PAGE_ATTRIBUTE}]`);
        if (link === null) return;
        const page = Number(link.getAttribute(ADD_TO_PACK_PAGE_ATTRIBUTE));
        if (!Number.isInteger(page) || page < 1) return;
        event.preventDefault();
        void loadCloset(currentSearch, page);
      },
      { signal: enhanced.signal },
    );
  }

  // -------------------------------------------------------------------------
  // 5. The remembered toggle
  // -------------------------------------------------------------------------

  if (toggle !== null) {
    // Only when the server has no opinion — see `ADD_TO_PACK_REMEMBER_ATTRIBUTE`. Neither
    // call can throw, whatever the browser's storage is doing.
    if (toggle.hasAttribute(ADD_TO_PACK_REMEMBER_ATTRIBUTE)) {
      toggle.checked = readAlsoAddToCloset(storage, userId);
    }
    toggle.addEventListener(
      'change',
      () => {
        writeAlsoAddToCloset(storage, userId, toggle.checked);
      },
      { signal: bound.signal },
    );
  }

  return {
    destroy() {
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      debounceTimer = null;
      inFlight?.abort();
      enhanced.abort();
      bound.abort();
    },
  };
}
