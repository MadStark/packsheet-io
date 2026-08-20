# Contributing to Packsheet

Thanks for considering it. This document covers what you need to know before opening an
issue or a pull request.

## No CLA

There is no contributor licence agreement and no copyright assignment. You keep the
copyright in what you write; you licence it to the project under
[AGPL-3.0-only](LICENSE), the same terms as everything else here.

The consequence, stated plainly so nobody is surprised later: because copyright is spread
across contributors, the project cannot be relicensed without everyone's agreement. That is
a deliberate constraint, not an oversight.

## Getting set up

Requires **Node 22**, pinned in `.nvmrc`. CI and both deploy workflows read that same
file, so local, staging and production all build on one version.

```bash
git clone git@github.com:MadStark/packsheet-io.git
cd packsheet-io
nvm use          # or: fnm use / mise install
npm install
cp .env.example .env
npm run dev
```

`.env.example` documents the only environment variable the app reads,
`PUBLIC_SITE_ENV`. You do not need to change it for normal work.

## Before you open a pull request

```bash
npm run check
npm test
```

`npm run check` runs `astro check`, `tsc --noEmit`, ESLint and Prettier; `npm test` runs
Vitest. CI runs both, in one required job that is confusingly also called `check` — so run
the two commands, not just the one that shares its name. `npm run format` applies Prettier
if formatting is the only thing failing.

## Branches

Work travels in one direction: **local → staging → live.**

- **`staging` is the integration branch.** It holds the latest in-progress work, and it is
  where your pull request should go.
- **`main` is production.** It is protected, and is only ever updated by merging `staging`
  through a pull request. A push to `main` deploys to the live site.

Feature branches are squashed when they merge into `staging` — that is where the readable,
one-commit-per-change history lives.

The `staging` → `main` promotion is different: it uses a **merge commit**, and must never
be squashed or rebased. Both of those rewrite commits, re-creating a change that already
exists on `staging` under a new SHA. The branches then diverge, and every subsequent
release fails with a spurious `add/add` conflict that looks like a content problem but is
a history one. This happened once, during the PS-7 release, and cost a force-push to
unpick.

This is also why linear history is deliberately **not** required on `main`: requiring it
would leave only the two rewriting strategies and guarantee the fault comes back. To read
`main` as a release log, use `git log main --first-parent` — one entry per release.

So: branch from `staging`, and target `staging` in your pull request.

There are **no per-pull-request preview deployments** — a PR runs CI and nothing is
deployed. Review a change by running it locally: `npm run db:start && npm run dev` gives
you the site against your own Postgres, and `npm test` runs the full suite against it.
`staging.packsheet.io` deploys from the `staging` branch once your PR merges.

Both branches require their CI check to pass before merging.

## Design constraints worth knowing

The site is built in the **Notebook Paper** design language, which is written down in
[`docs/design/DESIGN.md`](docs/design/DESIGN.md). That file is the authority: it explains the
materials, the rules that hold them together and the CSS recipes that produce them, and it
records the failures behind the rules most likely to be undone by someone who does not know
why they exist. Read it before designing a new surface.

Its one-sentence thesis is worth knowing even if you read nothing else: **the app prints, and
the visitor writes.** Two typefaces divide the page between them on that basis — Inter sets
anything the app says, Klee One sets anything the visitor entered — and a decision that cannot
be justified by that sentence is probably wrong.

One rule runs through the whole codebase, and a pull request that breaks it will be asked to
change:

1. **Blue only ever marks something interactive, or a base weight.** Never decorative.

**A second rule used to sit here and no longer does**, recorded rather than silently dropped
because it was true for months and people remember it. It read _"nothing casts a shadow at
rest — use the surface, sunk and hairline tokens for elevation, shadows are for transient
overlays."_ PK-64 superseded it. Notebook Paper's entire depth model **is** a shadow at rest:
the corner curl of `DESIGN.md` §2.4 is the one trick that makes a flat white rectangle read as
paper, and `--surface` and `--sunk` no longer exist. What survives is the intent — no uniform
drop shadows, no elevation for its own sake, and every shadow mixed from `--shadow-ink` rather
than from black, because a black shadow on warm paper reads as a hole.

