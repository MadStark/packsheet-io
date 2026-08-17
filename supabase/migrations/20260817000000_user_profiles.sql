-- The user's profile and settings record (PK-67).
--
-- This is the first per-user preference storage in the product. Until now `auth.users`
-- was the only thing that knew a user existed, and everything in `public` was something
-- they OWNED — gear, packs, categories, pack items — rather than something they ARE.
-- `/account` could offer sign-out and account deletion and nothing else, because there
-- was nowhere to put an answer to a question about the person.
--
-- ---------------------------------------------------------------------------
-- WHY THIS IS `profiles` AND NOT `weight_units`
-- ---------------------------------------------------------------------------
--
-- One column ships today — `weight_units` — and naming the table after it would be the
-- smaller, more honest-looking choice. It is the wrong one, and the reason is worth
-- stating before the column list rather than discovering later.
--
-- The nickname, home country, gender and tagline this product already knows it wants are
-- all facts about the same person, keyed by the same `user_id`, read on the same page,
-- and written by the same upsert. A `weight_units` table would take the first of them and
-- force a choice between two bad answers: add a `nickname` column to a table whose name
-- says it holds units, or create a second one-row-per-user table and start a collection of
-- them — at which point every page that wants two facts about a user issues two queries,
-- and "which of these tables does that field live in" becomes a thing to remember.
--
-- So the table is named for the row it holds, not for the one column it holds today.
-- That is a claim about what goes in it later, and it is deliberately recorded in the
-- table comment as well as here so it survives being read from `\d+` rather than from
-- this file.
--
-- ---------------------------------------------------------------------------
-- WHY `public`, WHICH IS A SCHEMA NAME AND NOT A VISIBILITY
-- ---------------------------------------------------------------------------
--
-- Nothing about this table is public. It is a private settings record and the grants
-- below give `anon` nothing at all. `public` is simply the schema PostgREST serves —
-- `supabase/config.toml` sets `schemas = ["public", "graphql_public"]` — so a table the
-- account page must read and write over the Data API has to live there. There is no
-- version of this feature where it lives in `private`, for the same reason
-- `20260811000000_account_deletion.sql` gives for `delete_own_account()`: `private` is
-- for helpers called BY other database code, and this is a row a client reads.
--
-- What makes that safe is the RLS policies and the revoke/grant block at the bottom of
-- this file, both of which are mandatory rather than diligent — the README's
-- "Authorization" section states the rule that a new table enables RLS and re-grants from
-- zero IN THE MIGRATION THAT CREATES IT, and `tests/rls-enabled.test.ts` enforces it
-- across every table in `public` rather than leaving it to review.

