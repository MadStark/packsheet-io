import { describe, expect, it } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { MODAL_ATTRIBUTE, OPEN_ON_LOAD_ATTRIBUTE } from '../src/lib/modal';
import {
  ADD_CATEGORY_PARAM,
  ADD_TAB_PARAM,
  ADD_TO_PACK_FIELD,
  ADD_TO_PACK_MODAL_ID,
  ADD_TO_PACK_TAB_LABELS,
  ALSO_ADD_TO_CLOSET_VALUE,
  addToPackHref,
} from '../src/lib/packs/add-to-pack';
import {
  ADD_TO_PACK_PAGE_ATTRIBUTE,
  ADD_TO_PACK_PART,
  ADD_TO_PACK_PART_ATTRIBUTE,
  ADD_TO_PACK_PATH_ATTRIBUTE,
  ADD_TO_PACK_REMEMBER_ATTRIBUTE,
  ADD_TO_PACK_TAB_ATTRIBUTE,
  ADD_TO_PACK_TOTAL_PAGES_ATTRIBUTE,
  ADD_TO_PACK_USER_ATTRIBUTE,
  ADD_TO_PACK_WEIGHT_SYSTEM_ATTRIBUTE,
  CLOSET_EMPTY_MESSAGE,
  CLOSET_NO_MATCHES_MESSAGE,
  CLOSET_ROW_CLASS,
  CLOSET_ROW_NO_BRAND,
  CLOSET_SEARCH_PARAM,
  closetPageHref,
} from '../src/lib/packs/add-to-pack-dialog';
import { CLOSET_LOAD_FAILED_MESSAGE } from '../src/lib/packs/closet-response';
import { PACK_EDITOR_FIELD, PACK_INTENT } from '../src/lib/packs/editor';
import { CUSTOM_PACK_ITEM_FORM_FIELD } from '../src/lib/packs/form';
import { PACK_ITEM_CARRIAGES } from '../src/lib/packs/fields';
import { formatWeight } from '../src/lib/units';

/**
 * `src/components/AddToPackDialog.astro` (PK-74), asserted by RENDERING it — the same
 * argument `tests/modal-component.test.ts` makes for the shell it is built on: a component
 * whose entire content is markup has no function to extract, and a test asserting that the
 * FILE contains a string would pass for a component that imported it and rendered nothing.
 *
 * WHAT IS WORTH PINNING HERE, and each of these is a defect that ships in silence:
 *
 *   - THE JOIN WITH `src/lib/packs/add-to-pack-dialog.ts`. That module finds every element
 *     it touches by `data-add-to-pack="<part>"`. A renamed part leaves `querySelector`
 *     returning `null`, the upgrade quietly not happening, and the page still working — which
 *     is indistinguishable from the intended no-script degradation. These assertions are the
 *     join, exactly as the modal's are for `MODAL_ATTRIBUTE`.
 *   - THE NO-SCRIPT PATH ITSELF. Real `<a href>` tabs, a real `<form method="GET">` search,
 *     real pager links and two real `<form method="POST">` submits. A component that rendered
 *     `<button>`s here would look identical in a screenshot and be completely dead wherever
 *     the bundle did not arrive.
 *   - THE HIDDEN PANEL. `hidden` and not a visually-hidden class, because the difference is
 *     whether the tab nobody can see is one Tab press away and whether its Save button can be
 *     reached by keyboard.
 *   - THE THREE CATEGORY INPUTS. One dialog serves every category, so a form that lost its
 *     hidden `category_id` would file items under whatever the `<select>` used to default to
 *     — the exact failure the dialog exists to remove.
 *
 * THE RENDERED HTML IS PARSED WITH JSDOM, rather than matched with the regexes
 * `tests/modal-component.test.ts` uses, and the reason is the panel guard: "these fields are
 * not submitted by that form" is a question about `FormData` and form ownership, which a
 * regex over the markup can only guess at.
 *
 * THIS FILE RENDERS IN `node` AND PARSES THE RESULT, rather than running under the jsdom
 * environment the way `tests/modal.test.ts` does, and the two halves of that are both
 * load-bearing. `AstroContainer.renderToString` DOES NOT WORK under that environment at all —
 * verified against `Modal.astro`, which renders here and dies there on
 * `NoMatchingRenderer: Unable to render ...`, because the environment resolves this project's
 * modules with the browser conditions and `.astro` has no browser entry point. So rendering
 * has to happen in `node`, and the DOM has to be built by hand from the string.
 *
 * AND THE ENVIRONMENT DOCBLOCK PRAGMA MUST NOT BE WRITTEN OUT IN THIS COMMENT EITHER, which
 * is how the above was discovered: vitest scans a file's leading block comments for that
 * pragma by regex and does not care that this one is prose about it. Naming it here in full
 * switched the whole file to jsdom and produced exactly the failure described.
 *
 * `jsdom` IS THEREFORE IMPORTED THROUGH A VARIABLE SPECIFIER — the same device this file
 * already uses for the component, and for a related reason. There is no `@types/jsdom` in
 * this project (jsdom arrives as vitest's environment, which needs no declarations), so a
 * literal `import { JSDOM } from 'jsdom'` fails `tsc --noEmit` with ts(7016). A variable
 * specifier is a specifier TypeScript cannot resolve and therefore does not object to, and
 * the shape it hands back is asserted once, below, instead of being trusted implicitly.
 *
 * The component is imported through a variable for the reason `tests/packs-nav.test.ts` sets
 * out at length: `npm run check` runs `astro check` AND `tsc --noEmit`, and only the first
 * knows what a `.astro` module is, while the wildcard `declare module '*.astro'` shim that
 * would fix the second types every component as accepting any props at all.
 */
