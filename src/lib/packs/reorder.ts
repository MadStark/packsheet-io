/**
 * Position arithmetic for pack list composition (PK-37): the one place in the product
 * that decides what `pack_categories.position` and `pack_items.position` become after a
 * drag. Pure functions over plain rows — no I/O, no framework import, no Supabase client,
 * nothing that can fail for a reason other than a bad argument — on the same footing as
 * `src/lib/units.ts` and `src/lib/totals.ts`, whose module comments establish that
 * posture and are not restated here.
 *
 * Nothing in this file may import from `src/lib/auth/`. Invariant A in
 * `tests/anonymous-read-path.test.ts` is an EDGE rule that does not care what a module
 * contains, and this one is imported by a Vue island that ships to the browser, so the
 * rule has teeth twice over. See `src/lib/packs/routes.ts`'s header.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE SCHEMA ALREADY DECIDED, AND WHICH THIS FILE ONLY IMPLEMENTS
 * ---------------------------------------------------------------------------
 *
 * `supabase/migrations/20260810120000_core_schema.sql:228` (`pack_categories.position`)
 * carries the decision in full, and `:268` (`pack_items.position`) points at it with "See
 * the note on pack_categories.position". Both columns are
 * `integer not null default 0 check (position >= 0)`. Read that comment before changing
 * anything below; three of its clauses are load-bearing here.
 *
 *   REINDEX, NOT A FRACTIONAL INDEX. "A move rewrites the affected run of siblings in one
 *   statement inside one transaction." So a plan produced here is a whole run's worth of
 *   integers, not one clever value wedged between two neighbours. The migration accepted
 *   O(n) writes against a list whose acceptance criterion is 40 items in exchange for
 *   positions a human can read in a query result and no ordering library on either side
 *   of the wire. Every function below is that trade, spent.
 *
 *   POSITION IS NOT UNIQUE, AND TIES RESOLVE ON `id`. "Deliberately NOT unique: a unique
 *   (parent, position) pair forces every reindex through a DEFERRABLE constraint or a
 *   temporary negative range, and that machinery is a poor trade for ties that resolve
 *   deterministically on id." Duplicates are therefore legal input, and `sortByPosition`
 *   below is what "resolve deterministically on id" actually means in code. The read
 *   indexes agree in their column order — `pack_categories_pack_id_position_idx` on
 *   `(pack_id, position, id)` and `pack_items_pack_category_id_position_idx` on
 *   `(pack_category_id, position, id)`, at `:697` and `:699` — so a server-side
 *   `order('position').order('id')` and a client-side `sortByPosition` produce the same
 *   sequence, which is the whole requirement.
 *
 *   NEGATIVES ARE NOT LEGAL. "Duplicate positions are a deliberate allowance; negatives
 *   are just a reindex that went wrong." No function here can emit one: every position it
 *   produces is an index into an array, so the floor is structural rather than checked.
 *   `tests/packs-reorder.test.ts` asserts it anyway, because "cannot happen by
 *   construction" is a property of the construction and the construction can be edited.
 *
 * ---------------------------------------------------------------------------
 * BOTH SIDES CALL THIS, ONLY ONE SIDE IS BELIEVED
 * ---------------------------------------------------------------------------
 *
 * The Vue island calls these functions to render the move optimistically the instant the
 * pointer is released, and the endpoint at `PACK_REORDER_PATH` calls the SAME functions
 * against rows it has just read for itself. Neither owns a second copy of the rules,
 * which is the reason this module exists at all: two implementations of "what happens
 * when you drop an item on a category boundary" drift, and the way they drift is that the
 * screen shows one order and a reload shows another.
 *
 * That sharing is NOT a claim that the client's arithmetic is trusted. The wire carries
 * the INTENT — which row, which destination run, which index — and never a computed
 * position list. The server re-plans from its own read under the caller's own session, so
 * a hand-written request can express "move item X to index 3 of category Y" and cannot
 * express "set every position in this pack to 0", and the row-level policies remain the
 * only thing deciding whether the rows may be touched at all. `ReorderPlan` is therefore
 * a RESULT on the server and a PREDICTION on the client, from identical code; when they
 * disagree, the server's is the one that gets written and the client re-renders from the
 * response.
 *
 * ---------------------------------------------------------------------------
 * WHY THE RETURN SHAPE IS `{id, position}` PAIRS GROUPED BY RUN
 * ---------------------------------------------------------------------------
 *
 * A plan is `{ runs: [{ parentId, updates: [{id, position}, ...] }, ...], reparent }`.
 * The alternatives considered, and why they lost:
 *
 *   AN ORDERED ARRAY OF IDS, positions left implicit in the index. Smaller on the wire,
 *   but it makes the database infer the arithmetic, which puts a second implementation of
 *   these rules in SQL — precisely the duplication this module exists to prevent. It also
 *   cannot express "only these three rows changed".
 *
 *   ONE FLAT LIST OF PAIRS, ungrouped. A cross-category move touches two runs and the
 *   caller needs to know which is which: the source run and the destination run are
 *   separate `where` clauses to scope and separate things to authorise. Flattening throws
 *   that away and the endpoint immediately reconstructs it.
 *
 *   THE WHOLE ROWS BACK, updated. Tempting for the island, which wants to re-render, but
 *   it makes the payload a copy of the pack and invites the endpoint to write columns the
 *   move never touched.
 *
 * Pairs grouped by run are exactly what an RPC taking a `jsonb` argument wants: one
 * `update ... from jsonb_to_recordset(...)` per run, one statement, one transaction, the
 * shape the migration's "rewrites the affected run of siblings in one statement" sentence
 * describes.
 *
 * THE UPDATES MUST BE MATCHED ON `id` ALONE — NOT ON `(parent, id)`. This is the one
 * thing about the shape that will bite an implementer who does not read this paragraph.
 * In a cross-category move the moved row appears in the DESTINATION run's updates while
 * it still carries its OLD `pack_category_id` in the database. A statement scoped
 * `where pack_category_id = $parent and id = v.id` therefore silently skips exactly one
 * row — the row that moved — and the write half-lands. `parentId` on a `RunUpdate` is
 * there to say which run the numbers belong to, for authorisation and for grouping; it is
 * not a predicate.
 *
 * `reparent` IS SEPARATE FROM THE POSITIONS, AND IS NOT REDUNDANT WITH THEM. It names the
 * one row whose `pack_category_id` changes, and it is present on every cross-category
 * move EVEN WHEN both runs' update lists come back empty — which happens more often than
 * it sounds: drag the only item of one category into an empty one and the row's position
 * is 0 before and 0 after, so the position diff is genuinely nothing while the move is
 * entirely real. A caller that treats an empty `runs` as "nothing to do" loses that move.
 * Check `reparent` first.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS CLAMPED, WHAT IS THROWN, AND WHY THE TWO ARE SPLIT WHERE THEY ARE
 * ---------------------------------------------------------------------------
 *
 * `src/lib/units.ts`'s "THROW, NOT RETURN" section argues that a bad weight must stop the
 * computation because 0 g is a specific and wrong claim rather than a safe default. The
 * same test applied here splits the arguments in two, because a target INDEX does have a
 * safe interpretation and a target ID does not.
 *
 *   AN OUT-OF-RANGE INDEX IS CLAMPED. "Index 9 of a 4-row category" is the everyday
 *   result of a list that changed under the person dragging — a sibling deleted in another
 *   tab, an item that moved while the pointer was down — and it has an unambiguous, honest
 *   reading: as far towards the end as the run goes. The server re-plans against its own
 *   freshly read rows, where the index it was handed may legitimately be past the end for
 *   exactly that reason; throwing there would turn a benign race into a 500 on a drag the
 *   visitor would swear worked. A fractional index truncates, for the same reason.
 *
 *   A NON-FINITE INDEX THROWS. `NaN` and the infinities are not stale, they are a parse
 *   that failed and never said so — `Number(form.get('toIndex'))` on a field that was not
 *   sent is `NaN`, and `NaN` clamped by comparison silently becomes 0, which is "move it
 *   to the very top" and is a real, wrong write. This is exactly the failure `units.ts`
 *   refuses to paper over, in a different column.
 *
 *   AN UNKNOWN ROW ID THROWS. There is no safe reading of "move a row that is not in the
 *   run you told me it is in": either the row was deleted, in which case the write must
 *   not be invented, or the caller read the wrong run, in which case every position in the
 *   plan would be computed against the wrong siblings. Clamping cannot express "no move".
 *
 *   A DUPLICATED ROW ID THROWS. A run containing the same id twice — or an id present in
 *   both the source and destination runs of a cross-category move — would produce a plan
 *   assigning two different positions to one row, whose outcome then depends on the order
 *   the RPC happens to apply the pairs in. That is corruption with a shrug, so it is
 *   refused at the boundary instead.
 */

