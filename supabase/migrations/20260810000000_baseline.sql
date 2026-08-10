-- Baseline migration.
--
-- Deliberately not the core schema. Packs, gear items, categories and their RLS
-- policies belong to the tickets that design them; this migration exists to make the
-- pipeline real — a migration written here runs, in order, against a clean database,
-- in both hosted projects, from CI — before any schema depends on that being true.
--
-- What it does contain is the two pieces of groundwork every later migration would
-- otherwise each re-invent slightly differently.

-- ---------------------------------------------------------------------------
-- citext
-- ---------------------------------------------------------------------------
-- Case-insensitive text, for the columns where "Antoine@example.com" and
-- "antoine@example.com" are the same value and a UNIQUE constraint has to agree:
-- emails, and share slugs, where /p/Ultralight and /p/ultralight must not become two
-- different packs.
--
-- Into `extensions`, not `public`. Supabase exposes `public` through PostgREST, so an
-- extension installed there puts its functions on the Data API surface for `anon`.
-- `extensions` is in the search_path of every request (see [api] extra_search_path in
-- config.toml), so `citext` resolves unqualified anyway.
create extension if not exists citext with schema extensions;

-- ---------------------------------------------------------------------------
-- set_updated_at()
-- ---------------------------------------------------------------------------
-- The trigger behind every `updated_at` column this project will have.
--
-- It is a trigger rather than a default because a default only fires on INSERT, and
-- it is server-side rather than set by the application because `updated_at` is what
-- optimistic concurrency will compare against: a client that can choose the value can
-- choose one that makes its own stale write look fresh. Conflict detection is a
-- separate ticket, but it will rest on this column being unforgeable, so the column
-- is unforgeable from the first migration rather than retrofitted later.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
-- SECURITY INVOKER — the default, stated because the alternative is dangerous here.
-- A DEFINER function attached to a table trigger runs as its owner and would bypass
-- the RLS policies that are meant to be this project's authorization boundary.
security invoker
-- Empty search_path, every reference schema-qualified. Without this, whoever fires
-- the trigger controls name resolution inside it, and Supabase's own linter flags it
-- (`function_search_path_mutable`). `pg_catalog` is always searched, so `now()` and
-- the `trigger` return type still resolve.
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

comment on function public.set_updated_at() is
  'BEFORE UPDATE trigger: stamps updated_at with the transaction timestamp. Attach to every table with an updated_at column; never set that column from the client.';
