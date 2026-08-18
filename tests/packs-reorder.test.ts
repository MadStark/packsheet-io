import { describe, expect, it } from 'vitest';
import {
  compareByPosition,
  planCategoryMove,
  planItemMove,
  sortByPosition,
  type Positioned,
  type ReorderPlan,
  type Run,
} from '../src/lib/packs/reorder';

/**
 * `src/lib/packs/reorder.ts` is the whole position engine for PK-37: no I/O, so every
 * rule it implements is pinned here rather than half here and half in an integration
 * suite. Read that module's comment first — in particular "WHAT THE SCHEMA ALREADY
 * DECIDED", "BOTH SIDES CALL THIS, ONLY ONE SIDE IS BELIEVED" and "WHAT IS CLAMPED, WHAT
 * IS THROWN" — because a good half of what follows exists to hold those decisions in
 * place rather than to restate what the code plainly does.
 *
 * Same care as `tests/units.test.ts` and `tests/gear-query.test.ts`: each assertion below
 * names the bug it would catch. The ones that matter most are the three the schema itself
 * asks for at `supabase/migrations/20260810120000_core_schema.sql:228` — a deterministic
 * tie-break on id, a reindex that touches the whole affected run, and no negative
 * position ever reaching a column constrained `check (position >= 0)`.
 *
 * IDS ARE MOSTLY SINGLE LETTERS, not UUIDs, because the comparator is defined over
 * strings and a four-row run written as `a b c d` can be read at a glance where four
 * UUIDs cannot. The tests that are ABOUT id shape — the ones pinning the agreement with
 * Postgres's uuid byte ordering — use real UUID spellings, because there the exact
 * characters are the thing under test.
 */

/** A run written as `[id, storedPosition]` pairs, in whatever order reads clearest —
 *  never sorted for the module's benefit, since sorting defensively is part of what is
 *  being tested. */
const run = (parentId: string, rows: readonly (readonly [string, number])[]): Run => ({
  parentId,
  rows: rows.map(([id, position]) => ({ id, position })),
});

/** The updates a plan carries for one run, or `[]` if it touches that run not at all. */
const updatesFor = (plan: ReorderPlan, parentId: string): readonly Positioned[] =>
  plan.runs.find((entry) => entry.parentId === parentId)?.updates ?? [];

/**
 * Applies a plan to a run and reports the resulting order — the round trip that actually
 * matters, since a list of integers is only correct in terms of the sequence it produces
 * when read back through the shared comparator. Rows the plan does not mention keep their
 * stored position, which is exactly what the database will do with them.
 */
const orderAfter = (rows: readonly Positioned[], plan: ReorderPlan, parentId: string): string[] => {
  const updates = new Map(updatesFor(plan, parentId).map((u) => [u.id, u.position]));
  return sortByPosition(
    rows.map((row) => ({ ...row, position: updates.get(row.id) ?? row.position })),
  ).map((row) => row.id);
};

/** Every position a plan would write, across every run it touches. */
const allPositions = (plan: ReorderPlan): number[] =>
  plan.runs.flatMap((entry) => entry.updates.map((update) => update.position));