/**
 * The two columns every function here needs from a row, and the only two. Callers pass
 * their own richer rows — a category with its name, an item with its quantity and worn
 * flag — and the generic parameter carries the full type back out of `sortByPosition`
 * so the island can sort the objects it actually renders.
 */
export interface Positioned {
  readonly id: string;
  readonly position: number;
}

/** One row's new position. The unit the RPC applies. */
export interface PositionUpdate {
  readonly id: string;
  readonly position: number;
}

/**
 * A run of siblings that share a parent: the categories of one pack (`parentId` is the
 * `pack_id`), or the items of one category (`parentId` is the `pack_category_id`). `rows`
 * need not be sorted — every function sorts defensively — but it must be complete, since
 * a reindex computed against half a run renumbers that half on top of the other.
 */
export interface Run<T extends Positioned = Positioned> {
  readonly parentId: string;
  readonly rows: readonly T[];
}

/** The new positions for one affected run. See "matched on `id` alone" in the header. */
export interface RunUpdate {
  readonly parentId: string;
  readonly updates: readonly PositionUpdate[];
}

/** The single row whose parent changes on a cross-category move. */
export interface Reparent {
  readonly id: string;
  readonly parentId: string;
}

/**
 * Everything the caller must write to make a move real, and nothing else. `runs` holds
 * only runs with at least one changed position; `reparent` is null for a move that stays
 * inside its run. Both can be empty at once — that is a no-op, and the caller should
 * issue no writes rather than an empty transaction.
 */
