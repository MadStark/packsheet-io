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
 * projection of a plan onto the tree are `src/lib/packs/drag.ts`'s, the wire field names and
 * the request shape are `src/lib/packs/reorder-request.ts`'s, the round trip and every
 * decision about what its answer MEANS are `src/lib/packs/reorder-response.ts`'s, the form
 * field names, the intents and the delete gate's value are `src/lib/packs/{form,editor}.ts`'s
 * and `src/lib/gear/bulk.ts`'s, and the figures are `src/lib/totals.ts`'s. That is
 * deliberate to the point of being the design: everything below is event plumbing and
 * markup, because a decision taken inside a drag handler in this repository is a decision
 * nothing can execute. `tests/packs-drag.test.ts` can server-render this component —
 * `renderToString` needs no DOM — but `vitest.config.ts` sets `environment: 'node'` and
 * neither `@vue/test-utils` nor `jsdom` is a dependency, so there is no `DragEvent`, no
 * `dataTransfer` and no `getBoundingClientRect` to drive one with.
 *
 * THAT ARGUMENT COVERS THE POINTER HANDLERS AND NOTHING ELSE, which PK-37's independent
 * review had to point out because this file had quietly stretched it. Reading a response
 * body, deciding whether a 200 confirmed anything, and choosing the sentence to show all
 * happened here, none of them touching a pointer or a DOM, and therefore none of them
 * covered by "there is no `DragEvent`". They live in `reorder-response.ts` now and are
 * tested branch by branch. What remains below genuinely needs a pointer: `slotFor` reads a
 * `getBoundingClientRect`, and every handler around it reads a `DragEvent`.
 *
 * AND THE TYPES IN THIS BLOCK ARE NOT CHECKED EITHER, which is a second, independent reason
 * to keep it thin and was verified rather than assumed: `npm run check` runs `astro check`,
 * `tsc --noEmit`, ESLint and Prettier, and none of the four reads the `<script setup>` of a
 * `.vue` file — a bare `const n: number = 'no'` here exits 0. So an annotation below is a
 * statement of intent, correct and waiting for `vue-tsc`, while the same annotation on a
 * function in `src/lib/packs/` is enforced today. Move code out of here to have either the
 * compiler or a test look at it; adding `vue-tsc` to that script is worth doing and is not
 * this ticket's to do.
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
 * appear in `onMounted`, on the principle that a control drawn before it can work is a
 * control that lies for as long as the gap lasts. `ThemeToggle.vue` used the same idiom for
 * its icon and was this file's reference for it; PK-64 removed dark mode, so this component
 * is now both the only `client:*` island in the app and the only place the idiom lives.
 */
import { computed, onMounted, shallowRef } from 'vue';
import { GripVertical } from 'lucide-vue-next';
import {
  REORDER_FIELD,
  REORDER_TARGET,
  REORDER_UNPLANNABLE_MESSAGE,
  planChangesAnything,
  type ReorderIntent,
} from '../lib/packs/reorder-request';
import {
  planCategoryMove,
  planItemMove,
  sortByPosition,
  type ReorderPlan,
} from '../lib/packs/reorder';
import { applyReorderPlan, dropTargetIndex } from '../lib/packs/drag';
import {
  reorderNotice,
  reorderRevertsTree,
  sendReorder,
  type ReorderNotice,
} from '../lib/packs/reorder-response';
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
 *  message renders beside that category's own field rather than at the top of the page. The
 *  number of forms on that page is not a constant to quote — this component alone renders a
 *  rename and a delete per category (three when a delete is being confirmed) and a save and
 *  a remove per item, on top of the eight `src/pages/packs/[id].astro` renders itself — so it
 *  grows with the pack, and one shared error slot at the top could not say which rename
 *  failed. */
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
// Copy. NOT ONE SENTENCE IS SPELLED IN THIS FILE. Everything a round trip can produce is
// `src/lib/packs/reorder-response.ts`'s, written beside the branch that produces it; the one
// failure that never reaches a round trip — the shared engine refusing to plan at all — is
// `REORDER_UNPLANNABLE_MESSAGE` in `src/lib/packs/reorder-request.ts`, IMPORTED above rather
// than retyped. It used to be retyped here, byte for byte, which is the shape of duplication
// that survives review precisely because it looks like nothing: the two copies read
// identically until one of them is reworded, and then the same failure has two wordings
// depending on whether it was caught on the client or on the server. `planReorderIntent`
// returns that exact constant for the exact same refusal, so there is one string.
// ---------------------------------------------------------------------------

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

