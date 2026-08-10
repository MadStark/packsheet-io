import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, sep, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import type { build as AstroBuild } from 'astro';

/**
 * Two things must never be reachable from the anonymous read path: an auth SDK that
 * bills per user, and the database key that turns row-level security off.
 *
 * The first is a cost problem. Auth providers price by monthly active user, not by
 * request or by compute — and this site's traffic is the opposite of what that pricing
 * assumes. Most visitors are strangers opening a shared pack list from a Reddit link;
 * they never sign in. If Clerk were invoked on that path, every one of those anonymous
 * reads counts as a MAU. At 250k monthly users that is roughly $6,000/month on Microsoft
 * Entra External ID, or $3,000-4,000/month on Clerk, against a compute bill of about
 * $9/month for serving the same traffic as static pages. One accidental import is the
 * entire gap between those numbers, and nothing about a stray `import { x } from
 * '@clerk/...'` looks dangerous in a code review — it type-checks, it builds, the page
 * still renders. The cost only shows up on an invoice, weeks later, from a provider that
 * cannot be un-billed retroactively.
 *
 * The second is an authorization problem, and it is sharper. Anonymous reads go through
 * Supabase with the publishable `anon` key, which is public by design and confined by
 * row-level security to the rows meant to be public. `SUPABASE_SERVICE_ROLE_KEY` bypasses
 * RLS entirely. It is not a stronger key; it is the absence of the authorization
 * boundary. Reachable from a route an anonymous visitor can load, it makes every RLS
 * policy in the database decorative — the database stops being the thing that says no,
 * and the code has to remember again, on every query, forever.
 *
 * So this file enforces three invariants at build time, by building the real site and
 * inspecting the actual Rollup module graph Astro produces — not by grep, which cannot
 * see through a re-export or an aliased import, and not by convention, which relies on
 * every future PR author having read this comment.
 *
 * Invariant A: no module outside src/lib/auth/ may import anything under
 * src/lib/auth/. Not "no anonymous route may transitively reach it" — an EDGE rule,
 * not a reachability rule, and the difference is the whole point. See the comment on
 * checkAnonymousReadPath below for why reachability is unsafe here, and for what has
 * to be solved before anyone relaxes this back to reachability.
 *
 * Invariant B: NO module in the build graph outside src/lib/auth/ may import
 * `@clerk/*`, with one exemption — Clerk's own packages importing each other. This is
 * what makes "single choke point" a fact about the codebase rather than a naming
 * convention: Invariant A only ever proves that nothing imports *this particular*
 * module, so without Invariant B a second, unguarded path to Clerk could open up right
 * next to it and Invariant A would have nothing to say about it. Note "no module",
 * not "no module under src/": the documented way to install Clerk adds no first-party
 * file at all, and scoping this to first-party importers exempts precisely it. See
 * checkClerkChokePoint.
 *
 * Invariant C: NO module in the build graph outside src/lib/auth/ may reference the
 * identifier `SUPABASE_SERVICE_ROLE_KEY`. This is not Invariant B with the package name
 * swapped, and reading it that way would break the site. `@supabase/supabase-js` with the
 * `anon` key BELONGS on the anonymous read path — it is how anonymous reads happen at
 * all — so the package cannot be what is banned. The rule is about the KEY. It is scoped
 * to the whole graph for the same reason Invariant B is, and that scoping is affordable
 * because it was measured rather than hoped: neither @supabase/supabase-js@2.112.2 nor
 * @supabase/ssr@0.12.4 contains the string SERVICE_ROLE anywhere, so this does not go red
 * on contact when those land (Ref 49). See checkServiceRoleKey.
 *
 * A module graph tells you what SHIPS; it cannot tell you what a module says. So
 * Invariant C needs source text, correlated with graph membership: the graph recorder
 * below also carries a `transform` hook, so every module the build actually processed is
 * scanned, and only modules that are in the graph are ever checked. Text is also where
 * its limits come from, and they are worth stating before the code implies otherwise:
 *
 *   - A name assembled at runtime is invisible. `env[SEGMENTS.join('_')]` is not the
 *     identifier and never will be to a scanner; the fixture's src/lib/runtime-named-key.ts
 *     pins that as the documented boundary rather than leaving it to be discovered.
 *     (`env['SUPABASE_' + 'SERVICE_ROLE_KEY']` is a different case and IS caught — esbuild
 *     folds adjacent string literals during transform, so the scan sees the whole name.)
 *   - A module with no file on disk that the transform hook never saw is a module this
 *     check has no text for at all. Anything backed by a file is scanned from the file
 *     regardless, so that gap is narrow, but it is not empty.
 *   - A comment counts. The check cannot tell code from a comment or from a string, so a
 *     comment naming the variable fails exactly as an assignment does — describe the key
 *     instead of naming it. Deliberate: stripping comments means depending on a parser
 *     being correct, and this guardrail has to stay simpler than the thing it guards.
 *
 * What none of the three invariants can see, stated plainly because the rest of this file
 * invites the assumption that it is airtight: a module graph contains only what the
 * bundler resolved. `<script is:inline src="https://js.clerk.com/...">` in a .astro file,
 * or a vendored SDK dropped into public/, produce ZERO graph edges — and Clerk ships a
 * browser bundle meant to be used exactly that way. That is a real boundary of any
 * build-graph check, not a defect in this one. It is covered here by a separate,
 * independent assertion that scans the HTML the build actually emitted for known auth
 * CDN hosts (checkEmittedHtmlForAuthCdn), and the fixture's cdn-script.astro pins both
 * halves of the boundary: invisible to the graph, caught by the HTML scan. Still
 * uncovered, deliberately: an SDK vendored into public/ and loaded by a same-origin
 * script tag, and any URL assembled at runtime. Closing those needs a different tool —
 * a script-src/connect-src CSP enforced at the edge — not a longer regex here.
 *
 * A build-graph-based check that never finds anything is indistinguishable from a
 * broken one — this repo already has a documented case of that failure mode (see
 * the header comment on deploy-origin-lock.test.ts). Today nothing in the real site
 * imports auth, so Invariant A's real-repo assertion passes trivially and proves
 * nothing about the checker on its own. Two things answer that. The self-test lower
 * down in this file runs the exact same functions against a fixture project that DOES
 * violate the invariants, in eight ways for Invariant A and three more for Invariant C,
 * and asserts each is caught with the right chain, the right lines and the right message.
 * And the real-site block opens with a tripwire asserting its graph is genuinely
 * populated and its transform hook genuinely fired, because every other assertion there
 * is "this derived list is empty" — which an empty graph, and a transform hook that
 * silently stopped running, satisfy just as well as a clean site does.
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
 *   three passes contain 0, 218 and 13 modules, and the `client:only` island's own
 *   import of auth is visible only in that third, 13-module pass.
 * - Page entry points are read off the build's own `virtual:astro:page:<route>@_@
 *   <ext>` modules rather than globbed from the filesystem, so the route list used
 *   here cannot drift from the routes the build actually produces. Under the
 *   edge-based rule they are no longer what the check is rooted at — they are used
 *   only to render a human-readable chain in a failure message.
 * - The `transform` hook Invariant C rides on fires once per module PER PASS, so the
 *   same module is scanned two or three times in one build; its records are deduped by
 *   line and snippet, or a failure message would repeat itself two or three times over.
 *   The code it is handed is also not the file on disk — it is what the plugin chain
 *   produced, with comments stripped and, for a .astro file, the frontmatter relocated,
 *   so its line numbers do not correspond to the file's. Measured against the fixture: a
 *   reference on line 11 of a page is reported at line 3 of the transformed module. That
 *   is why checkServiceRoleKey prefers the file's own text when there is a file; see
 *   there.
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

/** One place a module names the service-role key: which line, and the line itself so a
 *  failure message can show the reader what it found rather than only where. */