const DIALOG_MODULE = '../src/components/AddToPackDialog.astro';

const PACK_PATH = '/packs/11111111-1111-4111-8111-111111111111';

const CATEGORIES = [
  { id: 'cat-shelter', name: 'Shelter' },
  { id: 'cat-cooking', name: 'Cooking' },
] as const;

const ITEMS = [
  { id: 'gear-1', name: 'Stakes', brand: 'MSR', weightGrams: 56 },
  { id: 'gear-2', name: 'Groundsheet', brand: null, weightGrams: 120 },
] as const;

const BASE_PROPS = {
  packUrlPath: PACK_PATH,
  categories: CATEGORIES,
  categoryId: CATEGORIES[0].id,
  tab: 'closet',
  open: false,
  userId: 'user-1',
  weightSystem: 'metric',
  closetItems: ITEMS,
  closetPage: 1,
  closetTotalPages: 1,
  closetTotalCount: 2,
  closetSearch: '',
  closetError: false,
} as const;

async function renderHtml(props: Record<string, unknown> = {}): Promise<string> {
  const { default: AddToPackDialog } = await import(/* @vite-ignore */ DIALOG_MODULE);
  const container = await AstroContainer.create();
  return container.renderToString(AddToPackDialog, { props: { ...BASE_PROPS, ...props } });
}

const JSDOM_MODULE = 'jsdom';

interface JsdomModule {
  new (html: string): { readonly window: Window & typeof globalThis };
}

let Jsdom: JsdomModule | null = null;

async function render(props: Record<string, unknown> = {}): Promise<Document> {
  Jsdom ??= ((await import(/* @vite-ignore */ JSDOM_MODULE)) as { JSDOM: JsdomModule }).JSDOM;
  return new Jsdom(await renderHtml(props)).window.document;
}

const part = (scope: ParentNode, name: string): Element | null =>
  scope.querySelector(`[${ADD_TO_PACK_PART_ATTRIBUTE}="${name}"]`);

const parts = (scope: ParentNode, name: string): Element[] => [
  ...scope.querySelectorAll(`[${ADD_TO_PACK_PART_ATTRIBUTE}="${name}"]`),
];

/** A form's submission, read the way the browser reads it — through the PARSED document's
 *  own `FormData`, not Node's global one, which knows nothing about a jsdom element. */
const formData = (form: HTMLFormElement): FormData => {
  const view = form.ownerDocument.defaultView;
  if (view === null) throw new Error('the rendered markup parsed into a document with no window');
  return new view.FormData(form);
};

/** Every `name=` a form would actually submit. */
const submittedNames = (form: HTMLFormElement): string[] => [...formData(form).keys()];

