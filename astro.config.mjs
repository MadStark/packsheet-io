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

/**
 * PlaceholderOnly: serve the coming-soon page and nothing else.
 *
 * WHAT IT IS FOR. It decouples "the code is on main" from "the product is public", so
 * staging can be merged and released on its own schedule and the site turned on
 * afterwards by flipping a setting rather than by shipping a commit. Without it the only
 * lever is the merge itself, which makes every release a launch.
 *
 * ONLY THE LITERAL STRING "true", and unset therefore means off. That is the OPPOSITE
 * polarity to `PUBLIC_SITE_ENV` in src/pages/robots.txt.ts, which fails safe by
 * disallowing anything it does not recognise, and the asymmetry is deliberate rather
 * than an inconsistency: the cost of getting robots.txt wrong is a staging build
 * competing with production in search results, discovered late and slow to undo, while
 * the cost of getting this wrong is a placeholder page appearing on `npm run dev` and on
 * every local build, discovered within seconds by whoever is working. The failure that
 * has to be designed against is the one nobody notices.
 *
 * BUILD TIME, NOT REQUEST TIME, and this is the one decision in this file most likely to
 * be "improved" into a middleware check. It cannot be one. Cloudflare's assets binding
 * serves a prerendered file — `/welcome/`, `/robots.txt` — straight off the uploaded
 * assets WITHOUT invoking the Worker at all; that is stated in wrangler.jsonc and in the
 * adapter comment below, and scripts/verify-release.sh has a whole section resting on
 * it. Astro middleware runs inside the Worker, so it never sees those requests and could
 * not hide the landing page if it wanted to. Making it able to would mean
 * `run_worker_first: true`, which bills a Worker invocation for every static asset on
 * every visit, forever, to read one boolean.
 *
 * Pruning at build time is also the stronger guarantee, and the one the requirement
 * actually asks for: when this is off, `placeholder/` is not read by the build and the
 * coming-soon page exists in no artifact anywhere; when it is on, `src/pages/` is not
 * compiled and there is no other page in the deployed output to reach by any URL, any
 * spelling, or any hosting rule someone later gets wrong.
 */
const placeholderOnly = process.env.PLACEHOLDER_ONLY === 'true';

// https://astro.build/config
export default defineConfig({
  // Canonical URLs, the sitemap and OG/Twitter tags all key off `site`, and
  // robots.txt resolves the sitemap URL against it. Both hostnames serve the
  // same build, so this is the production origin on staging too — which is
  // exactly why staging must never be indexable. See src/pages/robots.txt.ts.
  site: SITE,

  // The whole of PlaceholderOnly's enforcement, in one line — see the constant above for
  // why it is enforced here rather than in src/middleware.ts.
  //
  // Astro discovers routes from `<srcDir>/pages`, so pointing srcDir somewhere else does
  // not hide the other pages, it means they are never compiled: `src/pages/` contributes
  // nothing to `dist/`, and neither does `src/middleware.ts`, so a placeholder build
  // reaches no auth SDK and needs no Supabase credentials to prerender. The reverse holds
  // just as literally — with the flag off, nothing under `placeholder/` is read, which is
  // what "the coming-soon page must disappear and not be served anywhere" reduces to when
  // it is a build input rather than a routing rule.
  //
  // Components, layouts and styles are unaffected either way: they are resolved by
  // relative import from the page that uses them, not by srcDir, so `placeholder/` shares
  // src/layouts/Layout.astro rather than forking it.
  srcDir: placeholderOnly ? './placeholder' : './src',

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
      //
      // AND THE FILTER INVERTS UNDER PlaceholderOnly, which is why it is a conditional
      // rather than the flat comparison it reads as above. In a placeholder build `/` is
      // not a router at all — it is a prerendered page, the only page, and the one thing
      // the site wants indexed. Leaving the exclusion in place would emit a sitemap
      // listing nothing, advertised by a robots.txt that invites a crawler to read it: an
      // empty answer to the only question a launch page exists to answer. The catch-all
      // that redirects every other URL needs no exclusion here, because it is a dynamic
      // route and `@astrojs/sitemap` does not emit those.
      filter: (page) => placeholderOnly || page !== `${SITE}/`,
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
