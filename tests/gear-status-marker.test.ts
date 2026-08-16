import { describe, expect, it } from 'vitest';
import { gearStatusMarker, type GearStatusMarker } from '../src/lib/gear/format';
import {
  GEAR_LIST_COLUMNS,
  GEAR_SORT_COLUMNS,
  GEAR_SORT_KEYS,
  GEAR_STATUSES,
  checkedGearStatuses,
} from '../src/lib/gear/fields';

/**
 * PK-62's three page-level decisions, tested where they actually live.
 *
 * All three used to be written in `src/pages/gear/index.astro` frontmatter or in
 * `GearStatusIcon.astro`, and all three are named in the ticket's acceptance criteria —
 * which is the problem this file exists to close. `vitest.config.ts` excludes
 * `src/pages/**` from collection, and this repo has no harness for rendering an `.astro`
 * component in a test, so every one of them could have been inverted with a green suite:
 *
 *   - "a wishlist item shows a cart, a retired item shows a trash can, an owned item
 *     shows neither" -> `gearStatusMarker`
 *   - "unchecking every status shows the full closet, not an empty one" ->
 *     `checkedGearStatuses`
 *   - "the Brand column header becomes a sort link" -> `GEAR_LIST_COLUMNS`
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

describe('checkedGearStatuses', () => {
  it('ticks all three when nothing is selected — zero checked behaves as all three checked', () => {
    // The acceptance criterion itself: with no filter panel left to rescue a visitor
    // from, a closet showing nothing at all is a dead end.
    expect(checkedGearStatuses([])).toEqual(['owned', 'wishlist', 'retired']);
  });

  it('ticks exactly what was selected when something was', () => {
    expect(checkedGearStatuses(['wishlist'])).toEqual(['wishlist']);
    expect(checkedGearStatuses(['owned', 'retired'])).toEqual(['owned', 'retired']);
  });

  it('leaves an explicit all-three selection alone rather than round-tripping it to empty', () => {
    // "All three ticked" and "none ticked" produce the same ROW SET (parseGearQuery
    // applies no status filter for an empty list), but they are different URLs and this
    // function must not quietly rewrite one into the other — gearQueryToSearchParams
    // would then disagree with what the boxes show.
    expect(checkedGearStatuses(['owned', 'wishlist', 'retired'])).toEqual([
      'owned',
      'wishlist',
      'retired',
    ]);
  });

  it('is total over the status vocabulary — every status is tickable', () => {
    for (const status of GEAR_STATUSES) {
      expect(checkedGearStatuses([status])).toEqual([status]);
      expect(checkedGearStatuses([])).toContain(status);
    }
  });
});

describe('GEAR_LIST_COLUMNS', () => {
  it('offers Brand as a sort link — PK-62 acceptance', () => {
    // `tests/gear-closet.test.ts` proves sort=brand WORKS against the database. This
    // proves the header OFFERS it, which is a different claim and was the uncovered one.
    expect(GEAR_LIST_COLUMNS).toContainEqual({ key: 'brand', label: 'Brand' });
  });

  it('no longer carries a Status column', () => {
    expect(GEAR_LIST_COLUMNS.map((column) => column.label)).not.toContain('Status');
  });

  it('renders Name and Brand as the two leading sortable headers, in that order', () => {
    expect(GEAR_LIST_COLUMNS.slice(0, 2)).toEqual([
      { key: 'name', label: 'Name' },
      { key: 'brand', label: 'Brand' },
    ]);
  });

  it('leaves Category and Qty unsortable — neither has a sort key to link to', () => {
    const unsortable = GEAR_LIST_COLUMNS.filter((column) => column.key === null);
    expect(unsortable.map((column) => column.label)).toEqual(['Category', 'Qty']);
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
