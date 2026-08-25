## Development

When starting the dev server, use background mode:

```
astro dev --background
```

Manage the background server with `astro dev stop`, `astro dev status`, and `astro dev logs`.

### Local Supabase cleanup

When you're done testing against a local Supabase stack (including one started in a worktree), tear it down with:

```
supabase stop --no-backup
```

`--no-backup` removes the containers, network, and data volumes together. Plain `docker rm`/`docker compose down`, or just deleting the worktree, leaves orphaned `supabase_db_*`, `supabase_storage_*`, and `supabase_edge_runtime_*` volumes and images behind — these accumulate across agent runs and are the main source of Docker disk bloat on this machine.

## Documentation

Full documentation: https://docs.astro.build

Consult these guides before working on related tasks:

- [Adding pages, dynamic routes, or middleware](https://docs.astro.build/en/guides/routing/)
- [Working with Astro components](https://docs.astro.build/en/basics/astro-components/)
- [Using React, Vue, Svelte, or other framework components](https://docs.astro.build/en/guides/framework-components/)
- [Adding or managing content](https://docs.astro.build/en/guides/content-collections/)
- [Adding styles or using Tailwind](https://docs.astro.build/en/guides/styling/)
- [Supporting multiple languages](https://docs.astro.build/en/guides/internationalization/)
