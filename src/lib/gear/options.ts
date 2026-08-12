/**
 * Turns the closet list's "what categories and brands does this user already have"
 * query into de-duplicated, sorted option lists for the filter form on
 * `src/pages/gear/index.astro`.
 *
 * WHY THIS LIVES IN src/lib/ RATHER THAN IN THE PAGE. Same reasoning as every other
 * module in this directory (see `src/lib/gear/query.ts`'s own module comment):
 * `vitest.config.ts:64` excludes `src/pages/`, and de-duplication has a real decision
 * buried in it — whether `null`, `''` and whitespace-only values count as "an option"
 * — that deserves a test rather than a guess re-derived by whoever next touches the
 * page.
 *
 * THE QUERY ITSELF STAYS IN THE PAGE. This module only shapes what a query already
 * returned; it does not build one. The page issues
 * `client.from('gear_items').select('category, brand').is('deleted_at', null)` —
 * every active row's own two columns, for the signed-in visitor's own closet under
 * RLS — and hands the rows here. That query is deliberately NOT wrapped in a builder
 * function the way `applyGearQuery` wraps the main list query: there is no filtering,
 * sorting or paging decision in it for a test to pin, only two column names, so
 * wrapping it would add a layer with nothing behind it.
 *
 * POSTGREST CAPS HOW MANY ROWS ONE QUERY RETURNS (`db-max-rows`, 1000 on Supabase's
 * default configuration), so this options query — like the main list query it sits
 * beside — is bounded rather than exhaustive over an unlimited closet. That is fine at
 * the scale this product actually runs at:
 * `supabase/migrations/20260813000000_gear_closet.sql`'s "Deliberately no new
 * indexes" section puts a real closet at a few hundred rows, an order of magnitude
 * under the cap, so a filter dropdown missing an option is not a failure mode this
 * product needs to plan for today.
 */

/** The two columns the options query selects — exactly what this module needs and
 *  nothing else, so a page calling it does not have to over-fetch the full
 *  `GEAR_SELECT` row shape just to build two filter dropdowns. */
export interface GearOptionRow {
  readonly category: string | null;
  readonly brand: string | null;
}

/** The de-duplicated, alphabetically sorted option lists the filter form renders as
 *  checkboxes. Sorted rather than left in query order (which PostgREST does not even
 *  guarantee for an unordered select) because a filter list a visitor has to scan is
 *  more usable in a stable, predictable order than in whatever order rows happen to
 *  come back in. */
export interface GearOptions {
  readonly categories: readonly string[];
  readonly brands: readonly string[];
}

/**
 * `null`, `''` and whitespace-only values are all dropped rather than rendered as a
 * blank, unlabelled checkbox — none of the three names an option a visitor could
 * meaningfully filter by. Case is preserved exactly as stored: unlike `GEAR_STATUSES`,
 * category and brand are free text with no canonical casing, so folding "Tent" and
 * "tent" together would silently merge two values a visitor may have intended to keep
 * distinct.
 */
function distinctSortedValues(values: readonly (string | null)[]): string[] {
  const seen = new Set<string>();
  for (const raw of values) {
    if (raw === null) continue;
    const trimmed = raw.trim();
    if (trimmed === '') continue;
    seen.add(trimmed);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

/** Shapes a `GearOptionRow[]` — one row per active gear item, category and brand
 *  columns only — into the two option lists the filter form's category and brand
 *  checkboxes are built from. An empty `rows` (a closet with no active items at all)
 *  returns two empty lists, which is also how `src/pages/gear/index.astro` tells "the
 *  closet is genuinely empty" apart from "these filters matched nothing" — see that
 *  page for the rest of that distinction. */
export function extractGearOptions(rows: readonly GearOptionRow[]): GearOptions {
  return {
    categories: distinctSortedValues(rows.map((row) => row.category)),
    brands: distinctSortedValues(rows.map((row) => row.brand)),
  };
}
