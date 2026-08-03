import { describe, it, expect, vi, afterEach } from 'vitest';
import type { APIContext } from 'astro';

/**
 * Invariant 1 — the robots.txt fail-safe.
 *
 * src/pages/robots.txt.ts is built so that ONLY the literal string "production"
 * yields an indexable site. Every other value — staging, previews, local builds,
 * environments nobody has invented yet — must fall through to Disallow.
 *
 * The regression this guards against is a rewrite of `=== 'production'` into
 * something permissive (`!== 'staging'`, or an `||` for a new environment). That
 * change passes `npm run check`, passes the build, and produces no symptom until
 * someone notices staging outranking production in search results.
 *
 * The eight values covered here — "production", plus the seven in `nonProduction`
 * below — are the ones the PR #4 review checked by hand. This test exists so that
 * verification is repeated on every commit rather than remembered.
 *
 * Note on fidelity: the real build has Vite statically inline `import.meta.env.
 * PUBLIC_SITE_ENV`, whereas here it is stubbed at runtime. This pins the branching
 * logic, not Vite's build-time substitution.
 */

const SITE = new URL('https://packsheet.io');

/**
 * `site` is a required parameter rather than one defaulting to SITE, because a
 * default would make the `site: undefined` case untestable: passing undefined
 * explicitly is exactly what triggers a default parameter, so the unset test would
 * silently receive SITE and assert nothing. robotsFor() below supplies the default
 * for the cases that don't care.
 */
async function robotsWith(value: string | undefined, site: URL | undefined): Promise<string> {
  // The module captures the env at import time (`const isProduction = ...` at top
  // level), so the module registry has to be reset between values or every case
  // after the first would read the first one's answer and pass for the wrong reason.
  vi.resetModules();
  vi.stubEnv('PUBLIC_SITE_ENV', value);

  const { GET } = await import('../src/pages/robots.txt.ts');
  const response = await GET({ site } as unknown as APIContext);
  return await response.text();
}

const robotsFor = (value: string | undefined): Promise<string> => robotsWith(value, SITE);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('robots.txt fail-safe', () => {
  it('serves an indexable robots.txt for exactly "production"', async () => {
    const body = await robotsFor('production');

    expect(body).toContain('Allow: /');
    expect(body).not.toContain('Disallow: /');
    expect(body).toContain('Sitemap: https://packsheet.io/sitemap-index.xml');
  });

  // siteRelative() in robots.txt.ts normalises the base to end in a slash before
  // resolving. Without that, new URL('sitemap-index.xml', 'https://packsheet.io/app')
  // resolves to https://packsheet.io/sitemap-index.xml — the last path segment is
  // treated as a filename and replaced. `site` is a bare origin today, so nothing
  // above would notice if the normalisation were deleted; this is the case that does.
  it('keeps a path segment on `site` when resolving the sitemap URL', async () => {
    const body = await robotsWith('production', new URL('https://packsheet.io/app'));

    expect(body).toContain('Sitemap: https://packsheet.io/app/sitemap-index.xml');
  });

  // Advertising a sitemap at the wrong origin is worse than a build that stops and
  // says why, so the route throws rather than defaulting. Unreachable while
  // astro.config.mjs sets `site` — which @astrojs/sitemap also requires — but the
  // throw is the guarantee that keeps it unreachable.
  it('throws rather than emitting a wrong-origin sitemap when `site` is unset', async () => {
    await expect(robotsWith('production', undefined)).rejects.toThrow(/`site` is not configured/);
  });

  // Every value that is not the exact literal. Casing variants and the leading-space
  // case are here because they are the shapes a typo or a trimmed env var actually
  // takes, and each one must still be treated as non-production.
  const nonProduction: Array<[label: string, value: string | undefined]> = [
    ['staging', 'staging'],
    ['empty string', ''],
    ['capitalised "Production"', 'Production'],
    ['upper-case "PRODUCTION"', 'PRODUCTION'],
    ['leading whitespace " production"', ' production'],
    ['preview', 'preview'],
    ['unset', undefined],
  ];

  it.each(nonProduction)('disallows indexing for %s', async (_label, value) => {
    const body = await robotsFor(value);

    expect(body).toContain('Disallow: /');
    expect(body).not.toContain('Allow: /');
  });

  // Advertising a sitemap from a page that also says Disallow: / is incoherent, and
  // the two strings are built separately, so this can regress independently of the
  // Disallow line above.
  it.each(nonProduction)('omits the Sitemap line for %s', async (_label, value) => {
    const body = await robotsFor(value);

    expect(body).not.toContain('Sitemap:');
  });
});
