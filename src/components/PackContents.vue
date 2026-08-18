<script setup lang="ts">
/**
 * PK-37's pack contents: the categories and items of one pack, their figures, the controls
 * that edit them, and — once it has hydrated — dragging to reorder them.
 *
 * ---------------------------------------------------------------------------
 * ONE LIST, WHICH IS THE WHOLE POINT OF THIS COMPONENT BEING THIS BIG
 * ---------------------------------------------------------------------------
 *
 * This started as an "Arrange" panel rendered ABOVE a second, server-rendered copy of the
 * same categories and items that carried the forms. That arrangement put two renderings of
 * one order on one screen: after a drag landed, the island had moved and the editor below
 * it still showed the order the page loaded with, and the only thing holding it together
 * was a status line asking the visitor to reload. Nothing else on this page needed a
 * reload, so the line was an apology for a defect rather than information.
 *
 * So the list and its controls are one component now. There is exactly one rendering of the
 * pack's order in the document, it is the one a pointer drags, and every per-item and
 * per-category control lives on the row it belongs to. What did NOT move is everything that
 * is not the ordered list: the pack details form, the closet picker, the one-off item form
 * and the pack-level actions are still plain `.astro` in `src/pages/packs/[id].astro`,
 * because a form that creates a row is not a rendering of the order of the rows.
 *
 * ---------------------------------------------------------------------------
 * EVERY CONTROL IN HERE IS A PLAIN FORM, AND THAT IS LOAD-BEARING
 * ---------------------------------------------------------------------------
 *
 * Astro server-renders this component, so what a browser receives is ordinary HTML:
 * `<form method="post">` with hidden `intent` and id fields, posting to the pack's own URL
 * and answered by the same ten-intent handler with the same `303`. Nothing here submits
 * with `fetch`, nothing calls `preventDefault` on a submit, and no control is disabled
 * before hydration. With JavaScript off — or off for the moment before the island hydrates,
 * or forever, because a bundle failed to load — this markup IS the editor, with exactly the
 * capability it had before any of this existed: rename, save, remove, delete, both two-step
 * confirmations.
 *
 * What hydration adds is dragging, and nothing else. `tests/packs-drag.test.ts` renders this
 * component with Vue's own `renderToString` and asserts both halves of that claim: the forms
 * are in the server output, and no grip, no `draggable` and no drop target is.
 *
 * ---------------------------------------------------------------------------
 * POINTER ONLY. THERE ARE NO KEYBOARD REORDER CONTROLS, AND THAT IS A DECISION
 * ---------------------------------------------------------------------------
 *
 * Recorded so that nobody later files it as a regression, and so that nobody "fixes" it by
 * quietly turning drag into a different interaction. Dragging is the only way to REORDER a
 * pack today. That route does not satisfy a keyboard audit — there is no grab/move/drop key
 * sequence, no move-up/move-down button and no roving tabindex, and none of the three is
 * missing by oversight. PK-41 owns revisiting it and owns which of those shapes the answer
 * takes; until then the honest thing is for the surface to say so out loud rather than imply
 * an affordance it does not have, which is what the intro line does once it can drag at all.
 *
 * The consequence to keep straight when reading the markup: no ROW here is focusable, and
 * nothing carries a `tabindex`, because a focus ring on a row a keyboard cannot then move
 * would be a promise this component cannot keep. Every EDITING control on those rows — every
 * rename, save, remove and delete — is a real form, in the tab order, operable by keyboard
 * alone, and unchanged by whether this component ever hydrates.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS COMPONENT IS ALLOWED TO DECIDE, WHICH IS ALMOST NOTHING
 * ---------------------------------------------------------------------------
 *
 * The position arithmetic is `src/lib/packs/reorder.ts`'s, the drop-slot conversion and the
 * projection of a plan onto the tree are `src/lib/packs/drag.ts`'s, the wire field names are
 * `src/lib/packs/reorder-request.ts`'s, the form field names, the intents and the delete
 * gate's value are `src/lib/packs/{form,editor}.ts`'s and `src/lib/gear/bulk.ts`'s, the URL
 * is `src/lib/packs/routes.ts`'s, and the figures are `src/lib/totals.ts`'s. That is
 * deliberate to the point of being the design: everything below is event plumbing and
 * markup, because a decision taken inside a drag handler in this repository is a decision
 * nothing can execute. `tests/packs-drag.test.ts` can server-render this component —
 * `renderToString` needs no DOM — but `vitest.config.ts` sets `environment: 'node'` and
 * neither `@vue/test-utils` nor `jsdom` is a dependency, so there is no `DragEvent`, no
 * `dataTransfer` and no `getBoundingClientRect` to drive one with.
 *
 * IT SENDS AN INTENT AND NEVER A POSITION. The reorder body carries which row moved, which
 * category it landed in and at which index; the endpoint re-reads the pack under the
 * caller's own session and recomputes every position from ITS rows. See "BOTH SIDES CALL
 * THIS, ONLY ONE SIDE IS BELIEVED" in `src/lib/packs/reorder.ts`. The plan this component
 * computes is a PREDICTION, rendered immediately so the move is not waiting on a round trip;
 * the plan the response carries is the RESULT, and it is what the tree ends up showing.
 *
 * IT IMPORTS NO AUTH MODULE, and cannot be made to. Everything it imports is pure — no
 * Supabase client, no session, no cookie — and this file is bundled for the browser, where
 * an auth SDK would be both useless (the session cookie is httpOnly by design) and a
 * disclosure. Invariant A in `tests/anonymous-read-path.test.ts` is an EDGE rule and this
 * component is not on `AUTH_CONSUMERS`, so an import added here fails the build rather than
 * shipping.
 *
 * ---------------------------------------------------------------------------
 * WHAT HYDRATION CHANGES, AND WHAT IT DOES NOT
 * ---------------------------------------------------------------------------
 *
 * Server-rendered, this is the pack's list with its live figures and its working forms, and
 * NOTHING that looks draggable: no grips, no `draggable`, no drop targets. The affordances
 * appear in `onMounted`, the same idiom `src/components/ThemeToggle.vue` uses for its icon
 * and for the same reason — a control that is drawn before it can work is a control that
 * lies for as long as the gap lasts.
 */
