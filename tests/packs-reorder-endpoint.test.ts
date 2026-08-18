import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIContext } from 'astro';
import type { User } from '@supabase/supabase-js';
import { SIGN_IN_PATH } from '../src/lib/auth-routes';
import { PACK_REORDER_PATH } from '../src/lib/packs/routes';
import { REORDER_FIELD, REORDER_TARGET } from '../src/lib/packs/reorder-request';

/**
 * `src/pages/packs/reorder.ts` — the one route in PK-37 that answers a machine rather than
 * a person, and the only place in the product where a request body becomes a database write
 * with no form parser in between.
 *
 * WHY THIS FILE EXISTS EVEN THOUGH THE ENDPOINT IS IN `src/pages/`. `vitest.config.ts:64`
 * excludes that directory from COLLECTION — a test file may not live there, because every
 * file there becomes a route. It does not stop a test in `tests/` from importing the module
 * and calling its exported handler, which is exactly what `tests/robots-txt.test.ts` has
 * always done for `src/pages/robots.txt.ts`. The endpoint is an ordinary async function of
 * an `APIContext`, so it is called directly with a hand-built one.
 *
 * WHAT IS MOCKED, AND WHY IT IS THE RIGHT LINE. `createAuthClient`, `loadPackForEdit` and
 * the two RPC wrappers are replaced; everything the endpoint DECIDES is real, including the
 * whole of `src/lib/packs/reorder.ts`'s arithmetic. What that buys is the assertion this
 * file is really for: given a body that carries its own positions, the RPC is called with
 * the positions the server computed from the rows IT read, and never with the ones it was
 * sent. Mocking the client instead of the network is what makes that observable — the
 * argument the RPC wrapper receives is the whole claim.
 *
 * The real `loadPackForEdit` has its own coverage against the local database in
 * `tests/packs-query.test.ts`, including its cross-user leak test; mocking it here is what
 * lets "the pack this visitor owns" be expressed as a fact rather than as a fixture.
 */

const { createAuthClient } = vi.hoisted(() => ({ createAuthClient: vi.fn() }));
vi.mock('../src/lib/auth', () => ({ createAuthClient }));

const { loadPackForEdit } = vi.hoisted(() => ({ loadPackForEdit: vi.fn() }));
vi.mock('../src/lib/packs/query', () => ({ loadPackForEdit }));

const { movePackItem, movePackCategory } = vi.hoisted(() => ({
  movePackItem: vi.fn(),
  movePackCategory: vi.fn(),
}));
vi.mock('../src/lib/packs/mutations', () => ({ movePackItem, movePackCategory }));

const { POST } = await import('../src/pages/packs/reorder');

const USER = { id: 'user-1', email: 'someone@packsheet.test' } as unknown as User;
const CLIENT = { marker: 'the request-scoped Supabase client' };

const PACK_ID = '11111111-1111-4111-8111-111111111111';
const CATEGORY_A = '22222222-2222-4222-8222-222222222222';
const CATEGORY_B = '33333333-3333-4333-8333-333333333333';
const ITEM_1 = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const ITEM_2 = 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa';
const ITEM_3 = 'aaaaaaaa-3333-4333-8333-aaaaaaaaaaaa';
const ITEM_4 = 'aaaaaaaa-4444-4444-8444-aaaaaaaaaaaa';

/** The rows the endpoint reads for itself. Deliberately NOT the rows any request body
 *  claims: the whole design is that these are the only ones the plan is computed from. */
const PACK_ROWS = {
  pack_categories: [
    {
      id: CATEGORY_A,
      position: 0,
      pack_items: [
        { id: ITEM_1, position: 0 },
        { id: ITEM_2, position: 1 },
        { id: ITEM_3, position: 2 },
      ],
    },
    { id: CATEGORY_B, position: 1, pack_items: [{ id: ITEM_4, position: 0 }] },
  ],
};

interface ContextOptions {
  readonly user?: User | null;
  readonly rawBody?: string;
}

