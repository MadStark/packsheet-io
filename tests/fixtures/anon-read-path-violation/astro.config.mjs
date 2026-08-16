// @ts-check
import { defineConfig } from 'astro/config';

import vue from '@astrojs/vue';

/**
 * Puts a reference to the privileged key into ONE module's transformed text without
 * putting it in that module's file. It is the fixture's stand-in for the several real
 * mechanisms that do this — a `vite.define` substitution, an integration's generated
 * wrapper, a codegen plugin — and it exists because that case is otherwise unreachable
 * from a fixture made only of files: every other case here is caught by reading the file,
 * so none of them can show that reading the file is not enough.
 *
 * `enforce: 'pre'` matters. The graph recorder in tests/anonymous-read-path.test.ts is an
 * ordinary plugin, so it only sees this injection if this runs first; as a `post` plugin
 * this would inject into text nothing downstream ever reads, and the fixture case would
 * silently prove nothing.
 *
 * Scoped to one module by exact path on purpose. A broader match would put the reference
 * into modules the other cases depend on being clean, and the "reports exactly these
 * modules" assertion would stop meaning anything.
 */
function injectPrivilegedKeyReference() {
  const target = '/src/lib/generated-only-key.ts';
  return {
    name: 'fixture-inject-generated-key',
    enforce: /** @type {const} */ ('pre'),
    transform(/** @type {string} */ code, /** @type {string} */ id) {
      if (!id.split('?')[0].endsWith(target)) return null;
      return {
        code:
          '// Injected at transform time by the fixture astro.config.mjs; not in the file.\n' +
          'const injectedPrivilegedKey = process.env.SUPABASE_SERVICE_ROLE_KEY;\n' +
          'void injectedPrivilegedKey;\n' +
          code,
        map: null,
      };
    },
  };
}

// The Vue integration is here because without a client-side framework this fixture's
// build has nothing in its client Rollup pass at all, and everything the checker knows
// about that pass would be justified in prose and exercised by nothing: the three-pass
// union, detection of an island whose import the compiler strips from the server module
// (`client:only`), and both halves of Invariant D — an allowlisted module that turns out
// to hydrate, and a component that imports `@supabase/*` and hydrates. All four ride on
// there being real islands here. `@astrojs/vue` and `vue` are already
// dependencies of the repo, so this adds no install; the fixture has no
// package.json of its own and resolves both from the repo root's node_modules.
export default defineConfig({
  integrations: [vue()],
  vite: {
    plugins: [injectPrivilegedKeyReference()],
  },
});
