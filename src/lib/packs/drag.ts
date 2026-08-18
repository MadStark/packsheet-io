/**
 * The pure half of PK-37's drag surface: the three decisions `src/components/PackContents.vue`
 * would otherwise have to make inside a `.vue` file, where nothing in this repository can
 * execute them.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A MODULE AND NOT THE ISLAND'S OWN SCRIPT BLOCK
 * ---------------------------------------------------------------------------
 *
 * The same argument `src/lib/packs/editor.ts` and `reorder-request.ts` each make for their
 * own layer, with one extra turn of the screw. `vitest.config.ts:64` excludes
 * `src/pages/**` because every file there is a route; an SFC is out of reach for a
 * narrower reason worth stating exactly, because overstating it is how the next person
 * decides the rule does not apply to them. The component itself CAN be server-rendered in
 * the suite — `tests/packs-drag.test.ts` does, with Vue's own `renderToString`, which needs
 * no DOM. What cannot be reached is any INTERACTION: `environment: 'node'` means no
 * `DragEvent`, no `dataTransfer` and no `getBoundingClientRect`, and neither
 * `@vue/test-utils` nor `jsdom` is a dependency to supply them. So a decision taken inside
 * a drag handler is a decision nothing can execute. All three functions below were taken out
 * of such a handler, and a wrong answer to any of them is SILENT: an off-by-one in
 * `dropTargetIndex` is invisible in the middle of a list and shows up only at its ends, a
 * plan applied wrongly in `applyReorderPlan` renders an order the next reload contradicts,
 * and a plan `unknownPlanRows` fails to flag is a plan applied to half a tree under the word
 * "Saved".
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY NOT HERE
 * ---------------------------------------------------------------------------
 *
 * THE POSITION ARITHMETIC. `src/lib/packs/reorder.ts` owns it, both sides call it, and its
 * header says at length why a second copy is the exact failure that module exists to
 * prevent. Nothing below computes a position: `dropTargetIndex` converts one index into
 * another index, and `applyReorderPlan` copies positions a `ReorderPlan` already decided.
 *
 * ANY NOTION OF WHAT A ROW CONTAINS. The two tree functions are generic over rows that
 * carry an `id` and a `position` — the same `Positioned` contract `reorder.ts` defines — so
 * the island hands in the tree it actually renders, names and weights and `overrides` and
 * gear embeds and all, and gets those same rows back rearranged. That is what lets the
 * island pass the result straight to `computeTotals` instead of rebuilding a tree for it.
 *
 * THE ROUND TRIP. Reading the response body and deciding what each outcome MEANS is
 * `src/lib/packs/reorder-response.ts`'s, which calls `unknownPlanRows` below for one of its
 * seven branches. This module knows nothing about `fetch`, a `Response` or a status code.
 *
 * ---------------------------------------------------------------------------
 * NOT importing src/lib/auth/
 * ---------------------------------------------------------------------------
 *
 * This module is bundled into the browser: it is imported by a hydrated Vue island, which
 * is the second and sharper of the two reasons `src/lib/packs/routes.ts`'s header gives for
 * the rule. Invariant A in `tests/anonymous-read-path.test.ts` is an EDGE rule that does
 * not care what a module contains, and Invariant D fails the build if anything on
 * `AUTH_CONSUMERS` reaches the client pass. The one import below is `./reorder`, which is
 * pure for the same reasons.
 */

import { sortByPosition, type Positioned, type ReorderPlan } from './reorder';

// ---------------------------------------------------------------------------
// dropTargetIndex
// ---------------------------------------------------------------------------

/**
 * Converts the slot a pointer chose into the index `planItemMove`/`planCategoryMove` mean.
 *
 * THE TWO INDICES ARE NOT THE SAME NUMBER, and conflating them is the single most likely
 * defect in a drag surface. A drop indicator sits BETWEEN two rendered rows, so what the
 * pointer selects is a slot in the run AS IT IS CURRENTLY DRAWN — `0..n`, where `n` is the
 * number of rows on screen and the row being dragged is still one of them. `reorder.ts`
 * defines `toIndex` as "the index the row will occupy in the RESULTING order — after its
 * own removal", and says why: that is the reading which makes "drag the first of four to
 * the bottom" mean 3 rather than a 4 that then has to be clamped.
 *
 * So when the row is already in the run it is being dropped into, every slot below it
 * closes up by one when it is lifted out, and a slot after its current index is one too
 * high. A row arriving from another category was never in this run, nothing closes up, and
 * the slot is already the answer — which is also why `fromIndex` is `null` rather than
 * `-1` for that case: absent, not "searched for and not found".
 *
 * THE RESULT IS NON-NEGATIVE FOR EVERY CALL THE ISLAND MAKES, and that is a PRECONDITION on
 * the caller rather than a property of this function — the distinction matters because the
 * function does not check it and cannot: `dropTargetIndex(-1, null)` returns `-1`, and
 * `dropTargetIndex(-5, 2)` returns `-5`. What holds is the caller's side. `insertAt` comes
 * from `slotFor` or from a run length, so it is at least 0; `fromIndex` comes from `indexIn`,
 * which returns `null` rather than `-1` for "not found", so where it is a number it is at
 * least 0. Under those two facts the subtracting branch is reached only when
 * `insertAt > fromIndex >= 0`, i.e. `insertAt >= 1`, and the subtraction cannot cross zero.
 * That matters because `readIndex` in `src/lib/packs/reorder-request.ts` refuses a negative
 * outright rather than clamping it, so a negative arriving here would reach a visitor as a
 * refused drag rather than as a wrong one. Guarding it here instead would put a second
 * opinion about the bottom of a list next to `clampTargetIndex`'s, which the next paragraph
 * argues against for the top of one.
 *
 * AN OUT-OF-RANGE `insertAt` IS PASSED THROUGH UNCLAMPED, deliberately. `clampTargetIndex`
 * in `reorder.ts` already holds the honest reading of "index 9 of a 4-row category" and
 * the argument for why the server must tolerate one; clamping here as well would put two
 * places in charge of deciding what the end of a list is, and the one that was wrong would
 * be the one nobody re-reads.
 */
