-- The core schema: gear_items, packs, pack_categories, pack_items.
--
-- Refs 7 and 49, deliberately one migration. Ref 49's first requirement is that row
-- level security is enabled "in the same migration that creates it — never a
-- follow-up", so the tables and the policies that guard them cannot be split into two
-- changes without producing exactly the window that ticket exists to close: a table
-- live in `public` with RLS off is not "unprotected pending policies", it is readable
-- by the `anon` key, which is public by design and shipped to every browser.
--
-- ---------------------------------------------------------------------------
-- THE THREE RULES THIS MODEL EXISTS TO ENFORCE
-- ---------------------------------------------------------------------------
--
--   1. Editing a gear item updates every pack referencing it — EXCEPT where a pack
--      item holds an override. Hence `pack_items.gear_item_id` is a reference and
--      never a copy, and `pack_items.overrides` is the per-list divergence.
--
--   2. Locking a pack freezes it. `packs.locked_at` plus `pack_items.snapshot`, and
--      the write policies below refuse edits to a locked pack's contents, so the
--      freeze is enforced by the database rather than remembered by the client.
--
--   3. Deleting a gear item never destroys pack history. A BEFORE DELETE trigger
--      materialises the snapshot into every referencing pack item first, the foreign
--      key then nulls only `gear_item_id`, and a check constraint makes a pack item
--      with neither a reference nor a snapshot unrepresentable.
--
-- ---------------------------------------------------------------------------
-- TWO LAYERS, NOT ONE
-- ---------------------------------------------------------------------------
--
-- Reachability on the Data API is decided by GRANTs; which rows come back is decided
-- by RLS. They are independent and both are written explicitly here, because each is
-- silently useless without the other: policies on a table `anon` was never granted
-- are unreachable code, and a grant without policies is the leak.
--
-- This is not the historical Supabase default. supabase/config.toml leaves
-- `auto_expose_new_tables` unset, which matches the current cloud behaviour: a table
-- created by `postgres` in `public` is NOT auto-granted to anon/authenticated. Nothing
-- below relies on that default holding — every privilege is granted or withheld by
-- name, functions included — but it is why the GRANT block exists at all rather than a
-- REVOKE block.

-- ---------------------------------------------------------------------------
-- gear_items — the closet, and the master record
-- ---------------------------------------------------------------------------

create table public.gear_items (
  id uuid primary key default gen_random_uuid(),

  -- Defaulted from the JWT rather than sent by the client. The insert policy checks
  -- the same value, so a client that sends someone else's id is refused rather than
  -- quietly corrected — but a client that sends nothing gets the right answer.
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,

  name text not null check (length(btrim(name)) > 0),
  brand text,
  category text,
  description text,

  -- Weight is stored as entered, with its unit, exactly as the ticket specifies.
  -- Canonicalising to grams at write time would lose the user's own precision on the
  -- imperial path (a 4.4 oz entry is not 124.7381 g to anybody), and the totals it
  -- would speed up are pure functions owned by Ref 23, computed from these two
  -- columns. If a canonical column is ever needed for sorting or aggregation in the
  -- database, it belongs there as a generated column derived from these — not as a
  -- replacement for them.
  -- `< 'Infinity'` is not decoration, and it is not the same as `>= 0`. Postgres orders
  -- NaN ABOVE every other numeric value, so `'NaN'::numeric >= 0` is TRUE and a plain
  -- non-negativity check lets NaN straight in through the ordinary Data API. One NaN
  -- poisons every total that touches it, cannot be spotted by eye in a list, and is
  -- removable only by an update. The upper bound excludes NaN and Infinity together,
  -- because NaN fails `< 'Infinity'` for the same ordering reason.
  weight numeric(12, 3) not null default 0 check (weight >= 0 and weight < 'Infinity'::numeric),
  weight_unit text not null default 'g' check (weight_unit in ('g', 'kg', 'oz', 'lb')),

  price numeric(12, 2) check (price >= 0 and price < 'Infinity'::numeric),
  -- ISO 4217. char(3) rather than text so a currency symbol or a stray name fails on
  -- entry instead of reaching a formatter that has to guess.
  currency char(3) check (currency ~ '^[A-Z]{3}$'),

  -- A price without its currency is a number no formatter can render, and a currency
  -- without a price is a unit with nothing to measure. The column above goes to real
  -- trouble to make the currency unguessable; permitting half a pair would put the
  -- guess back.
  constraint gear_items_price_has_currency check ((price is null) = (currency is null)),

  -- Litres. The ticket names one `volume` field and no unit column for it, so the
  -- unit lives in the column name; there is nowhere else for it to live and an
  -- unqualified `volume` is the kind of ambiguity that gets read as millilitres once.
  volume_litres numeric(12, 3) check (volume_litres >= 0 and volume_litres < 'Infinity'::numeric),

  url text,

  -- A storage key, not a URL. Ref 10 generates a size ladder into R2 and the served
  -- URL is derived from this plus a size; storing the URL would bake today's bucket
  -- hostname into every row.
  photo_path text,

  notes text,

  -- Three values, chosen here rather than left open because an unconstrained text
  -- column becomes a de-facto enum with typos in it. Extending this list is a one-line
  -- constraint change and no data migration, which is the property worth having.
  status text not null default 'owned' check (status in ('owned', 'wishlist', 'retired')),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Not redundant with the primary key. It is the target of the composite foreign key
  -- on pack_items, which is what makes it structurally impossible for one user's pack
  -- to reference another user's gear. See the note there.
  unique (user_id, id)
);

