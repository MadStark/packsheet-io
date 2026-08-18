import { describe, expect, it } from 'vitest';
import { PACKS_PATH, PACK_REORDER_PATH, packPath } from '../src/lib/packs/routes';

/**
 * `src/lib/packs/routes.ts` is four lines of strings, and only one thing about it can
 * actually go wrong — but that thing is a route collision, which fails at request time on
 * a URL nobody clicked before release rather than at build time. Two couplings are pinned
 * here.
 *
 * FIRST, `PACK_REORDER_PATH` MUST STAY UNDER `PACKS_PATH`. `src/middleware.ts` treats the
 * paths in `AUTH_ROUTE_PATHS` as roots and applies its session rules to everything beneath
 * them (see that list's comment on enumerated roots and inherited sub-paths). Moving the
 * endpoint to a sibling top-level path would take it out from under the rule silently —
 * nothing would fail, it would simply stop being covered.
 *
 * SECOND, `/packs/reorder` SHADOWS `packPath('reorder')`, and that is only safe while pack
 * ids are UUIDs. Astro resolves the static segment first, so if `packs.id` ever became a
 * user-chosen slug, the visitor who named a pack "reorder" would get the endpoint instead
 * of their pack. That is a live constraint on a future change, not a hypothetical, so it
 * is written down as an assertion rather than only as prose.
 */

/** A canonical v4 UUID, the shape `gen_random_uuid()` produces and the only shape
 *  `packPath` is ever handed. */
const PACK_ID = '0f9b6c2e-1a3d-4b7e-8c2f-5d6e7a8b9c01';

describe('pack route paths', () => {
  it('roots the packs list at /packs', () => {
    expect(PACKS_PATH).toBe('/packs');
  });

  it('builds the editor path under that root', () => {
    expect(packPath(PACK_ID)).toBe(`/packs/${PACK_ID}`);
  });

  it('keeps the reorder endpoint under the packs root, where middleware’s rules reach it', () => {
    expect(PACK_REORDER_PATH.startsWith(`${PACKS_PATH}/`)).toBe(true);
  });

  // The shadowing is safe because the collision is unreachable, not because Astro would
  // resolve it kindly: a UUID is 36 characters with hyphens at fixed offsets, and the
  // literal `reorder` is not one.
  it('cannot be produced by packPath for any UUID', () => {
    expect(packPath(PACK_ID)).not.toBe(PACK_REORDER_PATH);
    expect(PACK_ID).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(PACK_REORDER_PATH.slice(PACKS_PATH.length + 1)).not.toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  // A trailing slash on a Worker-served route is a redirect hop at best and a 404 at
  // worst — see the argument at WELCOME_PATH in src/lib/routes.ts, which is the same
  // problem from the prerendered side.
  it.each([
    ['the list', PACKS_PATH],
    ['the reorder endpoint', PACK_REORDER_PATH],
    ['the editor', packPath(PACK_ID)],
  ])('%s is an absolute path with no trailing slash', (_label, path) => {
    expect(path.startsWith('/')).toBe(true);
    expect(path.endsWith('/')).toBe(false);
  });
});
