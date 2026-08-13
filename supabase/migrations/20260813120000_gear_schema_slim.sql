-- Slim public.gear_items (PK-61): drop volume_litres, add acquired_on.
--
-- Two changes, and the relationship between the function and the column is what most of
-- the commentary below is about. Read the "what the ordering does and does not buy"
-- note at the end of the next section before concluding the order is load-bearing on
-- its own — it is more defensible than that, and less dramatic.

-- ---------------------------------------------------------------------------
-- Why the function is replaced BEFORE the column is dropped
-- ---------------------------------------------------------------------------
--
-- private.gear_item_snapshot(public.gear_items) (core_schema.sql:362-387) is `language
-- sql`, and Postgres records no dependency on `item.volume_litres` from inside its body
-- the way it would for a generated column or a view. It is tempting to explain that as
-- "the body is opaque text Postgres never parses" — that is not what is actually
-- happening. `check_function_bodies` defaults to `on`, and under that setting a
-- string-bodied `language sql` function IS parsed and validated at CREATE time: point
-- this function's body at a column that genuinely does not exist and `create or replace
-- function` fails immediately, right there, not later at call time. The real reason
-- `DROP COLUMN` is not blocked is narrower than "never parsed": having parsed the body
-- once to validate it, Postgres THROWS THE PARSE TREE AWAY afterwards and keeps only the
-- function's source text. No `pg_depend` entry is ever recorded tying the function to
-- the columns its body happens to mention, so there is nothing for a later `DROP COLUMN`
-- to consult — plain SQL-language function bodies were simply never wired into
-- dependency tracking, independent of whether or when the body gets parsed.
--
-- (Naming the rejected alternative, so nobody "fixes" this by reaching for it later: a
-- `begin atomic ... end` body, PG14+, IS dependency-tracked the way a view is — Postgres
-- keeps that parse tree, `pg_depend` gains real entries, and a `DROP COLUMN` on a column
-- such a body still referenced fails loudly with a dependency error instead of
-- succeeding silently. Not used here, because the entire point of this migration is to
-- make the drop succeed, not to make it fail safely — a `begin atomic` body would only
-- turn this file's careful ordering into a hard error at the `drop column` statement.)
--
-- Concretely, `alter table public.gear_items drop column volume_litres;` run FIRST would
-- succeed without warning. The break would not be immediate, either: both freeze paths —
-- gear_items_snapshot_before_delete (core_schema.sql:437-439) and the pack-lock freeze
-- (core_schema.sql:482-483) — call this function only from inside an `update ...
-- set snapshot = private.gear_item_snapshot(...) where ...`, and an UPDATE's SET
-- expression is evaluated per matched row, not once at plan time; `set search_path = ''`
-- on the function additionally rules out the planner inlining it into the scan. So a
-- gear delete or a pack lock with no matching, still-unfrozen `pack_items` row runs this
-- update, matches nothing, and the function is never invoked at all — nothing fails at
-- deploy time, or the first time ANY gear item is deleted or ANY pack is locked. The
-- break is scoped to exactly the row that needs the function: deleting gear that sits on
-- a pack with an unfrozen pack_items row (`snapshot is null` — one that has not already
-- been frozen by an earlier lock or an earlier delete of a different gear item on the
-- same pack). That makes the latent bug LATER and MORE SURPRISING than "breaks on the
-- next delete", not less dangerous — it can sit unnoticed through any number of deploys,
-- deletes and lock events that never happen to hit the one row shape that evaluates the
-- function, and then fail on a delete that looks routine, arbitrarily far downstream of
-- the migration that actually caused it. That gap between cause and symptom is the
-- strongest argument for the ordering here, not a weaker one.
--
-- The failure itself, reproduced rather than guessed at, is not the legible `column
-- "volume_litres" does not exist` a reader might expect. Once the column is dropped,
-- `item` inside the function body is no longer a value of composite type
-- `public.gear_items` with a `volume_litres` attribute — the attribute is simply gone
-- from the type — so Postgres reparses `item.volume_litres` under its OTHER grammar for
-- a dotted name, `table.column`, and fails looking for a FROM-clause entry named `item`:
--
--   ERROR:  missing FROM-clause entry for table "item"
--   CONTEXT: SQL function "gear_item_snapshot" during startup
--
-- raised from inside the trigger, on a table that by then has no `volume_litres` column
-- to fix the error by re-adding.
--
-- WHAT THE ORDERING DOES AND DOES NOT BUY — stated honestly, because the obvious reading
-- of everything above is "get this order wrong and you ship the bug", and that is not
-- true of THIS file. Both statements live in one migration, and the Supabase CLI applies
-- each migration file inside a transaction, so the two orders commit an identical end
-- state and no other session ever observes the intermediate one. Drop-then-replace would
-- work here too. What the failure mode above actually describes is the state this file
-- would leave behind if the drop shipped WITHOUT the replacement — a separate migration,
-- an aborted edit, a cherry-pick that took one statement and not the other — and that is
-- worth writing down whichever order the two statements end up in, because it is the
-- reason they must never be separated.
--
-- The honest counter-argument, recorded rather than buried: drop-FIRST would be
-- marginally safer, precisely because of the `check_function_bodies` behaviour described
-- above. With the column already gone, `create or replace function` validates the new
-- body against the post-drop table, so a replacement that still mentioned
-- `volume_litres` — the exact mistake this whole section frets about — would fail loudly
-- at migration time instead of committing. Replace-first validates the new body against
-- the OLD shape, where either version parses cleanly. Kept as replace-first anyway, for
-- one reason: it is the order that stays correct if these statements are ever applied
-- non-transactionally or split apart, which is the failure this file is actually
-- defending against. The validation benefit is real but only pays out against a typo the
-- test suite already catches — tests/gear-closet.test.ts hard-deletes gear through the
-- real mutation, firing the freeze trigger, so a stale body fails CI either way.
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
    'photo_path', item.photo_path,
    'gear_item_id', item.id,
    'captured_at', now()
  );
$$;

grant execute on function private.gear_item_snapshot(public.gear_items)
  to authenticated, service_role;

comment on function private.gear_item_snapshot(public.gear_items) is
  'The frozen form of a gear item, as written into pack_items.snapshot. Used by both freeze paths — pack locking and gear deletion — so the two cannot drift.';

-- Pre-existing frozen rows are untouched, and that is correct rather than an oversight.
-- Any pack_items.snapshot already written before this migration keeps whatever keys
-- gear_item_snapshot() wrote at the time it froze, `volume_litres` included — a
-- snapshot is historical fact about what the gear looked like at the moment it was
-- captured, not a live projection that should retroactively match today's function
-- definition. Rewriting old snapshots to drop the key would be editing history to match
-- a schema change that postdates it.

-- ---------------------------------------------------------------------------
-- volume_litres — removed
-- ---------------------------------------------------------------------------
--
-- The product no longer models a volume field on gear. The function above no longer
-- reads this column, so this drop is now safe to run.
alter table public.gear_items
  drop column volume_litres;

-- ---------------------------------------------------------------------------
-- acquired_on — the user's own claim about when they got the item
-- ---------------------------------------------------------------------------
--
-- Why this is a new column rather than simply letting the client write created_at:
-- public.set_row_timestamps() (core_schema.sql:631-649) is a BEFORE INSERT trigger that
-- unconditionally sets `new.created_at = now()` and does not consult what the client
-- sent — by design, per that migration's own comment, so `created_at` stays unforgeable
-- audit history rather than a client-supplied value optimistic-concurrency logic could
-- be fooled by. That trigger is attached to FOUR tables (gear_items, packs,
-- pack_categories, pack_items), all sharing the one function, so relaxing it for
-- gear_items alone would mean either forking the trigger function or relaxing the
-- guarantee everywhere at once — neither of which this ticket asks for. `created_at`
-- keeps answering "when was this row created in the database"; `acquired_on` answers a
-- different question, "when did the user get this piece of gear", which is a fact about
-- the physical item and is under the user's own editorial control precisely because
-- created_at cannot be.
--
-- Nullable, with NO default — not `not null default current_date`. "When I got this" is
-- genuinely unknown for plenty of real gear (hand-me-downs, gifts, things bought so long
-- ago the date is simply lost), and the product treats an empty date box as "I don't
-- know" rather than silently substituting today's date as a guess. That is the same
-- "not provided means null" treatment `brand` (core_schema.sql:56), and `price`,
-- `currency` and `url` (core_schema.sql:76-92) already get on this table — none of them
-- default to a manufactured value either. A `default current_date` would additionally
-- corrupt every row backfilled by
-- the update below the moment this migration ran, which is precisely what the backfill
-- exists to avoid — see the next section.
alter table public.gear_items
  add column acquired_on date;

-- Backfill as a separate, explicit UPDATE — never as a column default. `add column
-- acquired_on date not null default current_date` would apply the DEFAULT to every
-- existing row too, stamping every piece of gear already in the closet with the date
-- this migration happened to run, discarding forever the fact that it was acquired
-- months or years earlier. Existing rows do have a real date worth keeping: created_at,
-- which is when the gear was first entered into the closet. It is not a perfect proxy
-- for "when the user got the item" — someone could easily be backfilling gear they
-- bought long before signing up — but it is a strictly better default than "today" for
-- every row that already exists, and it costs nothing: acquired_on stays user-editable
-- afterwards, so anyone for whom created_at guesses wrong can simply correct it.
--
-- THE TRIGGER IS SUPPRESSED FOR THIS ONE STATEMENT, DELIBERATELY. `gear_items` carries a
-- BEFORE UPDATE trigger, `gear_items_set_updated_at` (core_schema.sql:663-665), running
-- `public.set_updated_at()` (baseline.sql), which unconditionally sets `new.updated_at =
-- now()` on every UPDATE regardless of which columns actually changed. Left enabled, the
-- bare backfill below would silently stamp `updated_at = now()` on every existing gear
-- row — claiming, in a column this product treats as meaningful audit history (see
-- `src/lib/gear/mutations.ts`'s `restoreFromTrash`, whose own `.not('deleted_at',
-- 'is', null)` guard exists for the identical reason: gratuitous `updated_at` churn is a
-- defect here, not a shrug), that a human edited every one of these rows just now. No
-- user touched anything; this is a one-time migration backfilling a value from data the
-- row already carried, and letting the trigger fire would write a lie into a column
-- optimistic-concurrency logic elsewhere in this codebase compares against. Disabling
-- the trigger for the duration of this one statement and re-enabling it immediately
-- afterwards keeps every OTHER write against this table — including any that happen to
-- run concurrently with this migration — fully covered by the ordinary guarantee.
--
-- `where acquired_on is null` IS NOT REDUNDANT with "this only runs once at migration
-- time" — it is what makes the statement safe to replay. A migration that has already
-- applied is not supposed to run twice, but this file has no way to guarantee a manual
-- re-run, a botched migration-history repair, or a future copy-paste never happens; the
-- guard means a replay touches only rows that still have no `acquired_on` (freshly
-- inserted rows created after the first run, say, that a broken migration-tracking setup
-- let this statement see again) rather than unconditionally overwriting a value a user
-- has since edited by hand with a now-stale `created_at::date`. An idempotent backfill
-- costs nothing here and forecloses an entire class of "the replay clobbered real user
-- edits" incident.
--
-- `at time zone 'utc'` IS LOAD-BEARING, NOT DECORATION. `created_at` is `timestamptz`,
-- and a bare `created_at::date` resolves the calendar day using the SESSION's TimeZone
-- setting — so the same row backfills to two different dates depending on who ran the
-- migration and from where:
--
--     set timezone='America/New_York';  select '2026-01-01T02:30:00Z'::timestamptz::date;
--       -->  2025-12-31
--     set timezone='UTC';               select '2026-01-01T02:30:00Z'::timestamptz::date;
--       -->  2026-01-01
--
-- Every row created in the early-UTC hours would be backfilled a day early under a
-- non-UTC session. Both this project's local stack and its hosted projects run UTC
-- today, so the bare cast would have produced the right answer — which is exactly what
-- makes it the dangerous kind of bug: correct on every machine anybody checked, wrong
-- the first time a migration is applied from a session that happens to carry a different
-- TimeZone, and silent when it is. Anchoring to UTC explicitly makes the result a
-- property of the data rather than of whoever ran the migration.
alter table public.gear_items disable trigger gear_items_set_updated_at;

update public.gear_items
   set acquired_on = (created_at at time zone 'utc')::date
 where acquired_on is null;

alter table public.gear_items enable trigger gear_items_set_updated_at;

comment on column public.gear_items.acquired_on is
  'When the user says they acquired this item. Nullable with no default, unlike created_at (which set_row_timestamps() stamps unconditionally and truthfully): an empty value here means "I don''t know", not "today". Existing rows are backfilled once, at migration time, from created_at as the best available guess — the column remains freely user-editable afterwards.';

-- ---------------------------------------------------------------------------
-- Deliberately no new index
-- ---------------------------------------------------------------------------
--
-- Same reasoning as the "Deliberately no new indexes" section of
-- 20260813000000_gear_closet.sql, extended to this column rather than repeated from
-- scratch: gear_items already carries a unique (user_id, id) btree with user_id
-- leading, which already answers every owner-scoped list this table serves, and a
-- per-user gear closet is bounded in practice at a few hundred rows — sorting or
-- filtering that set by acquired_on is trivial work for Postgres without a dedicated
-- index. A speculative index here would be pure write amplification on a table
-- core_schema.sql already identifies as one of the two hottest in this schema.
--
-- No grant change either: the four table-level grants in core_schema.sql are
-- column-agnostic and already cover this column, dropped or added, exactly as
-- 20260813000000_gear_closet.sql notes for its own three columns.
