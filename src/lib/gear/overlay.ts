/**
 * "Add item" and a click on an item row open the gear form OVER the page you were on
 * (PK-71), instead of jumping to `/gear/new` or `/gear/{id}` as a full page — with the
 * closet dimmed behind, the scroll position kept, and both of those URLs still working
 * as ordinary pages for a direct visit, a deep link, a bookmark and a visitor with no
 * JavaScript.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A MODULE AND NOT A `<script>` BLOCK
 * ---------------------------------------------------------------------------
 *
 * `src/lib/modal.ts`'s header makes the whole argument and it is not repeated here: a
 * `<script>` block in an `.astro` file is code nothing in this repository can execute,
 * so logic typed there is logic with no test — not by anybody's decision but as a side
 * effect of where it happened to be typed. Everything below that can be decided without
 * a browser is a small pure function for exactly that reason, and `initGearItemOverlay`
 * is the one impure wiring function they are called from. `src/layouts/Layout.astro`'s
 * script block is one import and one call.
 *
 * ---------------------------------------------------------------------------
 * THE DEVIATION FROM THE SHELL, WHICH IS THE FIRST THING TO KNOW ABOUT THIS FILE
 * ---------------------------------------------------------------------------
 *
 * `src/components/Modal.astro` and `src/lib/modal.ts` were built for content the SERVER
 * renders into the dialog's slots, with the trigger being an `<a data-modal-open="…">`
 * sitting next to a `<Modal>` on the same page. This module does neither: it intercepts
 * a click on any link to a gear item, FETCHES that page, and injects its form into a
 * dialog `src/layouts/Layout.astro` mounted once for the whole site.
 *
 * That is a real departure and it is worth being exact about why, because the shell's
 * own shape is the cheaper thing to reach for. The shell's shape needs a `<Modal>` in
 * every page that links to a gear item — `src/pages/gear/index.astro` (the closet, which
 * is where "Add item" and every item row live) and the pack pages, which link to items
 * too. PK-71 may not touch any of those files: they are being rewritten in parallel by
 * other tickets, and an edit here would either be clobbered or would clobber. So the
 * overlay has to reach them FROM THE OUTSIDE, which means one delegated listener on the
 * document and a dialog mounted in the layout every page already renders through. The
 * pay-off is not only the merge conflict avoided: any page that links to a gear item
 * gets the overlay for free, today and after those rewrites land, without knowing this
 * module exists.
 *
 * WHAT IS NOT DEVIATED FROM. The dialog is driven ONLY through the shell's public
 * handle: `initModals(doc).get(GEAR_OVERLAY_DIALOG_ID)` hands back a `ModalController`
 * and every open and close goes through it. Nothing here calls `showModal()` or
 * `close()` on the element — `Modal.astro`'s header states that the map is the only
 * supported handle and that `ModalController` deliberately does not expose its dialog.
 * The element is looked up here to READ from it (find the slots, choose the initial
 * focus, listen for `close` and for the injected form's `submit`) and for nothing else.
 *
 * AND THE SHELL'S NO-JS GUARANTEE IS UNTOUCHED, which is the invariant that actually
 * matters. Every trigger stays exactly what it was: a real `<a href>` to a real page
 * that renders the same form server-side. If this module never runs — a hashed bundle
 * 404ing after a deploy, a CSP refusing it, an extension, an exception thrown earlier in
 * the same bundle — the link navigates and the visitor gets the page. If it runs on a
 * platform with no `<dialog>` support, `initModals` refuses to wire the dialog, `.get()`
 * answers `undefined`, this function returns `null`, no listener is ever installed and
 * the link navigates. And on the ordinary path the navigation is cancelled only AFTER
 * `openFrom()` has reported that the dialog is genuinely up. That ordering is the single
 * most important rule in this file; see `initGearItemOverlay` where it is enforced.
 *
 * ---------------------------------------------------------------------------
 * THE EVENT CONTRACT, WHICH IS THE ENTIRE INTERFACE TO THE CLOSET
 * ---------------------------------------------------------------------------
 *
 * After a successful save, and AFTER the dialog has closed, this module dispatches
 * `GEAR_ITEM_SAVED_EVENT` on `document` as a `CustomEvent<GearItemSavedDetail>`. A page
 * showing a list of gear may listen for it and refresh its own list.
 *
 * THAT EVENT NAME IS THE ONLY THING SHARED between this ticket and the closet's own
 * ticket. There is no shared component, no shared state, no import in either direction
 * and no file both tickets edit — deliberately, because the closet is being rewritten in
 * parallel and a shared file is a merge conflict with a deadline on it. The closet adds
 * a listener; this module dispatches. Neither has to know anything else about the other.
 * See `GearItemSavedDetail` for what the event carries and why.
 */

import { NEXT_PARAM } from '../auth-routes';
import { focusFirstWithin, initModals } from '../modal';
import { GEAR_IMPORT_PATH, GEAR_NEW_PATH, GEAR_PATH } from './routes';

// ---------------------------------------------------------------------------
// The vocabulary — one definition, read by the pages, the layout and the tests
// ---------------------------------------------------------------------------

/*
 * EXPORTED FOR THE REASON `src/lib/modal.ts` GIVES ABOVE ITS OWN SIX, and the failure
 * mode is identical: rename either side of one of these joins and every test in the
 * suite stays green while the feature is silently dead — the page renders one attribute,
 * this module looks for another, no form is ever found, and the only symptom is that
 * clicking a link navigates, which is also exactly what the degradation path is supposed
 * to look like. `src/layouts/Layout.astro` imports the three it needs; the pages and
 * `src/components/GearItemForm.astro` write the others as literals in their markup (the
 * same trade `Modal.astro` makes and for the same reason — an attribute spread in markup
 * costs more legibility than the join is worth) and their own comments name this module.
 */

/** The `id` of the one dialog the whole site shares for this. `Layout.astro` renders it;
 *  `initModals` keys the controller map by it. */
export const GEAR_OVERLAY_DIALOG_ID = 'gear-item-overlay';

/** The `id` given to the injected form AT RUNTIME, so the submit button moved into the
 *  modal's footer can point at it with HTML's `form="…"` attribute. See
 *  `prepareInjectedForm` for why it is assigned here and never server-rendered. */
export const GEAR_OVERLAY_FORM_ID = 'gear-item-overlay-form';

/** On the `<form>` in `src/components/GearItemForm.astro`. The one element whose presence
 *  decides whether a fetched page can be shown in the dialog at all. */
