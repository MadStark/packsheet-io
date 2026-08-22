/**
 * @vitest-environment jsdom
 *
 * TWO TESTS IN THIS FILE ASK ABOUT A TREE RATHER THAN A STRING — the live status element's
 * nesting and the pager's, see `MARKUP_DOM` — and `DOMParser` is the tool for both. The alternative, importing `JSDOM` from the `jsdom`
 * package directly, keeps the rest of the file in the repository's default `node`
 * environment but does not typecheck: `jsdom` ships no types and this project has no
 * `@types/jsdom`, so `npx tsc --noEmit` fails on the import. The environment directive
 * costs one jsdom instance per run and nothing else — the string scans below neither know
 * nor care that a document exists. `tests/gear-live-list.test.ts` makes the same trade.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
 *   - That a swap produces the right list. That is `tests/gear-live-list.test.ts`, which
 *     drives the module against fixtures in jsdom, and `tests/gear-closet.test.ts`, which
 *     proves the server answers each URL correctly in the first place.
 *
 * TWO THINGS THIS FILE USED TO DISCLAIM AND NOW PROVES (PK-70 review). The list above also
 * said nesting was out of reach — "that `#gear-live-status` really sits outside every
 * swapped region rather than merely lacking the attribute itself, or that the pager really
 * sits inside `#gear-list` so a `page:` click has a region to scroll … are facts about a DOM
 * tree; this file reads a flat string". True of a flat string, and the wrong conclusion:
 * both facts are exactly the kind that fail SILENTLY (a live region nested inside its own
 * swap simply stops announcing; a pager outside the list region scrolls nothing), and the
 * template can be parsed into a tree by the same jsdom this repository already depends on.
 * See `MARKUP_DOM` below for what that parse can and cannot be trusted with.
 *
 * COMMENTS ARE STRIPPED BEFORE EVERY ASSERTION, and that is not a convenience. This
 * codebase's house style is to RECORD a superseded decision rather than delete it, so the
 * page's own comments quote, verbatim, the copy PK-70 removed and the constant it stopped
 * importing — which is exactly right for a reader and exactly wrong for a `not.toContain`.
 * Stripping first is also what stops the POSITIVE assertions passing for the wrong reason: a
 * comment that merely NAMES `data-gear-live-region` must not satisfy a test claiming the
 * markup emits it.
 */

/** Resolved from the run's root rather than from `import.meta.url`, which is the idiom every
 *  OTHER file-reading test here uses (`tests/migration-hygiene.test.ts` and friends). Those
 *  all run in the default `node` environment, where `import.meta.url` is a `file:` URL;
 *  under the `jsdom` environment this file now declares it is not, and `fileURLToPath`
 *  rejects it with "The URL must be of scheme file" before a single test collects. Vitest
 *  runs every worker with the project root as its working directory — the same root
 *  `vitest.config.ts` resolves `include` against — so this names the same file, from the one
 *  anchor both environments agree on. */
const PAGE_PATH = resolve(process.cwd(), 'src/pages/gear/index.astro');

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
 *
 * WHOLE-LINE `//` COMMENTS GO FIRST, AND THE ORDER IS THE BUG FIX (PK-70 review). This ran
 * the block-comment pass first, and that pass is a naive opener-to-closer scan with no idea
 * what a comment is. The page's own frontmatter carries the line `// \`src/pages/**\` from
 * collection …` — inside a line comment, but the literal characters `/**` are there, so the
 * scan opened a block comment on a glob and closed it on the next real terminator, lines
 * BELOW, silently deleting the run of frontmatter in between (the `checkedStatuses`
 * derivation among it) from everything this file asserts against. Exactly the failure the
 * paragraph above warns about, arriving from a direction it did not anticipate: a positive
 * assertion about that code cannot fail here, because the code is not in the string. Cutting
 * the `//` lines before the block pass removes the false opener along with the comment that
 * contained it. It cannot cost anything the old order kept — a line that is nothing but a
 * comment was going to be dropped either way.
 */
