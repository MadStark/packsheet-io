/// <reference types="vitest/config" />
import { getViteConfig } from 'astro/config';

// getViteConfig loads astro.config.mjs, so tests see the same resolved config the
// build does — notably `site`, which robots.txt.ts depends on to emit the Sitemap
// line. Hand-rolling a plain Vite config here would silently drift from the build.
export default getViteConfig({
  test: {
    // Tests deliberately live outside src/. Anything under src/pages/ becomes a
    // route, so a co-located robots.txt.test.ts would ship as /robots.txt.test.
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
