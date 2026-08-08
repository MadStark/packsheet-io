// @ts-check
import { defineConfig } from 'astro/config';

// Deliberately minimal: this fixture exists only so
// tests/anonymous-read-path.test.ts has a real Astro project to build and walk
// where the invariant is actually violated, proving the walker can fail. It needs
// no integrations, no site URL, nothing beyond a src/pages directory.
export default defineConfig({});
