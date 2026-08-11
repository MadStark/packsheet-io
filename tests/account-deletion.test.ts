import { describe, it, expect, beforeAll } from 'vitest';
import {
  adminSql,
  adminSqlWith,
  anonClient,
  createUser,
  type TestUser,
} from './support/local-database';
import { createPack, type PackFixture } from './support/fixtures';

/**
 * `delete_own_account()` — the RPC `deleteOwnAccount()` in `src/lib/auth/index.ts`
 * already calls, and the only place in this project a Postgres role is ever asked to
 * delete an `auth.users` row on a live user's behalf.
 *
 * The fixtures here are built exactly the way rls-owner.test.ts and rls-anon.test.ts
 * build theirs: every pack, category, item and gear row goes in through PostgREST as
 * its owner, under RLS, via `createPack`. Inserting with `adminSql` instead would prove
 * that a DELETE cascades from `auth.users`, which is not in question — the schema's own
 * foreign keys already guarantee that. What is in question is whether the RPC reaches
 * exactly the calling user's OWN rows, built the way real rows are built, and nobody
 * else's.
 */

let alice: TestUser;
let alicePack: PackFixture;
let bob: TestUser;
let bobPack: PackFixture;

beforeAll(async () => {
  alice = await createUser('alice');
  alicePack = await createPack(alice, { visibility: 'private', itemCount: 2 });
  bob = await createUser('bob');
  bobPack = await createPack(bob, { visibility: 'private', itemCount: 1 });
});

describe('a signed-in user deletes their own account', () => {
  it('removes the auth.users row and every pack, category, item and gear row it owned', async () => {
    const { error } = await alice.client.rpc('delete_own_account');
    expect(error).toBeNull();

    // auth.users itself. This is the row nothing but a SECURITY DEFINER function could
    // ever have reached — `authenticated` holds no DELETE privilege on it at all.
    const users = await adminSql('select id from auth.users where id = $1', [alice.id]);
    expect(users).toEqual([]);

    // Everything Alice owned, proved against a REAL fixture rather than an empty one:
    // two gear items, one pack, one category, two pack items, all inserted as Alice
    // through PostgREST's own insert policies before the deletion ran.
    //
    // Deleted BY NAME rather than by cascade, which is worth saying because the schema
    // does carry `on delete cascade` back to auth.users and it would be reasonable to
    // assume that is what ran. It is not: the function issues five statements leaf to
    // root, because letting Postgres interleave the gear_items and packs cascades from
    // one statement hits a referential-integrity race — see the comment above
    // `public.delete_own_account()` in the migration for the reproduction. What this
    // block asserts is the outcome, which is the same either way; what it would NOT
    // catch is somebody "simplifying" the function back to a single delete, since that
    // fails loudly on any account that owns a pack with an item in it.
    const packs = await adminSql('select id from packs where id = $1', [alicePack.packId]);
    const categories = await adminSql('select id from pack_categories where id = $1', [
      alicePack.categoryId,
    ]);
    const items = await adminSql('select id from pack_items where id = any($1)', [
      alicePack.itemIds,
    ]);
    const gear = await adminSql('select id from gear_items where id = any($1)', [
      alicePack.gearItemIds,
    ]);

    expect(packs).toEqual([]);
    expect(categories).toEqual([]);
    expect(items).toEqual([]);
    expect(gear).toEqual([]);
  });

  // The other half of "exactly this user's rows and nobody else's". Everything above
  // would pass just as well against a function that deleted every account on the
  // instance; this is what rules that out.
  it('leaves a second user entirely untouched', async () => {
    const users = await adminSql('select id from auth.users where id = $1', [bob.id]);
    expect(users).toHaveLength(1);

    const packs = await adminSql('select id from packs where id = $1', [bobPack.packId]);
    const gear = await adminSql('select id from gear_items where id = any($1)', [
      bobPack.gearItemIds,
    ]);
    expect(packs).toHaveLength(1);
    expect(gear).toHaveLength(bobPack.gearItemIds.length);

    // And Bob's own session still works — his account was never touched by the grant
    // that let Alice delete hers.
    const { data, error } = await bob.client.from('packs').select('id').eq('id', bobPack.packId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });
});

/**
 * The negative that matters most: `anon` must never be able to reach this function.
 *
 * `revoke all ... from public` plus a targeted `grant execute ... to authenticated` in
 * the migration is what makes this true; `tests/rls-enabled.test.ts` sweeps every
 * function in `public` for anon-EXECUTE as a catalogue fact. This test is the other
 * half — that the sweep's fact actually stops a real, unauthenticated caller — and it
 * is written to FAIL, not merely go quiet, the day anon execute is granted here: it
 * asserts the permission-denied error itself, not just "no rows changed", so a version
 * of this function that silently did nothing for anon would not accidentally pass it.
 */
describe('the anon key cannot call it at all', () => {
  let charlie: TestUser;
  let charliePack: PackFixture;

  beforeAll(async () => {
    charlie = await createUser('charlie');
    charliePack = await createPack(charlie, { visibility: 'private' });
  });

  it('is refused with a permission-denied error, not a silent no-op', async () => {
    const { error } = await anonClient().rpc('delete_own_account');

    // 42501 — insufficient privilege, the same SQLSTATE `rls-owner.test.ts` asserts for
    // a refused table write. Postgres reports the identical code whether the object is
    // a table or a function, and it is the fact that distinguishes "refused" from a
    // request that failed for some unrelated reason and happened to also touch no rows.
    expect(error?.code).toBe('42501');
  });

  it('leaves the account and its pack in place', async () => {
    const users = await adminSql('select id from auth.users where id = $1', [charlie.id]);
    expect(users).toHaveLength(1);

    const packs = await adminSql('select id from packs where id = $1', [charliePack.packId]);
    expect(packs).toHaveLength(1);
  });
});

/**
 * `delete from auth.users where id = (select auth.uid())` with no caller identity at
 * all. `auth.uid()` reads `request.jwt.claims` via `current_setting(..., true)` — the
 * `missing_ok` form — so an `authenticated`-role session with no JWT claims set answers
 * `null`, and `id = null` matches no row under three-valued logic rather than raising.
 * The function has to make that case a safe no-op rather than an error, because it is
 * exactly the shape a forged or absent session takes once it has cleared the anon check
 * above and reached the function body.
 *
 * This is deliberately driven at the SQL level rather than through supabase-js: the
 * client library always ships a bearer token for any authenticated call, so there is no
 * way to produce "authenticated role, no claims" through it. `adminSqlWith`'s `SET ROLE`
 * (session-scoped, not `SET LOCAL`) is what stands in for that here — the same technique
 * used to validate this migration's design against the live database before it was
 * written.
 */
describe('no signed-in identity deletes nothing', () => {
  it('is a safe no-op for an authenticated session with no JWT claims', async () => {
    const before = await adminSql('select count(*)::int as n from auth.users');

    await expect(
      adminSqlWith(['set role authenticated'], 'select public.delete_own_account()'),
    ).resolves.not.toThrow();

    const after = await adminSql('select count(*)::int as n from auth.users');
    expect(after[0].n).toBe(before[0].n);
  });
});
