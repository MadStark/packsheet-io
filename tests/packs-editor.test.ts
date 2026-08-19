import { describe, expect, it } from 'vitest';
import {
  PACK_EDITOR_FIELD,
  PACK_INTENT,
  categoryAppendPosition,
  hasPackCategory,
  hasPackItem,
  itemAppendPosition,
  parseEntityId,
  parseGearItemIds,
  type EditorPackRows,
} from '../src/lib/packs/editor';

/**
 * `src/lib/packs/editor.ts` — the pack editor's page-level decisions, tested where they live
 * rather than where they are used.
 *
 * Every one of them would otherwise sit in `src/pages/packs/[id].astro`, which
 * `vitest.config.ts:64` excludes from collection, and every one of them fails SILENTLY when
 * it is wrong: an append position one short of the end puts a new row above a row already
 * there without erroring, and an unchecked category or item id produces a write that affects
 * nothing — or, worse, affects the right row of the wrong pack. PK-4's review demonstrated
 * that page frontmatter is where mutants survive; this file is the reason these do not live
 * there.
 */

const CATEGORY_A = '22222222-2222-4222-8222-222222222222';
const CATEGORY_B = '33333333-3333-4333-8333-333333333333';
const GEAR_1 = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const GEAR_2 = 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa';
const ITEM_1 = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const ITEM_2 = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const ITEM_3 = 'bbbbbbbb-3333-4333-8333-bbbbbbbbbbbb';
const UNKNOWN = '99999999-9999-4999-8999-999999999999';

/** A pack whose runs are DENSE — positions 0..n-1 on both levels, which is what a pack
 *  looks like after any drag (`denseUpdates` in `src/lib/packs/reorder.ts` reindexes every
 *  run it touches). The gapped fixtures below are the other, equally ordinary, half. */
const PACK: EditorPackRows = {
  pack_categories: [
    {
      id: CATEGORY_A,
      position: 0,
      pack_items: [
        { id: ITEM_1, position: 0 },
        { id: ITEM_2, position: 1 },
        { id: ITEM_3, position: 2 },
      ],
    },
    { id: CATEGORY_B, position: 1, pack_items: [] },
  ],
};

describe('parseEntityId', () => {
  it('reads a uuid', () => {
    expect(parseEntityId(CATEGORY_A)).toBe(CATEGORY_A);
  });

  it('trims and lower-cases, so one id has one spelling', () => {
    expect(parseEntityId(`  ${CATEGORY_A.toUpperCase()}  `)).toBe(CATEGORY_A);
  });

  it.each([
    ['null', null],
    ['an empty string', ''],
    ['a number-ish string', '1'],
    ['an injection attempt', "1' OR '1'='1"],
    ['a nearly-uuid', `${CATEGORY_A}0`],
  ])('refuses %s', (_label, value) => {
    expect(parseEntityId(value)).toBeNull();
  });

  /**
   * A multipart POST can send a `File` under any name it likes, including a hidden field's.
   * The natural `value?.toString().trim()` spelling would turn that into a 500 rather than
   * a refusal — the same reasoning `confirmsGearDeletion` records for its own parameter
   * type, and the reason this takes `FormDataEntryValue | null` rather than `string | null`.
   */
  it('refuses a File without throwing', () => {
    expect(parseEntityId(new File(['x'], 'category.txt'))).toBeNull();
  });
});

describe('parseGearItemIds', () => {
  it('reads every ticked closet row, in submission order', () => {
    expect(parseGearItemIds([GEAR_1, GEAR_2])).toEqual([GEAR_1, GEAR_2]);
  });

  /**
   * THE ACCEPTANCE CRITERION THIS FILE EXISTS TO PIN. The same gear item may appear in a
   * pack more than once — two of the same stuff sack, a spare carried both worn and packed,
   * one fuel canister listed for two legs — and nothing may prevent it. `parseIds` in
   * `src/lib/gear/bulk.ts`, which this otherwise mirrors, DOES de-duplicate, so copying that
   * function across would have silently collapsed a deliberate repeat.
   */
  it('keeps repeats, because the same gear may be added to a pack twice', () => {
    expect(parseGearItemIds([GEAR_1, GEAR_1, GEAR_2, GEAR_1])).toEqual([
      GEAR_1,
      GEAR_1,
      GEAR_2,
      GEAR_1,
    ]);
  });

  it('drops malformed entries silently rather than reporting them', () => {
    // A checkbox list is not something a visitor typed into, so a bad value is a crafted
    // request or a client bug — not an error to put in front of somebody.
    expect(parseGearItemIds(['', 'not-an-id', GEAR_1, new File(['x'], 'g.txt')])).toEqual([GEAR_1]);
  });

  it('answers an empty selection with an empty list', () => {
    expect(parseGearItemIds([])).toEqual([]);
  });
});

