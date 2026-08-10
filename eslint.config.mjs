import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import astro from 'eslint-plugin-astro';
import vue from 'eslint-plugin-vue';
import vueParser from 'vue-eslint-parser';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default [
  {
    // `**/.astro/**` rather than `.astro/**`: ESLint's flat-config `ignores` isn't
    // recursive the way .gitignore is, so the un-prefixed form only ever matched
    // the project's own top-level cache. tests/fixtures/anon-read-path-violation is
    // a real Astro project in its own right (see anonymous-read-path.test.ts for
    // why it exists) and running a build against it generates the exact same
    // `.astro/types.d.ts` cache one level down, which would otherwise be linted as
    // if it were source. `node_modules/**` doesn't need the same treatment: ESLint
    // ignores every `node_modules` directory by default, at any depth.
    //
    // `supabase/.temp/**` is the local Docker stack's scratch directory. Starting a
    // stack writes a bundled edge-runtime `index.ts` into it — one 30 KB minified line
    // producing ~190 lint errors about code nobody here wrote. `.wrangler/**` is the
    // same story for `wrangler dev`, and `.astro-build-out-*` is what a killed test run
    // leaves behind.
    //
    // All of them are gitignored, and ESLint's flat config does not read .gitignore, so
    // each has to be named here as well. Without that, `npm run lint` passes or fails
    // according to whether a database happens to be running — and CI only escapes it by
    // an accident of step ordering (`npm run check` runs before the stack starts), which
    // stops being true the moment somebody reorders a workflow.
    ignores: [
      'dist/**',
      '**/.astro/**',
      'node_modules/**',
      'src/assets/**',
      '**/supabase/.temp/**',
      '**/supabase/.branches/**',
      '**/.wrangler/**',
      '.astro-build-out-*/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...astro.configs.recommended,
  ...vue.configs['flat/recommended'],
  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
  },
  {
    // vue-eslint-parser handles the SFC envelope but delegates <script lang="ts">
    // to an inner parser. Without this it chokes on the first type annotation.
    files: ['**/*.vue'],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        parser: tseslint.parser,
        extraFileExtensions: ['.vue'],
        sourceType: 'module',
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  // Must stay last: switches off every stylistic rule that would fight Prettier.
  // ESLint owns correctness here, Prettier owns formatting.
  prettier,
];
