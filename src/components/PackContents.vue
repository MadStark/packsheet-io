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
 * What hydration adds is dragging, plus — since PK-73 — two conveniences on the row's `…`
 * menu that it would work without: closing when you press away from it, and closing on
 * Escape. See `openMenus`. It adds no CAPABILITY: the menu itself is a `<details>` and opens
 * with no script at all, which is why the carriage choice, the packed toggle and Remove could
 * move into one. `tests/packs-drag.test.ts` renders this component with Vue's own
 * `renderToString` and asserts both halves of that claim: the forms are in the server output,
 * and no grip, no `draggable` and no drop target is.
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
 * rename, quantity step, carriage change, packed toggle, remove and delete — is a real form,
 * in the tab order, operable by keyboard alone, and unchanged by whether this component ever
 * hydrates. PK-73 moved several of them behind a `…` menu and that sentence still holds: a
 * `<summary>` is focusable and toggles on Enter and on Space by itself, so what the menu costs
 * a keyboard is one extra press, not reachability.
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
 * `renderToString` needs no DOM — but `vitest.config.ts` sets `environment: 'node'`,
 * `@vue/test-utils` is not a dependency, and that file does not opt into the `jsdom`
 * environment PK-69 added for `tests/modal.test.ts`, so there is no `DragEvent`, no
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
import { computed, onBeforeUnmount, onMounted, shallowRef } from 'vue';
import {
  Check,
  Ellipsis,
  Flame,
  GripVertical,
  Minus,
  Package,
  Pencil,
  Plus,
  Shirt,
  Trash2,
  type LucideProps,
} from 'lucide-vue-next';
import type { FunctionalComponent } from 'vue';
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
  type PackItemCarriage,
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
 *  The other two are aliases in the same shape — `--w-worn` is `var(--worn)` and
 *  `--w-cons` is `var(--ochre)` — so each stays tied to the accent it means rather than
 *  repeating its hex. (They used to be described as carrying dark cuts; PK-64 removed dark
 *  mode, so no token in this product has one.) None is decorative: each marks which total a
 *  number belongs to. Compiler-checked as a `Record<WeightBucket, …>` so a fourth bucket
 *  fails to build here rather than rendering uncoloured. */
const BUCKET_TEXT_CLASS: Record<WeightBucket, string> = {
  base: 'text-w-base',
  worn: 'text-w-worn',
  consumable: 'text-w-cons',
};

/**
 * PK-73. An icon per carriage option, because the design feedback asks for the choice to be
 * "an icon in a `…` option submenu" rather than the inline segmented control it was.
 *
 * THE ICON IS NEVER THE WHOLE CONTROL. Each menu entry renders this icon AND
 * `PACK_ITEM_CARRIAGE_LABELS`' word beside it, for the reason `PACK_ITEM_CARRIAGE_MEANINGS`
 * gives about hints: a visitor who cannot interpret a pictogram — and there is no pictogram
 * for "used up during the trip" that anybody reads correctly cold — must still be able to
 * choose from what is on screen. The icon is recognition, the label is the meaning.
 *
 * `Package` for carried, `Shirt` for worn and `Flame` for consumable, and the third is the
 * one to justify: the migration's own wording is "used up during the trip, like food or
 * fuel", and a flame is the half of that pair that does not collide with `Package`. Typed as
 * a `Record<PackItemCarriage, …>` so a fourth carriage fails to build here rather than
 * rendering an entry with no icon.
 */
const CARRIAGE_ICONS: Record<PackItemCarriage, FunctionalComponent<LucideProps>> = {
  carried: Package,
  worn: Shirt,
  consumable: Flame,
};

// PK-64 (Notebook Paper). Class strings, declared per file exactly as
// `src/pages/packs/[id].astro`, `src/pages/packs/index.astro` and
// `src/components/GearItemForm.astro` each declare their own — but now naming paper.css's
// vocabulary rather than a Tailwind box-and-border recipe. They are presentation, not a
// decision: nothing branches on them.
//
// PK-73 LEFT TWO OF THE SIX. `LABEL_CLASS`, `INPUT_CLASS`, `QUIET_BUTTON_CLASS` and
// `DANGER_BUTTON_CLASS` went with the controls that used them: a one-line row has no room
// for a label above a field, and Rename, Save and Delete category are `.row-menu-item`s in a
// `…` menu now rather than `.btn` boxes on the row. The two that remain are the two the
// two-step delete confirmation still uses — that block is a full-width reveal, not a row, and
// keeps the page's ordinary buttons.
const ERROR_CLASS = 'field-error';
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

/**
 * THE ROW'S `…` MENU IS A `<details>`, AND EVERYTHING BELOW IS AN ENHANCEMENT ON TOP OF ONE.
 *
 * PK-73 moved the carriage choice, the packed toggle and Remove off the row and into a
 * per-row overflow menu. The obvious way to build one is a button and a `click` handler, and
 * that way is not available here: this component's whole contract (see "EVERY CONTROL IN
 * HERE IS A PLAIN FORM" above) is that the markup the server sends IS the editor. A menu that
 * only opens once a bundle has arrived would put three of the four controls on every item row
 * behind JavaScript, which is a larger capability loss than anything hydration has ever added
 * here.
 *
 * `<details>`/`<summary>` opens with no script at all, is in the tab order by itself, toggles
 * on Enter AND Space, and is announced as an expandable group. So the menu WORKS before this
 * ref exists and works forever if the bundle never lands.
 *
 * What a bare `<details>` does not do is the two things a visitor expects of a menu once the
 * page is live: close when you click away from it, and close on Escape. Both are added here
 * and BOTH ARE OPTIONAL — a visitor without them closes the menu the same way they opened it,
 * by pressing its own summary, which is a mild inconvenience and not a broken control. That
 * is the line this component draws everywhere: hydration may make a working thing nicer, and
 * may not be the reason a thing works.
 *
 * SCOPED TO THIS COMPONENT'S OWN SUBTREE rather than to `document`, through `listRoot`. There
 * is exactly one island on this page today, so a document-wide query would find the same
 * elements — but "there is only one island" is a fact about the page in August 2026 and not a
 * property this component can rely on, and a handler that reaches outside its own root is the
 * kind of thing that only misbehaves once a second island exists.
 */