describe('the add-to-pack dialog’s shell', () => {
  it('renders exactly one modal, under the id the trigger and the script both name', async () => {
    const doc = await render();
    const dialogs = doc.querySelectorAll('dialog');

    expect(dialogs).toHaveLength(1);
    expect(dialogs[0]?.id).toBe(ADD_TO_PACK_MODAL_ID);
    expect(dialogs[0]?.hasAttribute(MODAL_ATTRIBUTE)).toBe(true);
  });

  it('renders a REAL <dialog open> when asked, because a direct visit to ?add= has to show a working form with no JavaScript at all', async () => {
    const doc = await render({ open: true });
    const dialog = doc.querySelector('dialog');

    expect(dialog?.hasAttribute('open')).toBe(true);
    expect(dialog?.hasAttribute(OPEN_ON_LOAD_ATTRIBUTE)).toBe(true);
  });

  it('is closed by default, so a pack page carrying this component does not open it on every load', async () => {
    const doc = await render();

    expect(doc.querySelector('dialog')?.hasAttribute('open')).toBe(false);
  });

  it('names the acting category in the heading the dialog is LABELLED BY, so what is announced cannot drift from what is shown', async () => {
    const doc = await render({ categoryId: CATEGORIES[1].id });
    const dialog = doc.querySelector('dialog');
    const labelledBy = dialog?.getAttribute('aria-labelledby');
    const heading =
      labelledBy === null || labelledBy === undefined ? null : doc.getElementById(labelledBy);

    // The script rewrites this one node before the dialog opens; if the name lived in a
    // second, hidden copy instead, the visible and the announced category could disagree.
    expect(heading?.textContent).toContain('Cooking');
    expect(part(doc, ADD_TO_PACK_PART.categoryName)?.textContent).toBe('Cooking');
  });

  it('falls back to the pack’s first category when the URL named none, rather than rendering a heading that trails off and three empty ids', async () => {
    const doc = await render({ categoryId: null });

    expect(part(doc, ADD_TO_PACK_PART.categoryName)?.textContent).toBe('Shelter');
    for (const input of parts(doc, ADD_TO_PACK_PART.categoryInput)) {
      expect(input.getAttribute('value')).toBe(CATEGORIES[0].id);
    }
  });

  it('carries the script’s whole configuration on the root element, since a bundle cannot read a component’s props', async () => {
    const doc = await render({ closetPage: 2, closetTotalPages: 4, weightSystem: 'imperial' });
    const root = part(doc, ADD_TO_PACK_PART.root);

    expect(root?.getAttribute(ADD_TO_PACK_PATH_ATTRIBUTE)).toBe(PACK_PATH);
    expect(root?.getAttribute(ADD_TO_PACK_USER_ATTRIBUTE)).toBe('user-1');
    expect(root?.getAttribute(ADD_TO_PACK_WEIGHT_SYSTEM_ATTRIBUTE)).toBe('imperial');
    expect(root?.getAttribute(ADD_TO_PACK_PAGE_ATTRIBUTE)).toBe('2');
    expect(root?.getAttribute(ADD_TO_PACK_TOTAL_PAGES_ATTRIBUTE)).toBe('4');
  });

  it('ships no island and no hydration directive, because a dialog that needed hydrating would be a dialog that is not there until the bundle is', async () => {
    const html = await renderHtml();

    expect(html).not.toMatch(/astro-island/);
    expect(html).not.toMatch(/client:(load|idle|visible|media|only)/);
  });
});