function withoutComments(source: string): string {
  return source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

const MARKUP = withoutComments(readFileSync(PAGE_PATH, 'utf8'));

/**
 * The page's TEMPLATE half, parsed as HTML — the only way to state a fact about NESTING, and
 * deliberately fenced about with what it is not.
 *
 * THE FRONTMATTER IS CUT FIRST, and that is not tidiness: it is TypeScript, and TypeScript
 * carrying `<` and `>` in generics and comparisons parses into tags that were never markup.
 * Everything before and including the closing `---` goes; what is left is the template, whose
 * Astro expressions (`{items.map(…)}`, `checked={…}`) an HTML parser reads as ordinary text
 * and attribute values rather than as structure.
 *
 * WHAT A PARSE OF A TEMPLATE MEANS. Both arms of every ternary are present at once, so this
 * tree is not any single rendered page — it is every branch superimposed. That makes it
 * useless for counting elements and exactly right for CONTAINMENT, which is the one question
 * asked of it below: an element written inside another in the source is inside it in every
 * branch that renders both, and no branch can move it out. Anything stronger belongs in
 * `tests/gear-closet.test.ts`, which renders the real page against a real database.
 */
const MARKUP_DOM = new DOMParser().parseFromString(
  MARKUP.replace(/^[\s\S]*?\n---\n/, ''),
  'text/html',
);

/**
 * The body of the inline fallback's `change` handler, on its own — `''` if it cannot be
 * found, which is itself a failure the test below states rather than passing vacuously.
 *
 * WHY A SCOPED EXTRACT AND NOT `MARKUP.toContain(…)`. The thing that must be true of the
 * readiness check is WHERE it is, not that it exists: inside the handler, re-read on every
 * fire. A file-wide `toContain` is satisfied by the one arrangement this handshake must
 * never have — the check hoisted to listener-install time, where the attribute is always
 * absent — and by a check written after the submit it was supposed to guard. Both are the
 * double-fire the attribute exists to prevent, and both keep a file-wide assertion green.
 */
const INLINE_SUBMIT_HANDLER: string =
  MARKUP.match(/const\s+submit\s*=\s*function\s*\([^)]*\)\s*\{([\s\S]*?)\n\s*\};/)?.[1] ?? '';

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
    // existing.
    expect(tag).not.toContain(LIVE_REGION_ATTRIBUTE);
  });

  it('KEEPS THE LIVE STATUS ELEMENT OUTSIDE EVERY SWAPPED REGION, which is a fact about the tree and not about the tag — nesting it inside one would look identical in a screenshot and be silent in use', () => {
    const liveStatus = MARKUP_DOM.getElementById(GEAR_LIVE_STATUS_ID);

    expect(liveStatus).not.toBe(null);
    // Not carrying the attribute is the assertion above; not being INSIDE something that
    // does is this one, and only the second is the actual requirement. A region's swap
    // replaces its whole `innerHTML`, so an announcement element anywhere under one is
    // destroyed and recreated by the very update it was supposed to announce — the node the
    // screen reader was observing stops existing, and nothing is read out.
    expect(liveStatus?.closest(`[${LIVE_REGION_ATTRIBUTE}]`)).toBe(null);
  });

  it('PUTS BOTH PAGER LINKS INSIDE THE LIST REGION, so a page: click has a region to scroll back to the top of', () => {
    const listRegion = MARKUP_DOM.getElementById(LIVE_REGION_IDS.list);

    expect(listRegion).not.toBe(null);
    // `initGearLiveList` finds the region to scroll with `link.closest('[…live-region]')`
    // (its point (h)). A pager rendered as a sibling of `#gear-list` rather than a
    // descendant still swaps, still fetches and still pages — it just silently stops
    // scrolling, leaving a visitor who paged from row 50 looking at whatever occupies that
    // scroll position in the new page.
    expect(listRegion?.querySelector(`[${LIVE_LINK_ATTRIBUTE}="page:prev"]`)).not.toBe(null);
    expect(listRegion?.querySelector(`[${LIVE_LINK_ATTRIBUTE}="page:next"]`)).not.toBe(null);
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

  it('has the inline fallback stand down on the same attribute the module sets, CHECKED INSIDE THE HANDLER AND BEFORE IT SUBMITS, so a status tick never fires twice', () => {
    // SCOPED TO THE HANDLER'S OWN BODY (PK-70 review), where this used to assert
    // `MARKUP.toContain("hasAttribute(…)")` against the whole file — true no matter WHERE
    // the check sat, including the one place it must never sit. `live-list.ts`'s
    // LIVE_READY_ATTRIBUTE header records an earlier draft that put it at listener-INSTALL
    // time; that draft reads as perfectly plausible and is wrong on every single visit,
    // because the inline script runs during parsing and the attribute is necessarily absent
    // then — the fallback would arm every time and race a full navigation against every
    // in-place update. Only a check that re-reads the attribute AT FIRE TIME can stand down.
    expect(INLINE_SUBMIT_HANDLER).not.toBe('');

    // PRESENCE, not a value: the module writes the attribute with an empty string, so a
    // `=== 'true'` comparison would be a fallback that never stands down.
    const check = INLINE_SUBMIT_HANDLER.indexOf(`hasAttribute('${LIVE_READY_ATTRIBUTE}')`);
    expect(check).toBeGreaterThanOrEqual(0);
    // And it guards the submit rather than trailing it: a check after the call is the same
    // double-fire with an extra line.
    expect(check).toBeLessThan(INLINE_SUBMIT_HANDLER.indexOf('requestSubmit()'));
  });

  it('ticks the status boxes from effectiveGearStatuses, not from the raw query, so the boxes cannot disagree with the rows the server just returned', () => {
    // Both halves matter and neither implies the other. `query.statuses` is what
    // `parseGearQuery` found in the URL — EMPTY for a fresh `/gear` — and it is
    // `effectiveGearStatuses` that turns "the visitor named none" into the owned + wishlist
    // pair `applyGearFilters` actually filtered by. Rendering `checked` from `query.statuses`
    // directly would compile, pass every type check, and produce three empty boxes over a
    // list of owned and wishlist rows on the closet's most common URL.
    expect(MARKUP).toContain('const checkedStatuses = effectiveGearStatuses(query.statuses)');
    expect(MARKUP).toContain('checked={checkedStatuses.includes(status)}');
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
  ])('no longer renders %s', (_what, copy) => {
    // Comments are stripped (see `withoutComments`): the page quotes both of these in the
    // comments that record why they went, which is the house style and would otherwise make
    // each of these assertions fail for the right reason at the wrong layer.
    expect(MARKUP).not.toContain(copy);
  });

  it('STILL ADVISES THAT A STATUS TICK CHANGES THE LIST, in wording true of the in-place update AND of the reload that can still happen before the module is ready', () => {
    // THIS CASE USED TO ASSERT THE OPPOSITE — it sat in the list above as "the WCAG 3.2.2
    // advisory for an auto-submit that no longer navigates", pinning the REMOVAL of
    // `Changing a status updates the list.`. PK-70's review showed that removal rested on a
    // false premise: the inline script removes the Apply button at PARSE time,
    // unconditionally, while the module that takes over is deferred — so on EVERY visit
    // there is a window in which a tick still falls through to `requestSubmit()` and
    // reloads the page, with no advisory anywhere. The sentence is back, reworded to be
    // true either way ("the list below" changes whether it is swapped or re-rendered), and
    // this assertion is what stops a future tidy-up removing it again on the old argument.
    expect(MARKUP).toContain('Changing a status updates the list below.');
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