const listRoot = shallowRef<HTMLElement | null>(null);

function openMenus(): HTMLDetailsElement[] {
  const root = listRoot.value;
  if (root === null) return [];
  return [...root.querySelectorAll<HTMLDetailsElement>('details.row-menu[open]')];
}

/** A press anywhere outside an open menu closes it. `pointerdown` and not `click`, so the
 *  menu is gone before whatever was pressed reacts — a `click` listener fires after the
 *  press has already landed on the control underneath, which reads as a menu that lingers. */
function closeMenusOutside(event: PointerEvent): void {
  const target = event.target;
  for (const menu of openMenus()) {
    if (target instanceof Node && menu.contains(target)) continue;
    menu.open = false;
  }
}

/** Escape closes the menu the focus is in and PUTS THE FOCUS BACK ON ITS SUMMARY. Closing a
 *  `<details>` whose panel holds the focused element leaves the focus on a node that is now
 *  `display: none`, which browsers resolve by moving it to `<body>` — so a keyboard visitor
 *  who dismisses a menu would lose their place in a list of forty rows. Returning it to the
 *  summary is where they were before they opened it. */
function closeMenuOnEscape(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return;
  const active = document.activeElement;
  for (const menu of openMenus()) {
    if (!(active instanceof Node) || !menu.contains(active)) continue;
    menu.open = false;
    menu.querySelector('summary')?.focus();
    // Stops the key reaching anything else that treats Escape as "dismiss" — a modal this
    // island is rendered inside one day, for instance.
    event.stopPropagation();
    return;
  }
}

