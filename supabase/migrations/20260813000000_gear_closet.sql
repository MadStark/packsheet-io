-- The gear closet (Ref 4, PK-4): quantity owned, soft delete, and a comparable weight.
--
-- Three columns on public.gear_items, and nothing else. No new table, no new function
-- (a function created in `public` needs the revoke-from-anon dance migration-hygiene.
-- test.ts enforces, and none of this needs one), no policy or grant change — the four
-- table-level grants in 20260810120000_core_schema.sql are column-agnostic and already
-- cover whatever columns the table happens to have.

-- ---------------------------------------------------------------------------
-- quantity — how many I own
-- ---------------------------------------------------------------------------
--
-- Deliberately named the same as pack_items.quantity and deliberately a different
-- number. pack_items.quantity is how many of this gear are carried on ONE trip's pack;
-- this column is how many the closet holds in total, independent of any pack. A user
-- who owns three identical stuff sacks and carries two of them on a given trip needs
-- both numbers, and they are allowed to disagree — carrying fewer than owned is the
-- ordinary case, not an error condition, so there is no cross-table check tying them
-- together.
alter table public.gear_items
  add column quantity integer not null default 1 check (quantity > 0);

comment on column public.gear_items.quantity is
  'How many of this item the closet holds. Distinct from pack_items.quantity, which is how many are carried on a given trip — the two are independent and are allowed to disagree.';

