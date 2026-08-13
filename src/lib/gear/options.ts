/**
 * The closet's "what categories and brands does this user already have" query, and the
 * de-duplication that turns its rows into sorted option lists.
 *
 * WHAT THIS MODULE IS FOR CHANGED IN PK-62, AND THE TWO HALVES NOW HAVE DIFFERENT
 * CALLERS — read this before concluding either half is dead code.
 *
 *   - `loadGearOptions` is still called by `src/pages/gear/index.astro` on every render,
 *     but no longer for its DATA. PK-62 deleted the Category and Brand filter checkboxes
 *     it used to populate; what the page needs now is only whether the query returned
 *     ANY row, because that is how `closetIsEmpty` tells "your closet is genuinely
 *     empty" apart from "these filters matched nothing" — two honestly different empty
 *     states that collapse into one wrong message without it. `.is('deleted_at', null)`
 *     is load-bearing for that reading specifically: a closet whose every item is in the
 *     trash must report as EMPTY, not as full-but-filtered.
 *   - `extractGearOptions` has NO production caller as of PK-62 and is kept, with its
 *     tests, for the item form's category autocomplete (PK-63). That is a forward-looking
 *     bet: if PK-63 changes shape and never wants it, delete this function rather than
 *     leaving it here indefinitely on the strength of this sentence.
 *
 * SINCE ONLY A BOOLEAN IS READ FROM IT TODAY, `loadGearOptions` fetches up to
 * `db-max-rows` rows and two columns to answer a question `.limit(1)` or a `head: true`
 * count would answer. Left as-is deliberately rather than optimised into something PK-63
 * would immediately have to widen again — but if PK-63 does not land, narrowing it is
 * the obvious cleanup.
 *
 * WHY THIS LIVES IN src/lib/ RATHER THAN IN THE PAGE. Same reasoning as every other
 * module in this directory (see `src/lib/gear/query.ts`'s own module comment):
 * `vitest.config.ts:64` excludes `src/pages/`, and de-duplication has a real decision
 * buried in it — whether `null`, `''` and whitespace-only values count as "an option"
 * — that deserves a test rather than a guess re-derived by whoever next touches the
 * page.
 *
 * THE QUERY ITSELF LIVES HERE TOO, as `loadGearOptions` below — moved out of the page
 * (PK-4 review, C3/I3). An earlier version of this comment described the page's own
 * query as `client.from('gear_items').select('category, brand').is('deleted_at',
 * null)` and called the result "the signed-in visitor's own closet under RLS" — THAT
 * WAS THE EXACT BUG THIS FEATURE EXISTS TO PREVENT, not a simplification. `gear_items`
 * carries TWO permissive SELECT policies (core_schema.sql): `gear_items_select_own`
 * (owner only) and `gear_items_select_via_public_pack`, granted to `anon,
 * authenticated` alike so a shared pack link can render the gear behind it. RLS
 * policies are UNIONED, not intersected, so that query — with no explicit owner filter
 * — would answer with this visitor's own rows OR any row that happens to sit on
 * ANYONE's public pack: "under RLS" alone does not mean "my own closet" for this table,
 * ever. `loadGearOptions` adds `.eq('user_id', userId)` for the same reason
 * `loadGearCloset` (`src/lib/gear/query.ts`) does on the main list query — see that
 * function's own comment for the fuller version of this same argument — which is also
 * what makes the owner scope something `tests/gear-closet.test.ts` can now assert on
 * directly, rather than trusting a comment that turned out to say the opposite of what
 * was true.
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

import type { PacksheetClient } from '../supabase';

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

/**
 * The owner-scoped options query itself — see the module comment's "THE QUERY ITSELF
 * LIVES HERE TOO" section for why this moved out of `src/pages/gear/index.astro` and
 * what the un-scoped version of it used to get wrong. `.is('deleted_at', null)`
 * matters independently of the owner filter: a trashed item's category/brand should
 * not populate a filter checkbox for a closet it no longer appears in.
 */
export async function loadGearOptions(client: PacksheetClient, userId: string) {
  return client
    .from('gear_items')
    .select('category, brand')
    .eq('user_id', userId)
    .is('deleted_at', null);
}
