-- Pack list composition (PK-37): three RPCs, and no new schema.
--
-- Nothing here adds a table, a column, a policy or an index. `20260810120000_core_schema.sql`
-- already carries the whole model — `packs` / `pack_categories` / `pack_items`, their
-- composite foreign keys, their row level security policies, the triggers that run
-- `set_row_timestamps()` and `assert_parent_pack_unlocked()` (those are the FUNCTION names;
-- the triggers themselves are per-table and named for their table — `pack_items_
-- set_row_timestamps`, `pack_items_assert_unlocked`, and the `pack_categories_*` pair) —
-- and this migration adds only the three
-- operations that need MORE THAN ONE STATEMENT to be correct, which is the only thing the
-- ordinary Data API cannot express:
--
--   public.move_pack_item      re-parent one item and apply the recomputed positions for
--                              the run(s) the move touched, atomically.
--   public.move_pack_category  apply the recomputed positions for a pack's categories.
--   public.duplicate_pack      copy a pack, its categories and its items, returning the
--                              new pack's id.
--
-- A PostgREST request is one transaction, so "one RPC" is what makes "one transaction"
-- true for the caller. Two PATCHes from a browser are two transactions with a window
-- between them, and the window is where a reindex gets half-applied.
--
-- ---------------------------------------------------------------------------
-- THE NON-OBVIOUS THING ABOUT THIS FILE: IT DOES NO POSITION ARITHMETIC
-- ---------------------------------------------------------------------------
--
-- Read this before adding anything below. Not one statement in this migration computes an
-- index, an offset, a `row_number()`, a `+ 1` or a "shift everything after". The functions
-- APPLY a set of `(id, position)` pairs that arrived already computed; they never decide
-- what a position should be.
--
-- That is a constraint, not an accident, and the reason is `src/lib/packs/reorder.ts`. That
-- module is the single place in the product that answers "what happens when you drop an
-- item here", and it is single deliberately: the Vue island calls it to render the move
-- optimistically the instant the pointer is released, and the server endpoint calls the
-- SAME functions against rows it has just read for itself. Its header says so at length,
-- under "BOTH SIDES CALL THIS, ONLY ONE SIDE IS BELIEVED". A `row_number() over (order by
-- ...)` in here would be a THIRD implementation of those rules, in a third language, with
-- its own opinion about how ties break — and the way that drift surfaces is that the screen
-- shows one order and a reload shows another, which is precisely the bug the module was
-- extracted to prevent.
--
-- So if a future change to one of these functions starts computing an index in SQL, the
-- change is in the wrong file. The arithmetic belongs in reorder.ts, whose result these
-- functions then apply unchanged.
--
-- What this file IS responsible for, and reorder.ts is not, is everything that needs the
-- database: the transaction, the row lock that serialises two concurrent reorders, and the
-- authorisation checks that confirm every id in the payload belongs to the caller and to
-- one pack.
--
-- ---------------------------------------------------------------------------
-- THE PAYLOAD SHAPE, AND WHY IT IS THIS ONE
-- ---------------------------------------------------------------------------
--
-- `planItemMove` / `planCategoryMove` return
--
--     { runs: [ { parentId, updates: [ { id, position }, ... ] }, ... ], reparent }
--
-- and `p_runs jsonb` below is `plan.runs` VERBATIM — same key names, same nesting, no
-- reshaping on the wire. The endpoint hands over what the planner produced and nothing
-- else, so there is no transform between the two that could be written wrong. It is
-- consumed with `jsonb_to_recordset`, which is what turns a run's `updates` array into the
-- relation an `update ... from` needs; reorder.ts's own header anticipates exactly that
-- shape, which is the other half of why it is left alone.
--
-- NOTE THAT THE RUNS ARE FLATTENED AT THE POINT OF THE WRITE. There is not one `update`
-- per run: `jsonb_array_elements(p_runs) cross join lateral jsonb_to_recordset(r.value ->
-- 'updates')` yields every pair of every run as one relation, and a single `update ...
-- where i.id = u.id` applies the lot. That is point 1 below, taken seriously — the grouping
-- is consumed by the authorisation checks ABOVE the write and must not reach the write's
-- `where`, because there the run boundary would skip the one row whose parent has just
-- changed.
--
-- `reparent` is DELIBERATELY NOT PASSED AS JSON. It arrives as two ordinary arguments —
-- `p_item_id` and `p_to_category_id` — and they are required rather than optional. That is
-- the one place this signature departs from the plan's shape, and it closes a trap
-- reorder.ts's header describes and cannot itself prevent:
--
--     "`reparent` ... is present on every cross-category move EVEN WHEN both runs' update
--      lists come back empty — which happens more often than it sounds: drag the only item
--      of one category into an empty one and the row's position is 0 before and 0 after ...
--      A caller that treats an empty `runs` as "nothing to do" loses that move."
--
-- With the destination as a required argument, "where the item ends up" cannot be dropped
-- on the way to the database, because there is no call that omits it. A same-category move
-- passes the category the item is already in, and the re-parent degrades to a no-op that is
-- filtered out below rather than becoming a second, differently-shaped API.
--
-- `p_pack_id` is required for the same reason it is not inferred: it is the row that gets
-- locked, and the scope every id in the payload is then checked against. Inferring it from
-- the first id in the payload would make the authorisation check circular — it would prove
-- the ids agree with each other, which is what a scrambling bug also does.
--
-- ---------------------------------------------------------------------------
-- FOUR THINGS THESE FUNCTIONS DO THAT ARE EASY TO GET WRONG
-- ---------------------------------------------------------------------------
--
-- 1. THE UPDATES ARE MATCHED ON `id` ALONE, NEVER ON `(parent, id)`. This is the mistake
--    reorder.ts warns about in capitals, and it is silent rather than loud: on a
--    cross-category move the moved row appears in the DESTINATION run's updates while it
--    still carries its OLD `pack_category_id` in the database, so
--    `where pack_category_id = <run's parentId> and id = u.id` skips exactly one row — the
--    row that moved — and the write half-lands with the source run renumbered and the
--    destination run not. `parentId` is therefore read here as an AUTHORISATION input (it
--    must name a category of this pack) and never as a predicate.
--
-- 2. THE PARENT PACK IS ROW-LOCKED BEFORE ANYTHING IS READ OR WRITTEN. `select ... for
--    update` on `public.packs` is what makes two concurrent reorders serialise instead of
--    interleaving: the second one waits, then re-reads under READ COMMITTED and applies its
--    pairs on top of a settled arrangement rather than into the middle of one. The
--    acceptance criterion is that the result is a VALID, COMPLETE ordering — every item
--    present exactly once, positions non-negative, nothing orphaned into the wrong category
--    — and not that both moves survive. Last writer wins on the arrangement. TELLING the
--    user their drag was overwritten is PK-20's job (optimistic concurrency over
--    `updated_at`), not this file's, and inventing a conflict error here would pre-empt that
--    decision with a worse version of it.
--
--    `assert_parent_pack_unlocked()` takes the same lock from its own trigger, so a reorder
--    and a `lock this pack` contend too — see core_schema.sql's "Rule 2, part two" for why
--    that trigger exists.
--
--    AN EARLIER VERSION OF THIS PARAGRAPH WENT ON TO CLAIM THAT THESE FUNCTIONS THEREFORE
--    NEED NO `locked_at` CHECK OF THEIR OWN, BECAUSE "THE TRIGGER RAISES `pack % is locked`
--    ON THE FIRST ROW THEY TOUCH". THAT WAS FALSE, and the way it was false is the reason
--    the two reorder functions are redefined at the END of this file. The trigger is a
--    BEFORE ROW trigger, so it only ever fires on a row the statement actually reached —
--    and on a locked pack the statement reaches none. `pack_items_update_own` and
--    `pack_categories_update_own` (core_schema.sql:840 and :784) carry their
--    `p.locked_at is null` clause in `USING`, which FILTERS: the rows are not refused, they
--    are not seen. So an UPDATE against a locked pack affects zero rows, raises nothing, and
--    the trigger never runs. Measured on this stack, not reasoned about: a re-parent UPDATE
--    on a locked pack returns `row_count = 0` with no exception.
--
--    That left `move_pack_item` able to report success having written nothing — see the
--    section at the end of this file, which is where the check the paragraph above wrongly
--    said was unnecessary now lives, and which explains why it is a diagnosis at the point
--    of refusal rather than a second copy of the rule at the top.
--
-- 3. EVERY ID IN THE PAYLOAD IS PROVED TO BELONG TO THE CALLER AND TO THIS PACK. Row level
--    security already confines every write below to the caller's own rows, so this is not
--    what stops a stranger — the policies are. What it stops is a BUG: ids from two
--    different packs OF THE SAME USER, which RLS permits and which would renumber both
--    packs against a plan computed for one. There is no honest partial handling of that, so
--    it is refused whole.
--
-- 4. THE AFFECTED ROW COUNT IS COMPARED AGAINST THE NUMBER OF PAIRS SENT. reorder.ts
--    already refuses a duplicated id (`assertDistinctIds`) and already omits rows that are
--    on the position they would be given (`denseUpdates`), so a correct plan has one pair
--    per row and every pair changes something. Anything else — a duplicated id that would
--    give one row two positions, an update RLS declined without erroring — shows up as a
--    count that does not match, and is raised rather than committed half-done.
--
-- ---------------------------------------------------------------------------
-- SECURITY INVOKER, ALL THREE
-- ---------------------------------------------------------------------------
--
-- Every statement in every function below runs under the CALLER's policies. None of these
-- operations needs to see a row its caller cannot, so none of them has a reason to step
-- over row level security, and a DEFINER function that did would move the whole
-- authorisation question from policies the database enforces into `if` statements a
-- reviewer has to re-derive. `public.delete_own_account()` is the project's only DEFINER
-- function and only because no policy can grant access to `auth.users` — see
-- `20260817000000_user_profiles.sql`.
--
-- `set search_path = ''` with fully-qualified names throughout, for the reason the baseline
-- gives on `set_updated_at()`: a mutable search_path hands name resolution to whoever calls
-- the function.

