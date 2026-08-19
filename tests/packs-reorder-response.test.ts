import { describe, expect, it, vi } from 'vitest';
import {
  REORDER_SAVE_FAILED_MESSAGE,
  REORDER_OFFLINE_MESSAGE,
  REORDER_SAVED_MESSAGE,
  REORDER_SIGNED_OUT_MESSAGE,
  REORDER_STALE_MESSAGE,
  REORDER_TIMEOUT_MESSAGE,
  REORDER_UNCONFIRMED_MESSAGE,
  messageOf,
  planOf,
  readUpdates,
  reorderNotice,
  reorderRevertsTree,
  sendReorder,
  type ReorderFetch,
  type ReorderOutcome,
} from '../src/lib/packs/reorder-response';
import { PACK_REORDER_PATH } from '../src/lib/packs/routes';
import { REORDER_TARGET, type ReorderIntent } from '../src/lib/packs/reorder-request';
import type { PositionedCategory } from '../src/lib/packs/drag';

/**
 * `src/lib/packs/reorder-response.ts` is the half of PK-37's island that reads what came
 * back, and this file is the reason it is a module at all.
 *
 * WHAT THIS FILE EXISTS TO CORRECT. Every function under test used to live in
 * `<script setup>` in `src/components/PackContents.vue`, behind that component's note that a
 * decision taken inside a drag handler is a decision nothing in this repository can execute.
 * PK-37's independent review was right that the note covers the POINTER handlers and stops
 * there: `environment: 'node'` denies the suite a `DragEvent`, a `dataTransfer` and a
 * `getBoundingClientRect`, and denies it nothing that a payload reader or a status-code
 * branch touches. `sendReorder` needs a stubbed `fetch`, which is one function.
 *
 * The comparison that settles it is next door: `parseReorderIntent` reads an untrusted
 * payload on the server side of this same protocol, and the 446 lines of
 * `tests/packs-reorder-request.test.ts` hold it and its two siblings in place. The only
 * thing that differed was the file extension.
 *
 * THE BRANCH TABLE IS THE POINT OF THE FILE. Seven outcomes, each asserted for the outcome
 * it produces, the sentence it shows, and what it does to the tree — because the defect the
 * review found was not a wrong sentence, it was three DIFFERENT situations all rendering
 * "Saved". Three of the seven were unreachable before: an unreadable 200, a plan naming
 * unknown rows, and a request that never came back at all.
 *
 * WHAT IS NOT RETESTED HERE. The position arithmetic is `tests/packs-reorder.test.ts`'s and
 * the projection of a plan onto a tree is `tests/packs-drag.test.ts`'s, which also owns
 * `unknownPlanRows` because that function lives beside `applyReorderPlan` and guards it.
 * This file asserts only that `sendReorder` consults it and what it does with the answer.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PACK_ID = '11111111-1111-4111-8111-111111111111';
const CATEGORY_A = '22222222-2222-4222-8222-222222222222';
const CATEGORY_B = '33333333-3333-4333-8333-333333333333';
const ITEM_1 = '44444444-4444-4444-8444-444444444444';
const ITEM_2 = '55555555-5555-4555-8555-555555555555';
/** Deliberately never in `TREE`: the row a stale tab has not heard of. */
const ITEM_ELSEWHERE = '66666666-6666-4666-8666-666666666666';

/** The tree the island holds while a drag is in flight, in the shape `applyReorderPlan` and
 *  `unknownPlanRows` both take — `id` and `position` at two levels, and nothing else. */
const TREE: readonly PositionedCategory[] = [
  {
    id: CATEGORY_A,
    position: 0,
    pack_items: [
      { id: ITEM_1, position: 0 },
      { id: ITEM_2, position: 1 },
    ],
  },
  { id: CATEGORY_B, position: 1, pack_items: [] },
];

const ITEM_INTENT: ReorderIntent = {
  target: REORDER_TARGET.item,
  packId: PACK_ID,
  itemId: ITEM_1,
  toCategoryId: CATEGORY_A,
  toIndex: 1,
};

/** What the endpoint answers on a successful same-category swap: `{ ok: true, ...plan }`,
 *  spread exactly as `src/pages/packs/reorder.ts` spreads it. */