comment on table public.gear_items is
  'The gear closet: the master record for a piece of gear. Pack items reference these rows, never copy them.';
comment on column public.gear_items.weight is
  'Stored in weight_unit, as entered. Conversion and totalling are pure functions in the application (Ref 23), not database concerns.';
comment on column public.gear_items.photo_path is
  'Storage key for the original upload. The served URL is derived from it; never store a URL here.';

-- ---------------------------------------------------------------------------
-- packs
-- ---------------------------------------------------------------------------

create table public.packs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,

  name text not null check (length(btrim(name)) > 0),
  description text,
  trip_type text,

  -- WHAT VISIBILITY MEANS, decided before the policy was written because the policy is
  -- what gives it meaning (Ref 49):
  --
  --   'private'  the owner, and nobody else. The `anon` key returns zero rows for it,
  --              by id and by slug alike.
  --   'public'   listed. Not merely "readable by anyone holding the link": the Data API
  --              answers an unfiltered `GET /rest/v1/packs` with the publishable key, so
  --              a public pack is enumerable by strangers, not just reachable by them.
  --
  -- Two values, not three — and the honest version of that argument is narrower than
  -- "nothing consumes the difference yet". An 'unlisted' value would have to be excluded
  -- from the enumeration described above, and no code path expresses that today, so
  -- shipping it now would create a name with no mechanism behind it. That is a reason to
  -- defer the value, not evidence the distinction is meaningless: a user publishing one
  -- pack today is enrolled in a public listing, which is a product decision worth making
  -- deliberately rather than discovering. It is text with a CHECK rather than a boolean
  -- precisely so adding the third value later is a constraint change, not the data
  -- migration Ref 49 warns about.
  --
  -- Default 'private'. A pack that becomes public does so because someone said so.
  visibility text not null default 'private' check (visibility in ('private', 'public')),

  -- citext, so /p/Ultralight and /p/ultralight cannot become two different packs — the
  -- reason the baseline migration installs the extension. NOT NULL and defaulted, so
  -- there is no state in which a pack is made public and is then unreachable because
  -- nobody generated its slug. The default is deliberately opaque rather than derived
  -- from the name: a name-derived slug leaks the title of a pack that is still
  -- private. Clients are free to replace it with a readable one when the pack is
  -- published.
  slug citext not null unique default substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)
    check (length(slug) between 3 and 64 and slug ~ '^[A-Za-z0-9][A-Za-z0-9_-]*$'),

  -- Rule 2. Non-null means frozen; the write policies on pack_categories and
  -- pack_items refuse edits while it is set. Clearing it is an update to this table,
  -- which the owner may do — unlocking is a decision, not an impossibility.
  locked_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (user_id, id)
);

comment on table public.packs is
  'A pack list. visibility is the authorization input: private means the anon key returns zero rows, public means readable by anyone.';
comment on column public.packs.slug is
  'Case-insensitive public identifier. Always present so publishing never requires a second write; opaque by default so a private pack''s title does not leak.';
comment on column public.packs.locked_at is
  'Set when the pack is frozen for posterity. While non-null, the write policies refuse changes to its categories and items.';

-- ---------------------------------------------------------------------------
-- pack_categories
-- ---------------------------------------------------------------------------

create table public.pack_categories (
  id uuid primary key default gen_random_uuid(),

  -- Denormalised from the parent pack and held true by the composite foreign key
  -- below, not by application discipline. Two things come out of it: every owner
  -- policy in this file is a plain column comparison instead of a join, and a row
  -- cannot be re-parented into another user's pack — the FK target (user_id, pack_id)
  -- simply does not exist there.
  user_id uuid not null default auth.uid(),
  pack_id uuid not null,

  name text not null check (length(btrim(name)) > 0),

  -- Integer ordering with a reindex, not a fractional index. Decided here rather than
  -- left to the first reorder (Ref 7 asks for the decision explicitly).
  --
  -- A move rewrites the affected run of siblings in one statement inside one
  -- transaction. That is O(n) writes against a list whose acceptance criterion is 40
  -- items, where a fractional index buys a single-row update at the cost of an
  -- ordering library on both sides of the wire and positions no human can read in a
  -- query result. Deliberately NOT unique: a unique (parent, position) pair forces
  -- every reindex through a DEFERRABLE constraint or a temporary negative range, and
  -- that machinery is a poor trade for ties that resolve deterministically on id.
  --
  -- Non-negative, though. Duplicate positions are a deliberate allowance; negatives are
  -- just a reindex that went wrong, and permitting them means the temporary-negative-
  -- range trick a reindex might use can be left behind in the data by a failed
  -- transaction.
  position integer not null default 0 check (position >= 0),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  foreign key (user_id, pack_id) references public.packs (user_id, id) on delete cascade,
  unique (user_id, id)
);

comment on table public.pack_categories is
  'An ordered group within a pack. user_id is denormalised and held true by the composite FK to packs, which is what makes cross-tenant re-parenting unrepresentable.';

