import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import type { build as AstroBuild } from 'astro';

/**
 * The anonymous read path must never reach Clerk.
 *
 * Auth providers price by monthly active user, not by request or by compute — and
 * this site's traffic is the opposite of what that pricing assumes. Most visitors
 * are strangers opening a shared pack list from a Reddit link; they never sign in.
 * If Clerk were invoked on that path, every one of those anonymous reads counts as
 * a MAU. At 250k monthly users that is roughly $6,000/month on Microsoft Entra
 * External ID, or $3,000-4,000/month on Clerk, against a compute bill of about
 * $9/month for serving the same traffic as static pages. One accidental import is
 * the entire gap between those numbers, and nothing about a stray `import { x } from
 * '@clerk/...'` looks dangerous in a code review — it type-checks, it builds, the
 * page still renders. The cost only shows up on an invoice, weeks later, from a
 * provider that cannot be un-billed retroactively.
 *
 * So this file enforces two invariants at build time, by building the real site and
 * inspecting the actual Rollup module graph Astro produces — not by grep, which
 * cannot see through a re-export or an aliased import, and not by convention, which
 * relies on every future PR author having read this comment.
 *
 * Invariant A: no anonymous route's page module, and nothing `src/middleware.ts`
 * imports (middleware runs on every route, so an import there poisons all of them
 * at once), can transitively reach anything under src/lib/auth/.
 *
 * Invariant B: nothing outside src/lib/auth/ may import `@clerk/*` directly, once
 * Clerk is a dependency. This is what makes "single choke point" a fact about the
 * codebase rather than a naming convention: Invariant A only ever proves that
 * anonymous routes don't reach *this particular* module, so without Invariant B a
 * second, unguarded path to Clerk could open up right next to it and Invariant A
 * would have nothing to say about it.
 *
 * A build-graph-based check that never finds anything is indistinguishable from a
 * broken one — this repo already has a documented case of that failure mode (see
 * the header comment on deploy-origin-lock.test.ts). Today nothing in the real site
 * imports auth, so Invariant A's real-repo assertion passes trivially and proves
 * nothing about the walker on its own. The self-test lower down in this file runs
 * the exact same walker function against a fixture project that DOES violate the
 * invariant, and asserts it is caught, with the right chain and the right message.
 *
 * Mechanism notes, from spiking this before writing it:
 *
 * - The graph is collected in the Rollup `buildEnd` hook via `this.getModuleIds()`
 *   / `this.getModuleInfo()`. The more obvious-looking `moduleParsed` hook was
 *   tried first and silently produces an incomplete graph — Layout.astro's own
 *   imports were missing from it entirely, which would have let a violation one
 *   level below any layout go undetected. `buildEnd` is complete.
 * - A single Astro build runs three separate Rollup passes (an empty one, an
 *   SSR/server pass, and a client pass for hydrated islands), and `buildEnd` fires
 *   once per pass, each with its own partial view of the graph — the client pass,
 *   for instance, is the only one that resolves a Vue island's own client-side
 *   dependencies. The passes are unioned into one graph below; checking only the
 *   first pass would miss anything reachable only from client-hydrated code.
 * - Page entry points are read off the build's own `virtual:astro:page:<route>@_@
 *   <ext>` modules rather than globbed from the filesystem, so the route list used
 *   here cannot drift from the routes the build actually produces.
 */

const repoPath = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const repoRoot = repoPath('.');
const fixtureRoot = repoPath('tests/fixtures/anon-read-path-violation');

const COST_ARGUMENT =
  'MAU-priced auth is the largest cost cliff in this stack: 250k monthly readers ' +
  'authenticating would cost roughly $6,000/month on Microsoft Entra External ID, or ' +
  '$3,000-4,000/month on Clerk, against a compute bill of about $9/month for serving the ' +
  'same traffic as static pages. Most visitors here are anonymous strangers opening a ' +
  'shared pack list from a Reddit link, so the auth SDK must never be reachable from an ' +
  'anonymous route.';

