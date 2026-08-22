/**
 * The shared vocabulary for pack list composition (PK-37), modelled on
 * `src/lib/gear/fields.ts`: the "what are the valid values" question kept in its own
 * separately-testable file, away from the "how does that turn into a PostgREST query"
 * question. Pure data and pure functions — no import that reaches an SDK, because this
 * module ships to the browser: `src/components/PackContents.vue` imports its carriage
 * exports (`PACK_ITEM_CARRIAGES` and the label/meaning maps) for the per-item `…` menu's
 * carriage commands (PK-73 moved them off an inline radio group), and that component is a
 * hydrated island. The TRIP-TYPE half is not the reason — that picker is
 * server-rendered in `src/pages/packs/[id].astro`'s own markup and the island never touches
 * it — but a module ships or does not ship as a whole, so the rule covers everything in this
 * file. See `src/lib/packs/routes.ts`'s header for the full argument.
 *
 * ---------------------------------------------------------------------------
 * THIS LIST IS NOT A CONSTRAINT, AND THE DIFFERENCE FROM `GEAR_STATUSES` IS THE POINT
 * ---------------------------------------------------------------------------
 *
 * `GEAR_STATUSES` exists to mirror a CHECK constraint —
 * `supabase/migrations/20260810120000_core_schema.sql:104`, `check (status in ('owned',
 * 'wishlist', 'retired'))` — and its comment is the only thing holding the two
 * independent files in step. Read that comment and then read this one, because the
 * relationship here is the OPPOSITE one and copying the gear pattern across without
 * noticing would break an import.
 *
 * `packs.trip_type` is declared `trip_type text` at
 * `supabase/migrations/20260810120000_core_schema.sql:132`. Nullable, no default, NO
 * CHECK CONSTRAINT, no enum, no foreign key to a lookup table. That is deliberate and it
 * must stay that way. `PACK_TRIP_TYPES` below is a UI CONVENIENCE — the options a
 * `<select>` offers so that the common cases are one click rather than a free-text field
 * everyone spells differently — and it is emphatically not a statement about what the
 * column accepts.
 *
 * WHAT DEPENDS ON IT STAYING UNCONSTRAINED. PK-33 and PK-65 import packs from other
 * tools, whose trip-type vocabularies are their own and are not this one. An imported
 * pack labelled `"PCT section hike"`, `"Bikepack - gravel"` or `"vacaciones"` has to
 * survive a round trip through this editor unchanged. There are exactly three things
 * that could happen to such a value and two of them are data loss:
 *
 *   - REJECT the import (or the save) because the value is not in this list. The import
 *     then fails on a decorative field, which is a terrible trade for the visitor.
 *   - BLANK it, silently, by rendering a `<select>` whose options do not include it. This
 *     is the one that actually bites, because it does not look like a bug from either
 *     side of the screen: a `<select>` with no matching `<option>` displays its FIRST
 *     option, so the form shows something plausible, and the next unrelated save — a
 *     typo fixed in the pack name — writes that plausible wrong value over the imported
 *     one. The visitor never touched the field. `packTripTypeOptions` below exists for
 *     this exact failure and nothing else.
 *   - RENDER IT AS-IS, keep it, and offer the curated list alongside. This is what this
 *     module does.
 *
 * If a constraint is ever genuinely wanted, that is a migration with a backfill for every
 * value already in the column, and this file moves with it — the same relationship
 * `GEAR_STATUSES`' comment describes, just not yet entered into.
 */

/**
 * The curated trip types, in the order the `<select>` renders them: roughly by trip
 * length, then by the modes of travel that change what goes in the pack.
 *
 * Values are stable lowercase slugs, labels are what a human reads
 * (`PACK_TRIP_TYPE_LABELS`). The two are separate for the reason `GEAR_STATUS_LABELS`
 * separates them — a label is copy and may be reworded or translated, a stored value is
 * data already written to rows and must not move underneath them. Slugs rather than the
 * labels themselves so that "Thru-hike", "Thru hike" and "thru-hike" cannot become three
 * values through nothing but a copy edit.
 *
 * ORDERING IS NOT ALPHABETICAL, on purpose. A picker sorted A-Z puts "Alpine" above "Day
 * hike" and buries the two commonest answers — overnight and weekend — in the middle of
 * the list. Trip length is the axis people actually pick along, so the list follows it,
 * with the mode-of-travel entries (which are not points on that axis) grouped after.
 *
 * ADDING ONE IS CHEAP AND REMOVING ONE IS NOT. A new entry is a line here and a line in
 * `PACK_TRIP_TYPE_LABELS`, and no row anywhere needs touching. Deleting an entry does not
 * delete the rows already carrying that value: they keep it, and they will render through
 * the unrecognised-value path below, exactly as an imported value does. That is a
 * feature — it means this list can be curated without a migration — but it does mean the
 * set of values in the column is a superset of this tuple and code must never assume
 * otherwise. `isPackTripType` is the narrow gate for the cases that genuinely need one.
 */