import { computed, onMounted, shallowRef } from 'vue';
import { GripVertical } from 'lucide-vue-next';
import { PACK_REORDER_PATH } from '../lib/packs/routes';
import { REORDER_FIELD, REORDER_TARGET, planChangesAnything } from '../lib/packs/reorder-request';
import {
  planCategoryMove,
  planItemMove,
  sortByPosition,
  type PositionUpdate,
  type ReorderPlan,
  type RunUpdate,
} from '../lib/packs/reorder';
import { applyReorderPlan, dropTargetIndex } from '../lib/packs/drag';
import { PACK_EDITOR_FIELD, PACK_INTENT } from '../lib/packs/editor';
import {
  PACK_CATEGORY_FORM_FIELD,
  PACK_ITEM_FORM_FIELD,
  packItemToFormValues,
  type PackItemFormValues,
} from '../lib/packs/form';
import {
  PACK_ITEM_CARRIAGES,
  PACK_ITEM_CARRIAGE_LABELS,
  PACK_ITEM_CARRIAGE_MEANINGS,
} from '../lib/packs/fields';
// The delete gate itself, imported rather than re-spelled — the value this form writes and
// the value `confirmsGearDeletion` compares it against must not be able to drift apart. The
// name says "gear" because that is where it was first needed; what it decides is "did this
// submission carry the confirmation we rendered", which is not a gear question. See the same
// import, with the same note, in `src/pages/packs/[id].astro`.
import { BULK_FORM_FIELD, GEAR_DELETE_CONFIRMATION_VALUE } from '../lib/gear/bulk';
import { WEIGHT_BUCKETS, computeTotals, type PackTreeItem, type WeightBucket } from '../lib/totals';
import { formatWeight, type WeightSystem } from '../lib/units';
import { formatMoney, type Money } from '../lib/money';

/**
 * The rows this component renders: exactly what `PACK_TREE_SELECT` returns, plus nothing.
 * `PackTreeItem` is `src/lib/totals.ts`'s own input type, extended here with the `position`
 * the totals engine has no use for and the reorder engine cannot work without — which is why
 * the two are composed rather than one being redeclared. A row that satisfies this satisfies
 * `computeTotals`, `planItemMove` AND `packItemToFormValues` at once, so the tree in this
 * component is one tree rather than a rendering copy kept beside a positions copy kept
 * beside a form-values copy.
 */
interface ListItem extends PackTreeItem {
  readonly position: number;
}

interface ListCategory {
  readonly id: string;
  readonly name: string;
  readonly position: number;
  readonly pack_items: readonly ListItem[];
}

/** A rename that failed validation, scoped to the ONE category it was submitted for, so the
 *  message renders beside that category's own field rather than at the top of a page with
 *  nine forms on it. */
interface RenameError {
  readonly categoryId: string;
  readonly message: string;
}

/** One item's per-list settings that failed validation: which row, what to say, and exactly
 *  what the visitor typed — `rawPackItemFormValues` explains why the raw strings are what a
 *  re-render shows rather than the stored row. */
interface ItemError {
  readonly itemId: string;
  readonly errors: Readonly<Record<string, string>>;
  readonly values: PackItemFormValues;
}

/**
 * PROPS, NOT A FETCH. The page has already read this pack owner-scoped through
 * `loadPackForEdit` and worked out, from the POST it just answered, which row (if any) is
 * mid-validation-failure or mid-confirmation; handing all of that down as props means the
 * browser needs no read of its own, no client of its own and no credentials to draw the
 * surface — the shape `tests/anonymous-read-path.test.ts` argues for in its "pass the result
 * into the island as an ordinary prop" note.
 *
 * The three error/pending props are the page's POST branch made visible, and they are what
 * lets this component hold the forms without owning any of their decisions: it validates
 * nothing and confirms nothing, it renders what the server decided about the submission it
 * has just answered.
 */
const props = defineProps<{
  packId: string;
  categories: readonly ListCategory[];
  weightSystem: WeightSystem;
  /** This pack's own URL including the closet picker's query — what every write on the page
   *  redirects to, and what the Cancel link of a revealed delete goes back to. */
  selfPath: string;
  renameError: RenameError | null;
  itemError: ItemError | null;
  /** The category whose delete has been asked for but not yet confirmed. NOTHING HAS BEEN
   *  WRITTEN when this is set — see the page's own comment on the reveal half. */
  pendingCategoryDeleteId: string | null;
}>();

// ---------------------------------------------------------------------------
// Copy. Never a raw PostgREST/Postgres string — the endpoint already collapses those into
// sentences (see its REORDER_FAILED_MESSAGE); these cover the cases it never gets to
// answer at all.
// ---------------------------------------------------------------------------

const SAVE_FAILED_MESSAGE = 'That move could not be saved. Reload the pack and try again.';
const OFFLINE_MESSAGE =
  'That move did not reach the server, so the pack is unchanged. Check your connection and try again.';
const SIGNED_OUT_MESSAGE = 'Your session has expired, so that move was not saved. Sign in again.';
/** What the shared engine's own refusals become. `planItemMove` throws on an unknown or
 *  duplicated row id — a tree that has drifted from the database — and none of its messages,
 *  which name row ids, is worth showing to anybody. Same collapse, same reason, as
 *  REORDER_UNPLANNABLE_MESSAGE in `src/lib/packs/reorder-request.ts`. */
const UNPLANNABLE_MESSAGE = 'That move no longer fits this pack. Reload the pack and try again.';
/** The confirmation for the request itself, and that is ALL it claims. There is no longer a
 *  line telling the visitor to reload to see the real order: the list they are looking at IS
 *  the order, and there is no second copy of it left on the page to disagree with it. */
const SAVED_MESSAGE = 'Order saved.';

const BUCKET_LABELS: Record<WeightBucket, string> = {
  base: 'Base weight',
  worn: 'Worn',
  consumable: 'Consumables',
};
/** Blue for base weight is the one non-interactive use of blue the palette allows
 *  (CONTRIBUTING.md, and `--w-base` is literally `var(--blue)` in `src/styles/tokens.css`).
 *  The other two are their own tokens with their own dark cuts. None is decorative: each
 *  marks which total a number belongs to. Compiler-checked as a `Record<WeightBucket, …>` so
 *  a fourth bucket fails to build here rather than rendering uncoloured. */
const BUCKET_TEXT_CLASS: Record<WeightBucket, string> = {
  base: 'text-w-base',
  worn: 'text-w-worn',
  consumable: 'text-w-cons',
};

// Tailwind class strings, declared per file exactly as `src/pages/packs/[id].astro`,
// `src/pages/packs/index.astro` and `src/components/GearItemForm.astro` each declare their
// own. They are presentation, not a decision: nothing branches on them.
const LABEL_CLASS = 'text-ink-2 block text-sm';
const INPUT_CLASS =
  'border-hairline bg-surface text-ink mt-1 w-full rounded-[var(--r-sm)] border px-3 py-2 text-sm aria-invalid:border-rust';
