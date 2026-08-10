/// <reference types="vitest/config" />
import { getViteConfig } from 'astro/config';
import type { PluginOption } from 'vite';

// getViteConfig applies Astro's own Vite resolution — its plugins, tsconfig path
// aliases and PUBLIC_ env prefix — so a module imported by a test transforms the way
// it does in the build rather than under a hand-rolled config that drifts from it.
//
// It does NOT hand the tests the resolved `site`: they inject their own APIContext.
// The dependency on `site` is pinned directly instead, by robots-txt.test.ts asserting
// the sitemap URL is derived from whatever `site` it passes in.

/**
 * Remove the Cloudflare Vite plugin from the config Astro hands back.
 *
 * Adding @astrojs/cloudflare to astro.config.mjs pulls @cloudflare/vite-plugin into
 * every consumer of getViteConfig, including this one — and that plugin refuses to
 * start when a Worker environment declares `resolve.external`, which is exactly what
 * Vitest sets on the `ssr` environment to keep Node builtins out of the transform.
 * The result is not a failing test, it is vitest exiting before collection with
 * "environment options are incompatible with the Cloudflare Vite plugin". The whole
 * suite, including the guardrails, stops running.
 *
 * Dropping it here is safe because nothing in tests/ executes in workerd: they parse
 * YAML and JSON, walk the module graph of a real `astro build` (which runs in a
 * separate process, with the plugin, through the adapter), and render an APIRoute as
 * a plain function. What is kept is everything Astro-specific — the env prefix, the
 * aliases, the .astro and .vue transforms.
 *
 * The narrow filter matters. `@astrojs/cloudflare:*` plugins are left in place; they
 * externalise `cloudflare:` imports and configure the adapter, and removing them
 * would change how a tested module resolves. Only `vite-plugin-cloudflare*` — the
 * runtime plugin that wants to own the environment — is dropped.
 *
 * If a test ever genuinely needs workerd, it wants @cloudflare/vitest-pool-workers in
 * its own project rather than this plugin re-added here.
 */
function withoutCloudflareRuntimePlugin(plugins: PluginOption[]): PluginOption[] {
  return plugins.flatMap((plugin) => {
    if (Array.isArray(plugin)) return [withoutCloudflareRuntimePlugin(plugin)];
    if (plugin && typeof plugin === 'object' && 'name' in plugin) {
      if (
        plugin.name === 'vite-plugin-cloudflare' ||
        plugin.name.startsWith('vite-plugin-cloudflare:')
      )
        return [];
    }
    return [plugin];
  });
}

const astroViteConfig = getViteConfig({
  test: {
    // Colocated tests are allowed anywhere under src/ EXCEPT src/pages/, where every
    // file becomes a route — a robots.txt.test.ts there would ship as /robots.txt.test.
    //
    // Listing src/ explicitly matters: a pattern narrow enough to only match tests/
    // means a test written anywhere else is silently never collected, and the run
    // still exits 0. A test that cannot fail is the exact defect this suite exists to
    // catch, so it must not be possible to create one by putting a file in the wrong
    // directory. src/pages/ is excluded rather than ignored, and ci.yml fails the
    // build if a test file appears there, so the gap closes loudly instead of quietly.
    include: ['tests/**/*.{test,spec}.ts', 'src/**/*.{test,spec}.ts'],
    exclude: ['src/pages/**'],
    environment: 'node',

    // One test file at a time. This suite has two kinds of test that are not safe to
    // run beside themselves, and both fail in the way that is hardest to act on — an
    // error in a file nobody touched, on a re-run that passes.
    //
    // 1. Two files run a real `astro build` against this project root:
    //    anonymous-read-path.test.ts in process, deploy-workers.test.ts through
    //    `npx astro build`. The Cloudflare adapter's Vite plugin persists workerd
    //    state to `.wrangler/state` under the root, and the root is the same for both.
    //    Concurrently, the second build to arrive dies on
    //    `SQLITE_BUSY: database is locked` before it has compiled anything, and every
    //    invariant in that file reports as a failure of the invariant rather than of
    //    the build. The plugin's `persistState` path is not reachable from here — it
    //    is set by @astrojs/cloudflare, not by us — so there is nowhere to give the
    //    two builds separate state.
    //
    // 2. The row-level-security tests share one Postgres. They scope their assertions
    //    to rows they created, so they do not corrupt each other's data — but the
    //    query PLANNER reads the whole table, and a test asserting how a lookup is
    //    executed will read a different plan depending on how many packs some other
    //    file happened to have inserted by then.
    //
    // Both were observed, not anticipated. The cost is the whole suite going from
    // roughly 4s to roughly 11s, which is the right trade against a suite that fails
    // for reasons unrelated to the change under test — the first flake teaches people
    // to re-run, and the second teaches them to stop reading the output.
    fileParallelism: false,
  },
});

export default async (env: Parameters<typeof astroViteConfig>[0]) => {
  const config = await astroViteConfig(env);
  return { ...config, plugins: withoutCloudflareRuntimePlugin(config.plugins ?? []) };
};
