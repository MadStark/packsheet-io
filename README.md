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
merge here weakens it and nothing here is evidence that it is still on. It authenticates
with a one-time PIN by email; an Access application admits nobody at all until an
identity provider exists in the account, however correct its allow-list.

**There are no per-pull-request preview deployments.** They were removed deliberately:
a workflow, a fork guard, a second Access application and a third hostname, in exchange
for a URL that was rarely opened. The staging branch auto-deploys to
`staging.packsheet.io` and that is the shared environment; anything needing a closer
look runs locally against this worktree's own database.

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

**Local development runs the whole stack in Docker, one per git worktree:**

```bash
npm run db:start     # this worktree's Postgres, Auth, PostgREST, Studio
npm run db:status
npm run db:reset     # replay every migration from empty
npm run db:stop
npm run db -- migration new <name>   # any other CLI command
```

Each worktree gets its **own** stack — its own containers and its own data — because
`supabase/config.toml` reads its project name and all seven of its ports from the
environment, and `scripts/supabase.sh` derives them from the checkout directory. Two
worktrees can run at once without colliding, and switching branches never inherits the
other branch's database. Override `PACKSHEET_STACK` or `PACKSHEET_PORT_BASE` to pin
either by hand.

> **Never call `supabase` directly.** With those variables unset the config does not
> parse and the CLI reports `failed to read config: ProjectConfigParseError`, which
> names neither the cause nor the fix. Use `npm run db:*`, or `scripts/supabase.sh`
> — the deploy workflows go through it too, because `link` and `db push` parse the
> same file even though they never start a stack.

`npm run db:reset` is the check that matters before opening a pull request: it proves
the migration runs from a clean database rather than only against the state your
machine happens to be in. There are no down-migrations, and recovery from a bad
migration is another migration.

There is no `supabase/seed.sql`, so a reset leaves you with an empty database. That
was deliberate while there was no schema to seed against; now that the core tables
exist it is simply not written yet.

**`npm test` needs that stack running.** Part of the suite exercises row-level security
by querying the database as the `anon` and `authenticated` roles, which nothing can
stand in for — a policy is a SQL expression, and only Postgres can say what it does. Those
tests fail, with the command to fix it, when there is no database. They deliberately do
not skip: a guardrail that reports green while not running is worse than no guardrail,
and this one is what stands between a private pack and the public internet. CI starts the
stack in the same job for the same reason.

```bash
npm run db:start && npm test
```

### Authorization

Row-level security is the authorization boundary, not a second opinion on one. A private
pack is unreachable with the `anon` key because the database returns zero rows for it,
so a bug in the share page cannot leak one.

Two things follow, and both are enforced by `tests/rls-enabled.test.ts` across every
table in `public` rather than by review:

- **A new table must enable RLS and carry policies in the migration that creates it.**
  Not in a follow-up — a table shipped without policies is not "unprotected pending
  policies", it is readable by the `anon` key, which is public by design and shipped to
  every browser.
- **A new table must revoke the default grants and re-grant what it needs.** Postgres
  hands `anon` TRUNCATE, REFERENCES, TRIGGER and MAINTAIN by default on tables owned by
  `postgres`, and **row-level security does not apply to TRUNCATE** — no policy can stop
  it. `supabase/migrations/20260810120000_core_schema.sql` has the block to copy.
- **A helper function goes in `private`, not `public`.** `public` is served by PostgREST
  and a function is created with `EXECUTE` to `PUBLIC`, so a helper written there is an
  anonymous RPC endpoint the moment it exists. This matters most for the one function
  people reach for under pressure: a `SECURITY DEFINER` helper added to break policy
  recursion would sit on the anonymous surface running as its owner.

Two things this does **not** yet do, so they are not mistaken for solved:

- A public pack exposes the **whole** gear row, including `notes` and `url`, and every
  table's `user_id`. Column-level grants are the obvious fix and are incompatible with
  PostgREST embedding — any table in an embed needs table-level `SELECT`, so restricting
  columns breaks the single-round-trip share query outright. The two mechanisms that do
  work (a `security_invoker` view, or moving those fields to a 1:1 owner-only table) are
  product decisions that belong with the share page. The frozen `snapshot` already omits
  them.
- `visibility = 'public'` means **listed**, not merely "reachable by anyone with the
  link": the Data API answers an unfiltered `GET /rest/v1/packs` with the publishable
  key. An `'unlisted'` value would need a code path that excludes it from that listing,
  and none exists yet.

### What still is not covered

The production deploy checks that `packsheet.io` answers 200 with HTML and an indexable
`robots.txt` immediately after each release, so a broken release is loud within a minute.
Nothing checks **between** releases: if something breaks on a quiet Tuesday, no deploy runs
to notice. An external uptime monitor is the missing third leg, and is not yet set up.

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
