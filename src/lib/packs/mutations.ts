/**
 * Every write pack list composition (PK-37) performs: the pack itself, its categories, the
 * items inside them — closet references and one-off custom items alike — and thin wrappers
 * over the RPCs `supabase/migrations/20260818000000_pack_composition_functions.sql` and
 * `20260819000000_pack_notes.sql` (PK-72) add.
 *
 * This module is `src/lib/gear/mutations.ts` for packs, and it is that deliberately. Read
 * that file first: its two rules are stated there at length and are binding here, and the
 * places this module has to depart from them are called out where they happen rather than
 * left for a reader to notice.
 *
 * WHY THE WRITES LIVE HERE AND NOT IN PAGE FRONTMATTER. `vitest.config.ts:64` excludes
 * `src/pages/` from the test run, so a write statement written in an `.astro` file is a
 * write statement no test in this repository can execute. PK-4's independent review proved
 * that is not a theoretical concern by mutation testing the gear pages: mutations to the
 * delete path SURVIVED, not because the assertions were weak but because nothing in the
 * suite could reach the statement at all. Every write below is callable, and asserted,
 * directly from `tests/packs-mutations.test.ts`.
 *
 * ---------------------------------------------------------------------------
 * EVERY TABLE WRITE TAKES `client` AND `userId` AND SCOPES ITSELF TO THAT OWNER
 * ---------------------------------------------------------------------------
 *
 * TABLE writes — the RPC wrappers take a `client` and no `userId`, because there is no
 * query for an owner filter to attach to and the migration's own `where p.user_id =
 * auth.uid() ...` (`for update` where a row is locked) is what authorises the call. That
 * now includes `createPack` and `updatePack` (PK-72) alongside `movePackItem`,
 * `movePackCategory` and `duplicatePack` at the bottom of this file — five wrappers, all
 * argued the same way where they are defined, not here, so this section can stay about the
 * rule rather than about its exceptions.
 *
 * Row level security already confines every statement below to the caller's own rows.
 * `packs_update_own` / `packs_delete_own` (core_schema.sql:747-754),
 * `pack_categories_update_own` / `_delete_own` (:784-:809) and `pack_items_update_own` /
 * `_delete_own` (:840-:871) all require `user_id = (select auth.uid())`, and the last two
 * pairs additionally require the parent pack to be unlocked. That is a fact about the
 * policy set as it stands today, not a property of this module, and it is not why the
 * filter is here. A function whose entire contract is "acts on THIS visitor's rows" should
 * enforce that contract itself, so it holds for every future caller, survives a policy
 * being renamed or relaxed, and is something a test can assert on directly rather than
 * having to take RLS's word for.
 *
 * IT COSTS MORE THAN IT DOES ON `gear_items`, AND IS WORTH MORE. The pack tables carry a
 * SECOND permissive SELECT policy each — `packs_select_public` (:727),
 * `pack_categories_select_public` (:758), `pack_items_select_public` (:813) — and RLS
 * policies are UNIONED, not intersected. `src/lib/packs/query.ts`'s header spells out what
 * that does to a read that trusts RLS alone: it returns this visitor's rows OR any
 * stranger's `visibility = 'public'` pack. Those are SELECT policies and do not by
 * themselves let anyone WRITE a stranger's row — but every function below is one an
 * endpoint reaches with an id taken from a request body, and "the id I was handed belongs
 * to a pack I can see" is exactly the reasoning that public read policy makes false.
 *
 * THE INSERTS SCOPE THEMSELVES DIFFERENTLY, BECAUSE `.eq()` HAS NO MEANING ON ONE. There is
 * no row to filter yet, so the equivalent is writing `user_id: userId` into the row
 * explicitly rather than leaving the column's `default auth.uid()` to supply it. The insert
 * policies check the same value, so a `userId` that disagrees with the client's own JWT is
 * REFUSED by `..._insert_own` rather than quietly producing a row owned by whoever the
 * client happened to be authenticated as. That failure is the point: it makes the owner an
 * argument of the function, testable in the same way the `.eq()` filter is, instead of an
 * ambient property of the client that no caller can see.
 *
 * That is the opposite of the choice `duplicate_pack` makes inside the migration, which
 * omits `user_id` on all three of its inserts and says so explicitly: "the insert policies
 * check the same value, so passing it explicitly would be one more thing that can disagree
 * with the JWT and nothing that can go right". Both are right in their own place, and the
 * difference is not style. Inside that SQL function there is exactly one identity in scope —
 * `auth.uid()` — and nothing that could supply a second, so an explicit value could only
 * ever be a copy of the one already there. A TypeScript function takes a client and a
 * `userId` as two independent arguments that a caller CAN get out of step, which is the
 * whole reason the update paths filter on it. An insert that silently ignored the `userId`
 * it was handed would be the one write in this module where passing the wrong one had no
 * effect at all — and the row it created would look, to every later assertion, exactly like
 * the row that was asked for.
 *
 * ---------------------------------------------------------------------------
 * EVERY WRITE REPORTS WHAT IT ACTUALLY DID, NOT WHAT IT WAS ASKED TO DO
 * ---------------------------------------------------------------------------
 *
 * `.select('id')` on every statement below, with `count` read off the rows the write
 * actually returned — never off the length of the id list or the array of values the caller
 * passed in (PK-4 review, I6). A zero-row write is not an error over plain PostgREST: a
 * stale link, a second tab that already deleted this item, a pack somebody locked between
 * the page rendering and the form submitting all come back `{ data: [], error: null }`. A
 * page that reports "1 item added" from the REQUEST rather than the RESULT can say that
 * about a write that touched nothing at all.
 *
 * THE LOCKED-PACK CASE MAKES THIS SHARPER HERE THAN IT IS FOR GEAR, BUT ONLY FOR UPDATE AND
 * DELETE — AND THE DIFFERENCE IS NOT COSMETIC. Every write policy on `pack_categories` and
 * `pack_items` requires `p.locked_at is null`, and where that clause sits decides whether a
 * refusal is loud or silent:
 *
 *   UPDATE and DELETE   The clause is in the policy's `USING`, which is a FILTER. The row
 *                       is not refused, it is not seen — so the statement matches nothing
 *                       and PostgREST answers `{ data: [], error: null, status: 200 }`.
 *                       `tests/core-schema.test.ts` asserts exactly that shape, and
 *                       `count` is the only thing that distinguishes "your change was
 *                       saved" from "that pack is frozen and nothing happened".
 *   INSERT              The clause is in `WITH CHECK`, which RAISES rather than filtering —
 *                       there is no existing row to filter. And it does not even get that
 *                       far: `assert_parent_pack_unlocked()` is a BEFORE INSERT ROW trigger
 *                       (core_schema.sql:606-608) and fires first, raising
 *                       `pack % is locked; unlock it before changing its contents` with
 *                       SQLSTATE 23514. So an insert into a locked pack arrives at the
 *                       caller as an `error`, never as a zero-row success.
 *
 * `count` is therefore load-bearing on the update and delete paths and a backstop on the
 * insert ones. It is read the same way on all of them because "report what the write did"
 * should not have two spellings — and because which of the two a given statement is depends
 * on a policy clause's position, which is not something a call site can see.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MODULE DOES NOT DO
 * ---------------------------------------------------------------------------
 *
 * IT COUNTS NOTHING BEFORE CREATING A PACK. There is no cap on how many packs an account
 * may have, and `createPack` issues one RPC call with no preceding SELECT. This is worth
 * stating because a limit is the kind of thing that gets added by reflex to a create path;
 * `tests/packs-mutations.test.ts` asserts the absence rather than leaving it true by
 * accident, so a cap introduced later fails a test instead of quietly shipping.
 *
 * IT COMPUTES NO POSITIONS FOR A MOVE. `src/lib/packs/reorder.ts` is the single place that
 * answers "what happens when you drop this here", and the RPC wrappers below pass its plan
 * through verbatim — see their own comments, and the migration's "IT DOES NO POSITION
 * ARITHMETIC" section, for why a second implementation in a second language is the bug that
 * design exists to prevent.
 *
 * IT NEVER CONSTRUCTS OR AUTHENTICATES A CLIENT. Every function takes a `PacksheetClient`
 * its caller already holds — the visitor's own, from middleware, never one carrying the
 * project's elevated policy-bypassing credential, which no shipped module in this codebase
 * touches. Nothing in `src/lib/packs/` may import `src/lib/auth/`; see
 * `src/lib/packs/query.ts`'s header for why that rule is an EDGE rule enforced before there
 * is anything concrete to violate it.
 */