describe('hasPackCategory', () => {
  it('recognises a category of this pack', () => {
    expect(hasPackCategory(PACK, CATEGORY_B)).toBe(true);
  });

  it('refuses one that is not, including a well-formed id from another pack', () => {
    expect(hasPackCategory(PACK, UNKNOWN)).toBe(false);
  });

  it('refuses everything for a pack with no categories', () => {
    expect(hasPackCategory({ pack_categories: [] }, CATEGORY_A)).toBe(false);
  });
});

/**
 * THE ITEM-LEVEL COUNTERPART, AND THE ONE THE EDITOR WAS MISSING (independent review, B3).
 *
 * `src/pages/packs/[id].astro`'s `save-item` and `remove-item` branches checked only that
 * `item_id` parsed as a UUID, so `ITEM_MISSING_MESSAGE` ("That item is no longer in this
 * pack") could fire for a malformed id and never once for the condition it names. The gap
 * that leaves is not blocked by anything downstream: an id naming an item of ANOTHER pack
 * of the SAME visitor passes `pack_items_update_own` and `pack_items_delete_own` outright —
 * both ask for `user_id = (select auth.uid())` and an unlocked parent, neither of which can
 * tell one of this visitor's packs from another — so the write lands on the wrong pack and
 * the editor redirects as though it had saved.
 */
describe('hasPackItem', () => {
  it('recognises an item of this pack, whichever category holds it', () => {
    expect(hasPackItem(PACK, ITEM_1)).toBe(true);
    expect(hasPackItem(PACK, ITEM_3)).toBe(true);
  });

  it('refuses a well-formed id that names an item of another pack', () => {
    expect(hasPackItem(PACK, UNKNOWN)).toBe(false);
  });

  // Two shapes of "this pack holds nothing": no categories at all, and categories that are
  // all empty. Both are ordinary states of a pack somebody just started, and neither may
  // answer true for an id that came in on a form.
  it('refuses everything for a pack with no items', () => {
    expect(hasPackItem({ pack_categories: [] }, ITEM_1)).toBe(false);
    expect(
      hasPackItem({ pack_categories: [{ id: CATEGORY_A, position: 0, pack_items: [] }] }, ITEM_1),
    ).toBe(false);
  });

  // A category id is not an item id, and the two arrive on the same POST under different
  // hidden field names. Crossing them would make `remove-item` delete against an id the
  // pack does hold — just not as an item.
  it('does not accept a category id of this pack', () => {
    expect(hasPackItem(PACK, CATEGORY_A)).toBe(false);
  });
});

/**
 * THE APPEND POSITIONS, AND THE BUG THEY CARRIED (independent review, B1).
 *
 * Both were `rows.length`, which is right only while a run is dense. Nothing renumbers a
 * run after a delete — `deletePackCategory`/`deletePackItem` are one statement against one
 * row, and no trigger in the core schema touches the siblings — so gaps are what ordinary
 * use produces, and a count is then strictly less than `max(position) + 1`. The failure is
 * SILENT: `position` is `check (position >= 0)` and not unique, so the too-low number is
 * accepted and the new row simply renders above rows it was meant to follow.
 */
describe('categoryAppendPosition', () => {
  it('puts a new category after the ones already there', () => {
    expect(categoryAppendPosition(PACK)).toBe(2);
  });

  // A pack with no categories is a valid, ordinary state — the editor renders it as an
  // empty state rather than an error — so the first category has to be position 0 and not
  // an off-by-one away from it.
  it('puts the first category of an empty pack at zero', () => {
    expect(categoryAppendPosition({ pack_categories: [] })).toBe(0);
  });

  /**
   * THE REPRO, EXACTLY AS THE REVIEW STATED IT. Three categories at 0, 1, 2; delete the
   * first two; one survivor sits at position 2. A count answers 1 — BELOW the row that is
   * still there — and `loadPackForEdit`'s `order(position).order(id)` then renders the new
   * category at the TOP of the pack.
   */
  it('appends past a gap left by deleting the rows in front', () => {
    const gapped: EditorPackRows = {
      pack_categories: [{ id: CATEGORY_A, position: 2, pack_items: [] }],
    };

    expect(categoryAppendPosition(gapped)).toBe(3);
  });

  // Duplicates are legal (core_schema.sql:228, "Deliberately NOT unique") and are the case
  // the old comment argued for the count on. Deriving from the maximum does not lose it:
  // 1 is still past all three, so the new row is still last in reading order.
  it('appends past a run whose rows all share one position', () => {
    const tied: EditorPackRows = {
      pack_categories: [
        { id: CATEGORY_A, position: 0, pack_items: [] },
        { id: CATEGORY_B, position: 0, pack_items: [] },
      ],
    };

    expect(categoryAppendPosition(tied)).toBe(1);
  });
});