-- ---------------------------------------------------------------------------
-- pack_items
-- ---------------------------------------------------------------------------

create table public.pack_items (
  id uuid primary key default gen_random_uuid(),

  user_id uuid not null default auth.uid(),
  pack_category_id uuid not null,

  -- Rule 1: a reference, never a copy.
  --
  -- The composite foreign key is the load-bearing part, and it is not decoration.
  -- Foreign keys are checked by the system, NOT under row level security, so a plain
  -- `gear_item_id references gear_items(id)` would happily accept another user's gear
  -- id from anyone who guessed one. That is not a hypothetical leak: the anon read
  -- policy on gear_items below grants read access to gear referenced by a public pack,
  -- so a plain FK would let an attacker point a public pack of their own at a private
  -- gear row and read it straight out. Requiring (user_id, gear_item_id) to exist in
  -- gear_items closes it in the schema, where no policy can be edited around it.
  gear_item_id uuid,

  quantity integer not null default 1 check (quantity > 0),
  worn boolean not null default false,
  consumable boolean not null default false,
  packed boolean not null default false,

  -- See the note on pack_categories.position.
  position integer not null default 0 check (position >= 0),

  -- Rule 1's exception: per-list divergence from the master record. An empty object,
  -- never null, so consumers merge unconditionally instead of branching on null.
  overrides jsonb not null default '{}'::jsonb check (jsonb_typeof(overrides) = 'object'),

  -- Rule 2 and rule 3: the frozen copy. Null until something freezes it.
  --
  -- The shape check is the difference between "there is a snapshot" and "this row can
  -- render itself". `snapshot` is an ordinary column with UPDATE granted to its owner,
  -- so without it `set snapshot = '{}', gear_item_id = null` satisfies the
  -- reference-or-snapshot constraint below and leaves an item that displays as
  -- nothing — one PATCH away, through the normal Data API. Requiring the two fields
  -- gear_item_snapshot() always writes makes the constraint mean what its comment says.
  -- It is a shape check, not a provenance check: it cannot tell a real freeze from a
  -- well-formed hand-written one, and is not trying to.
  snapshot jsonb check (
    snapshot is null
    or (
      jsonb_typeof(snapshot) = 'object'
      and snapshot ? 'captured_at'
      and length(btrim(coalesce(snapshot ->> 'name', ''))) > 0
    )
  ),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Rule 3, made structural. A pack item must always be able to render itself: either
  -- it still points at a gear item, or it carries the snapshot taken when that gear
  -- item was deleted. There is no third state, so "deleting gear silently blanked a
  -- locked trip" cannot be reached from any code path.
  constraint pack_items_reference_or_snapshot
    check (gear_item_id is not null or snapshot is not null),

  foreign key (user_id, pack_category_id)
    references public.pack_categories (user_id, id) on delete cascade,

  -- ON DELETE SET NULL with a column list (Postgres 15+): null only gear_item_id and
  -- leave user_id alone. Without the list this clause would try to null both columns
  -- of the referencing pair and fail against user_id's NOT NULL — turning every gear
  -- deletion into an error instead of the fallback rule 3 describes.
  foreign key (user_id, gear_item_id)
    references public.gear_items (user_id, id) on delete set null (gear_item_id)
);

comment on table public.pack_items is
  'A gear item''s appearance in one pack. References the closet rather than copying it; overrides hold per-list divergence and snapshot holds the frozen copy.';
comment on column public.pack_items.overrides is
  'Per-list divergence from the referenced gear item. Always an object; merged over the master record at read time.';
comment on column public.pack_items.snapshot is
  'Frozen copy, written by gear_item_snapshot(). Non-null once the pack is locked or the referenced gear item is deleted.';

-- ---------------------------------------------------------------------------
-- Rule 3: freeze before the reference goes
-- ---------------------------------------------------------------------------

-- The canonical shape of a frozen gear item.
--
-- One function so the two paths that freeze — locking a pack (Ref 12) and deleting a
-- gear item (rule 3, below) — cannot drift into writing two different shapes into the
-- same column. A reader of `pack_items.snapshot` must not have to ask which one wrote
-- it.
--
-- Declared here rather than with the other helpers at the top of this file because it
-- takes a gear_items row as its parameter type: the table has to exist first.
--
-- STABLE, not IMMUTABLE: it reads now(). Marking it immutable would let the planner
-- fold it, and a snapshot stamped with the wrong time is worse than no stamp.
-- Into `private`, not `public`, and that is a security boundary rather than tidiness.
--
-- `public` is an exposed PostgREST schema (see [api] schemas in config.toml), and a
-- function is created with EXECUTE granted to PUBLIC by default — so a helper defined
-- there is an anonymous RPC endpoint the moment it exists:
--
--     POST /rest/v1/rpc/gear_item_snapshot   (apikey: anon)   ->   200
--
-- This particular function only echoes back a row the caller supplied, so nothing
-- leaked. The reason for the schema is the NEXT helper: the standard remedy for policy
-- recursion in Supabase is a SECURITY DEFINER function, and one of those written in
-- `public` out of habit would land on the anonymous RPC surface, running as its owner,
-- with nothing going red. A schema PostgREST does not serve makes that mistake
-- unreachable instead of merely unlikely.
create schema if not exists private;

