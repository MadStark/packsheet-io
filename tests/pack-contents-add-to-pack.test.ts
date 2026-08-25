/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';
import { createSSRApp } from 'vue';
import { ADD_TO_PACK_MODAL_ID, addToPackHref } from '../src/lib/packs/add-to-pack';
import {
  ADD_TO_PACK_CATEGORY_ATTRIBUTE,
  ADD_TO_PACK_CATEGORY_NAME_ATTRIBUTE,
  ADD_TO_PACK_TRIGGER_SELECTOR,
  categoryFromTrigger,
} from '../src/lib/packs/add-to-pack-dialog';
import { TRIGGER_ATTRIBUTE } from '../src/lib/modal';
import { packPath } from '../src/lib/packs/routes';

/**
 * THE ONE HALF OF PK-74'S TRIGGER CONTRACT NOTHING ELSE PINS.
 *
 * `tests/add-to-pack-dialog-component.test.ts` renders `AddToPackDialog.astro` and joins its
 * markup to `ADD_TO_PACK_PART` — the dialog's own side. `tests/add-to-pack-dialog.test.ts`
 * drives `initAddToPackDialog` against hand-written triggers — the module's side. Neither
 * touches the markup `src/components/PackContents.vue` actually emits, and that markup is
 * where the join is made in production: one `<a href>` per category carrying
 * `data-modal-open="add-to-pack"` plus the two category attributes.
 *
 * DRIFT HERE IS SILENT, which is the whole reason this file exists rather than a comment.
 * `src/lib/packs/add-to-pack-dialog.ts` says so in its own header: a renamed attribute leaves
 * `querySelector` returning `null`, the upgrade quietly not happening, and the page still
 * working — indistinguishable from the intended degradation. So the assertions below are made
 * THROUGH the module's own exports, never against hand-typed strings: `categoryFromTrigger`
 * and `ADD_TO_PACK_TRIGGER_SELECTOR` are the exact two things the delegated click listener
 * uses, so a rename on either side fails this instead of going dead in silence.
 *
 * IT IS THE SERVER RENDER THAT IS ASSERTED, through the same `renderToString` harness
 * `tests/packs-drag.test.ts` uses and for the same reason: the trigger has to be in the
 * markup a browser receives, because with no script it is the only thing that opens the
 * dialog at all — it navigates, and the page server-renders the dialog open on that
 * category. jsdom is here only to READ that markup back with the module's own selector
 * (the environment `tests/modal.test.ts` introduced), not to run anything in it.
 */

const PACK_ID = '11111111-1111-4111-8111-111111111111';
const SELF_PATH = packPath(PACK_ID);

const CATEGORIES = [
  {
    id: '22222222-2222-4222-8222-222222222222',
    name: 'Shelter',
    position: 0,
    pack_items: [],
  },
  {
    // An apostrophe and an ampersand, because the name is written into an attribute and a
    // trigger that loses it leaves `categoryFromTrigger` reading a different category name
    // than the heading it is about to write.
    id: '33333333-3333-4333-8333-333333333333',
    name: "Cooking & Kate's stove",
    position: 1,
    pack_items: [],
  },
] as const;

async function render(): Promise<string> {
  // See tests/packs-drag.test.ts for why this suppression is `@ts-ignore` and is written per
  // call site rather than as a global `*.vue` shim.
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore tsc cannot resolve an SFC; astro check, which can, is what checks this one
  const component = (await import('../src/components/PackContents.vue')) as {
    default: Parameters<typeof createSSRApp>[0];
  };
  const { renderToString } = await import('vue/server-renderer');
  return renderToString(
    createSSRApp(component.default, {
      packId: PACK_ID,
      categories: CATEGORIES,
      weightSystem: 'metric',
      selfPath: SELF_PATH,
      renameError: null,
      itemError: null,
      pendingCategoryDeleteId: null,
    }),
  );
}

/** The rendered triggers, found exactly as the dialog's delegated listener finds them —
 *  through the module's own selector, in the jsdom environment `tests/modal.test.ts`
 *  established for this suite, rather than by a regular expression over the markup. */
async function triggers(): Promise<Element[]> {
  const host = document.createElement('div');
  host.innerHTML = await render();
  return [...host.querySelectorAll(ADD_TO_PACK_TRIGGER_SELECTOR)];
}

describe('PackContents renders one add-to-pack trigger per category', () => {
  it('renders exactly one, on every category', async () => {
    expect(await triggers()).toHaveLength(CATEGORIES.length);
  });

  it('names the dialog with the shell’s own trigger attribute', async () => {
    for (const trigger of await triggers()) {
      expect(trigger.getAttribute(TRIGGER_ATTRIBUTE)).toBe(ADD_TO_PACK_MODAL_ID);
    }
  });

  it('carries each category through `categoryFromTrigger` unchanged', async () => {
    expect((await triggers()).map((trigger) => categoryFromTrigger(trigger))).toEqual(
      CATEGORIES.map((category) => ({ id: category.id, name: category.name })),
    );
  });

  it('is an anchor with the working href, which is what `upgradeTrigger` requires', async () => {
    // Not a button, and not an empty href: `upgradeTrigger` refuses both outright, and a
    // refused trigger is a permanently dead control on every platform the shell degrades on.
    const rendered = await triggers();
    for (const [index, trigger] of rendered.entries()) {
      expect(trigger.tagName).toBe('A');
      expect(trigger.getAttribute('href')).toBe(
        addToPackHref(packPath(PACK_ID), CATEGORIES[index]!.id),
      );
    }
  });

  it('does not carry the attributes under any other spelling', async () => {
    // The join is one name on each side. If the markup ever grows a second, hand-typed copy
    // of either attribute, the selector above would still match and this would still pass —
    // so what is pinned here is the opposite: the ONLY category attributes in the rendered
    // markup are the two the module exports.
    const markup = await render();
    const spellings = [...markup.matchAll(/data-add-to-pack[a-z-]*/g)].map(([one]) => one);
    expect(new Set(spellings)).toEqual(
      new Set([ADD_TO_PACK_CATEGORY_ATTRIBUTE, ADD_TO_PACK_CATEGORY_NAME_ATTRIBUTE]),
    );
  });
});