import type { PostgrestError } from '@supabase/supabase-js';
import type { Json } from '../database.types';
// The snapshot's `currency` is the same narrowed code `parseCustomPackItemForm` produces —
// see `CustomItemSnapshot` below on why the shape is declared rather than left as `Json`.
import type { CurrencyCode } from '../money';
import type { PacksheetClient } from '../supabase';
import { carriageFlags, type PackItemCarriage } from './fields';
import type { CustomPackItemInput, PackCategoryInput, PackInput, PackItemInput } from './form';
import type { RunUpdate } from './reorder';

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

/** What every table write below reports: whether it failed, and how many rows it actually
 *  touched — see the module comment's "EVERY WRITE REPORTS…" section for why `count` is read
 *  off the write's own `.select('id')` rather than off the caller's input, and why a zero
 *  here is a real answer rather than an error. */
export interface PackMutationResult {
  readonly error: PostgrestError | null;
  readonly count: number;
}

/** A write that creates exactly one row and whose caller needs the id back — to redirect to
 *  the new pack, to hang the first category off it, to place the item that was just added.
 *  `id` is `null` on failure AND on a zero-row write, which are different things that
 *  `error` distinguishes; a caller must not read a null id as "it failed". */
export interface PackCreateResult extends PackMutationResult {
  readonly id: string | null;
}

/**
 * What an RPC wrapper reports. NO `count`, and its absence is deliberate rather than an
 * oversight.
 *
 * `move_pack_item` and `move_pack_category` return `void`, so there is no row set to count
 * — but more importantly there is nothing left for a count to tell a caller. The migration
 * already compares the number of rows each statement affected against the number of pairs
 * it was sent, INSIDE the transaction, and raises rather than committing a half-applied
 * reindex (see its "FOUR THINGS THESE FUNCTIONS DO THAT ARE EASY TO GET WRONG", point 4).
 * That is a strictly stronger version of the rule this module's header states: the write
 * does not merely report what it did, it refuses to commit unless what it did matches what
 * it was asked for. A `count` field here would have to be invented, and an invented number
 * is exactly what that rule exists to forbid.
 */
export interface PackRpcResult {
  readonly error: PostgrestError | null;
}

/**
 * The SQLSTATE `move_pack_item` and `move_pack_category` raise when the pack is locked.
 *
 * `55000` is `object_not_in_prerequisite_state`, and it is raised by those two functions
 * ALONE in this schema — deliberately not the `23514` (`check_violation`) that
 * `assert_parent_pack_unlocked()` raises for the same underlying condition. The two-code
 * split is argued in full at the end of
 * `supabase/migrations/20260818000000_pack_composition_functions.sql`; the short version is
 * that 23514 is also what every column CHECK on these tables raises, including
 * `pack_items.position >= 0`, which an authenticated caller can trip on purpose by sending
 * a negative position in `p_runs`. A reader that treated 23514 as "locked" would tell that
 * caller their pack is frozen, which would be false and unavoidable.
 *
 * NAMED HERE RATHER THAN SPELLED AT THE CALL SITE because the call site is
 * `src/pages/packs/reorder.ts`, which `vitest.config.ts:64` excludes from collection. A bare
 * `error.code === '55000'` written there is a magic string no test can reach; `isPackLocked`
 * below is called by `tests/packs-mutations.test.ts` against a real locked pack, so the code
 * is checked against the database that raises it rather than against this file's memory
 * of it.
 */
export const PACK_LOCKED_ERRCODE = '55000';

/**
 * What the two MOVE wrappers report: the error, and whether that error is the pack being
 * locked.
 *
 * WHY THE CLASSIFICATION IS HERE AND NOT AT THE CALL SITE. A locked pack is an ORDINARY,
 * EXPECTED, USER-ACTIONABLE state — the owner froze it, and unlocking it is a thing they may
 * do — so a caller has to be able to say that in a sentence rather than reporting a server
 * fault. This is the layer that knows what the database's answers mean; the endpoint above
 * it knows what HTTP status a meaning deserves. Handing it a boolean rather than a SQLSTATE
 * keeps the migration's error contract from leaking into a route.
 *
 * `duplicatePack` deliberately has no such flag: duplicating a LOCKED pack is allowed and is
 * the point of the feature (see that function's comment), so "locked" is never an answer it
 * can give and a field that was permanently false would invite a check that means nothing.
 */
export interface PackMoveResult extends PackRpcResult {
  readonly locked: boolean;
}

/** Whether a PostgREST error is the reorder RPCs' locked-pack refusal. Exported so the one
 *  place that compares against `PACK_LOCKED_ERRCODE` is a function a test can call. */
export function isPackLocked(error: PostgrestError | null): boolean {
  return error?.code === PACK_LOCKED_ERRCODE;
}

/** `duplicate_pack` returns the new pack's id, which is the only thing the caller can do
 *  anything with — there is nowhere to navigate to without it. */
export interface PackDuplicateResult extends PackRpcResult {
  readonly id: string | null;
}

// ---------------------------------------------------------------------------
// Packs
// ---------------------------------------------------------------------------

/**
 * Creates one pack. `values` is a `PackInput`, already validated by
 * `src/lib/packs/form.ts`, so nothing raw from a form reaches the RPC call here.
 *
 * AN RPC ON `create_pack_with_defaults`, NOT A PLAIN INSERT, since PK-72. Creating a pack
 * is now five statements — the pack, its four default categories (`Packing`, `Sleep`,
 * `Clothing`, `Cooking`), and a fifth for the note when one was typed — and a pack that
 * exists without its four categories is not a reachable state this product allows. Five
 * round trips from a browser are five transactions with four windows between them where a
 * half-built pack could be read back; a PostgREST RPC is one request and therefore one
 * transaction, which is the only way "one INSERT" used to be true here and is still true
 * of this call.
 *
 * NO `userId` PARAMETER, unlike the plain-INSERT version this replaces. There is nothing
 * left for one to authorise: `create_pack_with_defaults` is `security invoker` and reads
 * `auth.uid()` itself for every row it writes, so the identity a pack is created under is
 * whichever `client` is authenticated as, not a value this function could be handed and
 * asked to believe. See the migration's own comment and this module's header on the RPC
 * wrappers below for the general form of that argument.
 *
 * NOTHING COUNTS THE EXISTING PACKS FIRST. See the module comment: there is no cap, and
 * `tests/packs-mutations.test.ts` asserts the absence of a limit rather than leaving it to
 * be true by accident.
 *
 * `slug`, `visibility` AND `locked_at` ARE STILL NOT WRITTEN, for the reasons the migration
 * gives at length: a fresh opaque slug rather than one derived from a name that is private
 * by default, `default 'private'` because publishing is its own action, and a pack that
 * cannot be born already frozen.
 */