comment on schema private is
  'Helpers that are implementation, not API. Deliberately absent from [api] schemas in config.toml, so nothing here is reachable over PostgREST — put SECURITY DEFINER functions here, never in public.';

-- USAGE only, and only to the roles that reach these functions from inside a
-- SECURITY INVOKER trigger. `anon` gets nothing: it has no write privilege on any core
-- table, so it never reaches a freeze path.
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

create or replace function private.gear_item_snapshot(item public.gear_items)
returns jsonb
language sql
stable
-- SECURITY INVOKER and an empty search_path, for the reasons the baseline migration
-- sets out on set_updated_at(): a DEFINER function reachable from a table trigger runs
-- as its owner and would step straight over the policies below, and a mutable
-- search_path hands name resolution to whoever calls it.
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'name', item.name,
    'brand', item.brand,
    'category', item.category,
    'description', item.description,
    'weight', item.weight,
    'weight_unit', item.weight_unit,
    'price', item.price,
    'currency', item.currency,
    'volume_litres', item.volume_litres,
    'photo_path', item.photo_path,
    'gear_item_id', item.id,
    'captured_at', now()
  );
$$;

-- NOT captured: `notes` and `url`. This is a display record — the fields needed to
-- render the item after its gear is gone — and not an audit log of the gear row.
--
-- It is also the half of the notes/url exposure noted in the grants block below that
-- this migration CAN close. `anon` reads `pack_items.snapshot` on a public pack, so
-- freezing those fields would publish them permanently and put them somewhere a later
-- fix to the live path would not reach. Whether the live path exposes them is Ref 26's
-- decision; whether a frozen pack carries them forever is decided here, and the answer
-- is no.

grant execute on function private.gear_item_snapshot(public.gear_items)
  to authenticated, service_role;

comment on function private.gear_item_snapshot(public.gear_items) is
  'The frozen form of a gear item, as written into pack_items.snapshot. Used by both freeze paths — pack locking and gear deletion — so the two cannot drift.';

-- BEFORE DELETE, so the snapshots are in place by the time the foreign key action
-- nulls gear_item_id. The check constraint is what makes the ordering safe to rely on:
-- if this trigger were dropped, the deletion would fail loudly on the constraint
-- rather than succeed and leave unrenderable rows behind.
--
-- SECURITY INVOKER. The update it performs is subject to the same policies as any
-- other write, which is correct — but "the owner always has the rights to stamp it" is
-- NOT the whole reason, and reading it that way hides the coupling. Same ownership is
-- necessary and not sufficient: pack_items_update_own also requires the parent pack to
-- be unlocked. This works because a locked pack's items already carry a snapshot, so
-- the `snapshot is null` filter below matches none of them and the blocked write is
-- never attempted. That invariant is established by freeze_pack_items_on_lock() and
-- made atomic by assert_parent_pack_unlocked(); if either is weakened, this function is
-- where the damage surfaces.
create or replace function public.snapshot_pack_items_on_gear_delete()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  update public.pack_items
     set snapshot = private.gear_item_snapshot(old)
   where gear_item_id = old.id
     and snapshot is null;
  return old;
end;
$$;

comment on function public.snapshot_pack_items_on_gear_delete() is
  'BEFORE DELETE on gear_items: freezes the gear into every referencing pack item that is not already frozen, so deleting gear never destroys pack history.';

create trigger gear_items_snapshot_before_delete
  before delete on public.gear_items
  for each row execute function public.snapshot_pack_items_on_gear_delete();