const ERROR_CLASS = 'text-rust mt-1 text-sm';
const QUIET_BUTTON_CLASS =
  'border-hairline bg-surface text-ink-2 hover:text-ink hover:bg-sunk rounded-[var(--r-sm)] border px-3 py-1.5 text-sm font-medium transition-colors';
const DANGER_BUTTON_CLASS =
  'border-rust text-rust hover:bg-rust/10 rounded-[var(--r-sm)] border px-3 py-1.5 text-sm font-medium transition-colors';
const CONFIRM_BUTTON_CLASS =
  'bg-rust text-paper rounded-[var(--r-sm)] px-4 py-2 text-sm font-medium transition-colors hover:brightness-95';
const CANCEL_LINK_CLASS =
  'border-hairline text-ink-2 hover:text-ink rounded-[var(--r-sm)] border px-4 py-2 text-sm transition-colors';
const CARRIAGE_OPTION_CLASS =
  'border-hairline has-[:checked]:border-blue-deep has-[:checked]:bg-blue-tint flex cursor-pointer items-center gap-1.5 rounded-[var(--r-sm)] border px-2 py-1 text-xs';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * `shallowRef`, not `ref`, and that is about correctness as much as cost. Every update below
 * replaces the whole tree with a fresh one from `applyReorderPlan`, so deep reactivity would
 * mean Vue proxying every item, every `overrides` blob and every gear embed in the pack to
 * observe mutations that never happen.
 */
const tree = shallowRef<readonly ListCategory[]>(normalise(props.categories));

/** False until `onMounted`. Everything that makes a row look DRAGGABLE is gated on it — see
 *  "WHAT HYDRATION CHANGES" in the header. Nothing that makes a row EDITABLE is: the forms
 *  render identically either way, which is the degradation claim. */
const enabled = shallowRef(false);

/** A reorder request is in flight. Dragging is suspended while it is: a second plan computed
 *  against a tree whose first move has not been confirmed yet would be planned from rows the
 *  server has not agreed to, and the two responses could then arrive in either order. One
 *  move at a time is the honest serialisation, and a move is one round trip. The FORMS are
 *  not suspended — they are ordinary submissions that navigate, and a navigation abandons
 *  this document rather than racing it. */
const pending = shallowRef(false);

const notice = shallowRef<{ readonly text: string; readonly kind: 'error' | 'status' } | null>(
  null,
);

type Drag =
  | { readonly kind: 'item'; readonly id: string; readonly categoryId: string }
  | { readonly kind: 'category'; readonly id: string };

/** Where the drop indicator currently sits: a slot in a run AS DRAWN, `0..n`. That is not
 *  the index the reorder engine means — `dropTargetIndex` in `src/lib/packs/drag.ts` is the
 *  conversion, and its comment is the one to read before touching any of this. */
type Marker =
  | { readonly kind: 'item'; readonly categoryId: string; readonly insertAt: number }
  | { readonly kind: 'category'; readonly insertAt: number };

const drag = shallowRef<Drag | null>(null);
const marker = shallowRef<Marker | null>(null);

/**
 * THE ROW THE POINTER IS HOLDING BY ITS GRIP, and it exists because the forms moved in here.
 *
 * A row is `draggable` only while the pointer went down on its grip, rather than always.
 * That is not decoration: inside a `draggable="true"` element a browser treats press-and-move
 * as the start of a drag, so selecting the text in a category name field, or dragging across
 * a quantity to replace it, picks the whole row up instead of selecting anything. "The row is
 * permanently draggable" and "the fields on that row behave like fields" cannot both be true.
 * Gating the attribute on the grip keeps the drag image the whole row — which is what makes
 * the gesture legible — while leaving every control on it behaving exactly as the same
 * control does outside the island.
 *
 * The attribute is read by the browser at `dragstart`, which is after `pointerdown`, so
 * setting it here is early enough. It is cleared on `pointerup` ANYWHERE (a press that never
 * became a drag, which is usually released a few pixels off the grip rather than on it), on
 * `pointercancel` (touch or pen taken away mid-gesture), and in `endDrag` (a press that did
 * become a drag) — see `grab` for why the window and not the grip carries those listeners.
 */
const grabbed = shallowRef<string | null>(null);

onMounted(() => {
  enabled.value = true;
});

// ---------------------------------------------------------------------------
// Derived: the rows as they are rendered
// ---------------------------------------------------------------------------

/** Position ascending, ties broken on id, at both levels — through the comparator the server
 *  orders by and the endpoint plans against, never a local
 *  `(a, b) => a.position - b.position`. The rows arrive sorted; sorting them again costs
 *  nothing and means this component cannot be the place the two sides start disagreeing. */
function normalise(categories: readonly ListCategory[]): ListCategory[] {
  return sortByPosition(categories).map((category) => ({
    ...category,
    pack_items: sortByPosition(category.pack_items),
  }));
}

/**
 * THE FIGURES, FROM `computeTotals` AND NOWHERE ELSE, AND NOW RENDERED EXACTLY ONCE ON THE
 * PAGE. No summation is written in this component, and none may be: `src/lib/totals.ts` is
 * the only place in the product where two weights are added.
 *
 * The page used to render a summary strip of its own ABOVE a second copy of the same figures
 * inside this island. Two renderings of one set of figures is one too many for the same
 * reason two renderings of one order were: the moment they can disagree, one of them is
 * lying and nothing on screen says which. They live here because this is where the tree they
 * are derived from lives. The page still folds the same tree through the same function for
 * the one figure it needs on its own — how many items deleting the pack would take — which
 * is a second CALLER of the one engine and not a second engine.
 *
 * WHAT MUST MOVE AND WHAT MUST NOT. A cross-category drop changes the two CATEGORY subtotals,
 * which is exactly what makes the recomputation worth doing. It changes no pack figure at all
 * — reordering moves no weight, buys nothing and packs nothing — so base, worn, consumable,
 * total, the packed count and the cost must read identically before and after every drag.
 * `tests/packs-drag.test.ts` asserts that over the full 60-item tree rather than leaving it
 * as a claim.
 *
 * It cannot throw here in practice: `computeTotals` refuses a malformed tree by design, and
 * the page's own frontmatter has already folded this exact tree through this exact function
 * before rendering — a tree that would throw never reaches this island, because the page that
 * hosts it would have failed first. The same argument covers `packItemToFormValues` below,
 * which refuses a row that is both worn and consumable exactly as `classifyPackItem` does.
 */