export async function createPack(
  client: PacksheetClient,
  values: PackInput,
): Promise<PackCreateResult> {
  const { data, error } = await client.rpc('create_pack_with_defaults', {
    p_name: values.name,
    // Cast, not a genuine narrowing: the migration declares all three as nullable `text`,
    // and passes `null` straight through to an `insert`/`if … is not null` that is built to
    // receive it, but `database.types.ts`'s generated `Args` type names every SQL function
    // parameter `string` regardless of nullability — a gap in the generator, not a fact
    // about the function. The migration is the source of truth for what the database
    // accepts; this tells TypeScript what the generated type got wrong, the same way
    // `p_runs: runs as unknown as Json` does below for a different generated-type gap.
    p_description: values.description as string,
    p_trip_type: values.trip_type as string,
    p_notes: values.notes as string,
  });
  return { error, count: data ? 1 : 0, id: data ?? null };
}

/**
 * Saves an edit to one pack's own fields — name, description, trip type and note together,
 * from one validated `PackInput`.
 *
 * AN RPC ON `update_pack_details`, NOT A PLAIN `.update()`, since PK-72. This form now
 * saves two tables: `packs` for the first three fields, `pack_notes` for the fourth (see
 * `PackInput`'s own comment on why the note lives on a different table). Two round trips
 * from a browser have a window between them where the pack's name changed and its note did
 * not, leaving the dialog's two halves disagreeing with nothing to tell the visitor which
 * one landed. A PostgREST RPC is one request and therefore one transaction, which is what
 * makes "one save" true of a form that now touches two tables.
 *
 * ONE FUNCTION FOR THE WHOLE FORM, not four field setters, mirroring `updateGearItem`. The
 * narrow setters that DO exist below (`setPackTripType`, `setPackItemPacked`) exist because
 * their control is genuinely separate from any form — a picker in a header, a tick on a
 * checklist.
 *
 * NO `userId` PARAMETER, unlike the plain-`.update()` version this replaces, and for the
 * same reason `createPack` above has none: `update_pack_details` is `security invoker` and
 * its own first statement is the owner filter that used to sit here as `.eq('user_id',
 * userId)`. A `userId` argument that disagreed with the client's own session could no
 * longer change what gets written — only `auth.uid()` inside the function can — so keeping
 * one would be exactly the parameter this module's header on the RPC wrappers warns
 * against: documentation for something that does nothing.
 *
 * `count` IS THE INTEGER THE FUNCTION RETURNS, 0 on error, never the length of a `.select()`
 * result — there is no row set here to measure, only the row count `update public.packs`
 * reported inside the transaction. 0 means the pack is not the caller's or no longer
 * exists; it is never a locked pack, since `packs_update_own` carries no `locked_at`
 * clause.
 */
export async function updatePack(
  client: PacksheetClient,
  packId: string,
  values: PackInput,
): Promise<PackMutationResult> {
  const { data, error } = await client.rpc('update_pack_details', {
    p_pack_id: packId,
    p_name: values.name,
    // See createPack's identical cast, immediately above, for why: the generated Args type
    // says `string`, the migration's signature says nullable `text`, and the migration is
    // the one that is right.
    p_description: values.description as string,
    p_trip_type: values.trip_type as string,
    p_notes: values.notes as string,
  });
  return { error, count: error ? 0 : (data ?? 0) };
}

/** Renames one pack. A single-field write for the inline rename on the pack header, which
 *  submits on its own without the description or the trip type beside it — writing those
 *  two as well would mean this control could clear a description nobody opened. Pairs with
 *  `packs.name`'s `check (length(btrim(name)) > 0)`; `parsePackForm` has already trimmed
 *  and refused the blank case. */
export async function renamePack(
  client: PacksheetClient,
  userId: string,
  packId: string,
  name: string,
): Promise<PackMutationResult> {
  const { data, error } = await client
    .from('packs')
    .update({ name })
    .eq('user_id', userId)
    .eq('id', packId)
    .select('id');
  return { error, count: data?.length ?? 0 };
}

/** Sets or clears one pack's description. `null` clears it — the column is nullable with no
 *  default, and `parseOptionalText` in `src/lib/packs/form.ts` is what turns an emptied box
 *  into `null` rather than `''`, so that "has no description" has exactly one spelling. */
export async function setPackDescription(
  client: PacksheetClient,
  userId: string,
  packId: string,
  description: string | null,
): Promise<PackMutationResult> {
  const { data, error } = await client
    .from('packs')
    .update({ description })
    .eq('user_id', userId)
    .eq('id', packId)
    .select('id');
  return { error, count: data?.length ?? 0 };
}

/**
 * Sets or clears one pack's trip type.
 *
 * `tripType` IS A BARE `string`, NOT A `PackTripType`, and that is the whole point of this
 * signature. `packs.trip_type` carries no CHECK constraint, no enum and no lookup table
 * (core_schema.sql:132), and `PACK_TRIP_TYPES` in `src/lib/packs/fields.ts` is a UI
 * convenience whose header explains at length what depends on the column staying
 * unconstrained: PK-33 and PK-65 import packs from tools with their own vocabularies, and
 * an imported `'PCT section hike'` has to survive a round trip through this editor
 * unchanged. Typing this parameter as `PackTripType` would make the curated list a
 * constraint in TypeScript that the database deliberately does not have, and the first
 * casualty would be the import path.
 *
 * `null` clears it. "No trip type" is not itself a trip type and must never be stored as
 * one — `PACK_TRIP_TYPE_BLANK_LABEL`'s own comment says so about the blank `<option>` whose
 * value is the empty string.
 */
export async function setPackTripType(
  client: PacksheetClient,
  userId: string,
  packId: string,
  tripType: string | null,
): Promise<PackMutationResult> {
  const { data, error } = await client
    .from('packs')
    .update({ trip_type: tripType })
    .eq('user_id', userId)
    .eq('id', packId)
    .select('id');
  return { error, count: data?.length ?? 0 };
}

/**
 * THE delete: one pack leaves `packs` for good, and takes its categories and items with it.
 *
 * WHAT THIS SETS OFF IN THE DATABASE, because none of it is visible from this call.
 * `pack_categories` references `packs (user_id, id) on delete cascade` and `pack_items`
 * references `pack_categories (user_id, id) on delete cascade` (core_schema.sql:233, :303),
 * so one DELETE here removes the whole tree. Nothing snapshots anything on the way out —
 * that is rule 3's trigger, which fires on `gear_items`, not here — because there is
 * nothing left to render a snapshot INTO. The gear itself is untouched: `pack_items` points
 * AT the closet and never owns it (rule 1), so deleting a pack removes appearances of gear,
 * never gear.
 *
 * A LOCKED PACK CAN STILL BE DELETED, and that is the schema's choice rather than this
 * function's. `packs_delete_own` (core_schema.sql:752) has no `locked_at` clause: the lock
 * freezes a pack's CONTENTS against editing, and every write policy on the children checks
 * the parent for it, but the owner may still throw the whole thing away. Unlocking is
 * likewise a decision an owner may make (`locked_at`'s own comment). There is deliberately
 * no reveal-then-confirm step in this module — that is UI, and `confirmsGearDeletion` in
 * `src/lib/gear/bulk.ts` is where the closet's equivalent lives — so nothing here will stop
 * or reverse a confirmed delete.
 */