-- ---------------------------------------------------------------------------
-- Rule 2: locking a pack copies current values into snapshot
-- ---------------------------------------------------------------------------
--
-- Setting `locked_at` IS the lock. Doing the freeze in a trigger rather than leaving
-- it to whichever caller sets the column is what makes rule 2 a property of the model
-- instead of a convention, and it is also what keeps rule 3 workable — the two
-- interact, in a way that is easy to miss and produces a locked pack that cannot be
-- maintained:
--
--   If locking only stamped a timestamp, a locked pack's items would still have a null
--   snapshot. Deleting a referenced gear item would then fire the BEFORE DELETE
--   trigger above, whose UPDATE is refused by the write policies precisely BECAUSE the
--   pack is locked — so the delete fails, and Ref 7's acceptance criterion ("deleting
--   a gear item leaves locked packs intact") cannot be met at all.
--
--   With the freeze here, a locked pack's items always carry a snapshot, the delete
--   trigger's `where snapshot is null` matches none of them, and the two rules stop
--   competing for the same rows.
--
-- BEFORE UPDATE, and that is load-bearing rather than stylistic. A BEFORE ROW trigger
-- runs before the new version of the row is visible, so the write policies on
-- pack_items — which ask whether the parent pack's locked_at is null — still see the
-- pack as unlocked and permit the freeze.
--
-- Moving this to AFTER UPDATE does not error. That is the problem: the policy would see
-- the lock this very statement is setting, filter the freeze's UPDATE to zero rows, and
-- the pack would be marked frozen while every item still tracked live edits. A silent
-- no-op, not a failure. Three tests in core-schema.test.ts go red if it is moved.
--
-- The snapshot is overwritten, not filled in where missing. A pack that is unlocked,
-- edited and locked again must freeze what it holds now; `coalesce` here would pin it
-- to the first time it was ever locked.
create or replace function public.freeze_pack_items_on_lock()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.locked_at is not null and old.locked_at is null then
    update public.pack_items i
       set snapshot = private.gear_item_snapshot(g)
      from public.pack_categories c, public.gear_items g
     where c.pack_id = new.id
       and i.pack_category_id = c.id
       and i.gear_item_id = g.id;

  -- Unlocking clears them again, and this branch is not symmetry for its own sake —
  -- without it, `snapshot is not null` stops meaning "frozen" and rule 3 quietly
  -- records the wrong values. The sequence that breaks it is entirely ordinary:
  --
  --   lock a pack        -> snapshot = the gear as it was at lock time
  --   unlock it          -> snapshot survives, but the pack is live again
  --   edit the gear      -> snapshot is now stale
  --   delete the gear    -> the BEFORE DELETE trigger's `where snapshot is null`
  --                         matches nothing, so the item keeps the LOCK-TIME values
  --
  -- and `gear_item_id` is nulled by the foreign key regardless, so the values the user
  -- actually had when they deleted the gear are gone. That is silent data loss wearing
  -- the costume of history preservation.
  --
  -- The `gear_item_id is not null` guard is load-bearing: an item whose gear was
  -- deleted while the pack was locked has nothing but its snapshot, and clearing that
  -- would both violate pack_items_reference_or_snapshot and destroy exactly the history
  -- rule 3 exists to protect.
  elsif new.locked_at is null and old.locked_at is not null then
    update public.pack_items i
       set snapshot = null
      from public.pack_categories c
     where c.pack_id = new.id
       and i.pack_category_id = c.id
       and i.gear_item_id is not null;
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Rule 2, part two: making the freeze atomic
-- ---------------------------------------------------------------------------
--
-- "A locked pack's items always carry a snapshot" is the invariant rule 3 leans on,
-- and the freeze above does NOT establish it on its own. Two concurrent transactions
-- under READ COMMITTED are enough to break it, because the insert policy's
-- `locked_at is null` test and the freeze's UPDATE are two independent reads of the
-- same pack with nothing making them contend:
--
--   A: begin; insert a pack_item into an unlocked pack     -- policy sees unlocked: ok
--   B:        update packs set locked_at = now(); commit   -- freeze cannot see A's
--                                                          -- uncommitted row
--   A: commit
--
-- The result is a locked pack holding an item with a null snapshot, and the damage is
-- not theoretical: deleting that gear item afterwards fires the BEFORE DELETE trigger,
-- whose UPDATE is filtered to zero rows by the write policies (the pack is locked), the
-- foreign key nulls `gear_item_id` anyway because FK actions are not subject to RLS,
-- and the check constraint aborts the delete. The gear becomes undeletable, and the
-- user sees a raw constraint name, until someone thinks to unlock a pack they locked
-- for posterity.
--
-- The fix is to make both paths contend on the same row lock. `for update` on the
-- parent pack means an in-flight insert blocks a lock, and an in-flight lock blocks an
-- insert — and under READ COMMITTED the blocked statement re-reads the row when it
-- wakes, so the second one through sees the lock and raises.
--
-- Deliberately INSERT and UPDATE only, not DELETE. A cascade from `delete from packs`
-- fires row triggers on the children, and refusing those would make a locked pack
-- undeletable by its own owner — trading one trap for another. Removing a row from a
-- frozen pack concurrently with the freeze remains possible; it loses an item rather
-- than corrupting one, and the policies still refuse it in the non-concurrent case.
create or replace function public.assert_parent_pack_unlocked()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  target_pack uuid;
  pack_locked_at timestamptz;
begin
  -- This guards CLIENT writes. A nested write is one of this schema's own freeze
  -- triggers doing its job, and it must be let through: unlocking clears snapshots by
  -- updating pack_items from a BEFORE UPDATE trigger on packs, at which point the
  -- pack's row still reads as locked and this assertion would refuse the very write
  -- that unlocks it. Depth 1 is a statement issued directly against these tables.
  if pg_trigger_depth() > 1 then
    return new;
  end if;

  -- IF, not a CASE expression. plpgsql resolves the field references in every branch of
  -- a CASE when it evaluates it, so `new.pack_category_id` is looked up even on a
  -- pack_categories row that has no such field, and the trigger dies with
  -- `record "new" has no field "pack_category_id"` on the table it was meant to allow.
  if tg_table_name = 'pack_categories' then
    target_pack := new.pack_id;
  else
    select c.pack_id into target_pack
      from public.pack_categories c
     where c.id = new.pack_category_id;
  end if;

  -- `for update` and not a plain read: taking the write lock is the entire point.
  select p.locked_at into pack_locked_at
    from public.packs p
   where p.id = target_pack
     for update;

  if pack_locked_at is not null then
    raise exception 'pack % is locked; unlock it before changing its contents', target_pack
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function public.assert_parent_pack_unlocked() is
  'BEFORE INSERT/UPDATE on a pack''s children: takes the parent pack''s row lock and refuses the write if it is locked. The policies express the same rule; this is what makes it hold against a concurrent lock.';