const totals = computed(() => computeTotals({ pack_categories: tree.value }));

/** One entry per currency, never a single number: `src/lib/money.ts` refuses to invent an
 *  exchange rate, so a pack holding GBP and USD gear has two costs and saying so is the only
 *  honest rendering. */
const prices = computed(() => [...totals.value.pricesByCurrency.values()]);

/** One item, as the template needs it: the stored row's id (which is what a form posts and
 *  what a drag names), the rollup's figures, and the state of a submission that failed on
 *  this row. Assembled here rather than in the template so that no figure is reached for
 *  through an optional chain with a `?? 0` behind it — a silent zero for a row whose weight
 *  could not be found is exactly the kind of wrong number this product must not print. */
interface ItemRow {
  readonly id: string;
  /** `name` is null only for a row whose gear was deleted and whose snapshot carried no
   *  name — unreachable through this product's write paths, but `ResolvedPackItem` types it
   *  as nullable and inventing a name would be inventing data. Two fallbacks because the
   *  sentence differs: a heading says "Unnamed item", a label says "this item". */
  readonly displayName: string;
  readonly spokenName: string;
  readonly isCustom: boolean;
  readonly bucketClass: string;
  readonly quantity: number;
  readonly lineWeightGrams: number;
  readonly unitWeightGrams: number;
  readonly linePrice: Money | null;
  readonly values: PackItemFormValues;
  readonly errors: readonly string[];
  readonly quantityInvalid: boolean;
  readonly carriageInvalid: boolean;
}

interface CategoryRow {
  readonly id: string;
  readonly name: string;
  readonly baseGrams: number;
  readonly totalGrams: number;
  readonly items: readonly ItemRow[];
  readonly renameError: string | null;
  readonly confirmingDelete: boolean;
}

/**
 * The tree and its rollups, zipped. `computeTotals` maps its input one-to-one and in order —
 * `pack.pack_categories.map(...)`, and the same for the items inside each category — so the
 * rollup at an index belongs to the row at that index. Zipping rather than looking up by id
 * is what makes every field above non-optional.
 */
const rows = computed<CategoryRow[]>(() =>
  tree.value.map((category, categoryIndex) => {
    const categoryTotals = totals.value.categories[categoryIndex];
    return {
      id: category.id,
      name: category.name,
      baseGrams: categoryTotals.base,
      totalGrams: categoryTotals.total,
      renameError: props.renameError?.categoryId === category.id ? props.renameError.message : null,
      confirmingDelete: props.pendingCategoryDeleteId === category.id,
      items: category.pack_items.map((item, itemIndex) => {
        const rollup = categoryTotals.items[itemIndex];
        const failed = props.itemError?.itemId === item.id ? props.itemError : null;
        return {
          id: item.id,
          displayName: rollup.name ?? 'Unnamed item',
          spokenName: rollup.name ?? 'this item',
          isCustom: rollup.source === 'snapshot',
          bucketClass: BUCKET_TEXT_CLASS[rollup.bucket],
          quantity: rollup.quantity,
          lineWeightGrams: rollup.lineWeightGrams,
          unitWeightGrams: rollup.unitWeightGrams,
          linePrice: rollup.linePrice,
          // The visitor's own rejected input for the one row that failed, the stored row for
          // every other.
          values: failed === null ? packItemToFormValues(item) : failed.values,
          errors: failed === null ? [] : Object.values(failed.errors),
          quantityInvalid: failed?.errors.quantity !== undefined,
          carriageInvalid: failed?.errors.carriage !== undefined,
        };
      }),
    };
  }),
);

const draggable = computed(() => enabled.value && !pending.value);

// ---------------------------------------------------------------------------
// Drag plumbing
// ---------------------------------------------------------------------------

function markerIsItem(categoryId: string, insertAt: number): boolean {
  const current = marker.value;
  return (
    current !== null &&
    current.kind === 'item' &&
    current.categoryId === categoryId &&
    current.insertAt === insertAt
  );
}

function markerIsCategory(insertAt: number): boolean {
  const current = marker.value;
  return current !== null && current.kind === 'category' && current.insertAt === insertAt;
}

/** The pointer went down on a grip: arm that one row, and only while it could actually be
 *  dragged — see `grabbed`. */
function grab(id: string): void {
  if (!draggable.value) return;
  grabbed.value = id;
  // THE RELEASE HAS TO BE LISTENED FOR ON THE WINDOW, NOT ON THE GRIP.
  //
  // A press that never becomes a drag is usually not released where it started: the pointer
  // has drifted a few pixels off the grip by the time the button comes up, and a `pointerup`
  // bound to the grip alone never hears it. That leaves the row armed permanently, which is
  // the exact state this whole mechanism exists to prevent — its own quantity and name fields
  // stop taking a press-and-drag to select, because the row picks itself up instead. The grip
  // keeps its own handler as well, so the common case needs no bubbling at all.
  //
  // `pointercancel` matters for touch and pen, where the browser can take the pointer away
  // from us (a scroll takes over, the gesture is interrupted) and no `pointerup` ever arrives.
  window.addEventListener('pointerup', release);
  window.addEventListener('pointercancel', release);
}

function release(): void {
  grabbed.value = null;
  window.removeEventListener('pointerup', release);
  window.removeEventListener('pointercancel', release);
}

/** The half of a row the pointer is in decides whether the indicator sits above it or below
 *  it, which is what makes "drop between these two" expressible with no gap to aim at. */
function slotFor(event: DragEvent, index: number): number {
  const row = event.currentTarget as HTMLElement;
  const box = row.getBoundingClientRect();
  return event.clientY - box.top < box.height / 2 ? index : index + 1;
}

/** `setData` is not decoration: Firefox refuses to begin a drag whose `dataTransfer` carries
 *  nothing. The value is never read back — the source of truth is `drag` — because a payload
 *  a page can read is a payload another page can forge, and this island reads nothing it was
 *  not handed as a prop. */
function beginDrag(event: DragEvent, source: Drag): void {
  drag.value = source;
  if (event.dataTransfer === null) return;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', source.id);
}

function endDrag(): void {
  drag.value = null;
  marker.value = null;
  release();
}

function overItem(event: DragEvent, categoryId: string, index: number): void {
  // A CATEGORY being dragged over an item row must be left to bubble to the category that
  // holds it, which is why this is a conditional `stopPropagation` rather than a `.stop`
  // modifier in the template: an unconditional one swallows the event for the drag this
  // handler is not interested in, and dropping a category anywhere over another category's
  // items would silently do nothing.
  if (drag.value?.kind !== 'item') return;
  event.stopPropagation();
  // preventDefault is what makes an element a drop target at all; without it the browser
  // refuses the drop and the drag "snaps back" with no explanation.
  event.preventDefault();
  if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'move';
  marker.value = { kind: 'item', categoryId, insertAt: slotFor(event, index) };
}