onMounted(() => {
  enabled.value = true;
  document.addEventListener('pointerdown', closeMenusOutside);
  document.addEventListener('keydown', closeMenuOnEscape);
});

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', closeMenusOutside);
  document.removeEventListener('keydown', closeMenuOnEscape);
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
  /**
   * THE STORED TRIPLE — the row's own quantity (above), carriage and packed, as the database
   * holds them.
   *
   * PK-73 turned every per-item control into its own small form (see the template's own
   * note), and each of those forms has to carry the two settings it is NOT changing as hidden
   * fields — `parsePackItemForm` writes all three columns on every save, so a form that
   * omitted `carriage` would be refused and one that omitted `packed` would quietly unpack
   * the row.
   *
   * THIS ROW USED TO CARRY A `values` FIELD AS WELL, AND ITS REMOVAL IS A DECISION RATHER
   * THAN A TIDY-UP. `values` was `packItemToFormValues(item)` for every row except the one a
   * submission had just failed for, where it was what the VISITOR TYPED and was refused —
   * because the point of it was to redisplay a rejected value in the field it came from,
   * rather than silently reverting to the stored one and inviting them to save the revert
   * back. That was right when the row carried a free quantity field and a radio group.
   *
   * There is no field left to redisplay. Quantity is two buttons carrying computed numbers,
   * carriage is three buttons carrying three constants, and packed is one button carrying the
   * opposite of what is stored — so a rejected submission has nothing a visitor needs to
   * correct in place. What it has is a message, which still renders, still carries an `id` per
   * failed field, and is still pointed at by the control it belongs to.
   *
   * Reusing `values` for the HIDDEN fields would also have been wrong in a way that is worth
   * recording, because it is the obvious thing to reach for: on a row whose carriage failed to
   * parse it holds `''`, so every other form on that row would carry the `''` forward and fail
   * for the same reason, leaving the row unusable until a reload. The stored triple cannot do
   * that — `parsePackItemForm` has already accepted it once.
   *
   * `props.itemError.values` is untouched and still arrives: it is the page's prop, the page
   * still derives it, and this component simply no longer has a field to spend it on.
   */
  readonly storedCarriage: string;
  readonly storedPacked: boolean;
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
        // The stored triple, in the wire spelling the forms post. `packItemToFormValues` is
        // what turns the row's two boolean columns back into the one `carriage` word, and
        // going through it rather than reading `worn`/`consumable` here is what keeps this
        // component from owning a second copy of that mapping. See `storedCarriage`.
        const stored = packItemToFormValues(item);
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
          storedCarriage: stored.carriage,
          storedPacked: stored.packed !== '',
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
    ============================================================================
    THE FIGURES, NOW A SHEET OF THEIR OWN AND STILL THE ONLY COPY OF THEM (PK-73)
    ============================================================================

    Design feedback: "Pack weights should be in the top 'Pack' section, not in the gear area.
    As it's a summary of all the gear." They were inside the Categories sheet, under its
    heading, which said they were part of the list rather than a statement about the pack.

    THEY DID NOT MOVE OUT OF THIS COMPONENT, AND THAT IS THE WHOLE CARE OF IT. The obvious
    reading of "move them to the top section" is to render them from `src/pages/packs/[id].astro`,
    where that section's markup lives. That would fork one set of figures into two sources:
    the page computes its tree once per request, this island recomputes its own on every drag,
    and a cross-category drop would leave the page's copy describing a pack that is no longer
    on screen. The pack-level figures happen not to change under a reorder — but "the two
    copies agree today because of a property of one gesture" is not a design, it is a
    coincidence waiting for the next write. So the figures stay derived from `tree`, in here,
    and what moved is only which sheet they are drawn on.

    The component therefore has TWO ROOT ELEMENTS now. `astro-island` is `display: contents`,
    so both land as direct children of the page's `flex flex-col gap-[30px]` column and pick
    up the 30px sheet gap (DESIGN.md §3) exactly as the page's own sheets do. Nothing on this
    sheet drags, so the drag handlers stay on the Categories sheet below where they belong.

    Hidden entirely when the pack has no categories, per §9 ("an empty page has no figures to
    report") — the same rule that used to hide the `<dl>`, now hiding the sheet around it so
    an empty pack does not show an empty white rectangle above its invitation.

    The heading is `sr-only`: every figure below is labelled by its own `<dt>`, so a visible
    "Pack weight" title would be a fourth word for something already named six times — but a
    sheet with no accessible name at all is a landmark a screen-reader user cannot identify in
    a list of them.
  -->
  <section v-if="rows.length > 0" aria-labelledby="pack-weights-heading" class="sheet pack-weights">
    <div class="sheet-body">
      <h2 id="pack-weights-heading" class="sr-only">Pack weight</h2>
      <dl class="ledger-figures">
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
    </div>
  </section>

  <!--
    One drop handler for the whole list — see `onDrop`. `dragend` fires on the source element
    whether the drag ended in a drop or was abandoned over a non-target, which is what clears
    the indicator when somebody thinks better of it mid-drag. `dragleave` covers the case in
    between the two: the pointer is still down and has wandered off the list, where nothing
    would otherwise take the indicator down — see `onDragLeave` for why it cannot simply
    assign null.
  -->
  <section
    ref="listRoot"
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
          <!--
          ONE LINE, 40px, AT 375px AND AT 1000px (PK-73, DESIGN.md §3). What used to be here
          was a wrapping flex row carrying a labelled text field, a Rename button, the
          figures and a Delete button — four controls that could not co-exist on one line at
          any width, so the row was three lines on a phone and two on a desktop and the 40px
          rhythm did not survive one category.

          The name stays on the row because it is the row: renaming is the common edit, and
          burying a text field in a menu would make the ordinary case the hidden one. The two
          BUTTONS move into the `…` menu, which is what buys the line back.
        -->
          <div class="border-hairline row-line border-b">
            <!--
            The grip, and the only thing on this row that arms a drag. `aria-hidden` and not
            focusable on purpose: reordering is pointer-only (see the header), and a focusable
            handle a keyboard cannot then use would be the promise this component is careful
            not to make.
          -->
            <span
              v-if="enabled"
              class="grip text-ink-3 shrink-0"
              :class="{ busy: !draggable }"
              aria-hidden="true"
              @pointerdown="grab(category.id)"
              @pointerup="release"
            >
              <GripVertical :size="16" />
            </span>

            <!--
            THE FORM CARRIES AN `id` AND ITS SUBMIT BUTTON IS IN THE MENU, associated back to
            it with the `form` attribute. A `<form>` cannot contain a `<details>` that
            contains another `<form>` — nested forms are not parseable HTML — and the menu
            has to hold both the rename submit and the delete form, so the submit is the half
            that leaves. `form="…"` is the platform's own answer to exactly this and needs no
            script.

            Enter in the field still renames, which matters more than it looks: that button
            is the form's DEFAULT BUTTON (the first submit control in tree order among the
            form's controls), so implicit submission fires it. `display: none` on the closed
            menu does not change that — the default button is chosen from the form's control
            list, not from what is painted.

            The visible label is gone from the field, so the name is carried by `aria-label`
            rather than by a `<label>`: a 40px row has no space for a label above a field,
            and "Category name" printed beside every category name would be the app talking
            over the visitor's own words (DESIGN.md §4).
          -->
            <form :id="`category-rename-${category.id}`" method="post" class="category-name-form">
              <input type="hidden" name="intent" :value="PACK_INTENT.renameCategory" />
              <input type="hidden" :name="PACK_EDITOR_FIELD.categoryId" :value="category.id" />
              <input
                :id="`category-name-${category.id}`"
                :name="PACK_CATEGORY_FORM_FIELD.name"
                type="text"
                :value="category.name"
                aria-label="Category name"
                autocomplete="off"
                :aria-describedby="
                  category.renameError === null ? undefined : `category-name-error-${category.id}`
                "
                :aria-invalid="category.renameError === null ? undefined : 'true'"
                class="field category-name-field"
              />
            </form>

            <!-- The tail is `.row-figure-detail` for the same §3 reason the item row's is: at
                 375px a category name is competing with it for the line, and a name the
                 visitor typed and cannot read is a worse outcome than a total they can find
                 one sheet up. The base figure — the one the palette spends a colour on —
                 stays at every width. -->
            <p class="text-ink-2 numeric row-figures text-sm">
              <span :class="`font-medium ${BUCKET_TEXT_CLASS.base}`">
                {{ formatWeight(category.baseGrams, props.weightSystem) }}
              </span>
              <span class="text-ink-3 row-figure-detail"> base of </span>
              <span class="text-ink row-figure-detail font-medium">
                {{ formatWeight(category.totalGrams, props.weightSystem) }}
              </span>
            </p>

            <details class="row-menu">
              <summary
                class="row-menu-trigger"
                :aria-label="`Actions for ${category.name}`"
                :title="`Actions for ${category.name}`"
              >
                <Ellipsis :size="16" aria-hidden="true" />
              </summary>
              <div class="row-menu-panel">
                <!--
                THE NAME SAYS WHICH ROW, in the same way every named control in this component
                does. A screen reader listing this page's controls reads them out of context,
                and a pack with nine categories otherwise produces nine buttons called
                "Rename" and nine called "Delete category" with nothing to tell them apart.
                The distinguishing half is `sr-only` so the visible label stays the word the
                menu is built around — and because WCAG 2.5.3 (Label in Name) requires the
                accessible name to CONTAIN the visible one, which it does: the visible half is
                the first word of the hidden one.

                TWO SPANS, NOT ONE WITH AN `sr-only` TAIL, and that is a correction rather than
                a preference. The tail spelling — `Rename<span class="sr-only"> {name}</span>` —
                depends on a single leading space inside an `sr-only` element surviving Vue's
                template compilation, and it does not: `whitespace: 'condense'` drops it, so
                the accessible name came out as "RenameShelter" with the two words run
                together. It renders identically and reads as one word to a screen reader,
                which is exactly the kind of defect that survives a visual review. Writing the
                full sentence once, hidden, and the visible word once, `aria-hidden`, makes the
                accessible name a literal string in the template with no whitespace rule
                between it and what is announced.
              -->
                <button
                  type="submit"
                  :form="`category-rename-${category.id}`"
                  class="row-menu-item"
                >
                  <Pencil :size="15" aria-hidden="true" />
                  <span aria-hidden="true">Rename</span>
                  <span class="sr-only">Rename {{ category.name }}</span>
                </button>

                <form v-if="!category.confirmingDelete" method="post">
                  <input type="hidden" name="intent" :value="PACK_INTENT.deleteCategory" />
                  <input type="hidden" :name="PACK_EDITOR_FIELD.categoryId" :value="category.id" />
                  <button type="submit" class="row-menu-item row-menu-item-danger">
                    <Trash2 :size="15" aria-hidden="true" />
                    <span aria-hidden="true">Delete category</span>
                    <span class="sr-only">Delete category {{ category.name }}</span>
                  </button>
                </form>
              </div>
            </details>
          </div>

          <!-- Outside the line, because a message that has to wrap cannot share a 40px row —
               and it only exists for the one category whose rename was refused. -->
          <p
            v-if="category.renameError !== null"
            :id="`category-name-error-${category.id}`"
            :class="`${ERROR_CLASS} border-hairline row-note border-b`"
          >
            {{ category.renameError }}
          </p>

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
              class="row"
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
              <!--
              ONE LINE PER ITEM (PK-73), AND EVERY CONTROL ON IT IS A SEPARATE FORM.

              What was here: a name-and-figures line, then a second line carrying one form
              with a quantity field, a three-way segmented control, a Packed checkbox and a
              Save button, then a third line with Remove. Three lines at 1000px and five or
              six at 375px, against DESIGN.md §3's 40px row. The design feedback asks for the
              carriage selector and Remove to move into a `…` menu and for quantity to become
              a −/+ stepper, and doing both is what makes one line fit.

              WHY EACH CONTROL IS ITS OWN `<form>` RATHER THAN ONE FORM WITH SEVERAL SUBMIT
              BUTTONS. `parsePackItemForm` (src/lib/packs/form.ts) writes all three columns on
              every save: a submission missing `carriage` is REFUSED, one missing `quantity`
              writes the column default of 1 over whatever was stored, and one missing `packed`
              writes false. So every control here has to post a complete triple, and the two
              settings it is not changing have to travel as hidden fields.

              One form with `name`/`value` submit buttons cannot do that. The hidden field and
              the button would both be called `quantity`, both would be submitted, and which
              one `FormData.get` returned would come down to their order in the markup — a
              silent dependency on DOM order for the value of a stored column. Separate forms
              make each submission say exactly one thing, and the parser is untouched (it
              belongs to PK-72).

              THE COST, RECORDED RATHER THAN GLOSSED: a change is a round trip, so stepping a
              quantity from 1 to 5 is four of them where typing "5" and pressing Save was one.
              That is what a −/+ stepper IS — it trades typing for tapping — and it is what was
              asked for. What it buys back is that carriage and packed are now ONE action each
              instead of "change the control, then find Save".

              NOTHING HERE NEEDS JAVASCRIPT, which is the rule this component is built on: the
              stepper is two submit buttons, the menu is a `<details>`, and every one of them
              works in a browser that never runs the island. See `openMenus` for what
              hydration adds, and why all of it is optional.
            -->
              <div class="row-line item-line">
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

                <!--
                PACKED IS A MARK ON THE ROW AND A COMMAND IN THE MENU. The checkbox that used
                to sit on the second line cannot stay — a checkbox needs a Save button to mean
                anything, and there is no longer one — but the STATE has to remain visible or
                the packed count in the figures above would be reporting something the list
                does not show. A tick before the name reads at a glance down a long pack; the
                sr-only sentence is what a screen reader gets, because the icon is decorative
                once the state is also announceable.
              -->
                <span
                  v-if="item.storedPacked"
                  class="text-moss packed-tick shrink-0"
                  :title="`${item.spokenName} is packed`"
                >
                  <Check :size="14" aria-hidden="true" />
                  <span class="sr-only">Packed.</span>
                </span>

                <p class="item-name">
                  <span class="text-ink written font-medium">{{ item.displayName }}</span>
                  <span v-if="item.isCustom" class="system text-ink-3 item-badge">
                    one-off item
                  </span>
                </p>

                <!-- §3 forbids a wrapping data cell, so the two SECONDARY figures — the unit
                     weight and the line price — are dropped on a narrow viewport rather than
                     allowed to push the row to two lines. The line weight, which is the figure
                     the row exists to report, is never dropped. -->
                <p class="numeric row-figures text-sm">
                  <span :class="`font-medium ${item.bucketClass}`">
                    {{ formatWeight(item.lineWeightGrams, props.weightSystem) }}
                  </span>
                  <span v-if="item.quantity > 1" class="text-ink-3 row-figure-detail">
                    ({{ formatWeight(item.unitWeightGrams, props.weightSystem) }} each)
                  </span>
                  <span v-if="item.linePrice !== null" class="text-ink-3 row-figure-detail">
                    · {{ formatMoney(item.linePrice) }}
                  </span>
                </p>

                <!--
                THE STEPPER. Two submit buttons carrying the NEXT quantity in their `value`,
                either side of the current one.

                IT STEPS FROM THE STORED QUANTITY, NOT FROM `values.quantity`. The two differ
                on exactly one row — the one whose submission failed — where `values` holds
                what the visitor typed and was refused. A stepper reading that would offer to
                move from a number the database never accepted. `item.quantity` is the rollup's
                figure, which came out of the stored row.

                THE `−` IS DISABLED AT 1, and this is NOT the "a control drawn before it can
                work" case the header argues against. That rule is about controls disabled
                because a bundle has not arrived; this one is disabled because
                `pack_items_quantity_check` is `quantity > 0` and there is no lower value to
                step to. It is the same answer before and after hydration and with JavaScript
                off forever, which is what makes it honest. A quantity that IS invalid can
                still only arrive from outside this markup, and it is still reported: the
                group points at the row's own message with `aria-describedby`.

                `aria-invalid` is deliberately not carried over from the old text field. It
                marks a control whose VALUE is invalid, and neither of these buttons has a
                value a visitor chose — they each carry one number this component computed.
                The association with the message is what a screen reader needs, and it is kept.

                NAMED SO THAT SPEECH INPUT CAN REACH THEM. Both labels contain "Qty", which is
                what the visible control was called before it became a pair of icons, so
                "click Qty" still has something to match (WCAG 2.5.3). The group carries the
                item's name so forty steppers on one page are forty distinguishable groups.
              -->
                <div
                  class="stepper"
                  role="group"
                  :aria-label="`Qty for ${item.spokenName}`"
                  :aria-describedby="
                    item.quantityInvalid ? `item-${item.id}-error-quantity` : undefined
                  "
                >
                  <form method="post" class="stepper-form">
                    <input type="hidden" name="intent" :value="PACK_INTENT.saveItem" />
                    <input type="hidden" :name="PACK_EDITOR_FIELD.itemId" :value="item.id" />
                    <input
                      type="hidden"
                      :name="PACK_ITEM_FORM_FIELD.carriage"
                      :value="item.storedCarriage"
                    />
                    <input
                      v-if="item.storedPacked"
                      type="hidden"
                      :name="PACK_ITEM_FORM_FIELD.packed"
                      value="on"
                    />
                    <button
                      type="submit"
                      class="stepper-button"
                      :name="PACK_ITEM_FORM_FIELD.quantity"
                      :value="item.quantity - 1"
                      :disabled="item.quantity <= 1"
                      :aria-label="`Decrease Qty for ${item.spokenName}`"
                    >
                      <Minus :size="14" aria-hidden="true" />
                    </button>
                  </form>

                  <span class="written numeric stepper-value">{{ item.quantity }}</span>

                  <form method="post" class="stepper-form">
                    <input type="hidden" name="intent" :value="PACK_INTENT.saveItem" />
                    <input type="hidden" :name="PACK_EDITOR_FIELD.itemId" :value="item.id" />
                    <input
                      type="hidden"
                      :name="PACK_ITEM_FORM_FIELD.carriage"
                      :value="item.storedCarriage"
                    />
                    <input
                      v-if="item.storedPacked"
                      type="hidden"
                      :name="PACK_ITEM_FORM_FIELD.packed"
                      value="on"
                    />
                    <button
                      type="submit"
                      class="stepper-button"
                      :name="PACK_ITEM_FORM_FIELD.quantity"
                      :value="item.quantity + 1"
                      :aria-label="`Increase Qty for ${item.spokenName}`"
                    >
                      <Plus :size="14" aria-hidden="true" />
                    </button>
                  </form>
                </div>

                <details class="row-menu">
                  <summary
                    class="row-menu-trigger"
                    :aria-label="`Actions for ${item.spokenName}`"
                    :title="`Actions for ${item.spokenName}`"
                    :aria-describedby="
                      item.carriageInvalid ? `item-${item.id}-error-carriage` : undefined
                    "
                  >
                    <Ellipsis :size="16" aria-hidden="true" />
                  </summary>
                  <div class="row-menu-panel">
                    <!--
                    ONE COMMAND PER OPTION, WHICH KEEPS THE IMPOSSIBLE COMBINATION IMPOSSIBLE.
                    The control this replaces was a radio group, and the argument for it was
                    that `pack_items_worn_consumable_exclusive` refuses an item that is both
                    worn and consumable, and a radio group cannot express both at once. Three
                    submit buttons cannot either, and for a stronger reason: a submission
                    carries the `carriage` of the ONE button that was pressed, so there is no
                    request shape — not even a hand-written one built from this markup — in
                    which two of them travel together. `carriageFlags` still turns that single
                    word into the two columns, so the constraint has nothing to reject.

                    `aria-current` and the tick say which one is in force, in the two channels
                    a menu of commands has: a radio group announced its own selected state,
                    and buttons do not.

                    The label is the word, not the icon. See `CARRIAGE_ICONS`.
                  -->
                    <p :id="`item-${item.id}-carriage-label`" class="system row-menu-heading">
                      How {{ item.spokenName }} is carried
                    </p>
                    <div role="group" :aria-labelledby="`item-${item.id}-carriage-label`">
                      <form v-for="carriage in PACK_ITEM_CARRIAGES" :key="carriage" method="post">
                        <input type="hidden" name="intent" :value="PACK_INTENT.saveItem" />
                        <input type="hidden" :name="PACK_EDITOR_FIELD.itemId" :value="item.id" />
                        <input
                          type="hidden"
                          :name="PACK_ITEM_FORM_FIELD.quantity"
                          :value="item.quantity"
                        />
                        <input
                          v-if="item.storedPacked"
                          type="hidden"
                          :name="PACK_ITEM_FORM_FIELD.packed"
                          value="on"
                        />
                        <button
                          type="submit"
                          class="row-menu-item"
                          :name="PACK_ITEM_FORM_FIELD.carriage"
                          :value="carriage"
                          :aria-current="carriage === item.storedCarriage ? 'true' : undefined"
                          :title="PACK_ITEM_CARRIAGE_MEANINGS[carriage]"
                        >
                          <component :is="CARRIAGE_ICONS[carriage]" :size="15" aria-hidden="true" />
                          <span>{{ PACK_ITEM_CARRIAGE_LABELS[carriage] }}</span>
                          <Check
                            v-if="carriage === item.storedCarriage"
                            :size="14"
                            class="row-menu-tick"
                            aria-hidden="true"
                          />
                        </button>
                      </form>
                    </div>

                    <hr class="row-menu-rule" />

                    <!-- The hidden `packed` field is present exactly when the row is NOT
                         packed, so this one button both packs and unpacks: an absent checkbox
                         field is how `parseCheckbox` reads false, which is the same shape the
                         old checkbox posted. -->
                    <form method="post">
                      <input type="hidden" name="intent" :value="PACK_INTENT.saveItem" />
                      <input type="hidden" :name="PACK_EDITOR_FIELD.itemId" :value="item.id" />
                      <input
                        type="hidden"
                        :name="PACK_ITEM_FORM_FIELD.quantity"
                        :value="item.quantity"
                      />
                      <input
                        type="hidden"
                        :name="PACK_ITEM_FORM_FIELD.carriage"
                        :value="item.storedCarriage"
                      />
                      <input
                        v-if="!item.storedPacked"
                        type="hidden"
                        :name="PACK_ITEM_FORM_FIELD.packed"
                        value="on"
                      />
                      <button type="submit" class="row-menu-item">
                        <Check :size="15" aria-hidden="true" />
                        <span aria-hidden="true">
                          {{ item.storedPacked ? 'Mark as not packed' : 'Mark as packed' }}
                        </span>
                        <span class="sr-only">
                          {{ item.storedPacked ? 'Mark as not packed' : 'Mark as packed' }}
                          {{ item.spokenName }}
                        </span>
                      </button>
                    </form>

                    <hr class="row-menu-rule" />

                    <!--
                    ONE CLICK, NOT TWO, and this is the one destructive control on the page
                    that is not behind the reveal-then-confirm step. It removes an APPEARANCE,
                    not a piece of gear: a referenced item's closet row is untouched (rule 1 of
                    the core schema), and putting it back is one tick in the picker below. The
                    two controls that DO carry the step — deleting a category, deleting the
                    pack — each destroy rows nothing else holds a copy of, which is the
                    distinction the gesture is spent on.

                    Being inside a menu changes none of that. A `<details>` is a disclosure,
                    not a confirmation: opening it writes nothing and asks nothing, so this is
                    still one deliberate press against a page the server rendered — which is
                    the property the rule in `src/lib/account-deletion.ts` is protecting, and
                    is why this did not quietly become a two-step by moving.
                  -->
                    <form method="post">
                      <input type="hidden" name="intent" :value="PACK_INTENT.removeItem" />
                      <input type="hidden" :name="PACK_EDITOR_FIELD.itemId" :value="item.id" />
                      <button type="submit" class="row-menu-item row-menu-item-danger">
                        <Trash2 :size="15" aria-hidden="true" />
                        <span aria-hidden="true">Remove</span>
                        <span class="sr-only">Remove {{ item.spokenName }} from this pack</span>
                      </button>
                    </form>
                  </div>
                </details>
              </div>

              <!-- One `id` per FAILED FIELD, not one for the list: the stepper group and the
                   menu's carriage group each point at their own message, so a screen reader
                   reads the sentence belonging to the control it is on rather than every
                   sentence on the row. See `ItemRow.errors` for why the field name is carried
                   this far.

                   BELOW THE LINE, NOT ON IT. A message wraps, and §3 is explicit that a
                   wrapping cell breaks the 40px rhythm for every row under it. Only the one
                   row a submission failed for grows, and it grows downwards. -->
              <ul v-if="item.errors.length > 0" class="item-note row-note space-y-1">
                <li
                  v-for="entry in item.errors"
                  :id="`item-${item.id}-error-${entry.field}`"
                  :key="entry.field"
                  :class="ERROR_CLASS"
                >
                  {{ entry.message }}
                </li>
              </ul>
            </li>
          </ul>
        </li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
