-- Gear weight becomes grams at rest (PK-67).
--
-- ---------------------------------------------------------------------------
-- THIS REVERSES A DECISION THIS SCHEMA ARGUED FOR AT LENGTH
-- ---------------------------------------------------------------------------
--
-- `20260810120000_core_schema.sql` said, on the column itself: "Stored in weight_unit, as
-- entered. Conversion and totalling are pure functions in the application (Ref 23), not
-- database concerns." `src/lib/units.ts` devoted a section to the same split — "Grams are
-- canonical in memory, during arithmetic, never at rest" — and called storing as entered
-- "deliberately the OPPOSITE choice", on the grounds that a 4.4 oz entry is not
-- "124.7381 g" to anybody who typed 4.4.
--
-- Both of those comments are rewritten by this ticket rather than left standing, because a
-- migration that silently contradicts the prose above it is the one failure mode this
-- repository has avoided everywhere else. What follows is the argument for the new
-- position, so that this file is not merely the place the old one stopped being true.
--
-- WHAT ACTUALLY CHANGED IS THAT THE UNIT STOPPED BEING PER-ITEM. The old design was
-- coherent while every gear row carried its own unit: the row remembered what the user
-- typed, and preserving that was worth something real. PK-67 moves the unit to one
-- account-level choice, and that pulls the ground out from under it — there is no longer a
-- per-row "as entered" unit to be faithful TO. Keeping `weight_unit` after the form stops
-- offering it would leave a column whose only remaining job is to record which unit the
-- account happened to be set to on the day each row was written, which is not history
-- anybody wants: switch to imperial and half the closet would still be stamped 'g',
-- describing a preference the user no longer holds rather than a fact about the gear.
--
-- The 4.4-oz argument survives the change intact, and is now answered somewhere better.
-- A user who types 4.4 under an imperial account still SEES 4.4 oz, because display
-- derives the unit from the account setting and the magnitude (`formatWeight` in
-- src/lib/units.ts) rather than from a column. What is lost is the ability to tell 4.4 oz
-- apart from 124.738 g entered by a metric user — two rows that now store the same number
-- because they describe the same weight. That is the correct outcome for a product whose
-- whole complaint (PK-67's "Why") was that a closet listing `4.4 oz` beside `120 g` cannot
-- be compared by eye.
--
-- WHAT THE PRODUCT GAINS is that every weight in the database is directly comparable
-- without a conversion, which is the property `weight_grams` was added as a GENERATED
-- column to fake in `20260813000000_gear_closet.sql`. That column existed only because
-- `weight` alone did not mean the same thing across two rows. Once it does, the generated
-- column is the derived copy and `weight` is the thing worth keeping — so this migration
-- deletes the derivation and gives its name to the column that now earns it.
--
-- ---------------------------------------------------------------------------
-- THE ORDER OF THE STATEMENTS BELOW, AND WHY IT IS NOT ARBITRARY
-- ---------------------------------------------------------------------------
--
--   1. Replace private.gear_item_snapshot().
--   2. Rewrite pack_items.overrides (two shapes), then pack_items.snapshot.
--   3. Drop the generated weight_grams column.
--   4. Backfill gear_items.weight to grams, with the updated_at trigger suppressed.
--   5. Drop weight_unit.
--   6. Rename weight to weight_grams.
--
-- Step 2 MUST precede steps 5 and 6, and this is the constraint that fixes the whole
-- order: rewriting an override that carries a weight but no unit of its own requires
-- knowing which unit that weight was expressed in, and the only two places that fact
-- exists are `pack_items.snapshot->>'weight_unit'` and `gear_items.weight_unit` — one of
-- which step 2 itself removes and the other of which step 5 drops. Do the column surgery
-- first and the information needed to convert those rows is gone.
--
-- Step 1 precedes everything for the reason `20260813120000_gear_schema_slim.sql` sets out
-- at length for its own replace-before-drop ordering: a `language sql` function body is
-- validated at CREATE time but its parse tree is discarded, so no `pg_depend` entry ties
-- it to the columns it mentions and a later `DROP COLUMN` will not refuse to break it. The
-- statements share one migration and the CLI applies each migration in a transaction, so
-- no other session observes the intermediate state — but replace-first is the order that
-- stays correct if these statements are ever split apart, which is the failure that file
-- was actually defending against.
--
-- Here that property is unusually strong, and it is worth naming because it looks like a
-- coincidence. The new function body reads `item.weight_grams`, and that name is correct
-- BOTH BEFORE AND AFTER the surgery below: before, it is the generated column, which holds
-- exactly the gram figure this function now wants; after, it is the renamed real column
-- holding the same number. So the replacement is not merely safe to run first, it is
-- semantically complete on its own — ship step 1 alone, with nothing else in this file,
-- and snapshots are still correct. Only between step 3 and step 6 does the body reference
-- a name that does not resolve, and nothing invokes it there: the freeze paths run this
-- function from BEFORE DELETE on gear_items and BEFORE UPDATE on packs, and this migration
-- performs neither.

-- ---------------------------------------------------------------------------
-- 1. The frozen form of a gear item — grams, and no unit
-- ---------------------------------------------------------------------------
--
-- `weight_unit` leaves the snapshot rather than being frozen as 'g' forever. A snapshot is
-- a historical record of a gear row, and the row no longer has a unit to record; writing a
-- constant would be inventing history rather than preserving it.
create or replace function private.gear_item_snapshot(item public.gear_items)
returns jsonb
language sql
stable
-- SECURITY INVOKER and an empty search_path, unchanged and for the unchanged reasons the
-- baseline migration sets out on set_updated_at(): a DEFINER function reachable from a
-- table trigger runs as its owner and would step straight over the policies, and a mutable
-- search_path hands name resolution to whoever calls it.
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'name', item.name,
    'brand', item.brand,
    'category', item.category,
    'description', item.description,
    'weight', item.weight_grams,
    'price', item.price,
    'currency', item.currency,
    'photo_path', item.photo_path,
    'gear_item_id', item.id,
    'captured_at', now()
  );
