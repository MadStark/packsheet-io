import { describe, expect, it } from 'vitest';
import {
  REORDER_BODY_MESSAGE,
  REORDER_CATEGORY_MISSING_MESSAGE,
  REORDER_FIELD,
  REORDER_ID_MESSAGE,
  REORDER_INDEX_MESSAGE,
  REORDER_ITEM_MISSING_MESSAGE,
  REORDER_TARGET,
  REORDER_TARGET_MESSAGE,
  parseReorderIntent,
  planChangesAnything,
  planReorderIntent,
  type ReorderPackRows,
} from '../src/lib/packs/reorder-request';

/**
 * `src/lib/packs/reorder-request.ts` — the only thing standing between a JSON body and a
 * write, and therefore the module in PK-37 whose failures are least visible from anywhere
 * else.
 *
 * The endpoint that uses it lives in `src/pages/`, which `vitest.config.ts:64` excludes
 * from collection, so every rule asserted here is one that could otherwise be inverted with
 * a green suite. Two of them are the ticket's own acceptance criteria and are worth naming:
 *
 *   - THE CLIENT SENDS AN INTENT AND NEVER A POSITION. Asserted here as a property of the
 *     parser's OUTPUT — there is no field a position could survive in — and again in
 *     tests/packs-reorder-endpoint.test.ts against a body that tries to send one anyway.
 *   - THE SOURCE RUN IS FOUND, NOT SUPPLIED. A request says where an item is going; where
 *     it came from is read out of the tree, so a body cannot nominate the wrong siblings.
 */

const PACK_ID = '11111111-1111-4111-8111-111111111111';
const CATEGORY_A = '22222222-2222-4222-8222-222222222222';
const CATEGORY_B = '33333333-3333-4333-8333-333333333333';
const ITEM_1 = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const ITEM_2 = 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa';
const ITEM_3 = 'aaaaaaaa-3333-4333-8333-aaaaaaaaaaaa';
const ITEM_4 = 'aaaaaaaa-4444-4444-8444-aaaaaaaaaaaa';

/** Two categories, three items in the first and one in the second — the smallest tree that
 *  can express a same-category move, a cross-category move, and a category move without any
 *  of the three degenerating into a special case. */