describe('sortByPosition: the canonical order both the island and the server read', () => {
  it('orders by position ascending regardless of the order the rows arrived in', () => {
    const rows = [
      { id: 'c', position: 2 },
      { id: 'a', position: 0 },
      { id: 'b', position: 1 },
    ];
    expect(sortByPosition(rows).map((row) => row.id)).toEqual(['a', 'b', 'c']);
  });

  // The schema permits duplicate positions on purpose (":228 — Deliberately NOT unique")
  // and pays for that with a tie-break on id. If this ordering depended on the order rows
  // came back in, the island and the server would each render a different one of two
  // equally valid sequences and the pack would appear to reshuffle itself on reload.
  it('breaks a tie on id, so a duplicated position still has exactly one order', () => {
    const forwards = [
      { id: 'b', position: 0 },
      { id: 'a', position: 0 },
    ];
    const backwards = [...forwards].reverse();

    expect(sortByPosition(forwards).map((row) => row.id)).toEqual(['a', 'b']);
    expect(sortByPosition(backwards).map((row) => row.id)).toEqual(['a', 'b']);
  });

  // Postgres compares `uuid` as 16 raw bytes. A canonical (lowercase) UUID string
  // compares the same way in JavaScript — but an uppercase spelling does NOT, and this is
  // the one input that would make the client and the server disagree about "current
  // order" while both looked correct in isolation.
  it('compares ids case-insensitively, matching how Postgres orders uuid bytes', () => {
    const upperB = 'B0000000-0000-4000-8000-000000000000';
    const lowerA = 'a0000000-0000-4000-8000-000000000000';

    // The trap, stated as an assertion so it cannot be dismissed as hypothetical: raw
    // string comparison puts the uppercase B first, because 'B' is 0x42 and 'a' is 0x61.
    // Postgres puts the a-row first, because byte 0xa0 is below byte 0xb0.
    expect(upperB < lowerA).toBe(true);

    const sorted = sortByPosition([
      { id: upperB, position: 3 },
      { id: lowerA, position: 3 },
    ]);
    expect(sorted.map((row) => row.id)).toEqual([lowerA, upperB]);
  });

  it('sorts a hex digit below a hex letter, as the nibble values do', () => {
    const nine = '90000000-0000-4000-8000-000000000000';
    const aaa = 'a0000000-0000-4000-8000-000000000000';
    expect(
      sortByPosition([
        { id: aaa, position: 0 },
        { id: nine, position: 0 },
      ]),
    ).toEqual([
      { id: nine, position: 0 },
      { id: aaa, position: 0 },
    ]);
  });

  // The island renders straight from the array it passes in. Sorting it in place would
  // reorder the DOM as a side effect of asking what the order is.
  it('returns a new array and leaves its argument untouched', () => {
    const rows = [
      { id: 'b', position: 1 },
      { id: 'a', position: 0 },
    ];
    const sorted = sortByPosition(rows);

    expect(sorted).not.toBe(rows);
    expect(rows.map((row) => row.id)).toEqual(['b', 'a']);
  });

  it('compareByPosition reports equality only for a row against itself', () => {
    const row = { id: 'a', position: 4 };
    expect(compareByPosition(row, row)).toBe(0);
    expect(compareByPosition(row, { id: 'b', position: 4 })).toBeLessThan(0);
    expect(compareByPosition(row, { id: 'a', position: 5 })).toBeLessThan(0);
  });
});