/** The category's item area as a whole: dropping on it means the end of that run, which is
 *  the only way to express "after the last item" and the only drop an EMPTY category can
 *  receive at all. Item rows stop the event so this does not overwrite their finer answer. */
function overItemArea(event: DragEvent, categoryId: string, itemCount: number): void {
  if (drag.value?.kind !== 'item') return;
  event.preventDefault();
  if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'move';
  marker.value = { kind: 'item', categoryId, insertAt: itemCount };
}

function overCategory(event: DragEvent, index: number): void {
  if (drag.value?.kind !== 'category') return;
  event.preventDefault();
  if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'move';
  marker.value = { kind: 'category', insertAt: slotFor(event, index) };
}

/**
 * ONE DROP HANDLER FOR THE WHOLE LIST, on the root, rather than one per target. Drop events
 * bubble, so a handler on a row and another on its list both fire for the same gesture and
 * the move is applied twice — which reads as "the item jumped two places" and is nearly
 * impossible to attribute afterwards. The pointer's answer is already in `marker`, so there
 * is nothing a per-target handler would know that this one does not.
 */
function onDrop(): void {
  const source = drag.value;
  const target = marker.value;
  endDrag();
  if (source === null || target === null) return;
  if (source.kind === 'item' && target.kind === 'item') {
    void moveItem(source.id, source.categoryId, target.categoryId, target.insertAt);
  } else if (source.kind === 'category' && target.kind === 'category') {
    void moveCategory(source.id, target.insertAt);
  }
}

// ---------------------------------------------------------------------------
// The moves
// ---------------------------------------------------------------------------

function indexIn(rowsIn: readonly { readonly id: string }[], id: string): number | null {
  const index = rowsIn.findIndex((row) => row.id === id);
  return index === -1 ? null : index;
}

async function moveItem(
  itemId: string,
  fromCategoryId: string,
  toCategoryId: string,
  insertAt: number,
): Promise<void> {
  const before = tree.value;
  const from = before.find((category) => category.id === fromCategoryId);
  const to = before.find((category) => category.id === toCategoryId);
  if (from === undefined || to === undefined) {
    fail(UNPLANNABLE_MESSAGE);
    return;
  }

  // Within one run the slot the pointer chose counts the dragged row itself; arriving from
  // another category it does not. `dropTargetIndex` is that distinction, and only that.
  const fromIndex = from.id === to.id ? indexIn(to.pack_items, itemId) : null;
  const toIndex = dropTargetIndex(insertAt, fromIndex);

  let plan: ReorderPlan;
  try {
    plan = planItemMove(
      { parentId: from.id, rows: from.pack_items },
      { parentId: to.id, rows: to.pack_items },
      itemId,
      toIndex,
    );
  } catch {
    fail(UNPLANNABLE_MESSAGE);
    return;
  }

  // A drag that ended where it began. `planChangesAnything` rather than `runs.length > 0`,
  // because a cross-category move can carry no position updates at all and still be real —
  // see that function's own comment.
  if (!planChangesAnything(plan)) return;

  tree.value = applyReorderPlan(before, plan);
  await send(before, {
    [REORDER_FIELD.target]: REORDER_TARGET.item,
    [REORDER_FIELD.packId]: props.packId,
    [REORDER_FIELD.itemId]: itemId,
    [REORDER_FIELD.toCategoryId]: to.id,
    [REORDER_FIELD.toIndex]: toIndex,
  });
}

async function moveCategory(categoryId: string, insertAt: number): Promise<void> {
  const before = tree.value;
  const toIndex = dropTargetIndex(insertAt, indexIn(before, categoryId));

  let plan: ReorderPlan;
  try {
    plan = planCategoryMove({ parentId: props.packId, rows: before }, categoryId, toIndex);
  } catch {
    fail(UNPLANNABLE_MESSAGE);
    return;
  }

  if (!planChangesAnything(plan)) return;

  tree.value = applyReorderPlan(before, plan);
  await send(before, {
    [REORDER_FIELD.target]: REORDER_TARGET.category,
    [REORDER_FIELD.packId]: props.packId,
    [REORDER_FIELD.categoryId]: categoryId,
    [REORDER_FIELD.toIndex]: toIndex,
  });
}

function fail(text: string): void {
  notice.value = { text, kind: 'error' };
}

function revert(before: readonly ListCategory[], text: string): void {
  tree.value = before;
  fail(text);
}

/**
 * The round trip. `before` is the tree the plan was computed against, and it is what both
 * outcomes are expressed in terms of: a failure restores it exactly, and a success replays
 * the SERVER's plan on top of it rather than on top of the optimistic render — the positions
 * in that plan describe the rows as the endpoint read them, so applying them to a tree that
 * has already moved would apply the move twice.
 *
 * WHAT THIS CANNOT REPAIR, said plainly: if the endpoint's read differed from this tree
 * because the pack changed in another tab, its plan is correct about rows this island does
 * not have. The reorder still lands correctly in the database — the endpoint recomputes
 * everything from its own rows — but the tree on screen stays as stale as it was. The
 * endpoint answers that case with a 409 and a sentence telling the visitor to reload, and
 * that sentence is shown rather than second-guessed.
 */
async function send(
  before: readonly ListCategory[],
  body: Record<string, string | number>,
): Promise<void> {
  pending.value = true;
  notice.value = null;
  try {
    const response = await fetch(PACK_REORDER_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    // A signed-out caller is answered with a 303 to sign-in rather than a bare 401 — the
    // rule for every route under /packs. `fetch` follows it, so what arrives here is the
    // sign-in page and `response.ok` describes that page rather than a move.
    if (response.redirected) {
      revert(before, SIGNED_OUT_MESSAGE);
      return;
    }

    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      revert(before, messageOf(payload) ?? SAVE_FAILED_MESSAGE);
      return;
    }

    const applied = planOf(payload);
    // An unreadable success body keeps the optimistic tree: the write landed, and this
    // island's own prediction came from the same functions the endpoint planned with, so it
    // is the best answer available — and a better one than throwing away a move that
    // actually happened.
    if (applied !== null) tree.value = applyReorderPlan(before, applied);
    notice.value = { text: SAVED_MESSAGE, kind: 'status' };
  } catch {
    // A network failure, a dropped connection, a Worker that never answered. The request may
    // or may not have been received, but nothing was CONFIRMED, so the tree goes back to what
    // the server last agreed to rather than showing a move nobody can vouch for.
    revert(before, OFFLINE_MESSAGE);
  } finally {
    pending.value = false;
  }
}