export const PACK_TRIP_TYPES = [
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
] as const;

export type PackTripType = (typeof PACK_TRIP_TYPES)[number];

/**
 * Narrows a value to one of the curated trip types, mirroring `isGearStatus` and
 * `isWeightUnit`.
 *
 * READ ITS FALSE CAREFULLY, because it does NOT mean "invalid" here, and that is the one
 * way this guard differs from every other one in the codebase. `isGearStatus(value) ===
 * false` means the database would reject the value. `isPackTripType(value) === false`
 * means only "this is not one of ours" — the value may be a perfectly good imported trip
 * type that `packs.trip_type` will store happily. Use this to decide whether a curated
 * LABEL exists, never to decide whether a value may be saved. Nothing in this codebase
 * should ever branch to a rejection on it.
 */
export function isPackTripType(value: unknown): value is PackTripType {
  return typeof value === 'string' && (PACK_TRIP_TYPES as readonly string[]).includes(value);
}

/** Human labels for the curated values. These, not the slugs, are what render. */
export const PACK_TRIP_TYPE_LABELS: Record<PackTripType, string> = {
  'day-hike': 'Day hike',
  overnight: 'Overnight',
  weekend: 'Weekend',
  'multi-day': 'Multi-day',
  'thru-hike': 'Thru-hike',
  winter: 'Winter',
  alpine: 'Alpine',
  fastpacking: 'Fastpacking',
  bikepacking: 'Bikepacking',
  packrafting: 'Packrafting',
};

/**
 * The label on the blank `<option>` — the one selected when `trip_type` is null, which is
 * every pack that has not chosen one and is a perfectly ordinary state rather than an
 * incomplete form. Its value is the empty string, which the form layer maps back to SQL
 * null; "no trip type" is not itself a trip type and must never be stored as one.
 *
 * Named here rather than typed into the markup so that the blank option and the ten real
 * ones come from one place, and so `packTripTypeOptions` can return a list a template
 * maps over with no conditionals in it at all — `vitest.config.ts` excludes
 * `src/pages/**`, so a branch written in frontmatter is a branch no test can reach.
 */
export const PACK_TRIP_TYPE_BLANK_LABEL = 'No trip type';

/**
 * What to display for a stored `trip_type`: the curated label when the value is one of
 * ours, and otherwise the value itself, trimmed — the "render as-is" half of the
 * three-way choice this module's header sets out.
 *
 * Null, undefined and whitespace-only all collapse to the empty string rather than to
 * `PACK_TRIP_TYPE_BLANK_LABEL`. The caller decides what "no trip type" looks like in ITS
 * context, and the two contexts genuinely differ: a `<select>` needs a visible blank
 * option with words on it, while a pack header rendering "Weekend · 4.2 kg" wants nothing
 * at all there — not the string "No trip type" sitting where a real answer would be. A
 * function that invented a placeholder would force the second caller to compare against
 * it to undo it.
 */
export function packTripTypeLabel(value: string | null | undefined): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (trimmed === '') return '';
  return isPackTripType(trimmed) ? PACK_TRIP_TYPE_LABELS[trimmed] : trimmed;
}

/** One `<option>`: the value that would be submitted, and the text that renders. */
export interface PackTripTypeOption {
  readonly value: string;
  readonly label: string;
}

/**
 * Every option the trip-type `<select>` should render for a pack whose stored value is
 * `current`: the blank option, then `current` itself when it is a value this module does
 * not recognise, then the curated ten.
 *
 * THE MIDDLE ENTRY IS THE ENTIRE REASON THIS FUNCTION EXISTS, and it is a data-loss fix
 * rather than a nicety. A `<select>` whose options do not contain its bound value does
 * not error and does not render empty — it renders and submits its FIRST option. So a
 * pack imported with `trip_type = 'PCT section hike'` (PK-33, PK-65) would open showing
 * "No trip type", and the visitor's next save of any other field on that form would
 * quietly write null over a value they never chose to remove. Nothing on the screen would
 * indicate that had happened. Including the unrecognised value as a real option makes the
 * form show what is stored and submit back what it showed.
 *
 * IT SITS SECOND, DIRECTLY AFTER THE BLANK, rather than at the end. It is the currently
 * selected value, so it belongs where the visitor's eye already is when the picker opens;
 * appending it after the curated ten would also read as though it were part of the
 * vocabulary, which is the one thing it is not.
 *
 * The value is trimmed but NOT otherwise normalised — not lowercased, not slugified. It
 * has to round-trip byte-identically or the save rewrites the imported row for no reason
 * the visitor asked for. A value that differs from a curated slug only in case (`'Winter'`
 * against `'winter'`) is therefore offered as its own option, deliberately: silently
 * folding it would be the same unrequested rewrite in a smaller disguise.
 *
 * WHY A FUNCTION IN `src/lib/` RATHER THAN A TERNARY IN THE PAGE. The same argument
 * `checkedGearStatuses` makes for itself: `vitest.config.ts` excludes `src/pages/**`, so
 * the condition that decides whether an imported trip type survives its next save cannot
 * be asserted on if it is written in frontmatter. Inverting it here fails
 * `tests/packs-fields.test.ts`; inverting it in the page was a green suite and a field
 * that eats imported data.
 */
