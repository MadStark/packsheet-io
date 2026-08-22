import { describe, expect, it } from 'vitest';
import { gearStatusMarker, type GearStatusMarker } from '../src/lib/gear/format';
import {
  GEAR_LIST_COLUMNS,
  GEAR_SORT_COLUMNS,
  GEAR_SORT_KEYS,
  GEAR_STATUSES,
  effectiveGearStatuses,
} from '../src/lib/gear/fields';

/**
 * PK-62's three page-level decisions, plus PK-70's two, tested where they actually live.
 *
 * All five used to be (or, for the PK-70 pair, would naturally have been) written in
 * `src/pages/gear/index.astro` frontmatter or in `GearStatusIcon.astro`, and each is named
 * in its own ticket's acceptance criteria — which is the problem this file exists to
 * close. `vitest.config.ts` excludes `src/pages/**` from collection, and this repo has no
 * harness for rendering an `.astro` component in a test, so every one of them could have
 * been inverted with a green suite:
 *
 *   - "a wishlist item shows a cart, a retired item shows a trash can, an owned item
 *     shows neither" -> `gearStatusMarker`
 *   - "unchecking every status shows the full closet, not an empty one" (PK-62) ->
 *     `effectiveGearStatuses`
 *   - "the Brand column header becomes a sort link" (PK-62) -> `GEAR_LIST_COLUMNS`
 *   - "a fresh, unfiltered closet shows owned and wishlist gear but not retired gear"
 *     (PK-70) -> `effectiveGearStatuses`
 *   - "the Category column header becomes a sort link" (PK-70) -> `GEAR_LIST_COLUMNS`
 *
 * The SVG path data is deliberately not tested. It is not logic, and an assertion on it
 * would only ever fail when somebody intentionally redrew an icon.
 */

describe('gearStatusMarker', () => {
  it('gives wishlist its own marker', () => {
    expect(gearStatusMarker('wishlist')).toBe('wishlist');
  });

  it('gives retired its own marker', () => {
    expect(gearStatusMarker('retired')).toBe('retired');
  });

  it('marks owned with nothing at all — it is the unmarked default', () => {
    expect(gearStatusMarker('owned')).toBeNull();
  });

  it('marks an unrecognised status with nothing, rather than throwing or inventing a glyph', () => {
    // Reachable for a row written directly against PostgREST, past the CHECK constraint
    // this product's own write path respects. The closet list pairs this null with a
    // screen-reader-only rendering of the raw value, because after PK-62 removed the
    // Status column there is otherwise nowhere an ACTIVE row's malformed status shows.
    expect(gearStatusMarker('in-use')).toBeNull();
    expect(gearStatusMarker('')).toBeNull();
    expect(gearStatusMarker('Wishlist')).toBeNull(); // case-sensitive, like isGearStatus
  });

  it('marks exactly the two non-owned statuses, so a fourth status cannot slip through unnoticed', () => {
    // The map behind this is Record<GearStatus, ...>, so a new status is a compile error
    // rather than a row that silently renders nothing. This asserts the runtime side of
    // the same claim: every status either has a marker or is explicitly unmarked.
    const marked = GEAR_STATUSES.filter((status) => gearStatusMarker(status) !== null);
    expect(marked).toEqual(['wishlist', 'retired']);
  });

  it('never returns a marker that is not one of the two the icon can draw', () => {
    const drawable: readonly (GearStatusMarker | null)[] = ['wishlist', 'retired', null];
    for (const status of GEAR_STATUSES) {
      expect(drawable).toContain(gearStatusMarker(status));
    }
  });
});

describe('effectiveGearStatuses', () => {
  // PK-70: an empty selection used to mean "all three statuses, retired included" — see
  // fields.ts's own "A NOTE FOR THE NEXT READER WHO DIFFS THIS AGAINST PK-62'S TICKET"
  // for the full history. It now means GEAR_DEFAULT_STATUSES, owned and wishlist, with
  // retired specifically excluded until the visitor asks for it. This block replaces the
  // PK-62 assertions that pinned the OLD answer — an unmodified copy of them would now be
  // asserting the exact wrong thing rather than merely an outdated one.
  it('resolves an empty selection to owned and wishlist — retired is NOT included by default', () => {
    expect(effectiveGearStatuses([])).toEqual(['owned', 'wishlist']);
    expect(effectiveGearStatuses([])).not.toContain('retired');
  });

  it('leaves an explicit selection untouched, whatever it is', () => {
    expect(effectiveGearStatuses(['wishlist'])).toEqual(['wishlist']);
    expect(effectiveGearStatuses(['owned', 'retired'])).toEqual(['owned', 'retired']);
    // An explicit request for retired alone is honoured exactly as asked — this is the
    // other half of PK-70's acceptance criteria: retired gear is not gone, only no
    // longer the default.
    expect(effectiveGearStatuses(['retired'])).toEqual(['retired']);
  });

  it('leaves an explicit all-three selection alone rather than round-tripping it to empty', () => {
    // "All three, explicitly" and "none ticked" produce DIFFERENT row sets since PK-70
    // (the latter drops retired), so this function must not conflate them — an explicit
    // all-three selection is returned exactly as given, not collapsed to the default.
    expect(effectiveGearStatuses(['owned', 'wishlist', 'retired'])).toEqual([
      'owned',
      'wishlist',
      'retired',
    ]);
  });

  it('is total over the status vocabulary — every status is selectable on its own', () => {
    for (const status of GEAR_STATUSES) {
      expect(effectiveGearStatuses([status])).toEqual([status]);
    }
  });

  it('never returns an empty array — there is always a default to fall back on', () => {
    // The surviving half of PK-62's rule: unticking every box must not produce an empty
    // closet. Before PK-70 that was guaranteed by falling back to all three; now it is
    // guaranteed by falling back to GEAR_DEFAULT_STATUSES, which is non-empty for the
    // same reason.
    expect(effectiveGearStatuses([]).length).toBeGreaterThan(0);
  });
});