create trigger pack_categories_assert_unlocked
  before insert or update on public.pack_categories
  for each row execute function public.assert_parent_pack_unlocked();

create trigger pack_items_assert_unlocked
  before insert or update on public.pack_items
  for each row execute function public.assert_parent_pack_unlocked();

comment on function public.freeze_pack_items_on_lock() is
  'BEFORE UPDATE on packs: when locked_at goes from null to set, copies every referenced gear item into its pack item''s snapshot. Must stay BEFORE — see the migration that defines it.';

create trigger packs_freeze_items_before_lock
  before update on public.packs
  for each row execute function public.freeze_pack_items_on_lock();

-- ---------------------------------------------------------------------------
-- created_at / updated_at
-- ---------------------------------------------------------------------------
-- public.set_updated_at() comes from the baseline migration, where the reasoning for
-- it being a trigger rather than a default lives: `updated_at` is what optimistic
-- concurrency (Ref 20) will compare against, so a client that can choose the value can
-- make its own stale write look fresh.
--
-- That argument applies just as much to INSERT, and a DEFAULT does not carry it: a
-- default only supplies a value the client omitted, and these columns are granted to
-- `authenticated` like any other. `insert ... (created_at, updated_at) values
-- ('1999-01-01', '1999-01-01')` is accepted by a table that has set_updated_at on
-- UPDATE alone — the column is unforgeable from the second write onwards and forgeable
-- on the first, which is the least useful place for the guarantee to start.
create or replace function public.set_row_timestamps()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.created_at = now();
  new.updated_at = now();
  return new;
end;
$$;

comment on function public.set_row_timestamps() is
  'BEFORE INSERT trigger: stamps created_at and updated_at server-side. Pairs with set_updated_at() so neither column is ever client-supplied.';

create trigger gear_items_set_row_timestamps
  before insert on public.gear_items
  for each row execute function public.set_row_timestamps();

create trigger packs_set_row_timestamps
  before insert on public.packs
  for each row execute function public.set_row_timestamps();

create trigger pack_categories_set_row_timestamps
  before insert on public.pack_categories
  for each row execute function public.set_row_timestamps();

create trigger pack_items_set_row_timestamps
  before insert on public.pack_items
  for each row execute function public.set_row_timestamps();

create trigger gear_items_set_updated_at
  before update on public.gear_items
  for each row execute function public.set_updated_at();

create trigger packs_set_updated_at
  before update on public.packs
  for each row execute function public.set_updated_at();

create trigger pack_categories_set_updated_at
  before update on public.pack_categories
  for each row execute function public.set_updated_at();

create trigger pack_items_set_updated_at
  before update on public.pack_items
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
--
-- The unique constraints above already provide indexes on packs(slug) — which is what
-- makes the public lookup a single indexed query — and on (user_id, id) for
-- gear_items, packs and pack_categories. A btree on (user_id, id) has user_id leading,
-- so it already answers every `where user_id = $1` owner-scoped list on those three;
-- adding a separate (user_id) index there would be pure write amplification on the two
-- hottest tables, and was in an earlier draft of this migration.
--
-- pack_items is the exception, and the one that actually needs the index: it is a leaf
-- that nothing references, so it has no (user_id, id) unique constraint and therefore
-- no index with user_id leading — while pack_items_select_own filters on exactly that.
create index pack_items_user_id_idx on public.pack_items (user_id);

-- The ordered reads. Composite and in read order, so the pack tree comes back sorted
-- from the index rather than through a sort node.
create index pack_categories_pack_id_position_idx
  on public.pack_categories (pack_id, position, id);
create index pack_items_pack_category_id_position_idx
  on public.pack_items (pack_category_id, position, id);

-- Used twice over: by the BEFORE DELETE trigger to find rows to freeze, and by the
-- anon read policy on gear_items to decide whether a gear row is on a public pack.
create index pack_items_gear_item_id_idx
  on public.pack_items (gear_item_id) where gear_item_id is not null;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
--
-- Enabled on all four tables, in the migration that creates them.

alter table public.gear_items enable row level security;
alter table public.packs enable row level security;
alter table public.pack_categories enable row level security;
alter table public.pack_items enable row level security;

-- Every policy below wraps auth.uid() as `(select auth.uid())`. That is not style: it
-- makes the call an InitPlan evaluated once per statement instead of once per row,
-- which is the difference between a pack list that scales and one that does not.

-- --- packs ------------------------------------------------------------------

-- The whole point of Ref 49, in one policy. A private pack is not "hidden" from the
-- anon key, it is absent: the query returns zero rows, whether it asks by id or by
-- slug, and no bug in a share page can turn that into the wrong rows.
create policy packs_select_public on public.packs
  for select to anon, authenticated
  using (visibility = 'public');

create policy packs_select_own on public.packs
  for select to authenticated
  using (user_id = (select auth.uid()));

-- `locked_at is null` on INSERT, because the freeze is a BEFORE UPDATE trigger and
-- therefore never fires for a row that arrives already locked. Without this clause a
-- client can create a pack with locked_at set, which the freeze never sees; the pack is
-- then permanently uneditable, since every write policy on its children refuses a
-- locked parent. Locking is a transition, and this is what makes it one.
create policy packs_insert_own on public.packs
  for insert to authenticated
  with check (user_id = (select auth.uid()) and locked_at is null);