export function packTripTypeOptions(current: string | null | undefined): PackTripTypeOption[] {
  const options: PackTripTypeOption[] = [{ value: '', label: PACK_TRIP_TYPE_BLANK_LABEL }];

  const trimmed = typeof current === 'string' ? current.trim() : '';
  if (trimmed !== '' && !isPackTripType(trimmed)) {
    options.push({ value: trimmed, label: trimmed });
  }

  for (const tripType of PACK_TRIP_TYPES) {
    options.push({ value: tripType, label: PACK_TRIP_TYPE_LABELS[tripType] });
  }

  return options;
}

// ---------------------------------------------------------------------------
// How a pack item is carried — the three-way choice behind `worn` and `consumable`
// ---------------------------------------------------------------------------

/**
 * The three ways a pack item can be carried, as ONE value rather than as two independent
 * booleans. This is the only thing PK-37 adds to this file, and it is added here rather
 * than in `src/lib/packs/form.ts` for the reason the header gives for everything else in
 * this module: it is vocabulary, it is pure, and the pack editor's Vue island renders the
 * control that picks between these three and therefore ships this module to the browser.
 *
 * ---------------------------------------------------------------------------
 * WHY A THREE-WAY CHOICE AND NOT TWO CHECKBOXES
 * ---------------------------------------------------------------------------
 *
 * `pack_items` really does have two boolean columns, `worn` and `consumable`
 * (`supabase/migrations/20260810120000_core_schema.sql:263-264`), and the shortest path
 * from that schema to a form is two checkboxes. That path is wrong, and the reason is
 * written out in full in `supabase/migrations/20260812000000_worn_consumable_exclusive.sql`:
 * the two flags are not independent facts about an item, they are two answers to one
 * question — is this carried in the pack, on the body, or eaten on the way — and only
 * three of their four combinations mean anything. `worn` and `consumable` both true is
 * refused by `pack_items_worn_consumable_exclusive`, and `classifyPackItem` in
 * `src/lib/totals.ts` throws on it rather than picking a winner, because the three weight
 * buckets have to partition the pack exactly.
 *
 * Two checkboxes make the meaningless fourth combination the EASIEST thing on the screen
 * to produce: tick both, submit, and the visitor meets either a raw
 * `pack_items_worn_consumable_exclusive` violation or — if the write somehow lands — a pack
 * whose totals throw on read. Both of those are the backstop doing its job, and neither is
 * an interaction. A single control with three options cannot express the fourth combination
 * at all, so the constraint and `computeTotals`'s refusal go back to being what they are
 * meant to be: the defence against a row written by psql, by a restore, or by an import
 * path that never met this form.
 *
 * PK-63 MADE THE IDENTICAL STRUCTURAL CHOICE FOR GEAR STATUS and this follows it
 * deliberately rather than by coincidence — `gear_items.status` is one column with three
 * values rendered as a radio group (see `GEAR_STATUSES` in `src/lib/gear/fields.ts`). The
 * difference here is only that the database spells the three values as two booleans; the
 * control the visitor meets is the same shape, and the mapping between the two spellings
 * lives in `carriageFlags`/`packItemCarriage` below and nowhere else.
 *
 * ---------------------------------------------------------------------------
 * THIS LIST IS NOT A CONSTRAINT EITHER, BUT NOT FOR THE REASON `PACK_TRIP_TYPES` ISN'T
 * ---------------------------------------------------------------------------
 *
 * Read this against the header's argument about `PACK_TRIP_TYPES`, because the two are
 * unlike in a way that matters. `trip_type` is an unconstrained column whose stored values
 * are a SUPERSET of the curated list, so nothing may branch to a rejection on
 * `isPackTripType`. These three values are not stored at all — no column holds the string
 * `'worn'` — so there is no such superset and no imported value to preserve.
 * `isPackItemCarriage` returning false means exactly "not one of the three", which is a
 * genuine rejection, and `src/lib/packs/form.ts` treats it as one.
 */
