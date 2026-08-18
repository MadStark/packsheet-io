import { describe, expect, it } from 'vitest';
import {
  PACK_EDITOR_FIELD,
  categoryAppendPosition,
  hasPackCategory,
  itemAppendPosition,
  parseEntityId,
  parseGearItemIds,
  type EditorPackRows,
} from '../src/lib/packs/editor';

/**
 * `src/lib/packs/editor.ts` — the pack editor's two page-level decisions, tested where they
 * live rather than where they are used.
 *
 * Both would otherwise sit in `src/pages/packs/[id].astro`, which `vitest.config.ts:64`
 * excludes from collection, and both fail SILENTLY when they are wrong: an append position
 * computed as 0 puts every new row at the top of its run without erroring, and an unchecked
 * category id produces a write that affects nothing and reports nothing. PK-4's review
 * demonstrated that page frontmatter is where mutants survive; this file is the reason
 * these two do not live there.
 */

const CATEGORY_A = '22222222-2222-4222-8222-222222222222';
const CATEGORY_B = '33333333-3333-4333-8333-333333333333';
const GEAR_1 = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const GEAR_2 = 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa';
const UNKNOWN = '99999999-9999-4999-8999-999999999999';

const PACK: EditorPackRows = {
  pack_categories: [
    { id: CATEGORY_A, pack_items: [{}, {}, {}] },
    { id: CATEGORY_B, pack_items: [] },
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
});

describe('itemAppendPosition', () => {
  it('puts a new item after the ones already in its category', () => {
    expect(itemAppendPosition(PACK, CATEGORY_A)).toBe(3);
  });

  it('puts the first item of an empty category at zero', () => {
    expect(itemAppendPosition(PACK, CATEGORY_B)).toBe(0);
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
