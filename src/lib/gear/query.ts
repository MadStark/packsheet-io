/**
 * The pure translation layer between a URL query string and the PostgREST query the
 * gear closet list (PK-4) issues. Read `src/lib/gear/fields.ts` first — the vocabulary
 * this module validates against — and the module comment on `src/lib/units.ts` for
 * `toGrams`/`WeightUnit`, which the weight-range parsing here leans on directly.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS LIVES IN src/lib/ RATHER THAN IN THE PAGE
 * ---------------------------------------------------------------------------
 *
 * `vitest.config.ts:64` excludes `src/pages/` from the test run, because every file
 * there becomes a route. `src/pages/account/index.astro:51-55` names the same reasoning
 * for `src/lib/account-deletion.ts`: code written in frontmatter is code no test in this
 * repository can reach. The gear closet's filter/sort/page state is the URL query
 * string and nothing else — the closet is server-rendered specifically so that
 * `@supabase/*` never has to reach the browser (see `tests/anonymous-read-path.test.ts`)
 * — so EVERY rule about what a hand-edited or hostile URL means has to live somewhere
 * `tests/gear-query.test.ts` can call directly. This module is that somewhere.
 *
 * ---------------------------------------------------------------------------
 * TOTALITY: A URL CAN NEVER 500 THIS
 * ---------------------------------------------------------------------------
 *
 * `parseGearQuery` is total over `URLSearchParams` — there is no input that makes it
 * throw. A visitor can hand-edit `?page=-1&sort=DROP%20TABLE&wunit=stones` (or a search
 * engine, a stale bookmark, or a deliberately hostile request can), and the only
 * acceptable response is a `GearQuery` built from sane defaults for whatever could not
 * be understood — never a 500. Every parsing helper below follows the same shape:
 * validate, and fall back to a documented default rather than propagate a bad value or
 * throw. `toGrams` is the one exception worth calling out explicitly, because it is the
 * one dependency of this module that DOES throw (see its own module comment, "THROW,
 * NOT RETURN") — every call to it here is inside a guard that turns that throw into
 * `null`, which is this module's own equivalent of a safe default for a weight it could
 * not understand.
 *
 * ---------------------------------------------------------------------------
 * NOT importing src/lib/auth/
 * ---------------------------------------------------------------------------
 *
 * This module takes a `PacksheetClient` as a parameter to `applyGearQuery` rather than
 * constructing or authenticating one itself. Importing `src/lib/auth/` would need an
 * `AUTH_CONSUMERS` entry (see that module's own doc comment on the allowlist added in
 * PK-19), and a pure query-building module does not authenticate anybody — it has no
 * business asking for that standing permission. The page that calls `applyGearQuery`
 * already has an authenticated client from middleware; this module only ever borrows it
 * for the duration of one call.
 */

import type { PacksheetClient } from '../supabase';
import { toGrams, fromGrams, isWeightUnit, WEIGHT_DECIMALS, type WeightUnit } from '../units';
import {
  GEAR_DEFAULT_DIRECTION,
  GEAR_DEFAULT_SORT,
  GEAR_PAGE_SIZE,
  GEAR_SORT_COLUMNS,
  MAX_SEARCH_LENGTH,
  effectiveGearStatuses,
  isGearSortKey,
  isGearStatus,
  type GearSortKey,
  type GearStatus,
} from './fields';
import { GEAR_PATH } from './routes';
// The export's column list, kept beside the type it produces rather than here — see
// `GEAR_EXPORT_SELECT`'s own comment in that module for why the two live together.
import { GEAR_EXPORT_SELECT } from './json-schema';

// ---------------------------------------------------------------------------
// GearQuery
// ---------------------------------------------------------------------------

/**
 * The closet list's entire filter/sort/page state, parsed once from the URL by
 * `parseGearQuery` and turned back into one by `gearQueryToSearchParams`. Every field is
 * either already validated (an unknown status can never appear in `statuses`) or already
 * range-checked (`page >= 1`), so nothing downstream — `applyGearQuery`, or a page
 * rendering the active filters back to the visitor — has to re-validate any of it.
 */
export interface GearQuery {
  /** Trimmed and length-capped at `MAX_SEARCH_LENGTH`. `''` means "no search". */
  search: string;
  /** Distinct, first-seen order, whatever `category` values were repeated in the URL. */
  categories: readonly string[];
  /** Distinct, first-seen order, and only values `isGearStatus` accepts — but unlike
   *  `categories`/`brands` below, empty here does NOT mean "no filter"; it resolves to
   *  `GEAR_DEFAULT_STATUSES` (see `effectiveGearStatuses` in fields.ts). */
  statuses: readonly GearStatus[];
  /** Distinct, first-seen order, whatever `brand` values were repeated in the URL. */
  brands: readonly string[];
  /** Lower bound on `weight_grams`, already converted from whatever unit it was entered
   *  in. `null` means "no lower bound". See "MIN > MAX IS KEPT, NEVER FIXED" below for
   *  what happens when this exceeds `maxGrams`. */
  minGrams: number | null;
  /** Upper bound on `weight_grams`, same conversion. `null` means "no upper bound". */
  maxGrams: number | null;
  /** The unit `wmin`/`wmax` were entered in — kept (rather than discarded once converted
   *  to grams) so that a round trip through `gearQueryToSearchParams` gives back the
   *  figure the visitor actually typed, in the unit they typed it in, rather than a grams
   *  figure they never entered.
   *
   *  PK-62 REMOVED THE FORM THIS WAS WRITTEN FOR. The weight-range inputs and the unit
   *  picker are gone from `src/pages/gear/index.astro`, so nothing re-renders these
   *  values to a visitor today; what still depends on the round trip is every link that
   *  rebuilds the current query — sort headers, the pager, and the hidden inputs the
   *  filter form re-emits (see `unsurfacedFilterParams`). Dropping the unit would silently
   *  change a hand-edited or bookmarked `?wmin=2&wunit=lb` into a 2-GRAM bound the first
   *  time the visitor clicked a column header. */
  weightUnit: WeightUnit;
  sort: GearSortKey;
  direction: 'asc' | 'desc';
  /** 1-based. Always a positive integer, clamped at `MAX_GEAR_PAGE`. */
  page: number;
}