describe('the tab strip', () => {
  it('is the full ARIA tab pattern, so the control announces what it is whether or not the script arrived', async () => {
    const doc = await render({ tab: 'closet' });
    const tabs = parts(doc, ADD_TO_PACK_PART.tab);
    const panels = parts(doc, ADD_TO_PACK_PART.panel);

    expect(doc.querySelector('[role="tablist"]')?.getAttribute('aria-label')).not.toBeNull();
    expect(tabs).toHaveLength(2);
    expect(panels).toHaveLength(2);

    for (const tab of tabs) {
      expect(tab.getAttribute('role')).toBe('tab');
      const panel = doc.getElementById(tab.getAttribute('aria-controls') ?? '');
      expect(panel?.getAttribute('role')).toBe('tabpanel');
      expect(panel?.getAttribute('aria-labelledby')).toBe(tab.id);
    }

    expect(tabs.map((tab) => tab.textContent?.trim())).toEqual([
      ADD_TO_PACK_TAB_LABELS.closet,
      ADD_TO_PACK_TAB_LABELS.new,
    ]);
  });

  it('gives the selected tab the only tabindex of 0, which is what keeps one Tab press from walking through both tabs', async () => {
    const doc = await render({ tab: 'new' });
    const state = parts(doc, ADD_TO_PACK_PART.tab).map((tab) => ({
      tab: tab.getAttribute(ADD_TO_PACK_TAB_ATTRIBUTE),
      selected: tab.getAttribute('aria-selected'),
      tabindex: tab.getAttribute('tabindex'),
    }));

    expect(state).toEqual([
      { tab: 'closet', selected: 'false', tabindex: '-1' },
      { tab: 'new', selected: 'true', tabindex: '0' },
    ]);
  });

  it('IS TWO REAL LINKS TO REAL URLS, not two buttons — with no script, switching tabs is a navigation and there is no other way for it to work', async () => {
    const doc = await render({ categoryId: CATEGORIES[1].id });

    for (const tab of parts(doc, ADD_TO_PACK_PART.tab)) {
      const value = tab.getAttribute(ADD_TO_PACK_TAB_ATTRIBUTE);
      expect(tab.tagName).toBe('A');
      expect(tab.getAttribute('href')).toBe(
        addToPackHref(PACK_PATH, CATEGORIES[1].id, value === 'new' ? 'new' : 'closet'),
      );
    }
  });

  it('HIDES THE PANEL THAT IS NOT SHOWING WITH `hidden`, and keeps each panel’s fields inside its own form — a panel that were merely off-screen would put an invisible Save button one Tab away and its fields in the tab order', async () => {
    const doc = await render({ tab: 'closet' });
    const panels = parts(doc, ADD_TO_PACK_PART.panel);
    const closetPanel = panels.find((p) => p.getAttribute(ADD_TO_PACK_TAB_ATTRIBUTE) === 'closet');
    const newPanel = panels.find((p) => p.getAttribute(ADD_TO_PACK_TAB_ATTRIBUTE) === 'new');

    expect(closetPanel?.hasAttribute('hidden')).toBe(false);
    expect(newPanel?.hasAttribute('hidden')).toBe(true);

    // And the structural half of the same guarantee: nothing in the hidden panel can ride
    // along on the visible panel's submission, because they are two forms.
    const listForm = part(doc, ADD_TO_PACK_PART.listForm) as HTMLFormElement;
    const names = submittedNames(listForm);
    expect(names).not.toContain(CUSTOM_PACK_ITEM_FORM_FIELD.name);
    expect(names).not.toContain(ADD_TO_PACK_FIELD.alsoAddToCloset);
    for (const field of newPanel?.querySelectorAll('input, textarea, select') ?? []) {
      expect((field as HTMLInputElement).form).not.toBe(listForm);
    }
  });

  it('hides the other panel when the other tab is the active one, so the pair really is driven by the prop rather than one of them always losing', async () => {
    const doc = await render({ tab: 'new' });
    const panels = parts(doc, ADD_TO_PACK_PART.panel);

    expect(
      panels.map((p) => [p.getAttribute(ADD_TO_PACK_TAB_ATTRIBUTE), p.hasAttribute('hidden')]),
    ).toEqual([
      ['closet', true],
      ['new', false],
    ]);
  });
});

