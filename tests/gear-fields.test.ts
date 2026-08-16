import { describe, expect, it } from 'vitest';
import { GEAR_STATUSES, GEAR_STATUS_LABELS, GEAR_STATUS_MEANINGS } from '../src/lib/gear/fields';

/**
 * `src/lib/gear/fields.ts`'s status vocabulary is exercised indirectly all over the
 * suite — `tests/gear-query.test.ts` against `GEAR_STATUSES`, `tests/gear-format.test.ts`
 * against `GEAR_STATUS_LABELS` via `formatGearStatus` — but nothing pins the two
 * `Record<GearStatus, string>` maps directly against `GEAR_STATUSES` itself. This file is
 * that pin, and the one `GEAR_STATUS_MEANINGS` (PK-63) needed on arrival.
 */

describe('GEAR_STATUS_LABELS', () => {
  it('has a non-empty entry for every GEAR_STATUSES value', () => {
    for (const status of GEAR_STATUSES) {
      expect(GEAR_STATUS_LABELS[status]).toBeTruthy();
    }
  });
});

describe('GEAR_STATUS_MEANINGS', () => {
  it('has a non-empty entry for every GEAR_STATUSES value', () => {
    for (const status of GEAR_STATUSES) {
      expect(GEAR_STATUS_MEANINGS[status]).toBeTruthy();
    }
  });

  // Guards against a meaning silently regressing into a synonym for its own label — the
  // whole point of the tooltip is to add information the visible label does not already
  // carry (see this constant's own "NOT A SUBSTITUTE FOR GEAR_STATUS_LABELS" comment).
  // Asserted directly against what "a full sentence" actually means — ends with a full
  // stop, contains a space (so it is more than one word) — rather than a length
  // comparison against GEAR_STATUS_LABELS, which a short-but-still-a-sentence meaning
  // could fail even while being perfectly fine copy.
  it('is a full sentence, not a repeat of the short GEAR_STATUS_LABELS text', () => {
    for (const status of GEAR_STATUSES) {
      expect(GEAR_STATUS_MEANINGS[status]).not.toBe(GEAR_STATUS_LABELS[status]);
      expect(GEAR_STATUS_MEANINGS[status]).toMatch(/\.$/);
      expect(GEAR_STATUS_MEANINGS[status]).toContain(' ');
    }
  });

  // THE ASSERTION THAT MAKES THE THREE ABOVE MEAN SOMETHING. Every check in this file so
  // far is satisfied by setting all three meanings to the SAME sentence — each is
  // individually non-empty, individually unlike its own label, individually punctuated.
  // Three identical tooltips is also the most likely way this record actually breaks:
  // `Record<GearStatus, string>` forces whoever adds a fourth status to supply a value,
  // and the cheapest way to make the build go green is to paste a neighbour's. A tooltip
  // that describes the wrong status is worse than no tooltip, so distinctness is the
  // property worth pinning — the same argument applies to the labels, hence both.
  it('gives every status its own distinct meaning, not one sentence pasted three times', () => {
    const meanings = GEAR_STATUSES.map((status) => GEAR_STATUS_MEANINGS[status]);
    expect(new Set(meanings).size).toBe(GEAR_STATUSES.length);

    const labels = GEAR_STATUSES.map((status) => GEAR_STATUS_LABELS[status]);
    expect(new Set(labels).size).toBe(GEAR_STATUSES.length);
  });
});