describe('GEAR_LIST_COLUMNS', () => {
  it('offers Brand as a sort link — PK-62 acceptance', () => {
    // `tests/gear-closet.test.ts` proves sort=brand WORKS against the database. This
    // proves the header OFFERS it, which is a different claim and was the uncovered one.
    expect(GEAR_LIST_COLUMNS).toContainEqual({ key: 'brand', label: 'Brand', numeric: false });
  });

  it('offers Category as a sort link — PK-70 acceptance', () => {
    // Mirrors the Brand assertion above: `tests/gear-closet.test.ts` proves sort=category
    // WORKS against the database; this proves the header OFFERS it.
    expect(GEAR_LIST_COLUMNS).toContainEqual({
      key: 'category',
      label: 'Category',
      numeric: false,
    });
  });

  it('no longer carries a Status column', () => {
    expect(GEAR_LIST_COLUMNS.map((column) => column.label)).not.toContain('Status');
  });

  it('renders Name and Brand as the two leading sortable headers, in that order', () => {
    expect(GEAR_LIST_COLUMNS.slice(0, 2)).toEqual([
      { key: 'name', label: 'Name', numeric: false },
      { key: 'brand', label: 'Brand', numeric: false },
    ]);
  });

  it('lists exactly the six columns the closet renders, in order', () => {
    // THE WHOLE LIST, pinned. Every other assertion in this block checks one column or
    // one property, so adding or removing a column changes a user-visible part of the
    // product without any of them noticing — which is exactly what PK-64 did when it
    // dropped Added. A column change should have to be a deliberate edit to this line.
    //
    // It also guards the coupling this constant's own comment warns about and cannot
    // enforce: the `<tbody>` cells in src/pages/gear/index.astro are a separate,
    // hand-maintained list in the same order, and a header added here without its
    // matching `<td>` there silently misaligns every row after it.
    expect(GEAR_LIST_COLUMNS.map((column) => column.label)).toEqual([
      'Name',
      'Brand',
      'Category',
      'Qty',
      'Weight',
      'Price',
    ]);
  });

  it('marks exactly the figure columns numeric', () => {
    // The alignment decision lives beside the column rather than being derived from its
    // label. PK-64 first wrote it as `label === 'Qty' || ...` on the page, where renaming
    // a column would compile, ship, and quietly lose the right-align.
    const numeric = GEAR_LIST_COLUMNS.filter((column) => column.numeric).map((c) => c.label);
    expect(numeric).toEqual(['Qty', 'Weight', 'Price']);
  });

  it('keeps ?sort=added working even though no header offers it any more', () => {
    // PK-64 removed the Added COLUMN, not the sort key: `?sort=added` is a bookmarkable
    // URL and still orders by acquired_on, exactly as PK-62 kept working the filters
    // whose UI it removed. Nothing else asserts this, and the asymmetry is invisible —
    // the list can be sorted by something the page no longer names.
    expect(GEAR_SORT_KEYS).toContain('added');
    expect(GEAR_SORT_COLUMNS.added).toBe('acquired_on');
    expect(GEAR_LIST_COLUMNS.map((column) => column.key)).not.toContain('added');
  });

  it('leaves only Qty unsortable — Category (PK-70) has its own sort key now', () => {
    // Before PK-70 this pinned ['Category', 'Qty']: Category had no sort key of its own,
    // the same as Qty still does not. Reverting `GEAR_LIST_COLUMNS`' Category entry back
    // to `key: null` — the exact regression this test exists to catch — would make this
    // fail rather than silently pass.
    const unsortable = GEAR_LIST_COLUMNS.filter((column) => column.key === null);
    expect(unsortable.map((column) => column.label)).toEqual(['Qty']);
  });

  it('never names a sort key the query layer cannot order by, and never twice', () => {
    const keys = GEAR_LIST_COLUMNS.map((column) => column.key).filter((key) => key !== null);
    for (const key of keys) {
      // Every sortable header must name a key `parseGearQuery` accepts and
      // `GEAR_SORT_COLUMNS` maps — otherwise the link renders and does nothing.
      expect(GEAR_SORT_KEYS).toContain(key);
      expect(GEAR_SORT_COLUMNS[key]).toBeTruthy();
    }
    expect(new Set(keys).size).toBe(keys.length); // no column sorts by the same key twice
  });
});
