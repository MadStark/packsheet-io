import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
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
 * Invariant A: no module outside src/lib/auth/ may import anything under
 * src/lib/auth/. Not "no anonymous route may transitively reach it" — an EDGE rule,
 * not a reachability rule, and the difference is the whole point. See the comment on
 * checkAnonymousReadPath below for why reachability is unsafe here, and for what has
 * to be solved before anyone relaxes this back to reachability.
 *
 * Invariant B: nothing under src/ outside src/lib/auth/ may import `@clerk/*`
 * directly, once Clerk is a dependency. This is what makes "single choke point" a
 * fact about the codebase rather than a naming convention: Invariant A only ever
 * proves that nothing imports *this particular* module, so without Invariant B a
 * second, unguarded path to Clerk could open up right next to it and Invariant A
 * would have nothing to say about it.
 *
 * A build-graph-based check that never finds anything is indistinguishable from a
 * broken one — this repo already has a documented case of that failure mode (see
 * the header comment on deploy-origin-lock.test.ts). Today nothing in the real site
 * imports auth, so Invariant A's real-repo assertion passes trivially and proves
 * nothing about the checker on its own. The self-test lower down in this file runs
 * the exact same functions against a fixture project that DOES violate the
 * invariant, in six different ways, and asserts each is caught with the right chain
 * and the right message.
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
 *   first pass would miss anything reachable only from client-hydrated code. The
 *   fixture has a Vue integration and two islands specifically so this union is
 *   exercised rather than merely asserted here in prose: against the fixture the
 *   three passes contain 0, 205 and 12 modules, and the `client:only` island's own
 *   import of auth is visible only in that third, 12-module pass.
 * - Page entry points are read off the build's own `virtual:astro:page:<route>@_@
 *   <ext>` modules rather than globbed from the filesystem, so the route list used
 *   here cannot drift from the routes the build actually produces. Under the
 *   edge-based rule they are no longer what the check is rooted at — they are used
 *   only to render a human-readable chain in a failure message.
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
 *  to catch. The fixture's `src/lib/lazy-auth.ts` reaches auth only through a
 *  dynamic import, so the branch is executed by a test rather than assumed. */
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

/** Breadth-first, so the reported chain is the shortest path to the target — the
 *  clearest one to hand to whoever has to go fix the import, not just the first one
 *  Map iteration order happened to produce. Returns the full chain, starting at
 *  `from`, or null if nothing reachable from `from` satisfies `isTarget`.
 *
 *  This is presentation only. Nothing about whether a violation is REPORTED depends
 *  on it — see checkAnonymousReadPath — because a walk rooted at a page entry
 *  cannot see a `client:only` island at all. */
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

/** The shortest chain from any page entry to `module`, or null if no page entry
 *  reaches it. Routes are visited in sorted order and ties are broken by that
 *  order, so the chain in a failure message is the same on every run rather than a
 *  function of Map insertion order. */
function findPageChain(build: BuildGraph, module: string): string[] | null {
  let best: string[] | null = null;
  for (const route of [...build.pageEntries.keys()].sort()) {
    const file = build.pageEntries.get(route)!;
    const chain = findChain(build.graph, file, (id) => id === module);
    if (chain && (best === null || chain.length < best.length)) best = chain;
  }
  return best;
}

function describeChain(root: string, chain: string[]): string {
  return chain.map((id) => relative(root, id) || id).join('\n    -> ');
}

/** Why a module with no page chain is still a violation, spelled out in the failure
 *  itself: whoever hits this needs to know that "but no page imports it" is not a
 *  defence, and needs the `client:only` mechanism explained rather than looked up. */
const NO_PAGE_CHAIN_EXPLANATION =
  'No page entry in the build graph imports this module. That is not evidence it is ' +
  'unused — it is the exact shape of a `client:only` island (the Astro compiler drops the ' +
  'component import from the emitted server module, so the island has no inbound edge from ' +
  'the page that renders it, while still shipping to every visitor of that page) and of ' +
  'middleware (which Astro loads as its own entry, ahead of every route). The module is in ' +
  'the build graph, so it ships.';

function violationMessage(
  root: string,
  importer: string,
  target: string,
  chain: string[] | null,
): string {
  const rel = (id: string) => relative(root, id) || id;
  const lines = [
    `${rel(importer)} imports the auth choke point (src/lib/auth/), which nothing outside that directory may do:`,
    `    ${describeChain(root, chain ?? [importer, target])}`,
    '',
  ];
  if (chain === null) lines.push(NO_PAGE_CHAIN_EXPLANATION, '');
  lines.push(COST_ARGUMENT);
  return lines.join('\n');
}

interface AuthImportViolation {
  /** The module outside src/lib/auth/ that imports into it. */
  importer: string;
  /** The module under src/lib/auth/ that it imports. */
  target: string;
  /** page -> ... -> importer -> target, when some page entry reaches `importer`;
   *  null when none does, which is the `client:only` island and the middleware
   *  case. A null chain is a readability limitation, never an acquittal. */
  chain: string[] | null;
  message: string;
}

/**
 * Invariant A, as a pure function over an already-built graph: does ANY module
 * outside `<root>/src/lib/auth/` have an import edge to a module inside it?
 *
 * This is deliberately an edge rule and not a reachability rule ("can an anonymous
 * route walk to auth?"), because reachability is unsound on an Astro build graph:
 *
 *   For a `client:only` island the compiler removes the component import from the
 *   emitted server module altogether. The island still appears in the build graph —
 *   it is in the client pass, it is bundled, it ships to every visitor of the page
 *   that renders it — but with NO inbound edge from any page. A walk rooted at page
 *   entries therefore never reaches it. `<UserButton client:only="vue" />` importing
 *   the choke point would ship the Clerk SDK to every anonymous reader with CI
 *   green. That is the precise failure this file exists to prevent, so the rule may
 *   not be rooted at pages. The fixture's client-only.astro is the regression test:
 *   it fails against a reachability formulation and passes against this one.
 *
 * The edge rule is sound for the same reason: the build graph contains only modules
 * that actually ship, so an edge into the choke point from anywhere in it is by
 * itself sufficient evidence that the choke point ships. It also covers middleware
 * in every spelling for free — `src/middleware.ts` and `src/middleware/index.ts` are
 * both just modules with an edge — where the previous formulation special-cased one
 * hardcoded path and missed the other. While nothing in this codebase is
 * authenticated, the edge rule is strictly stronger than reachability: every module
 * that reaches auth via a chain also has an edge somewhere along that chain.
 *
 * WHEN THE FIRST GENUINELY AUTHENTICATED ROUTE ARRIVES, THIS RULE MUST BE REVISITED.
 * At that point some module legitimately imports auth, and this check must learn to
 * distinguish it — which almost certainly means going back to a reachability rule
 * with a list of authenticated routes. Whoever does that inherits the `client:only`
 * attribution problem above and must solve it BEFORE relaxing the rule: a
 * reachability check needs an edge from a page to its `client:only` island, which is
 * not in the graph and has to be reconstructed some other way (the client-pass entry
 * chunks, or Astro's island manifest). The acceptance test for that work is not "the
 * suite still passes" — a reachability check passes this suite happily while blind to
 * client-only islands. It is a fixture like tests/fixtures/anon-read-path-violation
 * whose `client:only` island importing auth is still caught by the relaxed version.
 * Do not delete that fixture case; it is the only thing standing between this
 * guardrail and a $6,000/month invoice.
 *
 * `findChain` survives purely to render a readable `page -> ... -> auth` chain in the
 * failure message where one exists; where none does, the importing module is reported
 * directly and the message explains why that is the whole story.
 */
function checkAnonymousReadPath(build: BuildGraph, root: string): AuthImportViolation[] {
  const authDir = join(root, 'src', 'lib', 'auth') + sep;
  const isAuthModule = (id: string) => id.startsWith(authDir);
  const violations: AuthImportViolation[] = [];

  for (const [importer, targets] of build.graph) {
    if (isAuthModule(importer)) continue;
    for (const target of targets) {
      if (!isAuthModule(target)) continue;
      const pageChain = findPageChain(build, importer);
      const chain = pageChain ? [...pageChain, target] : null;
      violations.push({
        importer,
        target,
        chain,
        message: violationMessage(root, importer, target, chain),
      });
    }
  }

  // Sorted so a multi-violation failure reads the same on every run: Map iteration
  // order here is Rollup's module-discovery order, which is stable enough in
  // practice to lull you and unstable enough to produce a diff nobody can review.
  return violations.sort(
    (a, b) => a.importer.localeCompare(b.importer) || a.target.localeCompare(b.target),
  );
}

interface ClerkViolation {
  clerkModule: string;
  importer: string;
  message: string;
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

function clerkViolationMessage(root: string, importer: string, clerkModule: string): string {
  return [
    `${relative(root, importer) || importer} imports ${relative(root, clerkModule) || clerkModule} directly, bypassing the auth choke point:`,
    `    ${relative(root, importer) || importer}\n    -> ${relative(root, clerkModule) || clerkModule}`,
    '',
    'Only src/lib/auth/ may import @clerk/*. A second, unguarded path to the SDK next to ' +
      'the choke point is not caught by the choke point being clean, which is why this is a ' +
      'separate invariant.',
    '',
    COST_ARGUMENT,
  ].join('\n');
}

/**
 * Invariant B, as a pure function over an already-built graph: among FIRST-PARTY
 * modules — those under `<root>/src/` — every module that imports `@clerk/*` must
 * be inside `<root>/src/lib/auth/`.
 *
 * The first-party restriction is load-bearing, not tidiness. `@clerk/astro` imports
 * `@clerk/shared`, `@clerk/types` and `@clerk/backend`; every one of those intra-
 * Clerk edges has an importer under node_modules/@clerk/, which is not inside the
 * choke point. Without the restriction this function would report all of them and
 * the test would go red on `npm i @clerk/astro` — before a single line of
 * first-party auth code existed, with no way to make it green except by gutting the
 * check. (For scale: of the 1,917 modules in the real build's graph at the time of
 * writing, 1,885 are under node_modules.) The synthetic self-test below pins that a
 * node_modules-to-node_modules Clerk edge is NOT reported.
 *
 * Clerk is not a dependency of this project yet, so on the real repo this returns an
 * empty array today — but that is not the same thing as vacuous. The function is
 * exercised directly, without a real build, by the self-test below using a synthetic
 * graph containing `@clerk/*` ids. The day Clerk is added as a dependency, this same
 * function starts gating every first-party module under src/ in the real build too,
 * with no code change required here.
 */
