import type { APIRoute } from 'astro';

/**
 * robots.txt, generated at build time from PUBLIC_SITE_ENV.
 *
 * Fail-safe by design: only the literal string "production" produces an indexable
 * site. Staging, PR previews, local builds and any future environment nobody has
 * thought of yet all fall through to Disallow. Getting this backwards — allowing by
 * default and denying for known non-production environments — means the first
 * environment someone forgets to add is silently indexed, and staging content
 * competing with production in search results is slow to notice and slow to undo.
 */

const isProduction = import.meta.env.PUBLIC_SITE_ENV === 'production';

// No Sitemap: line yet — there is no sitemap to point at, and advertising a URL that
// 404s is worse than omitting it. Add it alongside @astrojs/sitemap.
const productionRobots = `User-agent: *
Allow: /
`;

const nonProductionRobots = `# Not the production site — do not index.
User-agent: *
Disallow: /
`;

export const GET: APIRoute = () =>
  new Response(isProduction ? productionRobots : nonProductionRobots, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
