/**
 * The auth choke point.
 *
 * This module is the ONLY place in the codebase that is allowed to import or
 * re-export anything from Clerk. Every other module — every page, every layout,
 * every component, `src/middleware.ts` if one is ever added — must reach Clerk (if
 * it needs to at all) by going through here, never by importing `@clerk/*` directly.
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
 * real site, walks the resulting module graph, and fails if any anonymous route (or
 * `src/middleware.ts`, which would poison every route at once) transitively imports
 * this module, and separately fails if `@clerk/*` is imported from anywhere other
 * than this directory. Don't delete that test to make a build go green — read the
 * comment at the top of it first.
 *
 * Clerk is not installed yet (there are no consumers of this module today), so this
 * file currently exports nothing. It exists so the choke point — and the test that
 * guards it — are in place before the first line of auth code is.
 */

export {};
