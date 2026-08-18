import { describe, expect, it } from 'vitest';
import { createSSRApp } from 'vue';
import { applyReorderPlan, dropTargetIndex } from '../src/lib/packs/drag';
import { planCategoryMove, planItemMove, type ReorderPlan } from '../src/lib/packs/reorder';
// The names the island's forms are written with, asserted through the same constants the
// page's POST handler reads them back through: the point of these assertions is that the
// markup and the parser agree, and comparing two hand-typed copies of `'save-item'` would
// only prove that this file agrees with itself.
import { PACK_EDITOR_FIELD, PACK_INTENT } from '../src/lib/packs/editor';
import { PACK_CATEGORY_FORM_FIELD, PACK_ITEM_FORM_FIELD } from '../src/lib/packs/form';
import { PACK_ITEM_CARRIAGES } from '../src/lib/packs/fields';
import { BULK_FORM_FIELD, GEAR_DELETE_CONFIRMATION_VALUE } from '../src/lib/gear/bulk';
import {
  computeTotals,
  type PackTreeGearItem,
  type PackTreeItem,
  type PackTotals,
} from '../src/lib/totals';

/**
 * `src/lib/packs/drag.ts` is the decision-making half of PK-37's drag island, and this file
 * is where it is held in place. Read that module's header first; a good half of what follows
 * exists to pin its two arguments rather than to restate what the code plainly does.
 *
 * WHAT CAN AND CANNOT BE REACHED HERE, precisely, because the distinction is what put those
 * two functions in a module instead of in the SFC. `src/components/PackContents.vue` can be
 * SERVER-RENDERED in this suite — Vue's own `renderToString` needs no DOM, and
 * `vitest.config.ts` keeps Astro's `.vue` transform — and the last describe block does
 * exactly that, because the island's degradation claim is a claim about its server-rendered
 * markup. What cannot be reached is any INTERACTION: `environment: 'node'` means there is no
 * `DragEvent`, no `dataTransfer`, no `getBoundingClientRect`, and neither `@vue/test-utils`
 * nor `jsdom` is a dependency to supply them. So a decision written inside a drag handler is
 * a decision nothing can execute, and `dropTargetIndex`/`applyReorderPlan` are the decisions
 * that were taken out of those handlers.
 *
 * The position arithmetic is NOT retested here. `tests/packs-reorder.test.ts` owns it, and
 * duplicating a few of its cases under a different heading is how two suites end up
 * disagreeing about which one is authoritative. What this file pins is the two things that
 * are true only of the island: that the slot a pointer chose becomes the index the engine
 * means, and that a plan projected onto the rendered tree produces the tree the next reload
 * will produce.
 *
 * ---------------------------------------------------------------------------
 * THE ACCEPTANCE MEASUREMENT LIVES AT THE BOTTOM OF THIS FILE
 * ---------------------------------------------------------------------------
 *
 * PK-37 asks for "a pack of 60 items across 8 categories [that] recalculates without
 * visible lag, and the figure is measured and recorded rather than asserted". The last
 * describe block builds that pack and measures it. It asserts NO THRESHOLD, deliberately: a
 * number pinned as an upper bound on shared CI hardware is a flake generator that teaches
 * people to re-run the suite, and the acceptance criterion asks for evidence rather than for
 * a gate. The figure is printed on every run and recorded in that block's own comment.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * The rows the island actually holds: `PACK_TREE_SELECT`'s shape, which is
 * `src/lib/totals.ts`'s input type plus the `position` the reorder engine needs. Composed
 * rather than redeclared, for the same reason `PackContents.vue` composes them — a row that
 * satisfies this satisfies `computeTotals` and `planItemMove` at once, which is the property
 * the island's single-tree design rests on.
 */
interface TreeItem extends PackTreeItem {
  readonly position: number;
}

interface TreeCategory {
  readonly id: string;
  readonly name: string;
  readonly position: number;
  readonly pack_items: readonly TreeItem[];
}

function gear(overrides: Partial<PackTreeGearItem> = {}): PackTreeGearItem {
  // 100 g and no price by default — the same defaults tests/totals.test.ts uses, so a
  // number seen in both files means the same thing.
  return { name: 'Gear', weight_grams: 100, price: null, currency: null, ...overrides };
}

function item(id: string, position: number, overrides: Partial<TreeItem> = {}): TreeItem {
  return {
    id,
    position,
    quantity: 1,
    worn: false,
    consumable: false,
    packed: false,
    overrides: {},
    gear_items: gear(),
    ...overrides,
  };
}