/* ==========================================================================
 * PK-73 — THE ONE-LINE ROW, THE STEPPER AND THE `…` MENU
 *
 * All of it is in this scoped block and none of it is in `src/styles/paper.css`,
 * which PK-68 owns and which four other surfaces share. Nothing below invents a
 * colour: every value is a token from `src/styles/tokens.css` (CONTRIBUTING.md —
 * "if you need a colour that is not there, it belongs in DESIGN.md first"), and
 * every shadow is mixed from `--shadow-ink` rather than from black, because a
 * black shadow on warm paper reads as a hole.
 * ========================================================================== */

/*
 * The figures are the only thing on their own sheet now, so `.ledger-figures`'
 * top hairline has nothing above it to separate them FROM — it was drawn to
 * divide the figures from the list they used to sit above, and that list is a
 * sheet away. Neutralised here rather than in paper.css, where it is right for
 * every other caller.
 */
.pack-weights .ledger-figures {
  padding-top: 0;
  border-top: 0;
  /* Six figures do not fit on one 920px line once a four-figure cost is among them, so the
     row wraps — which it did inside the Categories sheet too. What it did not have there was
     a rhythm: the wrapped row landed directly under the first with no gap at all. 20px is the
     cell (§3). */
  row-gap: 20px;
}

/*
 * DESIGN.md §3: the 40px row, for both row kinds and at both widths.
 *
 * `min-height` AND NOT `height`, which is the difference between a rhythm and a
 * crop. Everything that normally sits on one of these rows is sized to fit 40px
 * — the 32px field, the 28px controls — so the rhythm holds down a long pack.
 * A row whose content genuinely cannot fit (a very long category name at 375px)
 * grows instead of clipping the visitor's own words, which §3 prefers: it names
 * the wrapped cell as the thing to design out, not the thing to hide.
 */