const APPLIED_BODY = {
  ok: true,
  runs: [
    {
      parentId: CATEGORY_A,
      updates: [
        { id: ITEM_2, position: 0 },
        { id: ITEM_1, position: 1 },
      ],
    },
  ],
  reparent: null,
};

/**
 * A `Response` as `fetch` hands one back. `redirected` is defined on the instance because
 * it is a prototype getter with no constructor option — `Response.redirect()` produces a
 * 3xx with `redirected` still false, since the flag records that a redirect was FOLLOWED
 * rather than that one was returned, which is exactly the fact the signed-out branch reads.
 */
function response(body: string, init: { status?: number; redirected?: boolean } = {}): Response {
  const built = new Response(body, {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json' },
  });
  if (init.redirected === true) {
    Object.defineProperty(built, 'redirected', { value: true, configurable: true });
  }
  return built;
}

const jsonResponse = (body: unknown, init: { status?: number; redirected?: boolean } = {}) =>
  response(JSON.stringify(body), init);

/** A stub that answers immediately with one prepared response. */
const answering = (built: Response): ReorderFetch => vi.fn(async () => built);

/**
 * A stub that behaves like a connection that is open and silent: it never resolves on its
 * own and settles only when the caller's own signal aborts, rejecting with that signal's
 * reason exactly as the platform's `fetch` does. Honouring the signal is what makes this a
 * faithful stand-in rather than a way of forcing the branch — a `sendReorder` that forgot
 * to pass its deadline through would hang this test rather than pass it.
 */
const silent = (): ReorderFetch =>
  vi.fn(
    (_path, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init.signal;
        if (signal == null) return; // never settles: the test times out, loudly
        signal.addEventListener('abort', () => {
          reject(signal.reason);
        });
      }),
  );

// ---------------------------------------------------------------------------
// The branch table
// ---------------------------------------------------------------------------

