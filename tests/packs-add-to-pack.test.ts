import { describe, expect, it } from 'vitest';
import {
  ADD_CATEGORY_PARAM,
  ADD_TAB_PARAM,
  ADD_TO_PACK_FIELD,
  ADD_TO_PACK_MODAL_ID,
  ADD_TO_PACK_TABS,
  ADD_TO_PACK_TAB_LABELS,
  ALSO_ADD_TO_CLOSET_VALUE,
  addToPackHref,
  alsoAddToClosetKey,
  customItemToGearInput,
  defaultAddToPackTab,
  isAddToPackTab,
  parseAddToPackRequest,
  readAlsoAddToCloset,
  submissionAlsoAddsToCloset,
  writeAlsoAddToCloset,
} from '../src/lib/packs/add-to-pack';
import type { CustomPackItemInput } from '../src/lib/packs/form';
import type { CurrencyCode } from '../src/lib/money';

/** Matches `tests/money.test.ts` and `tests/packs-mutations.test.ts`: `CurrencyCode` is a
 *  branded string only `isCurrencyCode` can narrow into at runtime, so a fixture that wants
 *  a specific currency without going through form parsing casts it, once, here. */
const GBP = 'GBP' as CurrencyCode;

/**
 * `src/lib/packs/add-to-pack.ts` — the "add an item to a pack category" dialog's pure
 * decisions (PK-74), tested where they live rather than where they render.
 * `vitest.config.ts:64` excludes `src/pages/**`, and every function here fails SILENTLY
 * when it is wrong — a bad `?tab=` falling back to a stale render, a category id from
 * another pack opening a dialog aimed at nothing, a `localStorage` access throwing and
 * taking a dialog open down with it — so this file is what makes those failures loud.
 */

const CATEGORY_A = '22222222-2222-4222-8222-222222222222';
const CATEGORY_B = '33333333-3333-4333-8333-333333333333';
const UNKNOWN = '99999999-9999-4999-8999-999999999999';
const PACK_URL = '/packs/11111111-1111-4111-8111-111111111111';

/** A storage double whose named method throws, mirroring exactly what Safari private mode
 *  and "block all cookies" do to a real `Storage` — see `readAlsoAddToCloset`'s own
 *  comment for why this is not a hypothetical to guard against. */
function throwingStorage(method: 'getItem' | 'setItem' | 'removeItem'): Storage {
  const storage = new Map<string, string>();
  const base: Storage = {
    get length() {
      return storage.size;
    },
    clear: () => storage.clear(),
    key: (index: number) => Array.from(storage.keys())[index] ?? null,
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
    removeItem: (key: string) => {
      storage.delete(key);
    },
  };
  return {
    ...base,
    [method]: () => {
      throw new Error(`${method} is blocked`);
    },
  };
}

/** A working, in-memory `Storage`, for the round-trip cases. */
function memoryStorage(): Storage {
  const storage = new Map<string, string>();
  return {
    get length() {
      return storage.size;
    },
    clear: () => storage.clear(),
    key: (index: number) => Array.from(storage.keys())[index] ?? null,
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
    removeItem: (key: string) => {
      storage.delete(key);
    },
  };
}

// ---------------------------------------------------------------------------
// Constants pinned against literals, so markup and parser cannot drift
// ---------------------------------------------------------------------------

describe('ADD_TO_PACK_MODAL_ID, ADD_CATEGORY_PARAM, ADD_TAB_PARAM', () => {
  // Pinned because a rename here is invisible: a `<Modal id>` or a query parameter the
  // markup still spells the old way simply never matches, and the dialog silently never
  // opens rather than erroring.
  it('names the modal id and the two query parameters the dialog is driven by', () => {
    expect(ADD_TO_PACK_MODAL_ID).toBe('add-to-pack');
    expect(ADD_CATEGORY_PARAM).toBe('add');
    expect(ADD_TAB_PARAM).toBe('tab');
  });
});

describe('ADD_TO_PACK_TABS / ADD_TO_PACK_TAB_LABELS', () => {
  it('names the two tabs, in render order', () => {
    expect(ADD_TO_PACK_TABS).toEqual(['closet', 'new']);
  });

  it('labels both tabs, and only the two tabs that exist', () => {
    expect(ADD_TO_PACK_TAB_LABELS).toEqual({
      closet: 'From closet',
      new: 'New item',
    });
  });
});