.row-line {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 40px;
}

/* Items are indented under their category. Once every row is the same height and
   nothing is boxed, this inset is the only thing left saying the list is a tree. */
.item-line {
  padding-left: 20px;
}

/* Capped rather than filling the line. A category name is two or three words, and a 600px
   outlined box holding "Shelter" reads as the row's subject being the box — four of them down
   a pack is a column of empty rectangles. The cap is above any name that is not itself a
   sentence; below it the field still grows with the viewport, which is what a 375px row needs
   so the value stays readable. */
.category-name-form {
  display: flex;
  flex: 1 1 auto;
  min-width: 0;
  max-width: 420px;
}

.category-name-field {
  width: 100%;
  min-width: 0;
}

.item-name {
  display: flex;
  flex: 1 1 auto;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

/* THE NAME IS THE ONE COLUMN §3 ALLOWS TO BE LONG, and the way it is allowed to
   be long is by truncating, never by wrapping: "a wrapped table cell breaks the
   rhythm for every row below it". Every other cell on the row has a bounded
   width, so this is the only one that can take the pressure. */
.item-name > :first-child {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.item-badge {
  flex: none;
  font-size: 12px;
  font-weight: 400;
}

.packed-tick {
  display: inline-flex;
}

/* `margin-left: auto` so the figures and the `…` after them sit against the right edge on
   BOTH row kinds. An item row gets there anyway — its name is `flex: 1` and eats the slack —
   but a category row's name field is capped, so without this its menu stopped wherever the
   name ended and the two menu columns did not line up. A ledger's right-hand column is a
   column (§7); a `…` that moves in and out by 180px between one row and the next is not. */
.row-figures {
  flex: none;
  margin-left: auto;
  white-space: nowrap;
}

/* --------------------------------------------------------------------------
 * The stepper
 * ----------------------------------------------------------------------- */

/* One box around three children, drawn like the `.field` it replaces so the row
   does not gain a new kind of control — same border token, same radius, same 1px
   stamp DESIGN.md §6 gives a field. */
.stepper {
  display: flex;
  flex: none;
  align-items: center;
  border: 1px solid var(--field-line);
  border-radius: var(--radius);
  background: var(--note);
  box-shadow: 1px 1px 0 rgba(var(--shadow-ink), 0.18);
}

/*
 * `display: contents` so the two forms contribute no box and the three children —
 * button, figure, button — sit in ONE flex line. The forms exist for the
 * submission, not for the layout; see the template's note on why there have to be
 * two of them. Safe on a `<form>` specifically: an unnamed form has no implicit
 * ARIA role, so this is not one of the elements `display: contents` is known to
 * drop out of the accessibility tree, and both buttons keep their own roles and
 * names either way.
 */
.stepper-form {
  display: contents;
}

.stepper-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 0;
  background: transparent;
  color: var(--ink);
  cursor: pointer;
}

/* At quantity 1 there is no lower value to step to — see the template. Dimmed
   and re-cursored so the refusal is visible rather than only felt on click. */
.stepper-button:disabled {
  color: var(--ink-3);
  cursor: default;
  opacity: 0.45;
}

/* The figure between them is WRITTEN, because it is the visitor's own quantity
   (DESIGN.md §4), while the two buttons around it are the app speaking and stay
   in the system face — "the hand never sets anything operable". 14.5px is the
   numeral size §4 specifies, one notch below body. */
.stepper-value {
  min-width: 24px;
  font-size: 14.5px;
  line-height: 20px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}

/* --------------------------------------------------------------------------
 * The `…` menu
 * ----------------------------------------------------------------------- */

.row-menu {
  position: relative;
  flex: none;
}

/*
 * AN OPEN MENU HAS TO PAINT OVER THE ROWS BELOW IT. Every `.row` is
 * `position: relative` with `z-index: auto`, so positioned siblings paint in tree
 * order and the panel of row three would otherwise be covered by row four's drop
 * indicator. A positive z-index puts the open menu in the layer above all of
 * them. Only `[open]`, so a closed menu adds no stacking context to fifty rows.
 */
.row-menu[open] {
  z-index: 40;
}

/* The disclosure triangle removed in both spellings a browser might use for it:
   the trigger is the `…` glyph, and a marker beside it would read as a second
   affordance. `list-style: none` also restores `<summary>` to a plain box in
   Safari, where it is a list-item by default. */
.row-menu-trigger {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: var(--radius);
  color: var(--ink-2);
  cursor: pointer;
  list-style: none;
}

.row-menu-trigger::-webkit-details-marker {
  display: none;
}

.row-menu-trigger:hover {
  background: var(--paper-deep);
  color: var(--ink);
}

/*
 * The panel. `--note` on a warm shadow, square-ish at the control radius, no
 * animation — paper does not move (§11), and `global.css` collapses transitions
 * globally anyway.
 *
 * ON §2.5, WHICH THIS SURFACE NEEDED AN AMENDMENT FOR. "No two papers ever
 * overlap" forbade this exactly as it forbade PK-69's modal, and PK-69 amended
 * §2.5 rather than shipping a component that quietly contradicted the authority.
 * This is the second entry under that amendment and the appendix records it: a
 * row menu is a dismissible interruption — it covers the row, writes nothing by
 * opening, and leaves nothing when it closes — and not the overlap-for-emphasis
 * (a note lying on a sheet, something hanging off an edge) that §13 still
 * refuses. If a third surface wants the same exception, that is the moment to
 * re-read §2.5 rather than to add another paragraph to it.
 */
.row-menu-panel {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  z-index: 40;
  min-width: 232px;
  padding: 6px;
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  background: var(--note);
  box-shadow: 2px 3px 0 rgba(var(--shadow-ink), 0.18);
}

/* The group label, in the 12px uppercase third ink §4 gives a section label. */
.row-menu-heading {
  padding: 6px 10px 2px;
  font-size: 12px;
  letter-spacing: 0.12em;
  line-height: 20px;
  text-transform: uppercase;
  color: var(--ink-3);
}

.row-menu-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 7px 10px;
  border: 0;
  border-radius: var(--radius);
  background: transparent;
  color: var(--ink);
  font-family: var(--font-system);
  font-size: 14px;
  line-height: 20px;
  text-align: left;
  cursor: pointer;
}

