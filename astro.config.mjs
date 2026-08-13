// @ts-check
import { defineConfig } from 'astro/config';

import cloudflare from '@astrojs/cloudflare';
import vue from '@astrojs/vue';
import tailwindcss from '@tailwindcss/vite';

import sitemap from '@astrojs/sitemap';

// One value for `site` below and for the sitemap filter that has to compare against it.
// The filter receives fully-qualified URLs, so it needs the origin — and a second copy of
// this string would be a copy that silently stops matching the day the domain changes,
// turning the filter into a no-op rather than into an error.
const SITE = 'https://packsheet.io';

// https://astro.build/config
export default defineConfig({
  // Canonical URLs, the sitemap and OG/Twitter tags all key off `site`, and
  // robots.txt resolves the sitemap URL against it. Both hostnames serve the
  // same build, so this is the production origin on staging too — which is
  // exactly why staging must never be indexable. See src/pages/robots.txt.ts.
  site: SITE,

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

  integrations: [
    vue(),
    sitemap({
      // `@astrojs/sitemap` emits every non-dynamic route, NOT only the prerendered ones —
      // verified against a real build, whose sitemap lists `/`, `/account/`, `/gear/`,
      // `/sign-in/` and the rest alongside `/welcome/`.
      //
      // `/` has to come out. It stopped being a page when it became a session-dependent
      // router (src/lib/routes.ts): every request to it now answers a `no-store` 302 to
      // either the gear closet or the landing page, so advertising it to a crawler as
      // canonical, indexable content is advertising a redirect whose destination depends
      // on a cookie the crawler does not have. The page that actually holds the marketing
      // content is `/welcome/`, and the sitemap still lists that.
      //
      // NOT FIXED HERE, and deliberately so rather than by oversight: the session-shaped
      // routes — `/account/`, `/gear/`, `/sign-in/` and their siblings — are also emitted,
      // and probably should not be either. That predates this change, costs nothing while
      // src/pages/robots.txt.ts disallows crawling everywhere but production, and is a
      // decision about which pages this site wants indexed rather than a consequence of
      // `/` becoming a router. It wants its own ticket, not a silent widening of this one.
      filter: (page) => page !== `${SITE}/`,
    }),
  ],

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