describe('sendReorder, branch by branch', () => {
  it('reports the applied plan when the endpoint returns one this tree can apply', async () => {
    const outcome = await sendReorder(answering(jsonResponse(APPLIED_BODY)), ITEM_INTENT, TREE);

    expect(outcome).toEqual({
      kind: 'applied',
      plan: { runs: APPLIED_BODY.runs, reparent: null },
    });
    expect(reorderNotice(outcome)).toEqual({ text: REORDER_SAVED_MESSAGE, kind: 'status' });
    expect(reorderRevertsTree(outcome)).toBe(false);
  });

  /**
   * THE ONE THE REVIEW CALLED OUT FIRST. A 200 whose body this client cannot read is a
   * proxy interstitial, a cached page, a truncated body or a shape a deploy changed under an
   * open tab. The only evidence of a write is the status code, and "Saved" is not a thing
   * that may be said on that evidence.
   */
  it('does not claim success for a 2xx whose body it cannot read', async () => {
    const outcome = await sendReorder(
      answering(response('<html>Gateway</html>')),
      ITEM_INTENT,
      TREE,
    );

    expect(outcome).toEqual({ kind: 'unconfirmed' });
    expect(reorderNotice(outcome)).toEqual({ text: REORDER_UNCONFIRMED_MESSAGE, kind: 'error' });
    expect(reorderNotice(outcome).text).not.toBe(REORDER_SAVED_MESSAGE);
    // Kept, not reverted: the move most likely landed, and this island's own prediction came
    // from the same functions the endpoint plans with.
    expect(reorderRevertsTree(outcome)).toBe(false);
  });

  it('does not claim success for a 2xx carrying JSON that is not a plan', async () => {
    const outcome = await sendReorder(
      answering(jsonResponse({ ok: true, runs: 'all of them' })),
      ITEM_INTENT,
      TREE,
    );

    expect(outcome).toEqual({ kind: 'unconfirmed' });
  });

  /**
   * THE REVERSE OF THE SKIP `applyReorderPlan` PERFORMS ON PURPOSE. A plan omitting a row
   * means that row's position is already right; a plan NAMING a row this tree lacks means
   * the two disagree about what is in the pack — two tabs on one pack, which is ordinary.
   * The write landed; the list on screen is what cannot be trusted.
   */
  it('reports a stale tree when the returned plan names a row this tree does not have', async () => {
    const outcome = await sendReorder(
      answering(
        jsonResponse({
          ok: true,
          runs: [
            {
              parentId: CATEGORY_A,
              updates: [
                { id: ITEM_1, position: 0 },
                { id: ITEM_ELSEWHERE, position: 1 },
              ],
            },
          ],
          reparent: null,
        }),
      ),
      ITEM_INTENT,
      TREE,
    );

    expect(outcome).toEqual({ kind: 'stale' });
    expect(reorderNotice(outcome)).toEqual({ text: REORDER_STALE_MESSAGE, kind: 'error' });
    expect(reorderNotice(outcome).text).not.toBe(REORDER_SAVED_MESSAGE);
    // The move was saved, so putting the pre-drag order back would be wrong in the other
    // direction. The sentence asks for a reload instead.
    expect(reorderRevertsTree(outcome)).toBe(false);
  });

  it('reports a stale tree when a reparent names a category this tree does not have', async () => {
    const outcome = await sendReorder(
      answering(
        jsonResponse({
          ok: true,
          runs: [],
          reparent: { id: ITEM_1, parentId: '77777777-7777-4777-8777-777777777777' },
        }),
      ),
      ITEM_INTENT,
      TREE,
    );

    expect(outcome).toEqual({ kind: 'stale' });
  });

  it("shows the endpoint's own sentence for a non-2xx", async () => {
    const outcome = await sendReorder(
      answering(jsonResponse({ ok: false, message: 'That pack is locked.' }, { status: 409 })),
      ITEM_INTENT,
      TREE,
    );

    expect(outcome).toEqual({ kind: 'refused', message: 'That pack is locked.' });
    expect(reorderNotice(outcome)).toEqual({ text: 'That pack is locked.', kind: 'error' });
    expect(reorderRevertsTree(outcome)).toBe(true);
  });

  it('falls back to its own sentence for a non-2xx with no readable message', async () => {
    const outcome = await sendReorder(
      answering(response('Bad Gateway', { status: 502 })),
      ITEM_INTENT,
      TREE,
    );

    expect(outcome).toEqual({ kind: 'refused', message: REORDER_SAVE_FAILED_MESSAGE });
  });

  /**
   * The signed-out case is checked BEFORE `ok`, and this test is what pins the order.
   * `fetch` follows the endpoint's 303 to sign-in, so what arrives is the sign-in PAGE with
   * a 200: read as a body it is unparseable, and reported as `unconfirmed` it would tell a
   * visitor whose session merely expired that their move might have been saved.
   */
  it('recognises a followed redirect to sign-in rather than reading the sign-in page', async () => {
    const outcome = await sendReorder(
      answering(response('<html>Sign in</html>', { redirected: true })),
      ITEM_INTENT,
      TREE,
    );

    expect(outcome).toEqual({ kind: 'signedOut' });
    expect(reorderNotice(outcome)).toEqual({ text: REORDER_SIGNED_OUT_MESSAGE, kind: 'error' });
    expect(reorderRevertsTree(outcome)).toBe(true);
  });

  /**
   * THE BRANCH THAT DID NOT EXIST. `fetch` has no timeout, so a stalled request never
   * settled: no `catch`, no `finally`, `pending` stuck true, and — because `draggable` is
   * gated on `!pending` — every row in the pack silently undraggable with no notice on
   * screen. The stub here is a connection that stays open and answers only to the abort.
   */
  it('gives up on a request that is never answered, and says so as a timeout', async () => {
    const send = silent();
    const outcome = await sendReorder(send, ITEM_INTENT, TREE, 5);

    expect(outcome).toEqual({ kind: 'timedOut' });
    expect(reorderNotice(outcome)).toEqual({ text: REORDER_TIMEOUT_MESSAGE, kind: 'error' });
    // The request may well have been applied, so the optimistic order stays and the sentence
    // promises nothing about the database.
    expect(reorderRevertsTree(outcome)).toBe(false);
    expect(reorderNotice(outcome).text).not.toBe(REORDER_OFFLINE_MESSAGE);
  });

  it('passes its deadline to fetch as an abort signal', async () => {
    const send = silent();
    await sendReorder(send, ITEM_INTENT, TREE, 5);

    const init = vi.mocked(send).mock.calls[0][1];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal?.aborted).toBe(true);
  });

  it('reports a rejected fetch as offline, which is the only branch that promises the pack is unchanged', async () => {
    const send: ReorderFetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const outcome = await sendReorder(send, ITEM_INTENT, TREE);

    expect(outcome).toEqual({ kind: 'offline' });
    expect(reorderNotice(outcome)).toEqual({ text: REORDER_OFFLINE_MESSAGE, kind: 'error' });
    expect(reorderRevertsTree(outcome)).toBe(true);
  });

  /**
   * A timeout and a dropped connection arrive through the same `catch` and must not produce
   * the same sentence. Asserted as a pair rather than separately because what matters is the
   * DIFFERENCE: only one of the two may say the pack is unchanged.
   */
  it('never tells a visitor the pack is unchanged after a timeout', () => {
    expect(REORDER_TIMEOUT_MESSAGE).not.toBe(REORDER_OFFLINE_MESSAGE);
    expect(REORDER_OFFLINE_MESSAGE).toContain('the pack is unchanged');
    expect(REORDER_TIMEOUT_MESSAGE).not.toContain('unchanged');
  });
});

