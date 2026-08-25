## Development

When starting the dev server, use background mode:

```
astro dev --background
```

Manage the background server with `astro dev stop`, `astro dev status`, and `astro dev logs`.

### Local Supabase stack lifecycle during `/implement-ticket`

When `notion-workflow:implement-ticket`'s browser-testing loop starts this worktree's own
local Supabase stack (`npm run db:start`), **leave it running when the skill finishes** —
don't tear it down automatically. The user reviews the built feature locally against that
same stack before deciding to merge, and tearing it down as part of finishing the skill
would force them to wait through another `db:start` (container startup, migrations replay)
just to look at what was built.

Tear it down only on an explicit signal from the user: they say the review is done, or a
`/complete-ticket` (or equivalent finishing) run begins for that ticket. At that point, stop
the stack so its containers actually stop holding CPU/RAM — this machine regularly runs
several worktrees' stacks at once, and a stack left running past its useful life is resource
contention for every other session on it.

**How to tear one down — `--no-backup`, not a plain stop.** Use:

```
supabase stop --no-backup
```

(or `npm run db:stop -- --no-backup`, which forwards through `scripts/supabase.sh`).
`--no-backup` removes the containers, network, and data volumes together. A plain `supabase
stop`/`npm run db:stop` keeps a backup volume around for a faster next start, but that
backup is exactly what accumulates across agent runs — `supabase_db_*`, `supabase_storage_*`
and `supabase_edge_runtime_*` volumes and images left behind are the main source of Docker
disk bloat on this machine, worse than the plain `docker rm`/`docker compose down` case
because they are silent: nothing in `docker ps` shows a stopped stack's orphaned volume.
Never tear a stack down by deleting its worktree directory or running `docker rm` directly —
either one skips Supabase's own cleanup and leaves the same orphaned state `--no-backup`
exists to prevent.

## Documentation

Full documentation: https://docs.astro.build

Consult these guides before working on related tasks:

- [Adding pages, dynamic routes, or middleware](https://docs.astro.build/en/guides/routing/)
- [Working with Astro components](https://docs.astro.build/en/basics/astro-components/)
- [Using React, Vue, Svelte, or other framework components](https://docs.astro.build/en/guides/framework-components/)
- [Adding or managing content](https://docs.astro.build/en/guides/content-collections/)
- [Adding styles or using Tailwind](https://docs.astro.build/en/guides/styling/)
- [Supporting multiple languages](https://docs.astro.build/en/guides/internationalization/)
