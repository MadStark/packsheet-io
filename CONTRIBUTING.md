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
```

This runs `astro check`, `tsc --noEmit`, ESLint and Prettier. It is what CI runs, so a
clean local run means no surprises. `npm run format` applies Prettier if formatting is the
only thing failing.

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

So: branch from `staging`, and target `staging` in your pull request. Opening a PR builds
an ephemeral preview environment and comments the URL on the PR; closing or merging the PR
tears it down.

Both branches require their CI check to pass before merging.

## Design constraints worth knowing

Two rules run through the whole codebase, and a pull request that breaks them will be asked
to change:

1. **Blue only ever marks something interactive, or a base weight.** Never decorative.
2. **Nothing casts a shadow at rest.** Use the surface, sunk and hairline tokens for
   elevation. Shadows are for transient overlays.

Colours come from `src/styles/tokens.css`. If you need a colour that is not there, raise it
in an issue rather than inventing one — the palette is maintained deliberately, including
its contrast ratios.

Two more that are less obvious:

- **The public share page must not require authentication.** It is the most-visited surface
  and most of its visitors never sign in. Adding an auth check to that path is a
  correctness _and_ a hosting-cost problem.
- **No third-party CDN for fonts or assets on reader-facing pages.** Someone reading a
  shared pack list should not have their IP disclosed to a third party to do it.

## Accessibility

Not optional, and not a later pass. New UI is expected to keep the placeholder's standard:
Lighthouse accessibility 100, WCAG AA contrast for text, visible focus indicators, and
`prefers-reduced-motion` respected.

If you add a colour combination, check its contrast. Several tokens in the palette pass in
light mode and fail in dark, so "it looked fine" is not sufficient evidence.

## Commit messages

Explain **why**, not just what. A message that records the reasoning behind a non-obvious
decision is worth considerably more later than one that restates the diff.

## Reporting bugs

Use the bug report template. The single most useful thing you can include is what you
expected to happen versus what did.

## Security

Please do **not** open a public issue for a security problem. Use GitHub's private
vulnerability reporting on this repository, or email `admin@queenswaystudios.com`.
