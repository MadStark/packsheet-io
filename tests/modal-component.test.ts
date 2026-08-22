import { describe, expect, it } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import {
  DISMISS_ATTRIBUTE,
  MODAL_ATTRIBUTE,
  OPEN_ON_LOAD_ATTRIBUTE,
  TRIGGER_ATTRIBUTE,
} from '../src/lib/modal';

/**
 * `src/components/Modal.astro` (PK-69), asserted by RENDERING it rather than by reading its
 * source — the same argument `tests/packs-nav.test.ts` makes for `GearNav.astro`, and for the
 * same reason: a component whose entire content is markup has no function to extract, and a
 * test asserting that the file CONTAINS a string would pass for a component that imported it
 * and rendered nothing.
 *
 * WHAT IS WORTH PINNING HERE:
 *
 *   - THE JOIN BETWEEN THE COMPONENT AND `src/lib/modal.ts`. The module declares
 *     `MODAL_ATTRIBUTE` and `OPEN_ON_LOAD_ATTRIBUTE`; the component writes the same two
 *     strings as literals in its markup (its header says why). Nothing connected the two, so
 *     renaming either side left the whole suite green while the feature was silently dead:
 *     `initModals` would find no dialogs, upgrade no triggers, and every trigger would
 *     navigate — which is exactly what the intended degradation path looks like from the
 *     outside. These assertions are that join. `TRIGGER_ATTRIBUTE` is the third name and it
 *     is not this component's to emit — a consumer writes it on their own link — so it is
 *     pinned in `tests/modal.test.ts`, where every trigger in the fixtures is written as the
 *     constant rather than as a literal.
 *   - THE ACCESSIBLE NAME, in all three of its states. `aria-labelledby` and `aria-label`
 *     must never both be emitted (Accname 1.2 §4.3.2 resolves 2B before 2C, so the
 *     `labelledby` would win and the `label` prop would be silently discarded), and a modal
 *     with neither has no accessible name at all — a WCAG 4.1.2 failure no visual review can
 *     see, which is why the component throws rather than shipping it.
 *   - THE CLOSE BUTTON. It is the only dismissal affordance that exists below 640px, where
 *     the sheet is full-bleed and there is no backdrop left to click, so "is it rendered even
 *     when there is no title and no actions slot" is a real question about a real phone.
 *
 * The component is imported through a variable for the reason `tests/packs-nav.test.ts` sets
 * out at length: `npm run check` runs `astro check` AND `tsc --noEmit`, and only the first
 * knows what a `.astro` module is, while the wildcard `declare module '*.astro'` shim that
 * would fix the second types every component as accepting any props at all.
 */
const MODAL_MODULE = '../src/components/Modal.astro';

type Slots = Record<string, string>;

/** The dialog's own opening tag. The close button in the header carries an `aria-label` of
 *  its own, so an assertion about the DIALOG's naming attributes has to be scoped to the
 *  dialog or it reads the button's and passes for the wrong reason. */
const dialogTag = (html: string): string => html.match(/<dialog[^>]*>/)?.[0] ?? '';

const render = async (props: Record<string, unknown>, slots: Slots = {}): Promise<string> => {
  const { default: Modal } = await import(/* @vite-ignore */ MODAL_MODULE);
  const container = await AstroContainer.create();
  return container.renderToString(Modal, { props, slots });
};

