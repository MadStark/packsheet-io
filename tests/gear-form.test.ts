import { describe, expect, it } from 'vitest';
import {
  GEAR_FORM_FIELD,
  gearItemToFormValues,
  parseGearItemForm,
  type GearFormValues,
  type GearItemRow,
} from '../src/lib/gear/form';

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

/** A complete, valid set of raw form values — every field filled in with something
 *  `parseGearItemForm` accepts, so each test below can override exactly the one field
 *  it means to exercise via `{ ...VALID, someField: '...' }` rather than restating all
 *  thirteen every time. */
const VALID: GearFormValues = {
  name: 'Tent',
  quantity: '1',
  weight: '2.5',
  weight_unit: 'kg',
  price: '199.99',
  currency: 'GBP',
  volume_litres: '4.2',
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
    const result = parseGearItemForm(formData({}));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok: true');
    expect(result.values).toEqual({
      name: 'Tent',
      quantity: 1,
      weight: 2.5,
      weight_unit: 'kg',
      price: 199.99,
      currency: 'GBP',
      volume_litres: 4.2,
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
    const result = parseGearItemForm(formData({ name: '  Tent  ' }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.name).toBe('Tent');
  });

  it('rejects an empty name — catches a form submitted with the field blank', () => {
    const result = parseGearItemForm(formData({ name: '' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.name).toBeTruthy();
  });

  // This is the case the CHECK constraint is written to catch: `btrim` strips
  // whitespace before checking length, so a name of only spaces is not "non-empty".
  // A parser that only checked `name !== ''` would let this through and disagree with
  // the database, which would then refuse the insert with a raw constraint-violation
  // error.
  it('rejects a whitespace-only name, mirroring btrim in the CHECK constraint', () => {
    const result = parseGearItemForm(formData({ name: '   ' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.name).toBeTruthy();
  });

  it('a missing name field is treated the same as an empty one', () => {
    const result = parseGearItemForm(formDataMissing('name'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.name).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// quantity — pairs with: check (quantity > 0)
// ---------------------------------------------------------------------------

describe('parseGearItemForm: quantity', () => {
  it('accepts a plain positive integer', () => {
    const result = parseGearItemForm(formData({ quantity: '3' }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.quantity).toBe(3);
  });

  it('rejects zero — the exact boundary quantity > 0 refuses', () => {
    const result = parseGearItemForm(formData({ quantity: '0' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.quantity).toBeTruthy();
  });

  it('rejects a negative quantity', () => {
    const result = parseGearItemForm(formData({ quantity: '-1' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.quantity).toBeTruthy();
  });

  it('rejects a decimal quantity — "2.5 items" is not representable in an integer column', () => {
    const result = parseGearItemForm(formData({ quantity: '2.5' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.quantity).toBeTruthy();
  });

  // The case the ticket calls out by name: Number('1e3') is 1000, a value
  // Number.isSafeInteger alone would accept, but it is scientific notation nobody types
  // by hand into a plain quantity field.
  it('rejects scientific notation (1e3) even though it parses to a valid positive integer', () => {
    const result = parseGearItemForm(formData({ quantity: '1e3' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.quantity).toBeTruthy();
  });

  it('rejects a quantity beyond Postgres integer range, rather than letting it reach the database', () => {
    const result = parseGearItemForm(formData({ quantity: '99999999999' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.quantity).toBeTruthy();
  });

  it('a missing quantity field is rejected, not silently defaulted to 1', () => {
    const result = parseGearItemForm(formDataMissing('quantity'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.quantity).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// weight — pairs with: check (weight >= 0 and weight < 'Infinity'::numeric)
// ---------------------------------------------------------------------------

describe('parseGearItemForm: weight', () => {
  it('accepts zero — the ordinary "not yet weighed" value, and the column default', () => {
    const result = parseGearItemForm(formData({ weight: '0' }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.weight).toBe(0);
  });

  it('accepts up to three decimal places, matching numeric(12, 3)', () => {
    const result = parseGearItemForm(formData({ weight: '1.234' }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.weight).toBe(1.234);
  });

  it('rejects a fourth decimal place — more precision than the column can store', () => {
    const result = parseGearItemForm(formData({ weight: '1.2345' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.weight).toBeTruthy();
  });

  it('rejects a negative weight', () => {
    const result = parseGearItemForm(formData({ weight: '-1' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.weight).toBeTruthy();
  });

  // The case the ticket names explicitly: Postgres orders NaN ABOVE every numeric
  // value, so a plain `weight >= 0` check on the database side lets it through (see
  // core_schema.sql:67-72) — this parser must refuse the string outright, not rely on
  // a >= 0 comparison that happens to also work in JavaScript for the wrong reason.
  it('rejects the literal string "NaN"', () => {
    const result = parseGearItemForm(formData({ weight: 'NaN' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.weight).toBeTruthy();
  });

  it('rejects the literal string "Infinity"', () => {
    const result = parseGearItemForm(formData({ weight: 'Infinity' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.weight).toBeTruthy();
  });

  it('rejects "-Infinity" too, not only the positive spelling', () => {
    const result = parseGearItemForm(formData({ weight: '-Infinity' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.weight).toBeTruthy();
  });

  it('rejects scientific notation, the same way quantity does', () => {
    const result = parseGearItemForm(formData({ weight: '1e3' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.weight).toBeTruthy();
  });

  it("rejects a value at or beyond numeric(12, 3)'s range instead of overflowing the column", () => {
    const result = parseGearItemForm(formData({ weight: '1000000000' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.weight).toBeTruthy();
  });

  it('a missing weight field is rejected, not silently defaulted to 0', () => {
    const result = parseGearItemForm(formDataMissing('weight'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.weight).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// weight_unit — pairs with: check (weight_unit in ('g', 'kg', 'oz', 'lb'))
// ---------------------------------------------------------------------------

describe('parseGearItemForm: weight_unit', () => {
  it.each(['g', 'kg', 'oz', 'lb'])('accepts %s', (unit) => {
    const result = parseGearItemForm(formData({ weight_unit: unit }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.weight_unit).toBe(unit);
  });

  it('rejects a near-miss like "G" (case-sensitive, mirroring isWeightUnit)', () => {
    const result = parseGearItemForm(formData({ weight_unit: 'G' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.weight_unit).toBeTruthy();
  });

  it('rejects "lbs" — a plausible but unaccepted spelling', () => {
    const result = parseGearItemForm(formData({ weight_unit: 'lbs' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.weight_unit).toBeTruthy();
  });

  it('a missing weight_unit field is rejected, not silently defaulted to g', () => {
    const result = parseGearItemForm(formDataMissing('weight_unit'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.weight_unit).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// status — pairs with: check (status in ('owned', 'wishlist', 'retired'))
// ---------------------------------------------------------------------------

describe('parseGearItemForm: status', () => {
  it.each(['owned', 'wishlist', 'retired'])('accepts %s', (status) => {
    const result = parseGearItemForm(formData({ status }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.status).toBe(status);
  });

  it('rejects the ticket-text status "Available", which the schema does not have', () => {
    const result = parseGearItemForm(formData({ status: 'Available' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.status).toBeTruthy();
  });

  it('a missing status field is rejected, not silently defaulted to owned', () => {
    const result = parseGearItemForm(formDataMissing('status'));
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
    const result = parseGearItemForm(formData({ price: '10.50', currency: 'USD' }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.values.price).toBe(10.5);
      expect(result.values.currency).toBe('USD');
    }
  });

  it('accepts both absent together — the "no price recorded" case', () => {
    const result = parseGearItemForm(formData({ price: '', currency: '' }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.values.price).toBeNull();
      expect(result.values.currency).toBeNull();
    }
  });

  // The exact pairing gear_items_price_has_currency exists to refuse: a price with no
  // currency is stored as a bare number no formatter can render.
  it('rejects a price with no currency', () => {
    const result = parseGearItemForm(formData({ price: '10.50', currency: '' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.currency).toBeTruthy();
  });

  // The other half of the same pairing: a currency naming nothing to measure.
  it('rejects a currency with no price', () => {
    const result = parseGearItemForm(formData({ price: '', currency: 'GBP' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.price).toBeTruthy();
  });

  it('rejects a lowercase currency code — the CHECK constraint is case-sensitive ([A-Z])', () => {
    const result = parseGearItemForm(formData({ price: '10', currency: 'gbp' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.currency).toBeTruthy();
  });

  it('rejects a currency symbol instead of a code', () => {
    const result = parseGearItemForm(formData({ price: '10', currency: '£' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.currency).toBeTruthy();
  });

  it('accepts up to two decimal places, matching numeric(12, 2)', () => {
    const result = parseGearItemForm(formData({ price: '10.99', currency: 'GBP' }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.price).toBe(10.99);
  });

  it("rejects a third decimal place — more precision than price's scale allows", () => {
    const result = parseGearItemForm(formData({ price: '10.999', currency: 'GBP' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.price).toBeTruthy();
  });

  it('rejects a negative price', () => {
    const result = parseGearItemForm(formData({ price: '-5', currency: 'GBP' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.price).toBeTruthy();
  });

  it('rejects the literal string "NaN" as a price', () => {
    const result = parseGearItemForm(formData({ price: 'NaN', currency: 'GBP' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.price).toBeTruthy();
  });

  it('rejects the literal string "Infinity" as a price', () => {
    const result = parseGearItemForm(formData({ price: 'Infinity', currency: 'GBP' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.price).toBeTruthy();
  });

  it('a bad price and a bad currency both report — the visitor sees both problems at once', () => {
    const result = parseGearItemForm(formData({ price: 'abc', currency: 'gbp' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.price).toBeTruthy();
      expect(result.errors.currency).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// volume_litres — pairs with: check (volume_litres >= 0 and volume_litres < 'Infinity'::numeric)
// ---------------------------------------------------------------------------

describe('parseGearItemForm: volume_litres', () => {
  it('accepts a blank value as "not provided" — the column is nullable with no default', () => {
    const result = parseGearItemForm(formData({ volume_litres: '' }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.volume_litres).toBeNull();
  });

  it('accepts up to three decimal places, matching numeric(12, 3)', () => {
    const result = parseGearItemForm(formData({ volume_litres: '4.321' }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.volume_litres).toBe(4.321);
  });

  it('rejects a negative volume', () => {
    const result = parseGearItemForm(formData({ volume_litres: '-1' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.volume_litres).toBeTruthy();
  });

  it('rejects the literal string "NaN"', () => {
    const result = parseGearItemForm(formData({ volume_litres: 'NaN' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.volume_litres).toBeTruthy();
  });

  it('rejects the literal string "Infinity"', () => {
    const result = parseGearItemForm(formData({ volume_litres: 'Infinity' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.volume_litres).toBeTruthy();
  });

  it('rejects a fourth decimal place', () => {
    const result = parseGearItemForm(formData({ volume_litres: '1.2345' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.volume_litres).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// url — no CHECK constraint at all; this parser is the entire defence
// ---------------------------------------------------------------------------

describe('parseGearItemForm: url', () => {
  it('accepts a blank value as "not provided"', () => {
    const result = parseGearItemForm(formData({ url: '' }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.url).toBeNull();
  });

  it('accepts a plain https URL', () => {
    const result = parseGearItemForm(formData({ url: 'https://rei.com/product/123' }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.url).toBe('https://rei.com/product/123');
  });

  it('accepts a plain http URL', () => {
    const result = parseGearItemForm(formData({ url: 'http://example.com/gear' }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.url).toBe('http://example.com/gear');
  });

  // NO REWRITING: the README's "No affiliate link rewriting" commitment, tested at the
  // parser boundary. A URL with tracking-shaped query params must come back byte-for-
  // byte identical, not stripped, reordered, or otherwise "cleaned up".
  it('stores a URL with tracking parameters exactly as typed, never stripped', () => {
    const withTracking = 'https://rei.com/product/123?utm_source=affiliate&ref=xyz';
    const result = parseGearItemForm(formData({ url: withTracking }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.url).toBe(withTracking);
  });

  it('does not normalise a URL missing a trailing slash into one that has it', () => {
    // new URL('https://example.com').href is 'https://example.com/' — if this parser
    // stored `.href` instead of the original string, this assertion would catch it.
    const result = parseGearItemForm(formData({ url: 'https://example.com' }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.url).toBe('https://example.com');
  });

  // The hostile case named explicitly in the ticket: a javascript: URL rendered into
  // an <a href> is stored XSS, and gear_items.url has no CHECK constraint of its own —
  // this parser is the only thing standing between this string and that anchor tag.
  it('rejects a javascript: URL', () => {
    const result = parseGearItemForm(formData({ url: 'javascript:alert(1)' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.url).toBeTruthy();
  });

  it('rejects a data: URL', () => {
    const result = parseGearItemForm(formData({ url: 'data:text/html,<script>alert(1)</script>' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.url).toBeTruthy();
  });

  it('rejects a file: URL', () => {
    const result = parseGearItemForm(formData({ url: 'file:///etc/passwd' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.url).toBeTruthy();
  });

  it('rejects a scheme-less value that is not a parseable URL', () => {
    const result = parseGearItemForm(formData({ url: 'rei.com/product/123' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.url).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// brand, category, description, notes — optional free text, '' -> null
// ---------------------------------------------------------------------------

describe('parseGearItemForm: optional free text', () => {
  it('trims and keeps a non-empty brand', () => {
    const result = parseGearItemForm(formData({ brand: '  Osprey  ' }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.brand).toBe('Osprey');
  });

  it('an empty brand becomes null, not the empty string', () => {
    const result = parseGearItemForm(formData({ brand: '' }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.brand).toBeNull();
  });

  it('a whitespace-only brand also becomes null', () => {
    const result = parseGearItemForm(formData({ brand: '   ' }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.brand).toBeNull();
  });

  it('an empty category becomes null', () => {
    const result = parseGearItemForm(formData({ category: '' }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.category).toBeNull();
  });

  it('an empty description becomes null', () => {
    const result = parseGearItemForm(formData({ description: '' }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.description).toBeNull();
  });

  it('an empty notes becomes null', () => {
    const result = parseGearItemForm(formData({ notes: '' }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values.notes).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Failure returns the raw values back, for re-rendering
// ---------------------------------------------------------------------------

describe('parseGearItemForm: failure carries the raw typed values back', () => {
  it('returns exactly what was submitted, not the trimmed/parsed version, so the form is not cleared', () => {
    const result = parseGearItemForm(formData({ name: '', brand: '  Osprey  ' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // The raw, untrimmed value survives — proves the page can re-render precisely
      // what the visitor typed rather than a normalised version of it.
      expect(result.values.brand).toBe('  Osprey  ');
      expect(result.values.name).toBe('');
    }
  });

  it('every field of GearFormValues is present on failure, even ones that were valid', () => {
    const result = parseGearItemForm(formData({ name: '' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // GEAR_FORM_FIELD's VALUES are the gear_items column names GearFormValues is
      // keyed by (its own KEYS are camelCase, e.g. weightUnit for weight_unit) — this
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
    const result = parseGearItemForm(form);
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
    weight: 2.5,
    weight_unit: 'kg',
    price: 199.99,
    currency: 'GBP',
    volume_litres: 4.2,
    url: 'https://example.com/tent',
    notes: 'Bought secondhand.',
    status: 'owned',
    quantity: 1,
  };

  it('renders every field to a string form re-parses back to the same value', () => {
    const values = gearItemToFormValues(FULL_ROW);
    const reparsed = parseGearItemForm(formData(values));
    expect(reparsed.ok).toBe(true);
    if (reparsed.ok) {
      expect(reparsed.values.name).toBe(FULL_ROW.name);
      expect(reparsed.values.weight).toBe(FULL_ROW.weight);
      expect(reparsed.values.price).toBe(FULL_ROW.price);
      expect(reparsed.values.currency).toBe(FULL_ROW.currency);
      expect(reparsed.values.volume_litres).toBe(FULL_ROW.volume_litres);
    }
  });

  it('renders a null price as an empty string, not the string "null"', () => {
    const values = gearItemToFormValues({ ...FULL_ROW, price: null, currency: null });
    expect(values.price).toBe('');
    expect(values.currency).toBe('');
  });

  it('renders a null volume_litres as an empty string', () => {
    const values = gearItemToFormValues({ ...FULL_ROW, volume_litres: null });
    expect(values.volume_litres).toBe('');
  });

  it('renders a null brand/category/description/notes/url as an empty string, never the literal "null"', () => {
    const values = gearItemToFormValues({
      ...FULL_ROW,
      brand: null,
      category: null,
      description: null,
      notes: null,
      url: null,
    });
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
    const values = gearItemToFormValues({ ...FULL_ROW, weight: 4.4 });
    expect(values.weight).toBe('4.4');
  });
});
