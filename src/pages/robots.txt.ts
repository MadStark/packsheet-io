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

/**
 * Resolve a path against `site` without losing a path segment.
 *
 * `new URL('sitemap-index.xml', 'https://packsheet.io/app')` resolves to
 * https://packsheet.io/sitemap-index.xml — the last segment of the base is treated
 * as a filename and replaced. That is silent and wrong the day `site` gains a path,
 * so the base is normalised to end in a slash first. Today `site` is a bare origin
 * and this is a no-op; it exists so that stays true.
 */
function siteRelative(site: URL | undefined, path: string): URL {
  if (!site) {
    // Unreachable while astro.config.mjs sets `site`, which @astrojs/sitemap also
    // requires. Thrown rather than defaulted: a robots.txt advertising a sitemap at
    // the wrong origin is worse than a build that stops and says why.
    throw new Error('`site` is not configured — robots.txt cannot resolve the sitemap URL.');
  }

  const base = site.href.endsWith('/') ? site.href : `${site.href}/`;
  return new URL(path, base);
}

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

Sitemap: ${siteRelative(site, 'sitemap-index.xml')}
`;

  return new Response(isProduction ? productionRobots : nonProductionRobots, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