// ---------------------------------------------------------------------------
// Reading the response
// ---------------------------------------------------------------------------

/**
 * The endpoint answers `{ ok, message }` on every failure, in one shape, deliberately. Read
 * defensively anyway: this is a `fetch` whose response could be a proxy's error page or a
 * truncated body, and a `payload.message` read off `null` is a TypeError inside a drag.
 */
function messageOf(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const message = (payload as { message?: unknown }).message;
  return typeof message === 'string' && message !== '' ? message : null;
}

function readUpdates(value: unknown): PositionUpdate[] | null {
  if (!Array.isArray(value)) return null;
  const updates: PositionUpdate[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) return null;
    const { id, position } = entry as { id?: unknown; position?: unknown };
    if (typeof id !== 'string' || typeof position !== 'number' || !Number.isFinite(position)) {
      return null;
    }
    updates.push({ id, position });
  }
  return updates;
}

/**
 * The applied plan, or `null` for anything this cannot vouch for.
 *
 * EVERY FIELD IS CHECKED RATHER THAN CAST, and the reason is specific rather than ceremony: a
 * `position` that arrived as `undefined` — from a body shaped differently than expected —
 * would be written into a row and then compared, and `undefined` in a comparator produces
 * `NaN`, which sorts as "equal to everything". The pack would not error; it would render in
 * an order nobody chose. Refusing the whole plan is the only outcome that cannot do that.
 */
function planOf(payload: unknown): ReorderPlan | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const body = payload as { ok?: unknown; runs?: unknown; reparent?: unknown };
  if (body.ok !== true || !Array.isArray(body.runs)) return null;

  const runs: RunUpdate[] = [];
  for (const run of body.runs) {
    if (typeof run !== 'object' || run === null) return null;
    const { parentId, updates } = run as { parentId?: unknown; updates?: unknown };
    const read = readUpdates(updates);
    if (typeof parentId !== 'string' || read === null) return null;
    runs.push({ parentId, updates: read });
  }

  const raw = body.reparent;
  if (raw === null || raw === undefined) return { runs, reparent: null };
  if (typeof raw !== 'object') return null;
  const { id, parentId } = raw as { id?: unknown; parentId?: unknown };
  if (typeof id !== 'string' || typeof parentId !== 'string') return null;
  return { runs, reparent: { id, parentId } };
}
</script>