$$;

grant execute on function private.gear_item_snapshot(public.gear_items)
  to authenticated, service_role;

comment on function private.gear_item_snapshot(public.gear_items) is
  'The frozen form of a gear item, as written into pack_items.snapshot. Used by both freeze paths — pack locking and gear deletion — so the two cannot drift. Since PK-67 the frozen ''weight'' is a gram figure and there is no ''weight_unit'' key: gear no longer carries a per-row unit.';

-- ---------------------------------------------------------------------------
-- 2. The frozen rows are rewritten — the one place "leave history alone" cannot apply
-- ---------------------------------------------------------------------------
--
-- `20260813120000_gear_schema_slim.sql` left pre-existing snapshots untouched when it
-- dropped `volume_litres`, and argued that rewriting them "would be editing history to
-- match a schema change that postdates it". That argument is right, and it does not reach
-- this case. The difference is that dropping a key made the old snapshots merely RICHER
-- than the new ones — a reader that ignores `volume_litres` is correct about every row,
-- old and new alike. Here the change is to the MEANING of a key that stays:
-- `'weight'` goes from "a number in the unit named by the sibling key" to "a number of
-- grams", and the sibling key disappears.
--
-- Left alone, `src/lib/totals.ts` would face two incompatible shapes with no way to tell
-- them apart, because the absence of `weight_unit` is ambiguous between "this is grams"
-- and "this is an old row that never had one". It could not even fail safely: an old
-- 4.4-oz snapshot would read as 4.4 g and quietly under-report a locked pack by a factor
-- of twenty-eight, which is exactly the class of silent wrongness the units module exists
-- to prevent. So the rows are converted, once, here — and after this runs there is exactly
-- one snapshot shape in the database.
--
-- THE TWO TRIGGERS ON pack_items ARE BOTH SUPPRESSED, and the first of them is not
-- optional in the way the second is:
--
--   - `pack_items_assert_unlocked` (core_schema.sql:606) raises `pack % is locked` on any
--     INSERT or UPDATE at `pg_trigger_depth() = 1`, which a migration's UPDATE is. Every
--     row this section needs to touch is a row that has a snapshot, and a row HAS a
--     snapshot precisely because its pack was locked or its gear was deleted — so without
--     this the statement below does not merely restamp something, it ABORTS the migration
--     on the first locked pack it meets. The trigger is protecting client writes against a
--     locked pack; this is a schema migration rewriting the frozen copy in place, which is
--     the one write that has to be allowed through a lock.
--   - `pack_items_set_updated_at` is suppressed for the reason
--     20260813120000_gear_schema_slim.sql gives for the identical move on gear_items: left
--     enabled it would stamp `updated_at = now()` on every rewritten row, claiming a human
--     edited a locked pack just now, in a column optimistic-concurrency logic compares
--     against. No user touched anything.
--
-- Both are re-enabled immediately afterwards, so every other write against this table —
-- including any running concurrently with this migration — keeps the ordinary guarantees.
alter table public.pack_items disable trigger pack_items_assert_unlocked;
alter table public.pack_items disable trigger pack_items_set_updated_at;