-- ---------------------------------------------------------------------------
-- move_pack_item
-- ---------------------------------------------------------------------------

create or replace function public.move_pack_item(
  p_pack_id uuid,
  p_item_id uuid,
  p_to_category_id uuid,
  p_runs jsonb
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  -- bigint, matching `get diagnostics ... = row_count`, so the comparison below is between
  -- two values of one type rather than between a count and a coerced integer.
  v_pairs bigint;
  v_updated bigint;
begin
  -- Point 2 above. First statement in the function, before anything is read, so the whole
  -- verify-then-apply sequence sits inside one lock rather than validating against a
  -- snapshot another session is about to move.
  --
  -- `for update` on `packs` is also an authorisation check and not only a lock: the row is
  -- visible for locking only if the caller passes `packs_update_own`, so a pack that is
  -- someone else's — including a PUBLIC pack of someone else's, which `packs_select_public`
  -- would happily return for a plain read — is simply not found here.
  perform 1
     from public.packs p
    where p.id = p_pack_id
      and p.user_id = auth.uid()
    for update;

  if not found then
    raise exception 'pack % is not yours to reorder', p_pack_id
      using errcode = 'insufficient_privilege';
  end if;

  -- The shape of the payload, checked before it is walked. `jsonb_array_elements` on a
  -- scalar raises `cannot extract elements from a scalar`, which names neither this
  -- function nor the argument that was wrong.
  if p_runs is null or pg_catalog.jsonb_typeof(p_runs) <> 'array' then
    raise exception 'p_runs must be the `runs` array from a reorder plan, got %',
      coalesce(pg_catalog.jsonb_typeof(p_runs), 'null')
      using errcode = 'invalid_parameter_value';
  end if;

  if exists (
    select 1
      from pg_catalog.jsonb_array_elements(p_runs) as r
     where (r.value ->> 'parentId') is null
        or pg_catalog.jsonb_typeof(r.value -> 'updates') is distinct from 'array'
  ) then
    raise exception 'every run in p_runs needs a parentId and an updates array'
      using errcode = 'invalid_parameter_value';
  end if;

  -- The destination. Required, always applied, never inferred — see "reparent IS
  -- DELIBERATELY NOT PASSED AS JSON" in the header. A category whose `pack_id` is this pack
  -- is necessarily the caller's own, because the pack itself was just proved to be.
  if not exists (
    select 1
      from public.pack_categories c
     where c.id = p_to_category_id
       and c.pack_id = p_pack_id
  ) then
    raise exception 'category % is not in pack %', p_to_category_id, p_pack_id
      using errcode = 'insufficient_privilege';
  end if;

  -- The item being moved, proved to be in this pack BEFORE its parent is rewritten.
  -- Without this, `update ... where id = p_item_id` under RLS would touch nothing for a
  -- stranger's id and the function would report success having moved nothing.
  if not exists (
    select 1
      from public.pack_items i
      join public.pack_categories c on c.id = i.pack_category_id
     where i.id = p_item_id
       and c.pack_id = p_pack_id
  ) then
    raise exception 'item % is not in pack %', p_item_id, p_pack_id
      using errcode = 'insufficient_privilege';
  end if;

  -- Point 3, the first half: the runs name categories of THIS pack. `parentId` is not used
  -- to find rows — point 1 — but it is the caller's own statement about which run each set
  -- of numbers belongs to, and a plan whose runs point at another pack was computed against
  -- the wrong siblings whatever its ids say.
  if exists (
    select 1
      from pg_catalog.jsonb_array_elements(p_runs) as r
     where not exists (
       select 1
         from public.pack_categories c
        where c.id = (r.value ->> 'parentId')::uuid
          and c.pack_id = p_pack_id
     )
  ) then
    raise exception 'a run in p_runs names a category that is not in pack %', p_pack_id
      using errcode = 'insufficient_privilege';
  end if;

  -- Point 3, the second half: every id being renumbered is an item of this pack. An id the
  -- caller does not own fails this too — RLS makes it invisible, so the `not exists` holds.
  if exists (
    select 1
      from pg_catalog.jsonb_array_elements(p_runs) as r
      cross join lateral pg_catalog.jsonb_to_recordset(r.value -> 'updates')
        as u(id uuid, position integer)
     where not exists (
       select 1
         from public.pack_items i
         join public.pack_categories c on c.id = i.pack_category_id
        where i.id = u.id
          and c.pack_id = p_pack_id
     )
  ) then
    raise exception 'p_runs renumbers an item that is not in pack %', p_pack_id
      using errcode = 'insufficient_privilege';
  end if;

  select count(*)
    into v_pairs
    from pg_catalog.jsonb_array_elements(p_runs) as r
    cross join lateral pg_catalog.jsonb_to_recordset(r.value -> 'updates')
      as u(id uuid, position integer);

  -- The re-parent runs FIRST, so that by the time the positions land, every row named by
  -- the destination run is actually in the destination. The two orders are equivalent for
  -- the data — the position update matches on `id` alone and does not care where a row
  -- lives — but this one leaves no intermediate state in which a category's rows and its
  -- numbering disagree, which is the state anything reading these tables from a trigger
  -- would see.
  --
  -- `is distinct from` because a same-category move passes the category the item is already
  -- in: without the guard this would rewrite the row for nothing and stamp `updated_at`,
  -- which is the column PK-20's optimistic concurrency compares against. A no-op write that
  -- moves that timestamp is a conflict reported to a user who caused none.
  update public.pack_items
     set pack_category_id = p_to_category_id
   where id = p_item_id
     and pack_category_id is distinct from p_to_category_id;

  -- One statement for both runs. Point 1 in full: matched on `i.id = u.id` and on nothing
  -- else. `r` and `u` are flattened here rather than applied run by run precisely because
  -- the run boundary must not become a predicate; it did its job in the checks above.
  update public.pack_items i
     set position = u.position
    from pg_catalog.jsonb_array_elements(p_runs) as r
    cross join lateral pg_catalog.jsonb_to_recordset(r.value -> 'updates')
      as u(id uuid, position integer)
   where i.id = u.id;

  get diagnostics v_updated = row_count;

  -- Point 4. The two ways this can differ are both corruption if committed: a duplicated id
  -- (two pairs, one row updated, and which of the two positions won depends on the plan the
  -- executor chose), or a row RLS declined to update without erroring. `position >= 0` is
  -- left to the column's own CHECK — core_schema.sql:228 argues that negatives are "just a
  -- reindex that went wrong", and a constraint that aborts the transaction says so better
  -- than a re-implementation here would.
  if v_updated <> v_pairs then
    raise exception
      'reorder applied % of % positions in pack % — refusing to commit a partial reindex',
      v_updated, v_pairs, p_pack_id
      using errcode = 'data_exception';
  end if;
end;
$$;

comment on function public.move_pack_item(uuid, uuid, uuid, jsonb) is
  'Re-parents one pack item to p_to_category_id and applies the positions in p_runs — `plan.runs` from planItemMove() in src/lib/packs/reorder.ts, verbatim — in one transaction under the caller''s own policies. Computes no positions itself: see the header of the migration that defines it.';

-- PK-57, and the reason `tests/migration-hygiene.test.ts` parses this file as text. A
-- function created in `public` is EXECUTE-able by the `PUBLIC` pseudo-role from the moment
-- it exists, and `public` is a PostgREST-exposed schema — so without the next two lines
-- this is an anonymous RPC endpoint. `from public` alone is NOT enough: on a hosted
-- Supabase project of this project's vintage the function is ALSO born with a NAMED `anon`
-- grant from an `alter default privileges`, which `revoke ... from public` does not touch.
-- That is exactly how `delete_own_account()` shipped to staging anon-callable while the
-- test forbidding it stayed green. `service_role` is named for the reason
-- `20260811120000_public_grant_hardening.sql` gives: this project has decided never to hold
-- a service-role key, and a standing grant to a key that should not exist is a grant nobody
-- is auditing.
revoke all on function public.move_pack_item(uuid, uuid, uuid, jsonb)
  from public, anon, service_role;
grant execute on function public.move_pack_item(uuid, uuid, uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- move_pack_category
-- ---------------------------------------------------------------------------
--
-- The same function against the other table, minus the re-parent: a category cannot change
-- pack. `planCategoryMove` returns at most one run, whose `parentId` is the pack id, so the
-- check below is an equality rather than a lookup — but the argument still arrives as
-- `runs` rather than as a bare `updates` array, so that both RPCs take the plan's shape and
-- neither caller has to remember which one unwraps.
create or replace function public.move_pack_category(
  p_pack_id uuid,
  p_runs jsonb
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_pairs bigint;
  v_updated bigint;
begin
  perform 1
     from public.packs p
    where p.id = p_pack_id
      and p.user_id = auth.uid()
    for update;

  if not found then
    raise exception 'pack % is not yours to reorder', p_pack_id
      using errcode = 'insufficient_privilege';
  end if;

  if p_runs is null or pg_catalog.jsonb_typeof(p_runs) <> 'array' then
    raise exception 'p_runs must be the `runs` array from a reorder plan, got %',
      coalesce(pg_catalog.jsonb_typeof(p_runs), 'null')
      using errcode = 'invalid_parameter_value';
  end if;

  if exists (
    select 1
      from pg_catalog.jsonb_array_elements(p_runs) as r
     where (r.value ->> 'parentId') is null
        or pg_catalog.jsonb_typeof(r.value -> 'updates') is distinct from 'array'
  ) then
    raise exception 'every run in p_runs needs a parentId and an updates array'
      using errcode = 'invalid_parameter_value';
  end if;

  -- A run of categories is parented by the PACK. Anything else is a plan built from another
  -- pack's rows, and applying it would renumber this one against siblings it does not have.
  if exists (
    select 1
      from pg_catalog.jsonb_array_elements(p_runs) as r
     where (r.value ->> 'parentId')::uuid <> p_pack_id
  ) then
    raise exception 'a run in p_runs is parented by something other than pack %', p_pack_id
      using errcode = 'insufficient_privilege';
  end if;

  if exists (
    select 1
      from pg_catalog.jsonb_array_elements(p_runs) as r
      cross join lateral pg_catalog.jsonb_to_recordset(r.value -> 'updates')
        as u(id uuid, position integer)
     where not exists (
       select 1
         from public.pack_categories c
        where c.id = u.id
          and c.pack_id = p_pack_id
     )
  ) then
    raise exception 'p_runs renumbers a category that is not in pack %', p_pack_id
      using errcode = 'insufficient_privilege';
  end if;

  select count(*)
    into v_pairs
    from pg_catalog.jsonb_array_elements(p_runs) as r
    cross join lateral pg_catalog.jsonb_to_recordset(r.value -> 'updates')
      as u(id uuid, position integer);

  -- Matched on `id` alone here too. There is no re-parenting to make it load-bearing, but
  -- writing it the other way would make the two functions differ for no reason a reader
  -- could infer, and the day a category does gain a second parent-like column the safe
  -- shape is the one already in place.
  update public.pack_categories c
     set position = u.position
    from pg_catalog.jsonb_array_elements(p_runs) as r
    cross join lateral pg_catalog.jsonb_to_recordset(r.value -> 'updates')
      as u(id uuid, position integer)
   where c.id = u.id;

  get diagnostics v_updated = row_count;

  if v_updated <> v_pairs then
    raise exception
      'reorder applied % of % positions in pack % — refusing to commit a partial reindex',
      v_updated, v_pairs, p_pack_id
      using errcode = 'data_exception';
  end if;
end;
$$;

comment on function public.move_pack_category(uuid, jsonb) is
  'Applies the category positions in p_runs — `plan.runs` from planCategoryMove() in src/lib/packs/reorder.ts, verbatim — to one pack, in one transaction under the caller''s own policies. Computes no positions itself.';

revoke all on function public.move_pack_category(uuid, jsonb)
  from public, anon, service_role;
grant execute on function public.move_pack_category(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- duplicate_pack
-- ---------------------------------------------------------------------------
--
-- Copy a pack, its categories and its items, and hand back the new pack's id.
--
-- WHAT THE COPY DELIBERATELY DOES NOT INHERIT:
--
--   slug        Omitted, so `packs.slug`'s own default mints a fresh opaque one. Copying it
--               is not merely wrong, it is impossible — the column is UNIQUE — and deriving
--               one from the name would leak the title of a pack that is about to be
--               private. core_schema.sql:175 argues that default at length; this function
--               simply does not get in its way.
--   visibility  Reset to 'private', never inherited. Duplicating a published pack must not
--               silently publish the copy: a copy is a working draft, and the pack it came
--               from was made public by someone saying so.
--   locked_at   Cleared. See below — this is the point of the feature rather than a
--               tidy-up.
--   created_at
--   updated_at  Omitted, so `set_row_timestamps` stamps them. The baseline's reasoning
--               applies unchanged: these columns are what optimistic concurrency compares
--               against, so a caller that can choose them can make a stale write look fresh
--               — and a copy that claims to have been created when its ORIGINAL was is a
--               lie of exactly that kind.
--   user_id     Omitted on all three inserts, so the `auth.uid()` DEFAULT supplies it. The
--               insert policies check the same value, so passing it explicitly would be one
--               more thing that can disagree with the JWT and nothing that can go right.
--
-- DUPLICATING A LOCKED PACK IS ALLOWED, AND PRODUCES AN UNLOCKED COPY. That is the feature,
-- not an edge case: a user locks last summer's trip for posterity and starts this year's
-- from it, and refusing would leave "unlock, copy, re-lock" as the workaround — three
-- writes, one of which clears every snapshot on the original (see the unlock branch of
-- `freeze_pack_items_on_lock`) and is exactly the sequence core_schema.sql calls "silent
-- data loss wearing the costume of history preservation". Reading a locked pack is
-- unaffected by the lock; only its own contents are frozen, and this function writes none
-- of them.
--
-- DUPLICATING SOMEONE ELSE'S PUBLIC PACK IS NOT SUPPORTED, and the refusal is structural
-- rather than a policy decision made here. `pack_items` carries
-- `foreign key (user_id, gear_item_id) references gear_items (user_id, id)`, so a pack item
-- owned by B cannot reference gear owned by A — a cross-owner copy would have to clone the
-- gear into B's closet first, which is a different feature with its own questions (what
-- happens to the price, the photo, the notes). The `for update` below refuses it long
-- before the foreign key would.
create or replace function public.duplicate_pack(p_pack_id uuid)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_new_pack_id uuid;
  -- The source-category-id -> new-category-id mapping, as a jsonb object keyed by text.
  -- See the CTE below for why it is built the way it is.
  v_category_map jsonb;
begin
  -- The same lock, for a different reason than the reorders take it: it holds the SOURCE
  -- still for the length of the copy. Without it, a concurrent `update packs set locked_at`
  -- could fire `freeze_pack_items_on_lock` between this function reading the categories and
  -- reading the items, and the copy would carry snapshots for some items and not others —
  -- a half-frozen pack that never existed.
  --
  -- It is also the ownership check. `packs_update_own` has no `locked_at` clause (unlocking
  -- is a decision an owner may make), so locking a LOCKED pack's row here succeeds, which
  -- is what makes "duplicating a locked pack is allowed" true rather than merely intended.
  perform 1
     from public.packs p
    where p.id = p_pack_id
      and p.user_id = auth.uid()
    for update;

  if not found then
    raise exception 'pack % is not yours to duplicate', p_pack_id
      using errcode = 'insufficient_privilege';
  end if;

  -- The name is copied verbatim, with no ' (copy)' suffix. Deliberate: what a duplicate
  -- should be called is a product decision with a visible answer, and inventing one in a
  -- migration would put a user-facing string somewhere no designer will ever look for it.
  -- The caller renames the copy if it wants to.
  insert into public.packs (name, description, trip_type, visibility)
  select p.name, p.description, p.trip_type, 'private'
    from public.packs p
   where p.id = p_pack_id
  returning id into v_new_pack_id;

  -- ---------------------------------------------------------------------------
  -- THE CATEGORY ID MAPPING — THE ONE PLACE THIS FUNCTION CAN CORRUPT A COPY
  -- ---------------------------------------------------------------------------
  --
  -- Every copied item has to land in the copy of the category it came from, which means
  -- something has to carry the pairing (source category, its copy) from the category insert
  -- to the item insert.
  --
  -- MATCHING THEM BACK UP BY NAME IS THE TRAP, and it is a trap because it works on every
  -- pack anyone would build by hand while testing. `pack_categories.name` is not unique and
  -- has no reason to be — two 'Extras', a 'Day 1' in a pack that also has a second 'Day 1',
  -- a user who simply has not renamed the two they just added — and a join on name against
  -- a duplicate produces a CROSS PRODUCT: every item of both categories copied into both,
  -- silently, in a feature whose whole promise is a faithful copy.
  --
  -- So the pairing is never re-derived. It is established once, in the CTE below, by
  -- generating the new id ON THE SOURCE ROW — one row of `source` holds both ids and there
  -- is no second step in which they could be associated wrongly. The insert reads that row;
  -- the map is aggregated from the very same row.
  --
  -- `as materialized` is load-bearing, not decoration. `source` is read twice (once by the
  -- data-modifying CTE, once by the outer aggregate), and a CTE that Postgres inlines is
  -- evaluated per reference — which would call `gen_random_uuid()` a second time and produce
  -- a map pointing at ids no category has. Postgres will not inline a CTE containing a
  -- VOLATILE function, so this is already safe today; `materialized` says so out loud rather
  -- than leaving the correctness of the copy resting on a planner rule a reader has to know.
  --
  -- `pg_catalog.gen_random_uuid`, qualified, because `extensions.gen_random_uuid` also
  -- exists on this stack and `search_path = ''` leaves only `pg_catalog` implicit. The
  -- second one comes from pgcrypto, which NO migration in this repository installs —
  -- `20260810000000_baseline.sql` creates only `citext` — and which is nonetheless present
  -- because Supabase preinstalls it into `extensions` when it initialises a database
  -- (`select extname, extnamespace::regnamespace from pg_extension` on the local stack lists
  -- citext, pg_net, pg_stat_statements, pgcrypto, supabase_vault and uuid-ossp). That is
  -- precisely why the qualification matters: the ambiguity is created by the platform rather
  -- than by anything a reader of these migrations can see, so it will not go away by
  -- auditing this directory. Since PG13 `gen_random_uuid()` is in core and the two are
  -- equivalent; naming the schema means the choice is visible instead of resolved.
  --
  -- The `copied` CTE's output is not read by the outer query, and that is fine by
  -- definition: "data-modifying statements in WITH are executed exactly once, and always to
  -- completion, independently of whether the primary query reads their output."
  with source as materialized (
    select c.id as source_id,
           pg_catalog.gen_random_uuid() as new_id,
           c.name,
           c.position
      from public.pack_categories c
     where c.pack_id = p_pack_id
  ),
  copied as (
    insert into public.pack_categories (id, pack_id, name, position)
    select s.new_id, v_new_pack_id, s.name, s.position
      from source s
    returning 1
  )
  select coalesce(pg_catalog.jsonb_object_agg(s.source_id::text, s.new_id), '{}'::jsonb)
    into v_category_map
    from source s;

  -- A SEPARATE STATEMENT, and it has to be one.
  --
  -- Folding this insert into the CTE above would put it in the same command as the category
  -- insert, and `pack_items_assert_unlocked` — `before insert or update ... for each row`,
-- so it is the INSERT half of it that fires here — resolves its
  -- parent with `select c.pack_id from pack_categories c where c.id = new.pack_category_id`
  -- against the command's own snapshot. Sibling CTEs cannot see each other's output, so that
  -- lookup would return NULL, the trigger would find no pack to check, and it would wave the
  -- write through having verified nothing. It would not fail; it would pass for the wrong
  -- reason, which is worse. As its own statement, the categories are visible, the trigger
  -- resolves the NEW pack, finds it unlocked, and does its job.
  --
  -- `snapshot` and `overrides` are copied VERBATIM. For `overrides` that is simply rule 1's
  -- per-list divergence travelling with the item. For `snapshot` it is required rather than
  -- chosen: an item whose gear was deleted has nothing BUT its snapshot, and
  -- `pack_items_reference_or_snapshot` makes a copy without it unrepresentable.
  --
  -- One consequence, recorded rather than left to be discovered: an unlocked copy of a
  -- LOCKED pack carries snapshots even though nothing about it is frozen, so if its gear is
  -- deleted later the BEFORE DELETE trigger's `where snapshot is null` skips it and the item
  -- keeps the ORIGINAL's freeze-time values instead of the values at deletion. This is the
  -- same staleness core_schema.sql describes for the unlock path. It is accepted here
  -- because the alternative — clearing snapshots on the copy — cannot be done for items that
  -- have no gear left to fall back on, and because locking the copy overwrites every
  -- snapshot it can (`freeze_pack_items_on_lock` assigns rather than coalesces), so the
  -- window closes the moment the copy is frozen in its own right.
  insert into public.pack_items (
    pack_category_id, gear_item_id, quantity, worn, consumable, packed, position, overrides, snapshot
  )
  select (v_category_map ->> i.pack_category_id::text)::uuid,
         i.gear_item_id,
         i.quantity,
         i.worn,
         i.consumable,
         i.packed,
         i.position,
         i.overrides,
         i.snapshot
    from public.pack_items i
    join public.pack_categories c on c.id = i.pack_category_id
   where c.pack_id = p_pack_id;

  return v_new_pack_id;
end;
$$;

comment on function public.duplicate_pack(uuid) is
  'Copies a pack, its categories and its items in one transaction and returns the new pack''s id. The copy is private, unlocked and carries a fresh slug; positions, overrides and snapshots are preserved verbatim. Duplicating a LOCKED pack is allowed and is the point — it is how a frozen trip becomes the starting point for the next one.';

revoke all on function public.duplicate_pack(uuid)
  from public, anon, service_role;
grant execute on function public.duplicate_pack(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- pack_items.snapshot now has a THIRD way of coming to exist
-- ---------------------------------------------------------------------------
--
-- The one thing in this file that is not a function. `20260810120000_core_schema.sql:318`
-- documents the column as:
--
--   'Frozen copy, written by gear_item_snapshot(). Non-null once the pack is locked or the
--    referenced gear item is deleted.'
--
-- That was complete when it was written and PK-37 makes it incomplete, so it is restated
-- here rather than edited there — an applied migration is history and must not be rewritten
-- (the same rule 20260817120000_gear_weight_in_grams.sql follows when it replaces the
-- snapshot function rather than editing the original definition). `comment on column` is
-- last-writer-wins, so this statement simply supersedes the earlier one.
--
-- WHAT CHANGED. A pack item may now be a ONE-OFF CUSTOM ITEM: something the owner is taking
-- on this trip that is not in their closet and is not being added to it. Such a row has
-- `gear_item_id` NULL and `snapshot` SET, and it needs no new column and no schema change to
-- express — `pack_items_reference_or_snapshot` is satisfied by the snapshot half, and the
-- column's own shape check (an object, with a `captured_at` key and a non-blank `name`)
-- already describes exactly what such a row must carry. `createCustomPackItem` in
-- `src/lib/packs/mutations.ts` is the writer, and it writes the identical ten keys
-- `private.gear_item_snapshot()` produces, because `src/lib/totals.ts` reads both through
-- one code path and has no provenance field to branch on.
--
-- SO "FROZEN COPY" IS NO LONGER THE WHOLE MEANING. Two rows can hold structurally identical
-- snapshots and mean different things:
--
--   a frozen copy   the item POINTED at a gear row, and that row was copied in — because
--                   the pack was locked (rule 2, freeze_pack_items_on_lock) or because the
--                   gear was deleted (rule 3, snapshot_pack_items_on_gear_delete). The
--                   original existed and may since have changed or gone.
--   an authored item  the item never had a gear row. The snapshot IS the item; there is no
--                   original for it to be a copy of.
--
-- `snapshot -> 'gear_item_id'` IS WHAT TELLS THEM APART, and it is the reason the custom-item
-- writer sets that key to JSON null rather than omitting it. On the freeze paths the key
-- holds the real id of the gear row that was copied; on the authored path it holds null.
-- Note that `pack_items.gear_item_id` — the COLUMN — is null in both cases, the second
-- because the composite foreign key's `on delete set null (gear_item_id)` cleared it after
-- the trigger froze the row, so the column cannot answer this question and the snapshot has
-- to. Absent and null are different in jsonb (`snapshot ? 'gear_item_id'` distinguishes
-- them; `->>` returns SQL NULL for both), which is why the key is written explicitly.
-- PK-66's "add this to your closet" offer is built on exactly that distinction: it is the
-- right offer for an authored item and the wrong one for an item whose gear was deleted.
--
-- AND `captured_at` NOW MEANS TWO DIFFERENT THINGS. On a frozen copy it is when the COPY WAS
-- TAKEN — lock time, or deletion time — which is what tells a reader how old the values are.
-- On an authored item it is when the ITEM WAS CREATED; nothing was copied, so there is no
-- staleness for it to measure. A reader of a single row cannot tell which reading applies
-- without checking `gear_item_id` first, which is why both sentences are in the comment
-- below rather than only the older one.
comment on column public.pack_items.snapshot is
  'Either a frozen copy of a gear item — written by gear_item_snapshot() when the pack is locked (rule 2) or when the referenced gear item is deleted (rule 3) — or, since PK-37, the item itself for a one-off custom item authored in this pack with no gear row behind it. snapshot -> ''gear_item_id'' distinguishes them: a real gear id for a frozen copy, JSON null for an authored item (the gear_item_id COLUMN is null in both cases). captured_at means when the copy was taken in the first case, and when the item was created in the second.';

-- ---------------------------------------------------------------------------
-- THE TWO REORDER FUNCTIONS, CORRECTED: A REFUSED WRITE CAN NO LONGER REPORT SUCCESS
-- ---------------------------------------------------------------------------
--
-- WHY THIS IS AT THE BOTTOM OF THE FILE RATHER THAN AN EDIT TO THE DEFINITIONS ABOVE. An
-- applied migration is history and is not rewritten in place — the rule
-- `20260817120000_gear_weight_in_grams.sql` follows when it REPLACES
-- `private.gear_item_snapshot()` rather than editing the original definition, and the same
-- rule this file already follows for `comment on column public.pack_items.snapshot`. The
-- definitions above are what was applied; these are what supersede them, and a reader who
-- runs the file top to bottom ends up with exactly what a fresh `supabase db reset`
-- produces.
--
-- ---------------------------------------------------------------------------
-- WHAT WAS WRONG
-- ---------------------------------------------------------------------------
--
-- `move_pack_item` checked the affected row count of its POSITION update (point 4 of the
-- header) and did not check the affected row count of its RE-PARENT update. With
-- `p_runs = []` — a real and tested case, `tests/pack-composition-rpc.test.ts`'s "re-parents
-- an item even when no position changes", which is what dragging the only item of one
-- category into an empty one produces — `v_pairs` is 0 and `v_updated` is 0, so `0 <> 0` is
-- false and the function returned success. If the re-parent had also affected nothing, that
-- success was a claim about a transaction that wrote nothing at all.
--
-- IT IS NOT HYPOTHETICAL, AND THE MECHANISM IS THE ONE THE HEADER GOT WRONG. On a locked
-- pack, `pack_items_update_own`'s `p.locked_at is null` sits in `USING`, so RLS FILTERS the
-- row out instead of raising; the statement matches nothing, and `assert_parent_pack_unlocked`
-- — a BEFORE ROW trigger — never fires, because there is no row for it to fire on. Measured
-- on this stack rather than reasoned about: the re-parent UPDATE returns `row_count = 0` with
-- no exception, and the old `move_pack_item` then returned success while the item stayed
-- exactly where it was.
--
-- ---------------------------------------------------------------------------
-- HOW IT IS FIXED, AND WHY NOT WITH A `locked_at` CHECK AT THE TOP
-- ---------------------------------------------------------------------------
--
-- The obvious repair — refuse up front if `packs.locked_at is not null` — is the wrong shape
-- twice over. It answers a question nobody asked (this function's job is to apply a plan, not
-- to re-state rule 2, and rule 2 is already enforced by the policies), and it leaves the
-- actual defect in place: a write that affected no rows for ANY OTHER reason would still be
-- reported as a move that happened. So the check is on the OUTCOME of each write, and the
-- lock is consulted only to explain an outcome already found wanting:
--
--   1. The re-parent's row count is taken. Zero is not automatically wrong — a same-category
--      move is filtered out by `is distinct from` on purpose (see the definition above), and
--      re-parenting an item to the category it is already in must not stamp `updated_at`. So
--      zero rows is legitimate EXACTLY WHEN the item is already in the destination, and that
--      is what is checked: `exists (... i.id = p_item_id and i.pack_category_id =
--      p_to_category_id)`. If it is not there, the move did not happen and the function
--      raises rather than returning.
--   2. The position update's row count is compared against the number of pairs, exactly as
--      before. That check was already correct; what changes is what it SAYS when it fires on
--      a locked pack.
--
-- WHEN EITHER FINDS A WRITE THAT DID NOT HAPPEN, THE LOCK IS WHAT IT ASKS FIRST. `locked_at`
-- is read once, at the top, off the row this function already reads and locks `for update` —
-- no extra query, and it cannot change underneath the transaction, because anything that
-- would set it has to take the same row lock (`assert_parent_pack_unlocked`, and the plain
-- `update packs set locked_at` that fires it). A locked pack is an ORDINARY, EXPECTED,
-- USER-ACTIONABLE state, so it gets a sentence of its own rather than being reported as a
-- partial reindex — which is what the old code said, and which described corruption that had
-- not occurred.
--
-- SQLSTATE 55000 (`object_not_in_prerequisite_state`), and DELIBERATELY NOT the
-- `check_violation` (23514) that `assert_parent_pack_unlocked()` raises for the same
-- underlying condition. `src/pages/packs/reorder.ts` keys off this code to answer a locked
-- pack with a 409 and a sentence instead of a 500, and 23514 is also what every column CHECK
-- on these tables raises — `pack_items.position >= 0` included, which an authenticated caller
-- can trip deliberately by sending a negative position in `p_runs`. Sharing the code would
-- make the endpoint tell that caller their pack is locked, which would be a lie the endpoint
-- had no way to avoid.
--
-- ---------------------------------------------------------------------------
-- THE SAME AUDIT, APPLIED TO move_pack_category
-- ---------------------------------------------------------------------------
--
-- It has ONE write, and its row count was already checked, so there is no second statement a
-- zero could be hiding. `p_runs = []` really is a no-op there — a category has no parent to
-- change, so there is nothing a category move can consist of other than positions — and
-- reporting success for it is honest rather than a hole. What it did NOT have was an honest
-- MESSAGE: on a locked pack its one update is filtered to zero rows and it raised "reorder
-- applied 0 of 2 positions — refusing to commit a partial reindex", naming a failure mode
-- that did not happen. It gets the same diagnosis, for the same reason, and no re-parent
-- check, because it has nothing to re-parent.

create or replace function public.move_pack_item(
  p_pack_id uuid,
  p_item_id uuid,
  p_to_category_id uuid,
  p_runs jsonb
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  -- bigint, matching `get diagnostics ... = row_count`, so the comparisons below are between
  -- two values of one type rather than between a count and a coerced integer.
  v_pairs bigint;
  v_updated bigint;
  v_reparented bigint;
  -- Read from the row this function locks anyway. Not a permission check — the `for update`
  -- below is that — but the answer to "why did a write affect no rows", kept for the two
  -- places that have to ask it.
  v_locked_at timestamptz;
begin
  -- Point 2 of the header. First statement in the function, before anything is read, so the
  -- whole verify-then-apply sequence sits inside one lock rather than validating against a
  -- snapshot another session is about to move.
  --
  -- `for update` on `packs` is also an authorisation check and not only a lock: the row is
  -- visible for locking only if the caller passes `packs_update_own`, so a pack that is
  -- someone else's — including a PUBLIC pack of someone else's, which `packs_select_public`
  -- would happily return for a plain read — is simply not found here.
  --
  -- `select ... into` rather than `perform`, so `locked_at` comes back with the lock. `found`
  -- is set by both spellings and means the same thing: a row was located. It does NOT mean
  -- the column was non-null, which matters because an unlocked pack's `locked_at` IS null.
  -- `packs_update_own` has no `locked_at` clause (unlocking is a decision an owner may make),
  -- so a LOCKED pack is found here too — which is what makes the diagnosis below possible at
  -- all rather than turning into a second "not yours".
  select p.locked_at
    into v_locked_at
    from public.packs p
   where p.id = p_pack_id
     and p.user_id = auth.uid()
   for update;

  if not found then
    raise exception 'pack % is not yours to reorder', p_pack_id
      using errcode = 'insufficient_privilege';
  end if;

  -- The shape of the payload, checked before it is walked. `jsonb_array_elements` on a
  -- scalar raises `cannot extract elements from a scalar`, which names neither this
  -- function nor the argument that was wrong.
  if p_runs is null or pg_catalog.jsonb_typeof(p_runs) <> 'array' then
    raise exception 'p_runs must be the `runs` array from a reorder plan, got %',
      coalesce(pg_catalog.jsonb_typeof(p_runs), 'null')
      using errcode = 'invalid_parameter_value';
  end if;

  if exists (
    select 1
      from pg_catalog.jsonb_array_elements(p_runs) as r
     where (r.value ->> 'parentId') is null
        or pg_catalog.jsonb_typeof(r.value -> 'updates') is distinct from 'array'
  ) then
    raise exception 'every run in p_runs needs a parentId and an updates array'
      using errcode = 'invalid_parameter_value';
  end if;

  -- The destination. Required, always applied, never inferred — see "reparent IS
  -- DELIBERATELY NOT PASSED AS JSON" in the header. A category whose `pack_id` is this pack
  -- is necessarily the caller's own, because the pack itself was just proved to be.
  if not exists (
    select 1
      from public.pack_categories c
     where c.id = p_to_category_id
       and c.pack_id = p_pack_id
  ) then
    raise exception 'category % is not in pack %', p_to_category_id, p_pack_id
      using errcode = 'insufficient_privilege';
  end if;

  -- The item being moved, proved to be in this pack BEFORE its parent is rewritten.
  -- Without this, `update ... where id = p_item_id` under RLS would touch nothing for a
  -- stranger's id and the function would report success having moved nothing.
  if not exists (
    select 1
      from public.pack_items i
      join public.pack_categories c on c.id = i.pack_category_id
     where i.id = p_item_id
       and c.pack_id = p_pack_id
  ) then
    raise exception 'item % is not in pack %', p_item_id, p_pack_id
      using errcode = 'insufficient_privilege';
  end if;

  -- Point 3, the first half: the runs name categories of THIS pack. `parentId` is not used
  -- to find rows — point 1 — but it is the caller's own statement about which run each set
  -- of numbers belongs to, and a plan whose runs point at another pack was computed against
  -- the wrong siblings whatever its ids say.
  if exists (
    select 1
      from pg_catalog.jsonb_array_elements(p_runs) as r
     where not exists (
       select 1
         from public.pack_categories c
        where c.id = (r.value ->> 'parentId')::uuid
          and c.pack_id = p_pack_id
     )
  ) then
    raise exception 'a run in p_runs names a category that is not in pack %', p_pack_id
      using errcode = 'insufficient_privilege';
  end if;

  -- Point 3, the second half: every id being renumbered is an item of this pack. An id the
  -- caller does not own fails this too — RLS makes it invisible, so the `not exists` holds.
  if exists (
    select 1
      from pg_catalog.jsonb_array_elements(p_runs) as r
      cross join lateral pg_catalog.jsonb_to_recordset(r.value -> 'updates')
        as u(id uuid, position integer)
     where not exists (
       select 1
         from public.pack_items i
         join public.pack_categories c on c.id = i.pack_category_id
        where i.id = u.id
          and c.pack_id = p_pack_id
     )
  ) then
    raise exception 'p_runs renumbers an item that is not in pack %', p_pack_id
      using errcode = 'insufficient_privilege';
  end if;

  select count(*)
    into v_pairs
    from pg_catalog.jsonb_array_elements(p_runs) as r
    cross join lateral pg_catalog.jsonb_to_recordset(r.value -> 'updates')
      as u(id uuid, position integer);

  -- The re-parent runs FIRST, so that by the time the positions land, every row named by
  -- the destination run is actually in the destination. The two orders are equivalent for
  -- the data — the position update matches on `id` alone and does not care where a row
  -- lives — but this one leaves no intermediate state in which a category's rows and its
  -- numbering disagree, which is the state anything reading these tables from a trigger
  -- would see.
  --
  -- `is distinct from` because a same-category move passes the category the item is already
  -- in: without the guard this would rewrite the row for nothing and stamp `updated_at`,
  -- which is the column PK-20's optimistic concurrency compares against. A no-op write that
  -- moves that timestamp is a conflict reported to a user who caused none.
  update public.pack_items
     set pack_category_id = p_to_category_id
   where id = p_item_id
     and pack_category_id is distinct from p_to_category_id;

  get diagnostics v_reparented = row_count;

  -- THE CHECK THIS FUNCTION SHIPPED WITHOUT. Zero rows here has two causes and they are
  -- opposites: the guard above filtered a move to where the item already is (fine, and the
  -- ordinary same-category case), or the write was refused and the item did not move (not
  -- fine, and previously reported as success). The `exists` tells them apart by asking where
  -- the row actually IS, now, inside this transaction — which is the only question whose
  -- answer separates them. It reads through `pack_items_select_own`, which this same item
  -- passed a few statements ago, so a false here means the row is somewhere else and not
  -- that it became invisible.
  if v_reparented = 0 and not exists (
    select 1
      from public.pack_items i
     where i.id = p_item_id
       and i.pack_category_id = p_to_category_id
  ) then
    if v_locked_at is not null then
      raise exception 'pack % is locked; unlock it before reordering its contents', p_pack_id
        using errcode = '55000';
    end if;
    raise exception
      'item % was not moved into category % — refusing to report a move that did not happen',
      p_item_id, p_to_category_id
      using errcode = 'data_exception';
  end if;

  -- One statement for both runs. Point 1 in full: matched on `i.id = u.id` and on nothing
  -- else. `r` and `u` are flattened here rather than applied run by run precisely because
  -- the run boundary must not become a predicate; it did its job in the checks above.
  update public.pack_items i
     set position = u.position
    from pg_catalog.jsonb_array_elements(p_runs) as r
    cross join lateral pg_catalog.jsonb_to_recordset(r.value -> 'updates')
      as u(id uuid, position integer)
   where i.id = u.id;

  get diagnostics v_updated = row_count;

  -- Point 4. Three ways this can differ, and only the last two are corruption: the pack is
  -- locked and RLS filtered every row out (an ordinary state, said plainly); a duplicated id,
  -- so two pairs updated one row and which position won depends on the plan the executor
  -- chose; or a row RLS declined for some other reason. `position >= 0` is left to the
  -- column's own CHECK — core_schema.sql:228 argues that negatives are "just a reindex that
  -- went wrong", and a constraint that aborts the transaction says so better than a
  -- re-implementation here would.
  if v_updated <> v_pairs then
    if v_locked_at is not null then
      raise exception 'pack % is locked; unlock it before reordering its contents', p_pack_id
        using errcode = '55000';
    end if;
    raise exception
      'reorder applied % of % positions in pack % — refusing to commit a partial reindex',
      v_updated, v_pairs, p_pack_id
      using errcode = 'data_exception';
  end if;
end;
$$;

comment on function public.move_pack_item(uuid, uuid, uuid, jsonb) is
  'Re-parents one pack item to p_to_category_id and applies the positions in p_runs — `plan.runs` from planItemMove() in src/lib/packs/reorder.ts, verbatim — in one transaction under the caller''s own policies. Computes no positions itself. Raises SQLSTATE 55000 when the pack is locked, and refuses to return normally when either write affected no rows: see the section at the end of the migration that defines it.';

create or replace function public.move_pack_category(
  p_pack_id uuid,
  p_runs jsonb
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_pairs bigint;
  v_updated bigint;
  v_locked_at timestamptz;
begin
  select p.locked_at
    into v_locked_at
    from public.packs p
   where p.id = p_pack_id
     and p.user_id = auth.uid()
   for update;

  if not found then
    raise exception 'pack % is not yours to reorder', p_pack_id
      using errcode = 'insufficient_privilege';
  end if;

  if p_runs is null or pg_catalog.jsonb_typeof(p_runs) <> 'array' then
    raise exception 'p_runs must be the `runs` array from a reorder plan, got %',
      coalesce(pg_catalog.jsonb_typeof(p_runs), 'null')
      using errcode = 'invalid_parameter_value';
  end if;

  if exists (
    select 1
      from pg_catalog.jsonb_array_elements(p_runs) as r
     where (r.value ->> 'parentId') is null
        or pg_catalog.jsonb_typeof(r.value -> 'updates') is distinct from 'array'
  ) then
    raise exception 'every run in p_runs needs a parentId and an updates array'
      using errcode = 'invalid_parameter_value';
  end if;

  -- A run of categories is parented by the PACK. Anything else is a plan built from another
  -- pack's rows, and applying it would renumber this one against siblings it does not have.
  if exists (
    select 1
      from pg_catalog.jsonb_array_elements(p_runs) as r
     where (r.value ->> 'parentId')::uuid <> p_pack_id
  ) then
    raise exception 'a run in p_runs is parented by something other than pack %', p_pack_id
      using errcode = 'insufficient_privilege';
  end if;

  if exists (
    select 1
      from pg_catalog.jsonb_array_elements(p_runs) as r
      cross join lateral pg_catalog.jsonb_to_recordset(r.value -> 'updates')
        as u(id uuid, position integer)
     where not exists (
       select 1
         from public.pack_categories c
        where c.id = u.id
          and c.pack_id = p_pack_id
     )
  ) then
    raise exception 'p_runs renumbers a category that is not in pack %', p_pack_id
      using errcode = 'insufficient_privilege';
  end if;

  select count(*)
    into v_pairs
    from pg_catalog.jsonb_array_elements(p_runs) as r
    cross join lateral pg_catalog.jsonb_to_recordset(r.value -> 'updates')
      as u(id uuid, position integer);

  -- Matched on `id` alone here too. There is no re-parenting to make it load-bearing, but
  -- writing it the other way would make the two functions differ for no reason a reader
  -- could infer, and the day a category does gain a second parent-like column the safe
  -- shape is the one already in place.
  update public.pack_categories c
     set position = u.position
    from pg_catalog.jsonb_array_elements(p_runs) as r
    cross join lateral pg_catalog.jsonb_to_recordset(r.value -> 'updates')
      as u(id uuid, position integer)
   where c.id = u.id;

  get diagnostics v_updated = row_count;

  -- This function's ONLY write, so unlike `move_pack_item` there is no second statement a
  -- zero here could be hiding — which is the whole result of the audit recorded above. What
  -- the lock changes is the sentence, not the refusal: a locked pack filters every row out
  -- through `pack_categories_update_own`'s USING clause, and calling that "a partial reindex"
  -- describes corruption that did not happen.
  if v_updated <> v_pairs then
    if v_locked_at is not null then
      raise exception 'pack % is locked; unlock it before reordering its contents', p_pack_id
        using errcode = '55000';
    end if;
    raise exception
      'reorder applied % of % positions in pack % — refusing to commit a partial reindex',
      v_updated, v_pairs, p_pack_id
      using errcode = 'data_exception';
  end if;
end;
$$;

comment on function public.move_pack_category(uuid, jsonb) is
  'Applies the category positions in p_runs — `plan.runs` from planCategoryMove() in src/lib/packs/reorder.ts, verbatim — to one pack, in one transaction under the caller''s own policies. Computes no positions itself. Raises SQLSTATE 55000 when the pack is locked: see the section at the end of the migration that defines it.';

-- Re-issued rather than relied upon. The `create or replace`s above kept the ACL each
-- function already carried, because neither SIGNATURE changed — but that is a fact about
-- these two statements, not a property of the syntax. Alter an argument list and
-- `create or replace` creates a SECOND function, born on a hosted project with the named
-- `anon` grant an `alter default privileges` attaches, which is PK-57 exactly. See the
-- revoke block beside the original definition of `move_pack_item` for why `from public`
-- alone does not cover it.
revoke all on function public.move_pack_item(uuid, uuid, uuid, jsonb)
  from public, anon, service_role;
grant execute on function public.move_pack_item(uuid, uuid, uuid, jsonb) to authenticated;

revoke all on function public.move_pack_category(uuid, jsonb)
  from public, anon, service_role;
grant execute on function public.move_pack_category(uuid, jsonb) to authenticated;