export function dropTargetIndex(insertAt: number, fromIndex: number | null): number {
  if (fromIndex === null || insertAt <= fromIndex) return insertAt;
  return insertAt - 1;
}

// ---------------------------------------------------------------------------
// applyReorderPlan
// ---------------------------------------------------------------------------

/**
 * The shape this module needs from a category: its own `id` and `position`, and its items,
 * each of which needs the same two. Structural rather than an import of `PackTreeRow` —
 * see `ReorderCategoryRows` in `src/lib/packs/reorder-request.ts`, which carries the
 * "STRUCTURAL, DELIBERATELY" argument for the same choice (`ReorderPackRows` beside it is
 * just the one-field wrapper).
 */
export interface PositionedCategory extends Positioned {
  readonly pack_items: readonly Positioned[];
}

/** The item type of whatever category type a caller handed in, so rows come back as the
 *  rows that went in rather than as bare `Positioned` the island would then have to
 *  re-join against its own state. */
type ItemOf<C extends PositionedCategory> = C['pack_items'][number];

/** `position` replaced where the plan names the row, kept where it does not. A row a plan
 *  does not mention is a row the database already agrees with — see `denseUpdates` in
 *  `src/lib/packs/reorder.ts` on why those rows are genuinely untouched rather than
 *  merely omitted. */
function repositioned<T extends Positioned>(row: T, positions: ReadonlyMap<string, number>): T {
  const next = positions.get(row.id);
  return next === undefined ? row : { ...row, position: next };
}

/**
 * Projects a `ReorderPlan` onto the tree on screen: the same rows, with the plan's
 * positions applied, the reparented item moved into its new category, and every run
 * re-sorted through `sortByPosition`.
 *
 * THIS IS THE ONLY WAY THE ISLAND EVER REARRANGES ITS TREE, which is the whole point of it
 * existing. Not the only way it ever assigns to that ref — it initialises the ref from its
 * props, and a failed round trip restores the pre-drag tree with a plain `tree.value =
 * before` — but neither of those computes an order; one is given one and the other puts back
 * one it already had. Every actual REARRANGEMENT goes through here. The tempting shape —
 * splice the row out of one array and into another, and
 * separately compute a plan for the request — is two implementations of "what happens when
 * you drop an item on a category boundary" inside one component, and `reorder.ts`'s header
 * describes exactly how they drift: the screen shows one order and a reload shows another.
 * Going through the plan makes the optimistic render and the wire payload the same
 * decision, taken once.
 *
 * IT IS CALLED TWICE PER SUCCESSFUL DRAG, WITH DIFFERENT PLANS AND THE SAME TREE — and once
 * per drag that is not successful, which is the half worth stating because it is where the
 * argument below actually earns its keep. First with the island's own prediction, to render
 * the move the instant the pointer is released; then, ONLY for the `applied` outcome of
 * `src/lib/packs/reorder-response.ts`'s seven, with the plan the endpoint returns. The other
 * six carry no plan: three of them put `before` back and three keep the optimistic render
 * with an error beside it, and in none of the six is this function called a second time.
 * That second call, when it happens, takes a RESULT rather than a prediction and is
 * applied to the tree the request was computed against rather than to the optimistically
 * updated one — the plan's positions describe the rows as they were read, so applying it
 * on top of a tree that has already moved would apply the move twice. `reorder.ts`'s "BOTH
 * SIDES CALL THIS, ONLY ONE SIDE IS BELIEVED" is that arrangement stated from the other end.
 *
 * THE REPARENTED ROW IS FOUND ACROSS THE WHOLE TREE, not in the category a caller believes
 * it is in — the same reason `reorder.ts` gives in capitals for matching updates on `id`
 * alone. At the moment a plan is applied the row still sits under its old parent, so
 * anything scoped by parent skips exactly the row that moved.
 *
 * `reparent` IS HANDLED EVEN WHEN `runs` IS EMPTY. Drag the only item of one category into
 * an empty one and its position is 0 before and 0 after, so the plan carries no position
 * updates at all while the move is entirely real — see `planChangesAnything` in
 * `src/lib/packs/reorder-request.ts`, which exists for the same trap on the write side.
 *
 * Pure: a new array at every level, and no argument is mutated. The island holds its tree
 * in a `shallowRef` and swaps the whole value, so a function that sorted in place would
 * reorder the DOM as a side effect of computing what the order ought to be — the hazard
 * `sortByPosition`'s own comment names.
 */
