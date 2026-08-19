import { describe, expect, it } from 'vitest';
import {
  WEIGHT_BUCKETS,
  computeTotals,
  type PackTreeItem,
  type PackTreePack,
  type WeightBucket,
} from '../src/lib/totals';

/**
 * A REGRESSION GUARD AGAINST A SPECIFIC, NAMED, NINE-YEAR-OLD DEFECT — not an arbitrary
 * arithmetic test. Nothing below is here to check that multiplication works.
 *
 * ---------------------------------------------------------------------------
 * THE BUG, IN ITS ORIGINAL FORM
 * ---------------------------------------------------------------------------
 *
 * LighterPack — the tool this product exists to replace — computes its worn-weight
 * subtotal like this, in `client/dataTypes.js`:
 *
 *     this.subtotalWornWeight += item.weight * ((categoryItem.qty > 0) ? 1 : 0);
 *
 * Read the multiplier carefully, because it is easy to skim as if it were `qty`. It is
 * not: it collapses ANY positive quantity to exactly 1. Two pairs of wool socks marked
 * worn contribute the weight of one pair. Three worn items contribute one. The base and
 * consumable subtotals on the same object multiply by quantity properly, so the defect
 * shows up only on the worn line — and only when a worn item has a quantity above 1,
 * which is a minority of rows in a minority of packs, which is exactly why it survived.
 *
 * It was reported in 2017 as issues #74 and #211 against lighterpack, and was still
 * unfixed in August 2026.
 *
 * BOTH OF THOSE ARE AS-OF CLAIMS, and the date is here so a later reader can judge them
 * rather than inherit them. The line quoted above was read from `client/dataTypes.js` in
 * the upstream lighterpack repository as it stood in August 2026, when this file was
 * written, and nothing in this suite re-checks either the line or the issues: a test that
 * depended on a third party's repository staying still would be a test that went red for
 * somebody else's reasons. What IS pinned below is this engine's behaviour, which is the
 * part we control.
 *
 * The user-visible symptoms are two:
 *
 *   - The worn subtotal is too small, by the weight of every extra worn unit.
 *   - Ticking "worn" on a multi-quantity item CHANGES the pack's overall weight. Base
 *     weight is derived by subtracting the worn and consumable subtotals from the whole,
 *     so an under-counted worn subtotal leaves the difference stranded in base and the
 *     three no longer partition the total. A user reconciling a spreadsheet against the
 *     tool finds a discrepancy with no visible cause.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS LIVES IN ITS OWN FILE
 * ---------------------------------------------------------------------------
 *
 * This is a stated acceptance criterion of the ticket, and a criterion that is one case
 * inside a forty-case general suite is a criterion that gets rewritten during an unrelated
 * refactor by someone who has never heard of issue #74. A whole file named after the
 * defect cannot be deleted by accident, and its name is a question anybody removing it
 * has to answer.
 *
 * Every case below uses a quantity greater than one and a weight where the correct answer
 * and LighterPack's answer are different numbers — so removing the quantity multiplier
 * from `computeItemTotals` in src/lib/totals.ts turns this file red rather than leaving it
 * green with fewer decimal places. `LIGHTERPACK_WORN` spells out what that formula would
 * have produced, and is asserted against explicitly rather than left implicit in the
 * arithmetic.
 */

const WORN_UNIT_GRAMS = 90;
const WORN_QUANTITY = 2;

/** What this engine must produce: quantity counts, in the worn bucket like every other. */
const CORRECT_WORN = WORN_UNIT_GRAMS * WORN_QUANTITY;

/** What `item.weight * ((qty > 0) ? 1 : 0)` produces for the same row. */
const LIGHTERPACK_WORN = WORN_UNIT_GRAMS;

function packItem(overrides: Partial<PackTreeItem> = {}): PackTreeItem {
  return {
    id: 'item-1',
    quantity: 1,
    worn: false,
    consumable: false,
    packed: false,
    overrides: {},
    gear_items: {
      name: 'Wool socks',
      weight_grams: WORN_UNIT_GRAMS,
      // Stated as an explicit null pair because the type requires it: an unpriced gear
      // row says so rather than leaving the fields out. Nothing in this file reads them.
      price: null,
      currency: null,
    },
    ...overrides,
  };
}

function pack(items: readonly PackTreeItem[]): PackTreePack {
  return { pack_categories: [{ id: 'category-1', name: 'Worn', pack_items: items }] };
}