<template>
  <!--
    One drop handler for the whole list — see `onDrop`. `dragend` fires on the source element
    whether the drag ended in a drop or was abandoned over a non-target, which is what clears
    the indicator when somebody thinks better of it mid-drag.
  -->
  <section
    aria-labelledby="pack-contents-heading"
    class="mt-8"
    @drop.prevent="onDrop"
    @dragend="endDrag"
  >
    <div class="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
      <h2 id="pack-contents-heading" class="text-xl">Categories</h2>
      <p class="text-ink-3 text-sm">
        {{
          enabled
            ? 'Drag a category, or an item by its grip, to reorder it. Items can be dragged into another category. Reordering needs a pointer.'
            : 'Everything in this pack, in the order it is stored in.'
        }}
      </p>
    </div>

    <!--
      THE FIGURES, RENDERED ONCE ON THIS PAGE. Base, worn and consumable are the partition
      `computeTotals` guarantees — the three add up to the total by definition, not by
      coincidence — so they are rendered together rather than as one figure with the others
      hidden behind a link. They are derived from the tree in front of the visitor, so a drag
      that moves an item between categories redraws them; reordering moves no weight, so not
      one of them may change when it does.
    -->
    <dl
      class="border-hairline bg-surface mt-4 flex flex-wrap gap-x-10 gap-y-4 rounded-[var(--r)] border p-5"
    >
      <div v-for="bucket in WEIGHT_BUCKETS" :key="bucket">
        <dt class="text-ink-3 text-xs tracking-wide uppercase">{{ BUCKET_LABELS[bucket] }}</dt>
        <dd :class="`numeric mt-1 text-lg font-medium ${BUCKET_TEXT_CLASS[bucket]}`">
          {{ formatWeight(totals[bucket], props.weightSystem) }}
        </dd>
      </div>
      <div>
        <dt class="text-ink-3 text-xs tracking-wide uppercase">Total</dt>
        <dd class="numeric text-ink mt-1 text-lg font-medium">
          {{ formatWeight(totals.total, props.weightSystem) }}
        </dd>
      </div>
      <div>
        <dt class="text-ink-3 text-xs tracking-wide uppercase">Packed</dt>
        <dd class="numeric text-ink mt-1 text-lg font-medium">
          {{ totals.packedCount }} / {{ totals.itemCount }}
        </dd>
      </div>
      <div v-if="prices.length > 0">
        <dt class="text-ink-3 text-xs tracking-wide uppercase">Cost</dt>
        <dd class="numeric text-ink mt-1 text-lg font-medium">
          {{ prices.map((money) => formatMoney(money)).join(' · ') }}
        </dd>
      </div>
    </dl>

    <p
      v-if="notice"
      :role="notice.kind === 'error' ? 'alert' : 'status'"
      :class="
        notice.kind === 'error'
          ? 'border-rust/40 bg-rust/10 text-ink mt-4 rounded-[var(--r-sm)] border px-4 py-3 text-sm'
          : 'text-ink-2 mt-4 text-sm'
      "
    >
      {{ notice.text }}
    </p>

    <!--
      A pack with no categories is a valid, ordinary state — a pack somebody made a minute
      ago — and not an error. It renders as an invitation, and every total above it reads
      zero, which is the truth about an empty pack.
    -->
    <div
      v-if="rows.length === 0"
      class="border-hairline bg-surface mt-4 rounded-[var(--r)] border px-6 py-12 text-center"
    >
      <p class="text-ink-2">This pack has no categories yet.</p>
      <p class="text-ink-3 mt-2 text-sm">
        Categories are how a pack is grouped — Shelter, Sleep, Cooking, or whatever matches the
        trip. Add one below, then fill it from your closet.
      </p>
    </div>

    <ul v-else class="mt-4 space-y-6">
      <li
        v-for="(category, categoryIndex) in rows"
        :key="category.id"
        class="row border-hairline bg-surface rounded-[var(--r)] border"
        :class="{
          dragging: drag?.kind === 'category' && drag.id === category.id,
          'drop-before': markerIsCategory(categoryIndex),
          'drop-after': markerIsCategory(categoryIndex + 1) && categoryIndex === rows.length - 1,
        }"
        :draggable="draggable && grabbed === category.id"
        @dragstart="beginDrag($event, { kind: 'category', id: category.id })"
        @dragover="overCategory($event, categoryIndex)"
      >
        <div class="border-hairline flex flex-wrap items-end justify-between gap-4 border-b p-5">
          <!--
            The grip, and the only thing on this row that arms a drag. `aria-hidden` and not
            focusable on purpose: reordering is pointer-only (see the header), and a focusable
            handle a keyboard cannot then use would be the promise this component is careful
            not to make.
          -->
          <span
            v-if="enabled"
            class="grip text-ink-3 shrink-0 self-center"
            aria-hidden="true"
            @pointerdown="grab(category.id)"
            @pointerup="release"
          >
            <GripVertical :size="16" />
          </span>

          <form method="post" class="flex flex-1 flex-wrap items-end gap-3">
            <input type="hidden" name="intent" :value="PACK_INTENT.renameCategory" />
            <input type="hidden" :name="PACK_EDITOR_FIELD.categoryId" :value="category.id" />
            <div class="min-w-48 flex-1">
              <label :for="`category-name-${category.id}`" :class="LABEL_CLASS">
                Category name
              </label>
              <input
                :id="`category-name-${category.id}`"
                :name="PACK_CATEGORY_FORM_FIELD.name"
                type="text"
                :value="category.name"
                :aria-describedby="
                  category.renameError === null ? undefined : `category-name-error-${category.id}`
                "
                :aria-invalid="category.renameError === null ? undefined : 'true'"
                :class="INPUT_CLASS"
              />
              <p
                v-if="category.renameError !== null"
                :id="`category-name-error-${category.id}`"
                :class="ERROR_CLASS"
              >
                {{ category.renameError }}
              </p>
            </div>
            <button type="submit" :class="QUIET_BUTTON_CLASS">Rename</button>
          </form>

          <p class="text-ink-2 numeric text-sm">
            <span :class="`font-medium ${BUCKET_TEXT_CLASS.base}`">
              {{ formatWeight(category.baseGrams, props.weightSystem) }}
            </span>
            <span class="text-ink-3"> base of </span>
            <span class="text-ink font-medium">
              {{ formatWeight(category.totalGrams, props.weightSystem) }}
            </span>
          </p>

          <form v-if="!category.confirmingDelete" method="post">
            <input type="hidden" name="intent" :value="PACK_INTENT.deleteCategory" />
            <input type="hidden" :name="PACK_EDITOR_FIELD.categoryId" :value="category.id" />
            <button type="submit" :class="DANGER_BUTTON_CLASS">Delete category</button>
          </form>
        </div>

        <!--
          The reveal half of the two-step, rendered in place of the row's own delete button and
          naming the cascade BEFORE it happens. pack_items references pack_categories ON DELETE
          CASCADE (core_schema.sql:303), so deleting a category takes every item in it; a
          visitor who only meant to tidy a heading has to be told that in the same breath as
          being asked. No client-side confirm() anywhere in this — see the identical reveal on
          the two gear pages, whose gate this shares. It renders from a prop rather than from
          state of this component's own: what put the page in this state was a POST that wrote
          nothing, and the answer to it has to survive with JavaScript switched off.
        -->
        <div v-if="category.confirmingDelete" class="border-rust/40 bg-rust/10 border-b px-5 py-4">
          <h3 class="text-rust text-base">Confirm delete</h3>
          <p class="text-ink-2 mt-2 text-sm">
            Delete “{{ category.name }}” permanently?
            {{
              category.items.length === 0
                ? 'It holds no items.'
                : `Its ${category.items.length} item${category.items.length === 1 ? '' : 's'} will be removed from this pack with it.`
            }}
            This cannot be undone. Your closet is not affected — a pack item points at your gear and
            never owns it.
          </p>
          <div class="mt-4 flex flex-wrap gap-3">
            <form method="post">
              <input type="hidden" name="intent" :value="PACK_INTENT.deleteCategory" />
              <input type="hidden" :name="PACK_EDITOR_FIELD.categoryId" :value="category.id" />
              <!--
                Value from the same constant `confirmsGearDeletion` compares against, never a
                bare "1": the writer and the reader of this gate must not be able to drift
                apart.
              -->
              <input
                type="hidden"
                :name="BULK_FORM_FIELD.confirm"
                :value="GEAR_DELETE_CONFIRMATION_VALUE"
              />
              <button type="submit" :class="CONFIRM_BUTTON_CLASS">
                Delete category and its items
              </button>
            </form>
            <a :href="props.selfPath" :class="CANCEL_LINK_CLASS">Cancel</a>
          </div>
        </div>

        <!--
          An empty category is a legitimate drop target and the only way to move the last item
          out of one — so it gets the same `dragover` the item list gets, on a paragraph rather
          than on an empty <ul>, which would have no height to aim at.
        -->
        <p
          v-if="category.items.length === 0"
          class="text-ink-3 px-5 py-6 text-sm"
          :class="{ 'drop-into': markerIsItem(category.id, 0) }"
          @dragover="overItemArea($event, category.id, 0)"
        >
          Nothing in here yet. Add something from your closet below, or a one-off item.
        </p>

        <ul
          v-else
          class="divide-hairline divide-y"
          @dragover="overItemArea($event, category.id, category.items.length)"
        >
          <li
            v-for="(item, itemIndex) in category.items"
            :key="item.id"
            class="row px-5 py-4"
            :class="{
              dragging: drag?.kind === 'item' && drag.id === item.id,
              'drop-before': markerIsItem(category.id, itemIndex),
              'drop-after':
                markerIsItem(category.id, itemIndex + 1) && itemIndex === category.items.length - 1,
            }"
            :draggable="draggable && grabbed === item.id"
            @dragstart.stop="
              beginDrag($event, { kind: 'item', id: item.id, categoryId: category.id })
            "
            @dragover="overItem($event, category.id, itemIndex)"
          >
            <div class="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
              <p class="text-ink flex min-w-0 items-center gap-2 font-medium">
                <span
                  v-if="enabled"
                  class="grip text-ink-3 shrink-0"
                  aria-hidden="true"
                  @pointerdown="grab(item.id)"
                  @pointerup="release"
                >
                  <GripVertical :size="14" />
                </span>
                {{ item.displayName }}
                <span v-if="item.isCustom" class="text-ink-3 text-xs font-normal">
                  one-off item
                </span>
              </p>
              <p class="numeric text-sm">
                <span :class="`font-medium ${item.bucketClass}`">
                  {{ formatWeight(item.lineWeightGrams, props.weightSystem) }}
                </span>
                <span v-if="item.quantity > 1" class="text-ink-3">
                  ({{ formatWeight(item.unitWeightGrams, props.weightSystem) }} each)
                </span>
                <span v-if="item.linePrice !== null" class="text-ink-3">
                  · {{ formatMoney(item.linePrice) }}
                </span>
              </p>
            </div>

            <form method="post" class="mt-3 flex flex-wrap items-center gap-3">
              <input type="hidden" name="intent" :value="PACK_INTENT.saveItem" />
              <input type="hidden" :name="PACK_EDITOR_FIELD.itemId" :value="item.id" />

              <label class="text-ink-2 flex items-center gap-2 text-sm">
                <span>Qty</span>
                <input
                  :name="PACK_ITEM_FORM_FIELD.quantity"
                  type="text"
                  inputmode="numeric"
                  :value="item.values.quantity"
                  :aria-label="`Quantity of ${item.spokenName}`"
                  :aria-invalid="item.quantityInvalid ? 'true' : undefined"
                  class="border-hairline bg-surface text-ink aria-invalid:border-rust w-16 rounded-[var(--r-sm)] border px-2 py-1 text-sm"
                />
              </label>

              <!--
                ONE CONTROL, THREE OPTIONS — never two checkboxes. The fourth combination two
                checkboxes make easiest to produce (worn AND consumable) is refused by
                pack_items_worn_consumable_exclusive and would make the pack's own totals throw
                on read. A radio group cannot express it at all: the browser itself refuses to
                let two radios of one name be checked. See PACK_ITEM_CARRIAGES.
              -->
              <fieldset class="flex flex-wrap items-center gap-2">
                <legend class="sr-only">How {{ item.spokenName }} is carried</legend>
                <label
                  v-for="carriage in PACK_ITEM_CARRIAGES"
                  :key="carriage"
                  :class="CARRIAGE_OPTION_CLASS"
                  :title="PACK_ITEM_CARRIAGE_MEANINGS[carriage]"
                >
                  <input
                    type="radio"
                    :name="PACK_ITEM_FORM_FIELD.carriage"
                    :value="carriage"
                    :checked="carriage === item.values.carriage"
                    :aria-invalid="item.carriageInvalid ? 'true' : undefined"
                  />
                  {{ PACK_ITEM_CARRIAGE_LABELS[carriage] }}
                </label>
              </fieldset>

              <label class="text-ink-2 flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  :name="PACK_ITEM_FORM_FIELD.packed"
                  value="on"
                  :checked="item.values.packed !== ''"
                  class="accent-blue"
                />
                Packed
              </label>

              <button type="submit" :class="QUIET_BUTTON_CLASS">Save</button>
            </form>

            <ul v-if="item.errors.length > 0" class="mt-2 space-y-1">
              <li v-for="message in item.errors" :key="message" :class="ERROR_CLASS">
                {{ message }}
              </li>
            </ul>

            <!--
              ONE CLICK, NOT TWO, and this is the one destructive control on the page that is
              not behind the reveal-then-confirm step. It removes an APPEARANCE, not a piece of
              gear: a referenced item's closet row is untouched (rule 1 of the core schema),
              and putting it back is one tick in the picker below. The two controls that DO
              carry the step — deleting a category, deleting the pack — each destroy rows
              nothing else holds a copy of, which is the distinction the gesture is spent on.
            -->
            <form method="post" class="mt-2">
              <input type="hidden" name="intent" :value="PACK_INTENT.removeItem" />
              <input type="hidden" :name="PACK_EDITOR_FIELD.itemId" :value="item.id" />
              <button
                type="submit"
                class="text-ink-3 hover:text-rust text-xs underline transition-colors"
              >
                Remove {{ item.spokenName }} from this pack
              </button>
            </form>
          </li>
        </ul>
      </li>
    </ul>
  </section>
