import { describe, expect, it } from 'vitest';
import {
  BULK_FORM_FIELD,
  BULK_INTENT,
  GEAR_DELETE_CONFIRMATION_VALUE,
  GEAR_DELETE_FAILED_MESSAGE,
  MAX_BULK_IDS,
  confirmsGearDeletion,
  isBulkIntent,
  parseBulkAction,
} from '../src/lib/gear/bulk';

/**
 * `src/lib/gear/bulk.ts` is the pure validation layer the closet list's bulk actions
 * need precisely because `vitest.config.ts:64` excludes `src/pages/` — see that
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

  it('rejects a near-miss string that is not one of the three declared values', () => {
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
// parseBulkAction: bulk-delete — ids only
// ---------------------------------------------------------------------------

describe('parseBulkAction: bulk-export (PK-65)', () => {
  /**
   * Export shares the delete branch — ids only, nothing further to validate — so nothing
   * in `parseBulkAction` was written FOR it, and that is exactly why it needs its own
   * tests rather than inheriting delete's. `bulk.ts` makes three claims about this intent
   * in its comments (it parses, `MAX_BULK_IDS` bounds it, malformed ids are dropped), and
   * a claim about a code path with no test is a claim about a path that is one refactor
   * away from being wrong. It is also the one intent that reads rather than writes, which
   * makes it the one whose failure is quietest: a broken delete is loud.
   */
  it('parses a valid selection', () => {
    const result = parseBulkAction(
      formData([
        [BULK_FORM_FIELD.intent, BULK_INTENT.export],
        [BULK_FORM_FIELD.id, UUID_A],
        [BULK_FORM_FIELD.id, UUID_C],
      ]),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.action.intent).toBe(BULK_INTENT.export);
      expect(result.action.ids).toEqual([UUID_A, UUID_C]);
    }
  });

  it('refuses an empty selection', () => {
    // The closet's export branch never reaches a query for this, so the refusal here is
    // the whole of what stops an "export" that selected nothing.
    const result = parseBulkAction(formData([[BULK_FORM_FIELD.intent, BULK_INTENT.export]]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.ids).toBe('Select at least one item.');
  });

  it('refuses a selection over MAX_BULK_IDS', () => {
    const entries: [string, string][] = [[BULK_FORM_FIELD.intent, BULK_INTENT.export]];
    for (let index = 0; index <= MAX_BULK_IDS; index += 1) {
      entries.push([
        BULK_FORM_FIELD.id,
        `${index.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`,
      ]);
    }
    const result = parseBulkAction(formData(entries));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.ids).toContain(String(MAX_BULK_IDS));
  });

  it('drops malformed ids rather than passing them to a query', () => {
    const result = parseBulkAction(
      formData([
        [BULK_FORM_FIELD.intent, BULK_INTENT.export],
        [BULK_FORM_FIELD.id, UUID_A],
        [BULK_FORM_FIELD.id, '1 OR 1=1'],
        [BULK_FORM_FIELD.id, '../../etc/passwd'],
        [BULK_FORM_FIELD.id, ''],
      ]),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.action.ids).toEqual([UUID_A]);
  });

  it('de-duplicates and lower-cases, so one row cannot be exported twice', () => {
    const result = parseBulkAction(
      formData([
        [BULK_FORM_FIELD.intent, BULK_INTENT.export],
        [BULK_FORM_FIELD.id, UUID_A],
        [BULK_FORM_FIELD.id, UUID_A.toUpperCase()],
      ]),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.action.ids).toEqual([UUID_A]);
  });

  it('ignores the fields the other intents use', () => {
    // An export form posts no category and no status; a crafted request may. Neither
    // should change what an export means, and neither should make it fail.
    const result = parseBulkAction(
      formData([
        [BULK_FORM_FIELD.intent, BULK_INTENT.export],
        [BULK_FORM_FIELD.id, UUID_A],
        [BULK_FORM_FIELD.category, 'Shelter'],
        [BULK_FORM_FIELD.status, 'not-a-status'],
      ]),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.action.intent).toBe(BULK_INTENT.export);
  });

  it('is a recognised intent', () => {
    expect(isBulkIntent(BULK_INTENT.export)).toBe(true);
    expect(isBulkIntent('bulk-export')).toBe(true);
    expect(isBulkIntent('export')).toBe(false);
  });
});

