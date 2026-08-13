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
  it('is a full sentence, not a repeat of the short GEAR_STATUS_LABELS text', () => {
    for (const status of GEAR_STATUSES) {
      expect(GEAR_STATUS_MEANINGS[status]).not.toBe(GEAR_STATUS_LABELS[status]);
      expect(GEAR_STATUS_MEANINGS[status].length).toBeGreaterThan(
        GEAR_STATUS_LABELS[status].length,
      );
    }
  });
});