export function applyReorderPlan<C extends PositionedCategory>(
  categories: readonly C[],
  plan: ReorderPlan,
): C[] {
  const positions = new Map<string, number>();
  for (const run of plan.runs) {
    for (const update of run.updates) positions.set(update.id, update.position);
  }

  const reparent = plan.reparent;
  const moved: ItemOf<C> | undefined =
    reparent === null
      ? undefined
      : categories
          .flatMap((category) => category.pack_items)
          .find((item) => item.id === reparent.id);

  const next = categories.map((category) => {
    const kept =
      moved === undefined
        ? category.pack_items
        : category.pack_items.filter((item) => item.id !== moved.id);
    const arriving = moved !== undefined && category.id === reparent?.parentId ? [moved] : [];
    const items = [...kept, ...arriving].map((item) => repositioned(item, positions));
    return { ...repositioned(category, positions), pack_items: sortByPosition(items) };
  });

  return sortByPosition(next);
}

// ---------------------------------------------------------------------------
// unknownPlanRows
// ---------------------------------------------------------------------------

/**
 * The ids a plan names that this tree does not have — empty for a plan the tree can apply
 * in full.
 *
 * WHY THIS EXISTS: `applyReorderPlan` ABOVE IS DELIBERATELY FORGIVING IN ONE DIRECTION AND
 * ACCIDENTALLY FORGIVING IN THE OTHER. `repositioned` keeps a row the plan does not
 * mention, which is right and is the whole of `denseUpdates`' contract — a row whose
 * position did not change is genuinely untouched rather than merely omitted. The reverse is
 * not symmetrical and was silently absorbed until PK-37's independent review: an update
 * naming an id that is nowhere in `categories` is written into the `positions` map, matched
 * by nothing, and dropped without a trace.
 *
 * That case is not noise. The plan the endpoint returns is a RESULT computed from the rows
 * the SERVER read under the caller's own session moments earlier (see "BOTH SIDES CALL
 * THIS, ONLY ONE SIDE IS BELIEVED" in `src/lib/packs/reorder.ts`), so an id in it that this
 * tree lacks is proof the two disagree about what is in the pack — two tabs open on one
 * pack is the ordinary way to produce it, not an exotic one. The move itself landed
 * correctly in the database; what cannot be trusted afterwards is the tree on screen, and
 * the honest answer is to say so rather than to render a partially applied plan under the
 * word "Saved".
 *
 * WHAT IS CHECKED IS EXACTLY WHAT `applyReorderPlan` LOOKS UP, no more:
 *
 *   - every `updates[].id`, against category ids AND item ids together, because
 *     `applyReorderPlan` flattens both levels into one map keyed on id alone and a category
 *     plan and an item plan are indistinguishable once flattened;
 *   - `reparent.id`, which must be an ITEM — it is searched for across every category's
 *     `pack_items`, and an id found nowhere means the row simply never arrives anywhere;
 *   - `reparent.parentId`, which must be a CATEGORY — `applyReorderPlan` matches it against
 *     `category.id` to decide where the moved row lands, so an id matching no category
 *     removes the item from its old parent and adds it to no new one. That is the one case
 *     in this list that LOSES a row from the rendered tree rather than merely failing to
 *     move it.
 *
 * `runs[].parentId` IS NOT CHECKED, and its absence from the list above is a decision
 * rather than an oversight. `applyReorderPlan` never looks it up — it flattens the runs and
 * keys on row id — and for a category move it is the PACK's id, which is not a row in this
 * tree at all and never could be. Checking it would fail every category drag.
 *
 * The result is sorted and de-duplicated so a caller logging it gets a stable string; no
 * caller branches on WHICH ids came back, only on whether any did.
 */
export function unknownPlanRows<C extends PositionedCategory>(
  categories: readonly C[],
  plan: ReorderPlan,
): string[] {
  const categoryIds = new Set(categories.map((category) => category.id));
  const itemIds = new Set(
    categories.flatMap((category) => category.pack_items.map((item) => item.id)),
  );

  const unknown = new Set<string>();
  for (const run of plan.runs) {
    for (const update of run.updates) {
      if (!categoryIds.has(update.id) && !itemIds.has(update.id)) unknown.add(update.id);
    }
  }

  const reparent = plan.reparent;
  if (reparent !== null) {
    if (!itemIds.has(reparent.id)) unknown.add(reparent.id);
    if (!categoryIds.has(reparent.parentId)) unknown.add(reparent.parentId);
  }

  return [...unknown].sort();
}