export const OVERLAY_FORM_ATTRIBUTE = 'data-gear-overlay-form';

/** On that form's submit button, which is moved into the modal's actions footer. */
export const OVERLAY_SUBMIT_ATTRIBUTE = 'data-gear-overlay-submit';

/** On that form's Cancel link, which is REMOVED — the modal supplies its own dismissal. */
export const OVERLAY_CANCEL_ATTRIBUTE = 'data-gear-overlay-cancel';

/** On each page's `<h1>`. Its text becomes the dialog's heading, and therefore the
 *  dialog's accessible name — see `Layout.astro` on why that is a `title` slot. */
export const OVERLAY_TITLE_ATTRIBUTE = 'data-gear-overlay-title';

/** On each page's error banners, and ONLY those: not on `[id].astro`'s "Saved." status
 *  and not on its delete confirmation. Both pages' own comments say so at the markup. */
export const OVERLAY_NOTICE_ATTRIBUTE = 'data-gear-overlay-notice';

/** The dialog's default slot, in `Layout.astro`: where the notices and the form go. */
export const OVERLAY_BODY_ATTRIBUTE = 'data-gear-overlay-body';

/** The dialog's actions slot, in `Layout.astro`: where the submit button goes. */
export const OVERLAY_ACTIONS_ATTRIBUTE = 'data-gear-overlay-actions';

/** The placeholder `<span>` in the dialog's `title` slot, whose text is replaced per
 *  item. */
export const OVERLAY_HEADING_ATTRIBUTE = 'data-gear-overlay-heading';

// ---------------------------------------------------------------------------
// The event contract
// ---------------------------------------------------------------------------

/**
 * Dispatched on `document` after a gear item has been created or edited through the
 * overlay — and only after the dialog has already closed.
 *
 * NAMESPACED, because a `CustomEvent` name is a global string on a shared `document` and
 * `gear-item-saved` is the kind of name two unrelated scripts pick independently.
 */
export const GEAR_ITEM_SAVED_EVENT = 'packsheet:gear-item-saved';

/**
 * What that event carries.
 *
 * `id` is the item the server actually wrote, read back off the redirect it answered
 * with rather than guessed at — see `savedDetailFrom`, and `submissionBody` for the one
 * thing this module has to do to the submission to keep that redirect readable.
 *
 * `created` distinguishes an insert from an edit, which is the fact a listening list
 * cannot work out for itself: an edit changes a row it is already showing (it can update
 * that row in place, or re-fetch), while a create adds one that may not belong in the
 * view at all — saved as `owned` while the view filters `wishlist`, or on page 3, or
 * under a search the new name does not match. Only the listener can decide what to do
 * about that, and it needs to be told which case it is in.
 *
 * DELIBERATELY NOT THE ITEM ITSELF. Sending the saved row would mean this module
 * inventing a serialisation of `gear_items` for a consumer it does not import and cannot
 * see, and every listener would then be coupled to that shape. An id and a flag are the
 * two facts a listener genuinely cannot derive; everything else it can fetch.
 */
export interface GearItemSavedDetail {
  readonly id: string;
  readonly created: boolean;
}

// ---------------------------------------------------------------------------
// overlayTargetFor
// ---------------------------------------------------------------------------

/** A link this overlay is willing to handle: the URL to fetch, and the item it names
 *  (`null` for the create form, which names no item yet). */
export interface OverlayTarget {
  /** Absolute, same-origin, fragment stripped. Used both as the `fetch` URL and as the
   *  injected form's `action` — see `prepareInjectedForm` for why those must be the same
   *  string. */
  readonly url: string;
  /** The `{id}` of `/gear/{id}`, or `null` for `/gear/new`. */
  readonly itemId: string | null;
}

/**
 * Decides whether a link's `href` is one of the two pages this overlay can present, and
 * resolves it. `null` for everything else, which is the answer that leaves the link
 * alone — a delegated listener on `document` sees EVERY link on the site, so this
 * function's refusals are what keep the overlay from swallowing navigation it has no
 * business in.
 *
 * BUILT ON `URL`, NEVER ON STRING SURGERY, and that is not tidiness. The thing being
 * decided is "is this same-origin, and is its path one of two shapes" — and a
 * `startsWith('/gear/')` test answers both questions wrongly for inputs a page can
 * legitimately contain: `https://evil.example/gear/1` is not this site, `//evil.example`
 * is a protocol-relative URL to somewhere else entirely, and `/gear/1#notes` and
 * `/gear/1?next=/gear%3Fq%3Dtent` are this site with parts a substring test will mangle.
 * `safeNextPath` in `src/lib/auth-routes.ts` carries the long version of that argument
 * for the parameter it guards; this is the same class of decision and gets the same
 * treatment. The one difference is the failure mode: a refusal here is not a security
 * hole, it is a full-page navigation, which is what the link did before this ticket.
 *
 * THE ORIGIN CHECK REFUSES AN OPAQUE ORIGIN OUTRIGHT. A document loaded from `data:` or
 * `about:blank` has origin `"null"`, and `"null" === "null"` would read as same-origin
 * for a target that is nothing of the kind. There is no such document in this product,
 * and the check costs one line.
 *
 * THE QUERY STRING SURVIVES AND THE FRAGMENT DOES NOT. A link into the form legitimately
 * carries `?next=…` (`gearFormHrefReturningTo` in `src/lib/gear/return-path.ts` builds
 * exactly that, so that Cancel and Save return the visitor to the closet view they came
 * from) and dropping it would silently change where the fetched page thinks it should go
 * back to. A fragment is never sent to a server and has no meaning for a form action, so
 * carrying it into either would be noise.
 *
 * `/gear`, `/gear/import` AND `/gear/1/anything` ARE REFUSED, by name and by shape
 * respectively. The closet list and the JSON importer are whole pages with their own
 * navigation, tables and file inputs — a modal is the wrong container for either, and
 * `/gear/import` in particular is the one page in this directory whose form has a FILE
 * input, which `submissionBody` cannot encode. Both are compared against the constants in
 * `src/lib/gear/routes.ts` rather than to literals, so a future move of either path
 * cannot leave a stale exclusion behind.
 */
