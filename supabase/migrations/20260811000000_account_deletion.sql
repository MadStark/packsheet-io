-- Account deletion that actually deletes.
--
-- Ref 19 / PK-19 is the authentication ticket, and the promise this migration keeps for
-- it is a narrow one: a signed-in user can delete their OWN account, in full, with no
-- service-role key involved anywhere. `src/lib/auth/index.ts` already has the client
-- half — `deleteOwnAccount()` calls `supabase.rpc('delete_own_account')` as the signed-in
-- user's own session — and its own comment explains why that shape was chosen over a
-- service-role client: this project has decided against ever holding one. See "WHAT
-- CHANGED WITH SUPABASE" there for the reasoning; this migration is the other half of
-- the contract that comment describes.
--
-- ---------------------------------------------------------------------------
-- WHY SECURITY DEFINER IS UNAVOIDABLE HERE, NOT A CONVENIENCE
-- ---------------------------------------------------------------------------
--
-- Every write elsewhere in this schema is SECURITY INVOKER: a user deletes their own
-- pack because `packs_delete_own` lets them, evaluated as them. That pattern has no
-- equivalent for this operation, for two independent reasons:
--
--   1. `auth.users` is not a table this project owns or writes policies on — it belongs
--      to GoTrue, and the `authenticated` role has no DELETE privilege on it at all. An
--      ordinary SECURITY INVOKER function would fail with a permissions error before any
--      policy question was even reached.
--
--   2. Row level security on OUR tables cannot express "delete the identity itself".
--      `gear_items`, `packs` and the rest are downstream of a user, deleted by the
--      cascade on their `user_id ... references auth.users (id) on delete cascade` — but
--      that cascade only fires once the `auth.users` row itself is gone. There is no
--      policy to write on `packs` that reaches back and removes the account that owns it.
--
-- So the only place this operation can be expressed is a function that runs with the
-- privilege to delete from `auth.users`, which means SECURITY DEFINER — running as the
-- function's owner rather than its caller. That is a real widening of privilege, and the
-- rest of this migration exists to make it a safe one rather than a bare escalation.
--
-- ---------------------------------------------------------------------------
-- WHAT STOPS THIS BEING A PRIVILEGE-ESCALATION HOLE
-- ---------------------------------------------------------------------------
--
-- The function takes NO ARGUMENTS. That is the whole defence, and it is complete: a
-- caller cannot name a victim, because there is nowhere in the call to put one. The only
-- row this function can ever touch is whichever one `auth.uid()` — read from the caller's
-- own verified JWT, not from anything the caller supplies — resolves to at the moment it
-- runs. Widen the signature to `delete_own_account(target uuid)` and this stops being
-- true; the day someone does that "for convenience", this comment is the warning that it
-- turns a self-service delete into an unauthenticated one.
--
-- ---------------------------------------------------------------------------
-- search_path, PINNED — same requirement as every other definer-adjacent function here
-- ---------------------------------------------------------------------------
--
-- `set search_path = ''` and every reference below fully qualified (`auth.users`,
-- `auth.uid()`), for the reason the core-schema migration gives at
-- `private.gear_item_snapshot()`: a SECURITY DEFINER function with a mutable search_path
-- lets its CALLER decide what an unqualified name resolves to, while the function runs
-- with the DEFINER's privilege. An attacker who could create an object earlier in a
-- writable schema on the search_path could shadow `auth.users` or `auth.uid()` with their
-- own and have this function operate on it instead — with this function's privilege, not
-- theirs. Pinning the search_path and qualifying every name closes that regardless of
-- what any caller's session has done to `search_path`. `tests/rls-enabled.test.ts` asserts
-- this for every SECURITY DEFINER function in `public` and `private`, so a future definer
-- helper that forgets it fails the build rather than shipping quietly.
--
-- ---------------------------------------------------------------------------
-- WHY PUBLIC, NOT PRIVATE — and why that is not the README's helper rule being ignored
-- ---------------------------------------------------------------------------
--
-- README's "Authorization" section says a helper function goes in `private`, not
-- `public`, because `public` is served by PostgREST and a function is created with
-- EXECUTE granted to PUBLIC by default — so a helper written there is an anonymous RPC
-- endpoint the moment it exists. That rule is about helpers: functions that exist to be
-- called BY other database code (triggers, other functions), never directly by a client.
-- `private.gear_item_snapshot()` is exactly that kind of function, and it lives where the
-- rule says.
--
-- This function is not a helper in that sense. It is the API: `src/lib/auth/index.ts`
-- reaches it as `supabase.rpc('delete_own_account')`, over PostgREST, which only routes
-- to `public` and `graphql_public` (see `[api] schemas` in supabase/config.toml). A
-- function that has to be callable as an RPC has to live in a schema PostgREST serves —
-- there is no version of this feature where it lives in `private`. So `public` is correct
-- placement, not an oversight of the rule; what makes it SAFE placement is the grant
-- block below, which is not optional. Putting a SECURITY DEFINER function in `public` and
-- leaving the default PUBLIC execute grant in place would be the exact hole the README's
-- rule exists to prevent — this migration closes it explicitly rather than relying on
-- `private` to close it implicitly.
--
-- ---------------------------------------------------------------------------
-- WHY THIS DELETES FIVE TABLES BY NAME INSTEAD OF ONE `delete from auth.users`
-- ---------------------------------------------------------------------------
--
-- The obvious version of this function is one statement — `delete from auth.users where
-- id = (select auth.uid())` — and it looked correct: `gear_items.user_id` and
-- `packs.user_id` both carry `on delete cascade` back to `auth.users`, so a single delete
-- there should be enough to take a user's whole closet with it. It is also WRONG for any
-- account that owns a pack with an item in it, reproducibly, and the failure is worth
-- recording so nobody "simplifies" this back to the one-liner:
--
--     insert or update on table "pack_items" violates foreign key constraint
--     "pack_items_user_id_pack_category_id_fkey"
--     Key (user_id, pack_category_id)=(...) is not present in table "pack_categories"
--
-- `auth.users` has TWO independent cascading children — `gear_items` and `packs` — and
-- deleting it fires both cascades within the same top-level statement. `packs` cascades
-- further, through `pack_categories`, down to `pack_items`. `gear_items` cascades through
-- its own `on delete` action AND fires the BEFORE DELETE trigger from the core-schema
-- migration (`snapshot_pack_items_on_gear_delete`), which UPDATEs `pack_items` to freeze a
-- snapshot before the reference goes. Postgres's referential-integrity check for the
-- `pack_items -> pack_categories` foreign key is not scoped to the columns an UPDATE
-- touches — confirmed against `pg_trigger` here, where the internal RI trigger carries no
-- column list — and it is deferred to the end of the enclosing statement rather than run
-- inline. So when the `packs` cascade has already removed a `pack_items` row's parent
-- category, but that `pack_items` row itself is still waiting in the SAME statement's
-- queue for the `pack_categories -> pack_items` cascade to remove it too, the `gear_items`
-- cascade's snapshot UPDATE reaches it in between — touching only `snapshot`, not the FK
-- columns — and the deferred check still fires against the now-missing parent. Two
-- cascades from one ancestor, racing inside one statement, is what produces it; deleting
-- from `packs` directly, or from `gear_items` directly, each in their own statement,
-- reproduces no error at all (verified against this database before writing this
-- migration), which is why the bug had nothing to catch it before this ticket: nothing
-- before this function ever deleted an `auth.users` row with a real pack behind it.
--
-- The fix is to stop asking Postgres to interleave two cascades and do the ordering
-- ourselves: five DELETEs, each its own top-level statement, leaf to root. Every
-- referential-integrity check is then resolved at the end of ITS OWN statement, before the
-- next one starts, so there is never a moment where a queued check outlives the row it
-- depends on. `pack_items` first (nothing references it), then `pack_categories`, then
-- `packs`, then `gear_items` — by which point `pack_items` is already gone, so the freeze
-- trigger's UPDATE matches zero rows and never runs — and `auth.users` last, whose own
-- cascades by then have nothing left to touch. This is still exactly "delete this user's
-- data, all of it, and nothing another user owns": every WHERE clause below is scoped to
-- `(select auth.uid())`, the same single value five times over, not five different
-- opportunities for the caller to name someone else's row.
create function public.delete_own_account()
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.pack_items where user_id = (select auth.uid());
  delete from public.pack_categories where user_id = (select auth.uid());
  delete from public.packs where user_id = (select auth.uid());
  delete from public.gear_items where user_id = (select auth.uid());
  delete from auth.users where id = (select auth.uid());
