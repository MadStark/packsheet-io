// @ts-check
import { defineConfig } from 'astro/config';

import cloudflare from '@astrojs/cloudflare';
import vue from '@astrojs/vue';
import tailwindcss from '@tailwindcss/vite';

import sitemap from '@astrojs/sitemap';

// https://astro.build/config
export default defineConfig({
  // Canonical URLs, the sitemap and OG/Twitter tags all key off `site`, and
  // robots.txt resolves the sitemap URL against it. Both hostnames serve the
  // same build, so this is the production origin on staging too — which is
  // exactly why staging must never be indexable. See src/pages/robots.txt.ts.
  site: 'https://packsheet.io',

  // Nothing uses `Astro.session`, and the adapter's default is to switch it on
  // backed by a Cloudflare KV namespace — which then has to exist, be bound in
  // every environment, and be reasoned about, to store nothing. Off until
  // something needs it.
  //
  // Auth will not be what needs it: @supabase/ssr keeps the access and refresh
  // tokens in its own httpOnly cookies and Postgres applies RLS from the JWT,
  // so there is no server-side session store in that design at all.
  session: false,

  // Every page is prerendered today, so this build is a pile of static files
  // that the Worker serves through its assets binding. The adapter is here
  // anyway, ahead of the first on-demand route, because it is what makes
  // `export const prerender = false` a one-line change rather than a
  // migration — and because `wrangler dev` then runs the same `workerd` that
  // production runs, which is half the reason for being on Workers at all.
  //
  // Astro's adapter layer is the exit door: swapping hosts is this import and
  // the wrangler config, nothing under src/.
  adapter: cloudflare({
    // The adapter defaults to Cloudflare's Images binding for <Image /> and
    // that meter is billed per unique transformation per 30 days — roughly
    // $57/month at the traffic this project models, against roughly $0.60 for
    // resizing once at upload. No image service is wired up yet; 'compile'
    // keeps Astro from reaching for the billed one by default the day the
    // first <Image /> lands, so the choice is made deliberately in the gear
    // photo ticket rather than inherited silently here.
    imageService: 'compile',
  }),

  integrations: [vue(), sitemap()],

  vite: {
    plugins: [tailwindcss()],
  },
});