describe('parseBulkAction: delete', () => {
  it('accepts a valid selection with no extra fields', () => {
    const result = parseBulkAction(
      formData([
        [BULK_FORM_FIELD.intent, BULK_INTENT.delete],
        [BULK_FORM_FIELD.id, UUID_A],
        [BULK_FORM_FIELD.id, UUID_C],
      ]),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.action.ids).toEqual([UUID_A, UUID_C]);
  });

  // The two intents a closet with a trash behind it would need, held out by name. Each
  // is a string a stale bookmark, a cached page or a crafted request can still post, and
  // neither describes anything this product does: there is ONE delete, `bulk-delete`,
  // and it removes the rows (`deleteGearItems`, src/lib/gear/mutations.ts).
  //
  // WHAT THIS DEFENDS, precisely, because the page's own defences changed under it.
  // src/pages/gear/index.astro now ends its intent branching in an exhaustiveness guard
  // (`const unhandled: never = action`, PK-60 review F2), so a fourth member ADDED TO
  // `BULK_INTENT` is refused by the compiler, whatever fields it carries — that class of
  // mistake no longer needs a runtime test, and this one would not catch it anyway.
  // What no type can refuse is a STRING: `bulk-restore` posted by a bookmark saved
  // before PK-60, by a page cached in a browser, or by a crafted request. That is a
  // value arriving at `parseBulkAction` at runtime, and the only thing that stops it is
  // `isBulkIntent` not recognising it. The bug this catches is either string quietly
  // acquiring a code path again — say by being added back to `BULK_INTENT` for a
  // half-built feature — because an intent `isBulkIntent` accepts falls out of
  // `parseBulkAction` as a well-formed `BulkAction` that a page then has to have a
  // branch for.
  it.each(['bulk-restore', 'bulk-delete-permanently'])(
    'rejects %s — not an action this module offers, however the string reaches the form',
    (intent) => {
      const result = parseBulkAction(
        formData([
          [BULK_FORM_FIELD.intent, intent],
          [BULK_FORM_FIELD.id, UUID_A],
        ]),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.intent).toBeTruthy();
    },
  );
});

