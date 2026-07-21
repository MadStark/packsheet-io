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

Requires Node 22.12 or newer.

```bash
npm install
cp .env.example .env
npm run dev      # http://localhost:4321
```

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
ways and diff the output before opening a pull request — this is the one difference between
the deployed environments, and CI does not yet assert it.

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
