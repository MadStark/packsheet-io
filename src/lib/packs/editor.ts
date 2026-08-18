/**
 * The pack editor's request-shaped decisions (PK-37): the ids a submission names, and
 * where a newly added row goes in its run.
 *
 * `src/lib/packs/form.ts` owns "is this value well formed" for every field a visitor
 * TYPES. This module owns the two questions that are left over on the same POST and that
 * neither that module nor `src/lib/packs/mutations.ts` can answer:
 *
 *   WHICH ROW IS THIS SUBMISSION ABOUT — the category being renamed, the item being saved,
 *   the item being removed, the closet items being added. These arrive as hidden fields and
 *   repeated checkboxes, not as form values, so they never pass through a `parse*Form`
 *   function.
 *   WHAT POSITION DOES A NEW ROW TAKE. `createPackCategory` and `createCustomPackItem` both
 *   take `position` from their caller, deliberately — that module computes no ordering, and
 *   its own comment says the caller "works it out from the run it just rendered, which is
 *   the only place the current positions are known". This is where that run is turned into
 *   a number.
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
 * The three levels of the tree this module reads, structurally rather than by importing
 * `PackTreeRow` — see `ReorderPackRows` in `src/lib/packs/reorder-request.ts` for the same
 * choice and the same argument.
 *
 * `position` IS CARRIED ON BOTH ROW TYPES, and it is the whole reason these interfaces are
 * shaped this way rather than as `pack_items: readonly unknown[]`. The append functions
 * below derive their answer from the highest position in the run, so a row type that hid
 * the column would leave them nothing to derive it from — which is exactly the state this
 * module was in when it counted rows instead (see `appendPosition`'s comment for the bug
 * that produced). `PACK_TREE_SELECT` in `src/lib/packs/query.ts` already fetches
 * `pack_categories(id, name, position, pack_items(id, …, position, …))`, so widening these
 * types asks the read for nothing it was not already returning.
 */
export interface EditorItemRows {
  readonly id: string;
  readonly position: number;
}

export interface EditorCategoryRows {
  readonly id: string;
  readonly position: number;
  readonly pack_items: readonly EditorItemRows[];
}

export interface EditorPackRows {
  readonly pack_categories: readonly EditorCategoryRows[];
}

/**
 * One past the highest position in a run, or 0 for an empty one.
 *
 * `max(position) + 1`, NOT A COUNT, AND THE DIFFERENCE IS A BUG THIS FUNCTION EXISTS TO
 * CLOSE. The count was wrong because DELETING LEAVES GAPS and nothing renumbers a run
 * afterwards. Neither `deletePackCategory` nor `deletePackItem` in
 * `src/lib/packs/mutations.ts` touches its siblings' positions, and no trigger in
 * `supabase/migrations/20260810120000_core_schema.sql` does either — a delete is one
 * statement against one row. So three categories at positions 0, 1, 2 with the first two
 * deleted leave a single category still sitting at position 2, at which point a count
 * answers 1: BELOW a row that is already there. `loadPackForEdit` reads
 * `order(position).order(id)`, so the freshly appended category renders ABOVE the one it
 * was supposed to follow, and nothing errors — `pack_categories.position` is
 * `check (position >= 0)` and DELIBERATELY NOT UNIQUE (core_schema.sql:228), so 1 is a
 * perfectly legal value for a row that has no business holding it.
 *
 * THE PREVIOUS COMMENT HERE DEFENDED THE COUNT AND WAS WRONG, and it is worth recording
 * why rather than quietly deleting it: it reasoned only about DUPLICATE positions, where a
 * count really is no worse than a maximum, and never about gaps. Duplicates are what a
 * hand-written or imported run can contain; gaps are what ordinary use produces, every
 * time somebody removes a row. It argued the rare case and missed the common one.
 *
 * A REINDEX AFTER EVERY DELETE WOULD BE THE OTHER FIX, AND IS THE WRONG ONE HERE. It turns
 * a one-row delete into a whole-run rewrite for no benefit a reader can see — the ORDER is
 * identical either way, because ties and gaps both resolve deterministically through
 * `(position, id)` — and it would put a third implementation of the reindex rules outside
 * `src/lib/packs/reorder.ts`, which that module's header forbids by name. Gaps are legal;
 * appending has to cope with them.
 *
 * DUPLICATES STILL RESOLVE SENSIBLY. A run stored 0, 0, 0 answers 1, which is past every
 * one of them, so the new row still lands last in reading order. That is the case the old
 * comment was really about, and it is not lost by deriving from the maximum.
 */
function appendPosition(rows: readonly { readonly position: number }[]): number {
  let next = 0;
  for (const row of rows) {
    if (row.position >= next) next = row.position + 1;
  }
  return next;
}

/**
 * Where a newly created category goes: after every category the pack already has, in the
 * ORDER a reader of that pack sees. See `appendPosition` for why that is one past the
 * highest stored position rather than the number of categories.
 */
export function categoryAppendPosition(pack: EditorPackRows): number {
  return appendPosition(pack.pack_categories);
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
 * Same append rule as `categoryAppendPosition`, for the same reason — a category whose
 * items are stored 0, 3, 7 because five were deleted answers 8, not 3; see
 * `appendPosition`. `startPosition` on `addGearItemsToCategory` is this number, and that
 * function adds the index of each id to it so a multi-item add lands in the order it was
 * ticked, which stays true of a gapped run because the numbers it produces all sit past
 * the end of it.
 */
export function itemAppendPosition(pack: EditorPackRows, categoryId: string): number | null {
  const category = pack.pack_categories.find((candidate) => candidate.id === categoryId);
  return category === undefined ? null : appendPosition(category.pack_items);
}

/**
 * Whether `itemId` names an item of THIS pack — the item-level counterpart to
 * `hasPackCategory`, and the check the `save-item` and `remove-item` branches of
 * `src/pages/packs/[id].astro` were missing.
 *
 * WITHOUT IT, `ITEM_MISSING_MESSAGE` ("That item is no longer in this pack") could only
 * ever fire for an id that failed to parse as a UUID — never once for the condition its
 * own sentence names. A hand-edited or stale `item_id` naming an item of a DIFFERENT pack
 * of the SAME visitor is not refused by anything else on that path: row level security
 * permits it outright (`pack_items_update_own` / `pack_items_delete_own` ask for
 * `user_id = (select auth.uid())` and an unlocked parent, neither of which distinguishes
 * one of this visitor's packs from another), so the write lands — on the wrong pack — and
 * the editor redirects as though it had saved. That is the same case the reorder migration
 * refuses by name for its own payload ("ids from two different packs OF THE SAME USER,
 * which RLS permits"), one table down.
 *
 * It is asked against a tree `loadPackForEdit` already fetched owner-scoped, so this is
 * not an authorisation check and must not be read as one — see this module's header. What
 * it decides is which PACK a submission is allowed to act on, which is a question ownership
 * does not answer.
 */
export function hasPackItem(pack: EditorPackRows, itemId: string): boolean {
  return pack.pack_categories.some((category) =>
    category.pack_items.some((item) => item.id === itemId),
  );
}