describe('planCategoryMove: a category among its siblings', () => {
  const pack = run('pack-1', [
    ['a', 0],
    ['b', 1],
    ['c', 2],
    ['d', 3],
  ]);

  it('moves the first category to the last slot and renumbers the run densely', () => {
    const plan = planCategoryMove(pack, 'a', 3);

    expect(updatesFor(plan, 'pack-1')).toEqual([
      { id: 'b', position: 0 },
      { id: 'c', position: 1 },
      { id: 'd', position: 2 },
      { id: 'a', position: 3 },
    ]);
    expect(orderAfter(pack.rows, plan, 'pack-1')).toEqual(['b', 'c', 'd', 'a']);
  });

  // `toIndex` is the index in the RESULTING order, after the row's own removal. Under the
  // other reading — index in the original list — this same call would land 'd' at index 2
  // and every drag would be one slot short of where it was dropped, invisibly in the
  // middle of a list and obviously at its ends.
  it('moves a category up, landing it exactly on the index asked for', () => {
    const plan = planCategoryMove(pack, 'd', 1);
    expect(orderAfter(pack.rows, plan, 'pack-1')).toEqual(['a', 'd', 'b', 'c']);
  });

  it('a move to the index the category already occupies writes nothing at all', () => {
    const plan = planCategoryMove(pack, 'b', 1);

    expect(plan.runs).toEqual([]);
    expect(plan.reparent).toBeNull();
  });

  // A run stored 0, 5, 9 displays identically to one stored 0, 1, 2 — but only one of
  // them is what the next insert will be numbered against. The reindex the migration
  // chose is a whole-run reindex, so an ordinally-unchanged move still closes the gaps,
  // and only the rows whose stored number is actually wrong are written.
  it('densifies a run stored with gaps even when the visible order does not change', () => {
    const gappy = run('pack-1', [
      ['a', 0],
      ['b', 5],
      ['c', 9],
    ]);
    const plan = planCategoryMove(gappy, 'b', 1);

    expect(updatesFor(plan, 'pack-1')).toEqual([
      { id: 'b', position: 1 },
      { id: 'c', position: 2 },
    ]);
    expect(orderAfter(gappy.rows, plan, 'pack-1')).toEqual(['a', 'b', 'c']);
  });

  // A sibling deleted in another tab is enough to make the index a drag produced point
  // past the end of the run the server then reads. Throwing there turns a benign race
  // into a 500 on a drag the visitor would swear worked.
  it('clamps an index past the end to the last slot instead of throwing', () => {
    expect(orderAfter(pack.rows, planCategoryMove(pack, 'a', 99), 'pack-1')).toEqual([
      'b',
      'c',
      'd',
      'a',
    ]);
  });

  it('clamps a negative index to the top', () => {
    expect(orderAfter(pack.rows, planCategoryMove(pack, 'c', -12), 'pack-1')).toEqual([
      'c',
      'a',
      'b',
      'd',
    ]);
  });

  it('truncates a fractional index rather than producing a fractional position', () => {
    const plan = planCategoryMove(pack, 'a', 2.9);
    expect(orderAfter(pack.rows, plan, 'pack-1')).toEqual(['b', 'c', 'a', 'd']);
    for (const position of allPositions(plan)) expect(Number.isInteger(position)).toBe(true);
  });

  // `Number(body.toIndex)` on a field that was never sent is NaN, and NaN loses every
  // comparison — so a clamp written with `<` and `>` alone silently reads it as 0 and
  // moves the row to the very top. That is a real, wrong write dressed as a default,
  // which is exactly what src/lib/units.ts refuses to do with a bad weight.
  it.each([
    ['NaN', Number.NaN],
    ['positive infinity', Number.POSITIVE_INFINITY],
    ['negative infinity', Number.NEGATIVE_INFINITY],
  ])('throws on a non-finite index (%s) rather than clamping it to the top', (_label, index) => {
    expect(() => planCategoryMove(pack, 'a', index)).toThrow(RangeError);
    expect(() => planCategoryMove(pack, 'a', index)).toThrow(/finite/i);
  });

  // Either the row was deleted — in which case the write must not be invented — or the
  // caller read the wrong run, in which case every position in the plan would be computed
  // against the wrong siblings. Neither has a safe reading, and a clamp cannot say "no".
  it('throws when the category is not in the run it was said to be in', () => {
    expect(() => planCategoryMove(pack, 'missing', 0)).toThrow(/not in the run/);
  });

  it('throws when a run lists the same id twice, rather than giving one row two positions', () => {
    const doubled = run('pack-1', [
      ['a', 0],
      ['a', 1],
      ['b', 2],
    ]);
    expect(() => planCategoryMove(doubled, 'b', 0)).toThrow(/more than once/);
  });

  it('is never a reparent — a category move cannot change what a category belongs to', () => {
    expect(planCategoryMove(pack, 'a', 3).reparent).toBeNull();
  });

  it('plans nothing for a single-category pack, whatever index is asked for', () => {
    const solo = run('pack-1', [['a', 0]]);
    expect(planCategoryMove(solo, 'a', 0)).toEqual({ runs: [], reparent: null });
    expect(planCategoryMove(solo, 'a', 7)).toEqual({ runs: [], reparent: null });
  });
});