-- ---------------------------------------------------------------------------
-- deleted_at — soft delete
-- ---------------------------------------------------------------------------
--
-- A soft delete, not a hard DELETE with a client-side "undo" that re-inserts the row.
-- That looks like the simpler design and is wrong for three separate reasons, each
-- sufficient on its own:
--
--   1. public.set_row_timestamps() is a BEFORE INSERT trigger that unconditionally
--      sets `created_at = now()` (see core_schema.sql:617-661). A row re-inserted to
--      "undo" a delete would silently get today's date as its date added, discarding
--      the original one — and "sort by date added" is a feature this same ticket asks
--      for. There is no way to re-insert a row and keep its created_at; the trigger
--      does not consult what the client sends.
--
--   2. gear_items_snapshot_before_delete (core_schema.sql:437-439) fires on every
--      DELETE and freezes the row into any pack_items that reference it, nulling their
--      gear_item_id (rule 3 of that migration's header). That freeze is irreversible by
--      design — it is what lets a pack survive its gear being deleted — so a hard
--      delete can never be walked back once a pack references the gear. Ref 37 (pack
--      composition) makes that reachable from ordinary use, not just a hypothetical.
--
--   3. Trash/undo needs the row to still exist somewhere the owner's session can find
--      it by id. A hard delete followed by a re-insert is a NEW row with a new
--      relationship to everything else — same name and weight, but its id, created_at
--      and any pack reference are all gone. There is nothing to "undo" back to.
--
-- A soft delete sidesteps all three: the id, created_at and every pack_items reference
-- survive untouched, because nothing was ever removed. Clearing deleted_at is a plain
-- UPDATE, which is exactly the operation the owner already has full RLS access to
-- perform on their own row.
--
-- A real DELETE remains reachable — it is what emptying the trash means — and is
-- unchanged by this column. gear_items_snapshot_before_delete still fires exactly as
-- before; deleted_at has no interaction with it and the freeze semantics are identical
-- whether the row being deleted was soft-deleted first or not.
alter table public.gear_items
  add column deleted_at timestamptz;

comment on column public.gear_items.deleted_at is
  'Soft delete. Null means active. Set to move an item to the trash; cleared to undo. A soft delete rather than delete-and-reinsert because set_row_timestamps() would stamp a re-inserted row with a new created_at (breaking sort-by-date-added) and because gear_items_snapshot_before_delete''s freeze into pack_items is irreversible once a pack references the gear (Ref 37) — see the migration comment for the full argument. A real DELETE, reachable by emptying the trash, still fires that trigger exactly as before.';

-- ---------------------------------------------------------------------------
-- weight_grams — a comparable weight, generated from the columns that remain canonical
-- ---------------------------------------------------------------------------
--
-- core_schema.sql:60-72 stores weight as entered, in weight_unit, on purpose — and says
-- explicitly that if a canonical column is ever needed for sorting or aggregation in
-- the database, "it belongs there as a generated column derived from these, not as a
-- replacement for them." This is that column, and it changes nothing about the
-- decision it follows: weight/weight_unit remain the source of truth, entered and
-- displayed exactly as the user typed them. weight_grams exists ONLY so that two rows
-- entered in different units — 4.4 oz and 2 kg — can be compared by the database at
-- all: weight-range filtering and sort-by-weight both need an ORDER BY / WHERE target
-- that means the same thing across every row, and "weight" alone does not, because a
-- bare numeric 4.4 is not comparable to a bare numeric 2000 without knowing which unit
-- each one is in.
--
-- The four factors below are not independently chosen — they are required to be
-- bit-for-bit the same as GRAMS_PER_UNIT in src/lib/units.ts, which computes the
-- identical conversion for every in-memory total (Ref 23). That file's own comment
-- explains why: oz and lb are not approximations, they are the EXACT decimal values
-- fixed by the 1959 international yard-and-pound agreement (1 lb = 0.45359237 kg
-- exactly, 1 oz = 1/16 of that), and rounding them — 28.35 instead of 28.349523125 —
-- makes every imperial total silently wrong by a small, avoidable amount. Do NOT round
-- these, here or anywhere else. tests/gear-closet-schema.test.ts pins the two
-- constants together by comparing this column's computed value against
-- toGrams(weight, weight_unit) for every unit in WEIGHT_UNITS — so a change to either
-- side without the other fails a test rather than silently drifting.
--
-- CASE over weight_unit rather than a lookup join: weight_unit is NOT NULL and
-- constrained to exactly ('g', 'kg', 'oz', 'lb') by the CHECK in core_schema.sql, so
-- the four branches are exhaustive and a fifth unit cannot reach this column without
-- also failing that constraint first — the two are already required to move together.
--
-- GENERATED ... STORED, not a view or a computed-at-read expression: STORED means the
-- value is materialised and recomputed by Postgres itself on every INSERT and UPDATE
-- that touches weight or weight_unit, so a range filter or an ORDER BY on this column
-- can use a plain index scan rather than recomputing the conversion per row, and no
-- application code path can forget to keep it in sync — the database does that,
-- structurally, the same way updated_at is a trigger rather than a client-set value.
-- A generated column also cannot be written directly (Postgres rejects it), which is
-- exactly right here: nothing should ever be able to write a weight_grams value that
-- disagrees with weight/weight_unit.
alter table public.gear_items
  add column weight_grams numeric generated always as (
    case weight_unit
      when 'g' then weight * 1
      when 'kg' then weight * 1000
      when 'oz' then weight * 28.349523125
      when 'lb' then weight * 453.59237
    end
  ) stored;

comment on column public.gear_items.weight_grams is
  'weight converted to grams, so weights entered in different units can be compared (range filtering, sort-by-weight) in SQL. Generated from weight/weight_unit, which remain the source of truth per core_schema.sql:60-72 — this column is derived, never entered. The four factors must stay identical to GRAMS_PER_UNIT in src/lib/units.ts; tests/gear-closet-schema.test.ts pins the two together.';

-- ---------------------------------------------------------------------------
-- Deliberately no new indexes
-- ---------------------------------------------------------------------------
--
-- Same reasoning core_schema.sql:683-693 already gives for this table, extended to the
-- three columns above rather than repeated from scratch. gear_items already carries a
-- unique (user_id, id) btree with user_id leading, so it already answers every
-- owner-scoped list — `where user_id = $1` — that a gear closet view issues, with or
-- without these new columns in the select list or in a WHERE/ORDER BY clause; a btree
-- with user_id leading does not need a second index to be scanned for a given owner.
--
-- A per-user gear closet is bounded in practice at a few hundred rows (nobody owns
-- five figures of backpacking gear), so sorting or filtering that set by quantity,
-- deleted_at, category, status, name or weight_grams inside the rows a single owner
-- already has is trivial work for Postgres without a dedicated index — an in-memory
-- sort over a few hundred rows costs nothing worth indexing against. A speculative
-- index on any of those columns would therefore be pure write amplification on
-- gear_items, which core_schema.sql already identifies as one of the two hottest
-- tables in this schema (packs and gear_items — every edit to either goes through
-- set_row_timestamps() and set_updated_at() on top of the write itself).
--
-- If measurement later shows a real problem — a closet large enough, or a query shape
-- this reasoning did not anticipate — adding the index then is a one-line migration.
-- Nothing here forecloses that; it just declines to guess at it now.

-- No `comment on table` change: the table comment from core_schema.sql still applies
-- unchanged, and none of these columns need a home other than their own `comment on
-- column` above.
