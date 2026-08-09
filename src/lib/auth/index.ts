/**
 * The auth choke point.
 *
 * This module is the ONLY place in the codebase that is allowed to import or
 * re-export anything from Clerk. Every other module — every page, every layout,
 * every component, middleware in either spelling Astro accepts (`src/middleware.ts`
 * or `src/middleware/index.ts`) if one is ever added — must reach Clerk (if it needs
 * to at all) by going through here, never by importing `@clerk/*` directly.
 *
 * Why this matters more than the usual "keep your SDK usage in one place" advice:
 * Clerk, like every mainstream auth provider, prices by monthly active user, not by
 * request or by compute. This site's entire traffic model is the opposite of what
 * that pricing assumes — most visitors are strangers who click a shared pack-list
 * link from Reddit and never sign in. If the auth SDK were invoked on that path,
 * every one of those anonymous reads would count as a MAU. At 250k monthly users,
 * that is roughly $6,000/month on Microsoft Entra External ID, or $3,000-4,000/month
 * on Clerk — against a compute bill of about $9/month for serving the same traffic
 * as static pages. A single accidental import is the entire difference between those
 * two numbers.
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
 * through. The one exemption is Clerk's own packages importing each other. What the
 * module graph cannot see, and what no rule there will ever catch, is an SDK loaded
 * over a `<script src="https://...">` tag or vendored into public/ — that has its own,
 * separate assertion in the same file. Don't delete any of it to make a build go
 * green; read the comment at the top of the test first.
 *
 * The corollary of an edge rule, and the thing to get right when adding files here:
 * this directory must contain NOTHING that an anonymous route could legitimately
 * want. A pure-types `types.ts`, or a shared `SIGN_IN_PATH` constant that a nav
 * component imports to render a link, would ship zero auth code and still fail CI
 * with a $6,000 message — the kind of false positive that gets a guardrail weakened
 * or deleted rather than obeyed. Shared auth-adjacent *types* and *constants* belong
 * somewhere an anonymous route may import from (src/lib/, or the consuming module
 * itself). What lives here is only what must never be reachable: the SDK and the
 * code that calls it.
 *
 * Clerk is not installed yet (there are no consumers of this module today), so this
 * file currently exports nothing. It exists so the choke point — and the test that
 * guards it — are in place before the first line of auth code is.
 */

export {};
