/// <reference types="vitest/config" />
import { getViteConfig } from 'astro/config';

// getViteConfig applies Astro's own Vite resolution — its plugins, tsconfig path
// aliases and PUBLIC_ env prefix — so a module imported by a test transforms the way
// it does in the build rather than under a hand-rolled config that drifts from it.
//
// It does NOT hand the tests the resolved `site`: they inject their own APIContext.
// The dependency on `site` is pinned directly instead, by robots-txt.test.ts asserting
// the sitemap URL is derived from whatever `site` it passes in.
export default getViteConfig({
  test: {
    // Colocated tests are allowed anywhere under src/ EXCEPT src/pages/, where every
    // file becomes a route — a robots.txt.test.ts there would ship as /robots.txt.test.
    //
    // Listing src/ explicitly matters: a pattern narrow enough to only match tests/
    // means a test written anywhere else is silently never collected, and the run
    // still exits 0. A test that cannot fail is the exact defect this suite exists to
    // catch, so it must not be possible to create one by putting a file in the wrong
    // directory. src/pages/ is excluded rather than ignored, and ci.yml fails the
    // build if a test file appears there, so the gap closes loudly instead of quietly.
    include: ['tests/**/*.{test,spec}.ts', 'src/**/*.{test,spec}.ts'],
    exclude: ['src/pages/**'],
    environment: 'node',
  },
});
