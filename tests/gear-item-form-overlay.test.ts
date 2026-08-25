import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { EMPTY_GEAR_FORM_VALUES } from '../src/lib/gear/form';
import {
  OVERLAY_CANCEL_ATTRIBUTE,
  OVERLAY_FORM_ATTRIBUTE,
  OVERLAY_SUBMIT_ATTRIBUTE,
} from '../src/lib/gear/overlay';

/**
 * PK-71's component/copy guards, in two halves.
 *
 * HALF ONE renders `src/components/GearItemForm.astro` with `experimental_AstroContainer`
 * — the same pattern `tests/modal-component.test.ts` uses, for the reasons that file's own
 * header gives: a component whose content is markup has no function to extract, so the
 * only honest way to pin it is to render it and read the HTML. The module is imported
 * through a variable rather than statically, and via a string path constant, for the same
 * reason `tests/modal-component.test.ts` and `tests/packs-nav.test.ts` both do it: `npm
 * run check` runs `astro check` AND `tsc --noEmit`, and only the first understands what a
 * `.astro` module is — a static import would need the wildcard `declare module '*.astro'`
 * shim, which types every component as accepting any props at all and defeats the point of
 * checking this one's `Props` interface is actually satisfied.
 *
 * HALF TWO reads `src/pages/gear/new.astro` and `src/pages/gear/[id].astro` as plain text
 * rather than rendering them — see that describe block's own comment for why, and for what
 * that costs.
 */

const GEAR_ITEM_FORM_MODULE = '../src/components/GearItemForm.astro';

const render = async (props: Record<string, unknown>): Promise<string> => {
  const { default: GearItemForm } = await import(/* @vite-ignore */ GEAR_ITEM_FORM_MODULE);
  const container = await AstroContainer.create();
  return container.renderToString(GearItemForm, { props });
};

/** Every required prop off `GearItemForm`'s own `Props` interface, with `values` matching
 *  the shape `gearItemToFormValues`/`GearFormValues` (`src/lib/gear/form.ts`) produce —
 *  `EMPTY_GEAR_FORM_VALUES` is exactly that shape, already covered by `tests/gear-form.test.ts`. */
const baseProps = {
  values: EMPTY_GEAR_FORM_VALUES,
  errors: {},
  submitLabel: 'Add item',
  cancelHref: '/gear',
  categories: [],
  weightSystem: 'metric',
};

describe('GearItemForm.astro (PK-71 overlay wiring)', () => {
  it('labels the Notes field "Notes (private)", the RLS fact GearItemForm.astros own header records — not a UI toggle, and not merely "Notes"', async () => {
    const html = await render(baseProps);
    expect(html).toContain('Notes (private)');
  });

  it('carries the three attributes src/lib/gear/overlay.ts looks for on the form, its submit button and its Cancel link — rename or drop one and every gear link silently degrades to a plain page navigation, with nothing on screen saying why', async () => {
    const html = await render(baseProps);

    expect(html).toMatch(new RegExp(`<form[^>]*${OVERLAY_FORM_ATTRIBUTE}[^>]*>`));
    expect(html).toMatch(new RegExp(`<button[^>]*${OVERLAY_SUBMIT_ATTRIBUTE}[^>]*>`));
    expect(html).toMatch(new RegExp(`<a[^>]*${OVERLAY_CANCEL_ATTRIBUTE}[^>]*>`));
  });
});

// ---------------------------------------------------------------------------
// The removed copy on new.astro / [id].astro
// ---------------------------------------------------------------------------

const NEW_ASTRO_PATH = fileURLToPath(new URL('../src/pages/gear/new.astro', import.meta.url));
const ID_ASTRO_PATH = fileURLToPath(new URL('../src/pages/gear/[id].astro', import.meta.url));

/*
 * new.astro and `[id].astro` are session-gated, on-demand pages — `export const prerender
 * = false`, and both read `Astro.locals.user`, redirecting to sign-in when it is absent —
 * which `experimental_AstroContainer` has no request or session to satisfy. Rendering them
 * the way the block above renders GearItemForm is not available here.
 *
 * SO THIS READS THE FILES' OWN SOURCE TEXT INSTEAD, and that is a weaker guard than a
 * render assertion, said plainly rather than dressed up as one: it would not notice one of
 * these three strings reappearing behind a condition that never renders, or surviving only
 * inside a comment. What it DOES catch — the removed copy coming back into the markup
 * verbatim, which is the ordinary way a revert or a bad merge would reintroduce it — is the
 * failure mode worth guarding against here, and a source-text assertion is the guard this
 * pair of pages has available for it.
 */
describe('the copy PK-71 removed from new.astro and [id].astro (source-text guard)', () => {
  const newAstro = readFileSync(NEW_ASTRO_PATH, 'utf-8');
  const idAstro = readFileSync(ID_ASTRO_PATH, 'utf-8');

  it('drops the "Gear" eyebrow above the page title on both pages', () => {
    expect(newAstro).not.toContain('class="eyebrow"');
    expect(idAstro).not.toContain('class="eyebrow"');
  });

  it('drops the "weigh it once" aside on both pages', () => {
    expect(newAstro).not.toContain('weigh it once');
    expect(idAstro).not.toContain('weigh it once');
  });

  it('drops "Photos aren\'t supported yet" from new.astro', () => {
    expect(newAstro).not.toContain("Photos aren't supported yet");
  });
});
