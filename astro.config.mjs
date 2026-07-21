// @ts-check
import { defineConfig } from 'astro/config';

import vue from '@astrojs/vue';
import tailwindcss from '@tailwindcss/vite';

import sitemap from '@astrojs/sitemap';

// https://astro.build/config
export default defineConfig({
  // The custom domain (PS-39) isn't bound yet — this still deploys to
  // *.azurestaticapps.net — but canonical URLs, the sitemap and OG/Twitter
  // tags all key off `site`, so setting the eventual production URL now means
  // nothing needs rewriting once the domain lands.
  site: 'https://packsheet.io',

  integrations: [vue(), sitemap()],

  vite: {
    plugins: [tailwindcss()],
  },
});