export interface ReorderPlan {
  readonly runs: readonly RunUpdate[];
  readonly reparent: Reparent | null;
}

/**
 * Orders two rows the way Postgres does when reading through
 * `(pack_id, position, id)` / `(pack_category_id, position, id)`: by `position`, then by
 * `id`.
 *
 * THE ID TIE-BREAK COMPARES LOWERCASED STRINGS, and that is a real decision rather than
 * defensive noise. Both id columns are `uuid`, which Postgres compares as 16 raw bytes.
 * The canonical text form is lowercase hex with hyphens at fixed offsets, so a plain
 * lexicographic comparison of two canonical UUID strings agrees with the byte comparison
 * exactly: the hyphens line up and never decide anything, and `'0'`-`'9'` (0x30-0x39)
 * sort below `'a'`-`'f'` (0x61-0x66) in the same order their nibble values do. The one way
 * to break that agreement is case — `'A'` is 0x41 and sorts BELOW `'a'`, so an uppercase
 * spelling of a uuid would sort differently in JavaScript than the same value does in the
 * database, and the client and the server would disagree about the current order. PostgREST
 * emits lowercase, so this costs nothing in practice; it is here so that a hand-built
 * fixture, a value pasted from a dashboard, or an import that upper-cased its ids cannot
 * quietly desynchronise the two sides.
 *
 * Exported because the island needs the same comparator for its own rendering, and a
 * second `(a, b) => a.position - b.position` written inline there is precisely the drift
 * this module exists to prevent.
 */
