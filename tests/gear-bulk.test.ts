import { describe, expect, it } from 'vitest';
import {
  BULK_FORM_FIELD,
  BULK_INTENT,
  MAX_BULK_IDS,
  isBulkIntent,
  makeUndoToken,
  parseBulkAction,
  parseUndoToken,
} from '../src/lib/gear/bulk';

/**
 * `src/lib/gear/bulk.ts` is the pure validation layer PK-4's bulk actions and undo
 * token need precisely because `vitest.config.ts:64` excludes `src/pages/` — see that
 * module's own doc comment for the fuller argument, and `tests/gear-form.test.ts` for
 * the sibling suite covering the single-item form.
 *
 * Same care as the rest of this project's pure-function suites: every assertion below
 * names the bug it would catch, not merely what the code does.
 */

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const UUID_C = '33333333-3333-4333-8333-333333333333';

function formData(entries: [string, string][]): FormData {
  const form = new FormData();
  for (const [key, value] of entries) form.append(key, value);
  return form;
}

// ---------------------------------------------------------------------------
// isBulkIntent
// ---------------------------------------------------------------------------

describe('isBulkIntent', () => {
  it('accepts every declared BULK_INTENT value', () => {
    for (const intent of Object.values(BULK_INTENT)) {
      expect(isBulkIntent(intent)).toBe(true);
    }
  });

  it('rejects a near-miss string that is not one of the five declared values', () => {
    expect(isBulkIntent('bulk-archive')).toBe(false);
  });

  it('rejects a non-string value without throwing', () => {
    expect(isBulkIntent(undefined)).toBe(false);
    expect(isBulkIntent(null)).toBe(false);
    expect(isBulkIntent(42)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseBulkAction: intent
// ---------------------------------------------------------------------------

describe('parseBulkAction: intent', () => {
  it('rejects a missing intent field', () => {
    const result = parseBulkAction(formData([[BULK_FORM_FIELD.id, UUID_A]]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.intent).toBeTruthy();
  });

  it('rejects an unrecognised intent', () => {
    const result = parseBulkAction(
      formData([
        [BULK_FORM_FIELD.intent, 'bulk-archive'],
        [BULK_FORM_FIELD.id, UUID_A],
      ]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.intent).toBeTruthy();
  });

  it('an invalid intent is reported even when no ids are selected either — the intent error is not swallowed by the ids error', () => {
    const result = parseBulkAction(formData([[BULK_FORM_FIELD.intent, 'nonsense']]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.intent).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// parseBulkAction: ids
// ---------------------------------------------------------------------------

describe('parseBulkAction: ids', () => {
  it('accepts a well-formed selection', () => {
    const result = parseBulkAction(
      formData([
        [BULK_FORM_FIELD.intent, BULK_INTENT.delete],
        [BULK_FORM_FIELD.id, UUID_A],
        [BULK_FORM_FIELD.id, UUID_B],
      ]),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.action.ids).toEqual([UUID_A, UUID_B]);
  });

  // The hostile case named explicitly in the ticket: ids must be validated as UUIDs
  // with a strict regex BEFORE they are ever used in a query.
  it('drops a non-UUID id rather than passing it through to a query', () => {
    const result = parseBulkAction(
      formData([
        [BULK_FORM_FIELD.intent, BULK_INTENT.delete],
        [BULK_FORM_FIELD.id, UUID_A],
        [BULK_FORM_FIELD.id, '1 OR 1=1'],
      ]),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.action.ids).toEqual([UUID_A]);
  });

  it('drops an id that is merely close to a UUID (wrong length)', () => {
    const result = parseBulkAction(
      formData([
        [BULK_FORM_FIELD.intent, BULK_INTENT.delete],
        [BULK_FORM_FIELD.id, UUID_A],
        [BULK_FORM_FIELD.id, UUID_A.slice(0, -1)],
      ]),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.action.ids).toEqual([UUID_A]);
  });

  it('de-duplicates repeated ids, preserving first-seen order', () => {
    const result = parseBulkAction(
      formData([
        [BULK_FORM_FIELD.intent, BULK_INTENT.delete],
        [BULK_FORM_FIELD.id, UUID_B],
        [BULK_FORM_FIELD.id, UUID_A],
        [BULK_FORM_FIELD.id, UUID_B],
      ]),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.action.ids).toEqual([UUID_B, UUID_A]);
  });

  it('treats the same id in different case as one duplicate, not two', () => {
    const result = parseBulkAction(
      formData([
        [BULK_FORM_FIELD.intent, BULK_INTENT.delete],
        [BULK_FORM_FIELD.id, UUID_A.toUpperCase()],
        [BULK_FORM_FIELD.id, UUID_A],
      ]),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.action.ids).toEqual([UUID_A]);
  });

  // The hostile case named explicitly in the ticket: an empty selection is rejected
  // with a clear message rather than silently doing nothing or acting on every row.
  it('rejects an empty selection with a clear message', () => {
    const result = parseBulkAction(formData([[BULK_FORM_FIELD.intent, BULK_INTENT.delete]]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.ids).toBeTruthy();
  });

  it('a selection containing only non-UUID junk is treated as an empty selection', () => {
    const result = parseBulkAction(
      formData([
        [BULK_FORM_FIELD.intent, BULK_INTENT.delete],
        [BULK_FORM_FIELD.id, 'not-a-uuid'],
        [BULK_FORM_FIELD.id, ''],
      ]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.ids).toBeTruthy();
  });

  // The hostile case named explicitly in the ticket: an over-cap id list is rejected
  // with an explanation of the cap, rather than accepted and handed to a query that
  // would build an arbitrarily large `IN (...)` clause.
  it(`rejects a selection larger than MAX_BULK_IDS (${MAX_BULK_IDS})`, () => {
    const entries: [string, string][] = [[BULK_FORM_FIELD.intent, BULK_INTENT.delete]];
    for (let i = 0; i < MAX_BULK_IDS + 1; i++) {
      // Distinct, well-formed UUIDs — a numbered suffix keeps each one valid while
      // guaranteeing none collide, so this genuinely exercises "too many", not
      // "de-duplicated down to few".
      const suffix = i.toString(16).padStart(12, '0');
      entries.push([BULK_FORM_FIELD.id, `00000000-0000-4000-8000-${suffix}`]);
    }
    const result = parseBulkAction(formData(entries));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.ids).toBeTruthy();
  });

  it(`accepts a selection of exactly MAX_BULK_IDS (${MAX_BULK_IDS}) — the cap is inclusive, not off by one`, () => {
    const entries: [string, string][] = [[BULK_FORM_FIELD.intent, BULK_INTENT.delete]];
    for (let i = 0; i < MAX_BULK_IDS; i++) {
      const suffix = i.toString(16).padStart(12, '0');
      entries.push([BULK_FORM_FIELD.id, `00000000-0000-4000-8000-${suffix}`]);
    }
    const result = parseBulkAction(formData(entries));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.action.ids).toHaveLength(MAX_BULK_IDS);
  });
});

// ---------------------------------------------------------------------------
// parseBulkAction: bulk-set-category
// ---------------------------------------------------------------------------

describe('parseBulkAction: bulk-set-category', () => {
  it('accepts a category and trims it', () => {
    const result = parseBulkAction(
      formData([
        [BULK_FORM_FIELD.intent, BULK_INTENT.setCategory],
        [BULK_FORM_FIELD.id, UUID_A],
        [BULK_FORM_FIELD.category, '  Shelter  '],
      ]),
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.action.intent === BULK_INTENT.setCategory) {
      expect(result.action.category).toBe('Shelter');
    }
  });

  it('an empty category becomes null — "clear the category from every selected item"', () => {
    const result = parseBulkAction(
      formData([
        [BULK_FORM_FIELD.intent, BULK_INTENT.setCategory],
        [BULK_FORM_FIELD.id, UUID_A],
        [BULK_FORM_FIELD.category, ''],
      ]),
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.action.intent === BULK_INTENT.setCategory) {
      expect(result.action.category).toBeNull();
    }
  });

  it('still rejects an empty selection even with a valid category', () => {
    const result = parseBulkAction(
      formData([
        [BULK_FORM_FIELD.intent, BULK_INTENT.setCategory],
        [BULK_FORM_FIELD.category, 'Shelter'],
      ]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.ids).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// parseBulkAction: bulk-set-status — pairs with:
//   check (status in ('owned', 'wishlist', 'retired'))
// ---------------------------------------------------------------------------

describe('parseBulkAction: bulk-set-status', () => {
  it.each(['owned', 'wishlist', 'retired'])('accepts %s', (status) => {
    const result = parseBulkAction(
      formData([
        [BULK_FORM_FIELD.intent, BULK_INTENT.setStatus],
        [BULK_FORM_FIELD.id, UUID_A],
        [BULK_FORM_FIELD.status, status],
      ]),
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.action.intent === BULK_INTENT.setStatus) {
      expect(result.action.status).toBe(status);
    }
  });

  it('rejects an invalid status', () => {
    const result = parseBulkAction(
      formData([
        [BULK_FORM_FIELD.intent, BULK_INTENT.setStatus],
        [BULK_FORM_FIELD.id, UUID_A],
        [BULK_FORM_FIELD.status, 'Available'],
      ]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.status).toBeTruthy();
  });

  it('rejects a missing status field', () => {
    const result = parseBulkAction(
      formData([
        [BULK_FORM_FIELD.intent, BULK_INTENT.setStatus],
        [BULK_FORM_FIELD.id, UUID_A],
      ]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.status).toBeTruthy();
  });

  // Both problems should surface together: an invalid status AND an empty selection
  // are two independent things wrong with the same submission.
  it('reports both an empty selection and an invalid status at once', () => {
    const result = parseBulkAction(
      formData([
        [BULK_FORM_FIELD.intent, BULK_INTENT.setStatus],
        [BULK_FORM_FIELD.status, 'nonsense'],
      ]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.ids).toBeTruthy();
      expect(result.errors.status).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// parseBulkAction: delete / restore / delete-permanently — ids only
// ---------------------------------------------------------------------------

describe('parseBulkAction: delete, restore, delete-permanently', () => {
  it.each([BULK_INTENT.delete, BULK_INTENT.restore, BULK_INTENT.deletePermanently])(
    'accepts %s with a valid selection and no extra fields',
    (intent) => {
      const result = parseBulkAction(
        formData([
          [BULK_FORM_FIELD.intent, intent],
          [BULK_FORM_FIELD.id, UUID_A],
          [BULK_FORM_FIELD.id, UUID_C],
        ]),
      );
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.action.ids).toEqual([UUID_A, UUID_C]);
    },
  );
});

// ---------------------------------------------------------------------------
// makeUndoToken / parseUndoToken
// ---------------------------------------------------------------------------

describe('makeUndoToken', () => {
  it('produces a value parseUndoToken accepts back — the two halves of this module must agree', () => {
    const token = makeUndoToken();
    expect(parseUndoToken(token)).toBe(token);
  });

  it('produces the exact shape new Date().toISOString() always does: milliseconds, Z suffix', () => {
    const token = makeUndoToken();
    expect(token).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

describe('parseUndoToken', () => {
  it('accepts a well-formed ISO-8601 UTC timestamp', () => {
    expect(parseUndoToken('2026-01-15T10:30:00.000Z')).toBe('2026-01-15T10:30:00.000Z');
  });

  it('rejects null — no undo parameter was present in the URL at all', () => {
    expect(parseUndoToken(null)).toBeNull();
  });

  it('rejects the empty string', () => {
    expect(parseUndoToken('')).toBeNull();
  });

  // The hostile case named explicitly in the ticket: a malformed token must never
  // reach a query.
  it('rejects a plain date with no time component', () => {
    expect(parseUndoToken('2026-01-15')).toBeNull();
  });

  it('rejects a timestamp with a numeric offset instead of Z', () => {
    expect(parseUndoToken('2026-01-15T10:30:00.000+00:00')).toBeNull();
  });

  it('rejects a timestamp with no milliseconds', () => {
    expect(parseUndoToken('2026-01-15T10:30:00Z')).toBeNull();
  });

  it('rejects a timestamp with the wrong number of millisecond digits', () => {
    expect(parseUndoToken('2026-01-15T10:30:00.00Z')).toBeNull();
  });

  it('rejects free text', () => {
    expect(parseUndoToken('not-a-timestamp')).toBeNull();
  });

  // The near-miss the ticket calls out by name: Date's own parser silently ROLLS OVER
  // an impossible day-of-month (Feb 30 -> Mar 1) rather than refusing it. A token that
  // rolls over to a different instant must be refused, not silently reinterpreted —
  // matching it against deleted_at would then restore nothing, since deleted_at was
  // stamped with a value that was never "Feb 30" in the first place.
  it('rejects an impossible date (Feb 30) that Date would silently roll over to March 1', () => {
    expect(parseUndoToken('2026-02-30T00:00:00.000Z')).toBeNull();
  });

  it('rejects an impossible time (24:00) that Date would silently roll over to the next day', () => {
    expect(parseUndoToken('2026-01-15T24:00:00.000Z')).toBeNull();
  });

  it('rejects an impossible minute value (60) that Date would silently roll into the next hour', () => {
    expect(parseUndoToken('2026-01-15T10:60:00.000Z')).toBeNull();
  });

  it('rejects a value with trailing garbage after an otherwise well-formed timestamp', () => {
    expect(parseUndoToken('2026-01-15T10:30:00.000Z ')).toBeNull();
  });

  it('rejects a value with leading garbage before an otherwise well-formed timestamp', () => {
    expect(parseUndoToken(' 2026-01-15T10:30:00.000Z')).toBeNull();
  });

  it('rejects lowercase z — not the exact shape toISOString() produces', () => {
    expect(parseUndoToken('2026-01-15T10:30:00.000z')).toBeNull();
  });
});