-- 2a. An override that carries a weight but NO unit of its own.
--
-- This shape is easy to miss and is the reason this section runs before the column drops.
-- `resolveWeightGrams` in src/lib/totals.ts merges the override over the base row key by
-- key, so `{"weight": 450}` overrode the number and left the unit alone — taking
-- `weight_unit` from the snapshot, or from the gear row when there is no snapshot. The
-- number therefore meant "450 of whatever unit the BASE was in", and converting it needs
-- that base unit, which exists in exactly the two places coalesced below and in no third
-- place once this migration is finished.
--
-- Ignoring this shape would have been within a literal reading of the ticket, which speaks
-- of a "weight/weight_unit pair". It is not ignorable: for a metric account it is a no-op,
-- and for an account whose gear was in ounces it silently divides an overridden weight by
-- twenty-eight — a wrong number on a shared pack, arrived at by doing nothing.
--
-- `else 1` covers a base unit that is null or not one of the four. Null is unreachable
-- through this schema (`gear_items.weight_unit` is NOT NULL, and every snapshot written
-- before this migration carries the key), and a malformed value is already unrenderable —
-- `isWeightUnit` in totals.ts throws on it today. Treating such a row's number as grams
-- leaves it displayable rather than fatal, and is the only alternative to inventing a
-- factor for a unit nobody can name.
update public.pack_items pi
   set overrides = pi.overrides || jsonb_build_object(
         'weight',
         (pi.overrides ->> 'weight')::numeric * case coalesce(
                pi.snapshot ->> 'weight_unit',
                (select g.weight_unit from public.gear_items g where g.id = pi.gear_item_id)
              )
              when 'g' then 1
              when 'kg' then 1000
              when 'oz' then 28.349523125
              when 'lb' then 453.59237
              else 1
            end
       )
 where not (pi.overrides ? 'weight_unit')
   and jsonb_typeof(pi.overrides -> 'weight') = 'number';

-- 2b. An override that carries a unit of its own, with or without a weight beside it.
--
-- `overrides` is owner-writable free-form JSON constrained only to `jsonb_typeof(...) =
-- 'object'`, so all three sub-shapes below are reachable through an ordinary PATCH rather
-- than hypothetical:
--
--   - unit AND a numeric weight: convert the number by its own unit, drop the key.
--   - unit alone, overriding only the base row's unit: there is no longer a unit for it to
--     override, so the key is dropped and the item falls back to its base gram weight.
--     Nothing better is available — the override never carried a number of its own.
--   - unit alone with a MALFORMED value ('lbs', 'stones'): the key is dropped and any
--     weight is left as-is. Such a row throws in totals.ts today, so no correct rendering
--     is being lost; `else 1` reads it as grams from here on.
update public.pack_items
   set overrides = case
         when jsonb_typeof(overrides -> 'weight') = 'number'
           then (overrides - 'weight_unit') || jsonb_build_object(
                  'weight',
                  (overrides ->> 'weight')::numeric * case overrides ->> 'weight_unit'
                       when 'g' then 1
                       when 'kg' then 1000
                       when 'oz' then 28.349523125
                       when 'lb' then 453.59237
                       else 1
                     end
                )
         else overrides - 'weight_unit'
       end
 where overrides ? 'weight_unit';

