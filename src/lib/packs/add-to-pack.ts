/**
 * The pure decisions behind the "add an item to a pack category" dialog (PK-74): which tab
 * it opens on, what its trigger links to, what a submission's "also add to closet" checkbox
 * means, and how the one-off item a visitor just typed becomes a closet row when that
 * checkbox is ticked. Sibling to `src/lib/packs/editor.ts` and modelled on it directly —
 * same reason for existing, same shape, same rules.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A MODULE AND NOT THE PAGE'S FRONTMATTER OR THE ISLAND'S OWN SCRIPT
 * ---------------------------------------------------------------------------
 *
 * `vitest.config.ts:64` excludes `src/pages/**`, and `src/lib/packs/editor.ts`'s header
 * records what PK-4's independent review found by mutation testing: logic that lives only
 * in `.astro` frontmatter is logic no test in this repository can execute. Every function
 * below answers a question the dialog gets wrong SILENTLY, not with a thrown error — a
 * `?tab=` that fails to parse and falls back to whatever tab happened to render last, a
 * `?add=` naming a category from a different pack that opens a dialog aimed at nothing, a
 * `localStorage` read that throws in Safari private mode and takes the whole pack page down
 * with it. `tests/packs-add-to-pack.test.ts` calls every one of these directly.
 *
 * ---------------------------------------------------------------------------
 * THE HREF MUST BE A REAL, WORKING URL — NOT A JAVASCRIPT-ONLY AFFORDANCE
 * ---------------------------------------------------------------------------
 *
 * `addToPackHref` is not a convenience for an onclick handler. `src/pages/packs/[id].astro`
 * reads the dialog's open/closed state and its tab off its OWN URL via
 * `parseAddToPackRequest`, so a visitor without JavaScript who follows a per-category "Add
 * item" link gets a page that server-renders the dialog already open — the same
 * navigate-to-open-a-dialog pattern `src/lib/modal.ts`'s `OPEN_ON_LOAD_ATTRIBUTE` exists to
 * drive. `addToPackHref` and `parseAddToPackRequest` are therefore a matched pair: one
 * writes the query string the other reads, and `tests/packs-add-to-pack.test.ts` round-trips
 * one through the other rather than testing either half against a hand-written string.
 *
 * ---------------------------------------------------------------------------
 * NOT importing src/lib/auth/ OR @supabase/*, AND WHY THAT BITES HERE SPECIFICALLY
 * ---------------------------------------------------------------------------
 *
 * `src/components/PackContents.vue` is a hydrated island (PK-37), so this module's whole
 * import graph ships to the browser. `src/lib/packs/form.ts` and `src/lib/packs/routes.ts`
 * both make this argument at length for their own layers, and the reasoning transfers
 * unchanged: Invariant A in `tests/anonymous-read-path.test.ts` forbids an import edge into
 * `src/lib/auth/` from anywhere outside its own allowlist, and Invariant D2 forbids anything
 * in the client Rollup pass from being, or importing, an `@supabase/*` package at runtime.
 * `GearItemInput`, imported from `src/lib/gear/form.ts` below, is imported with `import
 * type` for exactly this reason — the type is erased at compile time and carries none of
 * that module's runtime weight across the boundary.
 *
 * ---------------------------------------------------------------------------
 * "ALSO ADD TO CLOSET" IS A PER-BROWSER CONVENIENCE, NOT ACCOUNT STATE
 * ---------------------------------------------------------------------------
 *
 * `readAlsoAddToCloset`/`writeAlsoAddToCloset` read and write `localStorage`, which is the
 * OPPOSITE choice `src/pages/account/index.astro` documents for the weight-unit setting at
 * length: an account preference has to follow the visitor to another browser, so it is
 * written server-side and nowhere else. The toggle here is deliberately not that. It
 * remembers what this one browser last did on this one device — closer to a scroll position
 * than to a setting — and the two functions below must never throw, because Safari private
 * mode and "block all cookies" make `localStorage.getItem`/`.setItem` throw on every call,
 * and a dialog that cannot open because a convenience it does not need failed to load is a
 * worse bug than a convenience that quietly does not remember.
 *
 * ---------------------------------------------------------------------------
 * WEIGHT ARRIVES IN GRAMS ALREADY (PK-67) — THIS MODULE DOES NOT CONVERT
 * ---------------------------------------------------------------------------
 *
 * `customItemToGearInput` takes the `CustomPackItemInput` `parseCustomPackItemForm` already
 * produced. That parser's own header ("WEIGHT ENTRY IS IN THE ACCOUNT'S BASE UNIT, CONVERTED
 * ONCE") converts the visitor's typed figure to grams exactly once, at the form boundary,
 * and names its result field `weight_grams` for that reason. Converting again here would be
 * a second conversion of an already-converted number — turning, say, 4.4 oz correctly
 * entered and stored as 124.738 g into a closet row that claims some other weight entirely.
 * This module carries `weight_grams` straight across, unchanged, into `GearItemInput`'s own
 * `weight_grams` field, which documents the identical contract on the gear side.
 *
 * ---------------------------------------------------------------------------
 * NEVER A RAW POSTGRES OR POSTGREST STRING
 * ---------------------------------------------------------------------------
 *
 * The house rule `src/lib/packs/form.ts` states under this same heading and
 * `signUpErrorMessage` in `src/lib/auth/index.ts` follows for its own form: every message
 * exported below is a complete, neutral sentence a visitor can read, telling them what
 * happened and, where there is one, what they can still do. `PACK_LINK_FAILED_MESSAGE` in
 * particular is not a generic "something went wrong" — see its own comment for why the two
 * failure modes it distinguishes from `CLOSET_COPY_FAILED_MESSAGE` are not interchangeable.
 */