describe('planItemMove: within one category', () => {
  const category = run('cat-1', [
    ['x', 0],
    ['y', 1],
    ['z', 2],
  ]);

  it('plans a same-category drop as a reorder and not as a reparent', () => {
    const plan = planItemMove(category, category, 'z', 0);

    expect(plan.reparent).toBeNull();
    expect(orderAfter(category.rows, plan, 'cat-1')).toEqual(['z', 'x', 'y']);
  });

  // A drop target does not know whether the pointer crossed a category boundary, so the
  // island passes whatever it has for both sides. When the two name the same category
  // they are two descriptions of one run: merging them would double every row and trip
  // the duplicate-id guard on a move that is entirely legitimate.
  it('ignores the destination rows when both runs name the same category', () => {
    const staleView = run('cat-1', [
      ['x', 0],
      ['y', 1],
      ['z', 2],
    ]);
    const plan = planItemMove(category, staleView, 'x', 2);

    expect(plan.reparent).toBeNull();
    expect(orderAfter(category.rows, plan, 'cat-1')).toEqual(['y', 'z', 'x']);
  });

  it('clamps to the last slot, one short of where a cross-category drop may land', () => {
    const plan = planItemMove(category, category, 'x', 99);
    expect(updatesFor(plan, 'cat-1')).toContainEqual({ id: 'x', position: 2 });
  });
});

describe('planItemMove: across categories', () => {
  const source = run('cat-1', [
    ['a', 0],
    ['b', 1],
    ['c', 2],
  ]);
  const destination = run('cat-2', [
    ['x', 0],
    ['y', 1],
  ]);

  // The source closing its gap is the half that is easy to forget, and forgetting it is
  // not immediately visible: 0, 1, 3 reads back in the right order and stays wrong until
  // the next insert lands on a duplicate position and the id tie-break puts it somewhere
  // nobody chose.
  it('rewrites BOTH runs: the source closes its gap and the destination opens one', () => {
    const plan = planItemMove(source, destination, 'b', 1);

    expect(updatesFor(plan, 'cat-1')).toEqual([{ id: 'c', position: 1 }]);

    // 'b' is absent from the destination's updates ON PURPOSE, and this is the clearest
    // demonstration of why the plan is not simply "every row of every touched run": it
    // was stored at position 1 in cat-1 and it lands at index 1 in cat-2, so the only
    // thing that has to change about it is its parent. `reparent` carries that, and a
    // caller reading the updates alone would conclude the row had not moved.
    expect(updatesFor(plan, 'cat-2')).toEqual([{ id: 'y', position: 2 }]);
    expect(plan.reparent).toEqual({ id: 'b', parentId: 'cat-2' });

    expect(
      orderAfter(
        [...source.rows].filter((row) => row.id !== 'b'),
        plan,
        'cat-1',
      ),
    ).toEqual(['a', 'c']);
    expect(orderAfter([...destination.rows, { id: 'b', position: 1 }], plan, 'cat-2')).toEqual([
      'x',
      'b',
      'y',
    ]);
  });

  it('reports the reparent, which is the only thing that moves the row itself', () => {
    expect(planItemMove(source, destination, 'b', 0).reparent).toEqual({
      id: 'b',
      parentId: 'cat-2',
    });
  });

  // The trap the module comment warns about: a caller that treats an empty `runs` as
  // "nothing to do" loses this move entirely. The item's position is 0 before and 0
  // after, so there is genuinely no position to write — and the move is still real.
  it('still reports the reparent when no position changes at all', () => {
    const onlyItem = run('cat-1', [['a', 0]]);
    const empty = run('cat-2', []);
    const plan = planItemMove(onlyItem, empty, 'a', 0);

    expect(plan.runs).toEqual([]);
    expect(plan.reparent).toEqual({ id: 'a', parentId: 'cat-2' });
  });

  // A row arriving from elsewhere can land after every row already present, which is one
  // more slot than a within-run move has. Clamping to `length - 1` here would make it
  // impossible to drop an item at the bottom of another category.
  it('accepts an index one past the destination’s last row', () => {
    const plan = planItemMove(source, destination, 'b', 2);
    expect(orderAfter([...destination.rows, { id: 'b', position: 1 }], plan, 'cat-2')).toEqual([
      'x',
      'y',
      'b',
    ]);
  });

  it('clamps an index past that last slot to the end of the destination', () => {
    const plan = planItemMove(source, destination, 'b', 99);
    expect(orderAfter([...destination.rows, { id: 'b', position: 1 }], plan, 'cat-2')).toEqual([
      'x',
      'y',
      'b',
    ]);
  });

  it('pushes every existing destination row down when the drop is at index 0', () => {
    const plan = planItemMove(source, destination, 'b', 0);

    expect(updatesFor(plan, 'cat-2')).toEqual([
      { id: 'b', position: 0 },
      { id: 'x', position: 1 },
      { id: 'y', position: 2 },
    ]);
  });

  it('lands at position 0 in an empty destination category', () => {
    const plan = planItemMove(source, run('cat-2', []), 'c', 0);
    expect(updatesFor(plan, 'cat-2')).toEqual([{ id: 'c', position: 0 }]);
  });

  // Two runs that both claim the same row is a stale read on one of the two sides. Planning
  // it would assign that row two positions in one transaction and leave the outcome to
  // whichever pair the RPC applied last.
  it('throws when a row appears in both the source and the destination run', () => {
    const overlapping = run('cat-2', [
      ['b', 0],
      ['x', 1],
    ]);
    expect(() => planItemMove(source, overlapping, 'b', 0)).toThrow(/more than once/);
  });

  it('throws when the item is not in the source run, naming the run it was sought in', () => {
    expect(() => planItemMove(source, destination, 'x', 0)).toThrow(/not in the run of cat-1/);
  });

  it('throws on a non-finite index before touching either run', () => {
    expect(() => planItemMove(source, destination, 'b', Number.NaN)).toThrow(RangeError);
  });
});