// PK-64 (Notebook Paper). Class strings, declared per file exactly as
// `src/pages/packs/[id].astro`, `src/pages/packs/index.astro` and
// `src/components/GearItemForm.astro` each declare their own — but now naming paper.css's
// vocabulary rather than a Tailwind box-and-border recipe. They are presentation, not a
// decision: nothing branches on them. QUIET_BUTTON_CLASS and CANCEL_LINK_CLASS are the same
// class (`.btn`, undecorated); kept as two names because that is what the call sites mean
// even though the box is identical, the way `[id].astro` also keeps them apart.
const LABEL_CLASS = 'field-label';
const INPUT_CLASS = 'field mt-1 w-full';
const ERROR_CLASS = 'field-error';
const QUIET_BUTTON_CLASS = 'btn';
const DANGER_BUTTON_CLASS = 'btn btn-danger';
const CANCEL_LINK_CLASS = 'btn';

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

/** The one status line under the list. `ReorderNotice` is imported rather than re-spelled as
 *  an inline object type: every value this ever holds comes out of `reorderNotice`, and two
 *  declarations of one shape is how the `'status'` arm ends up spelled `'success'` on one
 *  side. `REORDER_UNPLANNABLE_MESSAGE` is written into the same shape by `fail`. */
const notice = shallowRef<ReorderNotice | null>(null);

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
  /**
   * The failed fields, as `(field, message)` pairs rather than as bare sentences.
   *
   * THE FIELD NAME IS WHAT MAKES THE ERROR ANNOUNCEABLE. Each message is rendered in a `<li>`
   * whose `id` is built from the item id and this field name, and the control that failed
   * points at exactly that `id` with `aria-describedby`. A flat `string[]` cannot express
   * that: the list would still render, `aria-invalid="true"` would still be set, and a
   * screen-reader user would be told the field is invalid and never told why — which is the
   * state the category rename beside it has always avoided and the item row did not.
   */
  readonly errors: readonly { readonly field: string; readonly message: string }[];
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
          errors:
            failed === null
              ? []
              : Object.entries(failed.errors).map(([field, message]) => ({ field, message })),
          quantityInvalid: failed?.errors.quantity !== undefined,
          carriageInvalid: failed?.errors.carriage !== undefined,
        };
      }),
    };
  }),
);

const draggable = computed(() => enabled.value && !pending.value);

/** The notice split across the two permanent live regions in the template — see the comment
 *  there for why the politeness is chosen by which element gets the text rather than by a
 *  `role` that changes. Empty string rather than null so the region always renders a text
 *  node and a reader observes a change rather than an insertion. */
const statusText = computed(() => (notice.value?.kind === 'status' ? notice.value.text : ''));
const errorText = computed(() => (notice.value?.kind === 'error' ? notice.value.text : ''));

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

/**
 * Clears the drop indicator when the pointer leaves the list entirely.
 *
 * WITHOUT THIS THE INDICATOR STAYS DRAWN AT ITS LAST SLOT. Nothing else clears `marker`
 * until a drop or a `dragend`: drag a row out of the list and over the page around it and
 * the blue rule sits there naming a destination the pointer is no longer anywhere near, which
 * is a promise the surface cannot keep — release there and `onDrop` never fires, so the move
 * does not happen at the slot the line is pointing at.
 *
 * THE `relatedTarget` GUARD IS THE WHOLE OF IT, and it is why this is a function rather than
 * `@dragleave="marker = null"`. `dragleave` fires on every crossing INSIDE the subtree too —
 * every time the pointer moves from one row to the next, the outer element sees a leave for
 * the row being left before it sees the enter for the row being entered. Clearing
 * unconditionally would blank the indicator on every internal boundary and let it flicker
 * back on the next `dragover`. `relatedTarget` names the node being ENTERED, so a leave whose
 * destination is still inside this section is an internal crossing and is ignored. A null
 * `relatedTarget` — the pointer left the document, or the browser declined to say — is
 * treated as a real exit, which is the safe direction: the indicator disappears, and the next
 * `dragover` puts it back.
 */