describe('ADD_TO_PACK_FIELD / ALSO_ADD_TO_CLOSET_VALUE', () => {
  it('names the checkbox field and the value a ticked box submits', () => {
    expect(ADD_TO_PACK_FIELD).toEqual({ alsoAddToCloset: 'also_add_to_closet' });
    expect(ALSO_ADD_TO_CLOSET_VALUE).toBe('on');
  });
});

describe('isAddToPackTab', () => {
  it('accepts the two real tabs', () => {
    expect(isAddToPackTab('closet')).toBe(true);
    expect(isAddToPackTab('new')).toBe(true);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a near-miss spelling', 'Closet'],
    ['a plausible but wrong value', 'from-closet'],
    ['an empty string', ''],
    ['a number', 1],
  ])('refuses %s', (_label, value) => {
    expect(isAddToPackTab(value)).toBe(false);
  });
});

describe('defaultAddToPackTab', () => {
  // The acceptance criterion this function exists to pin: a visitor with nothing in their
  // closet must not land on a tab listing zero items when the other tab is one click away
  // from adding something.
  it('opens on "new" for an empty closet', () => {
    expect(defaultAddToPackTab(0)).toBe('new');
  });

  it('opens on "closet" once the closet holds anything at all', () => {
    expect(defaultAddToPackTab(1)).toBe('closet');
    expect(defaultAddToPackTab(50)).toBe('closet');
  });
});

// ---------------------------------------------------------------------------
// submissionAlsoAddsToCloset
// ---------------------------------------------------------------------------

