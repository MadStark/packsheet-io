/**
 * The pack editor's request-shaped decisions (PK-37): the ids a submission names, and
 * where a newly added row goes in its run.
 *
 * `src/lib/packs/form.ts` owns "is this value well formed" for every field a visitor
 * TYPES. This module owns the two questions that are left over on the same POST and that
 * neither that module nor `src/lib/packs/mutations.ts` can answer:
 *
 *   WHICH ROW IS THIS SUBMISSION ABOUT — the category being renamed, the item being saved,
 *   the closet items being added. These arrive as hidden fields and repeated checkboxes,
 *   not as form values, so they never pass through a `parse*Form` function.
 *   WHAT POSITION DOES A NEW ROW TAKE. `createPackCategory` and `createCustomPackItem` both
 *   take `position` from their caller, deliberately — that module computes no ordering, and
 *   its own comment says the caller "expresses [append] by passing the current number of
 *   categories, a fact it already has from the tree it just rendered". This is where that
 *   fact is turned into a number.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A MODULE AND NOT THE PAGE'S FRONTMATTER
 * ---------------------------------------------------------------------------
 *
 * `vitest.config.ts:64` excludes `src/pages/**`, and both questions above are ones a wrong
 * answer to is SILENT. An append position computed as `0` instead of `n` does not error:
 * `pack_categories.position` is `check (position >= 0)` and DELIBERATELY NOT UNIQUE
 * (core_schema.sql:228), so every new row simply lands at the top and ties resolve on `id`
 * — an ordering nobody chose, produced by a page that looked like it worked. A category id
 * accepted from a submission without being checked against the pack in front of it is the
 * same shape of quiet: the write is refused by RLS or the composite foreign key, reports
 * zero rows, and the visitor is told nothing happened without being told why.
 *
 * PK-4's independent review demonstrated that this is not a theoretical concern by mutation
 * testing the gear pages: mutations to statements living only in frontmatter SURVIVED, not
 * because the assertions were weak but because nothing in the suite could reach them.
 * `tests/packs-editor.test.ts` calls every function below directly.
 *
 * ---------------------------------------------------------------------------
 * NOT importing src/lib/auth/, AND NOT A SUBSTITUTE FOR IT
 * ---------------------------------------------------------------------------
 *
 * Nothing here opens a connection or authenticates anybody — see
 * `src/lib/packs/query.ts`'s header for why that rule is an EDGE rule enforced before
 * there is anything concrete to violate it. Nor is `itemAppendPosition`'s refusal of an
 * unknown category an authorisation check: it is a check against a tree that was ALREADY
 * fetched owner-scoped by `loadPackForEdit`, so what it actually rules out is a stale or
 * hand-edited `category_id` naming a category of some other pack — including another pack
 * of this same visitor's, which RLS permits and which is exactly the case the migration's
 * own "ids from two different packs OF THE SAME USER" paragraph describes for the reorder
 * RPCs. Ownership itself is decided by the row-level policies, as everywhere else.
 */

// ---------------------------------------------------------------------------
// Intents
// ---------------------------------------------------------------------------

/**
 * The ten forms `src/pages/packs/[id].astro` answers on one POST handler, told apart by a
 * hidden `intent` field — the same mechanism that page's gear siblings use for their two,
 * and `BULK_FORM_FIELD.intent` in `src/lib/gear/bulk.ts` for the closet list's several.
 *
 * WHY THIS IS HERE RATHER THAN IN THE PAGE, which is where it started and where it belonged
 * while the page was the only thing that could read or write these strings. It is not a
 * decision — there is nothing buried in naming ten strings, and nothing below branches on
 * one. It is here because TWO FILES NOW RENDER FORMS THAT THIS ONE HANDLER READS: the page
 * itself, and `src/components/PackContents.vue`, which holds the per-item and per-category
 * forms so that the pack's order is rendered exactly once. A component spelling
 * `'save-item'` by hand is a component that can spell it wrongly, and the failure would be
 * silent in the worst way — an unrecognised intent falls through to "something went wrong"
 * on a form that looks perfectly ordinary. Named once, imported by both, and reachable by
 * `tests/packs-editor.test.ts`, which `vitest.config.ts:64` cannot say of anything under
 * `src/pages/`.
 */
export const PACK_INTENT = {
  savePack: 'save-pack',
  duplicatePack: 'duplicate-pack',
  deletePack: 'delete-pack',
  createCategory: 'create-category',
  renameCategory: 'rename-category',
  deleteCategory: 'delete-category',
  addGear: 'add-gear',
  addCustomItem: 'add-custom-item',
  saveItem: 'save-item',
  removeItem: 'remove-item',
} as const;

export type PackIntent = (typeof PACK_INTENT)[keyof typeof PACK_INTENT];

// ---------------------------------------------------------------------------
// Field names
// ---------------------------------------------------------------------------

/**
 * The `<input name="…">` values the editor uses for the ROWS a submission acts on, as
 * distinct from the VALUES it carries (those live in `PACK_FORM_FIELD`,
 * `PACK_CATEGORY_FORM_FIELD`, `PACK_ITEM_FORM_FIELD` and `CUSTOM_PACK_ITEM_FORM_FIELD` in
 * `src/lib/packs/form.ts`). Named here for the reason every other field map in this
 * codebase is named somewhere: the markup and the parser must not be able to disagree
 * about what a field is called.
 *
 * `gearItemId` IS REPEATED — one `<input type="checkbox" name="gear_item_id" value="…">`
 * per ticked closet row — hence `form.getAll(...)` in `parseGearItemIds` below, exactly as
 * `BULK_FORM_FIELD.id` is read in `src/lib/gear/bulk.ts`.
 */