-- 2c. The frozen snapshots themselves.
--
-- NOT ROUNDED to three decimals, deliberately, even though `gear_items.weight` lands in a
-- `numeric(12, 3)` below and will be. `snapshot` is jsonb with no scale of its own, and the
-- number this replaces was whatever the column held at freeze time; converting at full
-- precision reproduces EXACTLY the gram figure `toGrams` computed from that row before this
-- migration, so a pack locked beforehand reports an identical total afterwards rather than
-- one that merely agrees to three decimals. Rounding here would introduce a discrepancy
-- purely to match a constraint this column does not have.
--
-- The `jsonb_typeof(...) = 'number'` guard matters for the same reason totals.ts checks:
-- a hand-written snapshot can carry `"weight": "heavy"` or a null, and `::numeric` on either
-- would abort this migration. Such a row keeps whatever it had and loses only its unit key,
-- which leaves it exactly as broken as it already was rather than making a schema migration
-- the thing that fails.
update public.pack_items
   set snapshot = (snapshot - 'weight_unit') || case
         when jsonb_typeof(snapshot -> 'weight') = 'number'
           then jsonb_build_object(
                  'weight',
                  (snapshot ->> 'weight')::numeric * case snapshot ->> 'weight_unit'
                       when 'g' then 1
                       when 'kg' then 1000
                       when 'oz' then 28.349523125
                       when 'lb' then 453.59237
                       else 1
                     end
                )
         else '{}'::jsonb
       end
 where snapshot is not null
   and snapshot ? 'weight_unit';

alter table public.pack_items enable trigger pack_items_assert_unlocked;
alter table public.pack_items enable trigger pack_items_set_updated_at;

-- ---------------------------------------------------------------------------
-- 3. The generated column goes
-- ---------------------------------------------------------------------------
--
-- `weight_grams` was `generated always as (case weight_unit ...) stored`, and a generated
-- column cannot outlive the columns its expression reads — dropping `weight_unit` with this
-- in place fails outright. It is dropped rather than rewritten because the whole reason it
-- existed is about to stop being true: it was, in its own comment's words, the way "two rows
-- entered in different units can be compared", and after the backfill below every row is
-- already directly comparable.
--
-- No index depends on it. `20260813000000_gear_closet.sql` explicitly added none — its
-- "Deliberately no new indexes" section argues that the existing unique `(user_id, id)`
-- btree already answers every owner-scoped query and that a per-user closet is a few
-- hundred rows — and `pg_indexes` on this table confirms only `gear_items_pkey` and
-- `gear_items_user_id_id_key` exist. PK-67's requirement to "recreate the index that
-- pointed at the old generated column" therefore has nothing to recreate, and inventing
-- one here would contradict that reasoning while adding write amplification to what
-- core_schema.sql calls one of the two hottest tables in this schema.
alter table public.gear_items
  drop column weight_grams;