interface ServiceRoleRef {
  line: number;
  snippet: string;
}

interface BuildGraph {
  graph: ModuleGraph;
  /** route name (e.g. "src/pages/index") -> absolute path of the real page file it
   *  resolves to, read directly off the build's virtual:astro:page:* entries. */
  pageEntries: Map<string, string>;
  /** outDir-relative path -> contents, for every .html the build emitted. Captured
   *  because the module graph cannot see a `<script src="https://...">`; see
   *  checkEmittedHtmlForAuthCdn and the header comment. */
  emittedHtml: Map<string, string>;
  /** module id -> every line of it that names SUPABASE_SERVICE_ROLE_KEY, as the
   *  `transform` hook saw the module. Deduped across passes. Empty for a module the
   *  hook saw and found clean AND for one it never saw — which is why `transformedIds`
   *  exists next to it. */
  serviceRoleRefs: Map<string, ServiceRoleRef[]>;
  /** Every id the `transform` hook was called for, in any pass. The evidence that the
   *  hook fired at all: without it, a hook that silently stopped running would leave
   *  `serviceRoleRefs` empty, and "no module references the key" would be trivially,
   *  permanently true. The real-site tripwire asserts this is non-empty for exactly
   *  that reason. */
  transformedIds: Set<string>;
}

/** Module ids sometimes carry a query suffix (e.g. a font imported as `...woff2?
 *  url`) that is part of how Vite tags the import, not part of the module's
 *  identity for graph-walking purposes. Stripped so the same file is recognised as
 *  the same node regardless of which query string a given import used. */
function stripQuery(id: string): string {
  const i = id.indexOf('?');
  return i === -1 ? id : id.slice(0, i);
}

/** The identifier Invariant C bans, word-bounded so `MY_SUPABASE_SERVICE_ROLE_KEY_NAME`
 *  is not a match and `SUPABASE_SERVICE_ROLE_KEY` inside `env.SUPABASE_SERVICE_ROLE_KEY`
 *  or `{ SUPABASE_SERVICE_ROLE_KEY }` is. */
const SERVICE_ROLE_KEY_RE = /\bSUPABASE_SERVICE_ROLE_KEY\b/g;

/** Longest snippet a failure message will print for one line. A bundled dependency can
 *  be one line of several hundred kilobytes, and a guardrail whose failure output has to
 *  be scrolled past is one people stop reading. */
const SNIPPET_LIMIT = 120;

/** Every line of `code` that names the key, one ref per line however many times it
 *  appears there. `String.prototype.match` resets a global regex's `lastIndex`, so the
 *  shared SERVICE_ROLE_KEY_RE carries no state between calls — `RegExp.test` would. */
function scanForServiceRoleKey(code: string): ServiceRoleRef[] {
  const refs: ServiceRoleRef[] = [];
  code.split('\n').forEach((line, index) => {
    if (line.match(SERVICE_ROLE_KEY_RE) === null) return;
    const trimmed = line.trim();
    refs.push({
      line: index + 1,
      snippet: trimmed.length > SNIPPET_LIMIT ? `${trimmed.slice(0, SNIPPET_LIMIT)}…` : trimmed,
    });
  });
  return refs;
}

/** The file's own text, or null when the id is not a readable file — a virtual module, a
 *  bare specifier a pass left unresolved, or a directory-shaped id. `throwIfNoEntry:
 *  false` rather than a try/catch so a genuine read failure on something that IS a file
 *  still throws instead of being quietly scanned as empty. */