function contextFor(body: unknown, { user = USER, rawBody }: ContextOptions = {}): APIContext {
  const url = new URL(PACK_REORDER_PATH, 'https://packsheet.io');
  return {
    locals: { user },
    cookies: { marker: 'the AstroCookies for this request' },
    url,
    request: new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: rawBody ?? JSON.stringify(body),
    }),
    // Astro's own `redirect`, in the shape this handler uses it.
    redirect: (location: string, status?: number) =>
      new Response(null, { status: status ?? 302, headers: { location } }),
  } as unknown as APIContext;
}

const itemBody = (overrides: Record<string, unknown> = {}) => ({
  [REORDER_FIELD.target]: REORDER_TARGET.item,
  [REORDER_FIELD.packId]: PACK_ID,
  [REORDER_FIELD.itemId]: ITEM_1,
  [REORDER_FIELD.toCategoryId]: CATEGORY_A,
  [REORDER_FIELD.toIndex]: 2,
  ...overrides,
});

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

beforeEach(() => {
  createAuthClient.mockReset();
  createAuthClient.mockReturnValue(CLIENT);
  loadPackForEdit.mockReset();
  loadPackForEdit.mockResolvedValue({ data: PACK_ROWS, error: null });
  movePackItem.mockReset();
  movePackItem.mockResolvedValue({ error: null, locked: false });
  movePackCategory.mockReset();
  movePackCategory.mockResolvedValue({ error: null, locked: false });
});

describe('authorisation', () => {
  /**
   * The signed-out case. A redirect rather than a bare 401 because that is this ticket's
   * rule for every route under /packs, and because `fetch` reports it (`response.redirected`)
   * rather than silently succeeding. Nothing is read and nothing is written on this path.
   */
  it('redirects a signed-out caller to sign-in with `next` set to this URL', async () => {
    const response = await POST(contextFor(itemBody(), { user: null }));

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(
      `${SIGN_IN_PATH}?next=${encodeURIComponent(PACK_REORDER_PATH)}`,
    );
    expect(createAuthClient).not.toHaveBeenCalled();
    expect(loadPackForEdit).not.toHaveBeenCalled();
    expect(movePackItem).not.toHaveBeenCalled();
  });

  /**
   * The read is scoped to the SIGNED-IN visitor, from `locals.user`, and the pack id is the
   * only thing the body contributes to it. Nothing in this endpoint reads a user id off the
   * request, which is what makes "act as someone else" unspellable rather than merely
   * refused — and `loadPackForEdit` adds the `.eq('user_id', ...)` that keeps
   * `packs_select_public` from answering for a stranger's public pack.
   */
  it('reads the pack under the caller’s own session and id', async () => {
    await POST(contextFor(itemBody()));

    expect(createAuthClient).toHaveBeenCalledTimes(1);
    expect(loadPackForEdit).toHaveBeenCalledWith(CLIENT, USER.id, PACK_ID);
  });

  it('answers 404 for a pack the read does not return, and writes nothing', async () => {
    loadPackForEdit.mockResolvedValue({ data: null, error: null });

    const response = await POST(contextFor(itemBody()));

    expect(response.status).toBe(404);
    expect(movePackItem).not.toHaveBeenCalled();
  });

  it('answers 500 for a failed read without leaking the error', async () => {
    loadPackForEdit.mockResolvedValue({
      data: null,
      error: { message: 'permission denied for table packs', code: '42501' },
    });

    const response = await POST(contextFor(itemBody()));

    expect(response.status).toBe(500);
    expect(JSON.stringify(await bodyOf(response))).not.toMatch(/permission denied|42501/);
    expect(movePackItem).not.toHaveBeenCalled();
  });
});

