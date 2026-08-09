import type { MiddlewareHandler } from 'astro';

// Violation #6: middleware importing the choke point. Deliberately in the DIRECTORY
// form (`src/middleware/index.ts`) rather than the single-file `src/middleware.ts`:
// Astro resolves either spelling, so any rule that hardcodes a middleware path is
// blind to the other one, and the blindness is silent — the unchecked spelling is
// still built and still ships. The edge-based rule needs no path knowledge at all,
// and this fixture case is what keeps it that way.
//
// Middleware is the worst place for an auth import: it runs ahead of every route's
// own page module, so one import here puts the auth SDK on every anonymous read at
// once, and no page has an edge to it for a page-rooted walk to follow.
import '../lib/auth/index';

export const onRequest: MiddlewareHandler = (_context, next) => next();
