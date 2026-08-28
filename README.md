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
builds the site and fails if a module outside that directory imports into it, or imports an
auth SDK directly. It is an edge rule, not a "can an anonymous route reach it" rule: a
`client:only` island's import is stripped from the server module, so a route-rooted walk would
miss the one case that costs the most. The modules genuinely entitled to import auth — six of
them, since PK-19 — are enumerated one line at a time in `AUTH_CONSUMERS` in that file, and
each entry is checked rather than trusted: it must name a file that exists, must still hold
the import it was granted for, and must never reach a browser. That last one is separately
enforced over the whole client bundle, not just over the allowlist: no module a browser
downloads may be, or import, any `@supabase/*` package. Nothing needs Supabase in a browser
today — the anonymous read path uses it on the SERVER, where one rendered response can be
cached for every reader — so that is a rule the codebase can keep, and the failure message
says what to do when a ticket genuinely needs to change it. All of it runs in CI's required
`check` job, which is a different thing from the `npm run check` script — the job runs the
script _and_ the tests.

## Development

Requires **Node 22** — the version is pinned in `.nvmrc`, and CI and both deploy
workflows read that same file, so there is one place to change it and nothing can drift
out of step. If you use `nvm`, `fnm`, `mise` or `asdf`, it is picked up automatically:

```bash
nvm use          # or: fnm use / mise install
npm install
cp .env.example .env
npm run db:start                     # this worktree's own Supabase stack
# copy API_URL and PUBLISHABLE_KEY from its output into .env, as
# PUBLIC_SUPABASE_URL and PUBLIC_SUPABASE_ANON_KEY — see .env.example
npm run dev      # http://localhost:4321
```

Those two values are not optional and there is no default for them: every worktree runs
its own stack on its own ports, so the right values are specific to your checkout. Without
them the auth routes answer 500 and `npm test` fails at `tests/auth-flow.test.ts` saying so.

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
the other two. `PUBLIC_SITE_ENV` is the environment-dependent behaviour that changes what
the built HTML SAYS — it decides whether the site is indexable — and it is the one these
scripts reproduce:

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

### PlaceholderOnly

A setting that makes the site serve **one coming-soon page and nothing else**. It exists
so that merging `staging` into `main` is not the same act as launching: the code can be
live, in production, while the product is not yet open — and opening it is then a setting
change rather than a release.

When it is on, `/` is the placeholder page and every other URL — the landing page, the
gear closet, the auth routes, anything — answers a `302` back to `/`. When it is off, the
placeholder page is not built, not deployed, and reachable at no URL at all.

**To turn the site on or off:**

1. GitHub → Settings → Environments → `production` → Variables → set `PLACEHOLDER_ONLY`
   to `true` (placeholder) or `false` / delete it (the real site).
2. Actions → **Deploy production** → **Run workflow**.

Step 2 is not optional. The flag is read at **build** time, so changing the variable
changes nothing until something rebuilds — the live Worker is whatever the last build
produced. The workflow has a manual trigger for exactly this, and a dispatched run is a
full release: migrations, tests and release verification all included.

`staging` has its own variable, independent of production's, so the placeholder can be
looked at on `staging.packsheet.io` without touching what the public sees.

Locally:

```bash
npm run dev:placeholder    # iterate on the page itself
npm run build:placeholder  # exactly what a production placeholder release would serve
```

**Why it is a build-time flag and not a middleware check**, since middleware is the
obvious-looking implementation and does not work here: Cloudflare's assets binding serves
prerendered files — `/welcome/`, `/robots.txt` — straight off the uploaded assets
_without invoking the Worker at all_. Astro middleware runs inside the Worker, so it never
sees those requests and could not hide the landing page. Making it able to would mean
`run_worker_first: true`, billing a Worker invocation for every static asset on every
visit, forever, to read one boolean. Instead `astro.config.mjs` swaps `srcDir`, so under
the flag `src/pages/` is never compiled: there is no other page in the artifact to reach,
by any URL or any hosting rule someone later gets wrong. The placeholder itself stays a
prerendered file served with no Worker; only the catch-all redirect costs an invocation.

`scripts/verify-release.sh` knows about both shapes and checks the one that was built —
under the flag it asserts that `/` is the page and that `/welcome/` and `/account` are
_not_ reachable. Without that it would report every correct launch as a failed release.