describe('submissionAlsoAddsToCloset', () => {
  function form(entries: Record<string, string | string[]>): FormData {
    const data = new FormData();
    for (const [key, value] of Object.entries(entries)) {
      if (Array.isArray(value)) {
        for (const v of value) data.append(key, v);
      } else {
        data.append(key, value);
      }
    }
    return data;
  }

  it("reads the markup's own checkbox value as ticked", () => {
    expect(
      submissionAlsoAddsToCloset(
        form({ [ADD_TO_PACK_FIELD.alsoAddToCloset]: ALSO_ADD_TO_CLOSET_VALUE }),
      ),
    ).toBe(true);
  });

  it('reads an unticked box — the field simply absent — as false', () => {
    expect(submissionAlsoAddsToCloset(form({}))).toBe(false);
  });

  it.each([
    ['off', 'off'],
    ['0', '0'],
    ['false', 'false'],
    ['garbage', 'not-a-real-value'],
  ])('refuses %s rather than treating any non-empty string as ticked', (_label, value) => {
    expect(submissionAlsoAddsToCloset(form({ [ADD_TO_PACK_FIELD.alsoAddToCloset]: value }))).toBe(
      false,
    );
  });

  it('reads only the first value of a field submitted twice', () => {
    expect(
      submissionAlsoAddsToCloset(form({ [ADD_TO_PACK_FIELD.alsoAddToCloset]: ['off', 'on'] })),
    ).toBe(false);
  });

  it("refuses a File posted under this field's name without throwing", () => {
    const data = new FormData();
    data.append(ADD_TO_PACK_FIELD.alsoAddToCloset, new File(['x'], 'f.txt'));
    expect(submissionAlsoAddsToCloset(data)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// addToPackHref / parseAddToPackRequest — a matched, round-tripping pair
// ---------------------------------------------------------------------------

describe('addToPackHref → parseAddToPackRequest round trip', () => {
  it('opens the same category on the same tab it was built for', () => {
    const href = addToPackHref(PACK_URL, CATEGORY_A, 'new');
    const url = new URL(href, 'https://example.test');

    // closetCount is 3 here specifically so the round trip only passes because the tab
    // came from the URL — if addToPackHref had silently dropped `tab`, this would read
    // back as 'closet' (defaultAddToPackTab(3)) instead of the 'new' it was built with.
    expect(parseAddToPackRequest(url.searchParams, [CATEGORY_A, CATEGORY_B], 3)).toEqual({
      categoryId: CATEGORY_A,
      tab: 'new',
    });
  });

  it('omitting the tab leaves the default free to answer fresh from the closet count', () => {
    const href = addToPackHref(PACK_URL, CATEGORY_A);
    const url = new URL(href, 'https://example.test');

    expect(parseAddToPackRequest(url.searchParams, [CATEGORY_A], 0)).toEqual({
      categoryId: CATEGORY_A,
      tab: 'new',
    });
    expect(parseAddToPackRequest(url.searchParams, [CATEGORY_A], 1)).toEqual({
      categoryId: CATEGORY_A,
      tab: 'closet',
    });
  });
});

describe('parseAddToPackRequest', () => {
  it('opens the named category on the requested tab', () => {
    const params = new URLSearchParams({
      [ADD_CATEGORY_PARAM]: CATEGORY_A,
      [ADD_TAB_PARAM]: 'new',
    });

    expect(parseAddToPackRequest(params, [CATEGORY_A, CATEGORY_B], 5)).toEqual({
      categoryId: CATEGORY_A,
      tab: 'new',
    });
  });

  it('falls back to the closet-count default when no tab is given', () => {
    const withCloset = new URLSearchParams({ [ADD_CATEGORY_PARAM]: CATEGORY_A });
    const empty = new URLSearchParams({ [ADD_CATEGORY_PARAM]: CATEGORY_A });

    expect(parseAddToPackRequest(withCloset, [CATEGORY_A], 2)).toEqual({
      categoryId: CATEGORY_A,
      tab: 'closet',
    });
    expect(parseAddToPackRequest(empty, [CATEGORY_A], 0)).toEqual({
      categoryId: CATEGORY_A,
      tab: 'new',
    });
  });

  // THE ACCEPTANCE CRITERION: an `?add=` naming a category not in THIS pack — a stale
  // bookmark, a second tab that deleted it first, a hand-edited query string — must open no
  // dialog at all rather than one aimed at a category the page has nothing to render.
  it('refuses a category id that does not belong to this pack', () => {
    const params = new URLSearchParams({ [ADD_CATEGORY_PARAM]: UNKNOWN });
    expect(parseAddToPackRequest(params, [CATEGORY_A, CATEGORY_B], 0)).toEqual({
      categoryId: null,
      tab: 'new',
    });
  });

  it('refuses an empty ?add=', () => {
    const params = new URLSearchParams({ [ADD_CATEGORY_PARAM]: '' });
    expect(parseAddToPackRequest(params, [CATEGORY_A], 1).categoryId).toBeNull();
  });

  it('answers no dialog at all when ?add= is absent', () => {
    expect(parseAddToPackRequest(new URLSearchParams(), [CATEGORY_A], 1).categoryId).toBeNull();
  });

  it('reads only the first value of a repeated ?add=, exactly as FormData.get does', () => {
    const params = new URLSearchParams();
    params.append(ADD_CATEGORY_PARAM, CATEGORY_A);
    params.append(ADD_CATEGORY_PARAM, CATEGORY_B);

    expect(parseAddToPackRequest(params, [CATEGORY_A, CATEGORY_B], 0).categoryId).toBe(CATEGORY_A);
  });

  it('falls back to the default tab for a ?tab= that is nonsense, never throwing', () => {
    const params = new URLSearchParams({
      [ADD_CATEGORY_PARAM]: CATEGORY_A,
      [ADD_TAB_PARAM]: 'from-closet',
    });

    expect(parseAddToPackRequest(params, [CATEGORY_A], 4)).toEqual({
      categoryId: CATEGORY_A,
      tab: 'closet',
    });
  });

  it('never throws on a pack with no categories at all', () => {
    const params = new URLSearchParams({ [ADD_CATEGORY_PARAM]: CATEGORY_A });
    expect(() => parseAddToPackRequest(params, [], 0)).not.toThrow();
    expect(parseAddToPackRequest(params, [], 0).categoryId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// readAlsoAddToCloset / writeAlsoAddToCloset — must never throw
// ---------------------------------------------------------------------------

describe('alsoAddToClosetKey', () => {
  it('keys the remembered toggle per user, so two accounts on one browser do not collide', () => {
    expect(alsoAddToClosetKey('user-a')).not.toBe(alsoAddToClosetKey('user-b'));
  });
});

describe('readAlsoAddToCloset', () => {
  it('defaults to false with no storage at all — the server-side / SSR case', () => {
    expect(readAlsoAddToCloset(null, 'user-a')).toBe(false);
  });

  it('defaults to false when nothing has been remembered yet', () => {
    expect(readAlsoAddToCloset(memoryStorage(), 'user-a')).toBe(false);
  });

  it('reads back a remembered true', () => {
    const storage = memoryStorage();
    writeAlsoAddToCloset(storage, 'user-a', true);
    expect(readAlsoAddToCloset(storage, 'user-a')).toBe(true);
  });

  // THE GUARANTEE THIS FUNCTION EXISTS FOR: Safari private mode and "block all cookies"
  // throw on Storage.getItem itself, not only on write, and a dialog that cannot open
  // because this convenience threw would be a worse bug than one that never remembers.
  it('answers false rather than throwing when the storage itself throws on read', () => {
    const storage = throwingStorage('getItem');
    expect(() => readAlsoAddToCloset(storage, 'user-a')).not.toThrow();
    expect(readAlsoAddToCloset(storage, 'user-a')).toBe(false);
  });
});

describe('writeAlsoAddToCloset', () => {
  it('is a silent no-op with no storage at all', () => {
    expect(() => writeAlsoAddToCloset(null, 'user-a', true)).not.toThrow();
  });

  it('does not propagate when the storage throws on write', () => {
    const storage = throwingStorage('setItem');
    expect(() => writeAlsoAddToCloset(storage, 'user-a', true)).not.toThrow();
  });

  it('does not propagate when the storage throws clearing a remembered false', () => {
    const storage = throwingStorage('removeItem');
    expect(() => writeAlsoAddToCloset(storage, 'user-a', false)).not.toThrow();
  });

  it('a later false clears a previously remembered true', () => {
    const storage = memoryStorage();
    writeAlsoAddToCloset(storage, 'user-a', true);
    writeAlsoAddToCloset(storage, 'user-a', false);
    expect(readAlsoAddToCloset(storage, 'user-a')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// customItemToGearInput
// ---------------------------------------------------------------------------

describe('customItemToGearInput', () => {
  const CUSTOM_ITEM: CustomPackItemInput = {
    name: 'Titanium spork',
    brand: 'Snow Peak',
    category: 'Cook kit',
    description: 'Long handle, folds flat',
    weight_grams: 18.5,
    price: 12.99,
    currency: GBP,
    quantity: 2,
    packed: true,
    worn: false,
    consumable: false,
  };

  it('carries every field the dialog collected across unchanged', () => {
    const gear = customItemToGearInput(CUSTOM_ITEM);

    expect(gear.name).toBe('Titanium spork');
    expect(gear.brand).toBe('Snow Peak');
    expect(gear.category).toBe('Cook kit');
    expect(gear.description).toBe('Long handle, folds flat');
    // In grams, unconverted — parseCustomPackItemForm has already done the one conversion
    // this value will ever get (PK-67); customItemToGearInput must not touch it again.
    expect(gear.weight_grams).toBe(18.5);
    expect(gear.price).toBe(12.99);
    expect(gear.currency).toBe('GBP');
  });

  it('defaults every closet-only field this dialog has no control for', () => {
    const gear = customItemToGearInput(CUSTOM_ITEM);

    expect(gear.status).toBe('owned');
    expect(gear.acquired_on).toBeNull();
    expect(gear.url).toBeNull();
    expect(gear.notes).toBeNull();
  });

  // QUANTITY CROSSES, CARRIAGE DOES NOT, and the split is not arbitrary. `quantity` is a
  // required field of GearItemInput — a closet row has to say how many are owned — so it
  // cannot be dropped even if we wanted to, and defaulting it to 1 while the visitor has
  // just typed 2 would quietly disagree with what they entered. `packed`/`worn`/
  // `consumable` are the opposite: they describe how this item travels in THIS pack, and
  // `gear_items` has no column for any of them. An earlier version of this test asserted
  // quantity was dropped too; it contradicted the return type and had never been run.
  it('carries quantity onto the closet row but leaves the carriage flags behind', () => {
    const gear = customItemToGearInput(CUSTOM_ITEM);

    expect(gear.quantity).toBe(CUSTOM_ITEM.quantity);
    expect('packed' in gear).toBe(false);
    expect('worn' in gear).toBe(false);
    expect('consumable' in gear).toBe(false);
  });

  it('carries a null description/brand/category through as null, not the empty string', () => {
    const gear = customItemToGearInput({
      ...CUSTOM_ITEM,
      brand: null,
      category: null,
      description: null,
      price: null,
      currency: null,
    });

    expect(gear.brand).toBeNull();
    expect(gear.category).toBeNull();
    expect(gear.description).toBeNull();
    expect(gear.price).toBeNull();
    expect(gear.currency).toBeNull();
  });
});
