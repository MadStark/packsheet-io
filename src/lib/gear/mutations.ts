/**
 * The gear closet's writes (PK-4): the closet list's bulk actions and undo, the trash's
 * restore and permanent delete, and the single-item edit/soft-delete
 * `src/pages/gear/[id].astro` performs — moved out of page frontmatter and into
 * `src/lib/gear/` (PK-4 review, C3) for the same reason as every read in
 * `src/lib/gear/query.ts` and `src/lib/gear/options.ts`: `vitest.config.ts` excludes
 * `src/pages/`, so a write statement living only in frontmatter is a write statement no
 * test can reach — including, as PK-4's independent review found by mutation testing,
 * the difference between a soft delete (undoable, per the ticket's own acceptance
 * criterion) and a hard `.delete()` (not).
 *
 * `src/lib/gear/bulk.ts` stays what its own module comment always said it was: pure
 * validation, no query. This module is the other half that comment described as
 * belonging to "the calling page" — now a page, and a test, share.
 *
 * EVERY FUNCTION HERE TAKES `client` AND `userId` AND SCOPES ITS OWN WRITE WITH
 * `.eq('user_id', userId)` — belt AND braces alongside RLS (`gear_items_update_own` /
 * `_delete_own`), which already confines every write here to the caller's own rows
 * with no "via public pack" counterpart the way the SELECT policies have (see
 * `query.ts`'s `loadGearCloset` comment for that half of the story). Adding the same
 * explicit filter to the write side costs nothing, and it means a shared function whose
 * entire contract is "acts on THIS visitor's rows" enforces that itself rather than
 * depending on RLS alone to make every future caller safe.
 *
 * EVERY WRITE REPORTS WHAT IT ACTUALLY DID, NOT WHAT IT WAS ASKED TO DO (PK-4 review,
 * I6). `.select('id')` on every mutation below, with `count` read off the rows the
 * write actually returned — never off the length of the id list the caller passed in.
 * A zero-row update (a stale link, a second tab that already moved these items, a race
 * with another request) is indistinguishable from a real one over plain PostgREST
 * otherwise, and a page that reports "1 item moved to the trash" from the REQUEST
 * rather than the RESULT can say that about an update that touched nothing at all.
 */

import type { PostgrestError } from '@supabase/supabase-js';
import type { PacksheetClient } from '../supabase';
import type { GearStatus } from './fields';
import type { GearItemInput } from './form';

/** What every write below reports: whether it failed, and how many rows it actually
 *  touched — see the module comment's "EVERY WRITE REPORTS..." section for why `count`
 *  is read off the write's own `.select('id')` rather than off the caller's input. */
export interface GearMutationResult {
  readonly error: PostgrestError | null;
  readonly count: number;
}

/**
 * Moves `ids` to the trash, stamping every affected row with the SAME `token` — see
 * `makeUndoToken`'s own module comment (`bulk.ts`) for why one shared token, minted
 * once by the caller before this runs, is what makes undo possible at all.
 * `.is('deleted_at', null)` IS LOAD-BEARING: see `bulk.ts`'s "THE CALLER MUST GUARD"
 * section for what a retried or double-submitted delete does without it.
 */
export async function bulkSoftDelete(
  client: PacksheetClient,
  userId: string,
  ids: readonly string[],
  token: string,
): Promise<GearMutationResult> {
  const { data, error } = await client
    .from('gear_items')
    .update({ deleted_at: token })
    .eq('user_id', userId)
    .in('id', ids as string[])
    .is('deleted_at', null)
    .select('id');
  return { error, count: data?.length ?? 0 };
}

/** Restores every row this visitor soft-deleted under `token` — the write half of the
 *  undo mechanism `bulk.ts`'s module comment documents in full. Matching on the token
 *  alone (no `ids` list) is deliberate and unchanged from the original design: see
 *  `bulk.ts`'s "WHY MATCHING ON THE TIMESTAMP ITSELF IS SOUND" section. */
export async function undoBulkDelete(
  client: PacksheetClient,
  userId: string,
  token: string,
): Promise<GearMutationResult> {
  const { data, error } = await client
    .from('gear_items')
    .update({ deleted_at: null })
    .eq('user_id', userId)
    .eq('deleted_at', token)
    .select('id');
  return { error, count: data?.length ?? 0 };
}

