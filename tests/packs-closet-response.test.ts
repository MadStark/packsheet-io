import { describe, expect, it } from 'vitest';
import {
  CLOSET_LOAD_FAILED_MESSAGE,
  closetItemPayload,
  closetPagePayload,
  closetTotalPages,
  type ClosetSourceItem,
} from '../src/lib/packs/closet-response';
import { GEAR_PAGE_SIZE } from '../src/lib/gear/fields';

/**
 * `src/lib/packs/closet-response.ts` — the wire shape of the add-to-pack dialog's closet
 * page (PK-74). `vitest.config.ts:64` excludes `src/pages/**`, so what the endpoint
 * actually answers with is pinned here rather than in `src/pages/packs/closet.ts` itself.
 */

const STOVE: ClosetSourceItem = {
  id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
  name: 'Titanium stove',
  brand: 'Snow Peak',
  weight_grams: 85,
};

const UNBRANDED: ClosetSourceItem = {
  id: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
  name: 'Generic tent stake',
  brand: null,
  weight_grams: 12.5,
};

describe('closetItemPayload', () => {
  it('carries weight across as a raw number of grams, not a formatted string', () => {
    const payload = closetItemPayload(STOVE);
    expect(payload.weightGrams).toBe(85);
    expect(typeof payload.weightGrams).toBe('number');
  });

  it('reshapes the wire field names without renaming or dropping id/name/brand', () => {
    expect(closetItemPayload(STOVE)).toEqual({
      id: STOVE.id,
      name: STOVE.name,
      brand: STOVE.brand,
      weightGrams: STOVE.weight_grams,
    });
  });

  it('carries a null brand through as null, not the empty string or a placeholder', () => {
    expect(closetItemPayload(UNBRANDED).brand).toBeNull();
  });
});

describe('closetTotalPages', () => {
  it('reports one page for an empty closet, never zero pages', () => {
    // Zero pages would leave a pager with nothing to point at even though "page 1 of an
    // empty list" is the honest description of the state.
    expect(closetTotalPages(0)).toBe(1);
  });

  it('reports exactly one page when the count exactly fills it', () => {
    expect(closetTotalPages(GEAR_PAGE_SIZE)).toBe(1);
  });

  it('rounds up rather than truncating a partially-filled final page', () => {
    expect(closetTotalPages(GEAR_PAGE_SIZE + 1)).toBe(2);
  });
});

describe('closetPagePayload', () => {
  it('builds the full success envelope from loadGearCloset-shaped inputs', () => {
    const payload = closetPagePayload([STOVE, UNBRANDED], 1, 2);

    expect(payload).toEqual({
      ok: true,
      items: [closetItemPayload(STOVE), closetItemPayload(UNBRANDED)],
      page: 1,
      totalPages: 1,
      totalCount: 2,
    });
  });

  // THE C2 CLAMP CASE (see loadGearCloset's own comment in src/lib/gear/query.ts): the
  // `page` this function reports is whatever loadGearCloset actually queried, which can
  // differ from what a stale `?page=` asked for. This module must render the page it was
  // GIVEN, not recompute one of its own from totalCount.
  it('carries the caller-supplied page through unchanged, even if it looks out of range', () => {
    const payload = closetPagePayload([], 1, 0);
    expect(payload.page).toBe(1);
    expect(payload.totalPages).toBe(1);
  });

  it('answers an empty items array for a closet with no matching rows, not an error', () => {
    const payload = closetPagePayload([], 1, 0);
    expect(payload.ok).toBe(true);
    expect(payload.items).toEqual([]);
  });

  it('derives totalPages from totalCount rather than from items.length', () => {
    // A single fetched page is at most GEAR_PAGE_SIZE items long, but totalCount describes
    // the whole closet — the two must not be conflated, or a closet of 120 items would
    // report "1 page" from a 50-item page slice.
    const onePage = new Array(GEAR_PAGE_SIZE).fill(STOVE);
    const payload = closetPagePayload(onePage, 1, GEAR_PAGE_SIZE * 3);
    expect(payload.items).toHaveLength(GEAR_PAGE_SIZE);
    expect(payload.totalPages).toBe(3);
  });
});

describe('CLOSET_LOAD_FAILED_MESSAGE', () => {
  // The house rule ("NEVER A RAW POSTGRES OR POSTGREST STRING", src/lib/packs/form.ts):
  // this is what a visitor sees instead of a PostgrestError's own .message, so it must
  // read as a complete, neutral sentence rather than as a fragment or an internal name.
  it('is a complete sentence naming no internal detail', () => {
    expect(CLOSET_LOAD_FAILED_MESSAGE.endsWith('.')).toBe(true);
    expect(CLOSET_LOAD_FAILED_MESSAGE.toLowerCase()).not.toMatch(/postgres|sql|constraint|rls/);
  });
});
