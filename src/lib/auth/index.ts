/**
 * The auth choke point.
 *
 * This module is the ONLY place in the codebase that is allowed to import or
 * re-export an authentication SDK. Every other module — every page, every layout,
 * every component, middleware in either spelling Astro accepts (`src/middleware.ts`
 * or `src/middleware/index.ts`) if one is ever added — must reach it by going
 * through here.
 *
 * Why this matters more than the usual "keep your SDK usage in one place" advice:
 * auth providers price by monthly active user, not by request or by compute. This
 * site's entire traffic model is the opposite of what that pricing assumes — most
 * visitors are strangers who click a shared pack-list link from Reddit and never sign
 * in. If the auth SDK were invoked on that path, every one of those anonymous reads
 * would count as a MAU.
 *
 * `tests/anonymous-read-path.test.ts` enforces this at build time: it builds the
 * real site, walks the resulting module graph, and fails if ANY module outside this
 * directory imports anything inside it — an edge rule, not a "can an anonymous route
 * reach it" rule, because a `client:only` island's import is dropped from the server
 * module and no route-rooted walk can see it.
 *
 * It separately fails if `@clerk/*` is imported by ANY module in that graph other than
 * one in this directory — not merely by a first-party module under src/. That scoping
 * is deliberate and was a real hole: `npx astro add @clerk/astro` wires the SDK in
 * through astro.config.mjs and integration-injected middleware, touching no file under
 * src/ at all, so a first-party-scoped rule waves the documented installation straight
 * through. What the module graph cannot see, and what no rule there will ever catch,
 * is an SDK loaded over a `<script src="https://...">` tag or vendored into public/ —
 * that has its own, separate assertion in the same file. Don't delete any of it to
 * make a build go green; read the comment at the top of the test first.
 *
 * ---------------------------------------------------------------------------
 * WHAT CHANGED WITH SUPABASE, AND WHAT THIS FILE DOES NOT YET GUARD (Ref 48)
 * ---------------------------------------------------------------------------
 *
 * Authentication is Supabase Auth, not Clerk. Clerk was never installed, and the
 * `@clerk/*` assertion stays exactly as it is: it costs nothing and it keeps a
 * provider that has been decided against from arriving by accident.
 *
 * But the rule does NOT simply transfer by swapping the package name, and reading it
 * that way would break the site:
 *
 *   - `@supabase/supabase-js` and `@supabase/ssr` BELONG on the anonymous read path.
 *     Anonymous reads go through PostgREST with the publishable `anon` key, and
 *     row-level security restricts them to public rows. Supabase does not meter
 *     anonymous reads at all, and Auth is $0.00325/MAU. The $6,000/month cliff that
 *     justified banning the SDK outright does not exist here.
 *
 *   - What replaces it is narrower and sharper. The `anon` key is public by design
 *     and safe to ship. `SUPABASE_SERVICE_ROLE_KEY` **bypasses row-level security
 *     entirely** — it is not a stronger key, it is the absence of the authorization
 *     boundary. It must never be reachable from a route an anonymous visitor can
 *     load, because there the database stops being the thing that says no.
 *
 * **That service_role rule is not enforced yet.** It is Ref 30's rewrite, and it is
 * the same shape as the import rule above: one more assertion in the same test,
 * failing the build if `SUPABASE_SERVICE_ROLE_KEY` appears anywhere in the share-page
 * route tree. Until it lands, this file's guarantee covers who may import auth code,
 * not which key that code holds. Do not read the green build as coverage of the
 * second thing.
 *
 * The corollary of an edge rule, and the thing to get right when adding files here:
 * this directory must contain NOTHING that an anonymous route could legitimately
 * want. A pure-types `types.ts`, or a shared `SIGN_IN_PATH` constant that a nav
 * component imports to render a link, would ship zero auth code and still fail CI
 * with a $6,000 message — the kind of false positive that gets a guardrail weakened
 * or deleted rather than obeyed. Shared auth-adjacent *types* and *constants* belong
 * somewhere an anonymous route may import from (src/lib/, or the consuming module
 * itself). What lives here is only what must never be reachable: the SDK and the
 * code that calls it — and, once Ref 30 lands, the service-role client.
 *
 * No auth SDK is installed yet (there are no consumers of this module today), so this
 * file currently exports nothing. It exists so the choke point — and the test that
 * guards it — are in place before the first line of auth code is.
 */

export {};