create table public.profiles (
  -- The primary key IS the user id, rather than a surrogate `id uuid` with a separate
  -- unique constraint on `user_id`. This table is one row per user by definition — not
  -- "usually one row", not "one row until some feature wants two" — and a primary key is
  -- the way to say that such that no code path can violate it. The four existing tables
  -- all carry their own `id` because they are collections a user owns many of; this is
  -- not one of those, and giving it a surrogate key would model it as though it were.
  --
  -- `on delete cascade` mirrors every other user-owned table here. It is not what
  -- actually removes the row on account deletion — `delete_own_account()` names this
  -- table explicitly below, for the referential-integrity reason that function's own
  -- comment sets out — but it is what guarantees no orphan can outlive its user if a row
  -- is ever removed by some other path (a deletion run from the dashboard, say).
  --
  -- `default auth.uid()` for the same reason `gear_items.user_id` carries one
  -- (core_schema.sql:53): defaulted from the JWT rather than sent by the client, with the
  -- insert policy checking the same value, so a client that sends someone else's id is
  -- refused rather than quietly corrected while a client that sends nothing gets the right
  -- answer. `saveWeightSystem` sends it explicitly anyway — an upsert has to name its
  -- conflict target's value — so this default is what makes a PLAIN insert behave like
  -- every other table in this schema rather than failing on a missing primary key.
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,

  -- Two values, not four. The four members of `WEIGHT_UNITS` in `src/lib/units.ts` are
  -- what a weight can be DISPLAYED in; this column is which SYSTEM the account thinks in,
  -- and the display unit is then derived from the magnitude (see `formatWeight` there).
  -- Storing `'kg'` here would be a category error: somebody who thinks in metric wants
  -- grams for a tent peg and kilograms for a pack, and no single one of the four unit
  -- names answers "what does this person use".
  --
  -- Constrained rather than left open, and defaulted rather than nullable, for the same
  -- reason `gear_items.status` is (core_schema.sql:104): an unconstrained text column
  -- becomes a de-facto enum with typos in it, and a nullable one makes every reader
  -- decide what null means. Extending this list is a one-line constraint change with no
  -- data migration.
  weight_units text not null default 'metric' check (weight_units in ('metric', 'imperial')),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.profiles is
  'The user''s profile and settings record — one row per user, keyed by user_id. Named for the row rather than for the single column it holds today (weight_units): nickname, home country, gender and tagline are expected to land here, and a weight_units table would force each of them into either a misnamed home or a second one-row-per-user table. A MISSING ROW IS NOT AN ERROR — it means every setting is at its default, which is why no trigger on auth.users creates one and no backfill exists. Private despite the schema name: anon holds nothing on this table.';

comment on column public.profiles.weight_units is
  'Which system the account thinks in: metric (g, kg) or imperial (oz, lb). NOT one of the four WEIGHT_UNITS in src/lib/units.ts — those are display units chosen per weight by magnitude, derived from this. Absent row means ''metric''.';

-- ---------------------------------------------------------------------------
-- A MISSING ROW MEANS THE DEFAULT — no trigger, no backfill
-- ---------------------------------------------------------------------------
--
-- The obvious way to guarantee every user has a profile is an AFTER INSERT trigger on
-- `auth.users` that creates one, plus a one-time backfill for the accounts that already
-- exist. This migration deliberately does neither, and the reason is not laziness about
-- the backfill — it is that the trigger buys nothing and costs something real.
--
-- Reading treats absence as `'metric'` and saving upserts, so a user with no row and a
-- user with a row saying `'metric'` are indistinguishable to every caller. Given that,
-- the trigger's only effect would be to write a row stating the default that the absence
-- of a row already states. What it would cost is a trigger this project owns on a table
-- it does not — `auth.users` belongs to GoTrue — which is a dependency on another
-- system's schema that has to survive every one of its upgrades, in exchange for nothing
-- a reader can observe.
--
-- The backfill is skipped for the same reason and one more: there is nothing to fill.
-- Every existing account's preference is `'metric'`, because that is what a missing row
-- means, and inserting a row per user to record it would be writing the default down.
-- This is the whole reason this half of PK-67 needs no data migration at all, in a ticket
-- whose other half needs a careful one.
--
-- The consequence to hold onto: `select ... from profiles where user_id = $1` legitimately
-- returns zero rows, so every read path must use `maybeSingle()` and coalesce, never
-- `single()`. `src/lib/profile.ts` is the one place that happens.

alter table public.profiles enable row level security;

-- The timestamp triggers, both of them, for the reasons core_schema.sql:620-645 gives:
-- `updated_at` is what optimistic concurrency compares against, so a client that can
-- choose the value can make a stale write look fresh — and a DEFAULT does not carry that
-- argument to INSERT, because a default only supplies what the client omitted while the
-- columns are granted to `authenticated` like any other.
--
-- This matters more here than on the tables it was written for. Saving a preference is an
-- UPSERT, so the INSERT path is taken on the very first save of every account that ever
-- changes this setting — the exact write the BEFORE INSERT trigger exists to make
-- unforgeable, and the one a table with only an UPDATE trigger would leave open.
create trigger profiles_set_row_timestamps
  before insert on public.profiles
  for each row execute function public.set_row_timestamps();

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Policies — owner-only, and no DELETE policy on purpose
-- ---------------------------------------------------------------------------
--
-- The same three shapes `gear_items` carries (core_schema.sql:875-911), scoped to
-- `user_id = (select auth.uid())` and nothing else. There is no equivalent here of
-- `gear_items_select_via_public_pack`: no row in this table is reachable from a shared
-- pack, because nothing on this table is rendered on the share page today. When a
-- nickname does need to appear there, that is a new policy written deliberately for the
-- one column it exposes — not a widening of these.
--
-- `(select auth.uid())` rather than a bare `auth.uid()`, matching every other policy in
-- this schema: the subselect form is evaluated once per statement rather than once per
-- row.
create policy profiles_select_own on public.profiles
  for select to authenticated
  using (user_id = (select auth.uid()));

-- The insert policy checks the value the column defaults to, so a client that sends
-- someone else's id is refused rather than quietly corrected, while a client that sends
-- nothing still gets the right answer. Same reasoning as gear_items.user_id's default.
create policy profiles_insert_own on public.profiles
  for insert to authenticated
  with check (user_id = (select auth.uid()));

-- Both halves. `using` decides which rows the update can SEE, `with check` decides what
-- they may become — without the second, an owner could reassign their own row to another
-- user_id, which for a table keyed BY user_id would be handing someone else your settings.
create policy profiles_update_own on public.profiles
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- NO DELETE POLICY, and this is a decision rather than an omission. Nothing in the product
-- deletes a profile on its own: there is no "reset my settings" action, and if there were,
-- it would be an UPDATE back to the defaults rather than a delete, because a deleted row
-- and a row holding the defaults already mean the same thing. The only real deletion is
-- the account going away, which `delete_own_account()` performs below with the privilege
-- of a SECURITY DEFINER function, where row-level security does not apply at all — so a
-- delete policy would not be what authorises it even if one existed.
--
-- Withholding the policy is therefore the tighter position at almost no cost. DELETE *is*
-- granted to `authenticated` below, so the privilege exists and it is the absent policy
-- alone that makes every attempted delete match zero rows.
--
-- THAT GRANT IS NOT FORCED ON US, and this comment previously claimed otherwise — it cited
-- core_schema.sql:965 as though PostgREST needed it. That passage is about COLUMN-level
-- SELECT grants breaking an embed, which is a different problem: nothing in PostgREST
-- requires a DELETE grant, and `profiles` participates in no embed at all (no foreign key
-- points at it). The grant is here for symmetry with the other five tables, and so that a
-- future "reset my settings" action is a policy change rather than a migration. If that
-- symmetry is ever worth less than the belt, drop `delete` from the grant below — nothing
-- depends on it, `delete_own_account()` least of all, since a SECURITY DEFINER function
-- does not run under these privileges.

-- ---------------------------------------------------------------------------
-- Grants — REVOKE first, then grant back by name
-- ---------------------------------------------------------------------------
--
-- Not boilerplate. Postgres hands `anon` TRUNCATE, REFERENCES, TRIGGER and MAINTAIN by
-- default on a table owned by `postgres`, and ROW-LEVEL SECURITY DOES NOT APPLY TO
-- TRUNCATE — no policy above can stop it. That is the hole core_schema.sql:916-946
-- documents having reproduced on this very schema, and the reason the rule is "revoke,
-- then grant by name" rather than "grant what you need".
--
-- Both hosted projects additionally carry `alter default privileges ... grant all on
-- tables to anon, authenticated, service_role` for two separate grantors, per
-- 20260811120000_public_grant_hardening.sql — so on those projects this table is born
-- with a full anon grant in its ACL, not merely with the four defaults. The revoke below
-- is what removes it. Locally that statement is closer to a no-op; the difference between
-- the two environments is exactly the difference PK-57 existed to close.
revoke all on public.profiles from anon, authenticated, service_role;

-- `anon` IS GRANTED NOTHING. Deliberately not "granted select and protected by policy":
-- an absent grant and a revoked one are different from a policy that returns zero rows,
-- because the grant is what a future permissive policy could not accidentally widen. This
-- is the same position 20260811120000_public_grant_hardening.sql takes for the schema as a
-- whole, applied to the first table created since it.
--
-- WHEN A FIELD HERE DOES BECOME PUBLIC — a nickname shown beside a shared pack is the
-- obvious first one — that is a deliberate revisit of this line and not a formality. The
-- shape to reach for is the one core_schema.sql:977-981 already names for the identical
-- problem on `gear_items`: a `security_invoker` view exposing only the public columns,
-- with `anon` granted select on the view rather than on this table. Granting `anon` select
-- here and relying on a policy to hide the rest would expose every column of the row to
-- anyone holding the publishable key the moment a policy is written slightly too wide,
-- and this table is designed to grow columns (gender, home country) that must never be on
-- that surface. Leaving the door shut now costs nothing; opening it now would be opening
-- it for fields that do not exist yet.
grant select, insert, update, delete on public.profiles to authenticated;

-- service_role bypasses RLS but holds no privilege on this table once the revoke above has
-- run, so it is granted back by name for the same reason core_schema.sql:997-1002 grants
-- it on the other four: nothing in this product uses a service-role key (src/lib/auth's
-- doc comment explains why this project decided never to hold one), but a table that
-- silently refuses the role is a debugging trap for whoever first needs the dashboard.
grant select, insert, update, delete on public.profiles to service_role;

-- ---------------------------------------------------------------------------
-- delete_own_account() — five tables becomes six
-- ---------------------------------------------------------------------------
--
-- 20260811000000_account_deletion.sql deletes from five tables BY NAME rather than letting
-- the `auth.users` cascade do it, and its "WHY THIS DELETES FIVE TABLES BY NAME" comment
-- reproduces the referential-integrity race that forced it: two cascades descending from
-- one `auth.users` delete, interleaved inside a single statement, with a deferred FK check
-- firing against a parent another cascade has already removed. That argument is not
-- repeated here — read it there — but its CONCLUSION binds this table: every user-owned
-- table is deleted by name, in its own top-level statement, leaf to root.
--
-- `public.profiles` has no children and no table references it, so it is a leaf, and it
-- could correctly go anywhere before the `auth.users` delete. It is placed last among the
-- five that precede that delete rather than first, purely so the existing order is
-- untouched and the diff against the original function is one added line.
--
-- IT IS ADDED EVEN THOUGH THE CASCADE WOULD COVER IT, which is worth saying plainly
-- because this table's own `on delete cascade` makes the extra statement look redundant.
-- It is redundant in the same way the other five are, and for the same reason: the
-- function's guarantee is "this deletes the caller's data by name, and nothing another
-- user owns", and a table missing from the list is one whose removal depends on a cascade
-- firing correctly inside the exact statement the original comment demonstrates cannot be
-- trusted to interleave cascades safely. Adding profiles to that list keeps the guarantee
-- total rather than "total except for the newest table".
create or replace function public.delete_own_account()
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.pack_items where user_id = (select auth.uid());
  delete from public.pack_categories where user_id = (select auth.uid());
  delete from public.packs where user_id = (select auth.uid());
  delete from public.gear_items where user_id = (select auth.uid());
  delete from public.profiles where user_id = (select auth.uid());
  delete from auth.users where id = (select auth.uid());
$$;

comment on function public.delete_own_account() is
  'Deletes every row the calling user owns — pack_items, pack_categories, packs, gear_items, profiles, then the auth.users row itself, in that leaf-to-root order — and nothing another user owns. Takes no arguments: auth.uid() is the only identity it can ever act on. SECURITY DEFINER because ordinary policies on our own tables cannot express deleting the identity itself, and because authenticated holds no privilege on auth.users at all. Deletes six tables by name rather than relying on auth.users cascading them, because letting Postgres interleave the gear_items and packs cascades from one statement hits a referential-integrity race — see the comment above the function in 20260811000000_account_deletion.sql for the reproduction. Callable only by authenticated; see the revoke/grant immediately below.';

-- `create or replace function` PRESERVES the existing ACL, so the revoke and grant from
-- 20260811000000_account_deletion.sql still hold and re-stating them is belt and braces
-- against a future edit that reaches for `drop function` and `create` instead — which does
-- NOT preserve the ACL, and would hand `PUBLIC` execute on a SECURITY DEFINER function.
--
-- `anon` IS NAMED, and that is not redundant with `from public`.
-- `20260811120000_public_grant_hardening.sql` is the whole story: both hosted projects
-- carry `alter default privileges ... grant execute on functions to anon, authenticated,
-- service_role` for two separate grantors, so a function there is born with `anon=X`
-- ALREADY IN ITS ACL, alongside the built-in PUBLIC grant. Revoking PUBLIC leaves that
-- named grant untouched — two grants, one revoke — which is exactly the hole PK-57 was
-- filed for. `tests/migration-hygiene.test.ts` enforces the by-name revoke on every
-- function any migration creates or replaces in `public`, and it enforces it PER FILE
-- rather than per corpus, precisely so that a file re-creating an existing function cannot
-- inherit its safety from a migration that ran earlier.
revoke all on function public.delete_own_account() from public, anon;
grant execute on function public.delete_own_account() to authenticated;