export function overlayTargetFor(href: string, base: string): OverlayTarget | null {
  let origin: URL;
  let resolved: URL;
  try {
    origin = new URL(base);
    resolved = new URL(href, base);
  } catch {
    // A base that is not absolute, or an href that resolves to nothing — `mailto:`,
    // `javascript:`, a malformed string a page put in an attribute. Not ours.
    return null;
  }

  if (resolved.origin === 'null' || resolved.origin !== origin.origin) return null;

  /*
   * `next` IS STRIPPED HERE, AT THE ONE CHOKE POINT, AND THIS IS NOT TIDYING.
   *
   * The closet links to the form as `/gear/new?next=%2Fgear` so that an ordinary
   * full-page save returns the visitor to the view they came from. The overlay wants the
   * opposite: it is not navigating anywhere, and it needs the server to answer a save by
   * redirecting to the item's own `/gear/{id}` — that redirect is the only way the id of
   * a NEWLY CREATED item ever reaches the client, and `savedDetailFrom` reads it off the
   * response URL.
   *
   * Dropping the hidden `next` FIELD from the POST body is not enough on its own, and
   * this was found in a browser rather than reasoned about: both pages resolve the return
   * path with `gearReturnPathFromFormOrNull(form, url)`, which reads the form field first
   * and then FALLS BACK TO THE QUERY STRING of the URL being posted to. Post to
   * `/gear/new?next=%2Fgear` with no `next` field and the page still finds `next` in its
   * own URL, still redirects to `/gear`, and the save — which really did happen — reads
   * back as "this redirect names no gear item", so nothing is announced and the visitor
   * is bounced to the closet. Removing the parameter from the URL the overlay fetches and
   * posts to closes both halves at once: the fetched page renders no hidden field either,
   * so the body and the query string agree by construction rather than by two separate
   * deletions that could drift apart.
   *
   * Nothing is lost. `next` exists to say where to go after saving, and the overlay's
   * whole point is that the visitor never left.
   */
  const search = new URLSearchParams(resolved.search);
  search.delete(NEXT_PARAM);
  const query = search.toString();
  const url = `${resolved.origin}${resolved.pathname}${query === '' ? '' : `?${query}`}`;

  if (resolved.pathname === GEAR_NEW_PATH) return { url, itemId: null };
  if (resolved.pathname === GEAR_IMPORT_PATH) return null;
  if (!resolved.pathname.startsWith(`${GEAR_PATH}/`)) return null;

  // Exactly one further segment. `/gear` never reaches here (it does not carry the
  // trailing slash the test above requires), `/gear/` leaves an empty id, and
  // `/gear/1/edit` leaves a slash — all three are refused by these two clauses.
  const itemId = resolved.pathname.slice(GEAR_PATH.length + 1);
  if (itemId === '' || itemId.includes('/')) return null;

  // NOT percent-decoded. The id is a uuid the server round-trips verbatim, so decoding
  // could only ever change a value that was never going to be valid anyway — and
  // `decodeURIComponent` throws on a malformed sequence, which would turn a stray link
  // into an exception inside a click handler rather than into a plain navigation.
  return { url, itemId };
}

// ---------------------------------------------------------------------------
// isPlainLeftClick
// ---------------------------------------------------------------------------

/**
 * Whether this click is the one gesture a modal can honour: an unmodified press of the
 * primary button that nothing else has already claimed.
 *
 * THIS IS `upgradeTrigger`'S LIST, VERBATIM (`src/lib/modal.ts`), and the two must not
 * be allowed to drift: a visitor who Cmd-clicks "Add item" on the closet and Cmd-clicks
 * a `data-modal-open` trigger somewhere else must get the same behaviour from both. The
 * shell's own reasoning is the reasoning here — Cmd/Ctrl-click, Shift-click and
 * middle-click are the browser's "open this somewhere else" gestures, and swallowing
 * them would break open-in-new-tab on a control that still looks exactly like a link,
 * which it is. `defaultPrevented` is in the list for the same reason it is in the
 * shell's: something closer to the link has already handled this click and said so.
 *
 * WHAT IS DELIBERATELY NOT HERE: `target` and `download`. Both are properties of the
 * LINK, not of the event, and the shell asks about `target` at its own trigger for
 * exactly that reason. The caller checks both — see `initGearItemOverlay`. `download` is
 * the one addition the delegated form needs and the shell has no use for: a bound
 * trigger is one known anchor, while this listener sees every link on the page.
 */
export function isPlainLeftClick(event: MouseEvent): boolean {
  if (event.defaultPrevented) return false;
  if (event.button !== 0) return false;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
  return true;
}

// ---------------------------------------------------------------------------
// extractOverlayContent
// ---------------------------------------------------------------------------

/** The three pieces of a fetched gear page the dialog shows, already imported into the
 *  live document and ready to be inserted. */
export interface OverlayContent {
  /** The page's `<h1>` text, or `null` when the page had none or it was blank — in which
   *  case the caller keeps the dialog's placeholder heading rather than blanking the
   *  dialog's accessible name. */
  readonly title: string | null;
  /** Every error banner the page rendered, in document order. Usually empty on the open
   *  path and non-empty after a submit the server refused. */
  readonly notices: readonly Element[];
  readonly form: HTMLFormElement;
}

/**
 * Parses a fetched page and lifts out the three things the dialog needs.
 *
 * A DETACHED DOCUMENT, WHICH IS THE WHOLE POINT OF USING `DOMParser` HERE. The response
 * is a full HTML page — `<html>`, `<head>`, its own `<script>` tags, the site nav — and
 * the only safe way to reach into it is to parse it somewhere inert. A document produced
 * by `parseFromString` does not run scripts, does not fetch subresources and is not in
 * any browsing context; `importNode` then copies only the subtrees named below into the
 * live document. Assigning the response text to an `innerHTML` somewhere would do
 * something quite different and much worse.
 *
 * `null` WHEN THERE IS NO FORM, and the caller's answer to that is to navigate to the
 * link rather than to present an empty dialog. That is not a theoretical branch: the
 * fetch can perfectly well answer 200 with a page that has no gear form in it — a
 * session that expired between page load and click lands on the sign-in page, and a
 * `/gear/{id}` for an item that has gone answers 404 with a body. In every one of those
 * the visitor asked for a page, and the honest thing is to give it to them.
 *
 * `/gear/{id}` CONTAINS A SECOND FORM AND IT MUST NEVER COME THROUGH HERE. The delete
 * form at the foot of that page is a `<form method="POST">` like the edit form, and it
 * deliberately carries no overlay attribute — see that page's own comment beside it. A
 * selector of `form` or `form[method="POST"]` would find whichever came first in the
 * document and could put the DELETE form in front of a visitor who clicked an item name.
 * The attribute is the contract precisely so that cannot happen; `form[…]` below is
 * anchored on it and on the tag name together.
 */