-- ---------------------------------------------------------------------------
-- 4. The backfill
-- ---------------------------------------------------------------------------
--
-- An explicit UPDATE, never a column default, following the precedent
-- `20260813120000_gear_schema_slim.sql` set for `acquired_on`: a default applies to
-- existing rows as well and would overwrite real data with a manufactured value.
--
-- THE FOUR FACTORS ARE THE EXACT 1959 YARD-AND-POUND VALUES, byte for byte identical to
-- `GRAMS_PER_UNIT` in `src/lib/units.ts` and to the CASE this migration just deleted from
-- the generated column. The international pound is precisely 0.45359237 kg and the
-- avoirdupois ounce exactly 1/16 of it; written to fewer digits every imperial weight in
-- the product is wrong by a small, silent, entirely avoidable amount. Do not "tidy" these.
--
-- No `else` on the CASE, and no `where` clause. `weight_unit` is `not null` with
-- `check (weight_unit in ('g', 'kg', 'oz', 'lb'))`, so the four branches are total; a fifth
-- value cannot exist, and if one somehow did the CASE would yield null and the statement
-- would abort against the column's NOT NULL rather than quietly write a wrong number.
--
-- THIS STATEMENT IS NOT IDEMPOTENT, and unlike the `acquired_on` backfill it needs no guard
-- to make it safe to replay. Running it twice would square the conversion — but it cannot
-- run twice, because the column it reads is dropped four statements later in this same
-- file. A replay of this migration fails at `drop column weight_unit` with a missing-column
-- error long before it could double anything, which is a stronger guarantee than a `where`
-- clause and does not depend on remembering to write one.
--
-- THE TRIGGER IS SUPPRESSED for the reason gear_schema_slim.sql sets out in full for its
-- own backfill: `gear_items_set_updated_at` sets `new.updated_at = now()` on every UPDATE
-- regardless of what changed, and letting it fire here would claim a human edited every
-- piece of gear in every closet at the moment this migration ran — a lie written into a
-- column this product treats as audit history and compares against.
--
-- ON RANGE, recorded because it is the one honest cost of keeping `numeric(12, 3)` (which
-- PK-67 requires, correctly, on the precision argument: three decimals of a gram is finer
-- than three decimals of any imperial unit, so nothing entered in oz or lb loses precision
-- by moving to grams). Multiplying by up to 453.59237 narrows the largest STORABLE weight
-- by the same factor: the column tops out near 1e9, so a row holding more than about
-- 2,204,622 lb cannot be converted and this statement would abort with a numeric overflow.
-- That is 1,100 tons of backpacking gear. It is left to fail loudly rather than guarded,
-- because the transaction aborts cleanly and leaves nothing half-applied, and because any
-- row that large is data corruption worth stopping a deploy for rather than rounding down.
alter table public.gear_items disable trigger gear_items_set_updated_at;

update public.gear_items
   set weight = weight * case weight_unit
                           when 'g' then 1
                           when 'kg' then 1000
                           when 'oz' then 28.349523125
                           when 'lb' then 453.59237
                         end;

alter table public.gear_items enable trigger gear_items_set_updated_at;

-- ---------------------------------------------------------------------------
-- 5 and 6. The unit goes, and the column takes its name
-- ---------------------------------------------------------------------------
--
-- The rename is the point of the exercise rather than tidiness. A column called `weight`
-- holding grams is a column every reader has to remember something about, and the memory
-- is exactly what the old design had `weight_unit` sitting next to it to avoid needing. A
-- column called `weight_grams` states its unit at every call site that names it, including
-- the ones nobody has written yet — and, usefully, it is the same name `GEAR_SELECT` and
-- the generated types already used for the derived column, so a query that forgets to
-- follow the change fails at `tsc` rather than at request time.
alter table public.gear_items
  drop column weight_unit;

alter table public.gear_items
  rename column weight to weight_grams;

comment on column public.gear_items.weight_grams is
  'The item''s weight in grams — canonical at rest since PK-67, which moved the unit from a per-item column to one account-level metric/imperial setting (public.profiles.weight_units). The name states the unit so no reader has to remember it. Was `weight` + `weight_unit`, "stored as entered", until the form stopped offering a per-item unit to be faithful to; the migration that changed it argues the reversal in full. Display units are derived from this figure and the account setting by formatWeight() in src/lib/units.ts — conversion and totalling remain pure application functions (Ref 23), not database concerns.';

-- The table comment is restated rather than left alone only because its neighbour above
-- now describes a column that did not exist when it was written; the sentence itself is
-- unchanged from core_schema.sql, with the storage note appended.
comment on table public.gear_items is
  'The gear closet: the master record for a piece of gear. Pack items reference these rows, never copy them. Weight is stored in grams (PK-67); the unit a visitor sees is derived from their account setting at render time.';