function category(id: string, position: number, items: readonly TreeItem[]): TreeCategory {
  return { id, name: `Category ${id}`, position, pack_items: items };
}

/** A run written as `[id, storedPosition]`, deliberately not pre-sorted: sorting defensively
 *  is part of what `applyReorderPlan` promises. */
function items(rows: readonly (readonly [string, number])[]): TreeItem[] {
  return rows.map(([id, position]) => item(id, position));
}

const idsOf = (rows: readonly { readonly id: string }[]): string[] => rows.map((row) => row.id);

const positionsOf = (rows: readonly { readonly position: number }[]): number[] =>
  rows.map((row) => row.position);

const categoryOf = (tree: readonly TreeCategory[], id: string): TreeCategory => {
  const found = tree.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`No category ${id} in this tree`);
  return found;
};

/**
 * One drop, exactly as `PackContents.vue` performs it: locate the two runs, convert the
 * pointer's slot into the engine's index, plan the move with the SHARED engine, and project
 * the plan back onto the tree. Written out here rather than hidden in a helper the component
 * also imports, so that the sequence a reader has to trust is visible in the test as well as
 * in the island.
 */
function dragItem(
  tree: readonly TreeCategory[],
  itemId: string,
  toCategoryId: string,
  insertAt: number,
): { readonly tree: TreeCategory[]; readonly plan: ReorderPlan } {
  const from = tree.find((entry) => entry.pack_items.some((row) => row.id === itemId));
  const to = tree.find((entry) => entry.id === toCategoryId);
  if (from === undefined || to === undefined) throw new Error('Bad drag fixture');

  const fromIndex = from.id === to.id ? to.pack_items.findIndex((row) => row.id === itemId) : null;
  const toIndex = dropTargetIndex(insertAt, fromIndex === -1 ? null : fromIndex);
  const plan = planItemMove(
    { parentId: from.id, rows: from.pack_items },
    { parentId: to.id, rows: to.pack_items },
    itemId,
    toIndex,
  );
  return { tree: applyReorderPlan(tree, plan), plan };
}

// ---------------------------------------------------------------------------
// dropTargetIndex
// ---------------------------------------------------------------------------