// ---------------------------------------------------------------------------
// The walker
// ---------------------------------------------------------------------------

/** What `buildEnd` gives us for one module in one Rollup pass: what it imports,
 *  statically and dynamically. Both matter — a dynamic `import()` is exactly how a
 *  hydrated island would lazily pull in Clerk client-side, and missing that branch
 *  would make the graph blind to precisely the case the client Rollup pass exists
 *  to catch. */
interface PassEntry {
  imported: string[];
  dynamic: string[];
}
type PassGraph = Map<string, PassEntry>;

/** The unioned graph: module id -> every id it imports, static or dynamic, in any
 *  pass. Ids are absolute filesystem paths for real files, bare specifiers (e.g.
 *  "vue") for externals a given pass leaves unresolved, or resolved node_modules
 *  paths where a pass did resolve them. */
type ModuleGraph = Map<string, Set<string>>;

interface BuildGraph {
  graph: ModuleGraph;
  /** route name (e.g. "src/pages/index") -> absolute path of the real page file it
   *  resolves to, read directly off the build's virtual:astro:page:* entries. */
  pageEntries: Map<string, string>;
}

/** Module ids sometimes carry a query suffix (e.g. a font imported as `...woff2?
 *  url`) that is part of how Vite tags the import, not part of the module's
 *  identity for graph-walking purposes. Stripped so the same file is recognised as
 *  the same node regardless of which query string a given import used. */
function stripQuery(id: string): string {
  const i = id.indexOf('?');
  return i === -1 ? id : id.slice(0, i);
}

/** A page entry module imports exactly the real page file — see the mechanism
 *  notes above. The leading `\0` is Rollup's convention for a virtual module with
 *  no file on disk, stripped here because it is not part of the route name. */
const PAGE_ENTRY_RE = /^\0?virtual:astro:page:(.+)@_@[^@]+$/;

/**
 * `import { build } from 'astro'` cannot be a normal static import in this file.
 * vitest.config.ts builds its Vite config with `getViteConfig` (see that file's own
 * comment for why), which is astro's real dev/build config — and that config
 * aliases the bare specifier "astro" to `astro/dist/types/public/index.js`, a
 * types-only, runtime-empty stub. The alias is correct for ordinary site code,
 * which only ever imports astro's public *types* (`APIRoute`, `AstroGlobal`, ...);
 * it exists specifically so a page importing those types doesn't drag the entire
 * CLI into the site's own bundle. This file is the unusual case that wants astro's
 * actual `build()` function, and there is no config knob to exempt one import from
 * an aliasing rule. Resolving the real path with `require.resolve` and importing
 * that absolute path instead sidesteps the alias, which only matches the literal
 * specifier "astro". Confirmed against `node_modules/astro/dist/core/create-vite.js`.
 */
async function loadAstroBuild(): Promise<typeof AstroBuild> {
  const require = createRequire(import.meta.url);
  const astro = (await import(require.resolve('astro'))) as { build: typeof AstroBuild };
  return astro.build;
}

/** Runs a real `astro build` against `root` and returns the unioned module graph
 *  plus the route -> real-file map. This is the one function both the real
 *  Invariant A check and its fixture-backed self-test call, so a bug in the walker
 *  itself cannot pass one and fail the other for different reasons. */
