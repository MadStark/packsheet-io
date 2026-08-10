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
  },
});

export default async (env: Parameters<typeof astroViteConfig>[0]) => {
  const config = await astroViteConfig(env);
  return { ...config, plugins: withoutCloudflareRuntimePlugin(config.plugins ?? []) };
};