import type { GearStatus } from '../gear/fields';
import type { GearItemInput } from '../gear/form';
import type { CustomPackItemInput } from './form';

// ---------------------------------------------------------------------------
// The dialog's identity and query parameters
// ---------------------------------------------------------------------------

/** The `<Modal id>` this dialog registers under (`src/lib/modal.ts`, PK-69) — one dialog
 *  definition in the markup, reused for whichever category's trigger opened it, rather than
 *  one dialog per category. `ADD_CATEGORY_PARAM` is what tells the shared dialog which
 *  category it is currently open for. */
export const ADD_TO_PACK_MODAL_ID = 'add-to-pack';

/** `?add=<categoryId>` — the query parameter that says the dialog is open, and for which
 *  category. Read by `parseAddToPackRequest`, written by `addToPackHref`. */
export const ADD_CATEGORY_PARAM = 'add';

/** `?tab=closet|new` — which of the dialog's two tabs is showing. Absent or unrecognised
 *  falls back to `defaultAddToPackTab`, never to an error: a stale link with an old tab
 *  spelling is exactly as valid a way to open this dialog as one with none at all. */
export const ADD_TAB_PARAM = 'tab';

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

/** The dialog's two tabs, in the order they render. A tuple rather than a bare union, for
 *  the same reason `GEAR_STATUSES`/`PACK_ITEM_CARRIAGES` are tuples: it is both the
 *  vocabulary `isAddToPackTab` narrows against and the thing a `<select>` or tab strip
 *  iterates to render its options, so the two cannot drift apart into two different lists. */
export const ADD_TO_PACK_TABS = ['closet', 'new'] as const;

export type AddToPackTab = (typeof ADD_TO_PACK_TABS)[number];

/** Narrows an untrusted string — a query parameter, in practice — to a real tab. Mirrors
 *  `isPackItemCarriage`/`isGearStatus`: a value that merely looks plausible (`'Closet'`,
 *  `'from-closet'`) fails this exactly as a bare typo would, rather than being coerced. */
export function isAddToPackTab(value: unknown): value is AddToPackTab {
  return typeof value === 'string' && (ADD_TO_PACK_TABS as readonly string[]).includes(value);
}

/** Human labels for the tab strip. `PACK_LINK_FAILED_MESSAGE` below quotes
 *  `ADD_TO_PACK_TAB_LABELS.closet` rather than repeating the string "From closet" by hand,
 *  so a renamed label cannot leave that message pointing at a tab that no longer says what
 *  it claims. */
export const ADD_TO_PACK_TAB_LABELS: Readonly<Record<AddToPackTab, string>> = {
  closet: 'From closet',
  new: 'New item',
};

/**
 * Which tab the dialog opens on when nothing in the URL says otherwise: "From closet" when
 * there is a closet to show, "New item" when there is not. A visitor with an empty closet
 * landing on a tab listing zero items — with the tab that would actually let them add
 * something one click away — is the state this exists to avoid on the very first open.
 */