### The one thing staging cannot reproduce

`PUBLIC_SITE_ENV` and `PLACEHOLDER_ONLY` are both reproducible locally — they are the two
build-time switches; the
"Continue with Google" control has no flag of its own and is simply always compiled in
(see "Database" below for where the Google credentials that back it live). What is
environment-dependent and NOT reproducible is which Supabase project a build points at —
production and staging have separate ones, with separate data — and, more sharply, the
gate in front of staging itself:

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
npx wrangler deploy -c dist/server/wrangler.json
```

`astro build` resolves one environment out of `wrangler.jsonc` and writes the result to
`dist/server/wrangler.json`, which is the file `wrangler deploy` actually reads. (Before
PK-19 this was `dist/client/wrangler.json` — every route was prerendered, there was no
Worker entry, and Cloudflare's Vite plugin wrote the resolved config next to the static
assets. The first `export const prerender = false` route gave the build a real
`entry.mjs`, and the plugin writes the config next to _that_ instead — verified against
a real build, not merely expected.) That generated file has no environments left in it,
so `wrangler deploy --env staging` reads plausibly and does nothing — the deploy would
go to whichever Worker the build had already chosen. `tests/deploy-workers.test.ts` pins
that each workflow sets `CLOUDFLARE_ENV` explicitly, in both directions, because the
failure that costs something is a staging build landing on the Worker that serves
`packsheet.io`.

Two settings in that file are load-bearing:

- **`workers_dev: false`** on both Workers. This is what keeps the site off
  `*.packsheet-io.workers.dev`. Azure's equivalent hostname could not be turned off and
  cost four releases, two shell scripts and a `forwardingGateway` header dance to work
  around; here it is one boolean, and a test fails if it flips.
- **`preview_urls: false`** on both Workers. A version preview URL is an unlisted copy of
  the site on a `workers.dev` hostname — outside the zone, past the WAF, past the Access
  policy that gates staging. It was on for staging while per-PR previews existed; those
  are gone, so the exception went with them.

### Database

Schema lives in `supabase/migrations/` and is applied by the deploy workflows, before
the Worker is deployed, so a release never serves code against a schema that has not
caught up. `supabase db push` applies only what the target has not recorded, so
re-running a release is a no-op rather than a replay.

There are two hosted projects — production and staging — with separate keys and
separate data. Neither ref appears in this repository; CI selects between them from an
environment-scoped secret.

Production answers on **`auth.packsheet.io`** rather than on its generated
`<ref>.supabase.co` hostname, which is why `PUBLIC_SUPABASE_URL` for that environment
names it. This is bought — the Custom Domain add-on, \$10/month on top of Pro — for one
user-visible reason: an OAuth redirect is the single place a hosted project's hostname
reaches a person's eyes. Before this, Google's consent screen read _"to continue to
hrslxngdfocxderslkws.supabase.co"_, because Google shows the host of the redirect URI
rather than an app name for an app it has not verified. It now reads _"to continue to
packsheet.io"_ — Google collapses the subdomain to the registrable domain.

Nothing else needed it. Every other request to Supabase is made by the Worker, server
to server, where the hostname is never read by anyone: no browser talks to Supabase
directly, and `tests/anonymous-read-path.test.ts` fails the build if a `@supabase/*`
package ever reaches the client bundle. So a second custom domain for the data API
would rename something no user can see, at \$10/month per project. The generated
hostname keeps working alongside the custom one, so this is additive rather than a
cutover.

Two DNS records in the `packsheet.io` zone hold it up, and both must stay **DNS-only,
never proxied** — an orange cloud in front of them breaks certificate renewal, and the
failure arrives as an expired certificate months later rather than as a broken deploy:
a `CNAME` from `auth` to the project's generated hostname, and the `_acme-challenge`
`TXT` beneath it.

Each deploy workflow's GitHub _environment_ (`staging` or `production` — see
`environment:` in the workflow file) needs its own copies of these secrets, matching
that environment's Supabase project:

- `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF` — used by `scripts/supabase.sh link`
  and `db push` to apply migrations before the Worker deploys.
- `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` — used by the `wrangler-action` step
  to deploy the built Worker.
- `PUBLIC_SUPABASE_URL`, `PUBLIC_SUPABASE_ANON_KEY` (added by PK-19) — the same two
  values `.env.example` describes for local development, but for the hosted project.
  Vite inlines every `PUBLIC_`-prefixed variable into the client bundle at **build**
  time, so these have to be present before `npm run build` runs, not merely before the
  deploy step. They belong on the `Build` step's own `env:` and **nowhere else** — not at
  job level, not at workflow level. That is not tidiness: the same job runs `npm test` a
  few steps earlier, and that suite creates users and deletes accounts. A step-level
  `env:` cannot reach a step that already ran, which is the entire separation between
  the destructive suite and a hosted project; `tests/deploy-workers.test.ts` asserts the
  scoping and `tests/rls-enabled.test.ts` asserts that nothing above step level sets
  them. Both values are safe to hold as plain secrets rather than anything more careful:
  they are public by design (see `src/lib/auth/index.ts`'s doc comment for the key that
  is NOT this one), scoped per environment purely so staging and production build against
  their own separate Supabase projects rather than because either value is sensitive on
  its own.

Google sign-in needs no secret of its own in this repository or either workflow. The
"Continue with Google" button (`src/lib/auth-routes.ts`, `src/pages/sign-in.astro`,
`src/pages/sign-up.astro`) always renders — there used to be a `PUBLIC_`-prefixed
build-time flag gating it, added because neither hosted Supabase project had a Google
OAuth client configured yet, so the button would have sent every visitor to Supabase's
own authorize endpoint and its raw JSON `"provider is not enabled"` error. Google is now
configured and enabled on both hosted projects — a Google Cloud OAuth 2.0 client with
this project's auth callback as an authorised redirect URI, and the provider switched on
in each project's Authentication -> Providers with that client's ID and secret entered —
so the flag's only remaining job would have been to silently disable the button if
someone forgot to set it in a new environment, which is worse than not having it. Those
credentials live in Supabase's dashboard for each project, not as a GitHub secret, so
there is nothing to configure here to turn Google sign-in on or off.

**Local development runs the whole stack in Docker, one per git worktree:**

```bash
npm run db:start     # this worktree's Postgres, Auth, PostgREST, Studio
npm run db:status
npm run db:reset     # replay every migration from empty
npm run db:stop
npm run db:types     # regenerate src/lib/database.types.ts from that stack
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

**`npm test` needs that stack running, and needs `.env` pointing at it.** Part of the
suite exercises row-level security by querying the database as the `anon` and
`authenticated` roles, which nothing can stand in for — a policy is a SQL expression, and
only Postgres can say what it does. Another part signs users up, signs them in and deletes
accounts through the real module in `src/lib/auth/`. Both fail, with the command to fix
it, when there is no database or no `PUBLIC_SUPABASE_*` pair. They deliberately do not
skip: a guardrail that reports green while not running is worse than no guardrail, and
these are what stand between a private pack and the public internet.

CI never reads a `.env`. `.github/actions/local-database` starts the stack **and** exports
that stack's own URL and publishable key under those two names, so every workflow that
runs the suite is pointed at a throwaway database by construction. That is a safety
property rather than a convenience: the suite deletes accounts, and the two deploy
workflows run it in the same job that holds the hosted Supabase secrets. Those secrets are
set on the `Build` step's own `env:` and nowhere else — a step-level scope cannot reach the
`npm test` step that ran before it — and both halves are asserted in
`tests/rls-enabled.test.ts` and `tests/deploy-workers.test.ts`.

#### Generated types

`src/lib/database.types.ts` is generated from the schema by `npm run db:types` and
committed. It is what makes `supabase-js` describe rows rather than hand back `any`: a
column renamed in a migration otherwise goes on type-checking at every call site that
still says the old name, and returns `undefined` at request time on the page a stranger
is reading.

So the file has to be regenerated whenever a migration changes a table, and
`tests/database-types.test.ts` fails when it has not been — comparing the committed file
against types generated from the schema in your local stack, and printing the diff and
`npm run db:types` when they differ. It compares rather than rewrites, on purpose: a CI
step that regenerated the file quietly would keep the types correct and leave the call
sites naming columns that no longer exist, which is the breakage the check exists to
find. For the same reason, `scripts/database-types.sh` compares by default and only
writes when asked by name.

"The schema in your local stack" is deliberately not the same claim as "the migrations".
A stack one migration behind agrees with the committed types about a schema nobody has,
which is a green tick rather than a guardrail — so the script refuses to generate or
compare until `supabase migration list` says the stack is level with
`supabase/migrations/`, and tells you to `npm run db:reset` when it is not. It also
refuses a generation that came back describing no tables at all: `supabase gen types`
exits 0 emitting `Database = {}` against a database whose migrations did not apply, and
that agrees with a committed file generated the same way.

Generation runs against the **local** stack rather than a hosted project on purpose.
Generated from hosted, this would report drift whenever somebody had hand-edited that
database — a real problem, but a different one, arriving on the pull request of whoever
pushed next.

The file is excluded from Prettier and ESLint and committed byte for byte as the CLI
emits it — formatting it would make the committed content a function of the Prettier
version too, so a Prettier upgrade would read as a schema change. `tsc --noEmit` still
reads it, which is the point of having it.

One fact in this chain is hand-written rather than generated: `POSTGREST_MAJOR` in
`src/lib/supabase.ts`. `supabase gen types` does not emit the PostgREST version, so
supabase-js otherwise assumes 12 and decides what queries compile on that basis, against
a Data API running 14. That number is the one claim the drift check cannot verify — it
compares generated output against generated output, never against the running server — so
it is pinned separately, against the `Server` header the API reports.

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

Three things follow, and all three are enforced by `tests/rls-enabled.test.ts` across
every table and function in `public` rather than by review:

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

  The exception, because there is one and pretending otherwise would make the rule read
  as broken: a function that IS the API rather than a helper — `delete_own_account()`,
  which `src/lib/auth/index.ts` calls as an RPC — has to live in a schema PostgREST
  serves, so `public` is correct placement. What makes it safe is the explicit
  `revoke … from public` / `grant execute … to authenticated` block, which the rule's
  own reasoning is what motivates. A definer function anywhere must also pin
  `search_path`; that is swept too.

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

The production deploy checks that `packsheet.io` answers 200 with HTML, serves an
indexable `robots.txt`, and redirects a signed-out visitor from `/account` to `/sign-in` —
that last one being the check that proves the Worker ran at all rather than the assets
binding alone, which is what a missing Supabase secret would otherwise hide. So a broken
release is loud within a minute.
Nothing checks **between** releases: if something breaks on a quiet Tuesday, no deploy runs
to notice. An external uptime monitor is the missing third leg, and is not yet set up.

## Design system

The site is built in **Notebook Paper**, a design language written down in full at
[`docs/design/DESIGN.md`](docs/design/DESIGN.md). The page is a sheet of squared notebook
paper; content sits on flat white sheets lying on it; depth comes from a corner-curl shadow
rather than from borders or colour. Its organising idea is one sentence — **the app prints,
and the visitor writes** — and that is what divides the two typefaces: Inter sets anything the
app says, Klee One sets anything the visitor entered, including every figure.

The tokens live in `src/styles/tokens.css` and the language itself in `src/styles/paper.css`.
`DESIGN.md` is their authority. That is a change worth stating plainly: `tokens.css` used to
say it was ported from a "Treeline" palette page, and no such page ever existed — so the
project's design authority pointed at nothing, and the token file had become the standard by
default rather than by decision.

One rule the codebase depends on:

1. **Blue only ever marks something interactive, or a base weight.** It is never decorative.

A second rule — _"nothing casts a shadow at rest"_ — was retired by PK-64 rather than dropped
quietly: the corner curl **is** a shadow at rest, and it is what makes the sheets read as
paper. See `CONTRIBUTING.md` for what survives of it.

The language is **light only**. There is no dark mode and no theme toggle; paper is light, so
the language is.

Typefaces are self-hosted rather than loaded from a CDN, so that visiting a shared pack
list does not disclose the reader's IP address to a third party. See
[`src/assets/fonts/README.md`](src/assets/fonts/README.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Issues and pull requests are welcome. There is no
contributor licence agreement — you keep the copyright in what you write.

## Licence

[MIT](LICENSE).

The "Packsheet" name and logo are **not** covered by the MIT licence — they remain
trademarks of Queensway Studios Limited. The bundled typefaces are also **not** covered
by the MIT licence — they remain under the SIL Open Font License 1.1. See [NOTICE](NOTICE).

Copyright © 2026 Queensway Studios Limited.
