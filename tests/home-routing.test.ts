/**
 * Where `/` sends a visitor, and the one-way door that decision has to keep shut.
 *
 * `/` used to be the landing page itself — a prerendered file, the same for everybody.
 * It is now a router with no markup at all: signed-in visitors go to their closet,
 * signed-out visitors go to the landing page at `WELCOME_PATH`. That decision lives in
 * `homeDestination` rather than in `src/pages/index.astro`'s frontmatter for the reason
 * spelled out at the top of tests/account-deletion-gate.test.ts — vitest cannot reach
 * `src/pages/` at all (it is excluded, because every file under it becomes a route), so
 * logic typed into a page is logic with no test, not by anyone's decision but as a side
 * effect of where it was typed.
 *
 * THE ASSERTION THAT MATTERS MOST is the redirect-loop one below, and it is worth saying
 * why it is not paranoia. `homeDestination` returns a path that `src/pages/index.astro`
 * immediately redirects to. If either arm ever returned `HOME_PATH` — a plausible edit,
 * since "send them home" is exactly how someone would describe the signed-in case out
 * loud — `/` would redirect to `/`, and the browser would follow it until it gave up.
 * That failure does not look like a bug in a route, it looks like the site being down,
 * and nothing else in this suite is positioned to notice it.
 */

import { describe, expect, it } from 'vitest';
import { HOME_PATH, WELCOME_PATH, homeDestination } from '../src/lib/routes';
import { GEAR_PATH } from '../src/lib/gear/routes';
import { safeNextPath } from '../src/lib/auth-routes';

describe('homeDestination', () => {
  it('sends a signed-in visitor to their gear closet', () => {
    expect(homeDestination(true)).toBe(GEAR_PATH);
  });

  it('sends a signed-out visitor to the landing page', () => {
    expect(homeDestination(false)).toBe(WELCOME_PATH);
  });

  /**
   * The loop guard. Stated as "neither arm", not "the signed-in arm", because the
   * signed-out arm is one careless edit away from the same shape: `WELCOME_PATH` and
   * `HOME_PATH` are both "the page a stranger sees" in ordinary speech, and they are
   * the same string in every version of this site before this one.
   */
  it.each([
    ['signed in', true],
    ['signed out', false],
  ])(
    'never returns HOME_PATH itself when %s, which would be a redirect loop',
    (_label, signedIn) => {
      expect(homeDestination(signedIn)).not.toBe(HOME_PATH);
    },
  );

  // Two destinations, not one: the whole change is that these differ. An edit that
  // collapsed them would pass both assertions above if it picked GEAR_PATH for each.
  it('distinguishes the two cases', () => {
    expect(homeDestination(true)).not.toBe(homeDestination(false));
  });
});

describe('the paths themselves', () => {
  it('keeps the site root as the front door', () => {
    expect(HOME_PATH).toBe('/');
  });

  /**
   * WITH THE TRAILING SLASH, which is the whole assertion and not an accident of how it
   * was typed. Astro prerenders the landing page to `dist/client/welcome/index.html`, and
   * Cloudflare's assets binding canonicalises that to `/welcome/` — `/welcome` answers a
   * 307. Dropping the slash here costs the front door an extra hop AND fails
   * `scripts/verify-release.sh`, which fetches this path expecting 200 and would burn
   * every retry on the redirect. `npm run dev` serves both spellings, so nothing local
   * catches it; this assertion and the one in tests/deploy-workers.test.ts are what do.
   */
  it('gives the landing page a URL of its own, in the form the assets binding serves', () => {
    expect(WELCOME_PATH).toBe('/welcome/');
  });

  /**
   * `WELCOME_PATH` must stay somewhere a PRERENDERED, edge-cacheable file can live, which
   * in practice means: not under any prefix `src/middleware.ts` marks `no-store`, and not
   * under `/gear` or `/account`. Asserted as a shape rather than by importing the
   * middleware's list, because the point is a property of the path, and importing that
   * list here would make this test pass by construction the moment somebody added
   * `/welcome` to it — which is precisely the edit it exists to catch.
   */
  it('does not hide the landing page under a session-shaped prefix', () => {
    expect(WELCOME_PATH.startsWith('/gear')).toBe(false);
    expect(WELCOME_PATH.startsWith('/account')).toBe(false);
    expect(WELCOME_PATH.startsWith('/auth')).toBe(false);
  });

  // Both travel through `?next=`, so both have to survive the open-redirect guard
  // unchanged rather than being silently rewritten to the fallback.
  it.each([
    ['HOME_PATH', HOME_PATH],
    ['WELCOME_PATH', WELCOME_PATH],
    ['GEAR_PATH', GEAR_PATH],
  ])('leaves %s intact through safeNextPath', (_label, path) => {
    expect(safeNextPath(path)).toBe(path);
  });
});

/**
 * The post-sign-in default, moved from `ACCOUNT_PATH` to `HOME_PATH`.
 *
 * This is what makes "where a signed-in person goes" a single fact in one file. Before,
 * a sign-in that carried no `?next=` landed on `/account` — a settings screen — while
 * the gear closet, the thing people actually came for, was reachable only through the
 * nav. Sending them to `HOME_PATH` costs one extra 302 (`/` then resolves to the closet)
 * and buys the property that changing the dashboard later is an edit to `homeDestination`
 * alone, rather than an edit there plus a hunt for every hard-coded default.
 */
describe('the post-sign-in default', () => {
  it('falls back to HOME_PATH rather than to a settings page', () => {
    expect(safeNextPath(null)).toBe(HOME_PATH);
    expect(safeNextPath(undefined)).toBe(HOME_PATH);
    expect(safeNextPath('')).toBe(HOME_PATH);
  });

  // And a rejected value falls back the same way — the guard's refusals and its
  // "nothing was supplied" case have always shared a destination, and still do.
  it('falls back to HOME_PATH for a value the open-redirect guard refuses', () => {
    expect(safeNextPath('https://evil.example/steal')).toBe(HOME_PATH);
    expect(safeNextPath('//evil.example')).toBe(HOME_PATH);
  });
});