export function extractOverlayContent(html: string, into: Document): OverlayContent | null {
  // The live document's own parser when there is one, so the nodes below are constructed
  // by the same realm `into` belongs to; the global otherwise (a detached `into`).
  const Parser = into.defaultView?.DOMParser ?? DOMParser;
  const parsed = new Parser().parseFromString(html, 'text/html');

  const form = parsed.querySelector(`form[${OVERLAY_FORM_ATTRIBUTE}]`);
  if (form === null) return null;

  const title = parsed.querySelector(`[${OVERLAY_TITLE_ATTRIBUTE}]`)?.textContent?.trim() ?? '';
  const notices = [...parsed.querySelectorAll(`[${OVERLAY_NOTICE_ATTRIBUTE}]`)].map((notice) =>
    into.importNode(notice, true),
  );

  return {
    title: title === '' ? null : title,
    notices,
    // The cast is sound because the SELECTOR pinned the tag name: `form[…]` matches
    // nothing but a `<form>`, and `importNode` builds the copy with `into`'s own classes.
    // An `instanceof HTMLFormElement` here would be the weaker check, not the stronger
    // one — it asks about the realm the constructor came from rather than about the
    // element, and answers `false` for a perfectly good form imported across realms.
    form: into.importNode(form, true) as HTMLFormElement,
  };
}

// ---------------------------------------------------------------------------
// prepareInjectedForm
// ---------------------------------------------------------------------------

/**
 * Makes an extracted form submittable from inside the modal, and hands back the button
 * that will do it. `null` when the form carries no submit control, which the caller
 * treats exactly as it treats a page with no form at all.
 *
 * THE `action` IS SET, AND THAT IS THE WHOLE REASON THIS FUNCTION EXISTS. A
 * `<form method="POST">` with no `action` posts to the CURRENT URL — which is what makes
 * it correct on the page it was rendered on, and catastrophic here: the current URL is
 * whatever page the visitor happened to be on when they clicked, so the edit for item 7
 * would be POSTed at the closet list, or at a pack, or at the account screen. The form
 * has to keep pointing at the page it was FETCHED from, and only the caller knows what
 * that was, so it is passed in. (Nothing is submitted natively anyway — the caller
 * intercepts `submit` and fetches — but `form.action` is exactly where that handler
 * reads the destination from, so this is the one place it is decided.)
 *
 * THE `id` IS ASSIGNED AT RUNTIME RATHER THAN SERVER-RENDERED, deliberately. HTML's
 * `form="…"` attribute is what lets the submit button live in the modal's footer while
 * the `<form>` lives in the modal's body — a slot cannot span two slots, which
 * `Modal.astro`'s header already sets out. That join needs an id. But the form is
 * rendered by a component two ordinary pages also render: put the id in the markup and
 * `/gear/new` visited directly would contain an element with this id, and then opening
 * the overlay from that same page — which is a thing a visitor can do — would put a
 * SECOND element with the same id in the document. `getElementById` and the `form="…"`
 * association would both then resolve to whichever the browser saw first, which is the
 * one behind the dialog. Assigning it to the copy, here, means the id exists only on the
 * copy that is about to be shown.
 *
 * THE CANCEL LINK IS REMOVED, not hidden. The modal already has three dismissals of its
 * own (ESC, the backdrop, and the header's close button, which is a native
 * `<form method="dialog">` needing no script) and a fourth control that navigates the
 * whole page instead of closing the dialog is not a Cancel, it is a trapdoor. It is
 * removed rather than `hidden` so it is also out of the Tab order and out of the
 * accessibility tree, rather than relying on `focusableWithin`'s attribute checks to
 * keep it out of the trap.
 */
export function prepareInjectedForm(form: HTMLFormElement, action: string): HTMLElement | null {
  form.id = GEAR_OVERLAY_FORM_ID;
  form.action = action;

  form.querySelector(`[${OVERLAY_CANCEL_ATTRIBUTE}]`)?.remove();

  const submit = form.querySelector(`[${OVERLAY_SUBMIT_ATTRIBUTE}]`);
  // `instanceof HTMLElement` is safe here in a way it is not in `extractOverlayContent`:
  // this node was built by `importNode` into the live document, so it is an instance of
  // the same realm's classes this module was loaded into. `focusableWithin` in
  // `src/lib/modal.ts` makes the identical check for the identical reason.
  if (!(submit instanceof HTMLElement)) return null;

  submit.setAttribute('form', GEAR_OVERLAY_FORM_ID);
  return submit;
}

// ---------------------------------------------------------------------------
// submissionBody
// ---------------------------------------------------------------------------

/**
 * The body to POST for this form: everything the visitor typed, minus `next`.
 *
 * `URLSearchParams` RATHER THAN `FormData`, which decides the wire format. A `FormData`
 * body is sent as `multipart/form-data`; a `URLSearchParams` body is sent as
 * `application/x-www-form-urlencoded`, which is byte-for-byte what a native submit of
 * this form would have sent. Both pages read the submission with
 * `Astro.request.formData()`, which parses either — so this is not about what the server
 * can accept, it is about not making the server handle a second encoding for no reason.
 * The form has no file input (`src/components/GearItemForm.astro`'s header records that
 * the photo field is Ref 10's and deliberately absent), and a file is the only thing
 * urlencoded cannot carry. If one is ever added, THIS is the function that has to change
 * — which is why the loop below skips a non-string entry rather than stringifying it
 * into `[object File]` and posting a lie.
 *
 * `next` IS DROPPED, AND THAT IS LOAD-BEARING RATHER THAN TIDY. The hidden `next` field
 * carries the closet view the visitor came from, and both pages honour it on success by
 * redirecting THERE (`src/pages/gear/new.astro` and `src/pages/gear/[id].astro` each
 * fork on it). That is exactly right for a full-page submit and exactly wrong here: the
 * visitor is not going anywhere — they are looking at the page behind the dialog — and a
 * redirect to `/gear?status=owned&page=3` tells this module nothing about which item was
 * written. Dropping it makes the server take its OTHER branch, the one that lands on the
 * item's own canonical `/gear/{id}`, which is what `savedDetailFrom` reads the id back
 * off. The visitor loses nothing: they never left the view `next` would have returned
 * them to.
 */
