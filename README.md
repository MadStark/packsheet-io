# Packsheet

A free, open gear tracker and pack builder for hikers. Build your gear closet once, compose
unlimited pack lists from it, and share a page that reviewers actually want to read.

**Status: early development.** The site is not live yet. What is here is the walking
skeleton — the app shell, the design system, and the deployment pipeline. There is no
product to use as of today.

## The commitments

These are the reasons this project exists, and they are not subject to a change of heart
later:

- **Free forever.** No paywall, no feature gates, no "pro" tier. Every feature is available
  to everyone.
- **No ads.** Not now, not at scale, not "tasteful" ones.
- **No affiliate link rewriting.** If you paste a link to a piece of gear, that link is
  left exactly as you wrote it. Your gear list is not a monetisation surface.
- **Your data is always exportable.** Full export, in a format you can actually use,
  available to every user without asking. Import is not a one-way door.
- **Open source from the first commit.** Not "source available", not open-sourced later if
  it fails. The repository has been public since before there was anything in it.

Running costs are covered by donations. If donations do not cover them, the honest answer
is that the project shrinks to fit — not that the terms above quietly change.

## Why another one of these

[LighterPack](https://lighterpack.com) set the standard for this category and earned its
place: it is the shared vocabulary of r/Ultralight, and "post your lighterpack" is a
complete sentence to a hiker. This project exists because that tool is no longer actively
maintained, not because it was wrong.

The goal is continuity, not replacement. Import should be one paste. Nothing about
Packsheet should require you to abandon a list you already have.

## Stack

- [Astro](https://astro.build) with [Vue](https://vuejs.org) islands
- [Tailwind CSS](https://tailwindcss.com) v4, configured in CSS via `@theme`
- TypeScript, strict
- Cloudflare Workers, with static assets served from the same Worker
- Supabase (PostgreSQL, with row-level security as the authorization boundary)

Everything the site needs at runtime lives at two vendors. Cloudflare already held the
domain, DNS, TLS and WAF, so putting the origin there too makes the edge and the origin
the same thing rather than adding a network hop. Static asset requests on Workers are
free and unlimited, which is what lets the share page be as popular as it needs to be.

The public share page is served without authentication by design. It is the most-visited
surface by a wide margin — most visitors are strangers who never sign in — and keeping it
free of an auth check is both a performance and a hosting-cost decision: auth providers price
by monthly active user, and 250k of these anonymous reads counted as MAUs would cost
thousands of dollars a month against a compute bill in the single digits. All auth SDK usage is
required to go through one choke point, `src/lib/auth/`, and `tests/anonymous-read-path.test.ts`
builds the site and fails if **any** module outside that directory imports into it, or imports
an auth SDK directly. It is an edge rule, not a "can an anonymous route reach it" rule: a
`client:only` island's import is stripped from the server module, so a route-rooted walk would
miss the one case that costs the most. It runs in CI's required `check` job, which is a
different thing from the `npm run check` script — the job runs the script _and_ the tests.

## Development

Requires **Node 22** — the version is pinned in `.nvmrc`, and CI and both deploy
workflows read that same file, so there is one place to change it and nothing can drift
out of step. If you use `nvm`, `fnm`, `mise` or `asdf`, it is picked up automatically:

```bash
nvm use          # or: fnm use / mise install
npm install
cp .env.example .env
npm run dev      # http://localhost:4321
```

Node 22 is the current LTS line and is what builds every artifact that reaches staging
and production. Running a different major will still work for most things, and npm will
warn rather than stop you — but a build that only fails on 22 is a build that only fails
in CI, which is the slowest place to find out.

Other scripts:

```bash
npm run build    # static assets to dist/client, on-demand entry to dist/server
npm run preview  # serve the built output
npm run check    # astro check + tsc + eslint + prettier
npm run format   # apply prettier
```

`npm run check` is what CI enforces, alongside `npm test`. Both run in the same required
CI job, which is also called `check` — the job is the superset, so a clean `npm run check`
locally is necessary but not sufficient. Run both before opening a pull request.

### Reproducing staging and production locally

Changes travel **local → staging → live**, and the local stage can impersonate either of
the other two. There is exactly one environment-dependent behaviour in the codebase —
`PUBLIC_SITE_ENV`, which decides whether the site is indexable:

```bash
npm run build             # local: robots.txt disallows everything
npm run build:staging     # what staging serves (also disallowed)
npm run build:production  # what production serves: Allow + Sitemap
npm run preview:production # build as production, then serve it
```

Anything other than the literal string `production` yields `Disallow: /`, so staging,
previews, local builds, and any environment nobody has invented yet are all non-indexable
by default rather than by remembering to add a rule. See `src/pages/robots.txt.ts`.

If you change anything touching `robots.txt`, the sitemap, or canonical URLs, build both
ways and diff the output before opening a pull request — this is the one difference the
build produces, and CI does not yet assert it.

### The one thing staging cannot reproduce

`PUBLIC_SITE_ENV` is the only environment-dependent behaviour in the **codebase**, and the
local stage can reproduce all of it. What the local stage cannot reproduce is the gate in
front of staging itself:

**`staging.packsheet.io` sits behind Cloudflare Access.** An unlisted visitor is stopped at
the edge and the Worker never executes — so staging is not "unindexed and hopefully
unnoticed", it is closed. The allow-list lives in Cloudflare Zero Trust
(`packsheet.cloudflareaccess.com`), not in this repository, which means nothing you can
merge here weakens it and nothing here is evidence that it is still on. Pull request
preview URLs are covered by a second Access application on the same allow-list.

Production is deliberately **not** behind Access. It is a public website.

### Where the deploy configuration lives

`wrangler.jsonc` is the source of truth for both Workers, and the environment is chosen at
**build** time, not deploy time:

```bash
CLOUDFLARE_ENV=staging npm run build     # resolves the staging block
npx wrangler deploy -c dist/client/wrangler.json
```

`astro build` resolves one environment out of `wrangler.jsonc` and writes the result to
`dist/client/wrangler.json`, which is the file `wrangler deploy` actually reads. That
generated file has no environments left in it, so `wrangler deploy --env staging` reads
plausibly and does nothing — the deploy would go to whichever Worker the build had already
chosen. `tests/deploy-workers.test.ts` pins that each workflow sets `CLOUDFLARE_ENV`
explicitly, in both directions, because the failure that costs something is a staging build
landing on the Worker that serves `packsheet.io`.

Two settings in that file are load-bearing:

- **`workers_dev: false`** on both Workers. This is what keeps the site off
  `*.packsheet-io.workers.dev`. Azure's equivalent hostname could not be turned off and
  cost four releases, two shell scripts and a `forwardingGateway` header dance to work
  around; here it is one boolean, and a test fails if it flips.
- **`preview_urls`** — off on production, on for staging. Preview URLs are how a pull
  request gets a reviewable build; on production they would be an unlisted copy of the
  live site.

### Database

Schema lives in `supabase/migrations/` and is applied by the deploy workflows, before
the Worker is deployed, so a release never serves code against a schema that has not
caught up. `supabase db push` applies only what the target has not recorded, so
re-running a release is a no-op rather than a replay.

There are two hosted projects — production and staging — with separate keys and
separate data. Neither ref appears in this repository; CI selects between them from an
environment-scoped secret.

For local work you do not need either of them. `supabase start` runs the whole stack in
Docker:

```bash
supabase start                        # local Postgres, Auth, PostgREST, Studio
supabase migration new <name>         # create the next migration
supabase db reset                     # replay every migration from empty
```

`supabase db reset` is the check that matters before opening a pull request: it proves
the migration runs from a clean database rather than only against the state your
machine happens to be in. There are no down-migrations, and recovery from a bad
migration is another migration.

### What still is not covered

The production deploy checks that `packsheet.io` answers 200 with HTML and an indexable
`robots.txt` immediately after each release, so a broken release is loud within a minute.
Nothing checks **between** releases: if something breaks on a quiet Tuesday, no deploy runs
to notice. An external uptime monitor is the missing third leg, and is not yet set up.

Pull request previews share the **staging** database rather than getting one of their own.
A Supabase branch per pull request needs the Pro plan; the organisation is on Free. Nothing
reads a database yet, so this costs nothing today, but it is a gap rather than a decision.

## Design system

Colours, typography and spacing live in `src/styles/tokens.css`, ported from the project's
"Treeline" palette. Two rules the codebase depends on:

1. **Blue only ever marks something interactive, or a base weight.** It is never
   decorative.
2. **Nothing casts a shadow at rest.** Elevation is expressed with surface, sunk and
   hairline tokens. Shadows are for transient overlays only.

Typefaces are self-hosted rather than loaded from a CDN, so that visiting a shared pack
list does not disclose the reader's IP address to a third party. See
[`src/assets/fonts/README.md`](src/assets/fonts/README.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Issues and pull requests are welcome. There is no
contributor licence agreement — you keep the copyright in what you write.

## Licence

[GNU AGPL-3.0-only](LICENSE). If you run a modified copy of Packsheet as a network service,
you must offer your users its source. That is deliberate: this category has already seen a
popular tool reskinned into an affiliate funnel, and the AGPL is the licence that prevents
it happening here.

The bundled typefaces are **not** covered by the AGPL — they remain under the SIL Open Font
License 1.1. See [NOTICE](NOTICE).

Copyright © 2026 Queensway Studios Limited.
