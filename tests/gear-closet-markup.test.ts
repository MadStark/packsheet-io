import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  GEAR_FILTERS_FORM_ID,
  GEAR_LIVE_STATUS_ID,
  LIVE_LINK_ATTRIBUTE,
  LIVE_READY_ATTRIBUTE,
  LIVE_REGION_ATTRIBUTE,
  LIVE_SUMMARY_ATTRIBUTE,
} from '../src/lib/gear/live-list';

/**
 * THE JOIN BETWEEN `src/pages/gear/index.astro` AND `src/lib/gear/live-list.ts` (PK-70),
 * asserted by reading the page as TEXT — which wants justifying twice over, because it is
 * neither of the two techniques this repository normally reaches for.
 *
 * WHY NOT A RENDER TEST, THE WAY `tests/modal-component.test.ts` PINS THE SAME KIND OF JOIN
 * FOR `Modal.astro`. That component is pure markup and renders from props, so
 * `AstroContainer` can build it in a vacuum. This page cannot: its frontmatter reads
 * `Astro.locals.user`, redirects an anonymous visitor to sign-in, and then makes three
 * owner-scoped Supabase calls (`loadGearOptions`, `loadGearCloset`, `readWeightSystem`)
 * before a single tag is emitted. Rendering it means standing up a session and a database,
 * which is `tests/gear-closet.test.ts`'s job and is not what this file is about.
 *
 * WHY A SOURCE SCAN IS A LEGITIMATE TOOL HERE AND NOT A SHORTCUT. `vitest.config.ts:64`
 * excludes `src/pages/**` from COLLECTION — a test file may not LIVE there, because every
 * file under it becomes a route — but nothing stops a test in `tests/` from reading a page
 * off disk, and `tests/anonymous-read-path.test.ts` already establishes scanning shipped
 * source as a real technique in this suite (its Invariant C is a text scan, and it says so).
 * A source assertion is the only join available between this page and this module, and the
 * join needs one.
 *
 * WHY IT NEEDS ONE: THE FAILURE MODE IS SILENT, AND IT IS SILENT IN THE WORST WAY. The page
 * writes `data-gear-live-region`, `data-gear-live-link`, `data-gear-summary`,
 * `data-gear-live-ready`, `id="gear-filters"` and `id="gear-live-status"` as LITERALS in its
 * markup, for the reason `Modal.astro`'s header gives for doing the same with
 * `MODAL_ATTRIBUTE`: interpolating them from the imports costs more legibility than the join
 * is worth. Rename either side and nothing throws. `initGearLiveList` finds no form, or no
 * regions, returns `null`, and every control on the page falls back to what it already was —
 * a real `<a href>`, a real GET form, a real navigation. That is INDISTINGUISHABLE from the
 * intended no-JS path: the list still filters, still sorts, still pages. The feature is dead
 * and the whole suite is green. These assertions are the only thing standing between a
 * rename and that outcome.
 *
 * WHAT THIS FILE CANNOT PROVE, stated plainly so nobody mistakes a green run here for the
 * feature working:
 *
 *   - That the script RUNS. A string in a file is not a bundle that loaded, initialised and
 *     bound a listener. Only a real browser can say that, and the browser pass is where it
 *     is said.
 *   - That the regions are correctly NESTED — that `#gear-live-status` really sits outside
 *     every swapped region rather than merely lacking the attribute itself, or that the
 *     pager really sits inside `#gear-list` so a `page:` click has a region to scroll. Those
 *     are facts about a DOM tree; this file reads a flat string.
 *   - That a swap produces the right list. That is `tests/gear-live-list.test.ts`, which
 *     drives the module against fixtures in jsdom, and `tests/gear-closet.test.ts`, which
 *     proves the server answers each URL correctly in the first place.
 *
 * COMMENTS ARE STRIPPED BEFORE EVERY ASSERTION, and that is not a convenience. This
 * codebase's house style is to RECORD a superseded decision rather than delete it, so the
 * page's own comments quote, verbatim, the copy PK-70 removed and the constant it stopped
 * importing — which is exactly right for a reader and exactly wrong for a `not.toContain`.
 * Stripping first is also what stops the POSITIVE assertions passing for the wrong reason: a
 * comment that merely NAMES `data-gear-live-region` must not satisfy a test claiming the
 * markup emits it.
 */

const PAGE_PATH = fileURLToPath(new URL('../src/pages/gear/index.astro', import.meta.url));

/**
 * The page with every comment removed: `{/* … *\/}` expression comments and bare `/* … *\/`
 * blocks in the frontmatter and the `<script>`s, plus whole lines that are nothing but a
 * `//` comment.
 *
 * LINE COMMENTS ARE ONLY STRIPPED WHERE THEY START THE LINE, which is how every one in this
 * page is written. A blanket `//`-to-end-of-line rule would also cut a `//` inside a string
 * literal — `https://…` in a message, say — and since every assertion below is either
 * `toContain` or `not.toContain`, over-stripping is the dangerous direction: it can only
 * ever hide something a test was meant to catch.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

const MARKUP = withoutComments(readFileSync(PAGE_PATH, 'utf8'));

/** The opening tag carrying a given `id`, or `''`. Scoped so that "this element has the live
 *  region attribute" cannot pass because some OTHER element on the page has it — the same
 *  reason `tests/modal-component.test.ts` matches the `<dialog>`'s own tag rather than the
 *  whole document when it asserts about naming attributes. */