-- USING and WITH CHECK both. USING alone would allow an owner to update a row into
-- another user's name; the row would vanish from under them, which is the polite
-- version of a write they should never have been allowed to make.
create policy packs_update_own on public.packs
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy packs_delete_own on public.packs
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- --- pack_categories --------------------------------------------------------

create policy pack_categories_select_public on public.pack_categories
  for select to anon, authenticated
  using (
    exists (
      select 1 from public.packs p
      where p.id = pack_categories.pack_id and p.visibility = 'public'
    )
  );

create policy pack_categories_select_own on public.pack_categories
  for select to authenticated
  using (user_id = (select auth.uid()));

-- Rule 2, enforced rather than remembered: the contents of a locked pack cannot be
-- written, by anyone, through the Data API. The lock lives on the parent, so every
-- write policy on a child table asks the parent.
create policy pack_categories_insert_own on public.pack_categories
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.packs p
      where p.id = pack_categories.pack_id and p.locked_at is null
    )
  );

create policy pack_categories_update_own on public.pack_categories
  for update to authenticated
  using (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.packs p
      where p.id = pack_categories.pack_id and p.locked_at is null
    )
  )
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.packs p
      where p.id = pack_categories.pack_id and p.locked_at is null
    )
  );

create policy pack_categories_delete_own on public.pack_categories
  for delete to authenticated
  using (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.packs p
      where p.id = pack_categories.pack_id and p.locked_at is null
    )
  );

-- --- pack_items -------------------------------------------------------------

create policy pack_items_select_public on public.pack_items
  for select to anon, authenticated
  using (
    exists (
      select 1
      from public.pack_categories c
      join public.packs p on p.id = c.pack_id
      where c.id = pack_items.pack_category_id and p.visibility = 'public'
    )
  );

create policy pack_items_select_own on public.pack_items
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy pack_items_insert_own on public.pack_items
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1
      from public.pack_categories c
      join public.packs p on p.id = c.pack_id
      where c.id = pack_items.pack_category_id and p.locked_at is null
    )
  );

create policy pack_items_update_own on public.pack_items
  for update to authenticated
  using (
    user_id = (select auth.uid())
    and exists (
      select 1
      from public.pack_categories c
      join public.packs p on p.id = c.pack_id
      where c.id = pack_items.pack_category_id and p.locked_at is null
    )
  )
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1
      from public.pack_categories c
      join public.packs p on p.id = c.pack_id
      where c.id = pack_items.pack_category_id and p.locked_at is null
    )
  );

create policy pack_items_delete_own on public.pack_items
  for delete to authenticated
  using (
    user_id = (select auth.uid())
    and exists (
      select 1
      from public.pack_categories c
      join public.packs p on p.id = c.pack_id
      where c.id = pack_items.pack_category_id and p.locked_at is null
    )
  );

-- --- gear_items -------------------------------------------------------------

create policy gear_items_select_own on public.gear_items
  for select to authenticated
  using (user_id = (select auth.uid()));

-- The share page needs the master record behind each pack item — an unlocked public
-- pack has no snapshots to render from, so without this the page shows quantities and
-- no names.
--
-- Narrow on purpose: reachable only through a pack item on a PUBLIC pack. Publishing
-- a pack publishes exactly the gear on it and nothing else in the closet. The
-- composite foreign key on pack_items is what stops this being a way in — a pack item
-- can only ever point at its own owner's gear, so no one can publish a pack that
-- references someone else's private row.
create policy gear_items_select_via_public_pack on public.gear_items
  for select to anon, authenticated
  using (
    exists (
      select 1
      from public.pack_items i
      join public.pack_categories c on c.id = i.pack_category_id
      join public.packs p on p.id = c.pack_id
      where i.gear_item_id = gear_items.id and p.visibility = 'public'
    )
  );

create policy gear_items_insert_own on public.gear_items
  for insert to authenticated
  with check (user_id = (select auth.uid()));

create policy gear_items_update_own on public.gear_items
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy gear_items_delete_own on public.gear_items
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- Grants — the other layer, and the one RLS cannot cover
-- ---------------------------------------------------------------------------
--
-- REVOKE ALL first. This is not defensive boilerplate; it closes a hole that is live
-- on a default Supabase project and was reproduced on this schema before the revoke
-- was written.
--
-- With `auto_expose_new_tables` unset, a table created by `postgres` in `public` is
-- not granted SELECT/INSERT/UPDATE/DELETE to anon — that much works as advertised.
-- But the default ACL for tables owned by `postgres` still carries `Dxtm` for anon,
-- authenticated and service_role:
--
--     postgres|r|{postgres=arwdDxtm/postgres, anon=Dxtm/postgres, ...}
--
-- which is TRUNCATE, REFERENCES, TRIGGER and MAINTAIN. TRUNCATE is the one that
-- matters, because **row level security does not apply to TRUNCATE**. Policies filter
-- SELECT, INSERT, UPDATE and DELETE; they have nothing to say about a statement that
-- removes every row at once. Against this schema, before this block existed:
--
--     set role anon; truncate public.packs cascade;   -->   TRUNCATE TABLE
--
-- The `anon` key is shipped to every browser. A boundary that stops a stranger reading
-- a private pack but lets them empty the table is not a boundary. PostgREST does not
-- expose TRUNCATE today, which is why this has not bitten anyone — but "the API layer
-- happens not to offer it" is exactly the kind of guarantee this ticket exists to
-- replace with one the database makes.
--
-- MAINTAIN (Postgres 17) is a smaller version of the same problem: VACUUM FULL,
-- CLUSTER and REINDEX from an anonymous role are a denial-of-service surface with no
-- legitimate use. TRIGGER and REFERENCES let an untrusted role attach itself to these
-- tables' write paths. None of the four is wanted by anyone.
--
-- Everything is then granted back by name. tests/rls-enabled.test.ts asserts this
-- shape for EVERY table in `public`, not just these four, so a future migration that
-- creates a table and forgets this block fails the build rather than shipping.