async function buildModuleGraph(root: string): Promise<BuildGraph> {
  const build = await loadAstroBuild();
  const outDir = mkdtempSync(join(tmpdir(), 'anon-read-path-'));
  const passGraphs: PassGraph[] = [];

  // A minimal Rollup plugin: it doesn't transform anything, it just reads the
  // graph Rollup has already built and hands it to buildEnd, once per pass.
  function graphRecorderPlugin() {
    return {
      name: 'anon-read-path-graph-recorder',
      buildEnd(this: {
        getModuleIds(): IterableIterator<string>;
        getModuleInfo(
          id: string,
        ): { importedIds: string[]; dynamicallyImportedIds: string[] } | null;
      }) {
        const pass: PassGraph = new Map();
        for (const id of this.getModuleIds()) {
          const info = this.getModuleInfo(id);
          if (!info) continue; // Rollup can list an id whose info was since evicted; nothing to record.
          pass.set(stripQuery(id), {
            imported: info.importedIds.map(stripQuery),
            dynamic: info.dynamicallyImportedIds.map(stripQuery),
          });
        }
        passGraphs.push(pass);
      },
    };
  }

  try {
    await build({
      root,
      outDir,
      logLevel: 'error',
      vite: { plugins: [graphRecorderPlugin()] },
    });
  } finally {
    // Point every build at a throwaway directory and remove it unconditionally, so
    // a failed build still leaves no artifact behind in the repo or the fixture.
    rmSync(outDir, { recursive: true, force: true });
  }

  const graph: ModuleGraph = new Map();
  const pageEntries = new Map<string, string>();

  for (const pass of passGraphs) {
    for (const [id, { imported, dynamic }] of pass) {
      const targets = graph.get(id) ?? new Set<string>();
      for (const t of imported) targets.add(t);
      for (const t of dynamic) targets.add(t);
      graph.set(id, targets);

      const routeMatch = PAGE_ENTRY_RE.exec(id);
      if (routeMatch) {
        const real = imported[0] ?? dynamic[0];
        if (real) pageEntries.set(routeMatch[1], real);
      }
    }
  }

  return { graph, pageEntries };
}

/** Breadth-first, so the reported chain is the shortest path to the auth module —
 *  the clearest one to hand to whoever has to go fix the import, not just the
 *  first one Map iteration order happened to produce. Returns the full chain,
 *  starting at `from`, or null if nothing under the graph reaches `isTarget`. */
function findChain(
  graph: ModuleGraph,
  from: string,
  isTarget: (id: string) => boolean,
): string[] | null {
  const queue: string[][] = [[from]];
  const seen = new Set([from]);
  while (queue.length > 0) {
    const path = queue.shift()!;
    const last = path[path.length - 1];
    if (isTarget(last)) return path;
    for (const next of graph.get(last) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push([...path, next]);
    }
  }
  return null;
}

function describeChain(root: string, chain: string[]): string {
  return chain.map((id) => relative(root, id) || id).join('\n    -> ');
}

function violationMessage(root: string, entryLabel: string, chain: string[]): string {
  return [
    `${entryLabel} transitively imports the auth choke point (src/lib/auth/):`,
    `    ${describeChain(root, chain)}`,
    '',
    COST_ARGUMENT,
  ].join('\n');
}

interface RouteViolation {
  route: string;
  chain: string[];
  message: string;
}

/**
 * Invariant A, as a pure function over an already-built graph: for every
 * anonymous route (every route NOT named in `authenticatedRoutes`) and for
 * `src/middleware.ts` if it exists, is there any path at all to a module under
 * `<root>/src/lib/auth/`?
 *
 * `authenticatedRoutes` is default-deny on purpose: it is a list of routes to
 * SKIP, not a list to check, and it is empty today because nothing in this
 * codebase is authenticated yet. A route added in the future is covered by this
 * check automatically, with nobody needing to remember to opt it in — the
 * alternative, an allowlist of routes that MUST stay anonymous, silently stops
 * covering every route added after the list was last updated.
 */