const tagWithId = (id: string): string =>
  MARKUP.match(new RegExp(`<[a-zA-Z][^<>]*\\bid="${id}"[^<>]*>`))?.[0] ?? '';

/** The three ids PK-70 gives to `LIVE_REGION_ATTRIBUTE`, each with the reason it is a region
 *  rather than part of one. Named here so a future fourth region has an obvious place to be
 *  declared, and so removing one is a failing test rather than a quietly stale corner of the
 *  page. */
const LIVE_REGION_IDS = {
  /** The table, the bulk bar and the pager — or the "no items match" block that replaces all
   *  three. The thing the whole feature exists to update. */
  list: 'gear-list',
  /** "Items N" in the header sheet. It is the count of rows matching the CURRENT filters, so
   *  outside the list region it would go stale on the first filter change — a wrong number
   *  stated confidently above a correct list. */
  figures: 'gear-figures',
  /** Import and Add item. Both carry a `next=` naming the view they were rendered for, so an
   *  un-swapped copy sends the visitor back to the pre-filter view after a save. */
  actions: 'gear-actions',
} as const;

describe('the gear closet page’s live-update markup', () => {
  it('gives the filter form the id the module looks it up by, which is the lookup everything else hangs off', () => {
    // `initGearLiveList` returns null the moment this misses, and returning null is an
    // ORDINARY outcome it deliberately does not warn about (the empty closet renders no form
    // at all), so a typo here produces no console noise whatsoever.
    expect(MARKUP).toContain(`id="${GEAR_FILTERS_FORM_ID}"`);
  });

  it('renders the persistent live region the module announces into, and does NOT mark it as a swapped region', () => {
    const tag = tagWithId(GEAR_LIVE_STATUS_ID);

    expect(tag).not.toBe('');
    expect(tag).toContain('role="status"');
    // The load-bearing half: a live region that is itself replaced wholesale does not
    // reliably announce, because the node the assistive technology was observing stops
    // existing. This can only prove the element does not carry the attribute ITSELF — that
    // it is not nested inside a region that does is a fact about the tree, and this file
    // reads a string. See the header.
    expect(tag).not.toContain(LIVE_REGION_ATTRIBUTE);
  });

  it.each(Object.entries(LIVE_REGION_IDS))(
    'marks the %s region with the attribute the module swaps on, spelled as the module spells it',
    (_name, id) => {
      expect(tagWithId(id)).toContain(LIVE_REGION_ATTRIBUTE);
    },
  );

  it('makes each sortable column header a live link naming its sort key', () => {
    // The value shape `liveLinkKind` parses, not merely the attribute name: an attribute
    // carrying a value that function returns null for is an attribute the module reads as
    // "do not intercept this click", which is a live link that silently is not one.
    expect(MARKUP).toContain(`${LIVE_LINK_ATTRIBUTE}={\`sort:`);
  });

  it('marks both pager edges with the exact values liveLinkKind recognises', () => {
    expect(MARKUP).toContain(`${LIVE_LINK_ATTRIBUTE}="page:prev"`);
    expect(MARKUP).toContain(`${LIVE_LINK_ATTRIBUTE}="page:next"`);
  });

  it('marks the “Showing 1–12 of 47” line, which is the only text the announcement is built from', () => {
    // `liveStatusMessage` reads this element's rendered text rather than recomputing the
    // count, so losing the attribute does not produce a wrong announcement — it produces
    // NO_RESULTS_ANNOUNCEMENT on a page full of results.
    expect(MARKUP).toContain(LIVE_SUMMARY_ATTRIBUTE);
  });

  it('has the inline fallback stand down on the same attribute the module sets, so a status tick never fires twice', () => {
    // The handshake in both directions: the page must name the attribute, and it must test
    // for PRESENCE — the module writes it with an empty value, so a `=== 'true'` comparison
    // would be a fallback that never stands down and a full navigation racing every
    // in-place update.
    expect(MARKUP).toContain(`hasAttribute('${LIVE_READY_ATTRIBUTE}')`);
  });

  it('actually imports the module, so every attribute above has something reading it', () => {
    expect(MARKUP).toContain('initGearLiveList');
    expect(MARKUP).toContain("from '../../lib/gear/live-list'");
  });
});

describe('what PK-70 took off the page', () => {
  it.each([
    ['the “Gear” eyebrow above a title that already says gear', 'class="eyebrow"'],
    ['the “everything, weighed once” aside', 'everything, weighed once'],
    [
      'the WCAG 3.2.2 advisory for an auto-submit that no longer navigates',
      'Changing a status updates the list.',
    ],
  ])('no longer renders %s', (_what, copy) => {
    // Comments are stripped (see `withoutComments`): the page quotes all three of these in
    // the comments that record why they went, which is the house style and would otherwise
    // make every one of these assertions fail for the right reason at the wrong layer.
    expect(MARKUP).not.toContain(copy);
  });

  it.each(['GEAR_MARKER_ROW_CLASS', 'row-wishlist', 'row-retired'])(
    'carries no reference to %s, the coloured row rail DESIGN.md §7 was amended to drop',
    (name) => {
      // `GEAR_MARKER_ROW_CLASS` no longer exists in `src/lib/gear/format.ts` at all, so a
      // surviving import would fail the build rather than this test — but a surviving CLASS
      // NAME would not, and a `.row-retired` hand-written onto a `<tr>` would style nothing
      // at all now that `src/styles/paper.css` renames the rule to `.row-invalid` for the
      // import preview's failed rows. Silent either way; hence both halves are pinned.
      expect(MARKUP).not.toContain(name);
    },
  );
});
