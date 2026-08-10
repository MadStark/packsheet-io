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
 * WHAT CHANGED WITH SUPABASE (Ref 48), AND WHAT NOW GUARDS THE KEY (Ref 55)
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
 * That second rule is now enforced, in the same test, as Invariant C: the build fails
 * if ANY module in the graph outside this directory so much as names a privileged key —
 * `SUPABASE_SERVICE_ROLE_KEY`, the same name without its prefix, `SUPABASE_SECRET_KEY`,
 * or a pasted `sb_secret_…` value. It is a rule about the key and not about the package.
 * Neither Supabase package is installed yet (Ref 49 is what brings them), so what the
 * fixture actually asserts is the narrower, testable half of that claim: a page that
 * reads `PUBLIC_SUPABASE_URL` and `PUBLIC_SUPABASE_ANON_KEY` and names Supabase in its
 * own copy is not flagged, and must never become flagged. When the packages do land,
 * neither of them contains the string SERVICE_ROLE anywhere — measured at 2.112.2 and
 * 0.12.4 — so nothing goes red on contact. The whole build graph is in scope, not just
 * first-party code, for the same reason Invariant B is: a dependency holding the key
 * ships it exactly as our own code would.
 *
 * This directory is the one exemption, which makes it the only place a service-role
 * client may live. It does not hold one today; when it does, it goes here, and every
 * route that needs privileged data reaches it through this module rather than reading
 * the key itself.
 *
 * READ THIS BEFORE ACTING ON THE PARAGRAPH ABOVE. "Reach it through this module" is
 * where this is going, and it is not currently possible: Invariant A is an unconditional
 * edge rule, so a route importing this directory is itself a build failure — reported
 * with a message about a $6,000/month auth bill that has nothing to do with the key.
 * That is deliberate. There is no privileged consumer in this codebase yet, and the first
 * genuine one is the trigger for revisiting Invariant A rather than for quietly widening
 * it. Whoever has that first consumer should start from the all-caps paragraph on
 * `checkAnonymousReadPath` in tests/anonymous-read-path.test.ts, which says what has to be
 * solved first (a reachability rule has to reconstruct the `client:only` edge the compiler
 * drops) and what the acceptance test for that work is.
 *
 * Three limits of that check, so the green build is not read as more than it is.
 *
 * It reads source text, so a name assembled at runtime (`env[segments.join('_')]`) is
 * invisible to it — closing that means evaluating the program. And for the same reason it
 * cannot tell code from a comment: naming the variable in a comment fails the build
 * exactly as an assignment does. This file may spell it out because this directory is
 * exempt; anywhere else, describe the key rather than naming it.
 *
 * And it is NAME-BOUND. It knows the spellings listed in PRIVILEGED_KEY_PATTERNS in that
 * test file and no others, and this project has not yet chosen the name its secret will
 * ship under — there is no Supabase entry in .env.example and no such secret in
 * wrangler.jsonc. Whoever adds one must check the name against that list and add it if it
 * is missing. A name-bound rule that does not know the name in use is not a weaker
 * guardrail; it is a permanently green one, while the key ships.
 *
 * The corollary of an edge rule, and the thing to get right when adding files here:
 * this directory must contain NOTHING that an anonymous route could legitimately
 * want. A pure-types `types.ts`, or a shared `SIGN_IN_PATH` constant that a nav
 * component imports to render a link, would ship zero auth code and still fail CI
 * with a $6,000 message — the kind of false positive that gets a guardrail weakened
 * or deleted rather than obeyed. Shared auth-adjacent *types* and *constants* belong
 * somewhere an anonymous route may import from (src/lib/, or the consuming module
 * itself). What lives here is only what must never be reachable: the SDK, the code
 * that calls it, and the service-role client if one is ever needed.
 *
 * No auth SDK is installed yet (there are no consumers of this module today), so this
 * file currently exports nothing. It exists so the choke point — and the test that
 * guards it — are in place before the first line of auth code is.
 */

export {};