export async function deletePack(
  client: PacksheetClient,
  userId: string,
  packId: string,
): Promise<PackMutationResult> {
  const { data, error } = await client
    .from('packs')
    .delete()
    .eq('user_id', userId)
    .eq('id', packId)
    .select('id');
  return { error, count: data?.length ?? 0 };
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

/**
 * Creates one category in one pack.
 *
 * `position` IS THE CALLER'S, AND IT IS AN APPEND POSITION RATHER THAN A REORDER. This
 * module computes no ordering: `src/lib/packs/reorder.ts` owns every question of the form
 * "what happens when you drop this here", and the migration's header explains why a second
 * implementation of those rules in a second language is the failure that design prevents. A
 * new category goes at the end, and the caller works it out from the run it just rendered,
 * which is the only place the current positions are known — `categoryAppendPosition` in
 * `src/lib/packs/editor.ts` is that calculation, and its own comment explains why it is one
 * past the highest position rather than the number of categories. Getting it wrong is not
 * corruption but it is not harmless either: `pack_categories.position` is
 * `check (position >= 0)` and DELIBERATELY NOT UNIQUE (core_schema.sql:228), so a wrong
 * number is accepted in silence and simply puts the new row somewhere nobody chose, with
 * ties resolving on `id` in every read in this codebase.
 *
 * `user_id` IS WRITTEN EXPLICITLY, and here it is doing double duty. Besides the
 * insert-scoping argument in the module comment, `pack_categories.user_id` is DENORMALISED
 * from the parent pack and held true by the composite foreign key
 * `(user_id, pack_id) references packs (user_id, id)`. That FK is what makes cross-tenant
 * re-parenting unrepresentable — the target row simply does not exist in another user's
 * packs — so a mismatched `userId` here fails on the foreign key even before the insert
 * policy is consulted. Two independent mechanisms refuse the same mistake, neither of them
 * this function.
 */
export async function createPackCategory(
  client: PacksheetClient,
  userId: string,
  packId: string,
  values: PackCategoryInput,
  position: number,
): Promise<PackCreateResult> {
  const { data, error } = await client
    .from('pack_categories')
    .insert({ user_id: userId, pack_id: packId, name: values.name, position })
    .select('id');
  return { error, count: data?.length ?? 0, id: data?.[0]?.id ?? null };
}

/** Renames one category. Pairs with `pack_categories.name`'s
 *  `check (length(btrim(name)) > 0)` (core_schema.sql:211), already enforced by
 *  `parsePackCategoryForm`. No uniqueness is checked, deliberately — see that parser's
 *  comment, and `duplicate_pack`'s, for why anything relying on category names being
 *  distinct is a bug rather than a missing constraint. */
export async function renamePackCategory(
  client: PacksheetClient,
  userId: string,
  categoryId: string,
  name: string,
): Promise<PackMutationResult> {
  const { data, error } = await client
    .from('pack_categories')
    .update({ name })
    .eq('user_id', userId)
    .eq('id', categoryId)
    .select('id');
  return { error, count: data?.length ?? 0 };
}

/**
 * Deletes one category AND EVERY ITEM IN IT. `pack_items` references
 * `pack_categories (user_id, id) on delete cascade` (core_schema.sql:303-304), so this is
 * never the "empty category" delete it can look like at the call site — a category holding
 * twelve items takes all twelve with it, and `count` below reports 1 regardless, because
 * one category row is what this statement deleted.
 *
 * That asymmetry is worth a caller's attention rather than a silent fix: counting the
 * cascaded items would mean a SELECT before the DELETE, whose answer could be stale by the
 * time the DELETE ran, reported as though it were the write's own result — which is exactly
 * the substitution the module comment's "EVERY WRITE REPORTS…" rule forbids. A caller that
 * needs to warn "this will remove 12 items" has the tree it rendered from and should say so
 * BEFORE calling this, not learn it afterwards from a number this function cannot honestly
 * produce.
 */
export async function deletePackCategory(
  client: PacksheetClient,
  userId: string,
  categoryId: string,
): Promise<PackMutationResult> {
  const { data, error } = await client
    .from('pack_categories')
    .delete()
    .eq('user_id', userId)
    .eq('id', categoryId)
    .select('id');
  return { error, count: data?.length ?? 0 };
}

// ---------------------------------------------------------------------------
// Items: closet references
// ---------------------------------------------------------------------------

/**
 * Adds one or more closet items to a category AS REFERENCES.
 *
 * RULE 1 OF THE CORE SCHEMA, AND THE WHOLE REASON THIS FUNCTION LOOKS AS PLAIN AS IT DOES:
 * a pack item is a REFERENCE, never a copy. It writes `gear_item_id` and nothing else about
 * the gear — no name, no weight, no price — because "editing a gear item updates every pack
 * referencing it" is the first of the three rules the schema is built around
 * (core_schema.sql:14-16). Copying any of those values in here would be the exact defect
 * `pack_items.overrides` exists to make unnecessary: per-list divergence is a deliberate,
 * explicit object, not a stale copy nobody meant to take.
 *
 * THE SAME GEAR ITEM MAY BE ADDED MORE THAN ONCE, AND THIS FUNCTION MUST NOT PREVENT IT.
 * Nothing in the schema makes `(pack_category_id, gear_item_id)` unique, and that is
 * correct rather than an oversight: two of the same stuff sack in different categories,
 * a spare of something carried both worn and in the pack, the same fuel canister listed
 * twice for two legs. `gearItemIds` is therefore NOT deduplicated and repeated ids produce
 * repeated rows. A visitor who did not mean it deletes one; a function that silently
 * collapsed them would give no way to express what they did mean.
 *
 * AN EMPTY LIST IS A NO-OP, NOT AN ERROR — the same treatment `deleteGearItems` gives an
 * empty selection, and for the same two reasons: it is what a caller filtering a list down
 * to nothing legitimately produces, "nothing was added" is the truthful answer, and
 * returning it without a round trip means this function can never issue a degenerate insert
 * of zero rows.
 *
 * THERE IS NO `MAX_BULK_IDS` CAP HERE, and the omission is reasoned rather than inherited.
 * `deleteGearItems` earns its cap because an unbounded DELETE is irreversible at the scale
 * of whatever it matched. This is an INSERT: an over-large one is a slow statement whose
 * every row can be removed again by the opposite one, which is precisely the argument
 * `src/lib/gear/mutations.ts` gives for leaving `bulkSetCategory` and `bulkSetStatus`
 * unguarded.
 *
 * `count` IS READ OFF THE INSERT'S OWN RESULT, never `gearItemIds.length`. That is the
 * module rule applied without an exception, and it is worth being exact about what it buys
 * HERE, because the obvious reason is the wrong one: a locked parent does NOT produce a
 * silent zero-row insert. `pack_items_insert_own` carries its `locked_at is null` clause in
 * `WITH CHECK`, which raises rather than filtering, and `assert_parent_pack_unlocked()`
 * raises before that from a BEFORE INSERT ROW trigger — see the module comment's table. Nor
 * can this statement land partially: it is ONE insert of N rows, so it either writes all of
 * them or raises and writes none.
 *
 * So with `error` null, `count` and `gearItemIds.length` agree today, and a caller checking
 * `count !== gearItemIds.length` is checking something that cannot currently happen. It is
 * still the right thing to report and the right thing for a caller to check, for the reason
 * the module comment gives: `count` is what the write DID, and a number taken from the
 * request is a claim about what was asked for. The day this becomes two statements, or the
 * day a policy clause moves from `WITH CHECK` to `USING`, the honest number is already the
 * one being returned.
 */
export async function addGearItemsToCategory(
  client: PacksheetClient,
  userId: string,
  categoryId: string,
  gearItemIds: readonly string[],
  startPosition: number,
): Promise<PackMutationResult> {
  if (gearItemIds.length === 0) return { error: null, count: 0 };

  const { data, error } = await client
    .from('pack_items')
    .insert(
      gearItemIds.map((gearItemId, index) => ({
        user_id: userId,
        pack_category_id: categoryId,
        gear_item_id: gearItemId,
        position: startPosition + index,
      })),
    )
    .select('id');
  return { error, count: data?.length ?? 0 };
}

/**
 * `addGearItemsToCategory`'s single-item sibling, for the one caller that already has
 * per-list settings in hand and would otherwise lose them.
 *
 * WHY THIS EXISTS SEPARATELY RATHER THAN AS AN OPTIONAL PARAMETER ABOVE. That function's
 * whole contract is N ids in, one append run, every row identical apart from `position` —
 * that sameness is what makes "did the count come back right" the correct check for a bulk
 * add, and it is also why it deliberately writes nothing about the gear itself (see its own
 * comment's "RULE 1"). Per-item settings for exactly one row is a different shape of call,
 * not an edge case of the bulk one. `quantity`/`worn`/`consumable`/`packed` are NOT "the gear
 * itself" in the sense that comment means — they are `pack_items`' own per-list columns,
 * already independent of whether a row is a reference or a snapshot — so writing them here
 * does not reopen rule 1 at all.
 *
 * ITS ONLY CALLER, TODAY, is `src/pages/packs/[id].astro`'s "also add to closet" toggle
 * (PK-74): the visitor has just filled in quantity, carriage and packed on the very form
 * `settings` comes from, and routing the link through `addGearItemsToCategory` instead
 * dropped all four to their column defaults — a value the visitor typed, silently discarded
 * by the one call meant to honour it. See that page's own comment on the toggle for the fix
 * this replaced.
 */
export async function addGearItemToCategoryWithSettings(
  client: PacksheetClient,
  userId: string,
  categoryId: string,
  gearItemId: string,
  settings: PackItemInput,
  position: number,
): Promise<PackCreateResult> {
  const { data, error } = await client
    .from('pack_items')
    .insert({
      user_id: userId,
      pack_category_id: categoryId,
      gear_item_id: gearItemId,
      quantity: settings.quantity,
      worn: settings.worn,
      consumable: settings.consumable,
      packed: settings.packed,
      position,
    })
    .select('id');
  return { error, count: data?.length ?? 0, id: data?.[0]?.id ?? null };
}

// ---------------------------------------------------------------------------
// Items: the one-off custom item
// ---------------------------------------------------------------------------

/**
 * The frozen-copy object a custom item carries in place of a gear reference.
 *
 * ---------------------------------------------------------------------------
 * IT IS THE SHAPE `private.gear_item_snapshot()` PRODUCES, KEY FOR KEY
 * ---------------------------------------------------------------------------
 *
 * `supabase/migrations/20260817120000_gear_weight_in_grams.sql:104-116` is the definition
 * this mirrors, as PK-67 left it. Ten keys, and this function writes the same ten:
 *
 *     name  brand  category  description  weight  price  currency  photo_path
 *     gear_item_id  captured_at
 *
 * THIS SHAPE MUST NOT DIVERGE, and the reason is that nothing downstream can tell which
 * writer produced the object it is holding. `src/lib/totals.ts` reads
 * `pack_items.snapshot` through one `resolvePackItem`, merges `pack_items.overrides` over
 * it, and pulls `name`, `weight`, `price` and `currency` off the result. It has no
 * provenance field to branch on and no reason to want one — a snapshot is a snapshot. So a
 * key spelled differently here is not a cosmetic difference: it is a line whose weight or
 * price silently disappears from a pack total, or a `resolveWeightGrams` TypeError on a
 * pack the visitor can no longer open.
 *
 * Two of the ten deserve their own note:
 *
 *   `weight`      IS GRAMS AND THERE IS NO `weight_unit` KEY. PK-67 removed the per-row
 *                 unit from the product entirely and rewrote every pre-existing snapshot
 *                 and override so that exactly one shape exists in the database — see that
 *                 migration's step 2, which argues that leaving them would face
 *                 `src/lib/totals.ts` with two incompatible shapes and no way to tell them
 *                 apart, an old 4.4-oz snapshot reading as 4.4 g and under-reporting a pack
 *                 by a factor of twenty-eight. Writing a `weight_unit` key here — even the
 *                 harmless-looking `'g'` — would reintroduce the second shape that
 *                 migration exists to have eliminated. The KEY is `weight` while the column
 *                 it stands in for is `weight_grams`, deliberately: `resolvePackItem`'s own
 *                 comment explains that the merged record's field names are the SNAPSHOT's
 *                 vocabulary, not the table's, because an override written against a live
 *                 item has to keep working unchanged after that item is frozen.
 *   `photo_path`  Always `null`. The key is PRESENT rather than omitted, because the shape
 *                 has to match; a custom item simply has no upload behind it, which is the
 *                 same `null` a gear row with no photo freezes to.
 *
 * NOT CAPTURED, in either writer: `notes` and `url`. The core schema's comment at :389-397
 * explains why, and it applies with more force here — `anon` reads `pack_items.snapshot` on
 * a public pack, so anything frozen into it is published permanently and lands somewhere a
 * later fix to the live path would not reach. A snapshot is a display record, not an audit
 * log.
 *
 * ---------------------------------------------------------------------------
 * `gear_item_id` IS NULL, AND THE KEY MUST BE PRESENT
 * ---------------------------------------------------------------------------
 *
 * This is the subtlest line in the file. `private.gear_item_snapshot()` writes
 * `'gear_item_id', item.id` — the id of the gear row being frozen — so on the two freeze
 * paths the key holds a real uuid. A custom item has no gear row, so it holds `null`.
 *
 * THAT NULL IS A DISCRIMINATOR, NOT AN ABSENCE. `snapshot -> 'gear_item_id'` is the only
 * thing that distinguishes an item AUTHORED here from an item whose gear was deleted out
 * from under it. Both have `pack_items.gear_item_id` null at the column level — the first
 * because it never had one, the second because the composite foreign key's
 * `on delete set null (gear_item_id)` cleared it after the BEFORE DELETE trigger froze the
 * row (core_schema.sql:306-311) — so the COLUMN cannot tell them apart and the snapshot
 * must.
 *
 * OMITTING THE KEY WOULD BREAK PK-66, which reads exactly this discriminator to offer
 * "add this to your closet" for a one-off item and NOT to offer it for an item whose gear
 * has been deleted (where the right offer is something else entirely — the gear used to
 * exist). Absent and null are different in jsonb: `snapshot ? 'gear_item_id'` is false for
 * the first and true for the second, and `->>` returns SQL NULL for both, so a reader that
 * only checked `->>` could not distinguish "authored here" from "written by a version of
 * this function that forgot the key". Writing the key explicitly makes the question
 * answerable rather than ambiguous.
 *
 * ---------------------------------------------------------------------------
 * `captured_at` NOW MEANS TWO DIFFERENT THINGS DEPENDING ON THE ROW
 * ---------------------------------------------------------------------------
 *
 * On the freeze paths it is the moment a LIVE GEAR ROW WAS COPIED: when the pack was
 * locked, or when the gear was deleted. It answers "how old are these values" for a copy
 * whose original may since have changed or gone.
 *
 * Here it is the moment the item WAS AUTHORED — its creation time. There is no original for
 * it to be a copy of, so there is no staleness for it to measure. The two readings sit in
 * one column, and the column comment appended to
 * `supabase/migrations/20260818000000_pack_composition_functions.sql` now says both, because
 * a reader of a single row cannot work out which one they are looking at without checking
 * `gear_item_id` first.
 *
 * IT IS THIS APPLICATION'S CLOCK, NOT THE DATABASE'S, which is the one place the two
 * writers genuinely differ and it is recorded rather than papered over.
 * `private.gear_item_snapshot()` is `stable` specifically so `now()` is evaluated inside the
 * transaction; this value is a JavaScript `Date` serialised on the way out, so a skewed
 * server clock produces a skewed stamp. It is accepted because nothing computes with the
 * value — `src/lib/totals.ts` never reads it, and the column's shape check only requires the
 * key to exist — and because the alternative, an RPC that exists solely to call `now()`,
 * would add a function to the anonymous-facing schema surface for a display field. If
 * anything ever does arithmetic on `captured_at`, this is the paragraph to revisit.
 *
 * `capturedAt` is a parameter with a default rather than an unconditional `new Date()`, so
 * `tests/packs-mutations.test.ts` can assert the exact object this produces without racing
 * a clock.
 */
/**
 * The shape of `pack_items.snapshot`, written down once.
 *
 * WHAT THIS BUYS, EXACTLY, AND WHAT IT DOES NOT — stated precisely because overstating it
 * would be worse than the bare `Json` this replaces. The contract has three parties:
 * `buildCustomItemSnapshot` below, `private.gear_item_snapshot()` in
 * `supabase/migrations/20260817120000_gear_weight_in_grams.sql:104-115`, and
 * `resolvePackItem` in `src/lib/totals.ts`, which merges whichever of the two wrote the row
 * with the item's `overrides` and reads `name`, `weight`, `price` and `currency` back out.
 * TypeScript can see two of those three. So:
 *
 *   IT PINS THE TYPESCRIPT HALF. A dropped key, a renamed key, or a re-added `weight_unit`
 *   in `buildCustomItemSnapshot` is now a compile error instead of a `Json` that typechecks
 *   whatever it holds. That is the failure this closes, and it is a real one: `weight` vs
 *   `weight_grams` is a rename the rest of the codebase has already made once (PK-67), and
 *   a custom item written under the wrong key resolves to no weight at all and throws
 *   inside `computeTotals` on the next read of the pack.
 *
 *   IT CHECKS NO SQL WHATSOEVER. Nothing here reads the migration, and no test compares
 *   this declaration to `jsonb_build_object`'s key list. What it gives review is a NAMED
 *   ARTEFACT to diff that function against by eye — ten keys in one place, in the
 *   migration's own order — rather than a shape that has to be reconstructed from an object
 *   literal's properties. A comment claiming the compiler enforces agreement with Postgres
 *   would be false, and false in the direction that stops people checking.
 *
 * The runtime agreement is asserted where it can be: `tests/packs-mutations.test.ts` writes
 * a custom item through this function and reads the row back, and `tests/core-schema.test.ts`
 * exercises both freeze paths against the real database.
 *
 * A TYPE ALIAS RATHER THAN AN INTERFACE, which is load-bearing rather than stylistic. `Json`
 * includes `{ [key: string]: Json | undefined }`, and TypeScript grants an implicit index
 * signature to a type alias's object type but not to an interface — so an `interface` here
 * would not be assignable to `Json` and `createCustomPackItem`'s insert would not compile.
 *
 * `photo_path` AND `gear_item_id` ARE `string | null` BECAUSE THIS DESCRIBES THE COLUMN,
 * not just this function's output. The freeze paths put a real storage path and a real gear
 * uuid in both; `buildCustomItemSnapshot` writes null to both, and the second of those nulls
 * is a discriminator rather than an absence — see its own comment.
 */
export type CustomItemSnapshot = {
  readonly name: string;
  readonly brand: string | null;
  readonly category: string | null;
  readonly description: string | null;
  /** Grams. The KEY is `weight` while the gear column is `weight_grams`; see
   *  `CustomPackItemInput` in `./form` and `resolvePackItem` in `src/lib/totals.ts` for why
   *  the snapshot's vocabulary is the one an override is written against. */
  readonly weight: number;
  readonly price: number | null;
  readonly currency: CurrencyCode | null;
  readonly photo_path: string | null;
  readonly gear_item_id: string | null;
  readonly captured_at: string;
};

export function buildCustomItemSnapshot(
  values: CustomPackItemInput,
  capturedAt: Date = new Date(),
): CustomItemSnapshot {
  return {
    name: values.name,
    brand: values.brand,
    category: values.category,
    description: values.description,
    weight: values.weight_grams,
    price: values.price,
    currency: values.currency,
    photo_path: null,
    gear_item_id: null,
    captured_at: capturedAt.toISOString(),
  };
}

/**
 * Creates a one-off custom item: something taken on this trip that is not in the closet and
 * is not being added to it.
 *
 * NO NEW COLUMN AND NO MIGRATION. A custom item is a `pack_items` row with
 * `gear_item_id` NULL and `snapshot` SET, which the schema as it already stands permits
 * exactly: `pack_items_reference_or_snapshot check (gear_item_id is not null or snapshot is
 * not null)` (core_schema.sql:300-301) is satisfied by the snapshot half, and
 * `pack_items_insert_own` constrains only ownership and the parent pack's lock. The
 * column's shape check demands an object with a `captured_at` key and a non-blank `name`,
 * which `buildCustomItemSnapshot` and `parseCustomPackItemForm` supply between them.
 *
 * NOTHING ON THIS PATH WRITES TO `gear_items`. That is an acceptance criterion of PK-37 and
 * it is asserted directly — `tests/packs-mutations.test.ts` reads the closet before and
 * after and compares it byte for byte. It is worth stating as an invariant rather than
 * assuming it from the statement below, because the tempting implementation of "add a
 * custom item" is to create the gear row and reference it, which would silently fill a
 * visitor's closet with one-off entries they never wanted in it. That flow exists as a
 * DELIBERATE, LATER CHOICE — PK-66's promote-into-the-closet — and the `gear_item_id: null`
 * inside the snapshot is what makes it offerable.
 *
 * `gear_item_id` IS WRITTEN AS AN EXPLICIT NULL rather than omitted. The column is nullable
 * with no default so the two are equivalent to Postgres, and the explicit null is here to
 * be read: this row is "deliberately no reference", one line above a snapshot whose own
 * `gear_item_id` is null for a different and load-bearing reason.
 *
 * `position` is the caller's append position, exactly as in `createPackCategory` — see that
 * function's comment for why this module computes no ordering.
 */
export async function createCustomPackItem(
  client: PacksheetClient,
  userId: string,
  categoryId: string,
  values: CustomPackItemInput,
  position: number,
  capturedAt: Date = new Date(),
): Promise<PackCreateResult> {
  const { data, error } = await client
    .from('pack_items')
    .insert({
      user_id: userId,
      pack_category_id: categoryId,
      gear_item_id: null,
      snapshot: buildCustomItemSnapshot(values, capturedAt),
      quantity: values.quantity,
      worn: values.worn,
      consumable: values.consumable,
      packed: values.packed,
      position,
    })
    .select('id');
  return { error, count: data?.length ?? 0, id: data?.[0]?.id ?? null };
}

// ---------------------------------------------------------------------------
// Items: per-list settings
// ---------------------------------------------------------------------------

/**
 * Saves the per-list settings of one item — quantity, carriage and packed together, from
 * one validated `PackItemInput`. The counterpart to `updateGearItem`, and the same
 * reasoning: `values` has already passed `src/lib/packs/form.ts`, so nothing raw from a form
 * reaches the column list.
 *
 * `worn` AND `consumable` ARE WRITTEN BY THIS ONE STATEMENT, WHICH IS WHY THERE IS NO PATH
 * THROUGH BOTH-TRUE. They arrive as a pair out of `carriageFlags`, which can produce at most
 * one of them, and they are sent together — so there is no intermediate state where a row
 * has been set worn but not yet un-set consumable, which two sequential updates would pass
 * through and `pack_items_worn_consumable_exclusive` would refuse mid-way.
 *
 * THIS OVERWRITES EVERY ONE OF THE FOUR COLUMNS, including any the visitor did not touch —
 * the `.update(values)` caveat `src/lib/gear/form.ts` records for its own edit path. It is
 * what a whole-form save means; a control that must not disturb its neighbours uses one of
 * the narrow setters below instead.
 */
export async function updatePackItem(
  client: PacksheetClient,
  userId: string,
  itemId: string,
  values: PackItemInput,
): Promise<PackMutationResult> {
  const { data, error } = await client
    .from('pack_items')
    .update(values)
    .eq('user_id', userId)
    .eq('id', itemId)
    .select('id');
  return { error, count: data?.length ?? 0 };
}

/** Sets one item's quantity. A narrow setter because the quantity stepper beside a row is
 *  its own control, and a whole-`PackItemInput` write from it would carry three other
 *  columns' worth of whatever the page last rendered. Pairs with
 *  `quantity integer not null default 1 check (quantity > 0)` (core_schema.sql:262);
 *  `parsePackItemFields` has already refused zero, negatives and non-integers, and
 *  `computeItemTotals` in `src/lib/totals.ts` refuses them again at read time because a
 *  quantity of zero silently removes an item from a pack that still lists it. */
export async function setPackItemQuantity(
  client: PacksheetClient,
  userId: string,
  itemId: string,
  quantity: number,
): Promise<PackMutationResult> {
  const { data, error } = await client
    .from('pack_items')
    .update({ quantity })
    .eq('user_id', userId)
    .eq('id', itemId)
    .select('id');
  return { error, count: data?.length ?? 0 };
}

/**
 * Sets how one item is carried — in the pack, worn, or consumable.
 *
 * IT TAKES THE THREE-WAY VALUE AND NEVER THE TWO BOOLEANS, which is the entire reason it
 * exists as its own function rather than as two `setPackItemWorn`/`setPackItemConsumable`
 * calls. Two setters would make the both-true state reachable in two writes — set worn on an
 * item that is already consumable and the second write is refused by
 * `pack_items_worn_consumable_exclusive`, leaving a visitor who clicked one control looking
 * at a raw constraint name. `carriageFlags` produces the pair from one value, and one
 * statement writes both, so the refused state has no path to it. See `PACK_ITEM_CARRIAGES`
 * in `src/lib/packs/fields.ts`.
 */
export async function setPackItemCarriage(
  client: PacksheetClient,
  userId: string,
  itemId: string,
  carriage: PackItemCarriage,
): Promise<PackMutationResult> {
  const { data, error } = await client
    .from('pack_items')
    .update(carriageFlags(carriage))
    .eq('user_id', userId)
    .eq('id', itemId)
    .select('id');
  return { error, count: data?.length ?? 0 };
}

/** Ticks or unticks one item on the packing checklist. The narrowest write in this module,
 *  and the one most likely to be called repeatedly in a session, so it deliberately touches
 *  nothing else: `packed boolean not null default false` (core_schema.sql:265) is a
 *  per-trip working state, not a property of the gear, and a checklist tick must not be
 *  able to rewrite a quantity somebody set earlier from a stale page. */
export async function setPackItemPacked(
  client: PacksheetClient,
  userId: string,
  itemId: string,
  packed: boolean,
): Promise<PackMutationResult> {
  const { data, error } = await client
    .from('pack_items')
    .update({ packed })
    .eq('user_id', userId)
    .eq('id', itemId)
    .select('id');
  return { error, count: data?.length ?? 0 };
}

/**
 * Removes one item from a pack.
 *
 * IT REMOVES AN APPEARANCE, NOT A PIECE OF GEAR, and the distinction is the first rule of
 * the schema. A referencing item's `gear_item_id` points at a closet row this statement
 * does not touch; a custom item's whole existence is this row, and deleting it deletes the
 * only copy of its snapshot. Neither case has anything to restore from afterwards — there
 * is no trash tier in this product (PK-60 removed the closet's) — so a caller wanting a
 * confirmation step must put it in front of this call.
 *
 * SINGLE-ROW, DELIBERATELY, where the closet's equivalent takes a list. The pack editor
 * deletes one line at a time from one row's own control; there is no multi-select over pack
 * items to serve. A future bulk delete is a new function with `deleteGearItems`'s cap
 * argument to re-make, not an extra parameter here — that cap exists because an unbounded
 * irreversible DELETE built from a repeated query parameter is the specific risk, and a
 * one-row signature has no exposure to it at all.
 */
export async function deletePackItem(
  client: PacksheetClient,
  userId: string,
  itemId: string,
): Promise<PackMutationResult> {
  const { data, error } = await client
    .from('pack_items')
    .delete()
    .eq('user_id', userId)
    .eq('id', itemId)
    .select('id');
  return { error, count: data?.length ?? 0 };
}

// ---------------------------------------------------------------------------
// The RPCs
// ---------------------------------------------------------------------------

/**
 * The three wrappers below are THIN ON PURPOSE. Each one issues the single `.rpc(...)` call
 * its function needs and reports the error; none of them validates a payload, checks an
 * ownership, or reshapes a plan on the way through.
 *
 * THEY TAKE NO `userId`, WHICH IS THE ONE PLACE THIS MODULE'S "EVERY FUNCTION TAKES `client`
 * AND `userId`" RULE DOES NOT REACH — and the reason is that there is nothing here for one
 * to do. An RPC is one POST to one function; there is no query for an owner filter to attach
 * to, and the argument list is fixed by the function's signature. What replaces the filter is
 * stronger rather than weaker, and it is inside the migration: each function's first
 * statement is `select ... from public.packs p where p.id = p_pack_id and p.user_id =
 * auth.uid() ... for update`, which is simultaneously the row lock and the authorisation
 * check — a pack that is someone else's, INCLUDING a public pack of someone else's that
 * `packs_select_public` would happily return for a plain read, is simply not found, and the
 * function raises `insufficient_privilege`.
 *
 * THESE WRAPPERS USED TO TAKE ONE ANYWAY, for symmetry with the rest of the module, and the
 * independent review was right to call it back: `astro check` reported all three as
 * `'userId' is declared but its value is never read`, and the comment defending them had to
 * warn in its own last sentence that the parameter "is not, and must not be read as, the
 * thing that authorises the call". A parameter whose documentation exists to tell you it
 * does nothing is worse than an asymmetry a reader can see. Renaming it `_userId` would have
 * silenced the tool and kept the misdirection, which is the opposite of the trade worth
 * making.
 *
 * WHY NOTHING IS VALIDATED HERE. `plan.runs` is passed VERBATIM — same key names, same
 * nesting, no reshaping on the wire — because the migration consumes exactly the shape
 * `planItemMove`/`planCategoryMove` produce and says so at length under "THE PAYLOAD SHAPE,
 * AND WHY IT IS THIS ONE". A transform in between is a place for a bug that neither side's
 * tests would see. The payload's shape, the ids' membership of the pack, and the affected
 * row count are all checked inside the transaction, where a failure aborts rather than
 * half-applying.
 *
 * WHY THE ENDPOINT MUST NOT BELIEVE THE PLAN IT WAS SENT. `src/lib/packs/reorder.ts`'s
 * header — "BOTH SIDES CALL THIS, ONLY ONE SIDE IS BELIEVED" — is the rule these wrappers
 * sit under: the island computes a plan to render the move optimistically, and the server
 * endpoint computes its OWN plan from rows it has just read under the caller's session and
 * passes THAT here. These functions cannot tell the two apart, which is why the rule lives
 * in the endpoint rather than in this file.
 */

/**
 * The three ids one item move names, as an object rather than as three adjacent parameters.
 *
 * THE POSITIONAL VERSION COMPILED WHEN TRANSPOSED, which is the whole reason this type
 * exists and is a finding from PK-37's independent review. `movePackItem(client, packId,
 * itemId, toCategoryId, runs)` put three `string`s in a row, and `database.types.ts` types
 * every id in this schema as a plain `string` — so swapping any two of them typechecked
 * perfectly and produced a call the RPC would refuse at runtime with a message naming the
 * wrong thing (`item % is not in pack %`). At a keyword-argument call site the same
 * transposition is a compile error, because the names are on the arguments rather than in
 * the reader's head.
 *
 * NO BRANDED ID TYPES, deliberately, and the alternative is named so it is not proposed
 * again as an improvement. Branding (`type PackId = string & { readonly __brand: 'pack' }`)
 * would catch the same mistake at every call site in the codebase rather than at this one —
 * and would require every id crossing the PostgREST boundary to be cast, because
 * `database.types.ts` is generated and types all of them as `string`. That is a change to
 * every query module and every fixture in the project, which is far past what this ticket
 * owns. An object parameter fixes the one signature the review flagged and costs nothing.
 */
export interface PackItemMoveIds {
  readonly packId: string;
  readonly itemId: string;
  readonly toCategoryId: string;
}

/**
 * Applies one item move — the re-parent and the recomputed positions — in one transaction.
 *
 * `toCategoryId` IS REQUIRED, AND A SAME-CATEGORY MOVE PASSES THE CATEGORY THE ITEM IS
 * ALREADY IN. That is the migration's own signature decision and it closes a trap
 * `reorder.ts` describes and cannot itself prevent: `plan.reparent` is present on every
 * cross-category move EVEN WHEN both runs' update lists come back empty — drag the only
 * item of one category into an empty one and its position is 0 before and 0 after — so a
 * caller treating an empty `runs` as "nothing to do" loses that move entirely. With the
 * destination as a required argument there is no call that can omit where the item ended up.
 *
 * `packId` IS NOT INFERRED FROM THE PAYLOAD, for the reason the migration gives: it is the
 * row that gets locked and the scope every id is then checked against, and deriving it from
 * the first id in the plan would make the authorisation check circular — it would prove the
 * ids agree with each other, which is also what a scrambling bug does.
 *
 * `locked` IS REPORTED SEPARATELY FROM `error`, AND IS NOT A SECOND WAY OF SAYING THE SAME
 * THING. It is true only for the migration's `55000` refusal, which means the pack is frozen
 * and the caller's move was not applied — a state the owner can undo. Every other error is
 * either a bug or an attack and gets the generic answer. Before PK-37's independent review
 * this distinction did not exist BECAUSE THE REFUSAL DID NOT EITHER: on a locked pack, a
 * cross-category move with an empty `runs` array returned success having written nothing,
 * because RLS filtered the re-parent to zero rows and nothing counted them. See the section
 * at the end of the migration.
 */
export async function movePackItem(
  client: PacksheetClient,
  ids: PackItemMoveIds,
  runs: readonly RunUpdate[],
): Promise<PackMoveResult> {
  const { error } = await client.rpc('move_pack_item', {
    p_pack_id: ids.packId,
    p_item_id: ids.itemId,
    p_to_category_id: ids.toCategoryId,
    // The plan's own array, cast rather than rebuilt. `Json` is the generated argument type
    // and `RunUpdate[]` is structurally a JSON value already — an object of a string and an
    // array of `{ id, position }` — so this asserts a fact TypeScript cannot check across
    // the `readonly` boundary rather than converting anything. Mapping it into a fresh array
    // would be the reshaping step the migration's payload-shape section exists to forbid.
    p_runs: runs as unknown as Json,
  });
  return { error, locked: isPackLocked(error) };
}

/** Applies a category reorder — one pack's categories, recomputed positions, one
 *  transaction. The same contract as `movePackItem` above with no re-parent: a category
 *  belongs to its pack and cannot move to another one, which is why `planCategoryMove`
 *  returns a plan whose `reparent` is always null and why this signature has no destination
 *  argument to mirror. Its one write's row count was already checked before PK-37's review,
 *  so what the corrected migration changes for THIS function is only what it says when that
 *  check fires on a locked pack — see `locked` on `movePackItem`. */
export async function movePackCategory(
  client: PacksheetClient,
  packId: string,
  runs: readonly RunUpdate[],
): Promise<PackMoveResult> {
  const { error } = await client.rpc('move_pack_category', {
    p_pack_id: packId,
    p_runs: runs as unknown as Json,
  });
  return { error, locked: isPackLocked(error) };
}

/**
 * Copies one pack, its categories and its items, and returns the new pack's id.
 *
 * WHAT THE COPY DOES NOT INHERIT is decided in the migration, not here, and is worth knowing
 * at the call site: the copy is PRIVATE regardless of the original's visibility, UNLOCKED
 * regardless of the original's `locked_at`, and carries a FRESH opaque slug. Duplicating a
 * locked pack is the point of the feature rather than an edge case — a user locks last
 * summer's trip for posterity and starts this year's from it — and the alternative
 * ("unlock, copy, re-lock") would clear every snapshot on the ORIGINAL, which the core
 * schema calls "silent data loss wearing the costume of history preservation".
 *
 * The name is copied verbatim with no ' (copy)' suffix. That is deliberate on the
 * migration's part — a user-facing string invented in a migration is one no designer will
 * ever find — so a caller that wants one renames the copy with `renamePack` afterwards.
 */
export async function duplicatePack(
  client: PacksheetClient,
  packId: string,
): Promise<PackDuplicateResult> {
  const { data, error } = await client.rpc('duplicate_pack', { p_pack_id: packId });
  return { error, id: data ?? null };
}