</template>

<style scoped>
/*
 * THE ONLY SHADOW IN THE PRODUCT, AND THE RULE ALLOWS EXACTLY THIS ONE. "Nothing casts a
 * shadow at rest. Elevation is expressed with --surface, --sunk and --hairline. Shadows are
 * reserved for transient overlays" (src/styles/tokens.css, CONTRIBUTING.md). A row under the
 * pointer mid-drag IS a transient overlay in the literal sense the rule means: it is lifted,
 * it is following a pointer, it is over the list rather than in it, and it is gone the moment
 * the button is released. Nothing else here casts one, at rest or otherwise, and the palette
 * defines no shadow token precisely because nothing was supposed to need one.
 */
.dragging {
  opacity: 0.55;
  box-shadow: 0 10px 24px rgb(0 0 0 / 0.22);
}

/*
 * The drop indicator: a 2px rule in --blue, drawn as a pseudo-element so that showing it
 * moves nothing. Blue is correct here under the palette's own rule — it marks where the
 * interaction will land, which is the definition of interactive rather than decorative — and
 * it is the same blue every other affordance on the page uses. Never invented: the value is
 * the token.
 */
.row {
  position: relative;
}

.row.drop-before::before,
.row.drop-after::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  height: 2px;
  background: var(--blue);
}

.row.drop-before::before {
  top: -1px;
}

.row.drop-after::after {
  bottom: -1px;
}

/* An empty category has no edge to draw a line against, so the whole target tints instead.
   --blue-tint is the palette's own pairing for this and carries its own dark cut. */
.drop-into {
  background: var(--blue-tint);
}

/* The affordance itself, and the only part of a row that arms a drag — see `grabbed`.
   `grab`/`grabbing` are the standard cursors for exactly this and are the only thing on this
   surface that says "this row can be picked up" to a pointer. */
.grip {
  display: inline-flex;
  cursor: grab;
}

.row.dragging {
  cursor: grabbing;
}

/*
 * prefers-reduced-motion is not optional here (CONTRIBUTING.md). `src/styles/global.css`
 * already neutralises transition and animation DURATIONS globally, so this block is not what
 * makes the rule hold — it is here because that global rule is a blanket applied to whatever
 * a component happens to declare, and a component that introduces motion of its own should
 * say what it does about it rather than rely on being caught. The transition below is the
 * only one this island adds, and it is the only one removed.
 */
.row {
  transition: opacity 120ms ease-out;
}

@media (prefers-reduced-motion: reduce) {
  .row {
    transition: none;
  }
}
</style>
