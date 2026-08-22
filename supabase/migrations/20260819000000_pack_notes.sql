-- A pack's private note (PK-72), and the two operations the pack-details dialog needs
-- that cannot be one statement.
--
-- ---------------------------------------------------------------------------
-- WHY `notes` IS NOT A COLUMN ON `packs`
-- ---------------------------------------------------------------------------
--
-- The ticket asked for `packs.notes`. A column on `packs` cannot be private, and the
-- reason is written down in the migration that created the table —
-- `20260810120000_core_schema.sql`, the "KNOWN GAP" comment above the grants. The short
-- form:
--
--   `packs_select_public` is `for select to anon, authenticated using (visibility =
--   'public')`. RLS filters ROWS, not columns. `grant select on public.packs to anon`
--   then hands over every column PostgREST is asked for. So the moment a pack is
--   published, `GET /packs?select=notes&slug=eq.x` answers with the note, to anyone.
--
-- and the fix that looks obvious does not work:
--
--   `grant select (id, name, ...)` — a column-level grant — makes PostgREST refuse the
--   share page's whole query, because it requires table-level SELECT on every table
--   participating in an embed:
--
--       GET /packs?select=id,pack_categories(id)  ->  42501 permission denied for table packs
--
-- core_schema.sql names the only two mechanisms that do work: a `security_invoker` view
-- exposing the public columns, or moving the private field to a 1:1 owner-only table.
-- This migration takes the second, which that comment describes as making "the boundary
-- structural" and needing "no grant subtlety at all". The first would mean revoking
-- anon's SELECT on `packs` and re-pointing every anonymous read at a view — a change
-- that belongs with the share page (Ref 26), not with a dialog.
--
-- The property that buys: `anon` holds NO privilege on `public.pack_notes`. Not a
-- narrowed one — none. A future policy written carelessly on this table cannot leak it,
-- because a policy cannot grant a privilege that was never given. `tests/rls-enabled.
-- test.ts` sweeps every table in `public` for RLS and for at least one policy with no
-- allow-list, so this table is covered by that sweep the day it exists.
--
-- NOT A CONTRADICTION OF `gear_items.notes`, which IS readable by a stranger on a public
-- pack and has a test asserting so (`tests/rls-anon.test.ts`, "a public pack carries its
-- prices and extras to an anonymous reader"). That is the known gap above, deliberately
-- deferred. This ticket was asked for a note that is private and for a test proving it,
-- which is a different requirement, not a re-litigation of that one.

-- ---------------------------------------------------------------------------
-- pack_notes
-- ---------------------------------------------------------------------------

create table public.pack_notes (
  -- The pack IS the key. 1:1 by construction rather than by convention: there is no
  -- surrogate id and no `unique (pack_id)` to forget, so "two notes on one pack" is
  -- unrepresentable rather than merely unusual.
  pack_id uuid primary key,

  -- Denormalised and held true by the composite foreign key below, exactly as
  -- `pack_categories` does it. The FK references `packs (user_id, id)`, so a row whose
  -- `user_id` disagrees with its pack's owner has no parent and cannot be inserted —
  -- which is what makes cross-tenant re-parenting unrepresentable here too, rather than
  -- something the policies have to catch.
  user_id uuid not null default auth.uid(),

  notes text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  foreign key (user_id, pack_id) references public.packs (user_id, id) on delete cascade
);

comment on table public.pack_notes is
  'A pack''s private note, kept off `packs` so that publishing a pack cannot publish it. anon holds no privilege on this table at all.';
comment on column public.pack_notes.notes is
  'Private to the owner. Never granted to anon — contrast packs.description, which is public.';

create trigger pack_notes_set_row_timestamps
  before insert on public.pack_notes
  for each row execute function public.set_row_timestamps();

create trigger pack_notes_set_updated_at
  before update on public.pack_notes
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
--
-- Owner-only, all four verbs, and DELIBERATELY NO `_select_public` POLICY. Every other
-- pack-shaped table in this schema has one; this table's absence of one is the feature.
-- The grants below are the real boundary — the policies are the second lock, not the
-- first.

alter table public.pack_notes enable row level security;

create policy pack_notes_select_own on public.pack_notes
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy pack_notes_insert_own on public.pack_notes
  for insert to authenticated
  with check (user_id = (select auth.uid()));

create policy pack_notes_update_own on public.pack_notes
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy pack_notes_delete_own on public.pack_notes
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
--
-- `revoke all` first, for the reason core_schema.sql gives: a table created in `public`
-- picks up whatever the default privileges hand out, and the revoke is what makes the
-- grants below the complete list rather than an addition to an unknown one.
--
-- anon is named in the revoke and appears in no grant. That asymmetry is the whole
-- point of this file.

revoke all on public.pack_notes from anon, authenticated, service_role;

grant select, insert, update, delete on public.pack_notes to authenticated;
grant select, insert, update, delete on public.pack_notes to service_role;

-- ---------------------------------------------------------------------------
-- create_pack_with_defaults
-- ---------------------------------------------------------------------------
--
-- Creating a pack is now four inserts — the pack, and the four categories every new
-- pack starts with — plus a fifth when a note was typed. A PostgREST request is one
-- transaction, so one RPC is what makes "one transaction" true for the caller. Five
-- round trips from a browser are five transactions, and the windows between them are
-- where a pack ends up existing with two of its four categories.
--
-- AN RPC RATHER THAN A TRIGGER ON `packs`, and that is not a style preference. A
-- `before insert on public.packs` trigger fires for EVERY caller, including
-- `tests/support/fixtures.ts`, which creates a pack and exactly one category and whose
-- callers index `pack_categories[0]` and assert `length === 1`
-- (`tests/core-schema.test.ts`, `tests/rls-owner.test.ts`). Seeding from a trigger would
-- turn every fixture pack in the suite into a five-category pack and break those tests
-- for reasons having nothing to do with what they are testing. The established pattern
-- in this schema for "more than one statement, atomically" is an explicit function the
-- application calls — `move_pack_item`, `move_pack_category`, `duplicate_pack` — and
-- this joins them.
--
-- `security invoker`, like all three of those: this function needs to see nothing its
-- caller cannot. The insert into `packs` is governed by `packs_insert_own` and the
-- categories by `pack_categories_insert_own`, evaluated as the calling user. There is no
-- ownership check written here because there is no row to check — everything this
-- function touches, it is creating, and `user_id` defaults to `auth.uid()` on all three
-- tables. An unauthenticated caller gets `auth.uid() = null`, fails the `not null` on
-- `packs.user_id`, and never reaches the categories.

-- The four categories every new pack starts with, in the order they are shown.
--
-- Hard-coded here rather than read from a settings table because that is what they are
-- today: a product decision with one answer, not a preference anyone can express. When
-- they become editable this function keeps its shape and reads them from somewhere else.
create or replace function public.create_pack_with_defaults(
  p_name text,
  p_description text,
  p_trip_type text,
  p_notes text
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_pack_id uuid;
begin
  -- `slug`, `visibility`, `locked_at`, `created_at` and `updated_at` are all omitted so
  -- the table's own defaults and triggers supply them — the same list, and the same
  -- reason, as `duplicate_pack`'s insert. A new pack is private; publishing is a
  -- decision someone makes later.
  insert into public.packs (name, description, trip_type)
  values (p_name, p_description, p_trip_type)
  returning id into v_pack_id;

  -- `position` is supplied explicitly and ascending. No arithmetic: the ordinality of a
  -- literal list is not a computed index, and `src/lib/packs/reorder.ts` remains the only
  -- thing in the product that decides what a position becomes when something moves.
  insert into public.pack_categories (pack_id, name, position)
  select v_pack_id, name, position
    from (values
      ('Packing', 0),
      ('Sleep', 1),
      ('Clothing', 2),
      ('Cooking', 3)
    ) as defaults (name, position);

  -- Only when there is something to store. A pack with no note has no row here, rather
  -- than a row holding null — so "has the owner written a note" is answered by the
  -- row's existence and the table stays empty for the majority of packs that never get
  -- one. `null` and `''` both land here as "no note", because `parsePackForm` has
  -- already turned a blank textarea into null before this is called.
  if p_notes is not null then
    insert into public.pack_notes (pack_id, notes)
    values (v_pack_id, p_notes);
  end if;

  return v_pack_id;
end;
$$;

comment on function public.create_pack_with_defaults(text, text, text, text) is
  'Creates a pack, its four default categories (Packing, Sleep, Clothing, Cooking) and its private note in one transaction, returning the new pack''s id. A pack that exists without its categories is not a reachable state.';

revoke all on function public.create_pack_with_defaults(text, text, text, text)
  from public, anon, service_role;
grant execute on function public.create_pack_with_defaults(text, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- update_pack_details
-- ---------------------------------------------------------------------------
--
-- The edit half of the same dialog. Two statements — the pack, and its note — and the
-- same argument for one transaction: a save that updated the description and then failed
-- to write the note would leave the dialog's two halves disagreeing, with nothing to
-- tell the user which one landed.
--
-- RETURNS THE NUMBER OF PACKS UPDATED, which is 1 or 0, because the caller has to be
-- able to tell "saved" from "that pack is not yours / no longer exists". `updatePack` in
-- `src/lib/packs/mutations.ts` already reports `count` for exactly this and the page
-- already branches on it (`PACK_NOT_SAVED_MESSAGE`); returning void here would throw
-- that away and force the caller to re-read the row to find out what happened.
--
-- Note that 0 does NOT mean "locked". `packs_update_own` carries no `locked_at` clause —
-- an owner may always edit a pack's details, and unlocking is itself such an edit. The
-- freeze applies to a pack's CONTENTS, not to its name.
create or replace function public.update_pack_details(
  p_pack_id uuid,
  p_name text,
  p_description text,
  p_trip_type text,
  p_notes text
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_count integer;
begin
  update public.packs
     set name = p_name,
         description = p_description,
         trip_type = p_trip_type
   where id = p_pack_id;

  get diagnostics v_count = row_count;

  -- Nothing was updated: the pack is not visible to this caller for writing, or is gone.
  -- Return early rather than touching the note — writing a note for a pack we were not
  -- allowed to rename would be the one cross-tenant write this function could perform.
  -- (`pack_notes`'s composite FK would refuse it anyway; this makes the refusal explicit
  -- rather than incidental.)
  if v_count = 0 then
    return 0;
  end if;

  if p_notes is null then
    -- Clearing the note removes the row rather than nulling it, keeping "a row means a
    -- note" true in both directions. Deleting a note that was never there is a no-op.
    delete from public.pack_notes where pack_id = p_pack_id;
  else
    insert into public.pack_notes (pack_id, notes)
    values (p_pack_id, p_notes)
    on conflict (pack_id) do update set notes = excluded.notes;
  end if;

  return v_count;
end;
$$;

comment on function public.update_pack_details(uuid, text, text, text, text) is
  'Saves a pack''s name, description, trip type and private note in one transaction. Returns the number of packs updated — 0 means the pack is not the caller''s or no longer exists, never that it is locked.';

revoke all on function public.update_pack_details(uuid, text, text, text, text)
  from public, anon, service_role;
grant execute on function public.update_pack_details(uuid, text, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- delete_own_account() — six tables becomes seven
-- ---------------------------------------------------------------------------
--
-- See 20260817000000_user_profiles.sql's "five tables becomes six" comment for the full
-- argument; this is the same argument for pack_notes. `pack_notes` is a new user-owned
-- table (it has a `user_id` column) and was never added to this function when this file
-- created it. Its own `on delete cascade` from `packs` would remove it correctly on its
-- own — which is exactly why it still has to be named here rather than despite that: the
-- function's guarantee is "this deletes the caller's data by name, and nothing another
-- user owns", and a table missing from the list is one whose removal depends on a cascade
-- firing correctly. Placed before the `packs` delete, alongside `pack_items` and
-- `pack_categories`, since it is a leaf that references `packs` through the same
-- composite `(user_id, pack_id) references packs (user_id, id)` foreign key those two
-- tables use.
create or replace function public.delete_own_account()
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.pack_items where user_id = (select auth.uid());
  delete from public.pack_categories where user_id = (select auth.uid());
  delete from public.pack_notes where user_id = (select auth.uid());
  delete from public.packs where user_id = (select auth.uid());
  delete from public.gear_items where user_id = (select auth.uid());
  delete from public.profiles where user_id = (select auth.uid());
  delete from auth.users where id = (select auth.uid());
$$;

comment on function public.delete_own_account() is
  'Deletes every row the calling user owns — pack_items, pack_categories, pack_notes, packs, gear_items, profiles, then the auth.users row itself, in that leaf-to-root order — and nothing another user owns. Takes no arguments: auth.uid() is the only identity it can ever act on. SECURITY DEFINER because ordinary policies on our own tables cannot express deleting the identity itself, and because authenticated holds no privilege on auth.users at all. Deletes seven tables by name rather than relying on auth.users cascading them, because letting Postgres interleave cascades from one statement hits a referential-integrity race — see the comment above the function in 20260811000000_account_deletion.sql for the reproduction. Callable only by authenticated; see the revoke/grant immediately below.';

-- `create or replace function` PRESERVES the existing ACL, so the revoke and grant already
-- in force still hold — re-stating them here is belt and braces against a future edit that
-- reaches for `drop function` and `create` instead, which does NOT preserve the ACL, in
-- exactly the way 20260817000000_user_profiles.sql re-states them for the same function.
revoke all on function public.delete_own_account() from public, anon;
grant execute on function public.delete_own_account() to authenticated;