export const PACK_ITEM_CARRIAGES = ['carried', 'worn', 'consumable'] as const;

export type PackItemCarriage = (typeof PACK_ITEM_CARRIAGES)[number];

/**
 * Narrows a submitted string to one of the three. Unlike `isPackTripType` above — and this
 * is the one place in this file where a false IS a rejection — see the final section of
 * `PACK_ITEM_CARRIAGES`' comment.
 */
export function isPackItemCarriage(value: unknown): value is PackItemCarriage {
  return typeof value === 'string' && (PACK_ITEM_CARRIAGES as readonly string[]).includes(value);
}

/**
 * Human labels for the three options, on the same footing as `PACK_TRIP_TYPE_LABELS` and
 * `GEAR_STATUS_LABELS`: copy that may be reworded, kept apart from the values — which here
 * are not even stored, and exist only to be mapped to two booleans.
 *
 * `'carried'` IS LABELLED "In the pack", not "Carried", because "carried" is what a visitor
 * would reasonably call a worn item too — a jacket on your back is still being carried. The
 * value keeps the schema's own word for it
 * (`20260812000000_worn_consumable_exclusive.sql`: "an item that is just carried in the
 * pack, not worn and not consumed"), and the label says the thing that distinguishes it
 * from the other two.
 */
export const PACK_ITEM_CARRIAGE_LABELS: Record<PackItemCarriage, string> = {
  carried: 'In the pack',
  worn: 'Worn',
  consumable: 'Consumable',
};

/**
 * The one-line meaning of each option, for the use `GEAR_STATUS_MEANINGS` serves on PK-63's
 * status radio group: a hint beside the visible label. AN ENHANCEMENT, never a substitute
 * for `PACK_ITEM_CARRIAGE_LABELS` — a visitor who never hovers, or who meets the control
 * through a screen reader that does not announce the hint, sees only the label and must be
 * able to choose correctly from it alone.
 *
 * The wording is lifted from `20260812000000_worn_consumable_exclusive.sql`'s own comment on
 * purpose ("worn means carried on the body rather than in the pack, consumable means used up
 * during the trip"), so the sentence a visitor reads and the sentence a maintainer reads in
 * the migration are the same sentence — and `classifyPackItem`'s error message, which quotes
 * it a third time, agrees with both.
 */
export const PACK_ITEM_CARRIAGE_MEANINGS: Record<PackItemCarriage, string> = {
  carried: 'Carried inside the pack. This is the ordinary case.',
  worn: 'Carried on the body rather than in the pack, so it does not count towards base weight.',
  consumable: 'Used up during the trip, like food or fuel.',
};

/**
 * The two `pack_items` columns this vocabulary is a spelling of, READ WIDE: two independent
 * booleans, all four combinations representable, including the one the database refuses.
 *
 * THAT WIDTH IS DELIBERATE AND MUST NOT BE NARROWED TO `PackItemCarriageColumns` BELOW.
 * `packItemCarriage` takes this type and THROWS on both-true, and the throw is only
 * reachable because the parameter can express it. The function is written to be handed
 * objects that never came from `pack_items` — a fixture, a hand-built preview row, a decoded
 * request body — exactly as `classifyPackItem` in `src/lib/totals.ts` is; see its own
 * comment. Typing the parameter as the three-arm union would move that refusal from a
 * runtime error naming the problem to a compile error at the one call site that CAN prove
 * the state is impossible, and would leave every call site that cannot with a cast.
 *
 * So: a READ site (this type) admits the illegal row and refuses it out loud. A WRITE site
 * (`PackItemCarriageColumns`) cannot spell it at all.
 */
export interface PackItemCarriageFlags {
  readonly worn: boolean;
  readonly consumable: boolean;
}