function onDragLeave(event: DragEvent): void {
  const root = event.currentTarget as HTMLElement;
  const entering = event.relatedTarget;
  if (entering instanceof Node && root.contains(entering)) return;
  marker.value = null;
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
    fail(REORDER_UNPLANNABLE_MESSAGE);
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
    fail(REORDER_UNPLANNABLE_MESSAGE);
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
    fail(REORDER_UNPLANNABLE_MESSAGE);
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

/**
 * The round trip, which this component no longer takes any decision inside.
 *
 * `sendReorder` PERFORMS IT AND SAYS WHAT IT ESTABLISHED; the three lines below are the
 * whole of what is left here, because they are the only three that touch a Vue ref. Read
 * `src/lib/packs/reorder-response.ts`'s branch table for what each outcome means and why
 * six of the seven are errors — including two that keep the optimistic order on screen.
 * Every one of those branches is executed by `tests/packs-reorder-response.test.ts`; none
 * of them was reachable by any test while it lived in this file, and the "no pointer in
 * `environment: 'node'`" argument that kept the drag handlers here never covered it.
 *
 * `before` IS THE TREE THE PLAN WAS COMPUTED AGAINST, and it is what every outcome is
 * expressed in terms of: a revert restores it exactly, and the server's plan is replayed on
 * top of it rather than on top of the optimistic render — the positions in that plan
 * describe the rows as the endpoint read them, so applying them to a tree that has already
 * moved would apply the move twice.
 *
 * `pending` IS CLEARED IN A `finally` AND THAT NOW MEANS SOMETHING. `sendReorder` is total
 * and carries its own deadline, so this always settles; before it did not, and a stalled
 * request left every row in the pack undraggable (`draggable` is gated on `!pending`) with
 * no notice on screen, for as long as the connection stayed open.
 */
async function send(before: readonly ListCategory[], body: ReorderIntent): Promise<void> {
  pending.value = true;
  notice.value = null;
  try {
    const outcome = await sendReorder(fetch, body, before);
    if (outcome.kind === 'applied') tree.value = applyReorderPlan(before, outcome.plan);
    else if (reorderRevertsTree(outcome)) tree.value = before;
    notice.value = reorderNotice(outcome);
  } finally {
    pending.value = false;
  }
}
</script>

<template>
  <!--
    One drop handler for the whole list — see `onDrop`. `dragend` fires on the source element
    whether the drag ended in a drop or was abandoned over a non-target, which is what clears
    the indicator when somebody thinks better of it mid-drag. `dragleave` covers the case in
    between the two: the pointer is still down and has wandered off the list, where nothing
    would otherwise take the indicator down — see `onDragLeave` for why it cannot simply
    assign null.
  -->
  <section
    aria-labelledby="pack-contents-heading"
    class="sheet"
    @drop.prevent="onDrop"
    @dragend="endDrag"
    @dragleave="onDragLeave"
  >
    <div class="sheet-body">
      <div class="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <h2 id="pack-contents-heading" class="section-title">Categories</h2>
        <p class="hint">
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

        `.ledger-figures` (paper.css, DESIGN.md §7): flat inside this sheet, a hairline above
        and hairlines between figures — not a second surface. Hidden when the pack has no
        categories, per §9 ("an empty page has no figures to report"): every one of these
        would read zero, and a row of zeros above an empty-state invitation is worse than no
        row at all.
      -->
      <dl v-if="rows.length > 0" class="ledger-figures mt-8">
        <div v-for="bucket in WEIGHT_BUCKETS" :key="bucket">
          <dt>{{ BUCKET_LABELS[bucket] }}</dt>
          <dd :class="`numeric ${BUCKET_TEXT_CLASS[bucket]}`">
            {{ formatWeight(totals[bucket], props.weightSystem) }}
          </dd>
        </div>
        <div>
          <dt>Total</dt>
          <dd class="numeric">{{ formatWeight(totals.total, props.weightSystem) }}</dd>
        </div>
        <div>
          <dt>Packed</dt>
          <dd class="numeric">{{ totals.packedCount }} / {{ totals.itemCount }}</dd>
        </div>
        <div v-if="prices.length > 0">
          <dt>Cost</dt>
          <dd class="numeric">{{ prices.map((money) => formatMoney(money)).join(' · ') }}</dd>
        </div>
      </dl>

      <!--
        TWO PERMANENT LIVE REGIONS, AND THE PERMANENCE IS THE POINT. A live region has to be in
        the accessibility tree BEFORE its content changes: an assistive technology announces the
        DIFFERENCE between what a region held and what it now holds, so a region that is
        inserted already carrying its text has no previous state to differ from and the
        announcement is commonly dropped entirely. That is what `v-if="notice"` on a single
        element did — the element and its sentence appeared in the same tick, and "Order saved."
        often went unspoken. Both elements below are always rendered; only their text changes.

        TWO OF THEM RATHER THAN ONE WITH A SWAPPING `role`, for the same reason: changing a
        live region's role or politeness after it is in the tree is not reliably picked up.
        Keeping one polite `status` and one assertive `alert` means the politeness is decided by
        WHICH element receives the text, which is a change assistive technology does observe.
        Six of the seven outcomes in `src/lib/packs/reorder-response.ts` are errors and belong
        in the assertive one; only `applied` is a status.

        An empty region is `sr-only` rather than hidden: `display: none` and `hidden` take a
        region out of the tree, which is the failure this markup exists to avoid, restated.

        NEITHER IS A BOXED ALERT (DESIGN.md §2.5): a note may only lie directly on the paper,
        never inside a sheet, and this notice is scoped to the list this sheet holds — so it
        stays plain text in the system voice, rust for the error case, rather than growing a
        second surface.
      -->
      <p role="status" :class="statusText === '' ? 'sr-only' : 'hint mt-4'">
        {{ statusText }}
      </p>
      <p role="alert" :class="errorText === '' ? 'sr-only' : 'hint text-rust mt-4'">
        {{ errorText }}
      </p>

      <!--
        A pack with no categories is a valid, ordinary state — a pack somebody made a minute
        ago — and not an error. It renders as an invitation, and every total above it reads
        zero, which is the truth about an empty pack. `.blank` per DESIGN.md §9 — not a
        bordered box.
      -->
      <div v-if="rows.length === 0" class="blank">
        <p class="section-title">This pack has no categories yet.</p>
        <p class="hint mt-2">
          Categories are how a pack is grouped — Shelter, Sleep, Cooking, or whatever matches the
          trip. Add one below, then fill it from your closet.
        </p>
      </div>

      <!-- DESIGN.md §7: a ledger-style list on hairlines, not a box per category — the
           category-to-category divider is the hairline `divide-y` draws; nothing here is
           bordered or filled at rest. The drag affordances (`.row`, `.dragging`,
           `.drop-before`/`.drop-after`) are untouched, in `<style scoped>` below. -->
      <ul v-else class="divide-hairline mt-8 divide-y">
        <li
          v-for="(category, categoryIndex) in rows"
          :key="category.id"
          class="row"
          :class="{
            dragging: drag?.kind === 'category' && drag.id === category.id,
            'drop-before': markerIsCategory(categoryIndex),
            'drop-after': markerIsCategory(categoryIndex + 1) && categoryIndex === rows.length - 1,
          }"
          :draggable="draggable && grabbed === category.id"
          @dragstart="beginDrag($event, { kind: 'category', id: category.id })"
          @dragover="overCategory($event, categoryIndex)"
        >
          <!--
          NOTE THE ASYMMETRY WITH THE ITEM ROW BELOW, WHICH IS DELIBERATE AND IS THE PAIR TO
          READ TOGETHER. This `dragstart` has NO `.stop`; the item `<li>`'s has one. Both
          follow from the same fact: an item `<li>` is a DESCENDANT of the category `<li>`, so
          a `dragstart` on an item bubbles here.

          On the item, `.stop` is load-bearing. Without it every item drag would fire the item
          handler and then this one, and this one would overwrite `drag` with
          `{ kind: 'category' }` — after which `overItem` refuses to run (`drag.value?.kind
          !== 'item'`), no item marker is ever set, and `onDrop` finds a category source with
          no category marker and returns having done nothing. Item drags would silently stop
          working, with no error anywhere.

          Here, the absence is equally deliberate: only one element deep in this subtree can
          be the `draggable` source at a time (see `grabbed`), so nothing bubbles into this
          handler except the drag it is for. `overItem` is the mirror image on the `dragover`
          side and gets its own eight lines there, because it has to make the decision at
          runtime rather than in the template.
        -->
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
              :class="{ busy: !draggable }"
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
              <!--
              THE NAME SAYS WHICH ROW, in the same way the remove-item control at the bottom
              of an item row always has. A screen reader listing this page's controls reads
              them out of context, and a pack with nine categories otherwise produces nine
              buttons called "Rename" and nine called "Delete category" with nothing to tell
              them apart. The distinguishing half is `sr-only` so the visible label stays the
              single word the layout is built around — and because WCAG 2.5.3 (Label in Name)
              requires the accessible name to CONTAIN the visible one, which it does: the
              visible text is the first thing in the button and the context follows it.
            -->
              <button type="submit" :class="QUIET_BUTTON_CLASS">
                Rename <span class="sr-only">{{ category.name }}</span>
              </button>
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
              <!-- Named, for the reason the Rename button above gives. -->
              <button type="submit" :class="DANGER_BUTTON_CLASS">
                Delete category <span class="sr-only">{{ category.name }}</span>
              </button>
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
          <!--
          DESIGN.md §2.5: a note may only lie directly on the paper, never inside a sheet, and
          this reveal is inside the category row's own sheet — so it cannot take the
          `.note.note-danger` wash the page-level pack-delete confirmation does. Emphasis
          comes from rules, size and position instead: a rust heading, a hairline below it
          (matching the header row above), and the same `.btn.btn-danger` box every
          destructive control on the site uses.
        -->
          <div v-if="category.confirmingDelete" class="border-hairline border-b px-5 py-4">
            <h3 class="section-title text-rust">Confirm delete</h3>
            <p class="hint mt-2">
              Delete “{{ category.name }}” permanently?
              {{
                category.items.length === 0
                  ? 'It holds no items.'
                  : `Its ${category.items.length} item${category.items.length === 1 ? '' : 's'} will be removed from this pack with it.`
              }}
              This cannot be undone. Your closet is not affected — a pack item points at your gear
              and never owns it.
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
                <button type="submit" class="btn btn-danger">Delete category and its items</button>
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
                  markerIsItem(category.id, itemIndex + 1) &&
                  itemIndex === category.items.length - 1,
              }"
              :draggable="draggable && grabbed === item.id"
              @dragstart.stop="
                beginDrag($event, { kind: 'item', id: item.id, categoryId: category.id })
              "
              @dragover="overItem($event, category.id, itemIndex)"
            >
              <!--
              `.stop` ON `dragstart` IS NOT TIDINESS. This `<li>` sits inside the category
              `<li>`, which carries its own `dragstart`. Drag events bubble, so without the
              modifier every item drag would call `beginDrag` twice — once with
              `{ kind: 'item' }` and then, from the ancestor, with `{ kind: 'category' }`,
              which wins because it runs second. The consequences are all silent: `overItem`
              returns early because the drag is not an item drag, so no item marker is ever
              set; `overCategory` does set a category marker; and `onDrop` sees a category
              source with a category marker and moves a CATEGORY, or — if the pointer stayed
              over items — matches neither pair and does nothing at all. Either way the
              visitor drags an item and nothing they asked for happens.

              The category `<li>` deliberately does NOT carry `.stop`; see the note beside its
              own `dragstart` for why the two differ.
            -->
              <div class="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
                <p class="text-ink written written flex min-w-0 items-center gap-2 font-medium">
                  <span
                    v-if="enabled"
                    class="grip text-ink-3 shrink-0"
                    :class="{ busy: !draggable }"
                    aria-hidden="true"
                    @pointerdown="grab(item.id)"
                    @pointerup="release"
                  >
                    <GripVertical :size="14" />
                  </span>
                  {{ item.displayName }}
                  <span v-if="item.isCustom" class="system system text-ink-3 text-xs font-normal">
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

                <!--
                THE ACCESSIBLE NAME STARTS WITH THE VISIBLE ONE, which is WCAG 2.5.3 (Label
                in Name) and not a stylistic preference. The visible label is "Qty"; the
                accessible name has to CONTAIN that string, or somebody driving the page by
                voice who says "click Qty" targets a control whose name the speech engine
                cannot match. It used to read "Quantity of {item}", which shares not one word
                with what is on screen. The item name is still in there, because a page can
                hold forty of these and "Qty" alone names none of them.

                `aria-describedby` points at this row's own error message when there is one —
                the pattern the category rename above has always used. Without it a screen
                reader says "invalid entry" and stops, which is the announcement that tells a
                visitor something is wrong and withholds the only thing that would let them
                fix it.
              -->
                <label class="text-ink-2 flex items-center gap-2 text-sm">
                  <span class="system system">Qty</span>
                  <input
                    :name="PACK_ITEM_FORM_FIELD.quantity"
                    type="text"
                    inputmode="numeric"
                    :value="item.values.quantity"
                    :aria-label="`Qty for ${item.spokenName}`"
                    :aria-describedby="
                      item.quantityInvalid ? `item-${item.id}-error-quantity` : undefined
                    "
                    :aria-invalid="item.quantityInvalid ? 'true' : undefined"
                    class="field w-16"
                  />
                </label>

                <!--
                ONE CONTROL, THREE OPTIONS — never two checkboxes. The fourth combination two
                checkboxes make easiest to produce (worn AND consumable) is refused by
                pack_items_worn_consumable_exclusive and would make the pack's own totals throw
                on read. A radio group cannot express it at all: the browser itself refuses to
                let two radios of one name be checked. See PACK_ITEM_CARRIAGES. Presented as one
                segmented control (DESIGN.md §6: a choice of three or fewer), the same box
                the one-off item form's carriage field uses.
              -->
                <fieldset class="flex flex-wrap items-center gap-2">
                  <legend class="sr-only">How {{ item.spokenName }} is carried</legend>
                  <div class="segmented">
                    <label
                      v-for="carriage in PACK_ITEM_CARRIAGES"
                      :key="carriage"
                      class="segment"
                      :title="PACK_ITEM_CARRIAGE_MEANINGS[carriage]"
                    >
                      <!-- `aria-describedby` on each radio rather than on the fieldset: support
                       for a description on a grouping element is inconsistent, and the
                       invalid state is set here, so the explanation belongs on the same
                       node as the thing it explains. -->
                      <input
                        type="radio"
                        :name="PACK_ITEM_FORM_FIELD.carriage"
                        :value="carriage"
                        :checked="carriage === item.values.carriage"
                        :aria-describedby="
                          item.carriageInvalid ? `item-${item.id}-error-carriage` : undefined
                        "
                        :aria-invalid="item.carriageInvalid ? 'true' : undefined"
                      />
                      {{ PACK_ITEM_CARRIAGE_LABELS[carriage] }}
                    </label>
                  </div>
                </fieldset>

                <label class="text-ink-2 flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    :name="PACK_ITEM_FORM_FIELD.packed"
                    value="on"
                    :checked="item.values.packed !== ''"
                    class="checkbox"
                  />
                  Packed
                </label>

                <!-- Named, for the reason the category Rename button gives: an item row per
                   piece of gear means a pack of forty items otherwise offers forty buttons
                   called "Save". -->
                <button type="submit" :class="QUIET_BUTTON_CLASS">
                  Save <span class="sr-only">{{ item.spokenName }}</span>
                </button>
              </form>

              <!-- One `id` per FAILED FIELD, not one for the list: the quantity input and the
                 carriage radios each point at their own message, so a screen reader reads
                 the sentence belonging to the control it is on rather than every sentence on
                 the row. See `ItemRow.errors` for why the field name is carried this far. -->
              <ul v-if="item.errors.length > 0" class="mt-2 space-y-1">
                <li
                  v-for="entry in item.errors"
                  :id="`item-${item.id}-error-${entry.field}`"
                  :key="entry.field"
                  :class="ERROR_CLASS"
                >
                  {{ entry.message }}
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
    </div>
  </section>