/** Sets `category` on every id in `ids`, restricted to active (non-trashed) rows — the
 *  same `.is('deleted_at', null)` guard every other bulk write here uses, so a stale
 *  selection cannot reach back into an already-trashed row. `category: null` clears
 *  the field, mirroring `parseBulkAction`'s own "empty box means clear it" reading. */
export async function bulkSetCategory(
  client: PacksheetClient,
  userId: string,
  ids: readonly string[],
  category: string | null,
): Promise<GearMutationResult> {
  const { data, error } = await client
    .from('gear_items')
    .update({ category })
    .eq('user_id', userId)
    .in('id', ids as string[])
    .is('deleted_at', null)
    .select('id');
  return { error, count: data?.length ?? 0 };
}

/** Sets `status` on every id in `ids` — same shape and guard as `bulkSetCategory`. */
export async function bulkSetStatus(
  client: PacksheetClient,
  userId: string,
  ids: readonly string[],
  status: GearStatus,
): Promise<GearMutationResult> {
  const { data, error } = await client
    .from('gear_items')
    .update({ status })
    .eq('user_id', userId)
    .in('id', ids as string[])
    .is('deleted_at', null)
    .select('id');
  return { error, count: data?.length ?? 0 };
}

/** Restores trashed items back into the closet — `src/pages/gear/trash.astro`'s
 *  `bulk-restore`. `.not('deleted_at', 'is', null)` confines this to rows that are
 *  actually in the trash, mirroring that page's own original comment on the same
 *  guard: a stale or crafted id for an already-active item is not something this
 *  should "restore" into touching `updated_at` for no reason. */
export async function restoreFromTrash(
  client: PacksheetClient,
  userId: string,
  ids: readonly string[],
): Promise<GearMutationResult> {
  const { data, error } = await client
    .from('gear_items')
    .update({ deleted_at: null })
    .eq('user_id', userId)
    .in('id', ids as string[])
    .not('deleted_at', 'is', null)
    .select('id');
  return { error, count: data?.length ?? 0 };
}

/** The one genuinely irreversible write in the gear closet — `src/pages/gear/
 *  trash.astro`'s `bulk-delete-permanently`, reached only after
 *  `confirmsPermanentDeletion` has gated it. `gear_items_snapshot_before_delete`
 *  (core_schema.sql) fires per row and freezes it into any `pack_items` still
 *  referencing it — the entire reason a real delete is even safe to offer. */
export async function permanentlyDeleteGear(
  client: PacksheetClient,
  userId: string,
  ids: readonly string[],
): Promise<GearMutationResult> {
  const { data, error } = await client
    .from('gear_items')
    .delete()
    .eq('user_id', userId)
    .in('id', ids as string[])
    .select('id');
  return { error, count: data?.length ?? 0 };
}

/** Soft-deletes exactly one item — `src/pages/gear/[id].astro`'s own delete action,
 *  sharing the same undo-token mechanism and `.is('deleted_at', null)` guard as
 *  `bulkSoftDelete` above, scaled down to a single id so that page can redirect to the
 *  SAME undo banner the closet list's bulk delete uses. */
export async function softDeleteGearItem(
  client: PacksheetClient,
  userId: string,
  id: string,
  token: string,
): Promise<GearMutationResult> {
  const { data, error } = await client
    .from('gear_items')
    .update({ deleted_at: token })
    .eq('user_id', userId)
    .eq('id', id)
    .is('deleted_at', null)
    .select('id');
  return { error, count: data?.length ?? 0 };
}

/** Saves an edit to exactly one item. `.is('deleted_at', null)` keeps a trashed item's
 *  edit form (unreachable through this product's own UI, but not through a
 *  hand-crafted request) from being able to silently change a field on a row
 *  `src/pages/gear/[id].astro` no longer renders for. */
export async function updateGearItem(
  client: PacksheetClient,
  userId: string,
  id: string,
  values: GearItemInput,
): Promise<GearMutationResult> {
  const { data, error } = await client
    .from('gear_items')
    .update(values)
    .eq('user_id', userId)
    .eq('id', id)
    .is('deleted_at', null)
    .select('id');
  return { error, count: data?.length ?? 0 };
}
