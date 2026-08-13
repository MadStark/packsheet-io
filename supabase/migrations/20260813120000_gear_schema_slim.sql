-- Slim public.gear_items (PK-61): drop volume_litres, add acquired_on.
--
-- Two changes, and the order between them is the entire point of this file.

-- ---------------------------------------------------------------------------
-- Why the function is replaced BEFORE the column is dropped
-- ---------------------------------------------------------------------------
--
-- private.gear_item_snapshot(public.gear_items) (core_schema.sql:362-387) is `language
-- sql`, and its body is a quoted string Postgres does not parse at CREATE time — it is
-- opaque text until the function actually runs. That is exactly why ordinary column
-- dependency tracking does not see the reference to `item.volume_litres` inside it: a
-- generated column or a view referencing a table column registers a pg_depend entry that
-- blocks a DROP COLUMN outright, but a SQL-language function's body does not, because
-- Postgres never looked inside it to find the reference.
--
-- Concretely, `alter table public.gear_items drop column volume_litres;` run FIRST would
-- succeed without warning, and the break would surface only the next time something
-- fired gear_items_snapshot_before_delete (core_schema.sql:437-439) or the pack-lock
-- freeze — i.e. the first time a user deleted a gear item or locked a pack after the
-- deploy — as a runtime `column "volume_litres" does not exist` from inside a trigger,
-- on a table that by then had no such column to fix the error by re-adding. Replacing
-- the function first means the column is never, even briefly, referenced by a function
-- body that expects it to exist.
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
-- a schema change that postdates it. Nothing in this database holds any rows today, so
-- there is no snapshot anywhere carrying the key — but the reasoning holds independent
-- of that, and will still hold once real packs exist.

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
-- "not provided means null" treatment `price`, `currency`, `url` and `brand` already get
-- on this table (core_schema.sql:76-92) — none of them default to a manufactured value
-- either. A `default current_date` would additionally corrupt every row backfilled by
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
update public.gear_items
   set acquired_on = created_at::date;

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
