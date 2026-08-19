import { describe, it, expect, beforeAll } from 'vitest';
import { adminSql, createUser, type TestUser } from './support/local-database';
import {
  parseWeightSystemForm,
  readWeightSystem,
  saveWeightSystem,
  WEIGHT_SYSTEM_FIELD,
} from '../src/lib/profile';
import { DEFAULT_WEIGHT_SYSTEM } from '../src/lib/units';

/**
 * `src/lib/profile.ts` and the `public.profiles` table behind it (PK-67) — the first
 * per-user settings record in this product.
 *
 * Two halves, and the file covers both deliberately. `parseWeightSystemForm` is pure and
 * could live anywhere; the read and write functions are the ones that carry the decision
 * this ticket rests on — A MISSING ROW MEANS THE DEFAULT — and that decision is only
 * observable against a real database, because the whole point is what PostgREST returns
 * for a user who has no row. A mocked client would be asserting the mock.
 *
 * Same style as tests/gear-closet-schema.test.ts: real local stack, every write issued as
 * its owner through PostgREST under RLS, and every read-back taken from the owner's own
 * client rather than trusting the write's own response.
 */

let alice: TestUser;
let bob: TestUser;

beforeAll(async () => {
  alice = await createUser('profile-alice');
  bob = await createUser('profile-bob');
});

// ---------------------------------------------------------------------------
// parseWeightSystemForm
// ---------------------------------------------------------------------------

/** A submission carrying whatever the radio group posted, or nothing at all. */
function form(value?: string): FormData {
  const data = new FormData();
  if (value !== undefined) data.set(WEIGHT_SYSTEM_FIELD, value);
  return data;
}

describe('parseWeightSystemForm', () => {
  it.each(['metric', 'imperial'] as const)('accepts %s', (system) => {
    expect(parseWeightSystemForm(form(system))).toBe(system);
  });

  /**
   * A radio group with nothing checked posts NOTHING — the same submission
   * `parseGearItemForm` accounts for on `status`, and genuinely producible by a
   * JavaScript-disabled browser meeting a stale form or by a crafted request. It must
   * refuse rather than default: guessing writes a preference the visitor did not choose,
   * and unlike a blank weight there is no column default that makes one guess honest.
   */
  it('returns null when the field is absent entirely', () => {
    expect(parseWeightSystemForm(form())).toBeNull();
  });

  // Case-sensitive, mirroring the CHECK constraint, which is not case-insensitive either.
  // These are the near-misses a crafted request carries, since no visitor can type into
  // a radio group.
  it.each(['', '   ', 'Metric', 'METRIC', 'si', 'kg', 'metric ', 'imperialist'])(
    'returns null for %o',
    (value) => {
      expect(parseWeightSystemForm(form(value))).toBeNull();
    },
  );
});

// ---------------------------------------------------------------------------
// readWeightSystem — absence is the ordinary case
// ---------------------------------------------------------------------------

describe('readWeightSystem', () => {
  /**
   * THE DECISION THIS WHOLE TICKET RESTS ON. No trigger creates a profile at sign-up and
   * no backfill exists, so every account that has never opened `/account` has no row here
   * — which is most of them. If this returned null, threw, or surfaced PostgREST's
   * `PGRST116` "no rows" error, the gear closet would break for exactly those users.
   *
   * Asserted against a user created moments ago and never written to, which is the real
   * shape of the case rather than a deleted-row simulation of it.
   */
  it('reads a user with no profile row as the default, not an error', async () => {
    const rows = await adminSql('select user_id from profiles where user_id = $1', [alice.id]);
    expect(rows, 'fixture precondition: alice must have no profile row yet').toEqual([]);

    const { system, error } = await readWeightSystem(alice.client, alice.id);

    expect(error).toBeNull();
    expect(system).toBe(DEFAULT_WEIGHT_SYSTEM);
    expect(system).toBe('metric');
  });

  it('reads back what was saved', async () => {
    await saveWeightSystem(bob.client, bob.id, 'imperial');

    const { system, error } = await readWeightSystem(bob.client, bob.id);

    expect(error).toBeNull();
    expect(system).toBe('imperial');
  });

  /**
   * A value the CHECK constraint would refuse cannot be written through the client, so it
   * is planted with admin SQL — the gap `isWeightSystem` exists for, and the same one
   * `formatGearStatus` guards on `gear_items.status`: the constraint holds on write but is
   * not proven to still hold by the time a row is read back through a client that types
   * the column as a bare `string`.
   *
   * The constraint is dropped and restored around the write so this tests the READER
   * rather than accidentally testing that the constraint exists — which
   * tests/core-schema.test.ts already does directly.
   */
  it('falls back to the default for a stored value outside the vocabulary', async () => {
    const mallory = await createUser('profile-mallory');
    await adminSql('insert into profiles (user_id, weight_units) values ($1, $2)', [
      mallory.id,
      'metric',
    ]);
    await adminSql('alter table public.profiles drop constraint profiles_weight_units_check');
    try {
      await adminSql('update profiles set weight_units = $1 where user_id = $2', [
        'stones',
        mallory.id,
      ]);

      const { system } = await readWeightSystem(mallory.client, mallory.id);
      expect(system).toBe(DEFAULT_WEIGHT_SYSTEM);
    } finally {
      await adminSql('delete from profiles where user_id = $1', [mallory.id]);
      await adminSql(
        "alter table public.profiles add constraint profiles_weight_units_check check (weight_units in ('metric', 'imperial'))",
      );
    }
  });
});

// ---------------------------------------------------------------------------
// saveWeightSystem — upsert, because the first save is an INSERT
// ---------------------------------------------------------------------------

