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
import { toGrams, fromGrams, isWeightUnit, type WeightUnit } from '../units';
import {
  GEAR_PAGE_SIZE,
  GEAR_SORT_COLUMNS,
  MAX_SEARCH_LENGTH,
  isGearSortKey,
  isGearStatus,
  type GearSortKey,
  type GearStatus,
} from './fields';

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
  /** Distinct, first-seen order, and only values `isGearStatus` accepts. */
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
   *  to grams) purely so a form re-rendering this query can show the visitor back what
   *  they actually typed, in the unit they typed it in, rather than a grams figure they
   *  never entered. */
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
  const sort = isGearSortKey(sortRaw) ? sortRaw : 'name';

  const dirRaw = params.get('dir');
  const direction: 'asc' | 'desc' = dirRaw === 'asc' || dirRaw === 'desc' ? dirRaw : 'asc';

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

  // wunit is emitted whenever it is non-default, even if both bounds are null — a
  // visitor who picked "lb" in the form but has not yet typed a number still has that
  // choice as part of their query state, and dropping it here would silently reset
  // their unit picker to grams the next time this URL was parsed.
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
// buildSearchFilter
// ---------------------------------------------------------------------------

/**
 * Escapes `text` for use as a Postgres `LIKE`/`ILIKE` pattern body, so that `%`, `_` and
 * `\` inside it are matched LITERALLY rather than interpreted as wildcards or an escape
 * introducer. Postgres's default `LIKE` escape character is backslash (there is no
 * `ESCAPE` clause anywhere in this codebase's queries, so that default is what applies),
 * and it has to be escaped FIRST, before `%` and `_` are escaped into sequences that
 * themselves contain backslashes — escaping in the other order would re-escape the
 * backslashes this step just introduced and turn `\%` into `\\%`, which `ILIKE` reads
 * back as "a literal backslash, then a wildcard" instead of "a literal percent sign".
 */
function escapeLikePattern(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
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
 * TWO INDEPENDENT ESCAPING LAYERS, APPLIED IN THIS ORDER AND FOR DIFFERENT REASONS:
 *
 *   1. `escapeLikePattern` first, so the raw search text's own `%`, `_` and `\`
 *      characters are neutralised as LIKE metacharacters — this is what stops a search
 *      for the literal string `50%` from becoming the pattern `%50%%`, which `ILIKE`
 *      reads as "fifty, then anything" and would match `500 grams` even though the
 *      visitor typed a percent sign, not a wildcard.
 *   2. `quoteForPostgrestFilterValue` second, over the ALREADY-LIKE-ESCAPED string
 *      (including the `%` wildcards this function itself adds around it) — this is what
 *      stops PostgREST's own filter-list grammar from misreading a value containing a
 *      comma, a parenthesis, or a double quote as more of the `or=(...)` expression
 *      rather than as the value of one `ilike` condition.
 *
 * Applying these in the other order, or collapsing them into one escaping pass, is the
 * mistake this function exists to avoid: PostgREST-quoting the raw search text and only
 * then wrapping it in `%...%` would leave the wildcard percent signs OUTSIDE the quoted
 * value's own escaping, and LIKE-escaping the already-PostgREST-quoted string would
 * mangle the very backslashes and quote characters `quoteForPostgrestFilterValue` just
 * introduced. Both layers are exercised, independently, against the real local stack in
 * `tests/gear-search-escaping.test.ts` — see that file for exactly which awkward strings
 * are proven to round-trip correctly rather than merely reasoned about.
 */
export function buildSearchFilter(search: string): string {
  const pattern = `%${escapeLikePattern(search)}%`;
  const value = quoteForPostgrestFilterValue(pattern);
  return `name.ilike.${value},brand.ilike.${value}`;
}

// ---------------------------------------------------------------------------
// applyGearQuery
// ---------------------------------------------------------------------------

/** The columns the closet list view needs — named once so the page's `.select()` and
 *  any test asserting against it cannot drift apart. Deliberately does not include
 *  `notes`, `url` or `description`: those are detail-view fields, not list-row fields,
 *  and fetching them for every row on every page load would be pure waste for a view
 *  that never renders them. */
export const GEAR_SELECT =
  'id, name, brand, category, status, quantity, price, currency, weight, weight_unit, weight_grams, photo_path, created_at, updated_at';

/** The columns `src/pages/gear/[id].astro` needs: every `GEAR_FORM_FIELD` (so
 *  `gearItemToFormValues` can pre-fill the edit form) plus `id`, `photo_path` and
 *  `created_at` for the parts of the page that are not the form itself. Unlike
 *  `GEAR_SELECT`, this deliberately DOES include `description`, `notes`, `url` and
 *  `volume_litres` — the very fields that comment says a list row has no business
 *  fetching — because a detail/edit page is exactly the view that renders them. */
export const GEAR_DETAIL_SELECT =
  'id, name, brand, category, description, quantity, weight, weight_unit, price, currency, volume_litres, url, notes, status, photo_path, created_at';

/** The columns `src/pages/gear/trash.astro` needs: the same list-row shape as
 *  `GEAR_SELECT` plus `deleted_at`, which every trash row needs and no active-closet row
 *  (`GEAR_SELECT`'s own consumers) ever renders — that column is `null` by definition
 *  wherever `GEAR_SELECT` is used, since every one of those queries is guarded with
 *  `.is('deleted_at', null)`. */
export const GEAR_TRASH_SELECT =
  'id, name, brand, category, status, quantity, price, currency, weight, weight_unit, weight_grams, photo_path, created_at, updated_at, deleted_at';

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
 * Applies a parsed `GearQuery` to a `client.from('gear_items').select(GEAR_SELECT)`
 * builder: search, the three `in` filters, the weight range, the `deleted_at is null`
 * floor every closet-list query needs (a trashed item is never a "gear closet" row —
 * see `GEAR_TRASH_PATH` in `src/lib/gear/routes.ts` for the page that reads the OTHER
 * side of that filter), ordering, and `.range()` for pagination.
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
 * way `packTreeQuery` in `tests/support/local-database.ts` is used.
 */
export function applyGearQuery(
  builder: GearItemsQueryBuilder,
  query: GearQuery,
): GearItemsQueryBuilder {
  let next = builder.is('deleted_at', null);

  if (query.search !== '') {
    next = next.or(buildSearchFilter(query.search));
  }
  if (query.categories.length > 0) {
    next = next.in('category', query.categories as string[]);
  }
  if (query.statuses.length > 0) {
    next = next.in('status', query.statuses as string[]);
  }
  if (query.brands.length > 0) {
    next = next.in('brand', query.brands as string[]);
  }
  if (query.minGrams !== null) {
    next = next.gte('weight_grams', query.minGrams);
  }
  if (query.maxGrams !== null) {
    next = next.lte('weight_grams', query.maxGrams);
  }

  // Sorting by `price` orders by the raw column, and that is a documented limitation
  // rather than an oversight — see GEAR_SORT_COLUMNS's own comment in fields.ts for why
  // there is no canonical-price column this module could sort by instead: money.ts
  // refuses to invent an exchange rate, and canonicalising a price needs one.
  const column = GEAR_SORT_COLUMNS[query.sort];
  const ascending = query.direction === 'asc';
  next = next.order(column, { ascending }).order('id', { ascending });

  const offset = (query.page - 1) * GEAR_PAGE_SIZE;
  next = next.range(offset, offset + GEAR_PAGE_SIZE - 1);

  return next;
}