describe('the body', () => {
  it.each([
    ['a body that is not JSON', 'not json at all'],
    ['an empty body', ''],
  ])('refuses %s with a 400 and no read', async (_label, rawBody) => {
    const response = await POST(contextFor(undefined, { rawBody }));

    expect(response.status).toBe(400);
    expect((await bodyOf(response)).ok).toBe(false);
    expect(loadPackForEdit).not.toHaveBeenCalled();
  });

  it('refuses a body with no recognisable intent', async () => {
    const response = await POST(contextFor({ target: 'pack', packId: PACK_ID, toIndex: 0 }));

    expect(response.status).toBe(400);
    expect(loadPackForEdit).not.toHaveBeenCalled();
  });

  /**
   * THE ASSERTION THIS WHOLE FILE IS FOR — "BOTH SIDES CALL THIS, ONLY ONE SIDE IS
   * BELIEVED", as an executable claim rather than a comment.
   *
   * The body below carries a complete, well-formed `ReorderPlan` of the shape the island
   * computes for its own optimistic render, and it says something entirely different from
   * the truth: that every row in the pack should be set to position 0. The RPC is called
   * with the plan the SERVER computed from the rows it read, and the sent one appears
   * nowhere in it.
   */
  it('ignores positions in the body and sends the plan it computed itself', async () => {
    const hostilePlan = [
      {
        parentId: CATEGORY_A,
        updates: [
          { id: ITEM_1, position: 0 },
          { id: ITEM_2, position: 0 },
          { id: ITEM_3, position: 0 },
          { id: ITEM_4, position: 0 },
        ],
      },
    ];

    await POST(contextFor(itemBody({ runs: hostilePlan, positions: hostilePlan, position: 0 })));

    expect(movePackItem).toHaveBeenCalledTimes(1);
    expect(movePackItem).toHaveBeenCalledWith(CLIENT, PACK_ID, ITEM_1, CATEGORY_A, [
      {
        parentId: CATEGORY_A,
        updates: [
          { id: ITEM_2, position: 0 },
          { id: ITEM_3, position: 1 },
          { id: ITEM_1, position: 2 },
        ],
      },
    ]);
  });
});