describe('the closet tab', () => {
  it('searches through a real GET form aimed at the pack page, carrying ?add= and ?tab= so the dialog is still open on the same category when the page comes back', async () => {
    const doc = await render({ closetSearch: 'tent' });
    const form = part(doc, ADD_TO_PACK_PART.searchForm) as HTMLFormElement;

    expect(form.getAttribute('method')?.toLowerCase()).toBe('get');
    expect(form.getAttribute('action')).toBe(PACK_PATH);

    const submitted = formData(form);
    expect(submitted.get(ADD_CATEGORY_PARAM)).toBe(CATEGORIES[0].id);
    expect(submitted.get(ADD_TAB_PARAM)).toBe('closet');
    expect(submitted.get(CLOSET_SEARCH_PARAM)).toBe('tent');
    expect(part(doc, ADD_TO_PACK_PART.searchInput)?.getAttribute('name')).toBe(CLOSET_SEARCH_PARAM);
  });

  it('posts the picked rows under the add-gear intent with the acting category in a hidden input, not from a category picker the visitor has to name again', async () => {
    const doc = await render({ categoryId: CATEGORIES[1].id });
    const form = part(doc, ADD_TO_PACK_PART.listForm) as HTMLFormElement;

    expect(form.getAttribute('method')?.toLowerCase()).toBe('post');
    const submitted = formData(form);
    expect(submitted.get('intent')).toBe(PACK_INTENT.addGear);
    expect(submitted.get(PACK_EDITOR_FIELD.categoryId)).toBe(CATEGORIES[1].id);
    // No <select> anywhere: naming the category is what the trigger already did.
    expect(form.querySelector('select')).toBeNull();
    expect(form.querySelector('button[type="submit"]')).not.toBeNull();
  });

  it('renders each row with the classes the script re-renders them with, so a search does not visibly restyle the list', async () => {
    const doc = await render();
    const rows = [...(part(doc, ADD_TO_PACK_PART.list)?.querySelectorAll('li') ?? [])];

    expect(rows).toHaveLength(2);
    const [first, second] = rows;
    expect(first?.querySelector('label')?.getAttribute('class')).toBe(CLOSET_ROW_CLASS.label);
    const box = first?.querySelector('input[type="checkbox"]');
    expect(box?.getAttribute('name')).toBe(PACK_EDITOR_FIELD.gearItemId);
    expect(box?.getAttribute('value')).toBe('gear-1');
    expect(box?.getAttribute('class')).toBe(CLOSET_ROW_CLASS.checkbox);

    const cells = [...(first?.querySelectorAll('span') ?? [])].map((span) => [
      span.getAttribute('class'),
      span.textContent?.trim(),
    ]);
    expect(cells).toEqual([
      [CLOSET_ROW_CLASS.name, 'Stakes'],
      [CLOSET_ROW_CLASS.brand, 'MSR'],
      [CLOSET_ROW_CLASS.weight, formatWeight(56, 'metric')],
    ]);

    // A blank brand cell reads as a rendering fault; the dash reads as "there isn't one".
    expect(second?.textContent).toContain(CLOSET_ROW_NO_BRAND);
  });

  it('formats weights in the visitor’s own system rather than in whatever the database stores', async () => {
    const doc = await render({ weightSystem: 'imperial' });

    expect(part(doc, ADD_TO_PACK_PART.list)?.textContent).toContain(formatWeight(56, 'imperial'));
  });

  it('DISTINGUISHES AN EMPTY CLOSET FROM A SEARCH THAT MATCHED NOTHING, because telling someone with two hundred items that their closet is empty is a different and wrong statement', async () => {
    const emptyCloset = await render({ closetItems: [], closetTotalCount: 0, closetSearch: '' });
    const noMatches = await render({ closetItems: [], closetTotalCount: 0, closetSearch: 'tnet' });

    expect(part(emptyCloset, ADD_TO_PACK_PART.empty)?.textContent?.trim()).toBe(
      CLOSET_EMPTY_MESSAGE,
    );
    expect(part(noMatches, ADD_TO_PACK_PART.empty)?.textContent?.trim()).toBe(
      CLOSET_NO_MATCHES_MESSAGE,
    );
    // The picker itself is hidden rather than rendered as an empty fieldset with a live
    // "Add selected" button under it.
    expect(part(emptyCloset, ADD_TO_PACK_PART.listForm)?.hasAttribute('hidden')).toBe(true);
    expect(part(emptyCloset, ADD_TO_PACK_PART.empty)?.hasAttribute('hidden')).toBe(false);
  });

  it('hides the empty sentence when there are rows, rather than stacking it above them', async () => {
    const doc = await render();

    expect(part(doc, ADD_TO_PACK_PART.empty)?.hasAttribute('hidden')).toBe(true);
    expect(part(doc, ADD_TO_PACK_PART.listForm)?.hasAttribute('hidden')).toBe(false);
  });

  it('pages with real links carrying the page they go to, so paging works with no script and the script has a number to read rather than a sentence to parse', async () => {
    const doc = await render({ closetPage: 2, closetTotalPages: 3, closetSearch: 'tent' });
    const previous = part(doc, ADD_TO_PACK_PART.pagePrevious);
    const next = part(doc, ADD_TO_PACK_PART.pageNext);

    expect(part(doc, ADD_TO_PACK_PART.pager)?.hasAttribute('hidden')).toBe(false);
    expect(previous?.tagName).toBe('A');
    expect(previous?.getAttribute(ADD_TO_PACK_PAGE_ATTRIBUTE)).toBe('1');
    expect(previous?.getAttribute('href')).toBe(
      closetPageHref(PACK_PATH, CATEGORIES[0].id, 'tent', 1),
    );
    expect(next?.getAttribute(ADD_TO_PACK_PAGE_ATTRIBUTE)).toBe('3');
    expect(next?.getAttribute('href')).toBe(closetPageHref(PACK_PATH, CATEGORIES[0].id, 'tent', 3));
    expect(part(doc, ADD_TO_PACK_PART.pagerLabel)?.textContent?.trim()).toBe('Page 2 of 3');
  });

  it('hides the pager entirely on a single-page closet, and hides the end links at the ends', async () => {
    const single = await render({ closetPage: 1, closetTotalPages: 1 });
    const first = await render({ closetPage: 1, closetTotalPages: 3 });

    expect(part(single, ADD_TO_PACK_PART.pager)?.hasAttribute('hidden')).toBe(true);
    expect(part(first, ADD_TO_PACK_PART.pagePrevious)?.hasAttribute('hidden')).toBe(true);
    expect(part(first, ADD_TO_PACK_PART.pageNext)?.hasAttribute('hidden')).toBe(false);
  });

  it('reports a failed closet read in the same region a failed fetch speaks through, in the endpoint’s own neutral sentence and never a database string', async () => {
    const failed = await render({ closetError: true, closetItems: [], closetTotalCount: 0 });
    const fine = await render();

    const status = part(failed, ADD_TO_PACK_PART.status);
    expect(status?.getAttribute('role')).toBe('status');
    expect(status?.hasAttribute('hidden')).toBe(false);
    expect(status?.textContent?.trim()).toBe(CLOSET_LOAD_FAILED_MESSAGE);
    expect(part(fine, ADD_TO_PACK_PART.status)?.hasAttribute('hidden')).toBe(true);
  });
});