describe('itemAppendPosition', () => {
  it('puts a new item after the ones already in its category', () => {
    expect(itemAppendPosition(PACK, CATEGORY_A)).toBe(3);
  });

  it('puts the first item of an empty category at zero', () => {
    expect(itemAppendPosition(PACK, CATEGORY_B)).toBe(0);
  });

  /**
   * The same defect one level down, and the one that shows up faster in real use: removing
   * an item is a single click on this editor with no confirmation step, so a category that
   * has had rows removed is the common case rather than the odd one.
   */
  it('appends past a gap left by removing items in front', () => {
    const gapped: EditorPackRows = {
      pack_categories: [
        {
          id: CATEGORY_A,
          position: 0,
          // Positions 0..4 with 0, 1 and 3 removed: two rows left, holding 2 and 4.
          pack_items: [
            { id: ITEM_1, position: 2 },
            { id: ITEM_2, position: 4 },
          ],
        },
      ],
    };

    // A count would answer 2, which is where ITEM_1 already sits.
    expect(itemAppendPosition(gapped, CATEGORY_A)).toBe(5);
  });

  it('answers zero for an empty category however gapped its siblings are', () => {
    const gapped: EditorPackRows = {
      pack_categories: [
        { id: CATEGORY_A, position: 7, pack_items: [{ id: ITEM_1, position: 9 }] },
        { id: CATEGORY_B, position: 8, pack_items: [] },
      ],
    };

    // Each category is its own run: the gaps in A say nothing about where B's first item
    // goes, and reading the pack's positions instead of the category's would put it at 10.
    expect(itemAppendPosition(gapped, CATEGORY_B)).toBe(0);
  });

  /**
   * The null is a REFUSAL, not a default, and telling the two apart is the whole reason
   * this returns `number | null`: an unknown category answered with `0` would write a row
   * at the top of some other run, or fail on a foreign key with nothing to say to the
   * visitor. `0` is also a legitimate answer for an empty category, which is exactly why a
   * falsy check here would be a bug — asserted immediately above.
   */
  it('refuses a category that is not in this pack rather than defaulting to zero', () => {
    expect(itemAppendPosition(PACK, UNKNOWN)).toBeNull();
  });
});

describe('PACK_EDITOR_FIELD', () => {
  // The markup and the parser must not be able to disagree about what a field is called,
  // which is only true while both read these names. Pinned because a rename here is
  // invisible: a hidden field the page still spells the old way parses as "no id", and the
  // editor starts reporting "that category is no longer in this pack" for every rename.
  it('names the three row-identifying fields the editor posts', () => {
    expect(PACK_EDITOR_FIELD).toEqual({
      categoryId: 'category_id',
      itemId: 'item_id',
      gearItemId: 'gear_item_id',
    });
  });
});

describe('PACK_INTENT', () => {
  /**
   * Pinned for the same reason as the field names, and with one more edge to it: these
   * strings are now WRITTEN in two files — `src/pages/packs/[id].astro`, which handles them,
   * and `src/components/PackContents.vue`, which renders the per-row forms that carry them —
   * and READ in one. A value that changes on one side only does not error: the handler's
   * final `else` catches it and the visitor is told "something went wrong saving that
   * change" about a form that looks perfectly ordinary. Both sides importing this object is
   * what makes that impossible, and this test is what stops the object itself from being
   * quietly re-spelled.
   */
  it('names the ten intents the pack editor posts', () => {
    expect(PACK_INTENT).toEqual({
      savePack: 'save-pack',
      duplicatePack: 'duplicate-pack',
      deletePack: 'delete-pack',
      createCategory: 'create-category',
      renameCategory: 'rename-category',
      deleteCategory: 'delete-category',
      addGear: 'add-gear',
      addCustomItem: 'add-custom-item',
      saveItem: 'save-item',
      removeItem: 'remove-item',
    });
  });

  // Ten forms, ten intents, told apart by this field alone. Two branches sharing a value is
  // not a compile error and not a runtime one either: the first `else if` to match wins, and
  // the other form silently does the first one's work.
  it('gives every intent a value of its own', () => {
    const values = Object.values(PACK_INTENT);
    expect(new Set(values).size).toBe(values.length);
  });
});
