import { describe, expect, it } from 'vitest';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { GEAR_PATH } from '../src/lib/gear/routes';
import { PACKS_PATH } from '../src/lib/packs/routes';
import { ACCOUNT_PATH } from '../src/lib/auth-routes';
import { HOME_PATH } from '../src/lib/routes';

/**
 * `src/components/GearNav.astro` — the header every signed-in page renders, asserted by
 * RENDERING it rather than by reading its source.
 *
 * `tests/gear-status-marker.test.ts` records that "this repo has no harness for rendering
 * an `.astro` component in a test", which is why PK-62's three page-level decisions were
 * moved into `src/lib/` to be testable at all. That is still the right move for a DECISION.
 * It is the wrong one for a nav bar, whose entire content is markup: there is no function to
 * extract, and a test asserting that the file contains the string `PACKS_PATH` would pass
 * for a component that imported it and rendered nothing. So this file uses Astro's own
 * container API — the same renderer the build uses, driven directly — which `vitest.config.ts`
 * already makes possible by handing the tests Astro's real Vite config, `.astro` transform
 * included.
 *
 * WHAT IS WORTH PINNING HERE, given that a link is about as simple as markup gets:
 *
 *   - PK-37's acceptance criterion that Packs is REACHABLE. A section with no route into it
 *     from the chrome is a section only its own bookmark can find, which is the C1 defect
 *     PK-4's review filed against the gear closet, in a new place.
 *   - That this component still hydrates NOTHING. Its header comment forbids a `client:*`
 *     directive in capitals and gives two reasons; a comment is not enforcement, and the
 *     render is where an island would show itself.
 */

/**
 * THE COMPONENT IS IMPORTED THROUGH A VARIABLE, WHICH IS DELIBERATE AND WORTH THE LINE OF
 * EXPLANATION IT COSTS. `npm run check` runs `astro check` AND `tsc --noEmit`, and only the
 * first of the two knows what a `.astro` module is: the Astro language tooling compiles the
 * component and type-checks this import for real, while plain `tsc` has no resolver for the
 * extension and fails a static `import GearNav from '…/GearNav.astro'` with TS2307.
 *
 * The obvious fix — a global `declare module '*.astro'` shim — is the one that must not be
 * taken. A wildcard ambient declaration would apply wherever resolution is attempted, which
 * includes every `.astro` importing every other `.astro`, and it types a component as
 * something that accepts any props at all. `<Layout>` missing its required `title` would
 * stop being an error across the whole codebase, to make one test file compile.
 *
 * A non-literal specifier sidesteps the question instead: TypeScript types the result as
 * `any` and resolves nothing, while Vite — which is what actually loads this at run time,
 * with Astro's own transform, because `vitest.config.ts` hands the tests Astro's real Vite
 * config — resolves it perfectly well.
 */
const NAV_MODULE = '../src/components/GearNav.astro';

const render = async (pathname: string): Promise<string> => {
  const { default: GearNav } = await import(/* @vite-ignore */ NAV_MODULE);
  const container = await AstroContainer.create();
  return container.renderToString(GearNav, {
    request: new Request(new URL(pathname, 'https://packsheet.io')),
  });
};

describe('the signed-in header', () => {
  it('links to all three sections', async () => {
    const html = await render(PACKS_PATH);

    expect(html).toContain(`href="${GEAR_PATH}"`);
    expect(html).toContain(`href="${PACKS_PATH}"`);
    expect(html).toContain(`href="${ACCOUNT_PATH}"`);
    expect(html).toContain(`href="${HOME_PATH}"`);
  });

  it('names each destination in words, not only in a URL', async () => {
    const html = await render(PACKS_PATH);

    expect(html).toContain('>Closet<');
    expect(html).toContain('>Packs<');
    expect(html).toContain('>Account<');
  });

  // Closet before Packs before Account: gear lives in the closet, packs are built out of
  // it, and the account is the settings drawer at the end. Asserted because the order is a
  // decision the component's own comment defends, and reordering it is a one-line edit
  // nothing else would notice.
  it('orders them closet, packs, account', async () => {
    const html = await render(PACKS_PATH);

    expect(html.indexOf('>Closet<')).toBeLessThan(html.indexOf('>Packs<'));
    expect(html.indexOf('>Packs<')).toBeLessThan(html.indexOf('>Account<'));
  });

  /**
   * The nav is now shared by two sections, so its accessible name may not claim to be one
   * of them: a landmark announced as "Gear closet navigation" tells a screen-reader user
   * they are in the closet while they stand in the pack editor.
   */
  it('labels the landmark for the sections it links to, not for one of them', async () => {
    const html = await render(PACKS_PATH);

    expect(html).toContain('aria-label="Sections"');
    expect(html).not.toContain('aria-label="Gear closet"');
  });

  // aria-current marks the section a visitor is already in — a server-computed affordance
  // that needs no script, and the only thing distinguishing the three links from each other
  // for assistive technology.
  it.each([
    ['the closet', GEAR_PATH],
    ['the pack list', PACKS_PATH],
    ['the account page', ACCOUNT_PATH],
  ])('marks %s as the current page when it is the one being rendered', async (_label, path) => {
    const html = await render(path);

    expect(html).toContain(`href="${path}" aria-current="page"`);
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  });

  /**
   * IT MUST NEVER HYDRATE. A `client:*` directive anywhere in this component would make it
   * a module the browser downloads — and the whole reason `src/lib/gear/routes.ts`,
   * `src/lib/packs/routes.ts` and `src/lib/auth-routes.ts` hold nothing but strings is that
   * a component like this one can render a link without becoming a reason for an auth SDK
   * to reach a client. Invariant D in tests/anonymous-read-path.test.ts catches the auth
   * half of that from the other side; this catches the directive itself, on a component
   * that is not on the allowlist and so would never reach that check.
   */
  it('ships no island', async () => {
    const html = await render(PACKS_PATH);

    expect(html).not.toMatch(/astro-island/);
    expect(html).not.toMatch(/client:(load|idle|visible|media|only)/);
  });
});
