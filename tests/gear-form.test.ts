import { describe, expect, it } from 'vitest';
import {
  EMPTY_GEAR_FORM_VALUES,
  GEAR_FORM_FIELD,
  gearItemToFormValues,
  parseGearItemForm,
  rawGearFormValues,
  type GearFormValues,
  type GearItemRow,
} from '../src/lib/gear/form';
import { GRAMS_PER_UNIT, type WeightSystem } from '../src/lib/units';

/**
 * `src/lib/gear/form.ts` is the pure validation layer PK-4's gear create/edit form
 * needs precisely because `vitest.config.ts:64` excludes `src/pages/` — see that
 * module's own doc comment, and `src/pages/account/index.astro:51-55`, for why this
 * logic could not live in a page's frontmatter and still be tested at all.
 *
 * Same care as `tests/gear-query.test.ts` and `tests/totals.test.ts`: every assertion
 * below names the bug it would catch, not merely what the code does — see
 * totals.test.ts's own header for why a table that "looks full" but exercises only one
 * rejection path is a real trap, not a hypothetical one.
 */

/**
 * `parseGearItemForm` under a METRIC account, which is what almost every test in this file
 * wants and is the default rather than a parameter at each call site.
 *
 * PK-67 gave the parser a second argument: the account's weight system, which decides the
 * unit the typed number is converted FROM. Metric's entry unit is `g`, whose factor is 1,
 * so the typed number and the stored gram figure are the same — which is what lets every
 * numeric expectation written before this ticket stand unchanged, and why threading
 * `'metric'` through eighty call sites would have added noise without adding meaning.
 *
 * The imperial path is not left untested by this convenience: the `weight` block below has
 * its own cases that pass `'imperial'` explicitly, and they are the ones that exercise the
 * conversion at all.
 */
const parseForm = (form: FormData, system: WeightSystem = 'metric') =>
  parseGearItemForm(form, system);

/** A complete, valid set of raw form values — every field filled in with something
 *  `parseGearItemForm` accepts, so each test below can override exactly the one field
 *  it means to exercise via `{ ...VALID, someField: '...' }` rather than restating all
 *  twelve every time. */
const VALID: GearFormValues = {
  name: 'Tent',
  quantity: '1',
  // Under the metric account these tests parse as (see `parseForm`), this is 2.5 GRAMS —
  // entry is in the system's base unit, so the typed number and the stored number are the
  // same here. It read `'2.5'` with a `weight_unit: 'kg'` beside it until PK-67 removed
  // the field; the number is unchanged so that every weight assertion below still says
  // what it always said.
  weight: '2.5',
  price: '199.99',
  currency: 'GBP',
  acquired_on: '2026-08-13',
  status: 'owned',
  url: 'https://example.com/tent',
  brand: 'Example Co',
  category: 'Shelter',
  description: 'A tent.',
  notes: 'Bought secondhand.',
};

function formData(values: Partial<GearFormValues>): FormData {
  const form = new FormData();
  const merged = { ...VALID, ...values };
  for (const [key, value] of Object.entries(merged)) {
    form.set(key, value);
  }
  return form;
}

/** Builds a FormData with a given field entirely absent (not even an empty string) —
 *  distinct from `formData({ field: '' })`, which still submits the field. Exercises
 *  the "field missing from the request at all" path a crafted or stale POST can hit. */
function formDataMissing(field: keyof GearFormValues): FormData {
  const form = formData({});
  form.delete(field);
  return form;
}

// ---------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------

describe('parseGearItemForm: a fully valid submission', () => {
  it('parses every field into the right type', () => {
    const result = parseForm(formData({}));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok: true');
    expect(result.values).toEqual({
      name: 'Tent',
      quantity: 1,
      weight_grams: 2.5,
      price: 199.99,
      currency: 'GBP',
      acquired_on: '2026-08-13',
      status: 'owned',
      url: 'https://example.com/tent',
      brand: 'Example Co',
      category: 'Shelter',
      description: 'A tent.',
      notes: 'Bought secondhand.',
    });
  });
});

// ---------------------------------------------------------------------------
// name — pairs with: check (length(btrim(name)) > 0)
// ---------------------------------------------------------------------------