/**
 * The same two columns, WRITE-SHAPED: the three legal combinations and no others.
 *
 * THE EXCLUSIVITY IS REPRESENTABLE, SO IT IS REPRESENTED — a finding from PK-37's
 * independent review, and the argument is the one this file already makes about a radio
 * group. `worn` and `consumable` are not two independent facts, they are one three-way
 * answer, and `pack_items_worn_consumable_exclusive`
 * (`supabase/migrations/20260812000000_worn_consumable_exclusive.sql:36`) plus
 * `packItemCarriage` plus `classifyPackItem` each refuse the fourth combination at run time.
 * Three runtime validations of a rule the type system can state is two too many: with this
 * union, `{ worn: true, consumable: true }` is not a value that can be constructed and
 * handed to a write, so the three runtime refusals go back to being what they are for —
 * defence against a row written by psql, by a restore, or by an import path that never met
 * this module.
 *
 * EACH ARM STILL SPREADS INTO `.update()` UNCHANGED, which is the constraint that shaped it.
 * The columns are `worn boolean not null default false` and `consumable boolean not null
 * default false`, and `updatePackItem`/`setPackItemCarriage` in `src/lib/packs/mutations.ts`
 * pass their value to PostgREST verbatim. A union of three complete objects is assignable to
 * the generated Update type member by member, so nothing translates and nothing is rebuilt —
 * which was the whole argument for `PackItemInput` matching the columns in the first place.
 */
export type PackItemCarriageColumns =
  | { readonly worn: false; readonly consumable: false }
  | { readonly worn: true; readonly consumable: false }
  | { readonly worn: false; readonly consumable: true };

/**
 * The WRITE direction: the two columns a carriage choice means.
 *
 * BOTH COLUMNS COME OUT OF ONE CALL, which is the point. They are then written by one
 * statement from one value and cannot disagree. A caller that set `worn` and `consumable`
 * from two separate reads of a form — or, worse, with two separate UPDATEs — could pass
 * through a moment where both are true, which is the state
 * `pack_items_worn_consumable_exclusive` refuses outright; with the pair derived here there
 * is no intermediate state to pass through, because there is only ever one write.
 *
 * The function is total and its result can never have both flags set: three inputs, three
 * outputs, and `'carried'` is the only one that sets neither. Since PK-37's review that is
 * checked by the compiler as well — the return type is the three-arm union, so a body that
 * could produce both-true does not compile — and it is still asserted at run time:
 * `tests/packs-form.test.ts` enumerates `PACK_ITEM_CARRIAGES` and pins the pair for every
 * member, so adding a fourth value without deciding its flags fails the suite too.
 *
 * THE BODY IS A CONDITIONAL RATHER THAN THE TWO COMPARISONS IT REPLACES, and that is forced
 * by the return type rather than a preference. `{ worn: c === 'worn', consumable: c ===
 * 'consumable' }` infers `{ worn: boolean; consumable: boolean }`, which is not assignable
 * to a union of literal-typed arms: TypeScript relates the two comparisons independently and
 * has no way to know they cannot both be true. Returning one arm per branch states the same
 * fact in a form the compiler can check.
 */
export function carriageFlags(carriage: PackItemCarriage): PackItemCarriageColumns {
  if (carriage === 'worn') return { worn: true, consumable: false };
  if (carriage === 'consumable') return { worn: false, consumable: true };
  return { worn: false, consumable: false };
}

/**
 * The READ direction: which of the three a stored row is, so the editor can pre-select the
 * option an item already has — the counterpart to `gearItemToFormValues` reading `status`
 * straight off the gear row, which this cannot do because there is no column to read.
 *
 * IT THROWS ON A ROW WITH BOTH FLAGS SET, rather than picking a winner, and that is the
 * same refusal `classifyPackItem` in `src/lib/totals.ts` makes for the same row — read its
 * comment, and the "NOT an XOR" section of
 * `supabase/migrations/20260812000000_worn_consumable_exclusive.sql`, for the full argument
 * against a precedence rule. The short version: no answer is right, and a form that quietly
 * showed "Worn" for a both-flags row would invite the visitor to save that silent repair
 * back over whatever the row actually meant.
 *
 * The state is unreachable from the database — `pack_items_worn_consumable_exclusive`
 * refuses it — and this function is written to be handed objects that never came from that
 * table, exactly as `classifyPackItem` is: a fixture, a hand-built preview row, a decoded
 * request body. A page rendering such an item would already have thrown inside
 * `computeTotals` before reaching this function, so throwing here does not make a working
 * page fail; it makes a second, quieter failure impossible.
 */
export function packItemCarriage(row: PackItemCarriageFlags): PackItemCarriage {
  if (row.worn && row.consumable) {
    throw new TypeError(
      'A pack item is flagged both worn and consumable, which pack_items_worn_consumable_exclusive ' +
        '(supabase/migrations/20260812000000_worn_consumable_exclusive.sql) makes unrepresentable in ' +
        'the database. There is no correct third option to select for it: worn means carried on the ' +
        'body rather than in the pack, consumable means used up during the trip, and computeTotals ' +
        'refuses to total a row claiming both.',
    );
  }
  if (row.worn) return 'worn';
  if (row.consumable) return 'consumable';
  return 'carried';
}
