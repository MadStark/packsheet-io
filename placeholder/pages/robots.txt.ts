/**
 * robots.txt for a PlaceholderOnly build — the same robots.txt, from the same source.
 *
 * A placeholder build does not compile `src/pages/`, so `src/pages/robots.txt.ts` does not
 * become a route and the site would ship without one. Re-exporting rather than copying is
 * the point of this file: the rule that only the literal string "production" produces an
 * indexable site is a fail-safe with a long comment explaining which way it is tuned to be
 * wrong, and a second copy of it here would be a copy that drifts — silently, in the
 * direction of indexing something that should not be, because that is the direction a
 * copy fails when the original is later tightened.
 *
 * The behaviour this inherits is the one a launch page wants: on production it allows
 * crawling and advertises the sitemap, which under this flag lists exactly the placeholder
 * page (see the sitemap filter in astro.config.mjs). On staging, previews and local builds
 * it disallows everything, exactly as it does in a normal build.
 *
 * Prerendered, like the module it re-exports, so it is served off the assets binding
 * without invoking the Worker.
 */
export { GET } from '../../src/pages/robots.txt';