function checkAnonymousReadPath(
  build: BuildGraph,
  root: string,
  authenticatedRoutes: readonly string[],
): RouteViolation[] {
  const authDir = join(root, 'src', 'lib', 'auth') + sep;
  const isAuthModule = (id: string) => id.startsWith(authDir);
  const violations: RouteViolation[] = [];

  for (const [route, file] of build.pageEntries) {
    if (authenticatedRoutes.includes(route)) continue;
    const chain = findChain(build.graph, file, isAuthModule);
    if (chain) violations.push({ route, chain, message: violationMessage(root, route, chain) });
  }

  // Middleware runs ahead of every route's own page module, so an import inside it
  // poisons every route at once with no direct page -> middleware edge in the
  // graph for Invariant A's page loop above to ever walk. It does not exist in
  // this codebase yet, so `build.graph.has(...)` — false when the file was never
  // part of the build — is what lets this run without a special "does it exist"
  // check of its own.
  const middlewarePath = join(root, 'src', 'middleware.ts');
  if (build.graph.has(middlewarePath)) {
    const chain = findChain(build.graph, middlewarePath, isAuthModule);
    if (chain) {
      violations.push({
        route: 'src/middleware.ts',
        chain,
        message: violationMessage(root, 'src/middleware.ts (runs on every route)', chain),
      });
    }
  }

  return violations;
}

interface ClerkViolation {
  clerkModule: string;
  importer: string;
}

/** A Clerk module can show up two ways in the graph: as a bare specifier like
 *  "@clerk/astro" (a pass that leaves it an unresolved external — the same shape
 *  "vue" takes in the SSR pass before the client pass resolves it), or as a
 *  resolved path through node_modules/@clerk/... (the client pass, or a server
 *  pass that did resolve it). Both are checked so neither shape lets an import
 *  through unnoticed. */
function isClerkModule(id: string): boolean {
  return /^@clerk\//.test(id) || /(^|\/)node_modules\/@clerk\//.test(id);
}

/**
 * Invariant B, as a pure function over an already-built graph: every module that
 * resolves to `@clerk/*` must be imported only from inside `authDir`.
 *
 * Clerk is not a dependency of this project yet, so on the real repo this always
 * returns an empty array today — but that is not the same thing as vacuous. The
 * check itself (this function) is exercised directly, without a real build, by
 * the self-test below using a synthetic graph containing a `@clerk/*` id. The
 * day Clerk is added as a dependency, this same function starts actually gating
 * every module in the real build too, with no code change required here.
 */