describe('parseGearItemForm: name', () => {
  it('trims surrounding whitespace on success', () => {
    const result = parseForm(formData({ name: '  Tent  ' }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.name).toBe('Tent');
  });

  it('rejects an empty name — catches a form submitted with the field blank', () => {
    const result = parseForm(formData({ name: '' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.name).toBeTruthy();
  });

  // This is the case the CHECK constraint is written to catch: `btrim` strips
  // whitespace before checking length, so a name of only spaces is not "non-empty".
  // A parser that only checked `name !== ''` would let this through and disagree with
  // the database, which would then refuse the insert with a raw constraint-violation
  // error.
  it('rejects a whitespace-only name, mirroring btrim in the CHECK constraint', () => {
    const result = parseForm(formData({ name: '   ' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.name).toBeTruthy();
  });

  it('a missing name field is treated the same as an empty one', () => {
    const result = parseForm(formDataMissing('name'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.name).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// quantity — pairs with: check (quantity > 0)
// ---------------------------------------------------------------------------

describe('parseGearItemForm: quantity', () => {
  it('accepts a plain positive integer', () => {
    const result = parseForm(formData({ quantity: '3' }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.quantity).toBe(3);
  });

  it('rejects zero — the exact boundary quantity > 0 refuses', () => {
    const result = parseForm(formData({ quantity: '0' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.quantity).toBeTruthy();
  });

  it('rejects a negative quantity', () => {
    const result = parseForm(formData({ quantity: '-1' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.quantity).toBeTruthy();
  });

  it('rejects a decimal quantity — "2.5 items" is not representable in an integer column', () => {
    const result = parseForm(formData({ quantity: '2.5' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.quantity).toBeTruthy();
  });

  // The case the ticket calls out by name: Number('1e3') is 1000, a value
  // Number.isSafeInteger alone would accept, but it is scientific notation nobody types
  // by hand into a plain quantity field.
  it('rejects scientific notation (1e3) even though it parses to a valid positive integer', () => {
    const result = parseForm(formData({ quantity: '1e3' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.quantity).toBeTruthy();
  });

  it('rejects a quantity beyond Postgres integer range, rather than letting it reach the database', () => {
    const result = parseForm(formData({ quantity: '99999999999' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.quantity).toBeTruthy();
  });

  // PK-63: quantity integer not null default 1 — name is the only field left that can
  // block a save, so a missing quantity field now resolves to the column's own default
  // rather than being rejected as though the request were stale or tampered.
  it('a missing quantity field defaults to 1, the column default, rather than being rejected', () => {
    const result = parseForm(formDataMissing('quantity'));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.quantity).toBe(1);
  });

  it('a blank quantity defaults to 1', () => {
    const result = parseForm(formData({ quantity: '' }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.quantity).toBe(1);
  });

  it('a whitespace-only quantity defaults to 1, the same as a fully blank one', () => {
    const result = parseForm(formData({ quantity: '   ' }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.quantity).toBe(1);
  });

  // The default only forgives a BLANK field — a non-blank value that fails to parse is
  // still a wrong answer, not a missing one, and parseQuantity itself has not changed.
  it('a malformed non-blank quantity still errors, the default does not paper over it', () => {
    const result = parseForm(formData({ quantity: 'abc' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.quantity).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// weight — pairs with: check (weight >= 0 and weight < 'Infinity'::numeric)
// ---------------------------------------------------------------------------

describe('parseGearItemForm: weight', () => {
  it('accepts zero — the ordinary "not yet weighed" value, and the column default', () => {
    const result = parseForm(formData({ weight: '0' }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.weight_grams).toBe(0);
  });

  it('accepts up to three decimal places, matching numeric(12, 3)', () => {
    const result = parseForm(formData({ weight: '1.234' }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.weight_grams).toBe(1.234);
  });

  it('rejects a fourth decimal place — more precision than the column can store', () => {
    const result = parseForm(formData({ weight: '1.2345' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.weight).toBeTruthy();
  });

  it('rejects a negative weight', () => {
    const result = parseForm(formData({ weight: '-1' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.weight).toBeTruthy();
  });

  // The case the ticket names explicitly: Postgres orders NaN ABOVE every numeric
  // value, so a plain `weight >= 0` check on the database side lets it through (see
  // core_schema.sql:67-72) — this parser must refuse the string outright, not rely on
  // a >= 0 comparison that happens to also work in JavaScript for the wrong reason.
  it('rejects the literal string "NaN"', () => {
    const result = parseForm(formData({ weight: 'NaN' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.weight).toBeTruthy();
  });

  it('rejects the literal string "Infinity"', () => {
    const result = parseForm(formData({ weight: 'Infinity' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.weight).toBeTruthy();
  });

  it('rejects "-Infinity" too, not only the positive spelling', () => {
    const result = parseForm(formData({ weight: '-Infinity' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.weight).toBeTruthy();
  });

  it('rejects scientific notation, the same way quantity does', () => {
    const result = parseForm(formData({ weight: '1e3' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.weight).toBeTruthy();
  });

  it("rejects a value at or beyond numeric(12, 3)'s range instead of overflowing the column", () => {
    const result = parseForm(formData({ weight: '1000000000' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.weight).toBeTruthy();
  });

  // PK-63: weight numeric(12, 3) not null default 0 — same relaxation as quantity
  // above, and for the same reason: name is the only field left that can block a save.
  it('a missing weight field defaults to 0, the column default, rather than being rejected', () => {
    const result = parseForm(formDataMissing('weight'));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.weight_grams).toBe(0);
  });

  it('a blank weight defaults to 0', () => {
    const result = parseForm(formData({ weight: '' }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.weight_grams).toBe(0);
  });

  it('a whitespace-only weight defaults to 0, the same as a fully blank one', () => {
    const result = parseForm(formData({ weight: '   ' }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.weight_grams).toBe(0);
  });

  // The default only forgives a BLANK field — a non-blank value that fails to parse is
  // still a wrong answer, not a missing one, and parseNonNegativeDecimal itself has not
  // changed.
  it('a malformed non-blank weight still errors, the default does not paper over it', () => {
    const result = parseForm(formData({ weight: 'NaN' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.weight).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// The conversion that replaced the weight_unit field (PK-67)
// ---------------------------------------------------------------------------

/**
 * This block replaces `parseGearItemForm: weight_unit`, which pinned the four accepted
 * unit strings and the rejection of near-misses like `'G'` and `'lbs'` against
 * `check (weight_unit in ('g', 'kg', 'oz', 'lb'))`.
 *
 * None of that is reachable any more, and the reason is worth stating rather than leaving
 * as a gap in the file: the unit is no longer a FIELD. It is an argument, typed
 * `WeightSystem`, so a malformed one cannot be submitted — it would not compile. The
 * near-miss tests protected a string that arrived from a `<select>`; there is no select,
 * no string, and no submission that can carry one.
 *
 * What genuinely can go wrong instead is the conversion, so that is what is tested here.
 */
describe('parseGearItemForm: converting the typed weight to grams', () => {
  // Metric enters in grams, whose factor is 1 — so the typed number IS the stored number,
  // and this is the case that would keep passing if the conversion were dropped entirely.
  // Pinned anyway, because "metric is a no-op" is the property the rest of this file's
  // unchanged numeric expectations quietly depend on.
  it('stores a metric weight unchanged, grams being the entry unit', () => {
    const result = parseForm(formData({ weight: '1850' }), 'metric');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.weight_grams).toBe(1850);
  });

  /**
   * The ticket's own acceptance criterion, and the reason this block exists: a weight
   * typed as `4.4` under Imperial stores `124.738` g. Both halves matter — the factor
   * (28.349523125, giving 124.73790175) and the rounding to the column's three decimals.
   * An implementation that converted but did not round would store 124.73790175 and fail
   * this; one that rounded but did not convert would store 4.4.
   */
  it('converts an imperial weight from ounces and rounds to the column scale', () => {
    const result = parseForm(formData({ weight: '4.4' }), 'imperial');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.weight_grams).toBe(124.738);
  });

  it('converts zero to zero under either system', () => {
    for (const system of ['metric', 'imperial'] as const) {
      const result = parseForm(formData({ weight: '0' }), system);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.values.weight_grams).toBe(0);
    }
  });

  /**
   * THE UPPER BOUND FOLLOWS THE UNIT, which is the subtle half of the conversion and the
   * one a reimplementation gets wrong. `numeric(12, 3)` tops out just below 1e9 GRAMS, so
   * an imperial account's limit on the TYPED number is 1e9 / 28.349523125 ≈ 35,273,961.9
   * ounces — not 1e9. A parser that bounded the typed value at 1e9 for both systems would
   * accept 100,000,000 oz, convert it to 2.8e9 g, and hand Postgres a value the column
   * cannot hold: the raw `numeric field overflow` this module exists to never show a
   * visitor.
   */
  it('rejects an imperial weight that only overflows the column once converted', () => {
    const result = parseForm(formData({ weight: '100000000' }), 'imperial');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.weight).toBeTruthy();
  });

  // The same number is fine under metric, which is what proves the bound above moved with
  // the unit rather than simply being lowered for everyone.
  it('accepts that same number under metric, where it fits', () => {
    const result = parseForm(formData({ weight: '100000000' }), 'metric');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.weight_grams).toBe(100000000);
  });

  // Just inside and just outside the imperial bound, computed from the factor rather than
  // written as a literal so it cannot drift from GRAMS_PER_UNIT.
  it('accepts an imperial weight just inside the converted bound', () => {
    const justInside = Math.floor(10 ** 9 / GRAMS_PER_UNIT.oz) - 1;
    const result = parseForm(formData({ weight: String(justInside) }), 'imperial');
    expect(result.ok).toBe(true);
  });

  it('rejects an imperial weight just outside the converted bound', () => {
    const justOutside = Math.ceil(10 ** 9 / GRAMS_PER_UNIT.oz) + 1;
    const result = parseForm(formData({ weight: String(justOutside) }), 'imperial');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.weight).toBeTruthy();
  });

  /**
   * A weight_unit field left over in a stale or crafted submission must be IGNORED, not
   * honoured. This is the regression that would matter if someone reintroduced a unit read
   * "for backwards compatibility": the account setting is the only thing that may decide
   * the entry unit, and a submitted field must not be able to override it.
   */
  it('ignores a stale weight_unit field in the submission', () => {
    const form = formData({ weight: '4.4' });
    form.set('weight_unit', 'lb');

    const result = parseForm(form, 'imperial');
    expect(result.ok).toBe(true);
    // Converted as ounces, the imperial ENTRY unit — not as the pounds the stray field
    // asked for, which would have stored 1995.8 g.
    if (result.ok) expect(result.values.weight_grams).toBe(124.738);
  });
});

// ---------------------------------------------------------------------------
// status — pairs with: check (status in ('owned', 'wishlist', 'retired'))
// ---------------------------------------------------------------------------

describe('parseGearItemForm: status', () => {
  it.each(['owned', 'wishlist', 'retired'])('accepts %s', (status) => {
    const result = parseForm(formData({ status }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.status).toBe(status);
  });

  it('rejects the ticket-text status "Available", which the schema does not have', () => {
    const result = parseForm(formData({ status: 'Available' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.status).toBeTruthy();
  });

  it('a missing status field is rejected, not silently defaulted to owned', () => {
    const result = parseForm(formDataMissing('status'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.status).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// price / currency — pairs with: gear_items_price_has_currency,
//                                 check (currency ~ '^[A-Z]{3}$')
// ---------------------------------------------------------------------------

describe('parseGearItemForm: price and currency', () => {
  it('accepts both present together', () => {
    const result = parseForm(formData({ price: '10.50', currency: 'USD' }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.values.price).toBe(10.5);
      expect(result.values.currency).toBe('USD');
    }
  });

  it('accepts both absent together — the "no price recorded" case', () => {
    const result = parseForm(formData({ price: '', currency: '' }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.values.price).toBeNull();
      expect(result.values.currency).toBeNull();
    }
  });

  // The exact pairing gear_items_price_has_currency exists to refuse: a price with no
  // currency is stored as a bare number no formatter can render.
  it('rejects a price with no currency', () => {
    const result = parseForm(formData({ price: '10.50', currency: '' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.currency).toBeTruthy();
  });

  // The other half of the same pairing: a currency naming nothing to measure.
  it('rejects a currency with no price', () => {
    const result = parseForm(formData({ price: '', currency: 'GBP' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.price).toBeTruthy();
  });

  it('rejects a lowercase currency code — the CHECK constraint is case-sensitive ([A-Z])', () => {
    const result = parseForm(formData({ price: '10', currency: 'gbp' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.currency).toBeTruthy();
  });

  it('rejects a currency symbol instead of a code', () => {
    const result = parseForm(formData({ price: '10', currency: '£' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.currency).toBeTruthy();
  });

  it('accepts up to two decimal places, matching numeric(12, 2)', () => {
    const result = parseForm(formData({ price: '10.99', currency: 'GBP' }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.price).toBe(10.99);
  });

  it("rejects a third decimal place — more precision than price's scale allows", () => {
    const result = parseForm(formData({ price: '10.999', currency: 'GBP' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.price).toBeTruthy();
  });

  it('rejects a negative price', () => {
    const result = parseForm(formData({ price: '-5', currency: 'GBP' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.price).toBeTruthy();
  });

  it('rejects the literal string "NaN" as a price', () => {
    const result = parseForm(formData({ price: 'NaN', currency: 'GBP' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.price).toBeTruthy();
  });

  it('rejects the literal string "Infinity" as a price', () => {
    const result = parseForm(formData({ price: 'Infinity', currency: 'GBP' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.price).toBeTruthy();
  });

  it('a bad price and a bad currency both report — the visitor sees both problems at once', () => {
    const result = parseForm(formData({ price: 'abc', currency: 'gbp' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.price).toBeTruthy();
      expect(result.errors.currency).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// acquired_on (PK-61) — mirrors a TYPE (date), not a CHECK constraint; see
// isRealCalendarDate's own doc comment in src/lib/gear/form.ts for why a shape match
// alone (ACQUIRED_ON_PATTERN) is not enough and the round-trip through Date.UTC is.
// ---------------------------------------------------------------------------

describe('parseGearItemForm: acquired_on', () => {
  // THE SINGLE MOST IMPORTANT CASE IN THE TICKET: acquired_on is a nullable column with
  // NO database default (unlike quantity/weight/status, which this form
  // requires precisely because THEY have no honest blank — see the module comment's
  // "REQUIRED VS OPTIONAL FOLLOWS THE COLUMNS" section). A blank date box means "I don't
  // know when I got this", which is a normal, complete answer, not a mistake — so this
  // must come back `ok: true` with `acquired_on: null`, never an error.
  it('a blank value is not an error — it means "I do not know", and stores null', () => {
    const result = parseForm(formData({ acquired_on: '' }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.acquired_on).toBeNull();
  });

  // Same acceptance as blank, via the same `trimmed === ''` check every other optional
  // field in this module uses (parseOptionalText) — a visitor who tabs into the date
  // field and back out again without typing anything must not be penalised for the
  // stray whitespace a browser autofill or a copy-paste could leave behind.
  it('a whitespace-only value is treated the same as blank', () => {
    const result = parseForm(formData({ acquired_on: '   ' }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.acquired_on).toBeNull();
  });

  // Stored as the TRIMMED string, not reformatted otherwise — same "no rewriting"
  // discipline as `url` below: this is a validator, not a normaliser. ("Exactly as
  // given" would overstate it — the accepted value is `values.acquired_on.trim()`, not
  // the untrimmed raw string; this test's input has no surrounding whitespace to trim,
  // so it does not distinguish the two, but the wording here should not claim more than
  // the code does.)
  it('accepts a valid date and stores it exactly as given', () => {
    const result = parseForm(formData({ acquired_on: '2026-08-13' }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.acquired_on).toBe('2026-08-13');
  });

  // A real leap day. If isRealCalendarDate had a hand-rolled days-per-month table
  // instead of round-tripping through Date.UTC, this is the exact case a forgotten
  // "february has 29 days every 4 years, except..." rule would get wrong.
  it('accepts a real leap day (2024 was a leap year)', () => {
    const result = parseForm(formData({ acquired_on: '2024-02-29' }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.acquired_on).toBe('2024-02-29');
  });

  // 2026 is not a leap year — Date.UTC(2026, 1, 29) normalises forward to March 1st,
  // so the round-trip comparison against the typed day (29) fails and this is refused.
  // The false-positive twin of the case above: a validator that merely checked "is this
  // day <= 31" would wrongly accept it.
  it('rejects a February 29th in a non-leap year', () => {
    const result = parseForm(formData({ acquired_on: '2026-02-29' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.acquired_on).toBeTruthy();
  });

  // Shape-valid (matches ACQUIRED_ON_PATTERN) but not a real date — exactly the case
  // isRealCalendarDate's own comment names Postgres would otherwise reject with a raw
  // `date/time field value out of range` error, which this module exists to never let a
  // visitor see.
  it.each(['2026-02-30', '2026-13-01'])(
    'rejects %s — shape-valid but not a real calendar date',
    (value) => {
      const result = parseForm(formData({ acquired_on: value }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.acquired_on).toBeTruthy();
    },
  );

  // Zero month / zero day: still shape-valid against \d{4}-\d{2}-\d{2}, and still not a
  // real date — Date.UTC(2026, -1, 10) and Date.UTC(2026, 0, 0) both normalise away from
  // what was typed, so the round-trip catches both the same way it catches an
  // out-of-range month or day above 12/31.
  it.each(['2026-00-10', '2026-01-00'])(
    'rejects %s — zero month/day is not a real date',
    (value) => {
      const result = parseForm(formData({ acquired_on: value }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.acquired_on).toBeTruthy();
    },
  );

  // Malformed shapes ACQUIRED_ON_PATTERN refuses outright, before isRealCalendarDate
  // ever runs — the same reason parseNonNegativeDecimal gates with a regexp before
  // calling Number(). NOT because Postgres itself would refuse these: verified against
  // the local stack, `select '2026-2-3'::date` is ACCEPTED (Postgres's date parser
  // tolerates a single-digit month/day) — only '26-02-03', the two-digit-year shape, is
  // genuinely rejected by Postgres. This module is stricter than Postgres ON PURPOSE
  // (see ACQUIRED_ON_PATTERN's own comment in form.ts for the full reasoning: Postgres's
  // leniency depends on a `datestyle` session setting this module cannot see), not
  // because Postgres's own `date` input function would refuse the leniency `new Date()`
  // shows. '13/08/2026'/'today' are shapes nobody typing into a `YYYY-MM-DD` field would
  // produce by accident, regardless of what either parser does with them.
  it.each(['2026-2-3', '26-02-03', '13/08/2026', 'today'])(
    'rejects the malformed shape %s',
    (value) => {
      const result = parseForm(formData({ acquired_on: value }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.acquired_on).toBeTruthy();
    },
  );

  // Pinned deliberately, not a bug this test happens to demonstrate: isRealCalendarDate's
  // own doc comment documents that Date.UTC maps a two-digit year argument into the
  // 1900s (Date.UTC(26, ...) means 1926, not 26 AD), so the round-trip comparison never
  // matches for years 0000-0099 and '0026-02-03' comes back invalid — the right answer
  // for a field recording when somebody acquired a piece of camping gear, where a
  // first-century date is a typo every time. This test exists so a future refactor that
  // "fixes" the year-1900 mapping changes this assertion on purpose, rather than
  // silently, the day someone reworks the date-validation internals.
  it('rejects a four-digit year in 0000-0099, per the documented Date.UTC two-digit-year mapping', () => {
    const result = parseForm(formData({ acquired_on: '0026-02-03' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.acquired_on).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// acquired_on: future-date rejection (PK-61, isAcquiredOnInFuture in form.ts)
// ---------------------------------------------------------------------------

/** `YYYY-MM-DD` for `daysFromToday` days from today, computed in UTC — the exact
 *  arithmetic `acquiredOnFutureCutoff` (form.ts) itself does, so these tests stay
 *  correct on whatever day they happen to run rather than rotting the moment "today"
 *  moves past a hard-coded date. */
function isoDateOffsetUTC(daysFromToday: number): string {
  const now = new Date();
  const target = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysFromToday),
  );
  const year = String(target.getUTCFullYear()).padStart(4, '0');
  const month = String(target.getUTCMonth() + 1).padStart(2, '0');
  const day = String(target.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

describe('parseGearItemForm: acquired_on cannot be in the future', () => {
  // The case the ticket names explicitly: nothing previously bounded this field, so
  // `9999-12-31` — a perfectly real calendar date, which is exactly why it must NOT be
  // rejected with ACQUIRED_ON_MESSAGE's "enter a valid date" — validated and stored.
  // Distinctly worded from the malformed-shape rejections above: this date IS well
  // formed, so it needs its own message rather than reusing the "not a valid date" one.
  it('rejects a date far in the future, with a message distinct from the malformed-date one', () => {
    const result = parseForm(formData({ acquired_on: '9999-12-31' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.acquired_on).toBeTruthy();
      expect(result.errors.acquired_on).toBe('An acquired date cannot be in the future.');
    }
  });

  it("accepts today's date", () => {
    const result = parseForm(formData({ acquired_on: isoDateOffsetUTC(0) }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.acquired_on).toBe(isoDateOffsetUTC(0));
  });

  // THE ONE-DAY TOLERANCE, PINNED: a visitor whose local calendar date is a day ahead
  // of this server's UTC date (UTC+13/UTC+14, say) must not be told their honest
  // "today" is in the future. `isAcquiredOnInFuture`'s own comment names this exact
  // scenario as the reason the cutoff is "today in UTC, plus one day" rather than "today
  // in UTC" with no slack at all.
  it('accepts a date one day ahead of UTC today — the cross-time-zone tolerance', () => {
    const result = parseForm(formData({ acquired_on: isoDateOffsetUTC(1) }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.acquired_on).toBe(isoDateOffsetUTC(1));
  });

  // One day past the tolerance: no real time-zone offset explains being two calendar
  // days ahead of UTC, so this is where the cutoff actually bites.
  it('rejects a date two days ahead of UTC today — just past the tolerance', () => {
    const result = parseForm(formData({ acquired_on: isoDateOffsetUTC(2) }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.acquired_on).toBe('An acquired date cannot be in the future.');
    }
  });
});

// ---------------------------------------------------------------------------
// url — no CHECK constraint at all; this parser is the entire defence
// ---------------------------------------------------------------------------

describe('parseGearItemForm: url', () => {
  it('accepts a blank value as "not provided"', () => {
    const result = parseForm(formData({ url: '' }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.url).toBeNull();
  });

  it('accepts a plain https URL', () => {
    const result = parseForm(formData({ url: 'https://rei.com/product/123' }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.url).toBe('https://rei.com/product/123');
  });

  it('accepts a plain http URL', () => {
    const result = parseForm(formData({ url: 'http://example.com/gear' }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.url).toBe('http://example.com/gear');
  });

  // NO REWRITING: the README's "No affiliate link rewriting" commitment, tested at the
  // parser boundary. A URL with tracking-shaped query params must come back byte-for-
  // byte identical, not stripped, reordered, or otherwise "cleaned up".
  it('stores a URL with tracking parameters exactly as typed, never stripped', () => {
    const withTracking = 'https://rei.com/product/123?utm_source=affiliate&ref=xyz';
    const result = parseForm(formData({ url: withTracking }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.url).toBe(withTracking);
  });

  it('does not normalise a URL missing a trailing slash into one that has it', () => {
    // new URL('https://example.com').href is 'https://example.com/' — if this parser
    // stored `.href` instead of the original string, this assertion would catch it.
    const result = parseForm(formData({ url: 'https://example.com' }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.url).toBe('https://example.com');
  });

  // The hostile case named explicitly in the ticket: a javascript: URL rendered into
  // an <a href> is stored XSS, and gear_items.url has no CHECK constraint of its own —
  // this parser is the only thing standing between this string and that anchor tag.
  it('rejects a javascript: URL', () => {
    const result = parseForm(formData({ url: 'javascript:alert(1)' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.url).toBeTruthy();
  });

  it('rejects a data: URL', () => {
    const result = parseForm(formData({ url: 'data:text/html,<script>alert(1)</script>' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.url).toBeTruthy();
  });

  it('rejects a file: URL', () => {
    const result = parseForm(formData({ url: 'file:///etc/passwd' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.url).toBeTruthy();
  });

  it('rejects a scheme-less value that is not a parseable URL', () => {
    const result = parseForm(formData({ url: 'rei.com/product/123' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.url).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// brand, category, description, notes — optional free text, '' -> null
// ---------------------------------------------------------------------------

describe('parseGearItemForm: optional free text', () => {
  it('trims and keeps a non-empty brand', () => {
    const result = parseForm(formData({ brand: '  Osprey  ' }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.brand).toBe('Osprey');
  });

  it('an empty brand becomes null, not the empty string', () => {
    const result = parseForm(formData({ brand: '' }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.brand).toBeNull();
  });

  it('a whitespace-only brand also becomes null', () => {
    const result = parseForm(formData({ brand: '   ' }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.brand).toBeNull();
  });

  it('an empty category becomes null', () => {
    const result = parseForm(formData({ category: '' }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.category).toBeNull();
  });

  it('an empty description becomes null', () => {
    const result = parseForm(formData({ description: '' }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.description).toBeNull();
  });

  it('an empty notes becomes null', () => {
    const result = parseForm(formData({ notes: '' }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.notes).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Failure returns the raw values back, for re-rendering
// ---------------------------------------------------------------------------

describe('parseGearItemForm: failure carries the raw typed values back', () => {
  it('returns exactly what was submitted, not the trimmed/parsed version, so the form is not cleared', () => {
    const result = parseForm(formData({ name: '', brand: '  Osprey  ' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // The raw, untrimmed value survives — proves the page can re-render precisely
      // what the visitor typed rather than a normalised version of it.
      expect(result.values.brand).toBe('  Osprey  ');
      expect(result.values.name).toBe('');
    }
  });

  it('every field of GearFormValues is present on failure, even ones that were valid', () => {
    const result = parseForm(formData({ name: '' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // GEAR_FORM_FIELD's VALUES are the gear_items column names GearFormValues is
      // keyed by (its own KEYS are camelCase where the column is not, e.g. acquiredOn for
      // acquired_on) — this
      // compares against the column names, which is what result.values is actually
      // keyed by.
      expect(Object.keys(result.values).sort()).toEqual(Object.values(GEAR_FORM_FIELD).sort());
    }
  });
});

// ---------------------------------------------------------------------------
// GEAR_FORM_FIELD names line up with what parseGearItemForm actually reads
// ---------------------------------------------------------------------------

describe('GEAR_FORM_FIELD', () => {
  it('every declared field name is one parseGearItemForm actually reads', () => {
    const form = formData({ name: 'Field Test' });
    const result = parseForm(form);
    expect(result.ok).toBe(true);
    // If a GEAR_FORM_FIELD entry ever drifted from the key parseGearItemForm reads
    // with form.get(), the corresponding value below would be '' instead of what
    // formData() set it to — this is a canary for that drift.
    expect(form.get(GEAR_FORM_FIELD.name)).toBe('Field Test');
  });
});

// ---------------------------------------------------------------------------
// gearItemToFormValues: the inverse, for the edit form
// ---------------------------------------------------------------------------

describe('gearItemToFormValues', () => {
  const FULL_ROW: GearItemRow = {
    name: 'Tent',
    brand: 'Example Co',
    category: 'Shelter',
    description: 'A tent.',
    weight_grams: 2500,
    price: 199.99,
    currency: 'GBP',
    acquired_on: '2026-08-13',
    url: 'https://example.com/tent',
    notes: 'Bought secondhand.',
    status: 'owned',
    quantity: 1,
  };

  it('renders every field to a string form re-parses back to the same value', () => {
    const values = gearItemToFormValues(FULL_ROW, 'metric');
    const reparsed = parseForm(formData(values));
    expect(reparsed.ok).toBe(true);
    if (reparsed.ok) {
      expect(reparsed.values.name).toBe(FULL_ROW.name);
      expect(reparsed.values.weight_grams).toBe(FULL_ROW.weight_grams);
      expect(reparsed.values.price).toBe(FULL_ROW.price);
      expect(reparsed.values.currency).toBe(FULL_ROW.currency);
      expect(reparsed.values.acquired_on).toBe(FULL_ROW.acquired_on);
    }
  });

  it('renders a null price as an empty string, not the string "null"', () => {
    const values = gearItemToFormValues({ ...FULL_ROW, price: null, currency: null }, 'metric');
    expect(values.price).toBe('');
    expect(values.currency).toBe('');
  });

  it('renders a null acquired_on as an empty string, not the literal "null"', () => {
    const values = gearItemToFormValues({ ...FULL_ROW, acquired_on: null }, 'metric');
    expect(values.acquired_on).toBe('');
  });

  it('renders a null brand/category/description/notes/url as an empty string, never the literal "null"', () => {
    const values = gearItemToFormValues(
      {
        ...FULL_ROW,
        brand: null,
        category: null,
        description: null,
        notes: null,
        url: null,
      },
      'metric',
    );
    expect(values.brand).toBe('');
    expect(values.category).toBe('');
    expect(values.description).toBe('');
    expect(values.notes).toBe('');
    expect(values.url).toBe('');
  });

  // A weight of 4.4 must come back as '4.4', not '4.400' — WEIGHT_DECIMALS is the
  // storage precision, not a fixed display width; a caller that padded here would
  // show a value the user never entered.
  it('renders weight without padding to WEIGHT_DECIMALS', () => {
    const values = gearItemToFormValues({ ...FULL_ROW, weight_grams: 4.4 }, 'metric');
    expect(values.weight).toBe('4.4');
  });

  /**
   * PK-67: the edit form is filled in the account's BASE unit, not the unit the closet
   * scales the same row to. This is the case the ticket calls out so it is not later filed
   * as a bug — 2500 g is `2.5 kg` in the list and `2500` in the form.
   */
  it('fills the form in the base unit rather than the scaled one', () => {
    expect(gearItemToFormValues(FULL_ROW, 'metric').weight).toBe('2500');
  });

  /**
   * And the imperial half, which is the one with arithmetic in it. 124.738 g is what the
   * form stores for a typed `4.4` under an imperial account, so reading it back must
   * produce `'4.4'` again and not `'4.400000000000001'` — the round trip `roundWeight`
   * inside `gearItemToFormValues` exists to make exact.
   */
  it('reads an imperial row back as the ounces figure that was typed', () => {
    expect(gearItemToFormValues({ ...FULL_ROW, weight_grams: 124.738 }, 'imperial').weight).toBe(
      '4.4',
    );
  });
});

// ---------------------------------------------------------------------------
// EMPTY_GEAR_FORM_VALUES: the blank state src/pages/gear/new.astro renders on GET
// ---------------------------------------------------------------------------

describe('EMPTY_GEAR_FORM_VALUES', () => {
  it('parses successfully once a name is filled in — the three pre-filled defaults are already valid', () => {
    // name is the one not-null field EMPTY_GEAR_FORM_VALUES leaves blank on purpose
    // (there is no honest default for it) — everything else must already be
    // acceptable to parseGearItemForm exactly as shipped, since that is what the very
    // first render of the "add gear" form submits if the visitor changes nothing else.
    const result = parseForm(formData({ ...EMPTY_GEAR_FORM_VALUES, name: 'Tent' }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.values.quantity).toBe(1);
      expect(result.values.weight_grams).toBe(0);
      expect(result.values.status).toBe('owned');
    }
  });

  it('fails only on the blank name when submitted completely unchanged', () => {
    const result = parseForm(formData(EMPTY_GEAR_FORM_VALUES));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(Object.keys(result.errors)).toEqual(['name']);
    }
  });
});

// ---------------------------------------------------------------------------
// rawGearFormValues
// ---------------------------------------------------------------------------

describe('rawGearFormValues', () => {
  it('reads every field back as a bare string, with no validation at all', () => {
    const form = formData({ ...VALID, quantity: 'not-a-number', weight: '-5' });
    const values = rawGearFormValues(form);
    expect(values.quantity).toBe('not-a-number');
    expect(values.weight).toBe('-5');
    expect(values.name).toBe(VALID.name);
  });

  it('agrees with the `values` a failed parseGearItemForm returns for the same form', () => {
    const form = formData({ ...VALID, name: '' });
    const result = parseForm(form);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(rawGearFormValues(form)).toEqual(result.values);
    }
  });

  it('reads a missing field as an empty string, not the literal "null"', () => {
    const values = rawGearFormValues(formDataMissing('brand'));
    expect(values.brand).toBe('');
  });
});