const PACK: ReorderPackRows = {
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

const itemBody = (overrides: Record<string, unknown> = {}) => ({
  [REORDER_FIELD.target]: REORDER_TARGET.item,
  [REORDER_FIELD.packId]: PACK_ID,
  [REORDER_FIELD.itemId]: ITEM_1,
  [REORDER_FIELD.toCategoryId]: CATEGORY_A,
  [REORDER_FIELD.toIndex]: 2,
  ...overrides,
});

const categoryBody = (overrides: Record<string, unknown> = {}) => ({
  [REORDER_FIELD.target]: REORDER_TARGET.category,
  [REORDER_FIELD.packId]: PACK_ID,
  [REORDER_FIELD.categoryId]: CATEGORY_B,
  [REORDER_FIELD.toIndex]: 0,
  ...overrides,
});

describe('parseReorderIntent', () => {
  it('reads a well-formed item move', () => {
    const result = parseReorderIntent(itemBody());

    expect(result).toEqual({
      ok: true,
      value: {
        target: 'item',
        packId: PACK_ID,
        itemId: ITEM_1,
        toCategoryId: CATEGORY_A,
        toIndex: 2,
      },
    });
  });

  it('reads a well-formed category move, which has no destination to read', () => {
    const result = parseReorderIntent(categoryBody());

    expect(result).toEqual({
      ok: true,
      value: { target: 'category', packId: PACK_ID, categoryId: CATEGORY_B, toIndex: 0 },
    });
  });

  /**
   * THE RULE THIS WHOLE MODULE EXISTS FOR. A body carrying computed positions — the exact
   * `ReorderPlan` the island produces for its own optimistic render — parses to an intent
   * with no trace of them. Not because they are rejected, but because there is no field to
   * put them in: see the module's header on why "cannot be expressed" is a stronger
   * property than "is validated against".
   */
  it('drops anything a body says about positions, because there is nowhere for it to land', () => {
    const result = parseReorderIntent(
      itemBody({
        runs: [{ parentId: CATEGORY_A, updates: [{ id: ITEM_2, position: 0 }] }],
        positions: [{ id: ITEM_1, position: 0 }],
        position: 99,
        reparent: { id: ITEM_1, parentId: CATEGORY_B },
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.value).sort()).toEqual([
      'itemId',
      'packId',
      'target',
      'toCategoryId',
      'toIndex',
    ]);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', '{"target":"item"}'],
    ['a number', 7],
    ['an array', [{ target: 'item' }]],
  ])('refuses %s as a body rather than throwing', (_label, body) => {
    expect(parseReorderIntent(body)).toEqual({ ok: false, message: REORDER_BODY_MESSAGE });
  });

  it.each([
    ['no target', {}],
    ['an unknown target', { target: 'pack' }],
    ['a target of the wrong type', { target: 1 }],
  ])('refuses %s', (_label, extra) => {
    const body = { [REORDER_FIELD.packId]: PACK_ID, [REORDER_FIELD.toIndex]: 0, ...extra };
    expect(parseReorderIntent(body)).toEqual({ ok: false, message: REORDER_TARGET_MESSAGE });
  });

  it.each([
    ['a missing pack id', { [REORDER_FIELD.packId]: undefined }],
    ['a pack id that is not a uuid', { [REORDER_FIELD.packId]: 'reorder' }],
    ['a pack id that is nearly a uuid', { [REORDER_FIELD.packId]: `${PACK_ID}x` }],
    ['a missing item id', { [REORDER_FIELD.itemId]: undefined }],
    ['an item id of the wrong type', { [REORDER_FIELD.itemId]: 42 }],
    ['a missing destination category', { [REORDER_FIELD.toCategoryId]: undefined }],
    ['an injected destination category', { [REORDER_FIELD.toCategoryId]: '1 OR 1=1' }],
  ])('refuses %s', (_label, overrides) => {
    expect(parseReorderIntent(itemBody(overrides))).toEqual({
      ok: false,
      message: REORDER_ID_MESSAGE,
    });
  });

  // Ids are lower-cased on the way through so two spellings of one id cannot become two —
  // the same normalisation compareByPosition applies for a sharper reason of its own.
  it('accepts an upper-cased uuid and normalises it', () => {
    const result = parseReorderIntent(itemBody({ [REORDER_FIELD.itemId]: ITEM_1.toUpperCase() }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({ itemId: ITEM_1 });
  });

  it.each([
    ['a missing index', undefined],
    ['a string index', '2'],
    ['a fractional index', 1.5],
    ['a negative index', -1],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['null', null],
  ])('refuses %s', (_label, toIndex) => {
    expect(parseReorderIntent(itemBody({ [REORDER_FIELD.toIndex]: toIndex }))).toEqual({
      ok: false,
      message: REORDER_INDEX_MESSAGE,
    });
  });

  /**
   * The one out-of-range value that is NOT refused, and the reason it is not: an index past
   * the end of a run is what an ordinary race produces (a sibling deleted in another tab
   * while the pointer was down), and `clampTargetIndex` reads it as "as far towards the end
   * as the run goes". Refusing it here would turn a benign race into an error on a drag the
   * visitor would swear worked. Asserted so that "tighten the validation" cannot be done by
   * accident.
   */
  it('accepts an index past the end of any run, which the plan then clamps', () => {
    const result = parseReorderIntent(itemBody({ [REORDER_FIELD.toIndex]: 9000 }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.toIndex).toBe(9000);

    const planned = planReorderIntent(PACK, result.value);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    // Clamped to the end of the three-item run it is already in: 0,1,2 becomes 1,2,0 with
    // the moved row last, not an error and not position 9000.
    expect(planned.value.runs).toEqual([
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

describe('planReorderIntent', () => {
  it('reindexes one run for a move that stays inside its category', () => {
    const intent = parseReorderIntent(itemBody({ [REORDER_FIELD.toIndex]: 2 }));
    expect(intent.ok).toBe(true);
    if (!intent.ok) return;

    const planned = planReorderIntent(PACK, intent.value);

    expect(planned).toEqual({
      ok: true,
      value: {
        runs: [
          {
            parentId: CATEGORY_A,
            updates: [
              { id: ITEM_2, position: 0 },
              { id: ITEM_3, position: 1 },
              { id: ITEM_1, position: 2 },
            ],
          },
        ],
        reparent: null,
      },
    });
  });

  /**
   * Both runs are rewritten, and the reparent is separate from the positions. The source
   * closes the gap the item left and the destination opens one for it — returning only the
   * destination would leave the source's numbering with a hole, which reads fine right up
   * until the next insert lands on a duplicate position.
   */
  it('rewrites both runs and names the reparent for a cross-category move', () => {
    const intent = parseReorderIntent(
      itemBody({ [REORDER_FIELD.toCategoryId]: CATEGORY_B, [REORDER_FIELD.toIndex]: 0 }),
    );
    expect(intent.ok).toBe(true);
    if (!intent.ok) return;

    const planned = planReorderIntent(PACK, intent.value);

    expect(planned).toEqual({
      ok: true,
      value: {
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
      },
    });
  });

  it('reindexes the pack’s own run for a category move', () => {
    const intent = parseReorderIntent(categoryBody());
    expect(intent.ok).toBe(true);
    if (!intent.ok) return;

    const planned = planReorderIntent(PACK, intent.value);

    expect(planned).toEqual({
      ok: true,
      value: {
        runs: [
          {
            parentId: PACK_ID,
            updates: [
              { id: CATEGORY_B, position: 0 },
              { id: CATEGORY_A, position: 1 },
            ],
          },
        ],
        reparent: null,
      },
    });
  });

  /**
   * THE SOURCE RUN IS A FACT ABOUT THE DATABASE, NOT SOMETHING THE REQUEST SAYS. This is
   * the assertion behind that claim: the item's own category is located by searching the
   * tree, so the plan renumbers the run the item is actually in — even when the request
   * names a different one as its destination. A protocol that took `fromCategoryId` from
   * the body could be handed the wrong siblings and would compute a perfectly consistent,
   * wrong plan.
   */
  it('finds the source run in the tree rather than taking the caller’s word for it', () => {
    const intent = parseReorderIntent(
      itemBody({ [REORDER_FIELD.itemId]: ITEM_4, [REORDER_FIELD.toCategoryId]: CATEGORY_A }),
    );
    expect(intent.ok).toBe(true);
    if (!intent.ok) return;

    const planned = planReorderIntent(PACK, intent.value);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.value.reparent).toEqual({ id: ITEM_4, parentId: CATEGORY_A });
    // The source run is CATEGORY_B, which the request never mentioned. It is left with no
    // updates because emptying a one-row run changes nothing about the rows that remain.
    expect(planned.value.runs.map((run) => run.parentId)).toEqual([CATEGORY_A]);
  });

  it('refuses an item this pack does not hold', () => {
    const intent = parseReorderIntent(
      itemBody({ [REORDER_FIELD.itemId]: '99999999-9999-4999-8999-999999999999' }),
    );
    expect(intent.ok).toBe(true);
    if (!intent.ok) return;

    expect(planReorderIntent(PACK, intent.value)).toEqual({
      ok: false,
      message: REORDER_ITEM_MISSING_MESSAGE,
    });
  });

  it.each([
    [
      'a destination category this pack does not have',
      itemBody({ [REORDER_FIELD.toCategoryId]: '99999999-9999-4999-8999-999999999999' }),
    ],
    [
      'a category this pack does not have',
      categoryBody({ [REORDER_FIELD.categoryId]: '99999999-9999-4999-8999-999999999999' }),
    ],
  ])('refuses %s', (_label, body) => {
    const intent = parseReorderIntent(body);
    expect(intent.ok).toBe(true);
    if (!intent.ok) return;

    expect(planReorderIntent(PACK, intent.value)).toEqual({
      ok: false,
      message: REORDER_CATEGORY_MISSING_MESSAGE,
    });
  });

  // An empty pack is a valid pack (the editor renders it as an ordinary empty state), so a
  // reorder against one has to answer rather than throw.
  it('refuses a move against a pack with no categories at all', () => {
    const intent = parseReorderIntent(itemBody());
    expect(intent.ok).toBe(true);
    if (!intent.ok) return;

    expect(planReorderIntent({ pack_categories: [] }, intent.value)).toEqual({
      ok: false,
      message: REORDER_ITEM_MISSING_MESSAGE,
    });
  });

  /**
   * `reorder.ts` throws on rows it cannot plan against — a duplicated id gives one row two
   * positions, and the outcome would then depend on the order the RPC applied the pairs in.
   * That is the right behaviour for a pure function shared with the island and the wrong
   * one for an HTTP handler, so it is caught here and returned as a sentence: a 500 with a
   * stack trace is not a better answer than "reload the pack".
   */
  it('turns a tree reorder.ts refuses into a message rather than an exception', () => {
    const corrupt: ReorderPackRows = {
      pack_categories: [
        {
          id: CATEGORY_A,
          position: 0,
          pack_items: [
            { id: ITEM_1, position: 0 },
            { id: ITEM_1, position: 1 },
          ],
        },
      ],
    };
    const intent = parseReorderIntent(itemBody());
    expect(intent.ok).toBe(true);
    if (!intent.ok) return;

    const planned = planReorderIntent(corrupt, intent.value);

    expect(planned.ok).toBe(false);
    if (planned.ok) return;
    // Not the thrown text, which names a row id and an internal function.
    expect(planned.message).not.toMatch(/appears more than once/);
  });
});

describe('planChangesAnything', () => {
  it('is false for a drag that ended where it began', () => {
    const intent = parseReorderIntent(itemBody({ [REORDER_FIELD.toIndex]: 0 }));
    expect(intent.ok).toBe(true);
    if (!intent.ok) return;

    const planned = planReorderIntent(PACK, intent.value);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.value).toEqual({ runs: [], reparent: null });
    expect(planChangesAnything(planned.value)).toBe(false);
  });

  /**
   * The case that makes this a function rather than `runs.length > 0`: dragging the only
   * item of one category into an empty one leaves its position at 0 before and after, so
   * both runs' update lists are empty while the move is entirely real. A caller reading an
   * empty `runs` as "nothing to do" would lose it.
   */
  it('is true for a move whose only effect is a reparent', () => {
    const pack: ReorderPackRows = {
      pack_categories: [
        { id: CATEGORY_A, position: 0, pack_items: [{ id: ITEM_1, position: 0 }] },
        { id: CATEGORY_B, position: 1, pack_items: [] },
      ],
    };
    const intent = parseReorderIntent(
      itemBody({ [REORDER_FIELD.toCategoryId]: CATEGORY_B, [REORDER_FIELD.toIndex]: 0 }),
    );
    expect(intent.ok).toBe(true);
    if (!intent.ok) return;

    const planned = planReorderIntent(pack, intent.value);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.value.runs).toEqual([]);
    expect(planned.value.reparent).toEqual({ id: ITEM_1, parentId: CATEGORY_B });
    expect(planChangesAnything(planned.value)).toBe(true);
  });
});
