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
- Azure Static Web Apps behind Cloudflare
- PostgreSQL

The public share page is served without authentication by design. It is the most-visited
surface by a wide margin — most visitors are strangers who never sign in — and keeping it
free of an auth check is both a performance and a hosting-cost decision.

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
npm run build    # static output to dist/
npm run preview  # serve the built output
npm run check    # astro check + tsc + eslint + prettier
npm run format   # apply prettier
```

`npm run check` is what CI enforces. Run it before opening a pull request.

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
local stage can reproduce all of it. There is one divergence that lives in the **deploy
pipeline** instead, and it is deliberate:

Azure gives every Static Web App a permanent, public `*.azurestaticapps.net` hostname. It
cannot be turned off, it serves the same build, and it bypasses Cloudflare entirely — no
edge cache, no WAF, no rate limiting, and a second crawlable copy of every page. Since
`staticwebapp.config.json` route rules match on path and method but never on hostname,
there is no way to noindex that hostname without also noindexing `packsheet.io`.

So production refuses any request that did not come through Cloudflare: a Cloudflare
transform sets `X-Origin-Verify`, and `forwardingGateway.requiredHeaders` makes Azure
demand it. `deploy-production.yml` writes that config at deploy time from a secret, rather
than committing it, because this repository is public.

**Staging does not have it, and cannot.** `forwardingGateway` requires the Standard plan
and staging is deliberately on Free to halve the hosting cost. This is the one change in
the project that production receives untested — `tests/deploy-origin-lock.test.ts` runs
`scripts/write-origin-lock.sh` and pins what can be checked without deploying, and the
`Verify the lock from both sides` step checks the rest against the running site
immediately after each release.

#### If production returns 403, check Cloudflare first

The lock depends on a Cloudflare transform rule that lives outside this repository. If it
is edited, disabled, narrowed, or a DNS record is switched to grey-cloud, Azure starts
refusing every request and **nothing in this repo can tell you that** — the deploy was
green, the code is fine.

Restoring the Cloudflare rule is the fast path: seconds, no build, no merge. Reverting the
deploy is the slow one — a full `npm ci`, test, build and upload with the site down
throughout, and it rests on the assumption that a deployment omitting the file clears a
previously-applied `forwardingGateway`. **Reach for Cloudflare first.**

The rule must set `X-Origin-Verify` to exactly the value in the `SWA_ORIGIN_VERIFY` secret
(production environment), and is scoped to `http.host eq "packsheet.io"` so the value is
not broadcast to every other host on the zone.

#### Rotating the secret: one deploy, and the header name alternates

`requiredHeaders` is conjunctive — Azure demands _all_ listed headers — so "old value OR
new value" cannot be expressed on **one** header name. Changing either side alone is an
outage: update the secret first and Cloudflare still sends the old value; update Cloudflare
first and the deployed config still demands the old one.

The way through is to rotate the **name** as well as the value, alternating between two
names forever: `X-Origin-Verify` → `X-Origin-Verify-Alt` → `X-Origin-Verify` → … Each
rotation is a single deploy, and the name you end on is simply the other one.

1. **Cloudflare only.** Add a second header — the _other_ name — carrying the new value,
   leaving the current one in place. Production ignores it; it demands only the current
   name, which is unchanged. Nothing has moved yet.
2. **One deploy.** Update `SWA_ORIGIN_VERIFY` to the new value, and change `HEADER_NAME`
   to the other name in **both** `scripts/write-origin-lock.sh` **and**
   `tests/deploy-origin-lock.test.ts`. Both, or the suite goes red. The duplication is
   deliberate: a test importing the constant from the script would pin nothing.
   Deploy. Production now demands only the new header, which Cloudflare is already sending.
3. **Cloudflare only.** Delete the old header.

Never skip to step 3.

**If you change `HEADER_NAME` in only one of the two files, nothing breaks in
production.** `deploy-production.yml` runs `npm test` before the build and before the
config is written, so the job fails at the test step: nothing is built, nothing is
written, nothing is uploaded. The live deployment keeps the config it already had, which
demands the old header — and step 1 left Cloudflare still sending it. **The site stays
up.** Fix the second file and deploy again; there is no incident here, and no reason to
reach for a revert.

The value itself must contain no whitespace — not even a trailing newline, which is easy
to introduce by pasting into the GitHub secrets UI. `write-origin-lock.sh` refuses rather
than trimming, so that mistake fails the build instead of silently deploying a header
value Cloudflare can never match.

### What still is not covered

`Verify the lock from both sides` runs on every production deploy, so a lock that is
already broken is caught within a minute of a release. Nothing checks **between**
releases: if the Cloudflare rule is changed on a quiet Tuesday, the site starts refusing
everyone and no deploy runs to notice. An external uptime monitor on `packsheet.io` is
the missing third leg, and is not yet set up.

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