/**
 * The largest page `parseGearQuery` will ever produce. Paired with `GEAR_PAGE_SIZE`
 * (50), this bounds the largest `.range()` offset `applyGearQuery` can ever be asked to
 * request at roughly five million rows in — far beyond any real closet (a few hundred
 * rows at most; see the gear-closet migration's "Deliberately no new indexes" section)
 * and far short of leaving the offset genuinely unbounded. Without a ceiling, `?page=`
 * set to an enormous digit string is a request PostgREST would have to answer honestly:
 * "count and skip N rows", turned into arbitrarily expensive work by nothing more than
 * a longer number in the URL.
 */
export const MAX_GEAR_PAGE = 100_000;

// ---------------------------------------------------------------------------
// parseGearQuery
// ---------------------------------------------------------------------------

function parseSearch(params: URLSearchParams): string {
  const raw = params.get('q');
  if (raw === null) return '';
  return raw.trim().slice(0, MAX_SEARCH_LENGTH);
}

/**
 * Repeated params (`?category=a&category=b`), trimmed, with empties dropped and
 * duplicates removed while keeping the order they first appeared in. Order is preserved
 * (rather than, say, sorted) because it is the order the visitor's own selections were
 * added to the URL, and re-rendering them in a different order would be a small, visible
 * surprise for no benefit.
 */
