/// <reference types="astro/client" />

/**
 * `Astro.locals.user` — the signed-in user for this request, or `null`.
 *
 * Resolved exactly once per request by `src/middleware.ts`, which calls
 * `getUser()` (never `getSession()` — see that function's own comment in
 * `src/lib/auth/index.ts` for why the distinction matters) so that every route
 * downstream reads a value that has already been verified against the auth
 * server, rather than each route re-deciding how to check.
 *
 * `import('@supabase/supabase-js').User` rather than a static top-level import:
 * this file is a `.d.ts`, erased before anything reaches a bundler, so a type-only
 * reference here creates no Rollup module and no edge into `src/lib/auth/` for
 * `tests/anonymous-read-path.test.ts` to see. That is by design and not a loophole
 * — the choke point is about the SDK's *runtime* reaching a browser, and a type
 * name has no runtime to reach it with. Astro's own `Locals` type is declared the
 * same way (see `astro/client.d.ts`), which is what confirms the pattern is safe
 * to lean on here rather than something this file is inventing.
 */
declare namespace App {
  interface Locals {
    user: import('@supabase/supabase-js').User | null;
  }
}
