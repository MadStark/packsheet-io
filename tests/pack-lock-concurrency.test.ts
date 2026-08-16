import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { adminSql, createUser, localDatabase, type TestUser } from './support/local-database';
import { createPack, type PackFixture } from './support/fixtures';

/**
 * Locking a pack, against a concurrent write.
 *
 * The rest of the suite talks to PostgREST, which gives each request its own
 * transaction and no way to hold one open — so none of it can express the failure this
 * file exists for. That failure is not exotic; it is two ordinary requests overlapping:
 *
 *   A: begin; insert a pack_item into an unlocked pack     -- policy sees unlocked: ok
 *   B:        update packs set locked_at = now(); commit   -- freeze cannot see A's
 *                                                          -- uncommitted row
 *   A: commit
 *
 * and it leaves a locked pack holding an item with no snapshot. That state then breaks
 * rule 3 permanently: deleting that gear item fires the BEFORE DELETE trigger, whose
 * UPDATE is filtered to zero rows because the pack is locked, the foreign key nulls
 * `gear_item_id` anyway (foreign key actions are not subject to RLS), and the check
 * constraint aborts the delete. The gear becomes undeletable and the user sees a raw
 * constraint name, until somebody thinks to unlock a pack they locked for posterity.
 *
 * The fix is assert_parent_pack_unlocked(), which takes the parent pack's row lock on
 * the insert path so the two transactions contend instead of passing in the night. Both
 * interleavings are exercised below, because the fix has to work in both directions.
 *
 * These connect as `postgres`. Unusually for this suite that is correct rather than a
 * shortcut: the property under test is transaction isolation, not authorization, and
 * running as the superuser removes RLS as an explanation for any result. The RLS half
 * of the same rule is covered in core-schema.test.ts.
 */

let owner: TestUser;
let pack: PackFixture;
let spareGearId: string;
const clients: pg.Client[] = [];

async function connect(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: localDatabase().dbUrl });
  await client.connect();
  clients.push(client);
  return client;
}

beforeAll(async () => {
  owner = await createUser('lockrace');
  pack = await createPack(owner, { itemCount: 1 });

  const [spare] = await adminSql<{ id: string }>(
    `insert into public.gear_items (user_id, name) values ($1, 'Spare gear') returning id`,
    [owner.id],
  );
  spareGearId = spare.id;
});

afterAll(async () => {
  await Promise.all(clients.map((c) => c.end()));
});

/** The invariant the whole design rests on, asked directly. */
async function itemsWithoutSnapshotInLockedPacks(packId: string): Promise<number> {
  const rows = await adminSql<{ count: string }>(
    `select count(*) as count
       from public.pack_items i
       join public.pack_categories c on c.id = i.pack_category_id
       join public.packs p on p.id = c.pack_id
      where p.id = $1 and p.locked_at is not null and i.snapshot is null`,
    [packId],
  );
  return Number(rows[0].count);
}

describe('a lock cannot race an insert into the pack it is freezing', () => {
  it('makes the lock wait for an in-flight insert, and freezes what it inserted', async () => {
    const inserting = await connect();
    const locking = await connect();

    await inserting.query('begin');
    await inserting.query(
      `insert into public.pack_items (user_id, pack_category_id, gear_item_id)
       values ($1, $2, $3)`,
      [owner.id, pack.categoryId, spareGearId],
    );

    // Started but deliberately not awaited: it must block on the row lock the insert
    // is holding. If it does not, it completes here and freezes an incomplete pack.
    const lock = locking.query(`update public.packs set locked_at = now() where id = $1`, [
      pack.packId,
    ]);

    await new Promise((resolve) => setTimeout(resolve, 250));
    await inserting.query('commit');
    await lock;

    const unfrozen = await itemsWithoutSnapshotInLockedPacks(pack.packId);
    expect(unfrozen, 'a locked pack holds an item with no snapshot').toBe(0);

    // Both items, not just the one that existed when the lock began.
    const rows = await adminSql<{ count: string }>(
      `select count(*) as count from public.pack_items i
         join public.pack_categories c on c.id = i.pack_category_id
        where c.pack_id = $1 and i.snapshot is not null`,
      [pack.packId],
    );
    expect(Number(rows[0].count)).toBe(2);
  });

  // The other order. Here the insert is the one that has to notice.
  it('refuses an insert that arrives while a lock is in flight', async () => {
    const other = await createPack(owner, { itemCount: 1 });
    const locking = await connect();
    const inserting = await connect();

    await locking.query('begin');
    await locking.query(`update public.packs set locked_at = now() where id = $1`, [other.packId]);

    const insert = inserting.query(
      `insert into public.pack_items (user_id, pack_category_id, gear_item_id)
       values ($1, $2, $3)`,
      [owner.id, other.categoryId, spareGearId],
    );

    await new Promise((resolve) => setTimeout(resolve, 250));
    await locking.query('commit');

    // Under READ COMMITTED the blocked statement re-reads the row when it wakes, sees
    // the lock this time, and raises rather than inserting into a frozen pack.
    await expect(insert).rejects.toThrow(/is locked/);

    expect(await itemsWithoutSnapshotInLockedPacks(other.packId)).toBe(0);
  });

  /**
   * The consequence, end to end.
   *
   * Rule 3 on a locked pack is the thing the race actually broke, so it is asserted
   * here directly rather than inferred from the snapshot counts above.
   */
  it('leaves gear on a locked pack deletable afterwards', async () => {
    const { error } = await owner.client.from('gear_items').delete().eq('id', spareGearId);
    expect(error).toBeNull();

    const rows = await adminSql<{ gear_item_id: string | null; name: string }>(
      `select i.gear_item_id, i.snapshot ->> 'name' as name
         from public.pack_items i
         join public.pack_categories c on c.id = i.pack_category_id
        where c.pack_id = $1 and i.snapshot ->> 'name' = 'Spare gear'`,
      [pack.packId],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].gear_item_id).toBeNull();
  });
});