function parseStringList(params: URLSearchParams, key: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of params.getAll(key)) {
    const trimmed = raw.trim();
    if (trimmed === '' || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

/** Same shape as `parseStringList`, additionally dropping anything `isGearStatus`
 *  refuses — an old bookmark carrying a status this project renamed or removed is
 *  silently dropped rather than sent to PostgREST as a value `status in (...)` would
 *  simply never match. */
function parseStatuses(params: URLSearchParams): GearStatus[] {
  const seen = new Set<GearStatus>();
  const result: GearStatus[] = [];
  for (const raw of params.getAll('status')) {
    const trimmed = raw.trim();
    if (!isGearStatus(trimmed) || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

/**
 * `wmin`/`wmax`, converted to grams in the unit `wunit` names.
 *
 * Parsed with `Number()` rather than `parseFloat()` deliberately: `parseFloat('12abc')`
 * is `12`, silently discarding the trailing garbage and reporting a value the visitor
 * never actually typed. `Number('12abc')` is `NaN`, which this function already turns
 * into `null` — a value this module refuses to guess at is a more honest failure than a
 * value it half-read.
 *
 * `toGrams` is guarded rather than called bare, because it throws on a non-finite or
 * negative argument (see its own "THROW, NOT RETURN" module comment) and on a product
 * that itself overflows to `Infinity` — both real possibilities for a hand-edited
 * `wmin`, and both turned into `null` here rather than allowed to 500 the request.
 */
function parseWeightBoundary(raw: string | null, unit: WeightUnit): number | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0) return null;

  try {
    return toGrams(value, unit);
  } catch {
    return null;
  }
}

/**
 * `page`, defaulted to 1 for anything that is not a plain, non-negative, base-10 integer
 * string — `1.5`, `-3`, `abc`, `1e9` (scientific notation is not a plain digit string,
 * so it is refused the same way `abc` is) all land on 1. A digit string that IS a valid
 * integer but larger than `MAX_GEAR_PAGE` is clamped rather than refused: the visitor
 * asked for a real page, just an absurd one, and clamping to the last page this module
 * will ever construct a `.range()` for is a more honest answer than silently resetting
 * them to page 1, which would be a surprising jump for a merely-too-eager request (e.g.
 * a stale bookmark from when the closet held far more items).
 */
function parsePage(raw: string | null): number {
  if (raw === null) return 1;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return 1;

  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value < 1) return 1;
  return Math.min(value, MAX_GEAR_PAGE);
}

/**
 * Parses a `URLSearchParams` into a `GearQuery`. Total — see the module comment's
 * "TOTALITY" section — so no shape of hand-edited or hostile URL can make this throw or
 * make the page that calls it 500.
 *
 * MIN > MAX IS KEPT, NEVER FIXED. If `wmin` converts to a larger gram figure than `wmax`
 * — `?wmin=10&wmax=5` — both are kept exactly as parsed rather than swapped or either one
 * dropped. Swapping silently changes what the visitor asked for into a DIFFERENT,
 * unasked-for query that happens to return rows; dropping either bound does the same
 * with less honesty about it. Keeping both produces `weight_grams >= 10000 and
 * weight_grams <= 5000` in `applyGearQuery`, i.e. an always-false range, which is the
 * one response that stays true to the input: an empty result set the UI can explain
 * ("no items between 10g and 5g" is a legible thing to tell someone), rather than a
 * populated list answering a question they did not ask.
 */
export function parseGearQuery(params: URLSearchParams): GearQuery {
  const weightUnit = isWeightUnit(params.get('wunit')) ? (params.get('wunit') as WeightUnit) : 'g';

  const sortRaw = params.get('sort');
  const sort = isGearSortKey(sortRaw) ? sortRaw : GEAR_DEFAULT_SORT;

  const dirRaw = params.get('dir');
  const direction: 'asc' | 'desc' =
    dirRaw === 'asc' || dirRaw === 'desc' ? dirRaw : GEAR_DEFAULT_DIRECTION;

  return {
    search: parseSearch(params),
    categories: parseStringList(params, 'category'),
    statuses: parseStatuses(params),
    brands: parseStringList(params, 'brand'),
    minGrams: parseWeightBoundary(params.get('wmin'), weightUnit),
    maxGrams: parseWeightBoundary(params.get('wmax'), weightUnit),
    weightUnit,
    sort,
    direction,
    page: parsePage(params.get('page')),
  };
}

// ---------------------------------------------------------------------------
// gearQueryToSearchParams
// ---------------------------------------------------------------------------

/**
 * The inverse of `parseGearQuery`: turns a `GearQuery` back into a `URLSearchParams`,
 * emitting a param ONLY where the value differs from what `parseGearQuery` would have
 * produced from no params at all. That is what keeps a shared/bookmarked closet URL
 * short — `/gear` with every filter at its default carries no query string at all,
 * rather than `/gear?q=&category=&status=&brand=&wmin=&wmax=&wunit=g&sort=name&dir=asc&page=1`.
 *
 * ROUND-TRIP: `parseGearQuery(gearQueryToSearchParams(q))` must deep-equal `q` for any
 * `GearQuery` `q` that `parseGearQuery` could itself have produced — see
 * `tests/gear-query.test.ts` for the property test. The one place that is not obviously
 * exact is the weight range: `minGrams`/`maxGrams` are converted BACK to `weightUnit`
 * with `fromGrams` and serialised with `String()`, then re-parsed on the other end with
 * `Number()` and converted forward again with `toGrams`. `String()` on a finite JS
 * number always round-trips through `Number()` to the identical double (that half is
 * exact by the language specification), which leaves only whether
 * `toGrams(fromGrams(g, unit), unit) === g` for every `g` this module can produce — true
 * for every case exercised here and in `tests/units.test.ts`'s own round-trip suite,
 * because dividing and then multiplying by the same double factor lands back on the
 * original bit pattern far more often than the reverse direction (unit A -> unit B ->
 * unit A, which `roundWeight` exists to paper over) does. It is not a law of floating
 * point in general, which is why it is called out here rather than asserted silently.
 */
export function gearQueryToSearchParams(query: GearQuery): URLSearchParams {
  const params = new URLSearchParams();

  if (query.search !== '') params.set('q', query.search);

  for (const category of query.categories) params.append('category', category);
  for (const status of query.statuses) params.append('status', status);
  for (const brand of query.brands) params.append('brand', brand);

  // wunit is emitted whenever it is non-default, even if both bounds are null. The unit
  // picker this originally protected was removed by PK-62, but the emission still has to
  // be unconditional for the round-trip property to hold: `parseGearQuery` reads `wunit`
  // whether or not a bound is present, so omitting it here would make
  // `parse(serialize(q))` differ from `q` for any query carrying a non-gram unit and no
  // bound — exactly the invariant tests/gear-query.test.ts property-tests.
  if (query.weightUnit !== 'g') params.set('wunit', query.weightUnit);
  if (query.minGrams !== null)
    params.set('wmin', String(fromGrams(query.minGrams, query.weightUnit)));
  if (query.maxGrams !== null)
    params.set('wmax', String(fromGrams(query.maxGrams, query.weightUnit)));

  if (query.sort !== 'name') params.set('sort', query.sort);
  if (query.direction !== 'asc') params.set('dir', query.direction);
  if (query.page !== 1) params.set('page', String(query.page));

  return params;
}

// ---------------------------------------------------------------------------
// sortLinkSearchParams
// ---------------------------------------------------------------------------

/**
 * The `URLSearchParams` a sortable column header on the closet list should link to:
 * `sort` set to `key`, `direction` TOGGLED if `key` is already the active sort column
 * or reset to `'asc'` for a column that was not, `page` reset to 1, and every other
 * filter carried through unchanged via `gearQueryToSearchParams`.
 *
 * `page` IS RESET, DELIBERATELY. A stale offset into a differently-ordered result set
 * is not "page 3" of anything the visitor asked for — row 101-150 sorted by name and
 * row 101-150 sorted by price are, in general, two entirely different sets of items,
 * so keeping the same page number across a sort change would silently show the wrong
 * slice rather than an honest first page of the new order.
 *
 * Lives here rather than in the page template for the same reason every other rule in
 * this module does: `vitest.config.ts:64` excludes `src/pages/`, and "which direction
 * does clicking an already-active column head toggle to" is exactly the kind of small
 * decision that is easy to get backwards and impossible to pin with a test if it were
 * written in frontmatter.
 */
export function sortLinkSearchParams(query: GearQuery, key: GearSortKey): URLSearchParams {
  const direction: 'asc' | 'desc' =
    query.sort === key && query.direction === 'asc' ? 'desc' : 'asc';
  return gearQueryToSearchParams({ ...query, sort: key, direction, page: 1 });
}

// ---------------------------------------------------------------------------
// Unsurfaced filters — the params PK-62 left honoured but stopped rendering
// ---------------------------------------------------------------------------

/**
 * The `GearQuery` params that this module still parses and `applyGearFilters` still
 * applies, but which the closet list no longer renders any control for: `category`,
 * `brand` and the weight range (`wmin`/`wmax`/`wunit`).
 *
 * WHY THESE EXIST AT ALL AFTER PK-62. That ticket removed the Category, Brand and
 * Weight-range fieldsets from the UI. It deliberately did NOT remove them from the query
 * layer: they are tested, working, owner-scoped filtering that a later ticket may want to
 * surface again, and `/gear?category=Shelter` links were shipped to staging by PK-4, so
 * bookmarked and shared URLs carrying them already exist in the wild.
 *
 * WHAT THAT LEFT BROKEN, AND WHAT THESE TWO FUNCTIONS FIX. Removing the controls without
 * removing the behaviour gave the page three different answers to the same question.
 * Sort headers (`sortLinkSearchParams`, above) and the pager both round-trip the whole
 * query, so they PRESERVED these params; the filter form carried only `q`/`status`/
 * `sort`/`dir`, so submitting a search silently DROPPED them. A visitor arriving on a
 * bookmarked `?category=Shelter` therefore saw a closet narrowed for no stated reason,
 * kept that invisible filter while sorting and paging, and lost it the moment they typed
 * in the search box — three behaviours, none of them disclosed.
 *
 * `unsurfacedFilterParams` is what the form re-emits as hidden inputs so it stops being
 * the odd one out, and `hasUnsurfacedFilters` is what the page uses to TELL the visitor
 * the closet is filtered and offer them a way out. Derived from
 * `gearQueryToSearchParams` by subtraction rather than by listing the five names, so a
 * param added to `GearQuery` later is carried automatically instead of being silently
 * dropped by a list nobody remembered to update.
 */
export function unsurfacedFilterParams(query: GearQuery): URLSearchParams {
  const params = gearQueryToSearchParams(query);
  // Everything the closet list DOES render a control for, plus `page`, which the filter
  // form deliberately never carries (a new filter set changes what "page 3" means).
  for (const surfaced of ['q', 'status', 'sort', 'dir', 'page']) params.delete(surfaced);
  return params;
}

/**
 * Whether any unsurfaced filter is actually NARROWING the closet — which is not the same
 * question as whether `unsurfacedFilterParams` is non-empty. `wunit` alone is a unit
 * preference with no bound attached (`gearQueryToSearchParams` emits it whenever it is
 * non-default, precisely so a visitor's choice of `lb` survives a round trip), and it
 * filters nothing. Telling somebody their closet is filtered because a stale `?wunit=lb`
 * is sitting in the URL would be a false alarm, and false alarms are how a notice like
 * this one gets ignored when it matters.
 */
export function hasUnsurfacedFilters(query: GearQuery): boolean {
  return (
    query.categories.length > 0 ||
    query.brands.length > 0 ||
    query.minGrams !== null ||
    query.maxGrams !== null
  );
}

// ---------------------------------------------------------------------------
// gearListPath
// ---------------------------------------------------------------------------

/**
 * The URL a redirect back to the closet list's current filtered/sorted/paged view
 * should target: bare `GEAR_PATH` when `query` is exactly the all-default query (so a
 * redirect from an unfiltered view does not grow a pointless trailing `?`), or
 * `GEAR_PATH` with `gearQueryToSearchParams(query)` appended otherwise.
 *
 * WHY THIS EXISTS (PK-4 defect: "a bulk action throws away the active filter"). A
 * bulk action posts from, and belongs to, one particular filtered view; redirecting
 * unconditionally to a bare `GEAR_PATH` afterwards discards whatever
 * `q`/category/status/brand/weight/sort/page state the visitor was looking at — a
 * filtered-down "Bear Canister" search, say, losing its filter and dumping them back on
 * the full, unfiltered closet, immediately after an action they will very likely want
 * to follow with another one on the same selection. `src/pages/gear/index.astro`'s
 * bulk-action POST branches all redirect through this function instead.
 *
 * BUILT ON `gearQueryToSearchParams`, NOT A HAND-COPIED `URLSearchParams`. The tempting
 * alternative — `new URLSearchParams(Astro.url.searchParams)`, carried through as-is —
 * has to be kept in sync BY HAND with every param that is not really part of
 * `GearQuery`, and there is no guarantee the set of those stays empty forever. Routing
 * the redirect target through a parsed `GearQuery` instead means any param
 * `parseGearQuery` does not recognise as one of ITS OWN fields is dropped for free, the
 * same way a stray `?utm_source=` or a typo'd `?cagegory=` already is on every other
 * place this module round-trips a query — nothing has to remember to delete it by name.
 */
export function gearListPath(query: GearQuery): string {
  const search = gearQueryToSearchParams(query).toString();
  return search === '' ? GEAR_PATH : `${GEAR_PATH}?${search}`;
}

// ---------------------------------------------------------------------------
// buildSearchFilter
// ---------------------------------------------------------------------------

/**
 * Escapes `text` for literal use inside a Postgres POSIX regular expression — the
 * pattern language `~*`/`imatch` reads — so every ERE metacharacter (`\ ^ $ . | ? * +
 * ( ) [ ] { }`) is matched literally rather than interpreted as regex syntax. This is
 * the search text's own escaping layer, the direct analogue of what an `ilike`-based
 * search would need `%`/`_`/`\` escaped for; see `buildSearchFilter`'s own "WHY imatch,
 * NOT ilike" section for why the OPERATOR had to change, not merely this function's
 * character set.
 *
 * ONE PASS IS CORRECT HERE, UNLIKE A LIKE-STYLE ESCAPE. `String.replace` with a global
 * pattern scans the ORIGINAL string once, left to right, and never re-scans a
 * replacement it has already written — so a literal `\` in `text` is matched by this
 * same character class and escaped to `\\` in the one pass, with no risk of the
 * backslash it just introduced being picked up and re-escaped a second time.
 */
function escapeRegexPattern(text: string): string {
  return text.replace(/[\\^$.|?*+()[\]{}]/g, '\\$&');
}

/**
 * Escapes a value for use as one token inside a PostgREST `or=(...)`/`and=(...)` filter
 * expression, per the horizontal-filtering grammar PostgREST parses that query parameter
 * with (see https://postgrest.org/en/stable/references/api/tables_views.html#operators,
 * "Logical operators"). That grammar splits a filter list on top-level commas and reads
 * parentheses as `and(...)`/`or(...)` grouping, so a value carrying a literal comma,
 * parenthesis, or period would otherwise be read as PART OF THE GRAMMAR rather than as
 * data — confirmed empirically against the local stack in
 * `tests/gear-search-escaping.test.ts`, not assumed from the docs alone (a bare
 * `50%` search term, unescaped, is exactly the input that would silently start matching
 * everything if either escaping layer here were skipped or applied in the wrong order).
 *
 * The fix is to wrap the value in double quotes UNCONDITIONALLY, rather than only when a
 * reserved character is detected — detection is one more place a character could be
 * missed, and quoting a value that did not strictly need it costs nothing and is always
 * accepted by PostgREST's parser. Inside double quotes, only two characters are special
 * to PostgREST's own grammar: `"` itself (would end the quoted value early) and `\`
 * (PostgREST's quote-escape introducer). Both are escaped with a backslash, `\` first for
 * the same reason `escapeLikePattern` orders its own two escapes: escaping `"` before `\`
 * would double-escape the backslash just introduced in front of each quote.
 */
function quoteForPostgrestFilterValue(value: string): string {
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

/**
 * The `.or()` argument (without the outer parentheses postgrest-js's own `.or()` adds —
 * see that method's implementation) matching `search` against `name` OR `brand`,
 * case-insensitively, as a SUBSTRING match: `search` can appear anywhere in either
 * column, not only at the start.
 *
 * WHY `imatch` (`~*`), NOT `ilike` — THE `*` WILDCARD BUG (PK-4 review, I1). An earlier
 * version of this function used `ilike`, LIKE-escaping `%`/`_`/`\` the way this comment
 * used to describe. That has a hole no amount of escaping inside the value can close:
 * PostgREST rewrites a literal `*` inside an `ilike`/`like` filter value into `%`
 * BEFORE Postgres ever sees it — a documented convenience so a URL does not have to
 * percent-encode `%` as `%25` — and the rewrite is unconditional, applied to the
 * OPERATOR's value wholesale, not to unescaped input specifically. Backslash-escaping
 * the asterisk does not save it: PostgREST rewrites `\*` to `\%`, which Postgres's own
 * LIKE-escape handling then reads back as "a literal percent sign", not "a literal
 * asterisk" — so `?q=*` returned the entire closet, and `a*b` matched rows that never
 * contained the typed text. No fix inside `escapeLikePattern` could ever close this,
 * because the substitution happens a layer above where that function's escaping is
 * read. `imatch`/`~*` (POSIX case-insensitive regex match) carries no such rewrite —
 * PostgREST's `*` → `%` convenience is specific to `like`/`ilike` — so switching
 * operators removes the hazard outright rather than working around it. Verified
 * empirically against the local stack, the same standard `tests/gear-search-
 * escaping.test.ts` already holds every other character to: a decoy row with no
 * literal `*` proves `?q=*` no longer matches it.
 *
 * A substring match needs no `%...%`-style wrapping under a regex engine — POSIX regex
 * matches anywhere in the string by default — so the escaped literal alone is the whole
 * pattern.
 *
 * TWO INDEPENDENT ESCAPING LAYERS, APPLIED IN THIS ORDER AND FOR DIFFERENT REASONS:
 *
 *   1. `escapeRegexPattern` first, so the raw search text's own regex metacharacters —
 *      `\ ^ $ . | ? * + ( ) [ ] { }`, including the `*` this function exists to fix —
 *      are neutralised before anything else sees them. This is what stops a search for
 *      the literal string `a.b` from becoming a regex matching any single character
 *      between `a` and `b`, and what stops `*` from being read as "zero or more of the
 *      preceding token" (on top of PostgREST no longer rewriting it to `%` first).
 *   2. `quoteForPostgrestFilterValue` second, over the ALREADY-REGEX-ESCAPED string —
 *      including any `\(` / `\)` `escapeRegexPattern` itself just introduced — so
 *      PostgREST's own filter-list grammar does not misread a comma, parenthesis or
 *      double quote as more of the `or=(...)` expression rather than as the value of
 *      one `imatch` condition.
 *
 * Applying these in the other order, or collapsing them into one escaping pass, is the
 * mistake this function exists to avoid — the same reasoning as the two-layer design it
 * replaces, just with a regex escape standing in for a LIKE escape. Both layers are
 * exercised, independently, against the real local stack in `tests/gear-search-
 * escaping.test.ts` — see that file for exactly which awkward strings (now including
 * `*`) are proven to round-trip correctly rather than merely reasoned about.
 */
export function buildSearchFilter(search: string): string {
  const pattern = escapeRegexPattern(search);
  const value = quoteForPostgrestFilterValue(pattern);
  return `name.imatch.${value},brand.imatch.${value}`;
}

// ---------------------------------------------------------------------------
// applyGearQuery
// ---------------------------------------------------------------------------

/** The columns the closet list view fetches — named once so the page's `.select()` and
 *  any test asserting against it cannot drift apart. Deliberately does not include
 *  `notes`, `url` or `description`: those are detail-view fields, not list-row fields,
 *  and fetching them for every row on every page load would be pure waste for a view
 *  that never renders them.
 *
 *  "NEEDS" IS AN OVERSTATEMENT FOR TWO OF THESE COLUMNS, HONESTLY RECORDED RATHER THAN
 *  QUIETLY TRUE. `created_at` is fetched here but, as of PK-61 (which replaced its only
 *  renderer, the old "Added" column, with `acquired_on`), rendered nowhere in the list
 *  view — and `updated_at` has never had a renderer in this view at all. Neither is
 *  removed here: `updated_at` is in the identical unused state, and trimming either is
 *  separate cleanup this change does not attempt, not a reason to leave the comment
 *  claiming every column here earns its place by being displayed. Take "needs" as
 *  "roughly what the view uses", not a guarantee every field in this list has a
 *  renderer today. */
// ONE weight column since PK-67, where there were three. `weight` and `weight_unit` are
// gone from the table, and `weight_grams` is no longer the generated copy that existed so
// two rows entered in different units could be compared — it IS the stored weight now, and
// the closet renders it through `formatWeight` rather than printing it beside a unit.
export const GEAR_SELECT =
  'id, name, brand, category, status, quantity, price, currency, weight_grams, acquired_on, photo_path, created_at, updated_at';

/** The columns `src/pages/gear/[id].astro` needs: every `GEAR_FORM_FIELD` (so
 *  `gearItemToFormValues` can pre-fill the edit form) — with the Weight field reading the
 *  `weight_grams` column that function converts out of, since PK-67 the one place a form
 *  field and its column no longer share a name — plus `id`, `photo_path` and
 *  `created_at` for the parts of the page that are not the form itself. Unlike
 *  `GEAR_SELECT`, this deliberately DOES include `description`, `notes` and `url` — the
 *  very fields that comment says a list row has no business fetching — because a
 *  detail/edit page is exactly the view that renders them. */
export const GEAR_DETAIL_SELECT =
  'id, name, brand, category, description, quantity, weight_grams, price, currency, acquired_on, url, notes, status, photo_path, created_at';

/**
 * The exact shape `client.from('gear_items').select(GEAR_SELECT)` produces, derived
 * from `PacksheetClient` rather than hand-written — see `src/lib/supabase.ts`'s own doc
 * comment for why a bare `SupabaseClient` (no `Database` type argument) cannot be used
 * here: it would type `builder` as `PostgrestFilterBuilder<any, any, any>`, silently
 * discarding column names, filter-argument types and embed cardinality alike. Deriving
 * the type from a function's return type, rather than spelling out postgrest-js's own
 * generic parameters by hand, also means this type can never drift from `GEAR_SELECT`
 * itself — the two are the same expression.
 *
 * `_gearItemsQuery` is never called — it exists purely to be the argument to
 * `ReturnType<typeof …>` below, the same pattern `tests/totals.test.ts` uses for its own
 * compile-time-only assertions (`_acceptsQueryRows`, `_CategoriesAreEmbedded`). The
 * leading underscore is this project's convention for "used only as a type", which is
 * what tells the `no-unused-vars` lint rule this is deliberate rather than dead code.
 */
function _gearItemsQuery(client: PacksheetClient) {
  return client.from('gear_items').select(GEAR_SELECT);
}

type GearItemsQueryBuilder = ReturnType<typeof _gearItemsQuery>;

/**
 * I2 (PK-4 review): slack added to every `weight_grams` boundary comparison so a value
 * entered in a non-gram unit still matches its OWN exact boundary. `toGrams(4.4, 'oz')`
 * computes `124.73790175000002` in IEEE-754 double precision; Postgres computed the
 * identical conversion with EXACT decimal arithmetic when the row was written and
 * stored `124.73790175` — two different arithmetic systems multiplying the same
 * operands, agreeing to a very large number of digits but not bitwise. Without slack,
 * `weight_grams >= 124.73790175000002` excludes the row that IS "4.4 oz and heavier" —
 * the boundary itself, hidden by the seventeenth significant digit.
 *
 * PK-67 MADE THE DOMINANT ERROR A DIFFERENT AND MUCH LARGER ONE, so the figure below is
 * no longer the 1e-6 g that IEEE-754 noise called for. Read the paragraph above as history:
 * it described a `weight_grams` that was a GENERATED column of unconstrained `numeric`,
 * which held the exact decimal product `124.73790175` and disagreed with the TypeScript
 * conversion only in the seventeenth significant digit.
 *
 * `weight_grams` is now the stored weight itself, `numeric(12, 3)`. A weight entered as
 * `4.4 oz` is converted at entry and QUANTISED to the column's scale, so the row holds
 * `124.738`, not `124.73790175` — an error of up to half a milligram, which is five
 * hundred times the old tolerance. With 1e-6 g of slack, `wmax=4.4&wunit=oz` computes a
 * bound of `124.73790275` and EXCLUDES the row a user entered as exactly 4.4 oz: the exact
 * failure I2 was filed about, reintroduced from the other end by the rounding rather than
 * by the floating point.
 *
 * So the slack is half of the column's own quantum — the largest amount rounding to
 * `WEIGHT_DECIMALS` places can move a value — and it is DERIVED from that constant rather
 * than written as `0.0005`, so widening the column's scale cannot silently leave this
 * behind. It subsumes the floating-point noise it replaces, being some five hundred times
 * larger. Half a milligram remains far below anything that distinguishes two real pieces
 * of gear.
 *
 * APPLIED TO BOTH BOUNDS, not only the minimum I2 was filed against: rounding moves a
 * value up as readily as down, so the failure mode has an exact mirror on `lte` — and
 * since PK-67 that mirror is the more likely half, because `4.4 oz` rounds UP to 124.738.
 */
const WEIGHT_COMPARISON_TOLERANCE_GRAMS = 0.5 * 10 ** -WEIGHT_DECIMALS;

/**
 * The search/category/status/brand/weight filters every closet-list query needs.
 * Every row this visitor owns is a closet row — this function adds no SEPARATE hidden
 * tier of its own on top of the visitor's own filters, the way a soft delete's
 * `deleted_at is null` would. `status` is filtered through the same `.in()` mechanism as
 * every other field here, but — unlike them — unconditionally, on whatever list
 * `effectiveGearStatuses` resolves `query.statuses` to; see the call site below for why.
 * Deliberately does NOT add ordering, `.range()`, or the owner
 * scope — see `applyGearQuery` for the first two and `loadGearCloset` for the third.
 *
 * A NOTE FOR THE NEXT READER WHO DIFFS THIS AGAINST PK-4 OR PK-62. This paragraph used to
 * say `status` (including `'retired'`) was "an ordinary filterable value like any other
 * rather than a floor applied before the visitor's own filters are" — true when it was
 * written, because an empty status list meant no status filter at all. PK-70 makes that
 * reading false: `effectiveGearStatuses([])` is `GEAR_DEFAULT_STATUSES`, not "everything",
 * so an unfiltered visitor DOES get a floor now — owned and wishlist only — just one
 * applied through the exact same `.in()` an explicit selection goes through, not a second
 * condition bolted on beside it. `?status=retired` still reaches exactly the retired rows,
 * unchanged from before; what changed is only what "no `status` param at all" resolves to.
 *
 * SPLIT OUT FROM `applyGearQuery` FOR C2 (PK-4 review): `loadGearCloset` needs to run
 * this same filter set TWICE for one page render — once as an unranged, `head: true`
 * count to learn how many rows actually match before deciding what page is real, and
 * once as the full ranged query — and a `.range()` call baked into a shared helper
 * would make the first of those two calls request a specific slice of a result set
 * whose size is not yet known.
 */
function applyGearFilters(builder: GearItemsQueryBuilder, query: GearQuery): GearItemsQueryBuilder {
  let next = builder;

  if (query.search !== '') {
    next = next.or(buildSearchFilter(query.search));
  }
  if (query.categories.length > 0) {
    next = next.in('category', query.categories as string[]);
  }
  // UNCONDITIONAL, since PK-70 — not `if (query.statuses.length > 0)`. An empty status
  // list used to mean "apply no status filter at all", which is exactly what let a
  // fresh, unfiltered closet show retired gear. It now means `GEAR_DEFAULT_STATUSES`
  // (owned, wishlist), via `effectiveGearStatuses` — the SAME function the filter bar
  // (fields.ts) calls to decide which boxes render ticked, so the ticks and this result
  // set cannot drift apart. `query.statuses` ITSELF is left exactly as `parseGearQuery`
  // produced it: the default is applied only here, at the point of USE, never written
  // back into the `GearQuery`, so `gearQueryToSearchParams` still round-trips an absent
  // `?status=` as an absent `?status=`, not as three params nobody typed.
  next = next.in('status', effectiveGearStatuses(query.statuses) as string[]);
  if (query.brands.length > 0) {
    next = next.in('brand', query.brands as string[]);
  }
  if (query.minGrams !== null) {
    next = next.gte('weight_grams', query.minGrams - WEIGHT_COMPARISON_TOLERANCE_GRAMS);
  }
  if (query.maxGrams !== null) {
    next = next.lte('weight_grams', query.maxGrams + WEIGHT_COMPARISON_TOLERANCE_GRAMS);
  }

  return next;
}

/**
 * Applies a parsed `GearQuery` to a `client.from('gear_items').select(GEAR_SELECT)`
 * builder: `applyGearFilters` (search, the three `in` filters, the weight range),
 * ordering, and `.range()` for pagination.
 *
 * A STABLE `id` TIEBREAKER IS ADDED AFTER THE SORT COLUMN, ALWAYS. Without it, two rows
 * that tie on the sort column (two items literally named "Stakes", say, or two added in
 * the same transaction and so sharing `created_at` to the microsecond) have no defined
 * relative order, and Postgres is free to answer consecutive `.range()` requests for the
 * SAME query with those two rows swapped. Page 1 could then show both, or neither — the
 * classic pagination bug where the total item count looks right but a specific item is
 * missing or duplicated depending on exactly where a tie happened to fall across a page
 * boundary. `id` is a `uuid primary key`, so it is unique and always present, which is
 * what makes it a safe universal tiebreaker regardless of which column the visitor
 * actually chose to sort by.
 *
 * Does not itself run the query — the caller `await`s the returned builder, the same
 * way `packTreeQuery` in `tests/support/local-database.ts` is used. Does not scope by
 * owner either — see `loadGearCloset` below, the only caller this module ships, for
 * why that filter has to be added by something that actually knows who is asking.
 */
export function applyGearQuery(
  builder: GearItemsQueryBuilder,
  query: GearQuery,
): GearItemsQueryBuilder {
  let next = applyGearFilters(builder, query);

  // Sorting by `price` orders by the raw column, and that is a documented limitation
  // rather than an oversight — see GEAR_SORT_COLUMNS's own comment in fields.ts for why
  // there is no canonical-price column this module could sort by instead: money.ts
  // refuses to invent an exchange rate, and canonicalising a price needs one.
  const column = GEAR_SORT_COLUMNS[query.sort];
  const ascending = query.direction === 'asc';

  // nullsFirst: false, ALWAYS, REGARDLESS OF DIRECTION (PK-61). `acquired_on` is
  // nullable with no database default, so an "added" sort has to decide where an
  // undated row goes — Postgres will not decide it neutrally on its own. Postgres's
  // own default null ordering is NOT symmetric: NULLS LAST for ascending, but NULLS
  // FIRST for descending. Left unpinned, "newest first" (`added` desc) would put every
  // item with no date at all at the very TOP of the closet — the least informative rows
  // crowding out the most relevant ones, on exactly the sort a visitor reaches for to
  // see what they logged most recently. Pinning nulls last in BOTH directions means
  // "undated" always reads as "at the end", whichever way the visitor sorted, rather
  // than flipping to the front the moment they click the column header a second time.
  //
  // THIS OPTION APPLIES TO EVERY SORT KEY, NOT ONLY `added`. `column` above is
  // `GEAR_SORT_COLUMNS[query.sort]`, so `nullsFirst: false` is passed on this `.order()`
  // call regardless of which key the visitor actually chose — and `price` and
  // `weight_grams` (the columns behind the `price` and `weight` sort keys) are ALSO
  // nullable. So this same PK-61 change quietly changed where an unpriced row lands on
  // `price desc` too: previously Postgres's own unpinned default (NULLS FIRST for
  // descending) put every unpriced item at the top of "most expensive first"; now it is
  // pinned to the bottom, same as every other direction and column. That is a
  // deliberate, and arguably overdue, consistency fix — an unpriced item reads no more
  // usefully at the top of "most expensive" than an undated item did at the top of
  // "newest" — but it is real behaviour this migration changed beyond the `acquired_on`
  // column its own name promises, worth knowing for anyone auditing "what did PK-61
  // actually touch".
  next = next
    .order(column, { ascending, nullsFirst: false })
    // The `id` tiebreaker matters MORE now, not less. Ties on `created_at` were already
    // GUARANTEED, not merely possible, for any multi-row insert: `set_row_timestamps()`
    // stamps `created_at = now()`, and `now()` is `transaction_timestamp()` — constant
    // for an entire transaction, not re-evaluated per row (verified: three rows
    // inserted in one statement come back sharing exactly one distinct timestamp). This
    // function's own comment above already names that exact case ("two added in the
    // same transaction and so sharing `created_at` to the microsecond"), and the
    // baseline migration's comment on `set_row_timestamps()` says the same thing again
    // — a tie-free `created_at` sort was never something this codebase could assume.
    // `acquired_on` is a `date`, not a timestamp, so switching `added` to it does not
    // introduce ties where there were none before; it WIDENS how easily they happen —
    // from "rows inserted in the same transaction" to "anything acquired on the same
    // calendar day", which needs no shared transaction at all. A sort with no stable
    // tiebreaker was always a latent pagination bug (see this function's own comment
    // above); this column swap makes the tie case even more common, not newly possible.
    .order('id', { ascending });

  const offset = (query.page - 1) * GEAR_PAGE_SIZE;
  next = next.range(offset, offset + GEAR_PAGE_SIZE - 1);

  return next;
}

// ---------------------------------------------------------------------------
// loadGearCloset — the owner-scoped closet list, with the C2 page clamp
// ---------------------------------------------------------------------------

/**
 * WHAT `loadGearCloset` HANDS BACK, deliberately left to TypeScript's own inference
 * rather than a hand-written interface: `items` (the page of rows actually rendered,
 * typed exactly as `GEAR_SELECT` produces — see `GearItemsQueryBuilder` above for why
 * that type is derived rather than spelled out by hand), `count` (the total across
 * every page, for the pager's "Showing X-Y of Z"), `error` (postgrest-js's own
 * `PostgrestError | null`), and `page` — the CLAMPED page number that was actually
 * queried, which the caller should use for every page-dependent computation from here
 * on (range text, Previous/Next links) rather than the raw, possibly-over-range
 * `query.page` it was asked for.
 *
 * The owner-scoped closet list query — moved here from `src/pages/gear/index.astro`
 * (PK-4 review, C3) so a test can reach both the owner scope and the C2 clamp below
 * directly, rather than only through a page `vitest.config.ts` excludes.
 *
 * `.eq('user_id', userId)` IS LOAD-BEARING, not belt-and-braces. `gear_items` carries
 * TWO permissive SELECT policies (core_schema.sql): `gear_items_select_own` (owner
 * only) and `gear_items_select_via_public_pack`, granted to `anon, authenticated` alike
 * so a shared pack link can render the gear behind it. RLS policies are UNIONED, not
 * intersected, so a plain `.select()` relying on RLS alone would return this visitor's
 * own rows OR any row that happens to sit on ANYONE's public pack — "Your gear closet"
 * silently showing a stranger's gear the moment that stranger publishes a pack.
 * `applyGearQuery`/`applyGearFilters` deliberately do not add this filter themselves
 * (see their own comments); this function is the one place that knows the signed-in
 * visitor's id, so this is where it has to be added — and where a test can now assert
 * it is, by calling this function directly instead of a hand-copied stand-in.
 *
 * C2 (PK-4 review) — THE OVER-RANGE PAGE CLAMP. PostgREST answers a `.range()` whose
 * offset exceeds the row count with `PGRST103` (416, "Requested range not
 * satisfiable"), and an offset exactly EQUAL to the count with a 206 and an empty
 * array (I11) — neither of which is "no items match", and treating the first as a load
 * failure replaces the whole page (filter form, table, both empty states, pager) with
 * an error that can never resolve, because the 416 is deterministic for that URL. Both
 * are reachable ordinarily: delete enough rows on a page beyond the first and the page
 * you were just looking at is now past the end.
 *
 * The fix runs the filters TWICE: once unranged, as a `head: true` count-only request,
 * to learn how many rows actually match before any `.range()` is issued at all; then
 * `query.page` is clamped to `max(1, ceil(count / GEAR_PAGE_SIZE))` — never lower than
 * page 1, even for zero matches — before the real, ranged request runs. An offset built
 * from an already-clamped page can never exceed the row count, so PGRST103 and the I11
 * empty-206 case are both structurally unreachable afterwards, not merely handled.
 */
export async function loadGearCloset(client: PacksheetClient, userId: string, query: GearQuery) {
  const countQuery = applyGearFilters(
    client
      .from('gear_items')
      .select(GEAR_SELECT, { count: 'exact', head: true })
      .eq('user_id', userId),
    query,
  );
  const { count: unrangedCount, error: countError } = await countQuery;

  if (countError) {
    return { items: [], count: 0, page: query.page, error: countError };
  }

  const count = unrangedCount ?? 0;
  const totalPages = Math.max(1, Math.ceil(count / GEAR_PAGE_SIZE));
  const page = Math.min(query.page, totalPages);

  const rangedQuery = applyGearQuery(
    client.from('gear_items').select(GEAR_SELECT, { count: 'exact' }).eq('user_id', userId),
    page === query.page ? query : { ...query, page },
  );
  const { data, error, count: exactCount } = await rangedQuery;

  return { items: data ?? [], count: exactCount ?? count, page, error };
}

// ---------------------------------------------------------------------------
// loadGearItem — the owner-scoped single-item load
// ---------------------------------------------------------------------------

/**
 * The owner-scoped detail-page load query — moved here from
 * `src/pages/gear/[id].astro` (PK-4 review, C3) for the same reason as
 * `loadGearCloset` above.
 *
 * `.eq('user_id', userId)` IS LOAD-BEARING, not belt-and-braces — see the identical
 * comment on `loadGearCloset`. `gear_items` carries TWO permissive SELECT policies and
 * RLS unions them, so `.eq('id', id)` alone would let this page render ANY visitor's
 * gear item the moment it sits on someone's public pack — "your item" silently becoming
 * a stranger's, and its edit form silently offering to change somebody else's row. The
 * id in the URL is the only other thing narrowing this query, and an id is guessable in
 * exactly the way an ownership check is not.
 *
 * A missing row, another visitor's row, and a malformed id (which PostgREST refuses
 * with an error before RLS is even consulted) all collapse to the SAME `{ data: null }`
 * shape here, on purpose — `src/pages/gear/[id].astro` turns that into one real 404 for
 * all three, and none of the three is a distinction its visitor should be able to probe
 * for.
 */
export async function loadGearItem(client: PacksheetClient, userId: string, id: string) {
  return client
    .from('gear_items')
    .select(GEAR_DETAIL_SELECT)
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle();
}

// ---------------------------------------------------------------------------
// loadGearItemsForExport — the owner-scoped read behind a JSON export
// ---------------------------------------------------------------------------

/**
 * The rows behind a JSON export (PK-65), for a selection of ids.
 *
 * `.eq('user_id', userId)` IS LOAD-BEARING HERE FOR A SHARPER REASON THAN ON THE OTHER
 * TWO LOADS ON THIS PAGE. `gear_items` carries two permissive SELECT policies and RLS
 * UNIONS them, so `gear_items_select_via_public_pack` makes any item sitting on anybody's
 * public pack readable by EVERY visitor — that policy is granted to `anon` as well as
 * `authenticated` (core_schema.sql), which is how a shared pack page renders for a
 * stranger at all. See `loadGearCloset`'s own comment for the general shape of that trap. What makes it worse in this particular query is the
 * OUTPUT: the other two loads render a page, where a stranger's row would at least be
 * visible as something odd on screen. This one serialises whatever it gets into a file
 * and hands it over as a download, including `notes`, `price` and `url` — the fields a
 * public pack page does not show. Without the owner filter, a crafted `?id=` list would
 * be a working data-exfiltration endpoint for every item on every public pack in the
 * product, delivered as a tidy JSON document. The filter is the whole of what stops that.
 *
 * ORDERED BY NAME, NOT BY THE ORDER THE IDS ARRIVED. A file is a document, and a document
 * that reorders itself between two exports of the same closet is one that cannot be
 * usefully diffed. Input order is the visitor's checkbox order, which is really the
 * current sort — a view state that has nothing to do with the file. `id` breaks ties, so
 * two items sharing a name still come out in a stable order rather than whatever the
 * planner chose that day.
 *
 * NO CAP OF ITS OWN, deliberately, unlike `deleteGearItems` and `importGearItems`. Those
 * two WRITE, and their caps exist because an unbounded write is irreversible or expensive
 * at the scale of whatever it matched. This reads, and its caller is `parseBulkAction`,
 * which refuses a selection over `MAX_BULK_IDS` before an id ever reaches here. An
 * over-large read is a slow response, not a wrong one.
 */
export async function loadGearItemsForExport(
  client: PacksheetClient,
  userId: string,
  ids: readonly string[],
) {
  if (ids.length === 0) return { items: [], error: null };
  const { data, error } = await client
    .from('gear_items')
    .select(GEAR_EXPORT_SELECT)
    .eq('user_id', userId)
    .in('id', ids as string[])
    .order('name', { ascending: true })
    .order('id', { ascending: true });
  return { items: data ?? [], error };
}
