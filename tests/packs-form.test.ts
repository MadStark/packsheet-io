import { describe, it, expect } from 'vitest';
import {
  EMPTY_CUSTOM_PACK_ITEM_FORM_VALUES,
  EMPTY_PACK_FORM_VALUES,
  EMPTY_PACK_ITEM_FORM_VALUES,
  packItemToFormValues,
  packToFormValues,
  parseCustomPackItemForm,
  parsePackCategoryForm,
  parsePackForm,
  parsePackItemForm,
  rawCustomPackItemFormValues,
  rawPackFormValues,
} from '../src/lib/packs/form';
import {
  PACK_ITEM_CARRIAGES,
  PACK_ITEM_CARRIAGE_LABELS,
  PACK_ITEM_CARRIAGE_MEANINGS,
  carriageFlags,
  isPackItemCarriage,
  packItemCarriage,
} from '../src/lib/packs/fields';
import { GRAMS_PER_UNIT, roundWeight, toGrams } from '../src/lib/units';

/**
 * The pure validation behind pack list composition's four forms (PK-37).
 *
 * Every assertion here is against `src/lib/packs/form.ts` and the carriage vocabulary in
 * `src/lib/packs/fields.ts` — no database, no client, no `FormData` that a browser could
 * not produce. The real-database half of this ticket lives in `tests/packs-mutations.test.ts`
 * and is a different kind of test on purpose: the rules below are decisions this codebase
 * makes, and pinning them here means a change to one fails in the file that states it
 * rather than three layers away in a pack that will not load.
 *
 * WHY THESE RULES CANNOT BE TESTED WHERE THEY WOULD OTHERWISE HAVE BEEN WRITTEN.
 * `vitest.config.ts:64` excludes `src/pages/`, so validation living in `.astro` frontmatter
 * is validation no test can execute — the defect PK-4's independent review found by mutation
 * testing the gear pages. That is the whole reason `src/lib/packs/form.ts` exists as a
 * module, and this file is the other half of that arrangement.
 *
 * THE TWO ASSERTIONS THAT ARE ACCEPTANCE CRITERIA rather than ordinary coverage, called out
 * so nobody deletes them as redundant:
 *
 *   - "worn and consumable cannot both be set from the UI" — asserted structurally, over
 *     every member of `PACK_ITEM_CARRIAGES`, and against a hostile submission that carries
 *     literal `worn`/`consumable` fields.
 *   - An unrecognised `trip_type` survives a round trip byte-identically. `packs.trip_type`
 *     is deliberately unconstrained so imported packs (PK-33, PK-65) keep their own
 *     vocabulary; a parser that "validated" it against `PACK_TRIP_TYPES` would silently eat
 *     imported data, which is the failure `src/lib/packs/fields.ts`' header describes at
 *     length.
 */

/** Builds a `FormData` from plain entries, including repeated keys — the shape a real
 *  submission has. Values are appended rather than set so a test can express the
 *  submitted-twice case `getFormString` documents. */
function formData(entries: Record<string, string | string[]>): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(entries)) {
    if (Array.isArray(value)) {
      for (const v of value) form.append(key, v);
    } else {
      form.append(key, value);
    }
  }
  return form;
}

// ---------------------------------------------------------------------------
// parsePackForm
// ---------------------------------------------------------------------------