Colours come from `src/styles/tokens.css`, and that file's authority is `DESIGN.md` §14. If you
need a colour that is not there, it belongs in `DESIGN.md` first — raise it in an issue rather
than inventing one at a call site. The palette is maintained deliberately, including its
contrast ratios, and several of its values exist _because_ the obvious choice failed AA.

Two more that are less obvious:

- **The public share page must not require authentication.** It is the most-visited surface
  and most of its visitors never sign in. Adding an auth check to that path is a
  correctness _and_ a hosting-cost problem — auth providers price by monthly active user, and
  every anonymous read counted as one would turn a compute bill of single-digit dollars into
  one of several thousand. All auth is required to go through `src/lib/auth/`, and
  `tests/anonymous-read-path.test.ts` builds the site and fails if **any** module outside
  that directory imports into it, or imports `@clerk/*` directly — an edge rule, not a "can
  an anonymous route reach it" rule, because a `client:only` island's import never appears
  in the server module for a route-rooted walk to follow. It runs in the required CI job
  named `check`, which runs the tests as well as the `npm run check` script of the same
  name.
- **No module that ships may name the Supabase service-role key.** The same test fails if
  any module in the build graph outside `src/lib/auth/` so much as names it. Note that this
  one is deliberately _not_ a reachability rule and not an import rule at all, unlike the
  bullet above: it is a text scan over the modules the build actually produced, so a shared
  library nothing routes to fails it exactly as a page does. It is also not about cost:
  `service_role` bypasses row-level security entirely, so every RLS policy in the database
  becomes decorative. Supabase itself is welcome here — the publishable `anon` key is public
  by design and is how anonymous reads work at all. The rule is about the key, not the
  package.

  Two things follow, and the second one has caught people out:

  - The check reads source text and cannot tell code from a comment, so **describe the key
    rather than naming it** — in comments as well as in code. That applies to any file that
    ends up in the build graph, which means everything under `src/` that something imports.
    It does **not** apply to the test file that defines the rule, or to its fixtures under
    `tests/`: those are not built, are not in the graph, and name the key freely on purpose.
    If a build goes red, the fix is in the module the message names. Deleting the identifier
    from `tests/anonymous-read-path.test.ts` deletes the check.
  - The rule is **name-bound**: it matches a fixed list of spellings, defined as
    `PRIVILEGED_KEY_PATTERNS` in `tests/anonymous-read-path.test.ts`. If you are the person
    who first adds a Supabase secret to `.env.example`, `wrangler.jsonc` or a CI secret,
    check its name against that list and add it if it is not there. A name-bound rule that
    does not know the name in use is not a weaker guardrail, it is a permanently green one.

- **No third-party CDN for fonts or assets on reader-facing pages.** Someone reading a
  shared pack list should not have their IP disclosed to a third party to do it.

## Accessibility

Not optional, and not a later pass. New UI is expected to keep the placeholder's standard:
Lighthouse accessibility 100, WCAG AA contrast for text, visible focus indicators, and
`prefers-reduced-motion` respected.

If you add a colour combination, check its contrast — "it looked fine" is not sufficient
evidence. There is no dark mode to check against any more, but the palette still has values
that pass on one ground and fail on another, and the third ink is the one to watch: `--ink-3`
clears AA on the paper (4.51:1) and on a white sheet (4.64:1) and **nowhere else** — on
`--paper-deep` it is 4.11:1 and fails. Half the ten category fills fail as text on white too,
which is why they are documented as fill-only.

## Commit messages

Explain **why**, not just what. A message that records the reasoning behind a non-obvious
decision is worth considerably more later than one that restates the diff.

## Reporting bugs

Use the bug report template. The single most useful thing you can include is what you
expected to happen versus what did.

## Security

Please do **not** open a public issue for a security problem. Use GitHub's private
vulnerability reporting on this repository, or email `admin@queenswaystudios.com`.