export function defaultAddToPackTab(closetCount: number): AddToPackTab {
  return closetCount > 0 ? 'closet' : 'new';
}

// ---------------------------------------------------------------------------
// The "also add to closet" checkbox
// ---------------------------------------------------------------------------

/** The one field the "new item" tab's form carries beyond
 *  `CUSTOM_PACK_ITEM_FORM_FIELD` (`src/lib/packs/form.ts`): whether the one-off item being
 *  described should ALSO become a permanent closet row, not merely a snapshot on this pack.
 *  Named separately from that map, rather than folded into it, because it is not a
 *  `pack_items` or snapshot field at all — `parseCustomPackItemForm` never reads it, and a
 *  caller reads it itself before or after calling that parser. */
export const ADD_TO_PACK_FIELD = { alsoAddToCloset: 'also_add_to_closet' } as const;

/** The `value` attribute the checkbox's markup carries, matching every other checkbox in
 *  this codebase whose markup does not set one explicitly (`packed`, in
 *  `src/lib/packs/form.ts`, posts the same `'on'`). Exported so the component that renders
 *  the checkbox and the function that reads it cannot disagree about what a ticked box
 *  submits. */
export const ALSO_ADD_TO_CLOSET_VALUE = 'on';

/** The exact submitted strings that mean "ticked" — the same allow-list
 *  `src/lib/packs/form.ts`'s `parseCheckbox` uses, and duplicated here for the same reason
 *  its numeric parsers are duplicated from `src/lib/gear/form.ts`: this module and that one
 *  own two different files, and copying three lines is cheaper than widening either
 *  module's exports for a caller neither was written for. An unchecked checkbox posts
 *  NOTHING at all, so absence, `''` and anything not on this list all mean "not ticked" —
 *  never an error, because a checkbox is not something a visitor can get wrong. */
const CHECKBOX_TRUE_VALUES = new Set(['on', 'true', '1', 'yes']);

/**
 * Whether a submission asked for the item it is describing to also be written to the
 * closet. Never throws: the same two coercions `getFormString`
 * (`src/lib/packs/form.ts`) documents apply here — a field submitted more than once reads
 * back only its first value, and a non-string entry (a `File` part from a multipart POST
 * landing on this field's name) reads as not ticked rather than as a type error.
 */
export function submissionAlsoAddsToCloset(form: FormData): boolean {
  const value = form.get(ADD_TO_PACK_FIELD.alsoAddToCloset);
  if (typeof value !== 'string') return false;
  return CHECKBOX_TRUE_VALUES.has(value.trim().toLowerCase());
}

// ---------------------------------------------------------------------------
// The trigger's href
// ---------------------------------------------------------------------------

/**
 * The href a per-category "Add item" trigger points at. MUST be a real, working URL — see
 * this module's header — so that following it with JavaScript disabled server-renders the
 * dialog already open on `categoryId`, on `tab` if one is given or on whatever
 * `parseAddToPackRequest` defaults to otherwise.
 *
 * BUILT WITH `URLSearchParams`, NOT STRING CONCATENATION, so `categoryId` — a UUID in every
 * real case, but this function does not know that and must not assume it — is
 * percent-encoded exactly as `parseAddToPackRequest`'s `URLSearchParams` parsing expects,
 * with no hand-rolled escaping to get subtly wrong.
 *
 * `tab` IS OMITTED FROM THE QUERY STRING WHEN NOT GIVEN, rather than always written as
 * whatever `defaultAddToPackTab` would choose. A trigger that does not care which tab opens
 * — the ordinary "Add item" link — should not freeze in a stale tab choice if the pack's
 * closet count changes between when the link was rendered and when it is followed; omitting
 * the parameter leaves that decision to `parseAddToPackRequest`, made fresh against
 * whatever the closet holds at request time.
 */