describe('parsePackForm', () => {
  it('accepts a pack with only a name, leaving the nullable fields null', () => {
    const result = parsePackForm(formData({ name: 'Cairngorms winter' }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.values).toEqual({
      name: 'Cairngorms winter',
      description: null,
      trip_type: null,
    });
  });

  // pairs with: packs.name check (length(btrim(name)) > 0) — core_schema.sql:130
  it.each([
    ['absent', {}],
    ['empty', { name: '' }],
    ['whitespace only', { name: '   \t \n ' }],
  ])('refuses a name that is %s, the way btrim() in the constraint does', (_label, entries) => {
    const result = parsePackForm(formData(entries));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.name).toBeTruthy();
    // Not a raw Postgres string. A visitor reads this sentence.
    expect(result.errors.name).not.toMatch(/check constraint|btrim|null value/i);
  });

  it('stores the trimmed name, not the name as typed', () => {
    const result = parsePackForm(formData({ name: '  Ultralight  ' }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Storing it untrimmed would pass the constraint (which btrims before checking) and
    // leave two packs that look identical on screen sorting apart in every list.
    expect(result.values.name).toBe('Ultralight');
  });

  it('turns blank description and trip type into null rather than empty strings', () => {
    const result = parsePackForm(formData({ name: 'A', description: '  ', trip_type: '' }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.values.description).toBeNull();
    expect(result.values.trip_type).toBeNull();
  });

  /**
   * THE IMPORT GUARD. `packs.trip_type` carries no CHECK constraint, no enum and no lookup
   * table, and `PACK_TRIP_TYPES` is a UI convenience — see that constant's header for what
   * depends on the column staying unconstrained. A parser that rejected or blanked an
   * unrecognised value would eat exactly the data PK-33/PK-65 import.
   */
  it.each(['PCT section hike', 'Bikepack - gravel', 'vacaciones', 'Winter'])(
    'preserves the unrecognised trip type %j byte-identically',
    (tripType) => {
      const result = parsePackForm(formData({ name: 'Imported', trip_type: tripType }));

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.values.trip_type).toBe(tripType);
    },
  );

  it('keeps a curated trip type as its stored slug, not its label', () => {
    const result = parsePackForm(formData({ name: 'A', trip_type: 'thru-hike' }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.values.trip_type).toBe('thru-hike');
  });

  it('hands back exactly what the visitor typed when it refuses the submission', () => {
    const entries = { name: '   ', description: '  keep me  ', trip_type: ' Winter ' };
    const result = parsePackForm(formData(entries));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Untrimmed and unvalidated, so the re-rendered form shows their own input back rather
    // than clearing it or showing a value validation already reformatted.
    expect(result.values).toEqual(entries);
    expect(result.values).toEqual(rawPackFormValues(formData(entries)));
  });

  it('never throws on a hostile or malformed submission', () => {
    const form = new FormData();
    form.append('name', new File([], 'name.txt'));
    form.append('description', 'ok');

    expect(() => parsePackForm(form)).not.toThrow();
    // The File folds to '' — the documented coercion in getFormString — so this reads as a
    // missing name rather than as a type error.
    expect(parsePackForm(form).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parsePackCategoryForm
// ---------------------------------------------------------------------------

describe('parsePackCategoryForm', () => {
  // pairs with: pack_categories.name check (length(btrim(name)) > 0) — core_schema.sql:211
  it('refuses a blank or whitespace-only name', () => {
    expect(parsePackCategoryForm(formData({ name: '' })).ok).toBe(false);
    expect(parsePackCategoryForm(formData({ name: '  ' })).ok).toBe(false);
  });

  it('trims an accepted name', () => {
    const result = parsePackCategoryForm(formData({ name: ' Shelter ' }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.values).toEqual({ name: 'Shelter' });
  });

  it('says which thing is missing a name, rather than reusing the pack message', () => {
    const pack = parsePackForm(formData({ name: '' }));
    const category = parsePackCategoryForm(formData({ name: '' }));

    expect(pack.ok).toBe(false);
    expect(category.ok).toBe(false);
    if (pack.ok || category.ok) return;
    // Two constraints on two tables that happen to be spelled the same. A visitor told
    // "enter a name" needs to know which one.
    expect(category.errors.name).not.toBe(pack.errors.name);
  });

  it('accepts a name a sibling category already has', () => {
    // pack_categories.name is not unique and must not be treated as though it were — see
    // duplicate_pack's comment on why matching categories back up by name is the trap.
    const first = parsePackCategoryForm(formData({ name: 'Extras' }));
    const second = parsePackCategoryForm(formData({ name: 'Extras' }));

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The carriage vocabulary
// ---------------------------------------------------------------------------

describe('the three-way carriage vocabulary', () => {
  /**
   * THE ACCEPTANCE CRITERION, ASSERTED STRUCTURALLY. `carriageFlags` is the only thing in
   * the codebase that produces the `(worn, consumable)` pair from a form, so "an item cannot
   * be made worn and consumable at once through the form layer" is exactly the claim that no
   * member of `PACK_ITEM_CARRIAGES` maps to both. Enumerating the constant rather than
   * listing three cases by hand means a fourth value added without deciding its flags fails
   * here as well as at the compiler.
   */
  it.each(PACK_ITEM_CARRIAGES)('%s never sets both worn and consumable', (carriage) => {
    const flags = carriageFlags(carriage);

    expect(flags.worn && flags.consumable).toBe(false);
  });

  it('maps each of the three to the pair pack_items actually stores', () => {
    expect(carriageFlags('carried')).toEqual({ worn: false, consumable: false });
    expect(carriageFlags('worn')).toEqual({ worn: true, consumable: false });
    expect(carriageFlags('consumable')).toEqual({ worn: false, consumable: true });
  });

  it('round-trips every value through the two columns and back', () => {
    for (const carriage of PACK_ITEM_CARRIAGES) {
      expect(packItemCarriage(carriageFlags(carriage))).toBe(carriage);
    }
  });

  it('refuses to read a row flagged both, rather than picking a winner', () => {
    // pack_items_worn_consumable_exclusive makes this unreachable from the database, and
    // classifyPackItem in src/lib/totals.ts refuses the same row for the same reason: there
    // is no correct answer, and showing one would let a visitor save the silent repair.
    expect(() => packItemCarriage({ worn: true, consumable: true })).toThrow(TypeError);
    expect(() => packItemCarriage({ worn: true, consumable: true })).toThrow(
      /pack_items_worn_consumable_exclusive/,
    );
  });

  it('narrows only the three values, unlike isPackTripType', () => {
    for (const carriage of PACK_ITEM_CARRIAGES) expect(isPackItemCarriage(carriage)).toBe(true);
    for (const other of ['', 'Worn', 'base', 'packed', null, undefined, 3]) {
      expect(isPackItemCarriage(other)).toBe(false);
    }
  });

  it('has a label and a meaning for every value', () => {
    for (const carriage of PACK_ITEM_CARRIAGES) {
      expect(PACK_ITEM_CARRIAGE_LABELS[carriage]).toBeTruthy();
      expect(PACK_ITEM_CARRIAGE_MEANINGS[carriage]).toBeTruthy();
    }
    // The label a visitor picks by must not be the raw value: 'carried' would read as true
    // of a worn item too, which is why it is labelled "In the pack".
    expect(PACK_ITEM_CARRIAGE_LABELS.carried).not.toBe('carried');
  });
});

// ---------------------------------------------------------------------------
// parsePackItemForm
// ---------------------------------------------------------------------------

describe('parsePackItemForm', () => {
  it('accepts the blank-state values the form renders on a first paint', () => {
    const result = parsePackItemForm(formData({ ...EMPTY_PACK_ITEM_FORM_VALUES }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.values).toEqual({
      quantity: 1,
      worn: false,
      consumable: false,
      packed: false,
    });
  });

  // pairs with: quantity integer not null default 1 check (quantity > 0)
  it('resolves a blank quantity to the column default rather than erroring', () => {
    const result = parsePackItemForm(formData({ quantity: '  ', carriage: 'carried' }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.values.quantity).toBe(1);
  });

  it.each(['0', '-1', '1.5', '1e3', 'abc', 'NaN', 'Infinity', '0x10', '99999999999'])(
    'refuses the non-blank quantity %j',
    (quantity) => {
      const result = parsePackItemForm(formData({ quantity, carriage: 'carried' }));

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors.quantity).toBeTruthy();
    },
  );

  /**
   * A blank carriage is the one field here that is NOT forgiven, even though both its
   * columns have a default — see `parsePackItemFields`' comment. A radio group with nothing
   * checked posts nothing, and silently recording "in the pack" for someone who meant "worn"
   * moves weight between two buckets they are looking at on screen.
   */
  it.each([
    ['absent', {}],
    ['empty', { carriage: '' }],
    ['not one of ours', { carriage: 'base' }],
    ['a label rather than a value', { carriage: 'In the pack' }],
  ])('refuses a carriage that is %s', (_label, entries) => {
    const result = parsePackItemForm(formData(entries));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.carriage).toBeTruthy();
  });

  it.each(PACK_ITEM_CARRIAGES)('writes the columns %s means', (carriage) => {
    const result = parsePackItemForm(formData({ carriage }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect({ worn: result.values.worn, consumable: result.values.consumable }).toEqual(
      carriageFlags(carriage),
    );
  });

  /**
   * THE ACCEPTANCE CRITERION AT THE PARSER'S OWN BOUNDARY. A hand-crafted submission
   * carrying both legacy field names cannot produce a both-true row, because neither name is
   * read: the single `carriage` field decides both columns. This is not validation catching
   * a bad combination — the combination is unrepresentable in this parser's input.
   */
  it('cannot be made worn and consumable at once, even by a hostile submission', () => {
    const worn = parsePackItemForm(
      formData({ carriage: 'worn', worn: 'on', consumable: 'on', quantity: '1' }),
    );
    const carried = parsePackItemForm(
      formData({ carriage: 'carried', worn: 'on', consumable: '1' }),
    );

    expect(worn.ok).toBe(true);
    expect(carried.ok).toBe(true);
    if (!worn.ok || !carried.ok) return;
    expect(worn.values).toMatchObject({ worn: true, consumable: false });
    expect(carried.values).toMatchObject({ worn: false, consumable: false });
  });

  // pairs with: packed boolean not null default false
  it.each(['on', 'true', '1', 'yes', 'ON', ' true '])('reads packed=%j as ticked', (packed) => {
    const result = parsePackItemForm(formData({ carriage: 'carried', packed }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.values.packed).toBe(true);
  });

  it.each([
    ['absent', {}],
    ['empty', { packed: '' }],
    ['the literal string false', { packed: 'false' }],
    ['off', { packed: 'off' }],
    ['zero', { packed: '0' }],
  ])('reads a packed field that is %s as unticked', (_label, entries) => {
    const result = parsePackItemForm(formData({ carriage: 'carried', ...entries }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 'false'/'off'/'0' are never posted by a checkbox, so reading them as TRUE — which any
    // non-empty-string test would — would be the exact opposite of what their author meant.
    expect(result.values.packed).toBe(false);
  });

  it('reports a bad quantity and a bad carriage from one submission', () => {
    const result = parsePackItemForm(formData({ quantity: '-2', carriage: '' }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(Object.keys(result.errors).sort()).toEqual(['carriage', 'quantity']);
  });
});

// ---------------------------------------------------------------------------
// parseCustomPackItemForm
// ---------------------------------------------------------------------------

describe('parseCustomPackItemForm', () => {
  const minimal = { name: 'Repair kit', carriage: 'carried' };

  it('accepts a custom item with only a name and a carriage', () => {
    const result = parseCustomPackItemForm(formData(minimal), 'metric');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.values).toEqual({
      name: 'Repair kit',
      brand: null,
      category: null,
      description: null,
      weight_grams: 0,
      price: null,
      currency: null,
      quantity: 1,
      worn: false,
      consumable: false,
      packed: false,
    });
  });

  /**
   * pairs with the snapshot column's own shape check —
   * `length(btrim(coalesce(snapshot ->> 'name', ''))) > 0`, core_schema.sql:289 — which is
   * the one custom-item field the database really does check. Rule 3 is that a pack item
   * must always be able to render itself, and a nameless one cannot.
   */
  it.each([
    ['absent', {}],
    ['empty', { name: '' }],
    ['whitespace only', { name: ' \t ' }],
  ])('refuses a snapshot name that is %s', (_label, entries) => {
    const result = parseCustomPackItemForm(formData({ carriage: 'carried', ...entries }), 'metric');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.name).toBeTruthy();
  });

  it('accepts the blank state the form renders, once a name is typed into it', () => {
    const result = parseCustomPackItemForm(
      formData({ ...EMPTY_CUSTOM_PACK_ITEM_FORM_VALUES, name: 'Spare batteries' }),
      'metric',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.values.weight_grams).toBe(0);
    expect(result.values.quantity).toBe(1);
  });

  it('resolves a blank weight to 0, the same default a gear row with no weight gets', () => {
    const result = parseCustomPackItemForm(formData({ ...minimal, weight: '' }), 'metric');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.values.weight_grams).toBe(0);
  });

  it('takes a metric account’s weight as grams, unconverted', () => {
    const result = parseCustomPackItemForm(formData({ ...minimal, weight: '124.738' }), 'metric');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.values.weight_grams).toBe(124.738);
  });

  it('converts an imperial account’s weight from ounces exactly once', () => {
    const result = parseCustomPackItemForm(formData({ ...minimal, weight: '4.4' }), 'imperial');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The single conversion at entry that src/lib/units.ts describes: 4.4 oz is
    // 124.73790175 g, rounded to the gram scale a gear row would have been stored at.
    expect(result.values.weight_grams).toBe(roundWeight(toGrams(4.4, 'oz')));
    expect(result.values.weight_grams).toBe(124.738);
  });

  it.each(['NaN', 'Infinity', '-1', '1e3', '0x10', '1.2345', 'heavy', '.5', '1,5'])(
    'refuses the weight %j',
    (weight) => {
      const result = parseCustomPackItemForm(formData({ ...minimal, weight }), 'metric');

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors.weight).toBeTruthy();
    },
  );

  it('accepts a weight typed with surrounding whitespace', () => {
    // The call site trims before parsing, so ' 12 ' is a visitor being untidy rather than a
    // malformed value — the same treatment parseGearItemForm gives its own weight field.
    // `Number(' 12 ')` parsing to 12 is a hazard for the PARSER, which is why
    // parseNonNegativeDecimal gates on a regexp; it is not a reason to refuse the visitor.
    const result = parseCustomPackItemForm(formData({ ...minimal, weight: ' 12 ' }), 'metric');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.values.weight_grams).toBe(12);
  });

  /**
   * The magnitude bound is applied to the number that would be STORED, not to the one that
   * was typed — which is why it is divided by the entry unit's factor. 100,000,000 oz is
   * comfortably under 1e9 as typed and is 2.8e9 g once converted, a figure no gear row could
   * hold. See SNAPSHOT_WEIGHT_EXCLUSIVE_MAX_GRAMS for why a jsonb key is held to a numeric
   * column's bound at all.
   */
  it('bounds the weight by what a gear row could hold, in the unit it will be stored in', () => {
    const metricOver = parseCustomPackItemForm(
      formData({ ...minimal, weight: '1000000000' }),
      'metric',
    );
    const metricUnder = parseCustomPackItemForm(
      formData({ ...minimal, weight: '999999999' }),
      'metric',
    );
    const imperialOver = parseCustomPackItemForm(
      formData({ ...minimal, weight: '100000000' }),
      'imperial',
    );

    expect(metricOver.ok).toBe(false);
    expect(metricUnder.ok).toBe(true);
    expect(imperialOver.ok).toBe(false);
    // And the imperial rejection is not the metric one in disguise: the typed number is well
    // under the gram bound, and only becomes over it after conversion.
    expect(100000000 * GRAMS_PER_UNIT.oz).toBeGreaterThan(10 ** 9);
  });

  it('accepts a price and a currency together', () => {
    const result = parseCustomPackItemForm(
      formData({ ...minimal, price: '42.50', currency: 'GBP' }),
      'metric',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.values.price).toBe(42.5);
    expect(result.values.currency).toBe('GBP');
  });

  /**
   * `resolvePrice` in src/lib/totals.ts THROWS on half a pair, which would make the whole
   * pack unrenderable rather than merely mispriced. `gear_items_price_has_currency` makes
   * that unrepresentable on a gear row; nothing makes it unrepresentable inside a snapshot,
   * so this check is the only thing keeping it out.
   */
  it('refuses half a price/currency pair, naming the half that is missing', () => {
    const noCurrency = parseCustomPackItemForm(formData({ ...minimal, price: '10' }), 'metric');
    const noPrice = parseCustomPackItemForm(formData({ ...minimal, currency: 'GBP' }), 'metric');

    expect(noCurrency.ok).toBe(false);
    expect(noPrice.ok).toBe(false);
    if (noCurrency.ok || noPrice.ok) return;
    expect(noCurrency.errors.currency).toBeTruthy();
    expect(noCurrency.errors.price).toBeUndefined();
    expect(noPrice.errors.price).toBeTruthy();
    expect(noPrice.errors.currency).toBeUndefined();
  });

  it.each(['gbp', 'GB', 'GBPP', '£', '123'])('refuses the currency %j', (currency) => {
    const result = parseCustomPackItemForm(
      formData({ ...minimal, price: '10', currency }),
      'metric',
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.currency).toBeTruthy();
  });

  it('leaves both price and currency null when neither is provided', () => {
    const result = parseCustomPackItemForm(formData(minimal), 'metric');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.values.price).toBeNull();
    expect(result.values.currency).toBeNull();
  });

  it('reports every bad field from one submission, not just the first', () => {
    const result = parseCustomPackItemForm(
      formData({ name: '', weight: 'NaN', price: '1.234', currency: 'GBP', quantity: '0' }),
      'metric',
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(Object.keys(result.errors).sort()).toEqual([
      'carriage',
      'name',
      'price',
      'quantity',
      'weight',
    ]);
  });

  it('cannot be made worn and consumable at once either', () => {
    const result = parseCustomPackItemForm(
      formData({ ...minimal, carriage: 'consumable', worn: 'on', consumable: 'on' }),
      'metric',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.values).toMatchObject({ worn: false, consumable: true });
  });

  it('hands back the raw strings when it refuses', () => {
    const entries = {
      name: '  ',
      brand: ' Alpkit ',
      category: '',
      description: '',
      weight: 'lots',
      price: '',
      currency: '',
      quantity: '2',
      carriage: 'worn',
      packed: 'on',
    };
    const result = parseCustomPackItemForm(formData(entries), 'metric');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.values).toEqual(rawCustomPackItemFormValues(formData(entries)));
  });
});

// ---------------------------------------------------------------------------
// The inverse renderings
// ---------------------------------------------------------------------------

describe('the stored-row to form-values direction', () => {
  it('round-trips a pack through the form and back', () => {
    const row = { name: 'Cairngorms', description: 'March', trip_type: 'winter' };
    const values = packToFormValues(row);
    const reparsed = parsePackForm(formData({ ...values }));

    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    expect(reparsed.values).toEqual(row);
  });

  it('renders a pack’s null columns as empty fields, not as the string "null"', () => {
    expect(packToFormValues({ name: 'A', description: null, trip_type: null })).toEqual({
      name: 'A',
      description: '',
      trip_type: '',
    });
  });

  it('round-trips every pack item through the form and back', () => {
    for (const carriage of PACK_ITEM_CARRIAGES) {
      const row = { quantity: 3, packed: true, ...carriageFlags(carriage) };
      const reparsed = parsePackItemForm(formData({ ...packItemToFormValues(row) }));

      expect(reparsed.ok).toBe(true);
      if (!reparsed.ok) return;
      expect(reparsed.values).toEqual(row);
    }
  });

  it('renders an unpacked item as an empty checkbox value, not as "false"', () => {
    // 'false' in a checkbox's value is read as unticked by parseCheckbox — correctly, but
    // only because that string is on neither list. '' is the honest blank.
    expect(
      packItemToFormValues({ quantity: 1, packed: false, worn: false, consumable: false }),
    ).toEqual({ quantity: '1', carriage: 'carried', packed: '' });
  });

  it('refuses to render a row flagged both worn and consumable', () => {
    expect(() =>
      packItemToFormValues({ quantity: 1, packed: false, worn: true, consumable: true }),
    ).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// The blank states
// ---------------------------------------------------------------------------

describe('the blank form states', () => {
  it('leaves a new pack’s trip type blank rather than pre-picking one', () => {
    // A <select> whose value matches no option renders its FIRST option, so a pre-filled
    // trip type is how an imported value gets silently overwritten — see packTripTypeOptions.
    expect(EMPTY_PACK_FORM_VALUES.trip_type).toBe('');
    expect(EMPTY_PACK_FORM_VALUES.description).toBe('');
    expect(EMPTY_PACK_FORM_VALUES.name).toBe('');
  });

  it('seeds a carriage so the radio group starts with an option selected', () => {
    // Load-bearing in a way quantity's '1' is not: a radio group starts with nothing checked
    // unless some option's value matches, and a submission from that state is refused.
    expect(isPackItemCarriage(EMPTY_PACK_ITEM_FORM_VALUES.carriage)).toBe(true);
    expect(parsePackItemForm(formData({ ...EMPTY_PACK_ITEM_FORM_VALUES })).ok).toBe(true);
  });

  it('shows a custom item’s weight as the column’s own default', () => {
    expect(EMPTY_CUSTOM_PACK_ITEM_FORM_VALUES.weight).toBe('0');
    expect(EMPTY_CUSTOM_PACK_ITEM_FORM_VALUES.price).toBe('');
    expect(EMPTY_CUSTOM_PACK_ITEM_FORM_VALUES.currency).toBe('');
  });
});