export function compareByPosition(a: Positioned, b: Positioned): number {
  if (a.position !== b.position) return a.position - b.position;
  const left = a.id.toLowerCase();
  const right = b.id.toLowerCase();
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * The canonical current order of a run: position ascending, ties broken on id. This is
 * what "current order" MEANS for both sides — the island renders it, the server plans
 * against it, and neither is entitled to its own opinion when two siblings share a
 * position (which the schema explicitly permits).
 *
 * Returns a new array and never mutates its argument. The island hands in a reactive
 * array it is rendering from; sorting that in place would reorder the DOM as a side
 * effect of asking a question about it.
 */
export function sortByPosition<T extends Positioned>(rows: readonly T[]): T[] {
  return [...rows].sort(compareByPosition);
}

/**
 * The dense 0..n-1 renumbering of an already-ordered run, minus the rows that are already
 * sitting on the number they would be given.
 *
 * THE FILTER IS AN OPTIMISATION AND IS SAFE, but it is worth being precise about why: the
 * comparison is against the row's CURRENT STORED position, which is still its stored value
 * even for the row being moved across categories (its position column has not changed yet;
 * only its parent is about to). So a filtered-out row is genuinely a row the database
 * already agrees with.
 *
 * A MOVE ALWAYS DENSIFIES THE RUNS IT TOUCHES, even where the visible order does not
 * change — a run stored as 0, 5, 9 comes back as 0, 1, 2. The alternative (rewrite only
 * what the drag displaced, preserve the gaps) keeps a run's numbering forever dependent on
 * the history of its edits, so two runs displaying identically hold different integers and
 * every tie-break argument has to be re-made from scratch each time. Reindexing is what the
 * migration chose; a reindex that half-happens is just a fractional index with worse
 * ergonomics.
 */
function denseUpdates(ordered: readonly Positioned[]): PositionUpdate[] {
  const updates: PositionUpdate[] = [];
  ordered.forEach((row, index) => {
    if (row.position !== index) updates.push({ id: row.id, position: index });
  });
  return updates;
}

/** Rejects `NaN` and the infinities loudly; truncates and clamps everything else. See
 *  "WHAT IS CLAMPED, WHAT IS THROWN" in the header for why the line falls here. */
function clampTargetIndex(toIndex: number, maxIndex: number): number {
  if (!Number.isFinite(toIndex)) {
    throw new RangeError(
      `Target index must be a finite number, received ${String(toIndex)}. A non-finite index is a parse that failed upstream, not a stale one.`,
    );
  }
  const whole = Math.trunc(toIndex);
  if (whole <= 0) return 0;
  if (whole >= maxIndex) return maxIndex;
  return whole;
}

/**
 * Refuses a row id that appears more than once across the runs a single move touches —
 * twice in one run, or once in each of two. Either way the resulting plan would give one
 * row two positions and the outcome would depend on the order the RPC applied the pairs
 * in. See the header's fourth throwing case.
 */
function assertDistinctIds(runs: readonly Run<Positioned>[]): void {
  const seen = new Set<string>();
  for (const run of runs) {
    for (const row of run.rows) {
      if (seen.has(row.id)) {
        throw new Error(
          `Row ${row.id} appears more than once in the runs being reordered; a reindex cannot give one row two positions.`,
        );
      }
      seen.add(row.id);
    }
  }
}

/** Locates the row being moved, or throws. An id that is not in the run it was said to be
 *  in has no safe interpretation — see the header's third throwing case. */
function indexOfRow(ordered: readonly Positioned[], id: string, parentId: string): number {
  const index = ordered.findIndex((row) => row.id === id);
  if (index === -1) {
    throw new Error(`Row ${id} is not in the run of ${parentId}, so its move cannot be planned.`);
  }
  return index;
}

/** Shared by the category move and the same-category item move: they are the same
 *  arithmetic over different tables, and writing it twice is how the two stop agreeing. */
function planMoveWithinRun(run: Run, id: string, toIndex: number): ReorderPlan {
  assertDistinctIds([run]);

  const ordered = sortByPosition(run.rows);
  const from = indexOfRow(ordered, id, run.parentId);
  const to = clampTargetIndex(toIndex, ordered.length - 1);

  const moved = [...ordered];
  const [row] = moved.splice(from, 1);
  moved.splice(to, 0, row);

  const updates = denseUpdates(moved);
  return { runs: updates.length > 0 ? [{ parentId: run.parentId, updates }] : [], reparent: null };
}

/**
 * Moves a category among its siblings within one pack.
 *
 * `toIndex` IS THE INDEX THE CATEGORY WILL OCCUPY IN THE RESULTING ORDER — after its own
 * removal, not before it. That is the definition every drag-and-drop surface uses and the
 * one that makes "drag the first of four to the bottom" mean `toIndex: 3` rather than a
 * `4` that then has to be clamped. The off-by-one in the other reading is invisible in the
 * middle of a list and only shows up at its ends, which is the worst possible place for it
 * to first appear.
 */
export function planCategoryMove(pack: Run, categoryId: string, toIndex: number): ReorderPlan {
  return planMoveWithinRun(pack, categoryId, toIndex);
}

/**
 * Moves an item, either within its category or into another one. The caller does not pick
 * between two functions: it passes the run the item is in and the run it is going to, and
 * the two being the same category is an ordinary case rather than a separate API. That is
 * deliberate — a drop target does not know whether the pointer crossed a category boundary,
 * and making the CALLER classify the move is how a same-category drop ends up planned as a
 * cross-category one that reparents a row to the category it is already in.
 *
 * WHEN `from.parentId === to.parentId` the move is planned entirely from `from.rows` and
 * `to.rows` is ignored, rather than the two being merged or compared. They are two
 * descriptions of one run; treating them as distinct would double every row in it and trip
 * `assertDistinctIds`. `from` wins because it is the run the item was located in.
 *
 * ACROSS CATEGORIES, BOTH RUNS ARE REWRITTEN. The source run closes the gap the item left
 * (0,1,2,3 minus the middle one is 0,1,2, not 0,1,3) and the destination run opens one for
 * it. Returning only the destination is the bug this signature exists to make hard to
 * write: the source's numbering would keep a hole, which is legal — positions are not
 * unique and gaps are permitted — and then reads fine, right up until the next insert
 * lands on a duplicate position and the id tie-break puts it somewhere nobody chose.
 *
 * `toIndex` is the index within the DESTINATION run, and its valid range is `0..n` rather
 * than `0..n-1`: an item arriving from elsewhere can land after every row already there,
 * which is one more slot than there are rows. Dropping into an empty category is `0`.
 */
export function planItemMove(from: Run, to: Run, itemId: string, toIndex: number): ReorderPlan {
  if (from.parentId === to.parentId) return planMoveWithinRun(from, itemId, toIndex);

  assertDistinctIds([from, to]);

  const sourceOrdered = sortByPosition(from.rows);
  const row = sourceOrdered[indexOfRow(sourceOrdered, itemId, from.parentId)];

  const remaining = sourceOrdered.filter((candidate) => candidate.id !== itemId);
  const destinationOrdered = sortByPosition(to.rows);
  const target = clampTargetIndex(toIndex, destinationOrdered.length);
  const arrived = [...destinationOrdered];
  arrived.splice(target, 0, row);

  const runs: RunUpdate[] = [];
  const sourceUpdates = denseUpdates(remaining);
  if (sourceUpdates.length > 0) runs.push({ parentId: from.parentId, updates: sourceUpdates });
  const destinationUpdates = denseUpdates(arrived);
  if (destinationUpdates.length > 0) {
    runs.push({ parentId: to.parentId, updates: destinationUpdates });
  }

  return { runs, reparent: { id: itemId, parentId: to.parentId } };
}