export function addToPackHref(packUrlPath: string, categoryId: string, tab?: AddToPackTab): string {
  const params = new URLSearchParams();
  params.set(ADD_CATEGORY_PARAM, categoryId);
  if (tab !== undefined) params.set(ADD_TAB_PARAM, tab);
  return `${packUrlPath}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Reading the dialog's state off the pack page's own URL
// ---------------------------------------------------------------------------

/**
 * Reads the dialog's open/closed state and active tab off the pack page's own request URL.
 * Never throws, whatever `params` contains.
 *
 * `categoryIds` IS THE PACK'S REAL CATEGORY IDS, and checking `?add=` against it is the
 * whole reason this function takes the pack's tree rather than merely reading the
 * parameter back. The pattern is the one `hasPackCategory` in `src/lib/packs/editor.ts`
 * names at length: a stale bookmark, a second tab that deleted the category first, or a
 * hand-edited query string can all name a category id that is well-formed and belongs to
 * NO category of THIS pack — including a category of another pack of the same visitor's,
 * which nothing at this layer distinguishes from a crafted request. An `?add=` naming
 * anything else resolves to `categoryId: null` — no dialog rendered open — rather than
 * opening a dialog aimed at a category the page has nothing to show for.
 *
 * `tab` FALLS BACK TO `defaultAddToPackTab`, NOT TO A FIXED TAB, so a `?add=` with no `tab`
 * at all — the ordinary case, since `addToPackHref` omits it when the caller does not care
 * — still opens on whichever tab actually has something in it.
 */
export function parseAddToPackRequest(
  params: URLSearchParams,
  categoryIds: readonly string[],
  closetCount: number,
): { readonly categoryId: string | null; readonly tab: AddToPackTab } {
  // `URLSearchParams.get` already returns only the first value of a repeated key, the same
  // "first value wins" behaviour `form.get()` has and `getFormString` documents — so a
  // `?add=a&add=b` is read as `a`, not rejected and not merged.
  const requestedCategoryId = params.get(ADD_CATEGORY_PARAM);
  const categoryId =
    requestedCategoryId !== null && categoryIds.includes(requestedCategoryId)
      ? requestedCategoryId
      : null;

  const requestedTab = params.get(ADD_TAB_PARAM);
  const tab = isAddToPackTab(requestedTab) ? requestedTab : defaultAddToPackTab(closetCount);

  return { categoryId, tab };
}

// ---------------------------------------------------------------------------
// The "also add to closet" toggle's remembered state
// ---------------------------------------------------------------------------

/**
 * The `localStorage` key the toggle's remembered state is stored under, keyed per user so
 * that two accounts signed into the same browser — a shared family computer, a librarian's
 * kiosk — do not inherit each other's last choice.
 */
export function alsoAddToClosetKey(userId: string): string {
  return `packsheet:add-to-pack:also-add-to-closet:${userId}`;
}

/** What a remembered "ticked" reads back as. Deliberately NOT the same string as
 *  `ALSO_ADD_TO_CLOSET_VALUE`: that constant is the checkbox's submitted form value, this
 *  one is this module's own storage encoding, and the two happening to read `'on'`/`'true'`
 *  differently is the point — nothing about the storage format is dictated by the form. */
const STORED_ALSO_ADD_TO_CLOSET_TRUE = 'true';

/**
 * Reads the toggle's remembered state for `userId`. Defaults to `false` — a first-ever
 * visit remembers nothing — and for two reasons that never propagate: no stored value at
 * all, and a `storage` that cannot be read from.
 *
 * `storage: Storage | null`, NOT BARE `Storage`, so the server (which has no
 * `localStorage`) and a jsdom test double can both pass `null` rather than every caller
 * having to feature-test `typeof localStorage` first.
 *
 * MUST NEVER THROW — see this module's header. Safari private mode and browsers configured
 * to block all cookies make `Storage.getItem` throw a `SecurityError` on ACCESS, not only
 * on write, so the try/catch below is not defensive boilerplate: without it, opening this
 * dialog in exactly those browsers would throw before the dialog ever rendered, over a
 * convenience feature nobody asked to see fail.
 */
export function readAlsoAddToCloset(storage: Storage | null, userId: string): boolean {
  if (storage === null) return false;
  try {
    return storage.getItem(alsoAddToClosetKey(userId)) === STORED_ALSO_ADD_TO_CLOSET_TRUE;
  } catch {
    return false;
  }
}

/**
 * Remembers the toggle's state for `userId`. A silent no-op on a `null` storage or a
 * throwing one — see `readAlsoAddToCloset`'s comment for why both are the correct
 * behaviour rather than a gap: this is a per-browser convenience, not account state (see
 * this module's header), so a browser that will not let it be written simply does not get
 * to remember, and that is the entire cost.
 */
export function writeAlsoAddToCloset(
  storage: Storage | null,
  userId: string,
  value: boolean,
): void {
  if (storage === null) return;
  try {
    if (value) {
      storage.setItem(alsoAddToClosetKey(userId), STORED_ALSO_ADD_TO_CLOSET_TRUE);
    } else {
      storage.removeItem(alsoAddToClosetKey(userId));
    }
  } catch {
    // Storage.setItem/.removeItem throw in the same browsers and the same private-mode
    // configurations Storage.getItem does — see readAlsoAddToCloset. Nothing to recover:
    // the toggle just does not remember this time, which is what it would look like on
    // the very first visit anyway.
  }
}

// ---------------------------------------------------------------------------
// Turning a one-off item into a closet row
// ---------------------------------------------------------------------------

/** The status a custom item copied into the closet by "also add to closet" is given.
 *  Typed as `GearStatus` — narrowed from `GEAR_STATUSES` in `src/lib/gear/fields.ts` — so
 *  that if `'owned'` is ever removed from that vocabulary, this assignment fails to
 *  compile rather than silently writing a status the column no longer has a case for.
 *  `'owned'` and not `'wishlist'`: a visitor packing an item for a trip they are describing
 *  right now plainly already has it, which `'wishlist'` — something not yet acquired — is
 *  not true of. */
const ADD_TO_PACK_CLOSET_STATUS: GearStatus = 'owned';

/**
 * Turns the one-off item a visitor just described on the "New item" tab into a closet row,
 * for when "also add to closet" is ticked. Carries across only the fields the dialog
 * actually asked for — name, brand, category, description, weight, quantity, price,
 * currency — and defaults everything closet-only that this dialog has no field for:
 * `status` to `'owned'` (see `ADD_TO_PACK_CLOSET_STATUS`), and `acquired_on`, `url` and
 * `notes` to `null`, exactly the state those nullable columns are in for a gear row nobody
 * has filled them in for yet.
 *
 * `values` IS THE VALIDATED `CustomPackItemInput` `parseCustomPackItemForm` returns on its
 * `ok: true` branch — not the raw `CustomPackItemFormValues` strings — so every field this
 * function reads has already passed that parser's checks, and `weight_grams` in particular
 * has already been converted to grams exactly once (see this module's header). This
 * function performs no validation and no conversion of its own; it is a reshaping, not a
 * second parse.
 *
 * `quantity`, `packed`, `worn` and `consumable` on `values` are NOT carried across: they
 * are `pack_items` per-list settings — how this one pack carries the item — and have no
 * counterpart on a closet row at all, which describes what is OWNED rather than how any
 * particular list carries it.
 */
export function customItemToGearInput(values: CustomPackItemInput): GearItemInput {
  return {
    name: values.name,
    quantity: values.quantity,
    weight_grams: values.weight_grams,
    price: values.price,
    currency: values.currency,
    brand: values.brand,
    category: values.category,
    description: values.description,
    acquired_on: null,
    status: ADD_TO_PACK_CLOSET_STATUS,
    url: null,
    notes: null,
  };
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/**
 * The closet write itself failed — the `gear_items` insert never landed, so nothing was
 * written anywhere at all: no closet row, and consequently nothing for the pack to link to
 * either. A complete, neutral sentence rather than whatever the database call rejected
 * with, per this module's header.
 */
export const CLOSET_COPY_FAILED_MESSAGE =
  'Something went wrong adding this item to your closet. Nothing was added — try again.';

/**
 * THE OTHER FAILURE, AND WHY IT IS A DIFFERENT MESSAGE RATHER THAN THE SAME ONE REUSED. The
 * closet write SUCCEEDED here — there is a real, saved gear row — and it was only linking
 * that row to this pack (`addGearItemsToCategory`, `src/lib/packs/mutations.ts`) that
 * failed. Showing `CLOSET_COPY_FAILED_MESSAGE` for this case would tell a visitor "nothing
 * was added" about an item that is, at that moment, sitting in their closet — indistinguishable
 * from any other. The truth is narrower and more useful: the item exists and can be pulled
 * onto this pack from the tab that lists exactly what is in the closet, without describing
 * it a second time.
 */
export const PACK_LINK_FAILED_MESSAGE =
  `This item was added to your closet, but something went wrong adding it to this pack. ` +
  `You can add it from the "${ADD_TO_PACK_TAB_LABELS.closet}" tab instead.`;