// ---------------------------------------------------------------------------
// The request it sends
// ---------------------------------------------------------------------------

describe('the request sendReorder makes', () => {
  it('POSTs the intent verbatim as JSON to the one reorder path', async () => {
    const send = answering(jsonResponse(APPLIED_BODY));
    await sendReorder(send, ITEM_INTENT, TREE);

    const [path, init] = vi.mocked(send).mock.calls[0];
    expect(path).toBe(PACK_REORDER_PATH);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'content-type': 'application/json' });
    // Verbatim: the field names ARE the intent's property names (see REORDER_FIELD), so
    // there is no translation step between what the island computes and what
    // `parseReorderIntent` reads.
    expect(JSON.parse(String(init.body))).toEqual(ITEM_INTENT);
  });

  it('does not mutate the tree it was handed', async () => {
    const before = structuredClone(TREE);
    await sendReorder(answering(jsonResponse(APPLIED_BODY)), ITEM_INTENT, TREE);
    expect(TREE).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// The notice table, whole
// ---------------------------------------------------------------------------

describe('reorderNotice and reorderRevertsTree', () => {
  const OUTCOMES: readonly ReorderOutcome[] = [
    { kind: 'applied', plan: { runs: [], reparent: null } },
    { kind: 'unconfirmed' },
    { kind: 'stale' },
    { kind: 'refused', message: 'Something specific.' },
    { kind: 'signedOut' },
    { kind: 'timedOut' },
    { kind: 'offline' },
  ];

  it('gives every outcome a non-empty sentence', () => {
    for (const outcome of OUTCOMES) {
      expect(reorderNotice(outcome).text).not.toBe('');
    }
  });

  /** The correction, asserted as one statement: success is the only thing that reads as
   *  success. Six outcomes, six errors. */
  it('marks exactly one outcome as a status and the other six as errors', () => {
    const statuses = OUTCOMES.filter((outcome) => reorderNotice(outcome).kind === 'status');
    expect(statuses).toEqual([{ kind: 'applied', plan: { runs: [], reparent: null } }]);
  });

  it('reverts only the three outcomes in which the server said no or was never reached', () => {
    const reverting = OUTCOMES.filter(reorderRevertsTree).map((outcome) => outcome.kind);
    expect(reverting).toEqual(['refused', 'signedOut', 'offline']);
  });
});

// ---------------------------------------------------------------------------
// The payload readers
// ---------------------------------------------------------------------------

describe('messageOf', () => {
  it('reads a non-empty string message', () => {
    expect(messageOf({ ok: false, message: 'No.' })).toBe('No.');
  });

  it('refuses everything that is not one', () => {
    expect(messageOf(null)).toBeNull();
    expect(messageOf(undefined)).toBeNull();
    expect(messageOf('a bare string')).toBeNull();
    expect(messageOf({})).toBeNull();
    expect(messageOf({ message: '' })).toBeNull();
    expect(messageOf({ message: 42 })).toBeNull();
  });
});

describe('readUpdates', () => {
  it('reads a well-formed run', () => {
    expect(
      readUpdates([
        { id: 'a', position: 0 },
        { id: 'b', position: 1 },
      ]),
    ).toEqual([
      { id: 'a', position: 0 },
      { id: 'b', position: 1 },
    ]);
  });

  it('accepts an empty array, which is a run whose positions all already agree', () => {
    expect(readUpdates([])).toEqual([]);
  });

  /**
   * F8, and the reason the test is a list rather than one case. Every position this can ever
   * receive is `denseUpdates`' own `forEach` index in `src/lib/packs/reorder.ts` — a safe
   * non-negative integer. `Number.isFinite`, which this used until PK-37's review, admits
   * all four values below; each of them would have been written into a row's `position` and
   * then sorted on.
   */
  it.each([
    ['a fraction', 0.5],
    ['a negative', -1],
    ['beyond the safe integers', Number.MAX_SAFE_INTEGER + 2],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('refuses %s as a position, because a position is an array index', (_label, position) => {
    expect(readUpdates([{ id: 'a', position }])).toBeNull();
  });

  it('refuses anything that is not an array of id/position objects', () => {
    expect(readUpdates(undefined)).toBeNull();
    expect(readUpdates({ id: 'a', position: 0 })).toBeNull();
    expect(readUpdates([null])).toBeNull();
    expect(readUpdates(['a'])).toBeNull();
    expect(readUpdates([{ id: 1, position: 0 }])).toBeNull();
    expect(readUpdates([{ id: 'a' }])).toBeNull();
  });

  /** One bad entry refuses the WHOLE run rather than the entry: a partially applied plan
   *  renders an order nobody chose, which is the failure `planOf`'s comment describes. */
  it('refuses the whole run for one bad entry', () => {
    expect(
      readUpdates([
        { id: 'a', position: 0 },
        { id: 'b', position: 'second' },
      ]),
    ).toBeNull();
  });
});

describe('planOf', () => {
  it('reads the shape the endpoint spreads', () => {
    expect(planOf(APPLIED_BODY)).toEqual({ runs: APPLIED_BODY.runs, reparent: null });
  });

  it('reads a plan carrying a reparent', () => {
    expect(planOf({ ok: true, runs: [], reparent: { id: ITEM_1, parentId: CATEGORY_B } })).toEqual({
      runs: [],
      reparent: { id: ITEM_1, parentId: CATEGORY_B },
    });
  });

  /** An omitted `reparent` and a null one are the same plan. The endpoint always sends the
   *  key — it spreads a whole `ReorderPlan` — but a client that refused an absent one would
   *  be refusing a body it has no reason to. */
  it('treats an absent reparent as no reparent', () => {
    expect(planOf({ ok: true, runs: [] })).toEqual({ runs: [], reparent: null });
  });

  it('refuses a body that does not say ok: true', () => {
    expect(planOf({ runs: [] })).toBeNull();
    expect(planOf({ ok: 'true', runs: [] })).toBeNull();
    expect(planOf({ ok: false, message: 'no' })).toBeNull();
  });

  it('refuses anything that is not an object with an array of runs', () => {
    expect(planOf(null)).toBeNull();
    expect(planOf(undefined)).toBeNull();
    expect(planOf('ok')).toBeNull();
    expect(planOf({ ok: true })).toBeNull();
    expect(planOf({ ok: true, runs: {} })).toBeNull();
  });

  it('refuses a run with no parentId or with malformed updates', () => {
    expect(planOf({ ok: true, runs: [{ updates: [] }] })).toBeNull();
    expect(planOf({ ok: true, runs: [{ parentId: 1, updates: [] }] })).toBeNull();
    expect(planOf({ ok: true, runs: [{ parentId: 'a', updates: 'none' }] })).toBeNull();
    expect(planOf({ ok: true, runs: [null] })).toBeNull();
  });

  it('refuses a half-written reparent', () => {
    expect(planOf({ ok: true, runs: [], reparent: { id: ITEM_1 } })).toBeNull();
    expect(planOf({ ok: true, runs: [], reparent: { parentId: CATEGORY_B } })).toBeNull();
    expect(planOf({ ok: true, runs: [], reparent: 'somewhere' })).toBeNull();
  });
});