export function submissionBody(form: HTMLFormElement): URLSearchParams {
  const body = new URLSearchParams();
  for (const [name, value] of new FormData(form)) {
    if (typeof value !== 'string') continue;
    body.append(name, value);
  }
  body.delete(NEXT_PARAM);
  return body;
}

// ---------------------------------------------------------------------------
// savedDetailFrom
// ---------------------------------------------------------------------------

/**
 * Works out which item was just written, from the URL the POST's redirect landed on.
 *
 * READ BACK, NOT ASSUMED. For an edit the id is already known, but for a create it is
 * the database's answer and nothing on the client can predict it —
 * `src/pages/gear/new.astro` inserts, reads the new row's id back with
 * `.select('id').single()`, and redirects to `/gear/{id}` with a 303. That redirect IS
 * the receipt, and `submissionBody` drops `next` precisely so the server takes that
 * branch and the receipt is legible.
 *
 * THE LANDING URL IS THE ONLY EVIDENCE, AND AN ALREADY-KNOWN ID IS NOT A SUBSTITUTE FOR
 * IT. The tempting shortcut is to fall back to `requestedItemId` whenever the redirect
 * target cannot be read — for an edit that id is known before the request is even sent,
 * so it always looks available. It is a lie in the one case that matters. Both pages
 * bounce a request with no session to `/sign-in?next=…` (`src/pages/gear/new.astro`,
 * `src/pages/gear/[id].astro`), and they do it ABOVE their own POST branch, so an
 * expired session answers a save with a redirect that wrote nothing at all. With the
 * fallback in place that redirect reads as success, and an EDIT — where `requestedItemId`
 * is set — closes the dialog and announces a save of an item the server never touched,
 * discarding what the visitor typed on the way. So: no id in the landing URL, no event.
 *
 * `null` THEREFORE MEANS "THIS REDIRECT IS NOT A RECEIPT", not merely "the id was hard
 * to find", and the caller treats it as the session bounce it almost always is — see
 * `save`, which hands the visitor the page the browser would itself have landed on had
 * this been an ordinary form submit.
 *
 * `created` IS DECIDED BY WHAT WAS REQUESTED, not by what came back. "Did this
 * submission go to the create form" is a fact this module knows for certain from the
 * link it intercepted; inferring it from the response would mean asking whether the id
 * changed, which is not the same question and answers wrongly the moment the fallback
 * above is used.
 *
 * ONE MORE BOUNCE THE PATH SHAPE ALONE CANNOT TELL FROM A RECEIPT, found after the
 * fallback above was already fixed: a genuinely EXPIRED session lands on `/sign-in`,
 * which is not a gear path and is already refused — but a session that only BLIPS,
 * expiring for the one check the middleware makes and being good again by the time
 * sign-in's own redirect is followed, lands back on `/gear/{id}` having written
 * NOTHING, and that URL has the same shape a receipt does. For an edit this is
 * distinguishable, because `next` is always stripped: `src/pages/gear/[id].astro`'s
 * success branch therefore always takes its `returnPath === null` fork and always
 * redirects to `/gear/{id}?updated=1` — never a bare `/gear/{id}` — while the bounce
 * lands on the bare path (sign-in's `next` is the request's own path, captured before
 * anything was written). Requiring `updated=1` for an edit is what a bounce cannot
 * produce and a write always does. A create needs no such check: its own bounce lands
 * back on `/gear/new` (sign-in's `next` there), which names no item at all and is
 * already refused by the `landed.itemId === null` test below.
 */
export function savedDetailFrom(
  responseUrl: string,
  base: string,
  requestedItemId: string | null,
): GearItemSavedDetail | null {
  const landed = overlayTargetFor(responseUrl, base);
  if (landed === null || landed.itemId === null) return null;

  if (requestedItemId !== null) {
    const updated = new URL(responseUrl, base).searchParams.get('updated') === '1';
    if (!updated) return null;
  }

  return { id: landed.itemId, created: requestedItemId === null };
}

// ---------------------------------------------------------------------------
// The wiring
// ---------------------------------------------------------------------------

/** Shown in the dialog between the click and the fetched form arriving. */
const LOADING_MESSAGE = 'Loading…';

/**
 * Shown INSIDE the dialog when the POST could not be made or its answer could not be
 * read. It says the save did not reach us and to try again — and it says nothing about
 * whether the write happened, because a request that failed after the server received it
 * is indistinguishable from one that never arrived. `src/lib/gear/bulk.ts`'s
 * `GEAR_DELETE_FAILED_MESSAGE` carries the same caution for the same reason.
 */
const SAVE_UNREACHABLE_MESSAGE =
  'We could not reach the server to save this. Nothing you typed has been lost — try again.';

/**
 * Shown instead of `SAVE_UNREACHABLE_MESSAGE` when the server WAS reached and refused
 * the request outright — a 4xx or 5xx with no redirect, which is not the same failure
 * and should not carry the same claim. `loadInto`'s `!response.ok` check on the GET
 * already treats this as "show the visitor the real page instead"; a POST cannot do
 * that (there is nowhere safe to navigate a rejected write to), so it stays in the
 * dialog with a message that is honest about what happened: the request landed, the
 * server said no. Nothing typed is touched either way.
 */
const SAVE_REJECTED_MESSAGE =
  'The server refused this save. Nothing you typed has been lost — check the details and try again.';

/**
 * Marks the notice THIS module builds, so a retry replaces its own previous notice
 * rather than stacking a second one.
 *
 * NOT `OVERLAY_NOTICE_ATTRIBUTE`, deliberately, even though the markup is otherwise
 * identical. That attribute's contract is "a banner the SERVER rendered, which the
 * overlay lifts out of a fetched page", and the two must stay distinguishable: sweeping
 * every `[data-gear-overlay-notice]` out of the dialog before showing this one would
 * delete the "Fix the following before saving" summary from a previous failed submit,
 * while the fields it refers to are still on screen and still wrong.
 */
const UNREACHABLE_NOTICE_ATTRIBUTE = 'data-gear-overlay-unreachable';

/**
 * Mounts the overlay on a document. Returns the function that detaches everything it
 * installed, or `null` when this document has no usable overlay dialog — which is the
 * ordinary answer on a platform with no `<dialog>` support, and the answer that leaves
 * every gear link an ordinary working link.
 *
 * `options.fetch` exists so a test can drive the whole flow without a network; the
 * default is the document's own `fetch`, bound to its window because an unbound `fetch`
 * throws `Illegal invocation`.
 */