function checkClerkChokePoint(graph: ModuleGraph, root: string): ClerkViolation[] {
  const srcDir = join(root, 'src') + sep;
  const authDir = join(root, 'src', 'lib', 'auth') + sep;
  const violations: ClerkViolation[] = [];

  for (const [importer, targets] of graph) {
    if (!importer.startsWith(srcDir)) continue;
    if (importer.startsWith(authDir)) continue;
    for (const target of targets) {
      if (isClerkModule(target)) {
        violations.push({
          clerkModule: target,
          importer,
          message: clerkViolationMessage(root, importer, target),
        });
      }
    }
  }

  return violations.sort(
    (a, b) => a.importer.localeCompare(b.importer) || a.clerkModule.localeCompare(b.clerkModule),
  );
}

// ---------------------------------------------------------------------------
// Invariant A & B — against the real site
// ---------------------------------------------------------------------------

describe('the real site', () => {
  let realBuild: BuildGraph;

  // One real `astro build` (~well under a second per the pre-implementation spike),
  // shared by both invariants below so the suite pays for it once, not twice.
  beforeAll(async () => {
    realBuild = await buildModuleGraph(repoRoot);
  }, 60_000);

  // Both invariants are anchored on the string "<root>/src/lib/auth/", and neither
  // would notice if that directory stopped existing: the edge check would match no
  // importer and no target, the Clerk check would exempt nobody, and all of it would
  // stay green forever while auth lived somewhere else entirely. Collapsing the
  // directory to src/lib/auth.ts, or renaming it to src/lib/session/ when Clerk
  // lands, are both one-line changes a reviewer would wave through. This test is
  // only meaningful while that directory is where auth lives, so that fact is
  // asserted rather than assumed. If this fails, do not delete it — update both
  // invariants to point at wherever the choke point moved to.
  it('the auth choke point directory exists where both invariants expect it', () => {
    expect(statSync(join(repoRoot, 'src', 'lib', 'auth')).isDirectory()).toBe(true);
  });

  it('nothing outside src/lib/auth/ imports the auth choke point', () => {
    const violations = checkAnonymousReadPath(realBuild, repoRoot);
    expect(violations.map((v) => v.message)).toEqual([]);
  });

  // Dormant rather than vacuous: see the comment on checkClerkChokePoint. This
  // assertion is real and will start catching real violations the day
  // `@clerk/...` lands in package.json — it just has nothing to find yet.
  it('no first-party module outside src/lib/auth/ imports @clerk/* (dormant: Clerk is not yet a dependency)', () => {
    const violations = checkClerkChokePoint(realBuild.graph, repoRoot);
    expect(violations.map((v) => v.message)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Self-test — proves the checker can actually fail
// ---------------------------------------------------------------------------

/** The six ways the fixture reaches auth, by importing module. Every one of them is
 *  a real edge in a real Astro build of tests/fixtures/anon-read-path-violation, not
 *  a synthetic graph. */
const FIXTURE_VIOLATING_IMPORTERS = [
  'src/components/AuthGate.astro',
  'src/components/ClientLoadAuth.vue',
  'src/components/ClientOnlyAuth.vue',
  'src/lib/lazy-auth.ts',
  'src/middleware/index.ts',
  'src/pages/direct.astro',
];

describe('the checker, run against a fixture that actually violates Invariant A', () => {
  let fixtureBuild: BuildGraph;
  const rel = (id: string) => relative(fixtureRoot, id);
  const find = (importer: string) =>
    checkAnonymousReadPath(fixtureBuild, fixtureRoot).find((v) => rel(v.importer) === importer);

  beforeAll(async () => {
    fixtureBuild = await buildModuleGraph(fixtureRoot);
  }, 60_000);

  it('flags the page that imports auth directly, with the real one-hop chain', () => {
    const direct = find('src/pages/direct.astro');

    expect(direct).toBeDefined();
    expect(direct!.chain?.map(rel)).toEqual(['src/pages/direct.astro', 'src/lib/auth/index.ts']);
    expect(direct!.message).toContain('src/pages/direct.astro');
    expect(direct!.message).toContain('$6,000');
    expect(direct!.message).toContain('$3,000-4,000');
    expect(direct!.message).toContain('$9/month');
  });

  // The claim this suite actually makes is transitive detection, not "can spot a
  // direct import" — a checker that only inspected each page's own import list would
  // pass the `direct` case and still miss every realistic violation, which arrives
  // through a shared component two or three hops away.
  it('flags the component that imports auth, with the full chain from the page that renders it', () => {
    const transitive = find('src/components/AuthGate.astro');

    expect(transitive).toBeDefined();
    expect(transitive!.chain?.map(rel)).toEqual([
      'src/pages/transitive.astro',
      'src/components/AuthGate.astro',
      'src/lib/auth/index.ts',
    ]);
  });

  /**
   * The regression test for the reason Invariant A is an edge rule.
   *
   * The first assertion is the important one, and it is deliberately an assertion
   * about the FIXTURE rather than about the checker: it pins that no page entry
   * reaches this island — i.e. that the Astro compiler really does drop a
   * `client:only` component's import from the server module. If a future Astro
   * version started emitting that edge, this assertion fails loudly and tells the
   * next reader that the hazard has changed shape, instead of the fixture quietly
   * ceasing to test anything while the case below kept passing for the wrong reason.
   *
   * A reachability-based checker was run against exactly this fixture and reported
   * only src/pages/direct and src/pages/transitive — the island's import of auth was
   * invisible to it.
   */
  it('flags the client:only island, which no page entry reaches at all', () => {
    const island = [...fixtureBuild.graph.keys()].find((id) =>
      id.endsWith(join('src', 'components', 'ClientOnlyAuth.vue')),
    );
    expect(island).toBeDefined();
    expect(findPageChain(fixtureBuild, island!)).toBeNull();

    const violation = find('src/components/ClientOnlyAuth.vue');
    expect(violation).toBeDefined();
    expect(violation!.chain).toBeNull();
    expect(rel(violation!.target)).toBe('src/lib/auth/index.ts');
    expect(violation!.message).toContain('`client:only` island');
    expect(violation!.message).toContain('$6,000');
  });

  it('flags the client:load island, with the chain through the page that hydrates it', () => {
    const island = find('src/components/ClientLoadAuth.vue');

    expect(island).toBeDefined();
    expect(island!.chain?.map(rel)).toEqual([
      'src/pages/client-load.astro',
      'src/components/ClientLoadAuth.vue',
      'src/lib/auth/index.ts',
    ]);
  });

  // Dynamic imports are recorded by Rollup in a different field from static ones
  // (`dynamicallyImportedIds`), so a graph collector that read only `importedIds`
  // would miss this while looking entirely correct.
  it('flags the module that reaches auth through a dynamic import()', () => {
    const lazy = find('src/lib/lazy-auth.ts');

    expect(lazy).toBeDefined();
    expect(lazy!.chain?.map(rel)).toEqual([
      'src/pages/dynamic.astro',
      'src/lib/lazy-auth.ts',
      'src/lib/auth/index.ts',
    ]);
  });

  // Middleware in the DIRECTORY form. Astro resolves middleware from either
  // src/middleware.{js,ts,mjs} or src/middleware/index.{js,ts,mjs}; the previous
  // formulation hardcoded the first spelling and was blind to this one, and no test
  // ever executed that branch in either spelling. The edge rule needs no path
  // knowledge, and this case executes it. Like the client:only island, middleware has
  // no page entry above it — Astro loads it as its own entry, ahead of every route.
  it('flags middleware written in the src/middleware/index.ts directory form', () => {
    const middleware = find('src/middleware/index.ts');

    expect(middleware).toBeDefined();
    expect(middleware!.chain).toBeNull();
    expect(rel(middleware!.target)).toBe('src/lib/auth/index.ts');
    expect(middleware!.message).toContain('$6,000');
  });

  // The other half of "not vacuous": a checker that reported every module as a
  // violation would also pass every assertion above.
  it('does not flag the page that never goes near auth', () => {
    const violations = checkAnonymousReadPath(fixtureBuild, fixtureRoot);
    expect(violations.some((v) => rel(v.importer) === 'src/pages/clean.astro')).toBe(false);
    expect(fixtureBuild.pageEntries.has('src/pages/clean')).toBe(true);
  });

  it('reports exactly those six importers, no more and no fewer', () => {
    const violations = checkAnonymousReadPath(fixtureBuild, fixtureRoot);
    expect(violations.map((v) => rel(v.importer))).toEqual(FIXTURE_VIOLATING_IMPORTERS);
  });
});

describe('checkClerkChokePoint, self-tested with a synthetic graph since @clerk is not installed', () => {
  // Real node_modules/@clerk/* packages don't exist in this repo yet, so the only
  // way to prove this function actually fires — rather than being dormant AND
  // untested — is to hand it a graph shaped the way a real one would be once
  // Clerk exists, without running a real build.
  const pageFile = join(repoRoot, 'src', 'pages', 'index.astro');

  it('flags a @clerk/* import from outside the choke point, with the cost argument', () => {
    const graph: ModuleGraph = new Map([[pageFile, new Set(['@clerk/astro'])]]);
    const violations = checkClerkChokePoint(graph, repoRoot);

    expect(violations.map((v) => ({ clerkModule: v.clerkModule, importer: v.importer }))).toEqual([
      { clerkModule: '@clerk/astro', importer: pageFile },
    ]);
    expect(violations[0].message).toContain('src/pages/index.astro');
    expect(violations[0].message).toContain('@clerk/astro');
    expect(violations[0].message).toContain('$6,000');
    expect(violations[0].message).toContain('$3,000-4,000');
    expect(violations[0].message).toContain('$9/month');
  });

  it('flags a resolved node_modules/@clerk/* path from outside the choke point', () => {
    const resolved = join(repoRoot, 'node_modules', '@clerk', 'astro', 'dist', 'index.js');
    const graph: ModuleGraph = new Map([[pageFile, new Set([resolved])]]);

    expect(
      checkClerkChokePoint(graph, repoRoot).map((v) => ({
        clerkModule: v.clerkModule,
        importer: v.importer,
      })),
    ).toEqual([{ clerkModule: resolved, importer: pageFile }]);
  });

  it('allows a @clerk/* import from inside the choke point', () => {
    const authModule = join(repoRoot, 'src', 'lib', 'auth', 'index.ts');
    const graph: ModuleGraph = new Map([[authModule, new Set(['@clerk/astro'])]]);

    expect(checkClerkChokePoint(graph, repoRoot)).toEqual([]);
  });

  // Clerk's own packages import each other. Every one of those edges has an importer
  // under node_modules/@clerk/, outside the choke point, so a check that looked at
  // every importer in the graph would report all of them the day `npm i @clerk/astro`
  // lands — before any first-party auth code exists, and with no way to go green
  // except by deleting the check. This is the assertion that keeps that from
  // happening.
  it('does not flag Clerk packages importing each other inside node_modules', () => {
    const clerkAstro = join(repoRoot, 'node_modules', '@clerk', 'astro', 'dist', 'index.js');
    const graph: ModuleGraph = new Map([
      [clerkAstro, new Set(['@clerk/shared', '@clerk/types', '@clerk/backend'])],
    ]);

    expect(checkClerkChokePoint(graph, repoRoot)).toEqual([]);
  });
});