describe('applying a move', () => {
  // `move_pack_item`'s p_to_category_id is required precisely so that "moved, but I did not
  // say where" has no spelling — see that function's own comment on the trap reorder.ts
  // describes and cannot itself prevent.
  it('passes the destination category to the item RPC, even for a same-category move', async () => {
    await POST(contextFor(itemBody()));

    expect(movePackItem).toHaveBeenCalledWith(
      CLIENT,
      PACK_ID,
      ITEM_1,
      CATEGORY_A,
      expect.anything(),
    );
  });

  it('rewrites both runs and reports the reparent for a cross-category move', async () => {
    const response = await POST(
      contextFor(
        itemBody({ [REORDER_FIELD.toCategoryId]: CATEGORY_B, [REORDER_FIELD.toIndex]: 0 }),
      ),
    );

    expect(movePackItem).toHaveBeenCalledWith(CLIENT, PACK_ID, ITEM_1, CATEGORY_B, [
      {
        parentId: CATEGORY_A,
        updates: [
          { id: ITEM_2, position: 0 },
          { id: ITEM_3, position: 1 },
        ],
      },
      { parentId: CATEGORY_B, updates: [{ id: ITEM_4, position: 1 }] },
    ]);

    // The applied plan comes back, because that is what the island re-renders from when its
    // own prediction and the server's answer disagree.
    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toEqual({
      ok: true,
      runs: [
        {
          parentId: CATEGORY_A,
          updates: [
            { id: ITEM_2, position: 0 },
            { id: ITEM_3, position: 1 },
          ],
        },
        { parentId: CATEGORY_B, updates: [{ id: ITEM_4, position: 1 }] },
      ],
      reparent: { id: ITEM_1, parentId: CATEGORY_B },
    });
  });

  it('routes a category move to the category RPC, which has no destination', async () => {
    const response = await POST(
      contextFor({
        [REORDER_FIELD.target]: REORDER_TARGET.category,
        [REORDER_FIELD.packId]: PACK_ID,
        [REORDER_FIELD.categoryId]: CATEGORY_B,
        [REORDER_FIELD.toIndex]: 0,
      }),
    );

    expect(movePackItem).not.toHaveBeenCalled();
    expect(movePackCategory).toHaveBeenCalledWith(CLIENT, PACK_ID, [
      {
        parentId: PACK_ID,
        updates: [
          { id: CATEGORY_B, position: 0 },
          { id: CATEGORY_A, position: 1 },
        ],
      },
    ]);
    expect(response.status).toBe(200);
  });

  // A drag that ended where it began. An empty transaction is not a better answer than no
  // transaction, and the RPC would renumber a run to the numbers it already has.
  it('writes nothing for a move that changes nothing, and still answers ok', async () => {
    const response = await POST(contextFor(itemBody({ [REORDER_FIELD.toIndex]: 0 })));

    expect(movePackItem).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toEqual({ ok: true, runs: [], reparent: null });
  });

  it('answers 409 for a row the pack no longer holds, without writing', async () => {
    const response = await POST(
      contextFor(itemBody({ [REORDER_FIELD.itemId]: '99999999-9999-4999-8999-999999999999' })),
    );

    expect(response.status).toBe(409);
    expect(movePackItem).not.toHaveBeenCalled();
  });

  /**
   * The RPCs raise `pack % is not yours to reorder`, `item % is not in pack %` and
   * `p_runs renumbers an item that is not in pack %` — every one of which names internals a
   * client has no use for, and the first of which is an authorisation answer this endpoint
   * must not paraphrase into a hint about what exists.
   */
  it('never returns the RPC’s own error text', async () => {
    movePackItem.mockResolvedValue({
      error: {
        message: 'pack 1111 is not yours to reorder',
        code: '42501',
        details: 'insufficient_privilege',
      },
      locked: false,
    });

    const response = await POST(contextFor(itemBody()));

    expect(response.status).toBe(500);
    const body = await bodyOf(response);
    expect(body.ok).toBe(false);
    expect(JSON.stringify(body)).not.toMatch(/not yours to reorder|42501|insufficient_privilege/);
  });

  /**
   * A LOCKED PACK IS NOT A SERVER FAULT (independent review, B2).
   *
   * Two things had to change for this test to be possible to write. The RPC had to REFUSE at
   * all — `move_pack_item` used to return success on a locked pack whenever `p_runs` was
   * empty, because RLS filters the re-parent to zero rows instead of raising and nothing
   * counted them (see the section at the end of
   * `supabase/migrations/20260818000000_pack_composition_functions.sql`). And this endpoint
   * had to stop mapping every RPC error to a 500, which reported a state the owner put the
   * pack in — and can take it out of — as though the server had broken.
   *
   * 409 rather than 403 or 423: the same status the plan-refusal above answers, and for the
   * same stated reason. The request was well formed and was refused by the state of the pack,
   * which is the distinction a client can act on. `tests/packs-mutations.test.ts` is where
   * `locked` is proved to be what the real database actually says; here it is a given, which
   * is the point of mocking at this seam.
   */
  it('answers 409 and a locked-pack sentence rather than a 500, for both targets', async () => {
    const lockedError = {
      error: {
        message: 'pack 1111 is locked; unlock it before reordering its contents',
        code: '55000',
        details: null,
      },
      locked: true,
    };
    movePackItem.mockResolvedValue(lockedError);
    movePackCategory.mockResolvedValue(lockedError);

    const item = await POST(contextFor(itemBody()));
    const category = await POST(
      contextFor({
        [REORDER_FIELD.target]: REORDER_TARGET.category,
        [REORDER_FIELD.packId]: PACK_ID,
        [REORDER_FIELD.categoryId]: CATEGORY_B,
        [REORDER_FIELD.toIndex]: 0,
      }),
    );

    expect(item.status).toBe(409);
    expect(category.status).toBe(409);

    const body = await bodyOf(item);
    expect(body.ok).toBe(false);
    expect(String(body.message)).toMatch(/locked/i);
    // Still never the RPC's own words, the house rule this route already follows for every
    // other failure: the SQLSTATE and the raise's text name internals a client cannot use.
    expect(JSON.stringify(body)).not.toMatch(/55000|unlock it before reordering/);
  });

  it('answers JSON, with a content type that says so', async () => {
    const response = await POST(contextFor(itemBody()));

    expect(response.headers.get('content-type')).toBe('application/json');
  });
});