/** The three flag combinations, so each bucket is exercised by the same quantity rule. */
const flagsFor: Readonly<Record<WeightBucket, Partial<PackTreeItem>>> = {
  base: { worn: false, consumable: false },
  worn: { worn: true, consumable: false },
  consumable: { worn: false, consumable: true },
};

describe('worn weight multiplies by quantity (lighterpack issues #74 and #211)', () => {
  it('counts two worn pairs of socks as two pairs, not one', () => {
    const totals = computeTotals(pack([packItem({ worn: true, quantity: WORN_QUANTITY })]));

    expect(totals.worn).toBe(CORRECT_WORN);

    // The same assertion said the other way round. If somebody reintroduces the
    // `(qty > 0) ? 1 : 0` multiplier — or "simplifies" the worn branch to skip the
    // multiplication because worn items are "usually one of a kind" — this is the line
    // that names what went wrong rather than reporting an unexplained 90 vs 180.
    expect(totals.worn).not.toBe(LIGHTERPACK_WORN);
  });

  // The defect is bucket-specific, so the fix has to be bucket-INDEPENDENT: the same
  // quantity multiplier, applied with no branch on which bucket an item is in. A table
  // over all three is the only way to state that, and the worn row is the one that would
  // have been red in LighterPack while the other two passed.
  it.each(WEIGHT_BUCKETS)('multiplies by quantity in the %s bucket', (bucket) => {
    const quantity = 3;
    const totals = computeTotals(pack([packItem({ ...flagsFor[bucket], quantity })]));

    expect(totals[bucket]).toBe(WORN_UNIT_GRAMS * quantity);
    // And the other two buckets are untouched, so a bucket that quietly counted an item
    // twice — once in its own bucket and once in another — could not pass this.
    for (const other of WEIGHT_BUCKETS) {
      if (other !== bucket) expect(totals[other]).toBe(0);
    }
  });

  /**
   * The symptom a user actually reports, expressed directly: ticking "worn" must not
   * change how much the pack weighs. It only moves weight between buckets.
   *
   * This is the case that survives every other rule in the engine — the pack is
   * well-formed, the quantities are valid, the units agree, no override or snapshot is
   * involved — and is caught only by the quantity multiplier being present in the worn
   * bucket. Under LighterPack's formula the second total is 90 g lighter than the first
   * for no reason the user did anything to cause.
   */
  it('does not change the pack total when a multi-quantity item is marked worn', () => {
    const carried = computeTotals(pack([packItem({ quantity: WORN_QUANTITY, worn: false })]));
    const wornOnTheBody = computeTotals(pack([packItem({ quantity: WORN_QUANTITY, worn: true })]));

    expect(wornOnTheBody.total).toBe(carried.total);
    expect(carried.base).toBe(CORRECT_WORN);
    expect(wornOnTheBody.worn).toBe(CORRECT_WORN);
    expect(wornOnTheBody.base).toBe(0);
  });

  /**
   * And the partition itself, on a pack holding one multi-quantity item of each kind.
   * LighterPack derives base by subtraction, so an under-counted worn subtotal silently
   * inflates base and the identity below is precisely what breaks there. Here the three
   * are summed and the total is defined as their sum, so this cannot fail for a rounding
   * reason — only for a counting one.
   */
  it('keeps base + worn + consumable equal to the total with quantities above one', () => {
    const totals = computeTotals(
      pack([
        packItem({ id: 'base-item', quantity: 2, ...flagsFor.base }),
        packItem({ id: 'worn-item', quantity: 3, ...flagsFor.worn }),
        packItem({ id: 'consumable-item', quantity: 4, ...flagsFor.consumable }),
      ]),
    );

    expect(totals.base + totals.worn + totals.consumable).toBe(totals.total);
    expect(totals.total).toBe(WORN_UNIT_GRAMS * (2 + 3 + 4));
    expect(totals.worn).toBe(WORN_UNIT_GRAMS * 3);
  });

  /**
   * The count follows the same rule as the weight, and for the same reason: if quantity
   * counts for how heavy two pairs of socks are, it counts for how many socks there are.
   * A pack that says "180 g" and "1 item" in the same row has picked both answers.
   */
  it('counts the quantity of a worn item, not the row it sits on', () => {
    const totals = computeTotals(pack([packItem({ worn: true, quantity: WORN_QUANTITY })]));

    expect(totals.itemCount).toBe(WORN_QUANTITY);
  });
});