/**
 * `check (position >= 0)` is on both columns
 * (`supabase/migrations/20260810120000_core_schema.sql:228` and `:268`), and a plan that
 * emitted a negative would not corrupt anything — it would fail the whole transaction at
 * the database, taking an ordinary drag down with it. The floor is structural here (every
 * position is an array index), which is exactly the kind of guarantee that survives right
 * up until someone edits the construction, so it is asserted rather than assumed.
 *
 * The inputs below are deliberately ILLEGAL AT REST: a negative stored position cannot be
 * written through the Data API. They are reachable anyway — a failed reindex that left a
 * temporary range behind is the case the migration's own comment names — and this module
 * is the thing that has to bring such a run back to something the constraint accepts.
 */
describe('no plan can produce a position the column would reject', () => {
  const messy: readonly (readonly [string, ReorderPlan])[] = [
    [
      'a category run carrying a negative position',
      planCategoryMove(
        run('pack-1', [
          ['a', -3],
          ['b', 0],
          ['c', 7],
        ]),
        'c',
        0,
      ),
    ],
    [
      'a category run where every position is the same',
      planCategoryMove(
        run('pack-1', [
          ['a', 0],
          ['b', 0],
          ['c', 0],
        ]),
        'a',
        2,
      ),
    ],
    [
      'a cross-category move out of a run with negative positions',
      planItemMove(
        run('cat-1', [
          ['a', -5],
          ['b', -1],
        ]),
        run('cat-2', [['x', -2]]),
        'a',
        0,
      ),
    ],
    [
      'a cross-category move into a run with duplicated positions',
      planItemMove(
        run('cat-1', [
          ['a', 4],
          ['b', 4],
        ]),
        run('cat-2', [
          ['x', 9],
          ['y', 9],
        ]),
        'b',
        1,
      ),
    ],
  ];

  it.each(messy)('emits only non-negative integer positions for %s', (_label, plan) => {
    const positions = allPositions(plan);
    expect(positions.length).toBeGreaterThan(0);
    for (const position of positions) {
      expect(Number.isInteger(position)).toBe(true);
      expect(position).toBeGreaterThanOrEqual(0);
    }
  });

  it('renumbers a run of identical positions into a dense 0..n-1 sequence', () => {
    const tied = run('pack-1', [
      ['a', 0],
      ['b', 0],
      ['c', 0],
    ]);
    const plan = planCategoryMove(tied, 'a', 2);

    // 'a' ordered first before the move (tie-break on id), so the resulting order is
    // b, c, a — and every row lands on its own integer rather than three rows sharing 0.
    expect(updatesFor(plan, 'pack-1')).toEqual([
      { id: 'c', position: 1 },
      { id: 'a', position: 2 },
    ]);
    expect(orderAfter(tied.rows, plan, 'pack-1')).toEqual(['b', 'c', 'a']);
  });
});