$$;

comment on function public.delete_own_account() is
  'Deletes every row the calling user owns — pack_items, pack_categories, packs, gear_items, then the auth.users row itself, in that leaf-to-root order — and nothing another user owns. Takes no arguments: auth.uid() is the only identity it can ever act on. SECURITY DEFINER because ordinary policies on our own tables cannot express deleting the identity itself, and because authenticated holds no privilege on auth.users at all. Deletes five tables by name rather than relying on auth.users cascading them, because letting Postgres interleave the gear_items and packs cascades from one statement hits a referential-integrity race — see the comment above this function for the reproduction. Callable only by authenticated; see the revoke/grant immediately below.';

-- REVOKE first, exactly as the core-schema migration's grants block insists on for
-- tables: CREATE FUNCTION grants EXECUTE to PUBLIC by default, and `anon` and
-- `authenticated` would otherwise hold it THROUGH that default grant rather than through
-- anything explicit here. Revoking from PUBLIC and then granting only to `authenticated`
-- by name is what makes "anon cannot execute this" a fact about this migration instead of
-- an accident of nobody having granted it yet — the same distinction the core schema
-- draws between an absent grant and a revoked one.
--
-- `tests/rls-enabled.test.ts` sweeps every function in `public` for anon-EXECUTE and
-- would fail the build if this were missing; `tests/account-deletion.test.ts` additionally
-- asserts it directly against this function, with the SQLSTATE, so the test fails loudly
-- rather than merely "no rows" if a later migration ever grants anon execute here.
revoke all on function public.delete_own_account() from public;
grant execute on function public.delete_own_account() to authenticated;
