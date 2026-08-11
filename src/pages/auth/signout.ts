import type { APIRoute } from 'astro';
import { signOut } from '../../lib/auth';

// On-demand: clears session cookies, which a prerendered file cannot do.
export const prerender = false;

/**
 * POST only, deliberately — no GET handler is exported here at all. A GET that signs
 * the visitor out is a CSRF vector (an attacker-controlled page can trigger a GET with
 * nothing more than `<img src>`, no scripting or same-site cookie needed) and, on this
 * site specifically, a prefetcher: a browser or a link-preview bot speculatively
 * fetching every same-origin `<a href>` on a page would silently log a visitor out by
 * following a "Sign out" link nobody clicked. Astro answers any method with no
 * exported handler — GET included — with a 405, which is exactly what should happen
 * here; there is nothing else to write for that case.
 *
 * CSRF for the POST itself: Astro's on-demand origin check (security.checkOrigin, set
 * explicitly in astro.config.mjs) plus the session cookie's sameSite: 'lax' — the same
 * pair every other mutating route in this project relies on. See the comment on
 * astro.config.mjs's `security` block.
 */
export const POST: APIRoute = async ({ cookies, request, redirect }) => {
  await signOut({ cookies, request });
  return redirect('/', 303);
};
