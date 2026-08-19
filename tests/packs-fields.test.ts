import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  PACK_TRIP_TYPES,
  PACK_TRIP_TYPE_BLANK_LABEL,
  PACK_TRIP_TYPE_LABELS,
  isPackTripType,
  packTripTypeLabel,
  packTripTypeOptions,
} from '../src/lib/packs/fields';

/**
 * `src/lib/packs/fields.ts` is a vocabulary with NO constraint behind it, which makes it
 * the opposite of `src/lib/gear/fields.ts` in the one way that matters: `GEAR_STATUSES`
 * is tested as a mirror of a CHECK constraint, and everything below is tested as a UI
 * convenience that must never behave like one. Read that module's header first — in
 * particular the three things that can happen to an imported trip type and why two of
 * them are data loss.
 *
 * The tests fall into three groups: the vocabulary itself is well-formed; an unrecognised
 * value survives every path through the module unchanged; and the column it is written to
 * still carries no constraint that would refuse one.
 */

describe('PACK_TRIP_TYPES: the curated vocabulary', () => {
  // Spelled out rather than derived, for the reason tests/units.test.ts gives about the
  // conversion factors: a test that reads the tuple to check the tuple passes whatever is
  // in it. This is also the thing to look at when a value is REMOVED — rows already
  // carrying it keep it, and they will render through the unrecognised-value path, which
  // is a rendering change worth noticing deliberately rather than discovering.
  it('is exactly the ten values the picker offers', () => {
    expect(PACK_TRIP_TYPES).toEqual([
      'day-hike',
      'overnight',
      'weekend',
      'multi-day',
      'thru-hike',
      'winter',
      'alpine',
      'fastpacking',
      'bikepacking',
      'packrafting',
    ]);
  });

  it('holds no duplicates, which would render as two identical options', () => {
    expect(new Set(PACK_TRIP_TYPES).size).toBe(PACK_TRIP_TYPES.length);
  });

  // Slugs, not prose. A stored value is data already written to rows; if the values were
  // the labels, rewording "Thru-hike" to "Thru hike" would silently split one trip type
  // into two and orphan every pack saved before the edit.
  it.each(PACK_TRIP_TYPES.map((value) => [value] as const))(
    '%s is a lowercase hyphenated slug, storable and stable under a copy edit',
    (value) => {
      expect(value).toMatch(/^[a-z]+(-[a-z]+)*$/);
    },
  );

  it('labels every value, with no blanks and no two values sharing a label', () => {
    const labels = PACK_TRIP_TYPES.map((value) => PACK_TRIP_TYPE_LABELS[value]);

    expect(Object.keys(PACK_TRIP_TYPE_LABELS).sort()).toEqual([...PACK_TRIP_TYPES].sort());
    for (const label of labels) expect(label.trim()).not.toBe('');
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe('isPackTripType', () => {
  it.each(PACK_TRIP_TYPES.map((value) => [value] as const))('accepts %s', (value) => {
    expect(isPackTripType(value)).toBe(true);
  });

  // Each of these gets PAST "is it a string" and is refused only by not being an exact
  // member — the near-miss an import produces, not a wildly wrong value a bare typeof
  // check would already catch. A `false` here means "no curated label exists", NEVER
  // "reject this value": every one of these is a legal thing to store in `trip_type`.
  it.each([
    ['the label rather than the slug', 'Weekend'],
    ['a space where the hyphen is', 'day hike'],
    ['an underscore where the hyphen is', 'thru_hike'],
    ['trailing whitespace', 'weekend '],
    ['a plural', 'weekends'],
    ['a value imported from another tool', 'PCT section hike'],
  ])('rejects %s', (_label, value) => {
    expect(isPackTripType(value)).toBe(false);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a number', 3],
    ['an array of one valid value', ['weekend']],
  ])('rejects %s without throwing', (_label, value) => {
    expect(isPackTripType(value)).toBe(false);
  });
});

describe('packTripTypeLabel', () => {
  it('renders the curated label for a curated value', () => {
    expect(packTripTypeLabel('thru-hike')).toBe('Thru-hike');
    expect(packTripTypeLabel('day-hike')).toBe('Day hike');
  });

  // The whole point of the module. An imported value has no label of ours and must not be
  // dropped, replaced with a placeholder, or title-cased into something the visitor did
  // not write.
  it('renders an unrecognised value exactly as stored', () => {
    expect(packTripTypeLabel('PCT section hike')).toBe('PCT section hike');
    expect(packTripTypeLabel('Bikepack - gravel')).toBe('Bikepack - gravel');
  });

  it('trims surrounding whitespace but leaves the value otherwise untouched', () => {
    expect(packTripTypeLabel('  weekend  ')).toBe('Weekend');
    expect(packTripTypeLabel('  two  spaces  inside  ')).toBe('two  spaces  inside');
  });

  // The empty string and not PACK_TRIP_TYPE_BLANK_LABEL: a pack header rendering
  // "Weekend · 4.2 kg" wants nothing where the trip type would go, not the words "No trip
  // type" sitting where a real answer would be. The select supplies its own blank option.
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['the empty string', ''],
    ['whitespace only', '   '],
  ])('renders %s as the empty string, inventing no placeholder', (_label, value) => {
    expect(packTripTypeLabel(value)).toBe('');
  });
});

describe('packTripTypeOptions', () => {
  it('offers the blank option first, then the curated ten in their curated order', () => {
    expect(packTripTypeOptions(null)).toEqual([
      { value: '', label: PACK_TRIP_TYPE_BLANK_LABEL },
      ...PACK_TRIP_TYPES.map((value) => ({ value, label: PACK_TRIP_TYPE_LABELS[value] })),
    ]);
  });

  it('adds nothing when the current value is one of the curated ten', () => {
    expect(packTripTypeOptions('weekend')).toEqual(packTripTypeOptions(null));
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['the empty string', ''],
    ['whitespace only', '  '],
  ])('adds nothing for %s — an unset trip type is the blank option', (_label, value) => {
    expect(packTripTypeOptions(value)).toEqual(packTripTypeOptions(null));
  });

  /**
   * THE DATA-LOSS TEST. A `<select>` whose options do not contain its bound value renders
   * and submits its FIRST option — so without the extra entry, opening an imported pack
   * shows "No trip type" and the visitor's next save of any other field on that form
   * writes null over a value they never chose to remove, with nothing on screen to say so.
   */
  it.each([
    ['an imported free-text value', 'PCT section hike'],
    ['another tool’s vocabulary', 'Bikepack - gravel'],
    ['a curated slug spelled with different case', 'Winter'],
    ['a curated label rather than its slug', 'Day hike'],
  ])('keeps %s as a selectable option so a save cannot silently blank it', (_label, stored) => {
    const options = packTripTypeOptions(stored);

    expect(options.map((option) => option.value)).toContain(stored);
    expect(options[1]).toEqual({ value: stored, label: stored });
    expect(options).toHaveLength(PACK_TRIP_TYPES.length + 2);
  });

  // Second, not last: it is the value currently selected, so it belongs where the eye
  // already is — and appending it after the curated ten would read as though it were part
  // of the vocabulary, which is the one thing it is not.
  it('places the unrecognised value directly after the blank option', () => {
    const options = packTripTypeOptions('vacaciones');
    expect(options[0].value).toBe('');
    expect(options[1].value).toBe('vacaciones');
    expect(options[2].value).toBe(PACK_TRIP_TYPES[0]);
  });

  it('trims the stored value but preserves its case, so the save is a byte-identical round trip', () => {
    const options = packTripTypeOptions('  Winter  ');
    expect(options[1]).toEqual({ value: 'Winter', label: 'Winter' });
    expect(options.map((option) => option.value)).toContain('winter');
  });
});

/**
 * The claim `src/lib/packs/fields.ts` is built on, checked against the migrations rather
 * than trusted: `packs.trip_type` carries NO constraint. If one is ever added, the import
 * paths (PK-33, PK-65) start failing on a decorative field and every "render it as-is"
 * test above becomes a description of something the database will refuse — so the module
 * comment and the schema have to be brought back into agreement deliberately, which is
 * what a failure here is asking for.
 *
 * Text-scanning the migrations, in the style of `tests/migration-hygiene.test.ts`, because
 * it needs no database and therefore runs in the ordinary suite. Parenthesis matching is
 * done by counting depth, which a `(` inside a string literal could confuse; the failure
 * mode of that is an over-captured expression a human then reads, not a missed constraint.
 */
describe('packs.trip_type carries no database constraint', () => {
  const MIGRATIONS_DIR = fileURLToPath(new URL('../supabase/migrations', import.meta.url));

  const stripComments = (sql: string): string =>
    sql
      .split('\n')
      .map((line) => line.replace(/--.*$/, ''))
      .join('\n');

  /** Every `check (...)` expression in a migration, parentheses balanced. */
  const checkExpressions = (sql: string): string[] => {
    const expressions: string[] = [];
    const opener = /\bcheck\s*\(/gi;
    let match = opener.exec(sql);
    while (match !== null) {
      let depth = 1;
      let index = opener.lastIndex;
      while (index < sql.length && depth > 0) {
        if (sql[index] === '(') depth += 1;
        else if (sql[index] === ')') depth -= 1;
        index += 1;
      }
      expressions.push(sql.slice(opener.lastIndex, index - 1));
      match = opener.exec(sql);
    }
    return expressions;
  };

  const files = readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith('.sql'));

  // A scanner that found nothing would report "no CHECK over trip_type" for every
  // migration ever written, including one that added a CHECK over trip_type. So the
  // scanner is checked against constraints known to exist: the two position columns the
  // reorder engine depends on, and the status list gear/fields.ts mirrors. If these stop
  // being found, every assertion below this point is worthless and says so here first.
  it('the scanner actually finds the CHECK constraints that are known to be there', () => {
    const core = stripComments(
      readFileSync(`${MIGRATIONS_DIR}/20260810120000_core_schema.sql`, 'utf8'),
    );
    const expressions = checkExpressions(core);

    expect(files.length).toBeGreaterThan(0);
    expect(expressions.filter((e) => /position\s*>=\s*0/.test(e))).toHaveLength(2);
    expect(expressions.some((e) => /status in \('owned', 'wishlist', 'retired'\)/.test(e))).toBe(
      true,
    );
  });

  it.each(files.map((file) => [file] as const))('%s adds no CHECK over trip_type', (file) => {
    const sql = stripComments(readFileSync(`${MIGRATIONS_DIR}/${file}`, 'utf8'));
    for (const expression of checkExpressions(sql)) {
      expect(expression).not.toMatch(/trip_type/);
    }
  });

  // The column as declared: plain nullable text. `not null` would break the packs that
  // have no trip type, a `default` would put a value nobody chose on every new pack, and
  // an enum type would refuse imports outright.
  it('declares the column as plain nullable text with no default', () => {
    const core = stripComments(
      readFileSync(`${MIGRATIONS_DIR}/20260810120000_core_schema.sql`, 'utf8'),
    );
    expect(core).toMatch(/\n\s*trip_type\s+text\s*,\s*\n/);
  });

  it('never alters the column afterwards', () => {
    for (const file of files) {
      const sql = stripComments(readFileSync(`${MIGRATIONS_DIR}/${file}`, 'utf8'));
      expect(sql).not.toMatch(/alter\s+column\s+trip_type/i);
    }
  });
});