// ---------------------------------------------------------------------------
// confirmsGearDeletion — the gate in front of the delete
// ---------------------------------------------------------------------------
//
// This is the whole safety net. `deleteGearItems` (src/lib/gear/mutations.ts) removes
// the rows from `gear_items`; PK-60 took away the trash, the restore and the undo, so
// nothing downstream of this predicate catches a selection the visitor did not mean and
// nothing afterwards puts it back.
//
// Until PK-60's review it was an inline `form.get('confirm') === '1'` in
// src/pages/gear/index.astro and a SECOND, independently declared copy in
// src/pages/gear/[id].astro — one string duplicated across two files, held in step by
// nothing, in the one directory `vitest.config.ts:64` excludes from this run. So the
// guard in front of the only irreversible write in the gear closet was the only guard
// in it with no test able to execute it, exactly as tests/account-deletion-gate.test.ts
// records for account deletion: the same defect, found again, fixed the same way. Read
// `confirmsGearDeletion`'s own comment first for WHY it is strict where
// `confirmsAccountDeletion` is forgiving — nobody types this value, a hidden input this
// application renders writes it.
describe('confirmsGearDeletion', () => {
  it('confirms the exact value the confirmation form posts', () => {
    expect(confirmsGearDeletion(GEAR_DELETE_CONFIRMATION_VALUE)).toBe(true);
  });

  /**
   * Everything that must NOT delete. Each is a real submission shape, not a
   * hypothetical: what a browser, a stale form, a partly-rewritten template or a crafted
   * POST actually sends.
   */
  it.each<[string, FormDataEntryValue | null]>([
    // THE case: the first submission of a delete carries no `confirm` field at all —
    // that is what makes the flow two-step. A gate that confirmed on `null` would delete
    // the selection on the first click and never show the confirmation it was meant to.
    ['the field absent from the request entirely', null],
    // A hidden input left with no value, or a template edited to `value=""` — the field
    // is present, which any "did the form carry it?" check would read as confirmation.
    ['an empty string — the field posted with no value', ''],
    // The truthiness bug, named: `if (form.get(BULK_FORM_FIELD.confirm))` deletes on
    // this, because '0' is a non-empty string. So does `Boolean(value)`.
    ['the string 0', '0'],
    // The same bug from the other side — a rewrite that spells the confirmation as a
    // boolean somewhere (a JS client, a copied form, a template using `value={true}`)
    // must not half-work. There is one confirming value and it is not this one.
    ['the string true', 'true'],
    ['the string false', 'false'],
    // What an <input type="checkbox"> with no `value` attribute posts. If this gate ever
    // grows a visible "yes, delete" checkbox, the browser sends 'on' and the delete has
    // to keep refusing until the writer is changed deliberately — not confirm because
    // 'on' happens to look affirmative.
    ['on — what a valueless checkbox posts', 'on'],
    // Surrounding whitespace. Deliberately refused, unlike confirmsAccountDeletion,
    // which tolerates it: that value is typed by a person, this one is written by our
    // own hidden input from GEAR_DELETE_CONFIRMATION_VALUE. A padded value did not come
    // from the confirmation this application rendered, and no visitor is inconvenienced
    // by the refusal — the real button is one click away.
    ['a padded value', ' 1 '],
    ['a value with a trailing newline', '1\n'],
    // A near-miss that a lenient `startsWith`/`parseInt` spelling would accept.
    ['a value that merely begins with the confirming one', '10'],
  ])('refuses %s', (_label, value) => {
    expect(confirmsGearDeletion(value)).toBe(false);
  });

  /**
   * A non-string `FormDataEntryValue`. `form.get()` returns `File | string | null`, and
   * a multipart POST can send a file part under ANY field name, this one included — so
   * this is a request anybody can make, not a contrived value. Two separate things have
   * to hold: it must not confirm, and it must not THROW. The natural-looking lenient
   * spellings (`value.trim() === '1'`, `value.toLowerCase()`) throw a TypeError on a
   * File, which Astro turns into a 500 — a crafted body crashing the closet page rather
   * than being told no.
   */
  it.each<[string, FormDataEntryValue]>([
    ['a File', new File([GEAR_DELETE_CONFIRMATION_VALUE], 'confirm.txt', { type: 'text/plain' })],
    ['a File whose contents are the confirming value', new File(['1'], '1')],
  ])('refuses %s without throwing', (_label, value) => {
    expect(() => confirmsGearDeletion(value)).not.toThrow();
    expect(confirmsGearDeletion(value)).toBe(false);
  });

  /**
   * The other half of the gate: what a real submission looks like end to end. The pages
   * build their hidden input from `BULK_FORM_FIELD.confirm` and
   * `GEAR_DELETE_CONFIRMATION_VALUE`, so reading a `FormData` assembled from those same
   * two constants is the closest this suite can get to the actual round trip — and it
   * pins the pair together, which is the point of exporting the value at all rather than
   * writing `value="1"` in two templates.
   */
  it('confirms a FormData built the way both gear pages build it', () => {
    const form = new FormData();
    form.append(BULK_FORM_FIELD.intent, BULK_INTENT.delete);
    form.append(BULK_FORM_FIELD.id, UUID_A);
    form.append(BULK_FORM_FIELD.confirm, GEAR_DELETE_CONFIRMATION_VALUE);
    expect(confirmsGearDeletion(form.get(BULK_FORM_FIELD.confirm))).toBe(true);

    // And the first, unconfirmed submission of that same delete — identical but for the
    // one field — does not.
    const unconfirmed = new FormData();
    unconfirmed.append(BULK_FORM_FIELD.intent, BULK_INTENT.delete);
    unconfirmed.append(BULK_FORM_FIELD.id, UUID_A);
    expect(confirmsGearDeletion(unconfirmed.get(BULK_FORM_FIELD.confirm))).toBe(false);
  });

  // Pinned because the value is a contract between a template and a predicate in two
  // different files, and a change to it is invisible in both: swap it and every rendered
  // confirmation button silently stops confirming.
  it('names the field and value the gear pages render', () => {
    expect(BULK_FORM_FIELD.confirm).toBe('confirm');
    expect(GEAR_DELETE_CONFIRMATION_VALUE).toBe('1');
  });
});

// ---------------------------------------------------------------------------
// GEAR_DELETE_FAILED_MESSAGE
// ---------------------------------------------------------------------------
//
// What both gear pages show when the delete itself errors. Pinned here rather than left
// to whoever edits a page next, because the two things it must not say are both things
// the surrounding write paths DO say, one import away.
describe('GEAR_DELETE_FAILED_MESSAGE', () => {
  it('does not describe the failed delete as an update', () => {
    // The bug: both pages reported a failed delete with their generic write error, whose
    // text is "Something went wrong updating your gear / this item". A permanent delete
    // is not an update, and a visitor reading "updating" has been told the wrong thing
    // happened as well as that it failed.
    expect(GEAR_DELETE_FAILED_MESSAGE).not.toMatch(/updat/i);
  });

  it('does not promise the delete did not happen', () => {
    // "Please try again" asserts the rows are still there. A DELETE that commits and
    // then loses its response — a worker timeout, a reset connection, a 502 — lands in
    // the very same branch with the rows already gone, and PK-60 left no trash, no undo
    // and no log to check that against. The message must claim neither outcome.
    expect(GEAR_DELETE_FAILED_MESSAGE).not.toMatch(/try again/i);
    expect(GEAR_DELETE_FAILED_MESSAGE).not.toMatch(/nothing was deleted|was not deleted/i);
  });

  it('sends the visitor to the list, which is the only thing that can answer', () => {
    expect(GEAR_DELETE_FAILED_MESSAGE).toMatch(/closet/i);
  });
});
