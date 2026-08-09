// @ts-check
import { defineConfig } from 'astro/config';

import vue from '@astrojs/vue';

// The Vue integration is here for one reason: without a client-side framework this
// fixture's build has nothing in its client Rollup pass, and the two mechanisms the
// checker most depends on — the three-pass union, and detection of an island whose
// import the compiler strips from the server module (`client:only`) — would be
// justified in prose and exercised by nothing. `@astrojs/vue` and `vue` are already
// dependencies of the repo, so this adds no install; the fixture has no
// package.json of its own and resolves both from the repo root's node_modules.
export default defineConfig({
  integrations: [vue()],
});
