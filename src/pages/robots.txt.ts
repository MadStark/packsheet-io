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

// The Sitemap: line only belongs in the production output — advertising a sitemap
// from a page that also says Disallow: / is incoherent, so it must never appear in
// nonProductionRobots below.
const nonProductionRobots = `# Not the production site — do not index.
User-agent: *
Disallow: /
`;

export const GET: APIRoute = ({ site }) => {
  const productionRobots = `User-agent: *
Allow: /

Sitemap: ${new URL('sitemap-index.xml', site)}
`;

  return new Response(isProduction ? productionRobots : nonProductionRobots, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