export function initGearItemOverlay(
  doc: Document,
  options?: { readonly fetch?: typeof globalThis.fetch },
): (() => void) | null {
  const view = doc.defaultView;
  if (view === null) return null;

  const fetchPage =
    options?.fetch ?? (typeof view.fetch === 'function' ? view.fetch.bind(view) : undefined);
  if (fetchPage === undefined) return null;

  /*
   * `initModals` AGAIN, AND THE MAP IS THE ONLY HANDLE. `Modal.astro`'s own script has
   * already run this over the same document; calling it a second time is the supported
   * way to get a controller, and it is idempotent and additive — an already-wired dialog
   * hands back the SAME controller instance, never a second one over the same element.
   * `undefined` here means there is no wired dialog with this id: no `<Modal>` was
   * rendered, or `supportsModalDialog` refused this platform. Both end the same way and
   * that ending is correct — no listener, and every link navigates.
   */
  const controller = initModals(doc).get(GEAR_OVERLAY_DIALOG_ID);
  if (controller === undefined) return null;

  const dialog = doc.getElementById(GEAR_OVERLAY_DIALOG_ID);
  if (dialog === null) return null;

  const heading = dialog.querySelector(`[${OVERLAY_HEADING_ATTRIBUTE}]`);
  const body = dialog.querySelector(`[${OVERLAY_BODY_ATTRIBUTE}]`);
  const actions = dialog.querySelector(`[${OVERLAY_ACTIONS_ATTRIBUTE}]`);
  if (heading === null || body === null || actions === null) {
    // A wiring bug in `Layout.astro`, and the only one that is otherwise SILENT: the
    // controller exists, so the dialog would open — onto an empty sheet with no way to
    // put anything in it. Returning `null` keeps every link working; the warning is what
    // turns a three-day diagnosis into a ten-minute one.
    console.warn(
      `[gear-overlay] #${GEAR_OVERLAY_DIALOG_ID} is missing its ${OVERLAY_HEADING_ATTRIBUTE}, ` +
        `${OVERLAY_BODY_ATTRIBUTE} or ${OVERLAY_ACTIONS_ATTRIBUTE} slot, so there is nowhere ` +
        `to render a gear form. Leaving every gear link as a plain link.`,
      dialog,
    );
    return null;
  }

  // The dialog's own heading text, kept so it can be restored — the dialog is mounted on
  // every page and must not be left carrying the last item's name.
  const placeholderHeading = heading.textContent ?? '';

  const listeners = new AbortController();
  const { signal } = listeners;

  /*
   * WHICH OPEN THE DIALOG IS CURRENTLY SHOWING. Every `await` below is a window in which
   * the visitor can press ESC, or click a second item, and both used to end badly: a
   * fetch that resolved after a dismissal would inject a form into a closed dialog and
   * pull focus into it, and a failed fetch would call `location.assign` and navigate a
   * visitor away from the page they had just returned to. Neither throws and neither
   * logs. Bumping this on every open and on every close, and checking it after every
   * await, is the whole guard.
   *
   * NOT AN `AbortController` PER REQUEST, which is the other way to do this. Aborting
   * would also stop the request, which is worth something — but only for the GET, and it
   * would put the cancellation inside a `fetch` option that `options.fetch` is under no
   * obligation to honour, so the check would still have to exist here as well. One
   * counter that the test double cannot get wrong is the smaller mechanism.
   */
  let generation = 0;

  /** The item the open dialog is showing, so a submit knows what it was editing. */
  let openTarget: OverlayTarget | null = null;

  /** The submit button currently living in the modal's footer, so it can be disabled. */
  let injectedSubmit: HTMLElement | null = null;

  /** Whether a POST is in flight. The visible half of this is the disabled button; this
   *  flag is the half that actually holds, because Enter in a text field submits a form
   *  whose submit button is disabled just fine. */
  let submitting = false;

  const setHeading = (title: string | null) => {
    heading.textContent = title ?? placeholderHeading;
  };

  const showLoading = () => {
    const line = doc.createElement('p');
    line.className = 'hint';
    // `role="status"` because focus lands on the footer's Cancel button while this is
    // the only thing in the body (`focusableWithin` finds nothing else) — with no live
    // region a screen reader announces "Cancel button" and nothing about why the dialog
    // opened onto one line of text with no form in it yet.
    line.setAttribute('role', 'status');
    line.textContent = LOADING_MESSAGE;
    body.replaceChildren(line);
    actions.replaceChildren();
    injectedSubmit = null;
    // The heading goes back to the placeholder too: it is the dialog's accessible name,
    // and announcing the PREVIOUS item's name over a sheet that is loading a different
    // one is worse than announcing nothing in particular.
    setHeading(null);
  };

  /**
   * Moves focus to an element that is not in the tab order, so a screen reader reads it.
   * `tabindex="-1"` and not `0`: this makes the notice focusABLE without putting it in
   * the Tab sequence, which is what `focusableWithin` in `src/lib/modal.ts` also reads
   * it as — a negative tabindex is excluded from the trap, so the notice does not become
   * a phantom stop the visitor has to Tab past on every pass through the form.
   */
  const focusNotice = (notice: Element | undefined): boolean => {
    if (!(notice instanceof HTMLElement)) return false;
    notice.setAttribute('tabindex', '-1');
    notice.focus();
    return true;
  };

  /** Puts the fetched page's content into the dialog. Shared by the open path and the
   *  re-render after a submit the server refused, so the two cannot drift. */
  const renderContent = (content: OverlayContent, submit: HTMLElement) => {
    setHeading(content.title);
    body.replaceChildren(...content.notices, content.form);
    actions.replaceChildren(submit);
    injectedSubmit = submit;
  };

  /**
   * The dialog could not be used for this link, so the visitor gets the page they asked
   * for. Closing FIRST matters: `location.assign` does not unwind the current document
   * synchronously, and a dialog left presented over a page that is navigating away is a
   * frozen scroll lock with a spinner on top of it.
   */
  const fallbackToNavigation = (href: string) => {
    controller.close();
    view.location.assign(href);
  };

  const showUnreachableNotice = (message: string = SAVE_UNREACHABLE_MESSAGE) => {
    body.querySelector(`[${UNREACHABLE_NOTICE_ATTRIBUTE}]`)?.remove();
    // The same markup both pages use for their own banners — `.note.note-danger` with
    // `role="alert"` — rather than a shape invented here, so it reads as part of the
    // page's own vocabulary and not as a second kind of error.
    const notice = doc.createElement('div');
    notice.className = 'note note-danger';
    notice.setAttribute('role', 'alert');
    notice.setAttribute(UNREACHABLE_NOTICE_ATTRIBUTE, '');
    const line = doc.createElement('p');
    line.textContent = message;
    notice.append(line);
    body.prepend(notice);
    focusNotice(notice);
  };

  // -------------------------------------------------------------------------
  // Opening
  // -------------------------------------------------------------------------

  const loadInto = async (target: OverlayTarget, href: string, mine: number): Promise<void> => {
    let response: Response;
    try {
      // `credentials: 'same-origin'` states what the default already is, because this
      // request MUST carry the session cookie — without it the fetch lands on the
      // sign-in page, there is no form in the answer, and the overlay silently
      // degrades into a navigation on every click.
      response = await fetchPage(target.url, { credentials: 'same-origin' });
    } catch {
      if (mine !== generation) return;
      fallbackToNavigation(href);
      return;
    }
    if (mine !== generation) return;

    if (!response.ok) {
      fallbackToNavigation(href);
      return;
    }

    let html: string;
    try {
      html = await response.text();
    } catch {
      if (mine !== generation) return;
      fallbackToNavigation(href);
      return;
    }
    if (mine !== generation) return;

    const content = extractOverlayContent(html, doc);
    if (content === null) {
      // 200, but no gear form in it: an expired session redirected to sign-in, or a
      // deleted item's 404 body. The visitor asked for that page and must still get it.
      fallbackToNavigation(href);
      return;
    }

    const submit = prepareInjectedForm(content.form, target.url);
    if (submit === null) {
      // A form with no submit control cannot be saved from the modal's footer, which is
      // the same dead end as no form at all and gets the same answer.
      fallbackToNavigation(href);
      return;
    }

    openTarget = target;
    renderContent(content, submit);
    // Focus lands on the first field rather than on the close button — see
    // `focusFirstWithin`, which steps over the shell's own dismiss control for exactly
    // this. The dialog was opened before the content existed, so the focus the shell
    // moved at `showModal()` time was onto an empty sheet; this is the move that
    // matters, and it can only happen now.
    focusFirstWithin(dialog);
  };

  const onClick = (event: MouseEvent) => {
    if (!isPlainLeftClick(event)) return;

    const from = event.target;
    if (!(from instanceof Element)) return;
    const link = from.closest('a[href]');
    if (!(link instanceof HTMLAnchorElement)) return;

    // Both are the link's own instructions to the browser and neither survives a modal:
    // `target` says "somewhere else", `download` says "do not render this at all".
    if (link.hasAttribute('target') || link.hasAttribute('download')) return;

    // `link.href` rather than the raw attribute: the browser has already resolved it
    // against the document's base URL, and `view.location.href` is then the true origin
    // to compare against — a `<base href>` pointing off-site cannot smuggle a foreign
    // URL past the same-origin test that way.
    const target = overlayTargetFor(link.href, view.location.href);
    if (target === null) return;

    /*
     * THE ORDER OF THE NEXT THREE STEPS IS THE MOST IMPORTANT RULE IN THIS FILE.
     *
     * 1. The loading state goes in FIRST, while the dialog is still closed. `openFrom`
     *    moves focus into the dialog as part of opening it (`beginModalSession`), so a
     *    dialog still holding the last item's form would be shown, and focused, with the
     *    wrong item's values in it for as long as the fetch takes.
     *
     * 2. `openFrom` decides everything. It returns `false` when the dialog did not come
     *    up — `showModal()` threw, the controller was destroyed, the dialog was detached
     *    — and the ONLY correct response is to return without cancelling anything, so
     *    the browser follows the link exactly as it always did. `src/lib/modal.ts`'s
     *    header states this outright: an `event.preventDefault()` on the optimistic
     *    assumption that the dialog is about to appear is how a working link becomes a
     *    control that does nothing at all, which is the precise defect the whole
     *    degradation pattern exists to prevent.
     *
     * 3. Only now is the navigation cancelled, and only then does the fetch start.
     */
    showLoading();
    if (!controller.openFrom(link)) return;
    event.preventDefault();

    generation += 1;
    void loadInto(target, link.href, generation);
  };

  // -------------------------------------------------------------------------
  // Submitting
  // -------------------------------------------------------------------------

  const save = async (form: HTMLFormElement, mine: number): Promise<void> => {
    // Read off the form rather than off `openTarget`, because `prepareInjectedForm` is
    // the one place the destination is decided and this is the value it wrote.
    const action = form.action;
    const requestedItemId = openTarget?.itemId ?? null;

    let response: Response;
    try {
      response = await fetchPage(action, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        // The 303 both pages answer a good write with is followed here rather than
        // surfaced, because the URL it lands on is the receipt — see `savedDetailFrom`.
        redirect: 'follow',
        body: submissionBody(form).toString(),
      });
    } catch {
      // NEVER NAVIGATE FROM HERE. The visitor's typed values exist in exactly one place
      // — the fields in front of them — and a navigation would destroy them to report a
      // failure that may not even have reached the server. The dialog stays open, the
      // form stays untouched, and the notice says what happened.
      if (mine !== generation) return;
      showUnreachableNotice();
      return;
    }

    /*
     * A REDIRECT IS NECESSARY FOR SUCCESS BUT NOT SUFFICIENT, and the difference is the
     * whole of the branch below. Both pages answer a good write with
     * `Astro.redirect(…, 303)` to the item's own path, and nothing else on either page
     * redirects: a validation failure, a write failure and an unrecognised intent all
     * re-render the same page with 200. But each page ALSO bounces a request carrying no
     * session to `/sign-in?next=…`, above its own POST branch — so the one other redirect
     * a save can draw is the one that wrote nothing at all, and it is indistinguishable
     * from a receipt by status alone. What tells them apart is where it landed:
     * `savedDetailFrom` answers `null` for anything that does not name a gear item.
     */
    if (response.redirected) {
      const detail = savedDetailFrom(response.url, view.location.href, requestedItemId);

      /*
       * `mine !== generation` HERE MEANS THE VISITOR HAS MOVED ON while this POST was in
       * flight — dismissed the dialog, or opened a different item — and this branch used
       * to act as if nothing had changed: `controller.close()` closed whatever session
       * happened to be open, which could by now belong to a completely different item,
       * and `fallbackToNavigation` could navigate a visitor away from wherever they had
       * gone next to report a write that FAILED for a save they may not even remember
       * starting. Both are worse than doing nothing, so both are skipped. What is not
       * skipped is the event on a genuine write (`detail !== null`): the write reached
       * the database regardless of what the dialog is doing now, and a listener like the
       * closet's own list still needs to know about it — see `GEAR_ITEM_SAVED_EVENT`'s
       * own header on why closing and dispatching are two separate steps, not one.
       */
      if (mine !== generation) {
        if (detail !== null) {
          doc.dispatchEvent(
            new CustomEvent<GearItemSavedDetail>(GEAR_ITEM_SAVED_EVENT, { detail }),
          );
        }
        return;
      }

      if (detail === null) {
        /*
         * Not a receipt — in practice a session that expired while the dialog was open.
         * NOTHING WAS WRITTEN, so announcing a save here would be a lie, and closing
         * quietly would be a lie told silently: the visitor would watch the dialog
         * vanish and reasonably read that as "saved".
         *
         * Hand them the page the browser would have reached on its own. This is the same
         * request, with the same body, that a native submit of this form would have made
         * with the script absent — and the browser would have followed the redirect and
         * rendered the sign-in page. `next` carries them back afterwards. What they
         * typed is lost either way (a bounced POST kept none of it), so the useful thing
         * is to say so by showing them the page that explains it, not to strand them in
         * front of a form whose Save no longer does anything.
         */
        console.warn(
          `[gear-overlay] a save redirected to "${response.url}", which names no gear item, ` +
            `so nothing was saved. Following the redirect as an ordinary submit would.`,
        );
        fallbackToNavigation(response.url);
        return;
      }

      // CLOSE BEFORE DISPATCH. A listener's whole job is to re-render the list behind
      // this dialog, and doing that while the dialog is still up means re-rendering a
      // page the visitor cannot see or reach — and, since the row a modal was opened
      // from is very often the row that just changed, removing the element the shell is
      // about to restore focus to. `restoreFocus` handles a vanished opener; it cannot
      // handle one that vanishes at the wrong moment.
      controller.close();

      doc.dispatchEvent(new CustomEvent<GearItemSavedDetail>(GEAR_ITEM_SAVED_EVENT, { detail }));
      return;
    }

    if (!response.ok) {
      // Reached and REFUSED, not unreachable — a 403 from `checkOrigin`, a 500, a route
      // that started rejecting the method. `loadInto`'s GET has somewhere safe to send
      // the visitor when this happens (the real page, via `fallbackToNavigation`); a
      // POST does not, because there is no page that represents "try writing this
      // again" — so it stays in the dialog, with a message that says the request landed
      // rather than implying it never left.
      if (mine !== generation) return;
      showUnreachableNotice(SAVE_REJECTED_MESSAGE);
      return;
    }

    // Not redirected, and ok: the server re-rendered the page with its own error
    // banners in it — a validation failure or a write failure, both 200.
    let html: string;
    try {
      html = await response.text();
    } catch {
      if (mine !== generation) return;
      showUnreachableNotice();
      return;
    }
    // The visitor dismissed the dialog while this was in flight, discarding their edit
    // on purpose. Swapping content into a closed dialog would put the next open's
    // starting state in the wrong place.
    if (mine !== generation) return;

    const content = extractOverlayContent(html, doc);
    const submit = content === null ? null : prepareInjectedForm(content.form, action);
    if (content === null || submit === null) {
      // A 200 that is not a re-rendered form: this cannot be shown and must not be
      // navigated to either, for the reason the network branch above gives.
      showUnreachableNotice();
      return;
    }

    renderContent(content, submit);
    // Focus the first thing that says what went wrong, so a screen reader is told rather
    // than being left on a submit button that appears to have done nothing. When the
    // server somehow re-rendered with no banner at all, the first field is the next best
    // place for focus to be.
    if (!focusNotice(content.notices[0])) focusFirstWithin(dialog);
  };

  const onSubmit = (event: SubmitEvent) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    // The shell's own close button is a `<form method="dialog">` inside this same dialog
    // and its submit bubbles here too. The id is what tells the two apart — and it is
    // also why nothing here needs to know about the close button at all.
    if (form.id !== GEAR_OVERLAY_FORM_ID) return;

    event.preventDefault();
    if (submitting) return;
    submitting = true;
    injectedSubmit?.setAttribute('disabled', '');

    const mine = generation;
    void save(form, mine).finally(() => {
      // `mine !== generation` HERE MEANS THE DIALOG HAS MOVED ON since this POST was
      // sent — closed, or reopened onto a different item — and `submitting` /
      // `injectedSubmit` by now describe THAT session, not this finished request's. An
      // unconditional reset used to clear them anyway: save item A, dismiss mid-POST,
      // open and start saving item B, and A's `finally` would land in the middle of B's
      // POST, re-enabling B's submit button and setting `submitting = false` while B's
      // own request was still outstanding — Enter in a field then fired a second POST
      // for B, which for a create means two rows inserted from one submit. `onClose`
      // already resets both when a session genuinely ends; this `finally` must only
      // touch them when it is still that same session's own cleanup.
      if (mine !== generation) return;
      submitting = false;
      injectedSubmit?.removeAttribute('disabled');
    });
  };

  // -------------------------------------------------------------------------
  // Closing
  // -------------------------------------------------------------------------

  /*
   * EVERY DISMISSAL ENDS HERE, whoever caused it: ESC, the backdrop, the shell's close
   * button, the footer's own `<form method="dialog">` Cancel, and this module's own
   * `controller.close()` after a save. The shell converges all of them on the platform's
   * `close` event (see `endModalSession`), so emptying the dialog once, here, is the
   * whole of it — and it has to happen, because a dialog is mounted on every page of the
   * site and a form left inside it would be a stale `#gear-item-overlay-form` in the
   * document, findable by `getElementById`, and the previous item's values on the next
   * open before the fetch resolves.
   */
  const onClose = () => {
    generation += 1;
    submitting = false;
    openTarget = null;
    injectedSubmit = null;
    body.replaceChildren();
    actions.replaceChildren();
    setHeading(null);
  };

  doc.addEventListener('click', onClick, { signal });
  dialog.addEventListener('submit', onSubmit, { signal });
  dialog.addEventListener('close', onClose, { signal });

  return () => listeners.abort();
}