</template>

<style scoped>
/*
 * THE ONLY UNIFORM DROP SHADOW IN THE PRODUCT, AND IT IS A TOKEN. It used to be the only
 * shadow of any kind, and used to need an exemption: "nothing casts a shadow at rest" was a
 * standing rule, and this was written as its single admitted exception.
 *
 * PK-64 SUPERSEDED THAT RULE. Notebook Paper's depth model is a shadow at rest — the corner
 * curl of DESIGN.md §2.4 is on every sheet on the site — so this no longer needs an
 * exemption and no longer has one. What survives of the rule is the part that still bites
 * here: no uniform drop shadows, and this is the one place that breaks it. That is
 * deliberate rather than overlooked. The curl says "a sheet resting on paper"; a dragged row
 * is genuinely picked up, which is a different physical claim and wants a different shadow.
 * A SECOND one would be the moment to re-read this paragraph rather than to add a token.
 *
 * The value lives in tokens.css as --shadow-drag, because a colour invented at a call site
 * is a colour with no reviewer. Its dark cut went with dark mode, and it is now mixed from
 * --shadow-ink like every other shadow — warm, never black.
 *
 * WHAT THIS IS ACTUALLY DRAWN ON, because an earlier version of this comment described a
 * mechanism the browser does not have. It said the row was "lifted, following a pointer, over
 * the list rather than in it". It is not. With native HTML5 drag the source element STAYS IN
 * NORMAL FLOW for the whole gesture; what follows the pointer is a separate drag image the
 * browser snapshots at `dragstart`, before this class lands, and which no CSS here can reach.
 * So the shadow is painted on the in-flow row sitting in the list at 0.55 opacity — the row
 * left behind, not the one in motion.
 *
 * IT IS STILL TRANSIENT, which is what keeps it honest. The state this selector matches is
 * the interval between `dragstart` and `dragend` and nothing else, cleared by `endDrag` on
 * every exit including an abandoned drag.
 * What the shadow does is mark WHICH row the gesture is carrying, on a list where the faded
 * row and its neighbours are otherwise the same shape — the drag image is a snapshot the
 * visitor is looking at, not a thing they are looking for. Nothing else on this surface casts
 * a shadow, at rest or otherwise, and a second one is a reason to re-read the rule rather
 * than to add a second token.
 */
.dragging {
  opacity: 0.55;
  box-shadow: var(--shadow-drag);
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

/*
 * WHILE A MOVE IS IN FLIGHT THE GRIP STOPS CLAIMING IT CAN BE GRABBED. `draggable` is gated
 * on `!pending`, so for the length of a round trip `grab()` returns immediately and no row
 * can be picked up — and a grip still drawing `cursor: grab` through that window is exactly
 * the affordance-that-cannot-work this component's header argues against for the
 * pre-hydration case. Same rule, second window.
 *
 * DIMMED AND RE-CURSORED RATHER THAN REMOVED, deliberately: `v-if`-ing the grip out would
 * reflow every row in the pack the instant a drag lands and reflow them back when the
 * response arrives, which is a far larger lie than a stale cursor. `progress` rather than
 * `not-allowed`, because the state is "busy", not "refused" — it clears itself.
 */
.grip.busy {
  cursor: progress;
  opacity: 0.45;
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