export const PACK_EDITOR_FIELD = {
  categoryId: 'category_id',
  itemId: 'item_id',
  gearItemId: 'gear_item_id',
} as const;

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

/** Case-insensitive, and deliberately not checking the version/variant nibbles — the same
 *  pattern and the same reasoning as `parseIds` in `src/lib/gear/bulk.ts`: a well-formed
 *  id that names no row this visitor owns is refused by RLS anyway, so this exists to stop
 *  raw, caller-controlled text reaching a query as an id at all. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One hidden id field, or `null` for anything that is not a UUID.
 *
 * THE PARAMETER IS WHAT `form.get()` REALLY RETURNS, not `string | null`: a multipart POST
 * can send a `File` under any name it likes. `confirmsGearDeletion` in
 * `src/lib/gear/bulk.ts` records the same reasoning for the same reason — the natural
 * `value?.toString()` spelling turns a crafted body into a 500 rather than a refusal.
 *
 * Lower-cased on the way out so two spellings of one id cannot become two ids. That costs
 * nothing (`gen_random_uuid()` emits lowercase) and keeps this in step with
 * `compareByPosition` in `src/lib/packs/reorder.ts`, which lower-cases for a sharper
 * reason of its own.
 */
export function parseEntityId(value: FormDataEntryValue | null): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return UUID_PATTERN.test(trimmed) ? trimmed.toLowerCase() : null;
}

/**
 * Every ticked closet item, in the order the browser submitted them.
 *
 * NOT DE-DUPLICATED, AND THAT IS THE ONE THING THIS FUNCTION MUST NOT DO. `parseIds` in
 * `src/lib/gear/bulk.ts` — which this otherwise mirrors — collapses duplicates, because a
 * bulk action applied twice to one row is meaningless. Here the opposite is true: nothing
 * in the schema makes `(pack_category_id, gear_item_id)` unique, and
 * `addGearItemsToCategory` says in capitals that repeated ids must produce repeated rows
 * (two of the same stuff sack, a spare carried both worn and packed, one fuel canister
 * listed twice for two legs). A visitor who did not mean it deletes one; a parser that
 * silently collapsed them would leave no way to express what they did mean.
 *
 * Malformed entries are dropped silently rather than reported, exactly as `parseIds` drops
 * them: the selection is a checkbox list nobody typed into, so a bad value is a crafted
 * request or a client bug, not something to ask a visitor to fix.
 */
export function parseGearItemIds(values: readonly FormDataEntryValue[]): string[] {
  const ids: string[] = [];
  for (const value of values) {
    const id = parseEntityId(value);
    if (id !== null) ids.push(id);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Append positions
// ---------------------------------------------------------------------------

/**
 * The two levels of the tree this module reads, structurally rather than by importing
 * `PackTreeRow` — see `ReorderPackRows` in `src/lib/packs/reorder-request.ts` for the same
 * choice and the same argument. All that is needed is a category's id and how many items
 * it holds.
 */
export interface EditorCategoryRows {
  readonly id: string;
  readonly pack_items: readonly unknown[];
}

export interface EditorPackRows {
  readonly pack_categories: readonly EditorCategoryRows[];
}

/**
 * Where a newly created category goes: after every category the pack already has.
 *
 * A COUNT, NOT `max(position) + 1`, and the difference is deliberate. Positions are
 * reindexed dense on every move (`denseUpdates` in `src/lib/packs/reorder.ts`), so after
 * any drag the run is exactly `0..n-1` and the two answers agree. Where they DISAGREE is a
 * run that has never been dragged and was written with duplicate positions — legal, since
 * the column is deliberately not unique — and there the count is the honest answer: it
 * places the new row at the end of the ORDER a reader sees, which is what "add a category"
 * means, rather than at the end of a numbering nobody is looking at.
 */
export function categoryAppendPosition(pack: EditorPackRows): number {
  return pack.pack_categories.length;
}

/**
 * Whether `categoryId` names a category of THIS pack.
 *
 * The question every submission carrying a hidden `category_id` has to ask before it acts
 * on one — a rename, a delete, an add. It is asked against a tree `loadPackForEdit` already
 * fetched owner-scoped, so what it rules out is a stale or hand-edited id naming a category
 * of a DIFFERENT pack, including another pack belonging to the same visitor: a case RLS
 * permits outright, and the one the reorder migration refuses by name for the same reason
 * ("ids from two different packs OF THE SAME USER, which RLS permits and which would
 * renumber both packs against a plan computed for one").
 */
export function hasPackCategory(pack: EditorPackRows, categoryId: string): boolean {
  return pack.pack_categories.some((category) => category.id === categoryId);
}

/**
 * Where a newly added item goes inside `categoryId`: after every item that category
 * already holds. `null` means the id names no category of THIS pack.
 *
 * THE NULL IS A REFUSAL, NOT A DEFAULT, and this is the whole reason this returns
 * `number | null` rather than a number. The tempting shape — return 0 for an unknown
 * category and let the write fail — writes a row at the top of some other run, or fails
 * with a foreign-key error the visitor cannot read. Both are worse than saying "that
 * category is not in this pack", which is a sentence a page can render and a state a
 * second tab genuinely produces by deleting a category while this one had it selected.
 *
 * Same append rule as `categoryAppendPosition`, for the same reason; `startPosition` on
 * `addGearItemsToCategory` is this number, and that function adds the index of each id to
 * it so a multi-item add lands in the order it was ticked.
 */
export function itemAppendPosition(pack: EditorPackRows, categoryId: string): number | null {
  const category = pack.pack_categories.find((candidate) => candidate.id === categoryId);
  return category === undefined ? null : category.pack_items.length;
}