.row-menu-item:hover {
  background: var(--paper-deep);
}

.row-menu-item-danger {
  color: var(--rust);
}

/* The current carriage. `--ink-2` and not an accent: the tick reports which
   option is in force, and the palette spends a colour on a meaning rather than
   on a state that the tick's presence already carries. Never `--blue` — nothing
   here is interactive or a base weight. */
.row-menu-tick {
  flex: none;
  margin-left: auto;
  color: var(--ink-2);
}

.row-menu-rule {
  height: 0;
  margin: 5px 2px;
  border: 0;
  border-top: 1px solid var(--hairline);
}

/* A message belonging to the row above it, which is where a message goes when
   the row itself is 40px and a sentence wraps. */
.row-note {
  padding-bottom: 10px;
}

.item-note {
  padding-left: 20px;
}

/*
 * §3 AGAIN, AT 375px: "if the columns do not fit, remove a column rather than let
 * one wrap". The two SECONDARY figures go — the per-unit weight, which is the
 * line weight divided by a quantity the stepper is showing, and the line price —
 * and the line weight, which is what the row is for, never goes.
 */
@media (max-width: 640px) {
  .row-line {
    gap: 8px;
  }

  .item-line {
    padding-left: 12px;
  }

  .item-note {
    padding-left: 12px;
  }

  .row-figure-detail {
    display: none;
  }

  /* The badge is context, not the row's subject, and it was costing "Borrowed spork" every
     letter after the first. */
  .item-badge {
    display: none;
  }

  /* Four pixels off each control and two off the figure, which is 20px back for the name —
     the difference between "Zpacks D…" and "Zpacks Duplex…". Still a 24px tap target on the
     stepper, which is what the row can afford at this width. */
  .stepper-button,
  .row-menu-trigger {
    width: 24px;
    height: 24px;
  }

  .stepper-value {
    min-width: 20px;
  }

  /*
   * A COLUMN OF SIX FIGURES EACH TRAILING A VERTICAL HAIRLINE, which is what `.ledger-figures`
   * degrades to at this width: every figure wraps to its own line and keeps the `border-right`
   * that was separating it from a neighbour it no longer has. §2.6 allows exactly one set of
   * verticals on the site — the ones BETWEEN these figures — and six lines each ending in a
   * stray rule is not that set.
   *
   * A two-column grid on the 20px cell instead, with no verticals at all. Scoped to this
   * component rather than fixed in paper.css, which PK-68 owns and which other surfaces share.
   */
  .pack-weights .ledger-figures {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 20px;
  }

  .pack-weights .ledger-figures > * {
    margin-right: 0;
    padding-right: 0;
    border-right: 0;
  }

  .row-menu-panel {
    min-width: 208px;
  }
}

/*
 * THE ONLY LIFT SHADOW IN THE PRODUCT, AND IT IS A TOKEN. It used to be the only shadow of
 * any kind, and used to need an exemption: "nothing casts a shadow at rest" was a standing
 * rule, and this was written as its single admitted exception.
 *
 * PK-64 SUPERSEDED THAT RULE, so this no longer needs an exemption and no longer has one.
 * Be precise about what it is now the only one OF, because the obvious phrasing is wrong:
 * every .sheet and .strip on the site carries an ambient shadow as well as the §2.4 corner
 * curl, and this component's own root element is a .sheet. So this is not the only shadow
 * here, nor the only uniform one.
 *
 * What it is the only one of is a LIFT — the only shadow that claims something has been
 * picked up off the page. The curl says "a sheet resting on paper" and the ambient says
 * "resting slightly above it"; a dragged row is in the visitor's hand, which is a different
 * physical claim and wants a different shadow. A SECOND lift would be the moment to
 * re-read this paragraph rather than to add a token.
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
 * visitor is looking at, not a thing they are looking for.
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