function readFileForId(id: string): string | null {
  if (hasNoFileOnDisk(id)) return null;
  if (statSync(id, { throwIfNoEntry: false })?.isFile() !== true) return null;
  return readFileSync(id, 'utf8');
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
  // Inside `root`, NOT in tmpdir(). @astrojs/cloudflare prerenders static pages in
  // workerd, and workerd cannot reach a path outside the project it was given: an
  // outDir under /var/folders fails the build with "The Workers runtime failed to
  // start … internal error", which reads as a broken toolchain rather than as a
  // misplaced directory. Still a fresh directory per build, still removed in the
  // `finally` below, so the property that matters — no build output left behind, and
  // in particular dist/ never clobbered — is unchanged.
  const outDir = mkdtempSync(join(root, '.astro-build-out-'));
  const passGraphs: PassGraph[] = [];
  const serviceRoleRefs = new Map<string, ServiceRoleRef[]>();
  const transformedIds = new Set<string>();

  // A minimal Rollup plugin: it changes nothing. It reads the graph Rollup has already
  // built and hands it to buildEnd once per pass, and it reads — without rewriting — the
  // text of every module the build processes, because the graph alone says what ships
  // and never says what a module contains.
  function graphRecorderPlugin() {
    return {
      name: 'anon-read-path-graph-recorder',

      // Returning null leaves the module exactly as the previous plugin left it; this
      // hook is here to observe, and a `transform` that returned a value would put this
      // test file in the build's own critical path.
      //
      // Fires once per module per Rollup pass, so the same id arrives two or three times
      // in one build with identical findings — deduped by line and snippet so a failure
      // message names each line once.
      transform(code: string, id: string): null {
        const file = stripQuery(id);
        transformedIds.add(file);
        const found = scanForServiceRoleKey(code);
        if (found.length === 0) return null;
        const refs = serviceRoleRefs.get(file) ?? [];
        for (const ref of found) {
          if (refs.some((seen) => seen.line === ref.line && seen.snippet === ref.snippet)) continue;
          refs.push(ref);
        }
        serviceRoleRefs.set(file, refs);
        return null;
      },

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

  let emittedHtml: Map<string, string>;
  try {
    await build({
      root,
      outDir,
      logLevel: 'error',
      vite: { plugins: [graphRecorderPlugin()] },
    });
    // Read the emitted HTML into memory while it still exists — the `finally` below
    // deletes it, and the CDN-script check downstream has no other way to see it.
    emittedHtml = readEmittedHtml(outDir);
  } finally {
    // Point every build at a throwaway directory and remove it unconditionally, so a
    // failed build still leaves no BUILD OUTPUT behind in the repo or the fixture.
    // It is not the only artifact a build produces, and the comment used to claim it
    // was: astro also writes its generated-types cache into the project it builds,
    // .astro/ in the repo root and one in the fixture. Both are gitignored (and the
    // fixture's is why eslint.config.mjs ignores `**/.astro/**` rather than
    // `.astro/**`), but neither is removed here.
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

  return { graph, pageEntries, emittedHtml, serviceRoleRefs, transformedIds };
}

/** Every .html file under `outDir`, keyed by its path relative to it. Astro's default
 *  `format: 'directory'` means a route lands at `<route>/index.html`, and anything
 *  copied verbatim out of public/ lands wherever it was placed — both are picked up by
 *  the recursive walk, which is the point: this is deliberately looking at shipped
 *  bytes rather than at anything the bundler modelled. */
function readEmittedHtml(outDir: string): Map<string, string> {
  const html = new Map<string, string>();
  for (const entry of readdirSync(outDir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.html')) continue;
    const file = join(entry.parentPath, entry.name);
    html.set(relative(outDir, file), readFileSync(file, 'utf8'));
  }
  return html;
}

/** Breadth-first, so the reported chain is A shortest path to the target — the
 *  clearest kind to hand to whoever has to go fix the import, not just the first one
 *  Map iteration order happened to produce. Returns the full chain, starting at
 *  `from`, or null if nothing reachable from `from` satisfies `isTarget`.
 *
 *  What BFS guarantees is the LENGTH, not the identity. Neighbours come out of a Set
 *  in Rollup's module-discovery order, so where two paths of equal length exist the
 *  one rendered is whichever Rollup happened to find first, and that is not something
 *  this file pins. Every chain asserted on below is a case where the shortest path
 *  from the chosen route is unique, which is what makes those assertions stable; a
 *  future fixture case with two shortest paths from one page should assert on the
 *  chain's length or endpoints rather than on the whole chain.
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
 *  reaches it. Routes are visited in sorted order and a tie never displaces the
 *  incumbent, so which ROUTE a failure message blames is the same on every run rather
 *  than a function of Map insertion order. (Which path *within* that route gets
 *  rendered carries findChain's weaker guarantee — see there.) Three fixture pages
 *  reach AuthGate.astro, one of them through an extra hop, so both halves of this —
 *  preferring the shorter chain, and breaking a tie by sorted route — run against a
 *  real build rather than being merely intended.
 *
 *  The sort itself needs a synthetic graph to pin, and has one below. Rollup's
 *  page-discovery order for the fixture is not alphabetical, but it does happen to
 *  visit the two tied pages in the same relative order the sort does, so deleting
 *  `.sort()` leaves the fixture's result unchanged today — and leaves it at the mercy
 *  of a discovery order nothing here controls tomorrow, which is the whole reason the
 *  sort exists. Only a graph whose insertion order deliberately disagrees with its
 *  sorted order can show that, so that is what the unit test hands it. */
function findPageChain(build: BuildGraph, module: string): string[] | null {
  let best: string[] | null = null;
  for (const route of [...build.pageEntries.keys()].sort()) {
    const file = build.pageEntries.get(route)!;
    const chain = findChain(build.graph, file, (id) => id === module);
    if (chain && (best === null || chain.length < best.length)) best = chain;
  }
  return best;
}

/** Not every id in the graph is a filesystem path. `\0virtual:astro:middleware` and
 *  bare specifiers like `@clerk/astro/integration-middleware` are modules with no file
 *  on disk, and `relative()` would resolve them against the process CWD and render them
 *  as a `../../..` path pointing at nothing — in exactly the failure message where the
 *  reader most needs to recognise the id for what it is. Those are printed as-is, and
 *  only real absolute paths are relativised.
 *
 *  The leading `\0` is Rollup's marker for a module with no file (the same convention
 *  PAGE_ENTRY_RE strips); it is not part of the name, and a raw NUL in a terminal
 *  renders as nothing or as a stray blank, which makes a failure message look
 *  mis-indented rather than informative. Stripped for display only — never for
 *  matching, where the id has to stay exactly what the graph keys on. */
function stripVirtualMarker(id: string): string {
  return id.startsWith('\0') ? id.slice(1) : id;
}

function renderId(root: string, id: string): string {
  const bare = stripVirtualMarker(id);
  if (!isAbsolute(bare)) return bare;
  return relative(root, bare) || bare;
}

/** True for an id with no file behind it: a virtual module, or a bare specifier a pass
 *  left unresolved. Both mean "there is nothing here to open in an editor", which is
 *  what a failure message has to say out loud. */
function hasNoFileOnDisk(id: string): boolean {
  return !isAbsolute(stripVirtualMarker(id));
}

function describeChain(root: string, chain: string[]): string {
  return chain.map((id) => renderId(root, id)).join('\n    -> ');
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
  const rel = (id: string) => renderId(root, id);
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
 *  through unnoticed. The optional leading `\0` is Rollup's no-file marker, which any
 *  plugin resolving a `@clerk/*` specifier to a virtual module would add; matching it
 *  matters on both sides of this function, since it decides what counts as a violation
 *  AND what counts as one of Clerk's own internal edges. */
function isClerkModule(id: string): boolean {
  return /^\0?@clerk\//.test(id) || /(^|\/)node_modules\/@clerk\//.test(id);
}

/** The importer with no file behind it is the case whoever hits this is least equipped
 *  to act on: there is nothing to open in an editor, and the natural next move — grep
 *  src/ for "clerk" — finds nothing and looks like the check is wrong. Name the
 *  mechanism and the file to actually edit. */
const VIRTUAL_IMPORTER_EXPLANATION =
  'That importer is not a file in this repository — it is a module the build generates. ' +
  'The usual way one comes to import @clerk/* is an Astro integration injecting middleware ' +
  '(`npx astro add @clerk/astro` does exactly this, via addMiddleware({ entrypoint: ' +
  "'@clerk/astro/...' })), which wires the SDK in without touching a single file under src/. " +
  'The fix is in astro.config.mjs, not in src/: drop the integration, and reach Clerk through ' +
  'src/lib/auth/ from the routes that genuinely need it.';

function clerkViolationMessage(root: string, importer: string, clerkModule: string): string {
  const rel = (id: string) => renderId(root, id);
  const lines = [
    `${rel(importer)} imports ${rel(clerkModule)} directly, bypassing the auth choke point:`,
    `    ${rel(importer)}\n    -> ${rel(clerkModule)}`,
    '',
  ];
  if (hasNoFileOnDisk(importer)) lines.push(VIRTUAL_IMPORTER_EXPLANATION, '');
  lines.push(
    'Only src/lib/auth/ may import @clerk/*. A second, unguarded path to the SDK next to ' +
      'the choke point is not caught by the choke point being clean, which is why this is a ' +
      'separate invariant.',
    '',
    COST_ARGUMENT,
  );
  return lines.join('\n');
}

/**
 * Invariant B, as a pure function over an already-built graph: EVERY module in the
 * graph that imports `@clerk/*` must be inside `<root>/src/lib/auth/`. The one
 * exemption is Clerk's own packages importing each other.
 *
 * The scoping is the load-bearing part of this function, and the intuitive scoping is
 * wrong. Restricting it to first-party importers — those under `<root>/src/` — reads
 * as the conservative, low-false-positive choice, and it structurally exempts the most
 * likely way Clerk ever actually arrives here. `npx astro add @clerk/astro`, the
 * documented installation, edits astro.config.mjs and lets the integration inject its
 * own middleware with `addMiddleware({ entrypoint: '@clerk/astro/...' })`. No file
 * under src/ is involved at any point, so Invariant A never fires (nothing imports the
 * choke point) and a first-party-scoped Invariant B never fires either: the documented
 * install walks through both guards untouched, and the first evidence is the invoice.
 * Verified against a stub integration — the real build's graph then holds exactly one
 * Clerk edge, `virtual:astro:middleware -> @clerk/astro/integration-middleware`, whose
 * importer is a virtual module rather than a file. It is caught now.
 *
 * So the rule is inverted: consider every importer, and exempt only Clerk's own
 * internal edges — which is the false positive the first-party scoping was really
 * reaching for. `@clerk/astro` imports `@clerk/shared`, `@clerk/types` and
 * `@clerk/backend`; every one of those edges has an importer outside the choke point,
 * and reporting them would turn `npm i @clerk/astro` red on contact — before a line of
 * first-party auth code existed, with no way to go green except by gutting the check.
 * (For scale: of the 1,917 modules in the real build's graph at the time of writing,
 * 1,885 are under node_modules.)
 *
 * Exempting them costs nothing, and that is provable rather than hopeful: Clerk cannot
 * import itself into a build out of nowhere. Some non-Clerk module — a first-party
 * file, a virtual module, a third-party package — must hold the edge that first pulls a
 * Clerk module in, and that boundary edge is precisely what this reports. Waiving the
 * interior of the subgraph never waives its entrance.
 *
 * A NON-Clerk package under node_modules importing `@clerk/*` is therefore reported,
 * deliberately and not as an accident of the phrasing. A dependency that drags the SDK
 * in ships it to every anonymous reader exactly as a first-party import would, and the
 * fact that nobody here wrote that import makes it harder to notice, not cheaper. If
 * such a dependency ever turns out to be legitimate, exempt that package by name and
 * say why here — do not widen the rule back to first-party-only.
 *
 * Clerk is not a dependency of this project yet, so on the real repo this returns an
 * empty array today — but that is not the same thing as vacuous. The function is
 * exercised directly, without a real build, by the self-test below using synthetic
 * graphs containing `@clerk/*` ids in each of the shapes a real graph produces. The day
 * Clerk is added as a dependency — by any route, including one that touches no
 * first-party file — this same function starts gating the real build with no code
 * change required here.
 */
function checkClerkChokePoint(graph: ModuleGraph, root: string): ClerkViolation[] {
  const authDir = join(root, 'src', 'lib', 'auth') + sep;
  const violations: ClerkViolation[] = [];

  for (const [importer, targets] of graph) {
    if (importer.startsWith(authDir)) continue;
    // Clerk's own internals, in either shape isClerkModule recognises: a resolved
    // node_modules/@clerk/... path, or the bare `@clerk/...` specifier a pass that
    // left it external produces.
    if (isClerkModule(importer)) continue;
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

interface ServiceRoleViolation {
  /** The module outside src/lib/auth/ that names the key. */
  module: string;
  /** Every line of it that does, in file order. */
  refs: ServiceRoleRef[];
  message: string;
}

/** The consequence, in the words that make it act-on-able. Deliberately NOT "could allow
 *  unauthorised access": that phrasing is vague enough to argue with ("nobody knows the
 *  URL", "it's only on an admin page"), and an argument is what gets a check deleted to go
 *  green. What is true is narrower and harder to dismiss. */
const SERVICE_ROLE_ARGUMENT =
  'RLS bypassed. `service_role` bypasses row-level security ENTIRELY — it is not a stronger ' +
  'key, it is the absence of the authorization boundary. Reachable from a route an anonymous ' +
  'visitor can load, every RLS policy in this database becomes decorative: the database stops ' +
  'being the thing that says no, and the code has to remember again, on every query, forever. ' +
  'Nothing about that shows up in the rendered page.';

/** The half of the rule a reader will get wrong if only the ban is stated. Somebody who
 *  concludes "Supabase is not allowed here" will go and remove the thing that makes the
 *  anonymous read path work at all. */
const ANON_KEY_IS_THE_RIGHT_KEY =
  'This is a rule about the KEY, not about Supabase. `@supabase/supabase-js` with the ' +
  'publishable `anon` key belongs on this path — it is how anonymous reads happen at all. ' +
  'That key is public by design, safe to ship in a browser bundle, and confined by RLS to ' +
  'the rows that are meant to be public. PUBLIC_SUPABASE_ANON_KEY is the correct key here and ' +
  'this check has nothing to say about it.';

const REACH_IT_THROUGH_THE_CHOKE_POINT =
  'If something genuinely needs the privileged key, it belongs behind src/lib/auth/ — the one ' +
  'directory this rule exempts, and where a service-role client would live — and is reached ' +
  'from there rather than read here.';

/** Said in the failure itself because the alternative is somebody spending an afternoon
 *  concluding the check is broken. See the header comment for why it is not worth fixing. */
const A_COMMENT_IS_A_REFERENCE =
  'This check reads text and cannot tell code from a comment or from a string literal, so a ' +
  'comment that spells the variable out fails exactly as an assignment does. Describe the key ' +
  'instead of naming it. That is a deliberate choice rather than an oversight: not counting ' +
  'comments means depending on a parser being correct, and this guardrail has to stay simpler ' +
  'than the thing it guards.';

/** The module with no file behind it, again the case whoever hits this is least equipped to
 *  act on — and here it is worse than for Invariant B, because the message carries a line
 *  number that points into text that exists nowhere on disk. */
const GENERATED_MODULE_EXPLANATION =
  'That module is not a file in this repository — it is one the build generates, so the line ' +
  'number above refers to the generated text and there is nothing to open at it. Grepping ' +
  'src/ will find nothing. Look at what injects that module (astro.config.mjs and the ' +
  'integrations it lists are the usual source) rather than for a file.';

function serviceRoleViolationMessage(root: string, module: string, refs: ServiceRoleRef[]): string {
  const rel = renderId(root, module);
  const lines = [
    `${rel} references SUPABASE_SERVICE_ROLE_KEY, which no module outside src/lib/auth/ may do:`,
    ...refs.map((ref) => `    ${rel}:${ref.line}\n        ${ref.snippet}`),
    '',
  ];
  if (hasNoFileOnDisk(module)) lines.push(GENERATED_MODULE_EXPLANATION, '');
  lines.push(
    SERVICE_ROLE_ARGUMENT,
    '',
    ANON_KEY_IS_THE_RIGHT_KEY,
    '',
    REACH_IT_THROUGH_THE_CHOKE_POINT,
    '',
    A_COMMENT_IS_A_REFERENCE,
  );
  return lines.join('\n');
}

/**
 * Invariant C, as a pure function over an already-built graph: no module in the graph
 * outside `<root>/src/lib/auth/` may reference the identifier SUPABASE_SERVICE_ROLE_KEY.
 *
 * The graph is what makes this different from `grep -r SUPABASE_SERVICE_ROLE_KEY src/`.
 * Grep answers "does this string appear in the working tree", which is both too wide (a
 * script under scripts/, a doc, a deleted-but-not-removed file) and too narrow (it never
 * looks at the dependency that ships alongside your code). Iterating the graph answers
 * the question that matters — does anything that SHIPS name this key — and it is the same
 * union of the three Rollup passes both other invariants use, so a module that only the
 * client pass resolves is in scope here too.
 *
 * The scoping is the whole graph rather than first-party src/, for Invariant B's reason
 * restated: a dependency holding the key ships it exactly as first-party code would, and
 * the fact that nobody here wrote the line makes it harder to notice, not cheaper. That is
 * only affordable because it was measured — neither @supabase/supabase-js@2.112.2 nor
 * @supabase/ssr@0.12.4 contains the string SERVICE_ROLE anywhere, so adding them (Ref 49)
 * does not turn this red on contact and force somebody to gut it. If a future dependency
 * legitimately names the key, exempt that package by name and say why here; do not narrow
 * the rule to src/.
 *
 * Where the text comes from, and why it is not simply the transform record:
 *
 *   The `transform` hook is what proves a module was processed by this build, and it is
 *   the only source of text for a module with no file on disk. But the code it is handed
 *   is the plugin chain's output, not the file — comments are stripped and a .astro
 *   file's frontmatter is relocated, so its line numbers are not the file's. Measured
 *   against the fixture: a reference on line 11 of a page is reported at line 3. A
 *   failure message that points at the wrong line is worse than one that points at none,
 *   because the reader trusts it and goes looking. So when the id is backed by a file,
 *   the file's own text is what gets scanned and reported.
 *
 *   That also subsumes the case where the hook never ran for a module — an externalised
 *   or otherwise untransformed one. Its transform record is empty, which is
 *   indistinguishable from "scanned and clean", and the file scan is what keeps that from
 *   being a silent gap. What remains uncovered is a module with no file on disk that was
 *   never transformed: there is no text for it anywhere. `transformedIds` is what makes
 *   that set observable rather than imaginary.
 *
 *   The two sources are a union for DETECTION and a preference for DISPLAY: a module is
 *   reported if either found something, and the file's lines are shown when the file has
 *   any. A reference present only in the transformed text — an inlined define, a
 *   generated wrapper — is still reported, with the caveat spelled out in the message.
 */
function checkServiceRoleKey(build: BuildGraph, root: string): ServiceRoleViolation[] {
  const authDir = join(root, 'src', 'lib', 'auth') + sep;
  const violations: ServiceRoleViolation[] = [];

  for (const id of build.graph.keys()) {
    if (id.startsWith(authDir)) continue;

    const fileText = readFileForId(id);
    const onDisk = fileText === null ? [] : scanForServiceRoleKey(fileText);
    const refs = onDisk.length > 0 ? onDisk : (build.serviceRoleRefs.get(id) ?? []);
    if (refs.length === 0) continue;

    violations.push({ module: id, refs, message: serviceRoleViolationMessage(root, id, refs) });
  }

  // Sorted for the same reason the other two checkers sort: Map iteration order here is
  // Rollup's module-discovery order, stable enough in practice to lull you and unstable
  // enough to produce a diff nobody can review.
  return violations.sort((a, b) => a.module.localeCompare(b.module));
}

interface CdnScriptViolation {
  /** outDir-relative path of the emitted HTML file. */
  file: string;
  /** The matched URL, so the failure names the thing to delete. */
  url: string;
}

/** Auth SDKs served as a plain browser bundle, by host. Anchored on the host rather
 *  than on the word "clerk" anywhere in the document: a pack list could legitimately
 *  mention Clerk in prose, and a check that goes red on page copy is a check somebody
 *  deletes. Add a host here if another provider is ever evaluated. */
const AUTH_CDN_URL = /https?:\/\/[^"'\s>]*\bclerk\.(?:com|dev|io|accounts\.dev)\b[^"'\s>]*/gi;

/**
 * The complement to the two graph invariants, and the reason the header comment can
 * state a boundary instead of quietly having one.
 *
 * `<script is:inline src="https://js.clerk.com/...">` and anything vendored into
 * public/ never enter the module graph — there is no import for a bundler to resolve —
 * so both invariants above are structurally blind to them, and Clerk publishes a
 * browser bundle designed to be loaded exactly that way. This looks at what the build
 * actually wrote to disk instead of at what it modelled, which is a different kind of
 * evidence and fails for a different reason. The fixture's cdn-script.astro is caught
 * here and by nothing else in this file.
 */
function checkEmittedHtmlForAuthCdn(build: BuildGraph): CdnScriptViolation[] {
  const violations: CdnScriptViolation[] = [];
  for (const [file, contents] of build.emittedHtml) {
    for (const match of contents.matchAll(AUTH_CDN_URL)) {
      violations.push({ file, url: match[0] });
    }
  }
  return violations.sort((a, b) => a.file.localeCompare(b.file) || a.url.localeCompare(b.url));
}

// ---------------------------------------------------------------------------
// Invariant A & B — against the real site
// ---------------------------------------------------------------------------

describe('the real site', () => {
  let realBuild: BuildGraph;
  let buildFailure: unknown;

  // One real `astro build` (~well under a second per the pre-implementation spike),
  // shared by both invariants below so the suite pays for it once, not twice.
  //
  // The failure is CAPTURED rather than allowed to propagate, because a throwing
  // beforeAll makes vitest report every test in this describe as `skipped`. The run
  // still exits non-zero, so CI blocks — but the summary line a human reads says
  // "22 passed | 5 skipped", which looks like a suite with some optional cases in it
  // rather than one where the entire MAU guard did not execute. That distinction
  // matters most in exactly the situation that produces it: a toolchain change (the
  // Cloudflare adapter moved prerendering into workerd, which is fussier about where
  // it may write) breaking the build in a way unrelated to auth.
  beforeAll(async () => {
    try {
      realBuild = await buildModuleGraph(repoRoot);
    } catch (error) {
      buildFailure = error;
    }
  }, 60_000);

  // Turns that skip into one unmissable failure that names the cause.
  it('built the real site, so the invariants below actually ran', () => {
    expect(buildFailure).toBeUndefined();
    expect(realBuild).toBeDefined();
  });

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

  // The tripwire for a silently vacuous suite, and it belongs HERE specifically.
  // Every other assertion in this describe is "some list derived from the graph is
  // empty" — which an empty graph satisfies exactly as well as a clean one does.
  // Replace realBuild with empty maps, or keep its module nodes and drop every edge,
  // and all of them stay green forever. The fixture block below has its own anchor
  // (it asserts that specific violations ARE found, which no empty graph can fake),
  // but the two builds do not share a configuration — the real one also runs
  // @astrojs/sitemap and Tailwind — so buildEnd could stop firing for this build and
  // no other, and nothing else here would notice. This asserts the graph is genuinely
  // populated, so the invariants below are known to be looking at something.
  it('the real build graph is populated (tripwire: an empty graph passes every other assertion here)', () => {
    const indexEntry = realBuild.pageEntries.get('src/pages/index');

    expect(indexEntry).toBeDefined();
    expect(relative(repoRoot, indexEntry!)).toBe(join('src', 'pages', 'index.astro'));
    expect([...(realBuild.graph.get(indexEntry!) ?? [])].length).toBeGreaterThan(0);
    // The CDN scan below has the identical failure mode: nothing to scan passes it.
    expect(realBuild.emittedHtml.size).toBeGreaterThan(0);
    // And so does Invariant C, through a different mechanism that the graph assertion
    // above would not notice. The graph comes from `buildEnd`; the text Invariant C
    // reads comes from `transform`. A hook renamed, mis-ordered, or dropped by a Vite
    // version bump leaves the graph fully populated and `serviceRoleRefs` permanently
    // empty — at which point "no module references the key" is true of nothing at all,
    // forever, and stays green. This is the assertion that fails instead.
    expect(realBuild.transformedIds.size).toBeGreaterThan(0);
  });

  it('nothing outside src/lib/auth/ imports the auth choke point', () => {
    const violations = checkAnonymousReadPath(realBuild, repoRoot);
    expect(violations.map((v) => v.message)).toEqual([]);
  });

  // Dormant rather than vacuous: see the comment on checkClerkChokePoint. This
  // assertion is real and will start catching real violations the day
  // `@clerk/...` lands in package.json — it just has nothing to find yet. Note it
  // covers the whole graph, not only src/: the integration-injected middleware that
  // `astro add @clerk/astro` produces has a virtual module as its importer.
  it('nothing outside src/lib/auth/ imports @clerk/* (dormant: Clerk is not yet a dependency)', () => {
    const violations = checkClerkChokePoint(realBuild.graph, repoRoot);
    expect(violations.map((v) => v.message)).toEqual([]);
  });

  // Invariant C. Unlike the Clerk assertion this one is not dormant — Supabase is the
  // decided auth and data provider, so the identifier it looks for is one somebody on
  // this project will genuinely reach for. It is empty today and must stay empty: the
  // only file in the repo that names the key is src/lib/auth/index.ts, which is inside
  // the exempt directory and describes what may live there.
  it('nothing outside src/lib/auth/ references SUPABASE_SERVICE_ROLE_KEY', () => {
    const violations = checkServiceRoleKey(realBuild, repoRoot);
    expect(violations.map((v) => v.message)).toEqual([]);
  });

  // The module graph cannot see a script tag; this is the half of the boundary that
  // can. Both are needed, and the fixture proves this one catches what the graph
  // misses rather than being decoration.
  it('no emitted page loads an auth SDK from a CDN, which no module graph would show', () => {
    expect(checkEmittedHtmlForAuthCdn(realBuild)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Self-test — proves the checker can actually fail
// ---------------------------------------------------------------------------

/** The eight ways the fixture reaches auth, by importing module. Every one of them is
 *  a real edge in a real Astro build of tests/fixtures/anon-read-path-violation, not
 *  a synthetic graph. */
const FIXTURE_VIOLATING_IMPORTERS = [
  'src/components/AuthGate.astro',
  'src/components/ClientLoadAuth.vue',
  'src/components/ClientOnlyAuth.vue',
  'src/lib/auth-helpers.ts',
  'src/lib/lazy-auth.ts',
  'src/middleware/index.ts',
  'src/pages/direct.astro',
  'src/pages/second-auth-module.astro',
];

/** The two importers no page entry reaches, so no failure message can carry a chain
 *  for them. They are the whole reason Invariant A is an edge rule: a reachability
 *  check sees the other six and is blind to exactly these. */
const FIXTURE_IMPORTERS_WITH_NO_PAGE_CHAIN = [
  'src/components/ClientOnlyAuth.vue',
  'src/middleware/index.ts',
];

/** The three modules the fixture expects Invariant C to report, in the order the checker
 *  sorts them. Everything else in that build — including the fixture's anon-key page, its
 *  runtime-assembled name, the module inside its choke point, and every one of the ~200
 *  node_modules modules the build pulls in — must stay off this list. None of these three
 *  imports the choke point, which is what keeps FIXTURE_VIOLATING_IMPORTERS at eight. */
const FIXTURE_SERVICE_ROLE_MODULES = [
  'src/lib/service-role-config.ts',
  'src/pages/service-role-import-meta.astro',
  'src/pages/service-role-process-env.astro',
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
  //
  // Three fixture pages reach this one component, which is what turns the chain
  // rendered here into a real choice rather than the only option: deep-transitive
  // reaches it in two hops and sorts FIRST, second-transitive and transitive reach it
  // in one and tie. So the reported chain pins both rules at once — prefer the shorter
  // chain over the earlier route, and break a tie by sorted route.
  it('flags the component that imports auth, with the shortest chain and the sorted-first route among ties', () => {
    const transitive = find('src/components/AuthGate.astro');
    const gate = [...fixtureBuild.graph.keys()].find(
      (id) => rel(id) === 'src/components/AuthGate.astro',
    )!;
    const pagesReachingGate = [...fixtureBuild.pageEntries.entries()]
      .filter(([, file]) => findChain(fixtureBuild.graph, file, (id) => id === gate) !== null)
      .map(([route]) => route)
      .sort();

    // The premise of the test above: without three pages reaching it, neither the
    // shortest-path comparison nor the tie-break is exercised by anything.
    expect(pagesReachingGate).toEqual([
      'src/pages/deep-transitive',
      'src/pages/second-transitive',
      'src/pages/transitive',
    ]);

    expect(transitive).toBeDefined();
    expect(transitive!.chain?.map(rel)).toEqual([
      'src/pages/second-transitive.astro',
      'src/components/AuthGate.astro',
      'src/lib/auth/index.ts',
    ]);
    expect(transitive!.message).toContain('src/components/AuthGate.astro');
    expect(transitive!.message).toContain('$6,000');
  });

  // The choke point is a DIRECTORY, and a checker that recognises only its index.ts
  // guards one file of it. Everything else in there — including whichever module ends
  // up actually holding the Clerk client — would be importable from anywhere.
  it('flags a page importing a module inside the choke point other than index.ts', () => {
    const second = find('src/pages/second-auth-module.astro');

    expect(second).toBeDefined();
    expect(second!.chain?.map(rel)).toEqual([
      'src/pages/second-auth-module.astro',
      'src/lib/auth/session.ts',
    ]);
    expect(second!.message).toContain('src/lib/auth/session.ts');
    expect(second!.message).toContain('$6,000');
  });

  // The choke point's own files must be free to import each other, and that exemption
  // is only executed while the directory holds more than one file. The fixture's
  // index.ts imports its session.ts precisely so deleting the exemption goes red here.
  it('does not flag the choke point importing itself', () => {
    const violations = checkAnonymousReadPath(fixtureBuild, fixtureRoot);
    const authIndex = [...fixtureBuild.graph.keys()].find(
      (id) => rel(id) === 'src/lib/auth/index.ts',
    )!;

    // The intra-directory edge is really there — otherwise this asserts nothing.
    expect([...(fixtureBuild.graph.get(authIndex) ?? [])].map(rel)).toContain(
      'src/lib/auth/session.ts',
    );
    expect(violations.map((v) => rel(v.importer))).not.toContain('src/lib/auth/index.ts');
  });

  // `src/lib/auth-helpers.ts` is next to the choke point, not inside it. It is caught
  // by the trailing separator on the directory prefix, and by nothing else: without
  // the separator the comparison is a bare string prefix, and every `auth*` sibling
  // exempts itself from the invariant that exists to constrain it.
  it('flags a sibling module whose path merely starts with the choke point directory name', () => {
    const helper = find('src/lib/auth-helpers.ts');

    expect(helper).toBeDefined();
    expect(helper!.chain?.map(rel)).toEqual([
      'src/pages/auth-helpers.astro',
      'src/lib/auth-helpers.ts',
      'src/lib/auth/index.ts',
    ]);
    expect(helper!.message).toContain('src/lib/auth-helpers.ts');
    expect(helper!.message).toContain('$6,000');
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
   * A reachability-based checker was run against this fixture. It reports every
   * violation that some page entry can walk to — most of them — and is blind to
   * exactly the two that no page entry reaches: this island, and
   * src/middleware/index.ts. That set is not left to prose; it is asserted below, from
   * the same graph, as FIXTURE_IMPORTERS_WITH_NO_PAGE_CHAIN.
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
    expect(island!.message).toContain('src/components/ClientLoadAuth.vue');
    expect(island!.message).toContain('$6,000');
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
    expect(lazy!.message).toContain('src/lib/lazy-auth.ts');
    expect(lazy!.message).toContain('$6,000');
  });

  // Middleware in the DIRECTORY form. Astro resolves middleware from either
  // src/middleware.{js,ts,mjs} or src/middleware/index.{js,ts,mjs}, so any rule that
  // hardcodes a middleware path is blind to the other spelling — silently, because the
  // unchecked spelling still builds and still ships. The edge rule needs no path
  // knowledge at all, and this case is what executes that claim. Like the client:only
  // island, middleware has no page entry above it — Astro loads it as its own entry,
  // ahead of every route.
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

  it('reports exactly those eight importers, no more and no fewer', () => {
    const violations = checkAnonymousReadPath(fixtureBuild, fixtureRoot);
    expect(violations.map((v) => rel(v.importer))).toEqual(FIXTURE_VIOLATING_IMPORTERS);
  });

  // The measurement behind "a reachability checker is blind to exactly these two",
  // taken from the graph rather than asserted in a comment that can rot as the fixture
  // grows. A violation with no chain is one no page entry reaches, which is precisely
  // what a reachability rule would have missed.
  it('two of the eight are reachable from no page entry at all', () => {
    const violations = checkAnonymousReadPath(fixtureBuild, fixtureRoot);

    expect(violations.filter((v) => v.chain === null).map((v) => rel(v.importer))).toEqual(
      FIXTURE_IMPORTERS_WITH_NO_PAGE_CHAIN,
    );
  });

  // The boundary of the whole approach, executed from both sides. cdn-script.astro
  // loads an auth SDK over a plain <script src>, the way Clerk's browser bundle is
  // meant to be loaded: no import, so no edge, so nothing for either invariant to see —
  // and that is a property of module graphs, not a bug to fix here. The scan of the
  // emitted HTML is what covers it, and this is the only case in the suite that
  // distinguishes the two.
  it('sees no module-graph violation for a CDN script tag, and catches it in the emitted HTML', () => {
    const violations = checkAnonymousReadPath(fixtureBuild, fixtureRoot);

    expect(violations.map((v) => rel(v.importer))).not.toContain('src/pages/cdn-script.astro');
    expect(fixtureBuild.pageEntries.has('src/pages/cdn-script')).toBe(true);

    expect(checkEmittedHtmlForAuthCdn(fixtureBuild)).toEqual([
      { file: join('cdn-script', 'index.html'), url: 'https://cdn.clerk.io/clerk.browser.js' },
    ]);
  });

  /**
   * Invariant C's self-test, nested inside this describe rather than standing next to it
   * for one reason: `beforeAll` above runs a real `astro build`, and a sibling describe
   * would need its own. One fixture project, extended, costs nothing per run; a second
   * fixture project costs an entire build. That is also why none of the modules added for
   * Invariant C imports the fixture's choke point — doing so would change the eight
   * importers Invariant A's assertions above are pinned to.
   */
  describe('Invariant C, against the same fixture build', () => {
    const findRef = (module: string) =>
      checkServiceRoleKey(fixtureBuild, fixtureRoot).find((v) => rel(v.module) === module);
    const id = (relPath: string) => join(fixtureRoot, relPath);

    // Line numbers are computed from the fixture's own text rather than hardcoded. Not to
    // avoid churn when a fixture comment is edited — that would be a fine reason on its
    // own — but because hardcoding them proves nothing: the number this asserts has to be
    // the line of THIS FILE ON DISK, and the only way to say that is to go and find it in
    // the file. See the test below on why that distinction is load-bearing.
    const sourceLineOf = (relPath: string, needle: string) =>
      readFileSync(id(relPath), 'utf8')
        .split('\n')
        .findIndex((line) => line.includes(needle)) + 1;

    it('flags a page that reads the key off import.meta.env', () => {
      const page = 'src/pages/service-role-import-meta.astro';
      const violation = findRef(page);

      expect(violation).toBeDefined();
      expect(violation!.refs).toEqual([
        {
          line: sourceLineOf(page, 'import.meta.env.SUPABASE_SERVICE_ROLE_KEY'),
          snippet: 'const serviceRoleKey = import.meta.env.SUPABASE_SERVICE_ROLE_KEY;',
        },
      ]);
    });

    // The reported line has to be the line of the FILE, and for a .astro page it is not
    // the line the transform hook saw: Astro's compiler strips the frontmatter comments
    // and moves what is left, so the same reference lands many lines earlier in the text
    // the plugin chain hands over. A message pointing at the wrong line is worse than one
    // pointing at none, because the reader trusts it and goes looking at a comment.
    //
    // This asserts the two genuinely disagree, so the preference for the file's own text
    // in checkServiceRoleKey is executed rather than merely intended. If a future Astro
    // version starts preserving line numbers, this fails — and the right response is to
    // delete this test, not to stop reading the file.
    it('reports the line the file has, not the line the transformed module has', () => {
      const page = 'src/pages/service-role-import-meta.astro';
      const asTransformed = fixtureBuild.serviceRoleRefs.get(id(page));

      expect(asTransformed).toBeDefined();
      expect(asTransformed).toHaveLength(1);
      expect(asTransformed![0].line).not.toBe(findRef(page)!.refs[0].line);
    });

    it('flags a page that reads the key off process.env', () => {
      const page = 'src/pages/service-role-process-env.astro';
      const violation = findRef(page);

      expect(violation).toBeDefined();
      expect(violation!.refs).toEqual([
        {
          line: sourceLineOf(page, 'process.env.SUPABASE_SERVICE_ROLE_KEY'),
          snippet: 'const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;',
        },
      ]);
    });

    // A destructured binding in a library module: no member expression to spot, and not a
    // page, so both the "look for property access" and the "check the routes" shortcuts
    // fail here. The third ref is the comment at the bottom of that file, which is the
    // documented behaviour rather than a miss — see A_COMMENT_IS_A_REFERENCE.
    it('flags a destructured binding in a library module a page imports, comment line included', () => {
      const module = 'src/lib/service-role-config.ts';
      const violation = findRef(module);

      expect(violation).toBeDefined();
      expect(violation!.refs.map((ref) => ref.line)).toEqual([
        sourceLineOf(module, 'const { SUPABASE_SERVICE_ROLE_KEY } = env;'),
        sourceLineOf(module, 'return Boolean(SUPABASE_SERVICE_ROLE_KEY);'),
        sourceLineOf(module, '// SUPABASE_SERVICE_ROLE_KEY'),
      ]);
      // Its page is clean and must stay unreported: the module is what holds the key.
      expect(findRef('src/pages/service-role-config.astro')).toBeUndefined();
    });

    /**
     * THE DOCUMENTED BOUNDARY, AND NOT A BUG. A name assembled at runtime is invisible to
     * a text scan and always will be — catching it means evaluating the program.
     *
     * Two things are asserted here beyond "not flagged", because "not flagged" on its own
     * is exactly what a module the checker never looked at also produces, and the two are
     * indistinguishable without them: the module is in the build graph, and the transform
     * hook actually ran for it. It is in scope, it was read, and it still comes out
     * clean.
     *
     * Whoever narrows this boundary later: the case to beat is this file. Whoever widens
     * it — a regex loose enough to match `SERVICE_ROLE` in fragments — should know that is
     * how a guardrail starts failing on prose and gets deleted.
     */
    it('does NOT flag a key name assembled at runtime, which is the documented boundary', () => {
      const module = 'src/lib/runtime-named-key.ts';

      expect(fixtureBuild.graph.has(id(module))).toBe(true);
      expect(fixtureBuild.transformedIds.has(id(module))).toBe(true);
      expect(findRef(module)).toBeUndefined();
    });

    // The acceptance criterion the rule would be wrong without. A page that uses Supabase,
    // says so in its copy, and reads the publishable anon key is the anonymous read path
    // working as designed. A rule that failed this page would be deleted by the first
    // person who hit it, and they would be right.
    it('does NOT flag a page using the publishable anon key and naming Supabase', () => {
      const page = 'src/pages/supabase-anon-key.astro';

      expect(fixtureBuild.pageEntries.has('src/pages/supabase-anon-key')).toBe(true);
      expect(readFileSync(id(page), 'utf8')).toContain('PUBLIC_SUPABASE_ANON_KEY');
      expect(findRef(page)).toBeUndefined();
    });

    // The exemption, and it is the exemption doing the work rather than absence: the
    // transform record shows this module really does name the key, and it is still not
    // reported. Delete the `startsWith(authDir)` skip and this goes red.
    it('does NOT flag a module inside src/lib/auth/ that references the key', () => {
      const module = 'src/lib/auth/service-role.ts';

      expect(fixtureBuild.graph.has(id(module))).toBe(true);
      expect(fixtureBuild.serviceRoleRefs.get(id(module))?.length).toBeGreaterThan(0);
      expect(findRef(module)).toBeUndefined();
    });

    // The other half of "not vacuous", and the assertion that fails if the scan ever
    // starts matching something it should not — a fragment, a comment in a dependency, a
    // page that merely imports a module holding the key. Note this covers the whole
    // graph, node_modules included, so it is also the measurement behind the claim that
    // the broad scoping costs nothing.
    it('reports exactly those three modules, no more and no fewer', () => {
      const violations = checkServiceRoleKey(fixtureBuild, fixtureRoot);
      expect(violations.map((v) => rel(v.module))).toEqual(FIXTURE_SERVICE_ROLE_MODULES);
    });

    /**
     * The message is the whole deliverable of a guardrail like this: it is read once, by
     * somebody who did not write the rule, at the moment they most want to make it stop.
     * So its content is pinned rather than left to whoever edits the strings next.
     *
     * The negative assertion is the important one. "Could allow unauthorised access" is
     * the phrasing this message must never use — it is vague enough to argue with, and an
     * argument is what turns a red build into a deleted check. What is true is narrower:
     * RLS is bypassed, and every policy in the database becomes decorative.
     */
    it('the message says RLS is bypassed, that the anon key is fine, and what to do instead', () => {
      const page = 'src/pages/service-role-import-meta.astro';
      const message = findRef(page)!.message;

      expect(message).toContain(
        `${page}:${sourceLineOf(page, 'import.meta.env.SUPABASE_SERVICE_ROLE_KEY')}`,
      );
      expect(message).toContain('RLS bypassed');
      expect(message).toContain('row-level security ENTIRELY');
      expect(message).toContain('absence of the authorization boundary');
      expect(message).toContain('decorative');
      expect(message).not.toContain('unauthorised access');
      expect(message).not.toContain('unauthorized access');

      expect(message).toContain('PUBLIC_SUPABASE_ANON_KEY');
      expect(message).toContain('public by design');
      expect(message).toContain('src/lib/auth/');
      expect(message).toContain('cannot tell code from a comment');
    });
  });
});

describe('findPageChain, on graphs whose insertion order disagrees with their sorted order', () => {
  // Which route a failure message blames has to be the same on every run, or a
  // reviewer cannot tell a real change in the graph from a reshuffle of it. A real
  // build cannot demonstrate that: its page-discovery order is Rollup's, nothing here
  // chooses it, and for the fixture it currently agrees with sorted order anyway. A
  // graph built by hand can — these entries are inserted in the reverse of the order
  // the function must visit them in.
  const target = join(repoRoot, 'src', 'lib', 'auth', 'index.ts');
  const page = (name: string) => join(repoRoot, 'src', 'pages', `${name}.astro`);

  it('breaks a tie between equally short chains by sorted route, not insertion order', () => {
    const build: BuildGraph = {
      graph: new Map([
        [page('zebra'), new Set([target])],
        [page('alpha'), new Set([target])],
      ]),
      pageEntries: new Map([
        ['src/pages/zebra', page('zebra')],
        ['src/pages/alpha', page('alpha')],
      ]),
      emittedHtml: new Map(),
      serviceRoleRefs: new Map(),
      transformedIds: new Set(),
    };

    expect(findPageChain(build, target)).toEqual([page('alpha'), target]);
  });

  it('prefers a shorter chain from a later route over a longer one from an earlier route', () => {
    const middle = join(repoRoot, 'src', 'components', 'Middle.astro');
    const build: BuildGraph = {
      graph: new Map([
        [page('alpha'), new Set([middle])],
        [middle, new Set([target])],
        [page('zebra'), new Set([target])],
      ]),
      pageEntries: new Map([
        ['src/pages/alpha', page('alpha')],
        ['src/pages/zebra', page('zebra')],
      ]),
      emittedHtml: new Map(),
      serviceRoleRefs: new Map(),
      transformedIds: new Set(),
    };

    expect(findPageChain(build, target)).toEqual([page('zebra'), target]);
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

  /**
   * The case a first-party-scoped rule cannot see, and the most likely way Clerk ever
   * arrives: `npx astro add @clerk/astro` edits astro.config.mjs, and the integration
   * injects its middleware with `addMiddleware({ entrypoint: '@clerk/astro/...' })`.
   * Not one file under src/ changes, so Invariant A has nothing to fire on either.
   *
   * These two ids are not invented for the test, down to the leading NUL. They are
   * what a real build produces: verified by installing a stub `@clerk/astro`
   * integration exactly as `astro add` would, building this site, and reading the graph
   * — one Clerk edge, this one, the importer a `\0`-prefixed virtual module rather than
   * a file, the target left as a bare specifier because no pass resolved it.
   */
  it('flags the middleware an Astro integration injects, whose importer is a virtual module', () => {
    const graph: ModuleGraph = new Map([
      ['\0virtual:astro:middleware', new Set(['@clerk/astro/integration-middleware'])],
    ]);
    const violations = checkClerkChokePoint(graph, repoRoot);

    expect(violations.map((v) => ({ clerkModule: v.clerkModule, importer: v.importer }))).toEqual([
      {
        clerkModule: '@clerk/astro/integration-middleware',
        importer: '\0virtual:astro:middleware',
      },
    ]);
    // A virtual importer is not a path. Rendering it through `relative()` would print
    // it as a `../../..` walk out of the repo, and leaving the NUL in place prints a
    // control character that reads as a mis-indented blank — both in the one message
    // whose reader most needs to recognise that there is no file to go and edit. So the
    // rendered edge is pinned exactly, and the message names the file that IS editable.
    expect(violations[0].message).toContain(
      '    virtual:astro:middleware\n    -> @clerk/astro/integration-middleware',
    );
    expect(violations[0].message).not.toContain('\0');
    expect(violations[0].message).toContain('astro.config.mjs');
    expect(violations[0].message).toContain('$6,000');
  });

  it('allows a @clerk/* import from inside the choke point', () => {
    const authModule = join(repoRoot, 'src', 'lib', 'auth', 'index.ts');
    const graph: ModuleGraph = new Map([[authModule, new Set(['@clerk/astro'])]]);

    expect(checkClerkChokePoint(graph, repoRoot)).toEqual([]);
  });

  // The exemption is src/lib/auth/, not src/lib/. Widening it by one path segment is
  // a plausible-looking edit — "the auth helpers live in lib, let lib import clerk" —
  // and it reopens the invariant for every shared module in the codebase.
  it('flags a @clerk/* import from elsewhere in src/lib/, which is not the choke point', () => {
    const dbModule = join(repoRoot, 'src', 'lib', 'db.ts');
    const graph: ModuleGraph = new Map([[dbModule, new Set(['@clerk/astro'])]]);

    expect(
      checkClerkChokePoint(graph, repoRoot).map((v) => ({
        clerkModule: v.clerkModule,
        importer: v.importer,
      })),
    ).toEqual([{ clerkModule: '@clerk/astro', importer: dbModule }]);
  });

  // Clerk's own packages import each other. Every one of those edges has an importer
  // outside the choke point, so a check with no exemption at all would report all of
  // them the day `npm i @clerk/astro` lands — before any first-party auth code exists,
  // and with no way to go green except by deleting the check. This is the assertion
  // that keeps that from happening, in both shapes an importer takes: the resolved
  // node_modules path, and the bare specifier a pass that left it external produces.
  it('does not flag Clerk packages importing each other', () => {
    const clerkAstro = join(repoRoot, 'node_modules', '@clerk', 'astro', 'dist', 'index.js');
    const graph: ModuleGraph = new Map([
      [clerkAstro, new Set(['@clerk/shared', '@clerk/types', '@clerk/backend'])],
      ['@clerk/astro/integration-middleware', new Set(['@clerk/backend'])],
    ]);

    expect(checkClerkChokePoint(graph, repoRoot)).toEqual([]);
  });

  // Deliberate, and the reason the exemption is "Clerk's own edges" rather than "any
  // node_modules edge": a dependency that pulls the SDK in ships it to every anonymous
  // reader exactly as a first-party import would, and nobody here wrote the import to
  // notice it in review.
  it('flags a non-Clerk dependency that imports @clerk/*', () => {
    const someUiKit = join(repoRoot, 'node_modules', 'some-ui-kit', 'dist', 'index.js');
    const graph: ModuleGraph = new Map([[someUiKit, new Set(['@clerk/astro'])]]);

    expect(
      checkClerkChokePoint(graph, repoRoot).map((v) => ({
        clerkModule: v.clerkModule,
        importer: v.importer,
      })),
    ).toEqual([{ clerkModule: '@clerk/astro', importer: someUiKit }]);
  });
});
