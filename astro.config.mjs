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

  // Most pages are still prerendered and served straight off the assets
  // binding, which is the point: the landing page and robots.txt reach a
  // visitor without the Worker executing at all. PK-19 added the first routes
  // that cannot be — sign-in, sign-up, /account and the two /auth/* endpoints
  // all read a request body or write session cookies — so the adapter, which
  // was here ahead of them precisely so `export const prerender = false` would
  // be a one-line change rather than a migration, is now doing that job as
  // well as the assets one. `wrangler dev` runs the same `workerd` production
  // runs, which is half the reason for being on Workers at all.
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

  // PK-19's CSRF protection for every mutating on-demand route (sign-in, sign-up,
  // account deletion, sign-out) rests on this plus the session cookie's `sameSite:
  // 'lax'` (see REQUIRED_COOKIE_ATTRIBUTES in src/lib/auth/index.ts) — nothing else in
  // this project adds a CSRF token on top of that pair, so this is load-bearing.
  //
  // `checkOrigin: true` is Astro 7.2's own default (confirmed against
  // node_modules/astro/dist/core/config/schemas/defaults.js), so this line changes no
  // behaviour today. It is written out anyway, rather than left implicit, for two
  // reasons: a reader auditing CSRF protection should find the decision in this file
  // rather than have to go and check astro's source to confirm what "unset" resolves
  // to, and an explicit `true` here cannot be silently weakened by a future Astro
  // version changing its own default out from under an unrelated dependency bump.
  // Astro rejects a same-origin-suspicious POST/PUT/PATCH/DELETE to an on-demand route
  // with a 403 before that route's own code ever runs.
  security: {
    checkOrigin: true,
  },

  vite: {
    plugins: [tailwindcss()],
  },
});