function checkClerkChokePoint(graph: ModuleGraph, authDir: string): ClerkViolation[] {
  const violations: ClerkViolation[] = [];
  for (const [importer, targets] of graph) {
    if (importer.startsWith(authDir)) continue;
    for (const target of targets) {
      if (isClerkModule(target)) violations.push({ clerkModule: target, importer });
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Invariant A & B — against the real site
// ---------------------------------------------------------------------------

/** Empty today: nothing in this codebase is authenticated. See the reasoning on
 *  checkAnonymousReadPath above for why this is a skip-list rather than an
 *  allowlist, and why empty is the correct, permanent-until-proven-otherwise
 *  default rather than a placeholder waiting to be filled in. */
const AUTHENTICATED_ROUTES: readonly string[] = [];

describe('the real site', () => {
  let realBuild: BuildGraph;

  // One real `astro build` (~well under a second per the pre-implementation spike),
  // shared by both invariants below so the suite pays for it once, not twice.
  beforeAll(async () => {
    realBuild = await buildModuleGraph(repoRoot);
  }, 60_000);

  it('no anonymous route, and no middleware, transitively imports the auth choke point', () => {
    const violations = checkAnonymousReadPath(realBuild, repoRoot, AUTHENTICATED_ROUTES);
    expect(violations.map((v) => v.message)).toEqual([]);
  });

  // Dormant rather than vacuous: see the comment on checkClerkChokePoint. This
  // assertion is real and will start catching real violations the day
  // `@clerk/...` lands in package.json — it just has nothing to find yet.
  it('nothing outside src/lib/auth/ imports @clerk/* (dormant: Clerk is not yet a dependency)', () => {
    const authDir = join(repoRoot, 'src', 'lib', 'auth') + sep;
    const violations = checkClerkChokePoint(realBuild.graph, authDir);
    expect(violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Self-test — proves the walker can actually fail
// ---------------------------------------------------------------------------

describe('the walker, run against a fixture that actually violates Invariant A', () => {
  let fixtureBuild: BuildGraph;

  beforeAll(async () => {
    fixtureBuild = await buildModuleGraph(fixtureRoot);
  }, 60_000);

  it('flags the page that imports auth directly, with the real one-hop chain', () => {
    const violations = checkAnonymousReadPath(fixtureBuild, fixtureRoot, []);
    const direct = violations.find((v) => v.route === 'src/pages/direct');

    expect(direct).toBeDefined();
    expect(direct!.chain.map((id) => relative(fixtureRoot, id))).toEqual([
      'src/pages/direct.astro',
      'src/lib/auth/index.ts',
    ]);
    expect(direct!.message).toContain('src/pages/direct');
    expect(direct!.message).toContain('$6,000');
    expect(direct!.message).toContain('$3,000-4,000');
    expect(direct!.message).toContain('$9/month');
  });

  // The claim this test suite actually makes is transitive detection, not "can
  // spot a direct import" — a walker that only inspected each page's own import
  // list would pass this fixture's `direct` case and still miss every realistic
  // violation, which arrives through a shared component two or three hops away.
  it('flags the page that imports auth transitively, through a component, with the full chain', () => {
    const violations = checkAnonymousReadPath(fixtureBuild, fixtureRoot, []);
    const transitive = violations.find((v) => v.route === 'src/pages/transitive');

    expect(transitive).toBeDefined();
    expect(transitive!.chain.map((id) => relative(fixtureRoot, id))).toEqual([
      'src/pages/transitive.astro',
      'src/components/AuthGate.astro',
      'src/lib/auth/index.ts',
    ]);
  });

  // The other half of "not vacuous": a walker that reported every route as a
  // violation would also pass the two assertions above.
  it('does not flag the page that never goes near auth', () => {
    const violations = checkAnonymousReadPath(fixtureBuild, fixtureRoot, []);
    expect(violations.some((v) => v.route === 'src/pages/clean')).toBe(false);
  });

  it('reports exactly the two violating routes, no more and no fewer', () => {
    const violations = checkAnonymousReadPath(fixtureBuild, fixtureRoot, []);
    expect(violations.map((v) => v.route).sort()).toEqual([
      'src/pages/direct',
      'src/pages/transitive',
    ]);
  });
});

describe('checkClerkChokePoint, self-tested with a synthetic graph since @clerk is not installed', () => {
  // Real node_modules/@clerk/* packages don't exist in this repo yet, so the only
  // way to prove this function actually fires — rather than being dormant AND
  // untested — is to hand it a graph shaped the way a real one would be once
  // Clerk exists, without running a real build.
  const authDir = join(repoRoot, 'src', 'lib', 'auth') + sep;

  it('flags a @clerk/* import from outside the choke point', () => {
    const pageFile = join(repoRoot, 'src', 'pages', 'index.astro');
    const graph: ModuleGraph = new Map([[pageFile, new Set(['@clerk/astro'])]]);

    expect(checkClerkChokePoint(graph, authDir)).toEqual([
      { clerkModule: '@clerk/astro', importer: pageFile },
    ]);
  });

  it('flags a resolved node_modules/@clerk/* path from outside the choke point', () => {
    const pageFile = join(repoRoot, 'src', 'pages', 'index.astro');
    const resolved = join(repoRoot, 'node_modules', '@clerk', 'astro', 'dist', 'index.js');
    const graph: ModuleGraph = new Map([[pageFile, new Set([resolved])]]);

    expect(checkClerkChokePoint(graph, authDir)).toEqual([
      { clerkModule: resolved, importer: pageFile },
    ]);
  });

  it('allows a @clerk/* import from inside the choke point', () => {
    const authModule = join(authDir, 'index.ts');
    const graph: ModuleGraph = new Map([[authModule, new Set(['@clerk/astro'])]]);

    expect(checkClerkChokePoint(graph, authDir)).toEqual([]);
  });
});