describe('the new-item tab', () => {
  it('posts under the add-custom-item intent with the acting category, and carries exactly the agreed field set', async () => {
    const doc = await render({ tab: 'new', categoryId: CATEGORIES[1].id });
    const panel = parts(doc, ADD_TO_PACK_PART.panel).find(
      (p) => p.getAttribute(ADD_TO_PACK_TAB_ATTRIBUTE) === 'new',
    );
    const form = panel?.querySelector('form') as HTMLFormElement;

    expect(form.getAttribute('method')?.toLowerCase()).toBe('post');
    const submitted = formData(form);
    expect(submitted.get('intent')).toBe(PACK_INTENT.addCustomItem);
    expect(submitted.get(PACK_EDITOR_FIELD.categoryId)).toBe(CATEGORIES[1].id);
    expect(form.querySelector('select')).toBeNull();

    // Named with CUSTOM_PACK_ITEM_FORM_FIELD so `parseCustomPackItemForm` reads this form
    // unchanged — a renamed field here would be silently parsed as absent, not as an error.
    const named = new Set(
      [...form.querySelectorAll('input, textarea')].map((field) => field.getAttribute('name')),
    );
    for (const field of Object.values(CUSTOM_PACK_ITEM_FORM_FIELD)) {
      expect(named).toContain(field);
    }
    expect(named).toContain(ADD_TO_PACK_FIELD.alsoAddToCloset);
  });

  it('offers the three carriages as one segmented control, which is what §6 says a choice of three or fewer is', async () => {
    const doc = await render({ tab: 'new' });
    const radios = [
      ...doc.querySelectorAll(`input[name="${CUSTOM_PACK_ITEM_FORM_FIELD.carriage}"]`),
    ];

    expect(radios.map((radio) => radio.getAttribute('value'))).toEqual([...PACK_ITEM_CARRIAGES]);
    expect(radios.every((radio) => radio.getAttribute('type') === 'radio')).toBe(true);
    expect(radios[0]?.closest('.segmented')).not.toBeNull();
  });

  it('carries the entry unit in the weight label itself, so the accessible name and the visible one are the same string', async () => {
    const metric = await render({ tab: 'new', weightSystem: 'metric' });
    const imperial = await render({ tab: 'new', weightSystem: 'imperial' });
    const label = (doc: Document): string | undefined => {
      const field = doc.querySelector(`input[name="${CUSTOM_PACK_ITEM_FORM_FIELD.weight}"]`);
      return doc.querySelector(`label[for="${field?.id}"]`)?.textContent?.trim();
    };

    expect(label(metric)).toBe('Weight (g)');
    expect(label(imperial)).toBe('Weight (oz)');
  });

  it('KEEPS EVERYTHING THE VISITOR TYPED and shows the server’s objection beside the field it is about, wired with aria-invalid and aria-describedby', async () => {
    const doc = await render({
      tab: 'new',
      customValues: {
        name: '',
        brand: 'MSR',
        category: 'Shelter',
        description: 'A spare',
        weight: 'heavy',
        price: '',
        currency: '',
        quantity: '2',
        carriage: 'worn',
        packed: 'on',
      },
      customErrors: { name: 'Enter a name for this item.', weight: 'Enter a weight.' },
    });

    const name = doc.querySelector(`input[name="${CUSTOM_PACK_ITEM_FORM_FIELD.name}"]`);
    expect(name?.getAttribute('aria-invalid')).toBe('true');
    const describedBy = name?.getAttribute('aria-describedby') ?? '';
    expect(doc.getElementById(describedBy)?.textContent?.trim()).toBe(
      'Enter a name for this item.',
    );

    // The values the server did NOT object to come back untouched.
    expect(
      doc
        .querySelector(`input[name="${CUSTOM_PACK_ITEM_FORM_FIELD.brand}"]`)
        ?.getAttribute('value'),
    ).toBe('MSR');
    expect(
      doc.querySelector(`textarea[name="${CUSTOM_PACK_ITEM_FORM_FIELD.description}"]`)?.textContent,
    ).toBe('A spare');
    expect(
      doc
        .querySelector(`input[name="${CUSTOM_PACK_ITEM_FORM_FIELD.carriage}"][value="worn"]`)
        ?.hasAttribute('checked'),
    ).toBe(true);

    // A field with no error gets neither attribute, or every field would announce itself as
    // invalid the moment any one of them was.
    const price = doc.querySelector(`input[name="${CUSTOM_PACK_ITEM_FORM_FIELD.price}"]`);
    expect(price?.hasAttribute('aria-invalid')).toBe(false);
    expect(price?.hasAttribute('aria-describedby')).toBe(false);
  });

  it('puts "Also add to closet" BESIDE the Save button, in that form and not in the shell’s actions footer', async () => {
    const doc = await render({ tab: 'new' });
    const toggle = part(doc, ADD_TO_PACK_PART.toggle);
    const save = [...doc.querySelectorAll('button[type="submit"]')].find(
      (button) => button.textContent?.trim() === 'Save',
    );

    expect(toggle?.getAttribute('type')).toBe('checkbox');
    expect(toggle?.getAttribute('name')).toBe(ADD_TO_PACK_FIELD.alsoAddToCloset);
    expect(toggle?.getAttribute('value')).toBe(ALSO_ADD_TO_CLOSET_VALUE);
    expect(save).not.toBeUndefined();
    // Same row, same form — not the shell's `actions` slot, which this dialog never uses.
    expect(doc.querySelector('.modal-actions')).toBeNull();
    expect((toggle as HTMLInputElement).form).toBe((save as HTMLButtonElement).form);
    expect(toggle?.parentElement?.parentElement?.parentElement).toBe(save?.parentElement);
    expect(toggle?.closest('div')?.parentElement?.textContent).toContain('this browser');
  });

  it('MARKS THE TOGGLE AS THE SERVER’S ONLY WHEN THE SERVER HAS AN OPINION, or a browser that cannot read localStorage would silently un-tick a box the visitor had just ticked', async () => {
    const fresh = await render({ tab: 'new' });
    const roundTrip = await render({
      tab: 'new',
      alsoAddToCloset: true,
      customErrors: { name: 'Enter a name for this item.' },
    });

    expect(part(fresh, ADD_TO_PACK_PART.toggle)?.hasAttribute(ADD_TO_PACK_REMEMBER_ATTRIBUTE)).toBe(
      true,
    );
    const roundTripped = part(roundTrip, ADD_TO_PACK_PART.toggle);
    expect(roundTripped?.hasAttribute(ADD_TO_PACK_REMEMBER_ATTRIBUTE)).toBe(false);
    expect(roundTripped?.hasAttribute('checked')).toBe(true);
  });
});