describe('saveWeightSystem', () => {
  /**
   * The failure a plain `.update()` would produce, and the reason this is an upsert: with
   * no row created at sign-up, the FIRST save of every account is an insert. An update
   * would match zero rows, report `error: null`, and re-render the page showing the old
   * value — a silent no-op on the one action the page exists for.
   */
  it('creates the row on the first save, when none exists', async () => {
    const user = await createUser('profile-first-save');
    expect(await adminSql('select user_id from profiles where user_id = $1', [user.id])).toEqual(
      [],
    );

    const { error } = await saveWeightSystem(user.client, user.id, 'imperial');
    expect(error).toBeNull();

    const { system } = await readWeightSystem(user.client, user.id);
    expect(system).toBe('imperial');
  });

  it('updates the row on every save after the first, without creating a second', async () => {
    const user = await createUser('profile-second-save');

    await saveWeightSystem(user.client, user.id, 'imperial');
    await saveWeightSystem(user.client, user.id, 'metric');

    const { system } = await readWeightSystem(user.client, user.id);
    expect(system).toBe('metric');

    // One row, not two. `user_id` is the primary key, so a second would be impossible —
    // which is exactly why the key is the user id rather than a surrogate, and this says
    // so against the running schema rather than against the migration's intent.
    const rows = await adminSql('select user_id from profiles where user_id = $1', [user.id]);
    expect(rows).toHaveLength(1);
  });

  /**
   * The server-side timestamps, which matter here more than on the tables they were
   * written for: saving a preference is an UPSERT, so the INSERT path is taken on the very
   * first save of every account that ever changes this setting. A table carrying only an
   * UPDATE trigger would leave `created_at` client-supplied on exactly that write.
   */
  it('stamps created_at and updated_at server-side on the insert path', async () => {
    const user = await createUser('profile-timestamps');
    await saveWeightSystem(user.client, user.id, 'imperial');

    const [row] = await adminSql<{ created_at: Date; updated_at: Date }>(
      'select created_at, updated_at from profiles where user_id = $1',
      [user.id],
    );
    expect(row.created_at).toBeInstanceOf(Date);
    expect(row.updated_at).toBeInstanceOf(Date);
  });

  it('moves updated_at on a later save, leaving created_at alone', async () => {
    const user = await createUser('profile-updated-at');
    await saveWeightSystem(user.client, user.id, 'imperial');
    const [before] = await adminSql<{ created_at: Date; updated_at: Date }>(
      'select created_at, updated_at from profiles where user_id = $1',
      [user.id],
    );

    await saveWeightSystem(user.client, user.id, 'metric');
    const [after] = await adminSql<{ created_at: Date; updated_at: Date }>(
      'select created_at, updated_at from profiles where user_id = $1',
      [user.id],
    );

    expect(after.created_at.getTime()).toBe(before.created_at.getTime());
    expect(after.updated_at.getTime()).toBeGreaterThanOrEqual(before.updated_at.getTime());
  });
});

// ---------------------------------------------------------------------------
// The ownership boundary
// ---------------------------------------------------------------------------

/**
 * `profiles` holds one row per user with no "via public pack" escape hatch of the kind
 * `gear_items` has, so the boundary is the simplest in the schema — and worth asserting
 * anyway, because this is the first table added since the grant-hardening migration and
 * the first designed to grow fields (gender, home country) that must never become public.
 *
 * Read-backs are taken as the OWNER throughout: a write RLS hides comes back from
 * PostgREST as `{ error: null, data: [] }`, byte-identical to a write that legitimately
 * matched nothing, so the stranger's own response says nothing either way.
 */
describe('another user cannot read or write someone else’s profile', () => {
  it('a stranger reads nothing, and gets the default rather than the owner’s value', async () => {
    const owner = await createUser('profile-owner-read');
    await saveWeightSystem(owner.client, owner.id, 'imperial');

    // `readWeightSystem` asked for somebody else's row: RLS returns zero rows, which this
    // module reads as "no preference set" — so a stranger learns the default, never the
    // owner's actual choice.
    const { system, error } = await readWeightSystem(bob.client, owner.id);

    expect(error).toBeNull();
    expect(system).toBe(DEFAULT_WEIGHT_SYSTEM);
  });

  it('a stranger’s write changes nothing, confirmed by re-reading as the owner', async () => {
    const owner = await createUser('profile-owner-write');
    await saveWeightSystem(owner.client, owner.id, 'imperial');

    await saveWeightSystem(bob.client, owner.id, 'metric');

    const { system } = await readWeightSystem(owner.client, owner.id);
    expect(system).toBe('imperial');
  });

  /**
   * The DELETE half, which has no policy at all — deliberately, per the migration: nothing
   * in the product deletes a profile on its own, and the only real deletion is the account
   * going away through `delete_own_account()`, a SECURITY DEFINER function where RLS does
   * not apply. With no policy to permit it, even the OWNER's delete matches zero rows.
   *
   * Asserted for the owner rather than for a stranger, because the stranger case would
   * pass under a permissive delete policy too — the owner is the only caller that
   * distinguishes "no policy" from "an owner-scoped policy someone added later".
   */
  it('not even the owner can delete their own profile row directly', async () => {
    const owner = await createUser('profile-owner-delete');
    await saveWeightSystem(owner.client, owner.id, 'imperial');

    await owner.client.from('profiles').delete().eq('user_id', owner.id);

    const rows = await adminSql('select user_id from profiles where user_id = $1', [owner.id]);
    expect(rows).toHaveLength(1);
  });
});
