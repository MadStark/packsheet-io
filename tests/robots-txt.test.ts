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
 * The eight values below are the ones the PR #4 review checked by hand. This test
 * exists so that verification is repeated on every commit rather than remembered.
 *
 * Note on fidelity: the real build has Vite statically inline `import.meta.env.
 * PUBLIC_SITE_ENV`, whereas here it is stubbed at runtime. This pins the branching
 * logic, not Vite's build-time substitution.
 */

const SITE = new URL('https://packsheet.io');

async function robotsFor(value: string | undefined): Promise<string> {
  // The module captures the env at import time (`const isProduction = ...` at top
  // level), so the module registry has to be reset between values or every case
  // after the first would read the first one's answer and pass for the wrong reason.
  vi.resetModules();
  vi.stubEnv('PUBLIC_SITE_ENV', value);

  const { GET } = await import('../src/pages/robots.txt.ts');
  const response = await GET({ site: SITE } as unknown as APIContext);
  return await response.text();
}

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