revoke all on public.gear_items from anon, authenticated, service_role;
revoke all on public.packs from anon, authenticated, service_role;
revoke all on public.pack_categories from anon, authenticated, service_role;
revoke all on public.pack_items from anon, authenticated, service_role;

-- `anon` gets SELECT and nothing else. There is no anonymous write in this product,
-- and the absence is expressed as a missing privilege rather than as the absence of a
-- policy: a policy someone adds later cannot accidentally grant what was never
-- granted, whereas a permissive policy on a writable table is one review away.
--
-- KNOWN GAP, recorded here rather than discovered later: publishing a pack publishes
-- the WHOLE gear row, including `notes` and `url` — in practice a private aside and,
-- often, an order-confirmation link — and every table's `user_id`, which is the owner's
-- JWT `sub` and therefore lets a stranger group public packs by author.
--
-- Column-level grants are the obvious fix and do not work here. PostgREST requires
-- table-level SELECT on every table participating in an embed, so
-- `grant select (id, name, ...)` makes the share page's whole query fail:
--
--     GET /packs?select=id,pack_categories(id)   ->   42501 permission denied for table packs
--
-- which is Ref 7's "40 items in one round trip" criterion, not a nice-to-have. Measured
-- both ways: a flat `?select=id` works under column grants, any embed does not.
--
-- The two mechanisms that DO work are both product decisions rather than schema
-- tidying, and belong with the share page (Ref 26) or the gear closet (Ref 4):
--
--   1. A `security_invoker` view exposing only the public columns, with anon granted
--      the view and nothing on the base table. Costs a PostgREST relationship hint so
--      the embed still resolves.
--   2. Moving `notes` and `url` to a 1:1 owner-only table, which makes the boundary
--      structural and needs no grant subtlety at all.
--
-- Neither is blocked by anything here, and no share page exists yet to leak through.
-- What is NOT deferred is the frozen copy: gear_item_snapshot() does not capture these
-- fields, so locking a pack does not additionally bake them into a column anon reads.
grant select on public.gear_items to anon;
grant select on public.packs to anon;
grant select on public.pack_categories to anon;
grant select on public.pack_items to anon;

grant select, insert, update, delete on public.gear_items to authenticated;
grant select, insert, update, delete on public.packs to authenticated;
grant select, insert, update, delete on public.pack_categories to authenticated;
grant select, insert, update, delete on public.pack_items to authenticated;

-- service_role bypasses RLS by role attribute, but privileges are a separate system
-- and it holds none on these tables once the revoke above has run. Granted the same
-- four verbs rather than ALL: nothing in this product has a use for TRUNCATE or
-- MAINTAIN, and the key that carries this role is the one Ref 55 exists to keep off
-- the anonymous read path. Leaving it able to read and write, and unable to drop
-- everything, is the honest scope.
grant select, insert, update, delete on public.gear_items to service_role;
grant select, insert, update, delete on public.packs to service_role;
grant select, insert, update, delete on public.pack_categories to service_role;
grant select, insert, update, delete on public.pack_items to service_role;

-- ---------------------------------------------------------------------------
-- Functions
-- ---------------------------------------------------------------------------
--
-- Tables are not the whole privilege surface, and the block above would have been an
-- incomplete claim without this one. A function is created with EXECUTE granted to
-- PUBLIC by default, and `public` is an exposed PostgREST schema, so a function defined
-- there is an anonymous RPC endpoint from the moment it exists.
--
-- The helper that had that shape now lives in `private` (see the schema comment where
-- it is defined). What remains in `public` is trigger functions — `returns trigger`, so
-- PostgREST will not route to them — plus whatever a later migration adds. This revoke
-- is for the latter: it makes "reachable over RPC" an explicit grant rather than the
-- default, so a SECURITY DEFINER helper written in `public` out of habit is inert
-- instead of live.
--
-- Trigger functions keep working. Postgres checks EXECUTE on a trigger function when
-- the trigger is CREATED, not each time it fires, so revoking here does not stop any
-- trigger above — verified by deleting a gear item as `authenticated` after the revoke.
revoke execute on all functions in schema public from anon, authenticated, service_role;

-- PUBLIC too, and not as belt-and-braces: the three roles above hold EXECUTE *through*
-- the default PUBLIC grant rather than directly, so revoking from them alone changes
-- nothing at all while looking decisive.
revoke execute on all functions in schema public from public;