describe('the modal shell', () => {
  it('marks the dialog with the attribute the script actually looks for, which is the join that would otherwise go dead on a rename', async () => {
    const html = await render({ id: 'add-item' }, { title: 'Add an item' });

    expect(html).toContain(MODAL_ATTRIBUTE);
    expect(html).toContain('id="add-item"');
  });

  it('renders a closed dialog with neither the open attribute nor the open-on-load marker, so a page with a modal on it does not show the modal', async () => {
    const html = await render({ id: 'add-item' }, { title: 'Add an item' });

    expect(html).not.toContain(OPEN_ON_LOAD_ATTRIBUTE);
    expect(html).not.toMatch(/<dialog[^>]*\sopen[\s>]/);
  });

  it('renders a REAL <dialog open> for open-on-load, not a promise the script has to keep — a direct URL visit has to show the form with no JavaScript at all', async () => {
    const html = await render({ id: 'add-item', open: true }, { title: 'Add an item' });

    expect(html).toMatch(/<dialog[^>]*\sopen[\s>]/);
    expect(html).toContain(OPEN_ON_LOAD_ATTRIBUTE);
  });

  it('labels the dialog by its own heading when no label is given, so the announced name cannot drift from the visible one', async () => {
    const html = await render({ id: 'add-item' }, { title: 'Add an item' });

    expect(dialogTag(html)).toContain('aria-labelledby="add-item-title"');
    expect(html).toContain('id="add-item-title"');
    expect(dialogTag(html)).not.toContain('aria-label=');
  });

  it('EMITS ONE NAMING ATTRIBUTE AND NEVER BOTH, because aria-labelledby wins the accname computation and would silently discard the label a consumer passed on purpose', async () => {
    const html = await render(
      { id: 'add-item', label: 'Add an item to your closet' },
      {
        title: '<span aria-hidden="true">+</span>',
      },
    );

    expect(dialogTag(html)).toContain('aria-label="Add an item to your closet"');
    expect(dialogTag(html)).not.toContain('aria-labelledby');
  });

  it('REFUSES TO BUILD a dialog with no accessible name, which is a WCAG 4.1.2 failure that ships in silence and cannot be seen in a screenshot', async () => {
    await expect(render({ id: 'add-item' }, { default: '<p>A form</p>' })).rejects.toThrow(
      /accessible name/,
    );
  });

  it('renders the close button even with no title and no actions slot, which is the case where a phone visitor would otherwise have no way to dismiss the sheet at all', async () => {
    const html = await render({ id: 'add-item', label: 'Add an item' });

    expect(html).toContain('<form method="dialog"');
    expect(html).toContain('aria-label="Close"');
  });

  it('marks the close button so the initial focus steps over it, or every modal opens focused on Close instead of on its first field', async () => {
    const html = await render({ id: 'add-item' }, { title: 'Add an item' });

    expect(html).toContain(DISMISS_ATTRIBUTE);
  });

  it('dismisses through the platform rather than a click handler, so the close button still works on the one path where no script has run', async () => {
    const html = await render({ id: 'add-item' }, { title: 'Add an item' });

    // `<form method="dialog">` is the browser closing its own dialog. A `<button>` wired by
    // the script would be a control that does nothing wherever the bundle did not arrive —
    // the exact defect `upgradeTrigger`'s anchor-only rule exists to prevent, one layer in.
    expect(html).toMatch(/<form[^>]*method="dialog"/);
    expect(html).toMatch(/<button[^>]*type="submit"/);
  });

  it('renders the actions footer only when a consumer supplies one, so a modal with no buttons has no empty bar under it', async () => {
    const withActions = await render(
      { id: 'add-item' },
      { title: 'Add an item', actions: '<button>Save</button>' },
    );
    const without = await render({ id: 'add-item' }, { title: 'Add an item' });

    expect(withActions).toContain('modal-actions');
    expect(without).not.toContain('modal-actions');
  });

  it('puts the consumer’s own markup in the one scrolling box, which is what keeps the actions row on screen at 375px', async () => {
    const html = await render(
      { id: 'add-item' },
      { title: 'Add an item', default: '<form id="add-item-form">fields</form>' },
    );

    expect(html).toContain('<form id="add-item-form">fields</form>');
    expect(html).toContain('overflow-y-auto');
  });

  it('carries the extra classes a consumer asks for without losing its own, so a wider sheet is one prop rather than a second component', async () => {
    const html = await render({ id: 'add-item', class: 'max-w-3xl' }, { title: 'Add an item' });

    expect(html).toMatch(/class="[^"]*\bmodal\b[^"]*"/);
    expect(html).toMatch(/class="[^"]*\bmax-w-3xl\b[^"]*"/);
  });

  it('ships no island, because a dialog that needed hydrating would be a dialog that is not there until the bundle is', async () => {
    const html = await render({ id: 'add-item' }, { title: 'Add an item' });

    expect(html).not.toMatch(/astro-island/);
    expect(html).not.toMatch(/client:(load|idle|visible|media|only)/);
  });
});

describe('the consumer-side attribute', () => {
  it('is one string, declared once, so the example in the component header cannot drift from what the script looks for', () => {
    // Not a render assertion, and it is not pretending to be one: this component never emits
    // a trigger. What it does emit is the `id` a trigger names, and the pairing itself is
    // asserted end to end in tests/modal.test.ts against this same constant.
    expect(TRIGGER_ATTRIBUTE).toBe('data-modal-open');
  });
});