describe('dropTargetIndex: the slot a pointer chose is not the index the engine means', () => {
  // The whole reason this function exists. A drop indicator sits between two DRAWN rows and
  // the dragged row is still one of them; `toIndex` counts the run after that row has been
  // lifted out. Without the shift, dragging a row downwards lands it one place short of
  // where the indicator was — invisible in the middle of a list, obvious at its end, which
  // is the worst possible place for a bug to first appear.
  it('shifts a downward move within one run down by one', () => {
    expect(dropTargetIndex(3, 1)).toBe(2);
  });

  it('leaves an upward move within one run alone: nothing below it closes up', () => {
    expect(dropTargetIndex(1, 3)).toBe(1);
  });

  // The two spellings of "do not move me": the slot just above the row and the slot just
  // below it both mean the position it already occupies. Getting either wrong produces a
  // write on a drag that changed nothing.
  it('maps both slots adjacent to the row onto the row own index', () => {
    expect(dropTargetIndex(2, 2)).toBe(2);
    expect(dropTargetIndex(3, 2)).toBe(2);
  });

  // `fromIndex` is null rather than -1 precisely so this case cannot be confused with "not
  // found in the run". A row arriving from another category was never in this run, so no
  // slot closes up and the pointer's answer is already the engine's.
  it('passes a cross-category drop straight through', () => {
    expect(dropTargetIndex(0, null)).toBe(0);
    expect(dropTargetIndex(4, null)).toBe(4);
  });

  // The end of a run is `n` slots for `n` rows plus one, and an arriving row may legally
  // take the last of them — `planItemMove`'s own comment says its valid range is 0..n rather
  // than 0..n-1 for exactly this reason.
  it('lets an arriving row land after every row already there', () => {
    expect(dropTargetIndex(5, null)).toBe(5);
  });

  // Structurally, not by a clamp: the subtracting branch is reachable only when
  // insertAt > fromIndex >= 0. A negative here would be refused outright by `readIndex` in
  // reorder-request.ts, so it would surface as a drag that errored rather than one that
  // landed wrongly — and neither is allowed.
  it('never produces a negative index', () => {
    for (let insertAt = 0; insertAt <= 8; insertAt += 1) {
      for (let fromIndex = 0; fromIndex <= 8; fromIndex += 1) {
        expect(dropTargetIndex(insertAt, fromIndex)).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// applyReorderPlan
// ---------------------------------------------------------------------------

describe('applyReorderPlan: a plan projected onto the tree on screen', () => {
  it('renders a within-category move as the order the reindex describes', () => {
    const tree = [
      category(
        'c1',
        0,
        items([
          ['a', 0],
          ['b', 1],
          ['c', 2],
          ['d', 3],
        ]),
      ),
    ];
    const { tree: next } = dragItem(tree, 'a', 'c1', 4);

    expect(idsOf(categoryOf(next, 'c1').pack_items)).toEqual(['b', 'c', 'd', 'a']);
    // Dense 0..n-1, which is what the migration chose and what the next read will return.
    expect(positionsOf(categoryOf(next, 'c1').pack_items)).toEqual([0, 1, 2, 3]);
  });

  it('moves the row across categories and closes the gap it left', () => {
    const tree = [
      category(
        'c1',
        0,
        items([
          ['a', 0],
          ['b', 1],
          ['c', 2],
        ]),
      ),
      category(
        'c2',
        1,
        items([
          ['x', 0],
          ['y', 1],
        ]),
      ),
    ];
    const { tree: next } = dragItem(tree, 'b', 'c2', 1);

    expect(idsOf(categoryOf(next, 'c1').pack_items)).toEqual(['a', 'c']);
    expect(positionsOf(categoryOf(next, 'c1').pack_items)).toEqual([0, 1]);
    expect(idsOf(categoryOf(next, 'c2').pack_items)).toEqual(['x', 'b', 'y']);
    expect(positionsOf(categoryOf(next, 'c2').pack_items)).toEqual([0, 1, 2]);
  });

  /**
   * The trap `reorder.ts` and `planChangesAnything` both call out, from the rendering side:
   * the only item of one category dropped into an empty one is position 0 before and 0
   * after, so the plan carries NO position updates while the move is entirely real. An
   * implementation that keyed off `runs` alone would drop this move on the floor and the row
   * would snap back on screen while the database happily reparented it.
   */
  it('honours a reparent whose plan carries no position updates at all', () => {
    const tree = [category('c1', 0, items([['only', 0]])), category('c2', 1, [])];
    const { tree: next, plan } = dragItem(tree, 'only', 'c2', 0);

    expect(plan.runs).toEqual([]);
    expect(plan.reparent).toEqual({ id: 'only', parentId: 'c2' });
    expect(idsOf(categoryOf(next, 'c1').pack_items)).toEqual([]);
    expect(idsOf(categoryOf(next, 'c2').pack_items)).toEqual(['only']);
  });

  /**
   * The row being reparented still sits under its OLD parent at the moment the plan is
   * applied — the same fact `reorder.ts` states in capitals about matching updates on `id`
   * alone. A lookup scoped to the destination category would find nothing and the move would
   * silently vanish; a lookup scoped to the source would work only for a plan the island
   * itself computed and not for one the server returned.
   */
  it('finds the reparented row wherever it currently is, not where it is going', () => {
    const tree = [
      category('c1', 0, items([['a', 0]])),
      category('c2', 1, items([['b', 0]])),
      category('c3', 2, items([['c', 0]])),
    ];
    const plan: ReorderPlan = { runs: [], reparent: { id: 'c', parentId: 'c1' } };
    const next = applyReorderPlan(tree, plan);

    expect(idsOf(categoryOf(next, 'c1').pack_items)).toEqual(['a', 'c']);
    expect(idsOf(categoryOf(next, 'c3').pack_items)).toEqual([]);
  });

  it('reorders categories from a category plan', () => {
    const tree = [
      category('c1', 0, items([['a', 0]])),
      category('c2', 1, items([['b', 0]])),
      category('c3', 2, items([['c', 0]])),
    ];
    const plan = planCategoryMove({ parentId: 'pack', rows: tree }, 'c3', dropTargetIndex(0, 2));

    expect(idsOf(applyReorderPlan(tree, plan))).toEqual(['c3', 'c1', 'c2']);
  });

  // Rows a plan does not name are rows the database already agrees with — `denseUpdates`
  // filters them out on purpose. Overwriting them with anything, including a recomputed
  // value, would make this function a second implementation of the arithmetic.
  it('leaves a row the plan does not mention on the position it already had', () => {
    const tree = [
      category(
        'c1',
        0,
        items([
          ['a', 0],
          ['b', 7],
        ]),
      ),
    ];
    const next = applyReorderPlan(tree, {
      runs: [{ parentId: 'c1', updates: [{ id: 'a', position: 1 }] }],
      reparent: null,
    });

    // 'b' keeps its stored 7 and therefore sorts last; 'a' takes the 1 the plan gave it.
    expect(idsOf(categoryOf(next, 'c1').pack_items)).toEqual(['a', 'b']);
    expect(positionsOf(categoryOf(next, 'c1').pack_items)).toEqual([1, 7]);
  });

  // The island holds this tree in a `shallowRef` and swaps the whole value. A function that
  // sorted or spliced in place would reorder the DOM as a side effect of working out what
  // the order ought to be — the hazard `sortByPosition`'s own comment names.
  it('mutates nothing it was handed', () => {
    const original = [
      category(
        'c1',
        0,
        items([
          ['a', 0],
          ['b', 1],
        ]),
      ),
      category('c2', 1, []),
    ];
    const snapshot = JSON.stringify(original);
    dragItem(original, 'a', 'c2', 0);

    expect(JSON.stringify(original)).toBe(snapshot);
  });

  // Ties are legal — the column is deliberately not unique — and both sides resolve them on
  // id. If this sorted on position alone, the island would render one of two equally valid
  // orders and a reload would show the other.
  it('resolves a duplicated position on id, the way the read indexes do', () => {
    const tree = [
      category(
        'c1',
        0,
        items([
          ['b', 0],
          ['a', 0],
        ]),
      ),
    ];
    expect(idsOf(applyReorderPlan(tree, { runs: [], reparent: null })[0]!.pack_items)).toEqual([
      'a',
      'b',
    ]);
  });
});

// ---------------------------------------------------------------------------
// The 60-item pack: what must not move, and the measurement
// ---------------------------------------------------------------------------

/**
 * The acceptance pack, built once and reused: 60 items across 8 categories, which is the
 * tree PK-37 names. It is deliberately not uniform — quantities above one, worn and
 * consumable rows, priced and unpriced gear, and one item per category carrying an override
 * — because `computeTotals` does materially different work per bucket and a pack of sixty
 * identical 100 g rows would measure the cheapest possible shape and report it as the
 * ticket's figure.
 */
function acceptancePack(): TreeCategory[] {
  const categories: TreeCategory[] = [];
  let made = 0;
  for (let c = 0; c < 8; c += 1) {
    const rows: TreeItem[] = [];
    // 8, 8, 8, 8, 7, 7, 7, 7 — sixty exactly, and uneven, so no test can accidentally
    // depend on every category holding the same number of rows.
    const size = c < 4 ? 8 : 7;
    for (let i = 0; i < size; i += 1) {
      const id = `item-${made}`;
      rows.push(
        item(id, i, {
          quantity: made % 5 === 0 ? 2 : 1,
          worn: made % 7 === 0,
          consumable: made % 7 !== 0 && made % 6 === 0,
          packed: made % 3 !== 0,
          // `weight`, not `weight_grams`: the merged record speaks the SNAPSHOT's
          // vocabulary, which `resolvePackItem` explains at length and which an override
          // written against live gear has to match.
          overrides: made % 4 === 0 ? { weight: 250 + made } : {},
          gear_items: gear({
            name: `Gear ${made}`,
            weight_grams: 40 + made * 3,
            // A DECIMAL major-unit value, as `gear_items.price` is `numeric(12, 2)`.
            price: made % 2 === 0 ? 12.5 + made : null,
            currency: made % 2 === 0 ? 'GBP' : null,
          }),
        }),
      );
      made += 1;
    }
    categories.push(category(`cat-${c}`, c, rows));
  }
  if (made !== 60) throw new Error(`The acceptance pack must hold 60 items, built ${made}`);
  return categories;
}

/** Every pack-level figure `computeTotals` produces, as one comparable value. Prices are
 *  folded in as sorted pairs because `pricesByCurrency` is a Map and `toEqual` on two Maps
 *  would compare insertion order along with contents. */
function packFigures(totals: PackTotals) {
  return {
    total: totals.total,
    base: totals.base,
    worn: totals.worn,
    consumable: totals.consumable,
    itemCount: totals.itemCount,
    packedCount: totals.packedCount,
    prices: [...totals.pricesByCurrency.entries()]
      .map(([code, money]) => `${code}:${money.amountMinorUnits}`)
      .sort(),
  };
}

describe('reordering the acceptance pack changes the order and nothing else', () => {
  it('holds 60 items across 8 categories', () => {
    const tree = acceptancePack();
    expect(tree).toHaveLength(8);
    expect(tree.flatMap((entry) => entry.pack_items)).toHaveLength(60);
  });

  /**
   * THE ASSERTION THE ISLAND'S TOTALS STRIP EXISTS TO MAKE VISIBLE. Reordering moves no
   * weight, buys nothing and packs nothing, so every pack-level figure must be byte-identical
   * before and after a drag — including after a CROSS-CATEGORY drag, which is the case where
   * a hand-written "just subtract it from one subtotal and add it to the other" would drift.
   * The island recomputes with `computeTotals` rather than adjusting the numbers it already
   * has, and this is what that buys.
   */
  it('leaves every pack figure identical after a cross-category drag', () => {
    const tree = acceptancePack();
    const before = packFigures(computeTotals({ pack_categories: tree }));

    // Out of the first category and into the middle of the last: both runs are rewritten,
    // and the item is a quantity-2, weight-overridden row, so it carries real weight and a
    // real price with it.
    const { tree: next } = dragItem(tree, 'item-0', 'cat-7', 3);

    expect(packFigures(computeTotals({ pack_categories: next }))).toEqual(before);
  });

  /**
   * The other half of the same claim, and the reason the recomputation is worth doing at
   * all: the two CATEGORY subtotals do move, by exactly the line weight that crossed the
   * boundary. A component that only ever showed pack figures could satisfy the test above by
   * doing nothing whatsoever.
   */
  it('moves exactly the crossed weight between the two category subtotals', () => {
    const tree = acceptancePack();
    const before = computeTotals({ pack_categories: tree });
    const { tree: next } = dragItem(tree, 'item-0', 'cat-7', 3);
    const after = computeTotals({ pack_categories: next });

    const line = before.categories[0]!.items[0]!.lineWeightGrams;
    expect(line).toBeGreaterThan(0);
    expect(after.categories[0]!.total).toBeCloseTo(before.categories[0]!.total - line, 9);
    expect(after.categories[7]!.total).toBeCloseTo(before.categories[7]!.total + line, 9);

    // QUANTITIES, NOT ROWS — `itemCount` counts stuff, not lines, and this row carries two
    // of the same thing. Asserting a delta of one here is the exact mistake
    // tests/worn-weight-quantity.test.ts exists to guard against one level up.
    const quantity = before.categories[0]!.items[0]!.quantity;
    expect(quantity).toBe(2);
    expect(after.categories[0]!.itemCount).toBe(before.categories[0]!.itemCount - quantity);
    expect(after.categories[7]!.itemCount).toBe(before.categories[7]!.itemCount + quantity);
  });

  it('leaves every pack figure identical after a category drag', () => {
    const tree = acceptancePack();
    const before = packFigures(computeTotals({ pack_categories: tree }));
    const plan = planCategoryMove({ parentId: 'pack', rows: tree }, 'cat-7', dropTargetIndex(0, 7));
    const next = applyReorderPlan(tree, plan);

    expect(idsOf(next)[0]).toBe('cat-7');
    expect(packFigures(computeTotals({ pack_categories: next }))).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// The island's server-rendered markup
// ---------------------------------------------------------------------------

/**
 * THE DEGRADATION CLAIM, EXECUTED RATHER THAN ASSERTED IN A COMMENT.
 *
 * `src/components/PackContents.vue` holds the pack's ordered list AND the controls that edit
 * it, which is the whole point of PK-37's last change: one rendering of the order, with its
 * forms on it, instead of a drag surface above a second server-rendered copy that went stale
 * the moment anything was dragged. That makes the component promise two things about its
 * SERVER-rendered output, and they pull in opposite directions:
 *
 *   1. EVERY CONTROL IS THERE, as plain `<form method="post">` markup with the hidden intent
 *      and id fields `src/pages/packs/[id].astro` reads. With JavaScript off that markup is
 *      the entire editor, so a control missing from it is a capability missing from the
 *      product — not a degraded experience, an absent one.
 *   2. NOTHING THAT LOOKS DRAGGABLE IS THERE. No `draggable`, no grip, no instruction to
 *      drag, because a control drawn before it can work is a control that lies for as long
 *      as the gap lasts, and for a visitor whose JavaScript never arrives that gap is
 *      forever.
 *
 * Both halves are executed here. Together they are what makes `client:visible` safe on a
 * page whose editor must keep working with JavaScript switched off entirely.
 *
 * `renderToString` is Vue's own SSR entry and needs no DOM, which is what makes this
 * reachable in a `node` environment with no new dependency. It exercises the template's
 * compilation as a side effect — a mistyped binding or an unclosed tag fails here rather
 * than at the next real build.
 */
describe('PackContents renders the whole editor, and no drag affordance, on the server', () => {
  const CATEGORY_ID = '11111111-1111-4111-8111-111111111111';
  const EMPTY_CATEGORY_ID = '33333333-3333-4333-8333-333333333333';
  const ITEM_ID = '22222222-2222-4222-8222-222222222222';
  const PACK_ID = '44444444-4444-4444-8444-444444444444';
  /** The page's own URL WITH the closet picker's query on it, which is what a Cancel link
   *  has to go back to — cancelling a delete must not also drop the search the visitor had
   *  running. */
  const SELF_PATH = `/packs/${PACK_ID}?q=tarp`;

  const tree: TreeCategory[] = [
    category(CATEGORY_ID, 0, [
      item(ITEM_ID, 0, {
        gear_items: gear({ name: 'Tarp', weight_grams: 450 }),
      }),
    ]),
    category(EMPTY_CATEGORY_ID, 1, []),
  ];

  /** The three props the page derives from the POST it has just answered. All absent is a
   *  plain GET, which is what most of the assertions below render. */
  interface EditorState {
    readonly renameError?: { readonly categoryId: string; readonly message: string } | null;
    readonly itemError?: {
      readonly itemId: string;
      readonly errors: Readonly<Record<string, string>>;
      readonly values: {
        readonly quantity: string;
        readonly carriage: string;
        readonly packed: string;
      };
    } | null;
    readonly pendingCategoryDeleteId?: string | null;
  }

  async function render(state: EditorState = {}): Promise<string> {
    // Imported inside the function rather than at the top of the file: this is the one
    // place that needs Astro's `.vue` transform, and a top-level import would make every
    // other assertion in this file depend on it resolving.
    //
    // `npm run check` runs THREE type checkers over this repository and they do not agree
    // about `.vue`. `astro check` resolves it properly — it runs the Vue language plugin,
    // which is what type-checks the props `src/pages/packs/[id].astro` passes to this
    // component — while plain `tsc --noEmit` has no notion of an SFC and reports TS2307.
    // The suppression is one line, here, deliberately: the alternative is a global
    // `declare module '*.vue'` shim, which would resolve the import by giving EVERY `.vue`
    // in the project an `any`-shaped component type, and would therefore switch off the
    // prop checking on the page that hosts this island — trading a real check for a
    // cosmetic one.
    // `@ts-ignore` rather than `@ts-expect-error`, which is the spelling this project
    // otherwise prefers and which CANNOT be used here: `tsc` reports TS2307 on this line
    // and `astro check` reports TS2578 ("unused '@ts-expect-error' directive") because for
    // it there is no error to expect. A directive that is an error in one of the two
    // checkers `npm run check` runs is not a usable directive. The eslint suppression is
    // the price of the one that works in both.
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore tsc cannot resolve an SFC; astro check, which can, is what checks this one
    const component = (await import('../src/components/PackContents.vue')) as {
      default: Parameters<typeof createSSRApp>[0];
    };
    const { renderToString } = await import('vue/server-renderer');
    return renderToString(
      createSSRApp(component.default, {
        packId: PACK_ID,
        categories: tree,
        weightSystem: 'metric',
        selfPath: SELF_PATH,
        renameError: state.renameError ?? null,
        itemError: state.itemError ?? null,
        pendingCategoryDeleteId: state.pendingCategoryDeleteId ?? null,
      }),
    );
  }

  /** `<input type="hidden" name="…" value="…"` as Vue's SSR writes it: attributes in the
   *  order the template declares them, which is what lets these be substring assertions
   *  rather than a parse. Deliberately not closed with `>`: a scoped stylesheet makes Vue
   *  append its own `data-v-…` attribute to every element it renders, and pinning the tag's
   *  last attribute would make these assertions fail the day the `<style scoped>` block
   *  changes rather than the day the form does. */
  const hidden = (name: string, value: string): string =>
    `<input type="hidden" name="${name}" value="${value}"`;

  it('shows the pack it was handed, with figures from computeTotals', async () => {
    const html = await render();
    expect(html).toContain('Tarp');
    expect(html).toContain('450 g');
    expect(html).toContain('Nothing in here yet.');
  });

  /**
   * The pack figures moved in here when the page's own summary strip was removed, and the
   * reason they moved is that there must be exactly one of them: two renderings of one
   * number can disagree, and after a drag one of them would. This pins that the component
   * draws the strip once. That it is the ONLY one on the page is the page's side of the
   * claim — src/pages/packs/[id].astro no longer imports WEIGHT_BUCKETS at all.
   */
  it('renders the pack figures once, from the tree it was handed', async () => {
    const html = await render();
    expect(html.split('Base weight')).toHaveLength(2);
    // 450 g of gear, carried rather than worn or consumed, so all of it is base weight and
    // the total says the same number.
    expect(html).toContain('Packed');
    expect(html).toContain('0 / 1');
  });

  /**
   * CLAIM 1, for the per-item controls. Quantity, carriage, packed and remove are the four
   * things a visitor can do to a row that is already in the pack, and with JavaScript off
   * these four forms are the only way any of them happens.
   */
  it('renders the per-item controls as plain forms that post', async () => {
    const html = await render();

    expect(html).toContain('<form method="post"');
    expect(html).toContain(hidden('intent', PACK_INTENT.saveItem));
    expect(html).toContain(hidden('intent', PACK_INTENT.removeItem));
    expect(html).toContain(hidden(PACK_EDITOR_FIELD.itemId, ITEM_ID));

    // The settings themselves: a quantity box, the three-way carriage control, the packed
    // checkbox. Named through the same constants `parsePackItemForm` reads.
    expect(html).toContain(`name="${PACK_ITEM_FORM_FIELD.quantity}"`);
    for (const carriage of PACK_ITEM_CARRIAGES) {
      expect(html).toContain(`name="${PACK_ITEM_FORM_FIELD.carriage}" value="${carriage}"`);
    }
    expect(html).toContain(`name="${PACK_ITEM_FORM_FIELD.packed}"`);
    expect(html).toContain('Remove Tarp from this pack');
  });

  /** CLAIM 1, for the per-category controls: rename, and the first half of the delete gate. */
  it('renders the per-category controls as plain forms that post', async () => {
    const html = await render();

    expect(html).toContain(hidden('intent', PACK_INTENT.renameCategory));
    expect(html).toContain(hidden('intent', PACK_INTENT.deleteCategory));
    expect(html).toContain(hidden(PACK_EDITOR_FIELD.categoryId, CATEGORY_ID));
    expect(html).toContain(hidden(PACK_EDITOR_FIELD.categoryId, EMPTY_CATEGORY_ID));
    expect(html).toContain(`name="${PACK_CATEGORY_FORM_FIELD.name}"`);
  });

  /**
   * The reveal half of the two-step, rendered from a prop. NOTHING has been written at this
   * point, the cascade is named before it happens, and the second submission carries the
   * confirmation value `confirmsGearDeletion` compares against — from the constant, so the
   * writer and the reader cannot drift apart.
   */
  it('reveals the delete confirmation for the one category a submission named', async () => {
    const html = await render({ pendingCategoryDeleteId: CATEGORY_ID });

    expect(html).toContain('Its 1 item will be removed from this pack with it.');
    expect(html).toContain(hidden(BULK_FORM_FIELD.confirm, GEAR_DELETE_CONFIRMATION_VALUE));
    expect(html).toContain('Delete category and its items');
    // Cancel goes back to the URL the page was on, picker query and all.
    expect(html).toContain(`href="${SELF_PATH}"`);
    // The confirmation replaces that category's own delete button and leaves the other
    // category's alone: one plain "Delete category" left, not two.
    expect(html.split('>Delete category</button>')).toHaveLength(2);
  });

  it('renders no confirmation at all when nothing has been asked about', async () => {
    const html = await render();
    expect(html).not.toContain('Confirm delete');
    expect(html).not.toContain('Delete category and its items');
    expect(html).not.toContain(hidden(BULK_FORM_FIELD.confirm, GEAR_DELETE_CONFIRMATION_VALUE));
    expect(html.split('>Delete category</button>')).toHaveLength(3);
  });

  /** A failed rename renders beside the field it was typed into, not at the top of a page
   *  with ten forms on it. */
  it('puts a failed rename beside its own category', async () => {
    const html = await render({
      renameError: { categoryId: CATEGORY_ID, message: 'Enter a name for this category.' },
    });

    expect(html).toContain('Enter a name for this category.');
    expect(html).toContain(`id="category-name-error-${CATEGORY_ID}"`);
    expect(html).toContain('aria-invalid="true"');
  });

  /** And a failed item save renders what the VISITOR TYPED, not what is stored — the whole
   *  reason `rawPackItemFormValues` exists. */
  it('shows the rejected input back on the row that failed', async () => {
    const html = await render({
      itemError: {
        itemId: ITEM_ID,
        errors: { quantity: 'Enter a whole number greater than zero for quantity.' },
        values: { quantity: '0', carriage: 'worn', packed: 'on' },
      },
    });

    expect(html).toContain('Enter a whole number greater than zero for quantity.');
    expect(html).toContain('value="0"');
    // The carriage the submission carried, not the stored `carried` — a re-render that
    // silently reverted it would invite the visitor to save the revert back.
    expect(html).toMatch(/name="carriage" value="worn"[^>]*checked/);
  });

  // CLAIM 2. `draggable` and the grip are gated on `onMounted`, which does not run during
  // SSR, so neither may appear — and if one ever does, the page ships a handle that a visitor
  // without JavaScript can pick up and drop into nothing.
  it('renders no drag affordance at all before it hydrates', async () => {
    const html = await render();
    expect(html).not.toContain('draggable="true"');
    expect(html).not.toContain('lucide-grip-vertical');
  });

  // The instruction line is the other half of being honest about the pointer-only decision:
  // before hydration there is nothing to instruct, so it must not promise a drag.
  it('does not invite a drag it cannot yet accept', async () => {
    const html = await render();
    expect(html).not.toContain('Drag a category');
    expect(html).toContain('in the order it is stored in.');
  });
});

/**
 * ---------------------------------------------------------------------------
 * THE ACCEPTANCE MEASUREMENT — RECORDED, NOT ASSERTED
 * ---------------------------------------------------------------------------
 *
 * PK-37: "A pack of 60 items across 8 categories recalculates without visible lag, and the
 * figure is measured and recorded rather than asserted."
 *
 * WHAT IS MEASURED. Two things, because "recalculates" has two honest readings and the
 * smaller one on its own would be flattering:
 *
 *   1. `computeTotals` alone over the 60-item tree — the summation the ticket names.
 *   2. THE WHOLE DROP: `planItemMove` + `applyReorderPlan` + `computeTotals`, which is what
 *      actually runs between the pointer being released and the figures being redrawn. This
 *      is the number a visitor experiences; the first is a component of it.
 *
 * Vue's own render is not in either figure and cannot be measured here — there is no DOM in
 * this suite. What that leaves out is bounded and worth stating rather than implying: the
 * island re-renders at most 68 rows of text.
 *
 * NO THRESHOLD IS ASSERTED. A bound pinned against whatever hardware CI happens to allocate
 * is a flake that teaches people to re-run the suite rather than to read it, and the
 * criterion asks for a measurement rather than a gate. The figures are printed on every run.
 *
 * RECORDED, 18 August 2026, Node 22.22 on an Apple-silicon laptop, median of 200 iterations
 * after 50 warm-up passes, over two runs:
 *
 *   computeTotals over 60 items in 8 categories: 0.205-0.206 ms  (mean 0.206-0.210 ms)
 *   full drop — plan + apply + computeTotals:    0.207-0.226 ms  (mean 0.214-0.248 ms)
 *
 * Roughly a fifth of a millisecond, which is about 1.3% of the ~16 ms a 60 Hz frame costs.
 * The recalculation therefore cannot be what a visitor sees; if lag ever appears on this
 * surface it is the render or the round trip, and this figure is what rules the arithmetic
 * out. Note that the drop cycle costs barely more than the recomputation inside it: the
 * plan and the projection are two passes over sixty rows, and the summation dominates both.
 */
describe('acceptance: 60 items across 8 categories, measured', () => {
  const WARMUP = 50;
  const ITERATIONS = 200;

  function measure(label: string, run: () => unknown): void {
    for (let i = 0; i < WARMUP; i += 1) run();

    const samples: number[] = [];
    for (let i = 0; i < ITERATIONS; i += 1) {
      const started = performance.now();
      run();
      samples.push(performance.now() - started);
    }

    samples.sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)]!;
    const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
    // Printed rather than asserted — see this block's own comment. `console.info` so it
    // survives a run that is only reading the summary.
    console.info(
      `[PK-37] ${label}: median ${median.toFixed(3)} ms, mean ${mean.toFixed(3)} ms ` +
        `over ${ITERATIONS} iterations (60 items, 8 categories)`,
    );
  }

  it('measures computeTotals over the acceptance pack', () => {
    const tree = acceptancePack();
    measure('computeTotals', () => computeTotals({ pack_categories: tree }));
    // The only assertion: that the thing being measured produced the pack it claims to.
    expect(computeTotals({ pack_categories: tree }).itemCount).toBeGreaterThanOrEqual(60);
  });

  it('measures the whole drop: plan, apply, recompute', () => {
    const tree = acceptancePack();
    measure('drop cycle (plan + apply + computeTotals)', () => {
      const { tree: next } = dragItem(tree, 'item-0', 'cat-7', 3);
      return computeTotals({ pack_categories: next });
    });
    expect(idsOf(dragItem(tree, 'item-0', 'cat-7', 3).tree)).toHaveLength(8);
  });
});
