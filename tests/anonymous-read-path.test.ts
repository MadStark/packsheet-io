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
 * inspecting the actual Rollup module graph Astro produces — not by convention, which
 * relies on every future PR author having read this comment.
 *
 * "Not by grep" applies to two of the three, and the difference is worth stating because
 * the phrase reads as if it covered all of them. Invariants A and B are graph rules: they
 * follow edges, which is what grep cannot do through a re-export or an aliased import.
 * Invariant C IS a text scan — the same kind of thing grep does. What the graph gives it
 * is not sight through indirection but SCOPE: it decides which text is scanned, namely
 * every module that actually ships, dependencies included, rather than whatever happens to
 * be lying in the working tree.
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
 * Invariant C: NO module in the build graph outside src/lib/auth/ may name a Supabase
 * privileged key, in any of the spellings listed in PRIVILEGED_KEY_PATTERNS below — the
 * service-role key with or without its `SUPABASE_` prefix, `SUPABASE_SECRET_KEY`, or a
 * pasted `sb_secret_…` literal. This is not Invariant B with the package name swapped,
 * and reading it that way would break the site. `@supabase/supabase-js` with the `anon`
 * key BELONGS on the anonymous read path — it is how anonymous reads happen at all — so
 * the package cannot be what is banned. The rule is about the KEY. It is scoped to the
 * whole graph for the same reason Invariant B is, and that scoping is affordable because
 * it was measured rather than hoped: no pattern in that set matches anything in the 2,070
 * modules of the real build's graph, and neither @supabase/supabase-js@2.112.2 nor
 * @supabase/ssr@0.12.4 contains the string SERVICE_ROLE anywhere, so this does not go red
 * on contact when those land (Ref 49). See checkServiceRoleKey.
 *
 * A module graph tells you what SHIPS; it cannot tell you what a module says. So
 * Invariant C needs source text, correlated with graph membership: the graph recorder
 * below also carries a `transform` hook, so every module the build actually processed is
 * scanned, and only modules that are in the graph are ever checked. Text is also where
 * its limits come from, and they are worth stating before the code implies otherwise:
 *
 *   - A name assembled at runtime is invisible. Neither `env[SEGMENTS.join('_')]` nor
 *     `env['SUPABASE_SERVICE' + '_ROLE_KEY']` is the identifier, and neither ever will be
 *     to a scanner; the fixture's src/lib/runtime-named-key.ts pins both as the documented
 *     boundary rather than leaving them to be discovered. This build does NOT constant-fold
 *     the concatenation into a contiguous name — measured, see that file — so whether a
 *     `+` form is caught depends entirely on where the author happened to split it: a
 *     fragment that is itself one of the banned spellings still matches, and one that is
 *     not, does not.
 *   - The rule is NAME-BOUND. It knows the spellings in PRIVILEGED_KEY_PATTERNS and no
 *     others, and there is no Supabase secret in .env.example or wrangler.jsonc yet for it
 *     to have been checked against. Whoever adds one must confirm its name matches a
 *     pattern there, or add a pattern — otherwise this check stays green forever while the
 *     key ships, which is the one failure mode a guardrail must not have.
 *   - A module with no file on disk that the transform hook never saw is a module this
 *     check has no text for at all. Anything backed by a file is scanned from the file
 *     regardless, so that gap is narrow, but it is not empty — and it is not left to
 *     prose either: partitionScannability makes that set explicit and the real-site block
 *     asserts it stays within a small allow-list, so a dependency getting externalised
 *     into it turns the build red instead of quietly becoming invisible.
 *   - astro.config.mjs is not a module in any pass, so nothing here reads it — and it is
 *     the one place a service-role VALUE, not merely its name, can be inlined into every
 *     shipped module: `vite: { define: { … } }` substitutes a literal at transform time,
 *     leaving the name only in the config and an opaque string in the bundles. Reviewing
 *     that file is a human job; see the note on the transform-sourced refs below for the
 *     narrow part of it this check does still see.
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
 * violate the invariants, in eight ways for Invariant A and in one way per spelling
 * Invariant C recognises plus one per source its text can come from, and asserts each is
 * caught with the right chain, the right lines and the right message.
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
 *   exercised rather than merely asserted here in prose: against the fixture the three
 *   passes contain an empty one, a server pass of a couple of hundred modules, and a
 *   client pass of a dozen or so, and the `client:only` island's own import of auth is
 *   visible ONLY in that third, small pass. Exact counts are deliberately not written
 *   down — they move every time the fixture gains a case — but the property that matters
 *   is pinned by a test rather than by this sentence: the client:only case below fails
 *   if that third pass stops being unioned in.
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

/** Where the text a ref was found in came from. It decides whether the `path:line` in a
 *  failure message is something the reader can open:
 *
 *    'file'      the module's own file on disk. The line number is the file's, so it is
 *                exactly what an editor will jump to.
 *    'transform' the plugin chain's output for that module. Comments are stripped and a
 *                .astro file's frontmatter is relocated, so the line number belongs to
 *                text that exists nowhere on disk — the reader has to be told, or they
 *                will open the file at that line and find something unrelated.
 *
 *  This is a property of the REF, not of the module, and the distinction is the whole
 *  point: a module can have a perfectly good file, whose text is clean, and still carry a
 *  reference that only the transformed text has (an inlined define, a generated wrapper,
 *  an injecting plugin). Gating the caveat on "has no file on disk" gets that case wrong
 *  in the direction that matters — a real-looking path:line with no warning attached. */
type RefSource = 'file' | 'transform';

/** One place a module names a privileged key: which line, the line itself so a failure
 *  message can show the reader what it found rather than only where, and which text that
 *  line was read from. */
interface ServiceRoleRef {
  line: number;
  snippet: string;
  source: RefSource;
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
  /** module id -> every line of it that names a privileged key, as the `transform` hook
   *  saw the module. Deduped across passes. There is NO entry at all — `.get()` returns
   *  `undefined`, not an empty array — both for a module the hook saw and found clean and
   *  for one it never saw, which is why `transformedIds` exists next to it: the two are
   *  otherwise indistinguishable from here. */
  serviceRoleRefs: Map<string, ServiceRoleRef[]>;
  /** Every id the `transform` hook was called for, in any pass. The evidence that the
   *  hook fired at all: without it, a hook that silently stopped running would leave
   *  `serviceRoleRefs` permanently empty, and Invariant C would be blind to every module
   *  whose only text comes from the transform — the ones with no file on disk, and the
   *  ones whose reference is injected into the transformed text rather than written in
   *  the file. The real-site tripwire asserts this is populated for exactly that reason. */
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

/** The choke point as a path prefix, which is what all three invariants are anchored on.
 *  Defined once rather than spelled out at each of them, so that when auth moves — to
 *  src/lib/session/, say, the day Supabase Auth lands — there is one place to change and
 *  no chance of two of the three moving while the third silently stops exempting anything.
 *
 *  The trailing separator is load-bearing, not tidiness: without it the comparison is a
 *  bare string prefix and `src/lib/auth-helpers.ts` exempts itself from the rule that
 *  exists to constrain it. The fixture has that exact sibling for that exact reason. */
function chokePointDir(root: string): string {
  return join(root, 'src', 'lib', 'auth') + sep;
}

/**
 * EVERY spelling Invariant C bans, in one place so extending the rule is a one-line edit
 * rather than an archaeology exercise. This is the definition of "a privileged key" for
 * the whole file; nothing else hardcodes a name.
 *
 * The rule is NAME-BOUND, and that is its sharpest limitation rather than a detail. This
 * check knows the strings below and nothing else. At the time of writing the project has
 * not yet chosen which name the secret ships under: `.env.example` has no Supabase entry
 * and wrangler.jsonc declares no such secret, so nothing here has ever been confirmed
 * against the real thing. WHOEVER ADDS THAT SECRET — to .env.example, to wrangler, to a
 * CI secret, anywhere — MUST CHECK ITS NAME AGAINST THIS LIST AND ADD IT IF IT IS NOT
 * HERE. A name-bound rule that does not know the name in use is not a weaker guardrail,
 * it is a green one, permanently, while the key ships.
 *
 * Why these, specifically:
 *
 *   - `SERVICE_ROLE_KEY` with the `SUPABASE_` prefix OPTIONAL. The prefix is a convention,
 *     not part of the key's identity, and a module that destructures or re-exports the
 *     value under the bare name is exactly as dangerous. Making the prefix optional also
 *     means a `'SUPABASE_' + 'SERVICE_ROLE_KEY'` concatenation still matches on its second
 *     fragment — see src/lib/runtime-named-key.ts in the fixture for where that stops.
 *   - `SUPABASE_SECRET_KEY`, Supabase's own current name for the same thing in its newer
 *     key scheme. A rule that knew only the older name would go green the day the project
 *     adopted the newer one, with nothing to indicate anything had changed.
 *   - A pasted `sb_secret_…` LITERAL. Every pattern above is a name-based rule, and a
 *     name-based rule has one structural hole: the value pasted in directly, with no
 *     identifier anywhere near it. Supabase's secret keys carry that fixed prefix, so the
 *     value is recognisable on its own. This is the only pattern here that matches a
 *     credential rather than a variable name, which is also why it is the only one that
 *     REDACTS what it prints — see `mask`.
 *
 * Every pattern is word-bounded so `MY_SERVICE_ROLE_KEY_NAME` is not a match while
 * `env.SERVICE_ROLE_KEY` and `{ SUPABASE_SERVICE_ROLE_KEY }` are. All of them were run
 * against the whole of both build graphs before being adopted — the real site's 2,070
 * modules and the fixture's — and none matches anything outside the fixture cases written
 * for it. The looser spellings that were considered and rejected are worth recording so
 * nobody re-litigates them by accident: a bare `SERVICE_ROLE` or `SECRET_KEY` also matches
 * nothing today, but both are short enough and generic enough to start matching a
 * dependency's own unrelated constant later, and a guardrail that goes red on somebody
 * else's code is one that gets deleted rather than obeyed.
 */
interface PrivilegedKeyPattern {
  /** What this spelling is, for the failure message's list of what the rule matches. */
  name: string;
  /** Global, because the scan uses `matchAll`/`replace` over a whole line. */
  pattern: RegExp;
  /** Set only where the match is a CREDENTIAL rather than a variable name. What the
   *  matched text is replaced with before it is printed anywhere: a failure message goes
   *  into a CI log, and a guardrail that echoes the live secret it just found into a log
   *  has leaked it more widely than the commit did. The mask deliberately still matches
   *  its own pattern, so redacting is idempotent and the snippet windowing below can
   *  still anchor on it. */
  mask?: string;
}

const PRIVILEGED_KEY_PATTERNS: readonly PrivilegedKeyPattern[] = [
  {
    name: 'SUPABASE_SERVICE_ROLE_KEY (or the bare SERVICE_ROLE_KEY)',
    pattern: /\b(?:SUPABASE_)?SERVICE_ROLE_KEY\b/g,
  },
  { name: 'SUPABASE_SECRET_KEY', pattern: /\bSUPABASE_SECRET_KEY\b/g },
  {
    name: 'a pasted sb_secret_… key value',
    pattern: /\bsb_secret_[A-Za-z0-9_-]{8,}/g,
    mask: 'sb_secret_REDACTED',
  },
];

/** The one-line remedy the docstrings promise, made real. If a dependency ever
 *  legitimately names a privileged key — a Supabase admin SDK shipping its own env
 *  plumbing, say — put its package name here with a comment saying why, rather than
 *  narrowing the rule to first-party code. Matched against the `node_modules/<name>/`
 *  segment of a resolved id, so it exempts a package and not a path that merely contains
 *  its name. Empty today, and it should stay a list of named exceptions rather than
 *  becoming a category. */
const PACKAGES_EXEMPT_FROM_KEY_SCAN: readonly string[] = [];

/** Longest snippet a failure message will print for one line. A bundled dependency can
 *  be one line of several hundred kilobytes, and a guardrail whose failure output has to
 *  be scrolled past is one people stop reading. */
const SNIPPET_LIMIT = 120;

/** The first place in `line` any pattern matches, or null. "First" is by position in the
 *  line rather than by position in the pattern list, so the snippet below is windowed
 *  around what a reader scanning left to right would find first. */
function firstKeyMatch(line: string): { index: number; length: number } | null {
  let best: { index: number; length: number } | null = null;
  for (const { pattern } of PRIVILEGED_KEY_PATTERNS) {
    // `matchAll` requires a global regex and, unlike `RegExp.test`, leaves no `lastIndex`
    // state behind on these shared, module-level patterns.
    for (const match of line.matchAll(pattern)) {
      if (best === null || match.index < best.index)
        best = { index: match.index, length: match[0].length };
      break; // Only the leftmost match of each pattern can be the leftmost overall.
    }
  }
  return best;
}

/** Replace every credential-shaped match with its mask. Applied to the whole line BEFORE
 *  it is windowed, so a window that clips a secret cannot leave a fragment of it behind. */
function redactKeyValues(line: string): string {
  let out = line;
  for (const { pattern, mask } of PRIVILEGED_KEY_PATTERNS) {
    if (mask !== undefined) out = out.replace(pattern, mask);
  }
  return out;
}

/** The part of `line` worth printing: the whole thing when it is short, and otherwise a
 *  window centred on the match. Slicing from column 0 instead — which is what this used to
 *  do — produces, for a minified dependency on one 300kB line, a snippet that does not
 *  visibly contain the identifier the message says it found. */
function snippetFor(line: string, match: { index: number; length: number }): string {
  if (line.length <= SNIPPET_LIMIT) return line;
  const padding = Math.max(0, Math.floor((SNIPPET_LIMIT - match.length) / 2));
  const start = Math.max(0, Math.min(match.index - padding, line.length - SNIPPET_LIMIT));
  const end = Math.min(line.length, start + SNIPPET_LIMIT);
  return `${start > 0 ? '…' : ''}${line.slice(start, end)}${end < line.length ? '…' : ''}`;
}

/** Every line of `code` that names a privileged key, one ref per line however many times
 *  it appears there, tagged with where `code` came from so the message can say whether the
 *  line number points at something openable. */
function scanForPrivilegedKey(code: string, source: RefSource): ServiceRoleRef[] {
  const refs: ServiceRoleRef[] = [];
  code.split('\n').forEach((raw, index) => {
    const safe = redactKeyValues(raw.trim());
    const match = firstKeyMatch(safe);
    if (match === null) return;
    refs.push({ line: index + 1, snippet: snippetFor(safe, match), source });
  });
  return refs;
}

/** Reads are memoised because checkServiceRoleKey is called once per assertion — around a
 *  dozen times against the fixture build — and would otherwise re-read every file in the
 *  graph each time, .woff2 binaries included. Safe as a module-level cache because nothing
 *  in this suite writes to a file that a build graph points at, and because the way this
 *  guardrail gets mutation-tested — edit a module, re-run the suite — starts a new process
 *  and therefore a new cache. If a test ever does need to edit a file mid-run, it has to
 *  clear this rather than assume the read is fresh. */
const fileTextCache = new Map<string, string | null>();

/** The file's own text, or null when the id is not a readable file — a virtual module, a
 *  bare specifier a pass left unresolved, or a directory-shaped id. `throwIfNoEntry:
 *  false` rather than a try/catch so a genuine read failure on something that IS a file
 *  still throws instead of being quietly scanned as empty.
 *
 *  `hasNoFileOnDisk` has to be consulted on the RAW id, NUL and all. Rollup's `\0` prefix
 *  is not decoration that can be stripped before a syscall: an id like `\0/abs/path.js` —
 *  which is exactly what @rollup/plugin-commonjs emits for its proxy modules, so it
 *  arrives with the first CJS dependency in the graph — denotes a VIRTUAL PROXY for that
 *  file, not the file. Reading the file for it would be wrong even if it worked, because
 *  the proxy's text is generated wrapper code and the file's line numbers do not describe
 *  it. It also does not work: `statSync` rejects a NUL in a path with
 *  ERR_INVALID_ARG_VALUE, which `throwIfNoEntry: false` does not suppress — that only
 *  covers ENOENT. So a `\0` id is answered from the transform record or not at all. */
function readFileForId(id: string): string | null {
  const cached = fileTextCache.get(id);
  if (cached !== undefined) return cached;
  const text = readFileForIdUncached(id);
  fileTextCache.set(id, text);
  return text;
}

function readFileForIdUncached(id: string): string | null {
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
        const found = scanForPrivilegedKey(code, 'transform');
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

/** True for an id with no file behind it: anything Rollup marked virtual with a leading
 *  `\0`, or a bare specifier a pass left unresolved. Both mean "there is nothing here to
 *  open in an editor", which is what a failure message has to say out loud.
 *
 *  The `\0` is tested on the raw id and short-circuits, rather than being stripped first.
 *  Stripping it would classify `\0/abs/path.js` — @rollup/plugin-commonjs's proxy for a
 *  CJS module — as a file, which it is not: it is a generated wrapper that merely borrows
 *  the file's path as its name. See readFileForId for what goes wrong downstream. */
function hasNoFileOnDisk(id: string): boolean {
  return id.startsWith('\0') || !isAbsolute(id);
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
  const authDir = chokePointDir(root);
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
  const authDir = chokePointDir(root);
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

/** Where the key belongs — and, said in the same breath because the obvious next move is
 *  currently blocked, what happens if you go and do it. src/lib/auth/ is the one directory
 *  Invariant C exempts, so a service-role client goes there. But Invariant A is an
 *  unconditional EDGE rule: importing that directory from a route is itself a violation
 *  today, and one whose failure message is about a $6,000/month auth bill that has nothing
 *  to do with what you just did. Sending a reader from one red build straight into another,
 *  more confusing one is how a guardrail earns the reputation that gets it deleted. */
const REACH_IT_THROUGH_THE_CHOKE_POINT =
  'If something genuinely needs the privileged key, it belongs behind src/lib/auth/ — the one ' +
  'directory this rule exempts, and where a service-role client would live. Be aware that ' +
  'importing that directory from a route is ALSO blocked right now, by a separate rule ' +
  '(Invariant A) that forbids any module outside it from importing into it, and whose failure ' +
  'message is about auth billing rather than about this. That is not an oversight to work ' +
  'around: there is no privileged consumer in this codebase yet, and the first genuine one is ' +
  'the trigger for revisiting Invariant A rather than for quietly widening it. See the ' +
  'all-caps paragraph in checkAnonymousReadPath in tests/anonymous-read-path.test.ts, which ' +
  'says what has to be solved first and what the acceptance test for that work is.';

/** Said in the failure itself because the alternative is somebody spending an afternoon
 *  concluding the check is broken. See the header comment for why it is not worth fixing. */
const A_COMMENT_IS_A_REFERENCE =
  'This check reads text and cannot tell code from a comment or from a string literal, so a ' +
  'comment that spells the variable out fails exactly as an assignment does. Describe the key ' +
  'instead of naming it. That is a deliberate choice rather than an oversight: not counting ' +
  'comments means depending on a parser being correct, and this guardrail has to stay simpler ' +
  'than the thing it guards.';

/** The line number that points at text nobody can open, which is the case whoever hits
 *  this is least equipped to act on.
 *
 *  Gated on the REFS, not on the module. The obvious gate — "this module has no file on
 *  disk" — is wrong in the one direction that hurts: a module CAN have a file, have a
 *  perfectly clean file, and still carry a reference that exists only in what the plugin
 *  chain produced. That prints a real-looking path:line, with no caveat, whose line number
 *  came from different text entirely; measured against the fixture's generated-only case,
 *  the drift is several lines and the file's line there says nothing at all. The reader
 *  trusts it and goes looking. So the caveat follows the provenance of the reference. */
const GENERATED_MODULE_EXPLANATION =
  'At least one line above was found in the module as the BUILD TRANSFORMED IT, not in a file ' +
  'in this repository — so that line number refers to generated text and there is nothing to ' +
  'open at it. Grepping src/ will find nothing. Either the module itself is generated, or a ' +
  'plugin injected the reference into it: look at astro.config.mjs, the integrations it lists ' +
  'and any `vite.define` there, rather than for a file.';

/** Named in the failure so the reader can tell "this rule does not know my spelling" from
 *  "this rule does not care", without going and reading the checker. */
const WHAT_THIS_RULE_MATCHES =
  'This rule is name-bound. It matches exactly these spellings and nothing else: ' +
  PRIVILEGED_KEY_PATTERNS.map((p) => p.name).join('; ') +
  '. If the key ships under a name that is not in that list, add it to ' +
  'PRIVILEGED_KEY_PATTERNS in tests/anonymous-read-path.test.ts — a name-bound rule that does ' +
  'not know the name in use is not a weaker guardrail, it is a permanently green one.';

function serviceRoleViolationMessage(root: string, module: string, refs: ServiceRoleRef[]): string {
  const rel = renderId(root, module);
  const lines = [
    `${rel} names a Supabase privileged key, which no module outside src/lib/auth/ may do:`,
    ...refs.map((ref) => `    ${rel}:${ref.line}\n        ${ref.snippet}`),
    '',
  ];
  if (refs.some((ref) => ref.source === 'transform')) {
    lines.push(GENERATED_MODULE_EXPLANATION, '');
  }
  lines.push(
    SERVICE_ROLE_ARGUMENT,
    '',
    ANON_KEY_IS_THE_RIGHT_KEY,
    '',
    REACH_IT_THROUGH_THE_CHOKE_POINT,
    '',
    A_COMMENT_IS_A_REFERENCE,
    '',
    WHAT_THIS_RULE_MATCHES,
  );
  return lines.join('\n');
}

/** True when `id` resolves inside a package this rule has been told to leave alone. Split
 *  on the LAST `node_modules/` segment so a nested dependency is matched by its own name
 *  rather than by its host's, and scoped-package names (`@scope/pkg`) are kept whole. */
function isExemptPackage(id: string, packages: readonly string[]): boolean {
  const marker = id.lastIndexOf('node_modules/');
  if (marker === -1) return false;
  const after = id.slice(marker + 'node_modules/'.length);
  return packages.some((pkg) => after === pkg || after.startsWith(`${pkg}/`));
}

/**
 * Invariant C, as a pure function over an already-built graph: no module in the graph
 * outside `<root>/src/lib/auth/` may name a privileged key in any of the spellings
 * PRIVILEGED_KEY_PATTERNS lists.
 *
 * The graph is what makes this different from `grep -r` over the working tree. Grep
 * answers "does this string appear somewhere in this checkout", which is both too wide (a
 * script under scripts/, a doc, this test file, a deleted-but-not-removed file) and too
 * narrow (it never looks at the dependency that ships alongside your code). Iterating the
 * graph answers the question that matters — does anything that SHIPS name this key — and
 * it is the same union of the three Rollup passes both other invariants use, so a module
 * that only the client pass resolves is in scope here too. What it is NOT is sight through
 * indirection: this is still a text scan, and re-exporting the value under another name
 * hides it from here exactly as it would from grep. The graph chooses the haystack.
 *
 * The scoping is the whole graph rather than first-party src/, for Invariant B's reason
 * restated: a dependency holding the key ships it exactly as first-party code would, and
 * the fact that nobody here wrote the line makes it harder to notice, not cheaper. That is
 * only affordable because it was measured — no pattern in the set matches anything in
 * either build graph today, and neither @supabase/supabase-js@2.112.2 nor
 * @supabase/ssr@0.12.4 contains the string SERVICE_ROLE anywhere, so adding them (Ref 49)
 * does not turn this red on contact and force somebody to gut it. If a future dependency
 * legitimately names the key, put it in PACKAGES_EXEMPT_FROM_KEY_SCAN with a reason; do
 * not narrow the rule to src/.
 *
 * What is iterated is the UNION of the graph's keys and the transform record's, not the
 * graph's alone. They are not the same set: this build has one id the hook fires for that
 * never becomes a graph key (`\0rolldown/runtime.js`), and iterating only the graph would
 * discard a finding from any such module in silence — the worst possible way to lose one.
 * Anything the hook saw naming a key is reported whether or not the graph kept it.
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
 *   or otherwise untransformed one. Its transform record is absent, which is
 *   indistinguishable from "scanned and clean", and the file scan is what keeps that from
 *   being a silent gap. What remains uncovered is a module with no file on disk that was
 *   never transformed: there is no text for it anywhere. `partitionScannability` below is
 *   what makes that set observable rather than imaginary, and the real-site block asserts
 *   it stays small and known.
 *
 *   The two sources are a union for DETECTION and a preference for DISPLAY: a module is
 *   reported if either found something, and the file's lines are shown when the file has
 *   any. A reference present only in the transformed text — an inlined define, a generated
 *   wrapper, an injecting plugin — is still reported, tagged `source: 'transform'`, which
 *   is what puts the caveat in the message. That tag is per-ref rather than per-module
 *   precisely because a module can have a clean file AND a dirty transform.
 */
function checkServiceRoleKey(build: BuildGraph, root: string): ServiceRoleViolation[] {
  const authDir = chokePointDir(root);
  const violations: ServiceRoleViolation[] = [];

  for (const id of new Set([...build.graph.keys(), ...build.serviceRoleRefs.keys()])) {
    if (id.startsWith(authDir)) continue;
    if (isExemptPackage(id, PACKAGES_EXEMPT_FROM_KEY_SCAN)) continue;

    const fileText = readFileForId(id);
    const onDisk = fileText === null ? [] : scanForPrivilegedKey(fileText, 'file');
    const refs = onDisk.length > 0 ? onDisk : (build.serviceRoleRefs.get(id) ?? []);
    if (refs.length === 0) continue;

    violations.push({ module: id, refs, message: serviceRoleViolationMessage(root, id, refs) });
  }

  // Sorted for the same reason the other checkers sort: Map iteration order here is
  // Rollup's module-discovery order, stable enough in practice to lull you and unstable
  // enough to produce a diff nobody can review.
  return violations.sort((a, b) => a.module.localeCompare(b.module));
}

/** Ids Invariant C is allowed to have no text for. Both entries are runtime-provided
 *  module namespaces rather than code that ships: `cloudflare:workers` is workerd's own
 *  binding module, `node:*` are Node builtins. Neither has a file, neither is ever handed
 *  to a `transform` hook, and neither can contain a project's secret. Anything ELSE
 *  landing in the unscanned set is a real dependency that the check is silently not
 *  reading, and must turn the build red so somebody decides about it. */
const UNSCANNED_ID_ALLOWLIST: readonly string[] = ['cloudflare:workers'];

function isAllowedUnscannedId(id: string): boolean {
  return UNSCANNED_ID_ALLOWLIST.includes(id) || id.startsWith('node:');
}

/**
 * Splits the graph into the modules Invariant C actually reads and the ones it cannot,
 * because the silent version of that second set is how this check quietly stops covering
 * dependencies.
 *
 * The mechanism: when a Rollup pass externalises a dependency, its graph key is the bare
 * specifier ("vue", "cookie", "devalue"). `readFileForId` returns null for it AND the
 * transform hook never fired for it, so it contributes no refs — which is byte-for-byte
 * indistinguishable from a module that was read and found clean. Dependency coverage
 * therefore rests entirely on @astrojs/cloudflare choosing to bundle rather than
 * externalise. One `vite.ssr.external` entry, or an adapter upgrade that changes its mind,
 * moves an arbitrary number of packages into "reads nothing" with every test still green.
 *
 * Measured at the time of writing: 1 unscanned id in the real build (`cloudflare:workers`)
 * and 12 in the fixture's — eleven externalised packages and one Node builtin, every one of
 * them a bare specifier. The real build's set is asserted against UNSCANNED_ID_ALLOWLIST, so
 * growth there is a red build and a decision rather than a silent loss of coverage.
 */
function partitionScannability(build: BuildGraph): { scanned: string[]; unscanned: string[] } {
  const scanned: string[] = [];
  const unscanned: string[] = [];
  for (const id of build.graph.keys()) {
    if (readFileForId(id) !== null || build.transformedIds.has(id)) scanned.push(id);
    else unscanned.push(id);
  }
  return { scanned, unscanned };
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
// Invariants A, B and C, plus the emitted-HTML scan — against the real site
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
    // And so does half of Invariant C, through a different mechanism the graph assertion
    // above would not notice. The graph comes from `buildEnd`; the transformed text
    // Invariant C also reads comes from `transform`. A hook renamed, mis-ordered, or
    // dropped by a Vite version bump leaves the graph fully populated and
    // `serviceRoleRefs` permanently empty. That does NOT make the whole invariant vacuous
    // — file-backed modules are still scanned from their files, which is most of the graph
    // — but it silently removes the only text there is for a module with no file, and the
    // only text there is for a reference injected during the build rather than written in
    // a file (see the generated-only fixture case). Both are exactly the cases nobody
    // would think to check by hand.
    //
    // `> 0` would be satisfied by the hook firing for one module out of 2,070, which is
    // indistinguishable from broken. The assertion is proportional to the graph instead,
    // and names one module that must specifically be in there.
    expect(realBuild.transformedIds.size).toBeGreaterThan(realBuild.graph.size * 0.9);
    expect(realBuild.transformedIds.has(indexEntry!)).toBe(true);
  });

  /**
   * The other silent way this check stops covering things, and the reason it is asserted
   * rather than described: a module the scan has no text for at all contributes no
   * findings, which is byte-for-byte what a module that was read and found clean
   * contributes. See partitionScannability for the mechanism.
   *
   * Today exactly one id is in that state — `cloudflare:workers`, workerd's own binding
   * namespace, which has no file and can hold nobody's secret. Every real dependency is
   * bundled and therefore read. That is a property of how @astrojs/cloudflare happens to
   * be configured, not a guarantee: a `vite.ssr.external` entry or an adapter upgrade can
   * move packages into the unscanned set wholesale, with every assertion in this file
   * still green. So the set is pinned to an allow-list.
   *
   * If this fails, the answer is NOT to add the new id to UNSCANNED_ID_ALLOWLIST because
   * the build is red. The allow-list is for things that cannot contain a key. A real
   * package landing there means Invariant C stopped covering it, and the decision to make
   * is whether that is acceptable — which is the decision this assertion exists to force.
   */
  it('every module in the real graph is one Invariant C can actually read', () => {
    const { scanned, unscanned } = partitionScannability(realBuild);

    expect(unscanned.filter((id) => !isAllowedUnscannedId(id))).toEqual([]);
    // Not vacuous in the other direction: an implementation that called everything
    // scanned would pass the line above.
    expect(scanned.length + unscanned.length).toBe(realBuild.graph.size);
    expect(scanned.length).toBeGreaterThan(realBuild.graph.size * 0.9);
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
  // decided auth and data provider, so the names it looks for are ones somebody on this
  // project will genuinely reach for.
  //
  // Why it is green today, stated exactly, because the obvious explanation is wrong and
  // believing it would hide a real gap. Several files in this repository DO name the key:
  // this test file names it a couple of dozen times, four fixture files under
  // tests/fixtures/ do, and src/lib/auth/index.ts does. None of them is why this passes.
  // What makes it pass is that none of them is in the real build graph — tests and
  // fixtures are not built, and nothing in the site imports src/lib/auth/ at all, so the
  // choke point is not a module in this build. The `startsWith(authDir)` exemption is not
  // load-bearing here: delete it and this assertion stays green. It is exercised by the
  // fixture, whose src/lib/auth/service-role.ts is in that build's graph and does name the
  // key, and where deleting the exemption goes red.
  //
  // The consequence to keep in mind: this assertion will do real work for the first time
  // when the first module that ships names the key, and it must not be softened before
  // then on the grounds that it has never caught anything.
  it('nothing outside src/lib/auth/ names a Supabase privileged key', () => {
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

/** Every module the fixture expects Invariant C to report, in the order the checker sorts
 *  them — one per spelling in PRIVILEGED_KEY_PATTERNS, plus the destructured-binding case
 *  and the generated-only case. Everything else in that build must stay off this list:
 *  the anon-key page, the two runtime-assembled names, the pages that merely import a
 *  module holding a key, the module inside the choke point, and every node_modules module
 *  the build pulls in (the large majority of the graph — see the scannability test below
 *  for what "every" does and does not cover there). None of these imports the choke point,
 *  which is what keeps FIXTURE_VIOLATING_IMPORTERS at eight. */
const FIXTURE_SERVICE_ROLE_MODULES = [
  'src/lib/generated-only-key.ts',
  'src/lib/service-role-config.ts',
  'src/pages/pasted-secret.astro',
  'src/pages/service-role-import-meta.astro',
  'src/pages/service-role-process-env.astro',
  'src/pages/service-role-unprefixed.astro',
  'src/pages/supabase-secret-key.astro',
];

describe('the checkers, run against a fixture that actually violates Invariants A and C', () => {
  let fixtureBuild: BuildGraph;
  let fixtureBuildFailure: unknown;
  const rel = (id: string) => relative(fixtureRoot, id);
  const find = (importer: string) =>
    checkAnonymousReadPath(fixtureBuild, fixtureRoot).find((v) => rel(v.importer) === importer);

  // Captured rather than thrown, for the reason spelled out on the real site's beforeAll:
  // a throwing beforeAll makes vitest report every test in this describe as `skipped`, and
  // "N passed | M skipped" reads as a suite with some optional cases in it. That reading is
  // worse here than it is up there. This block holds every self-test of every checker —
  // it is the entire proof that any of them can fail at all — so a summary line that makes
  // its absence look routine is precisely the wrong signal. The build also fails here for
  // reasons that have nothing to do with auth: this fixture has its own astro.config.mjs
  // with its own plugin, and it is built by the same workerd-backed adapter.
  beforeAll(async () => {
    try {
      fixtureBuild = await buildModuleGraph(fixtureRoot);
    } catch (error) {
      fixtureBuildFailure = error;
    }
  }, 60_000);

  // Turns that skip into one unmissable failure that names the cause.
  it('built the fixture, so the self-tests below actually ran', () => {
    expect(fixtureBuildFailure).toBeUndefined();
    expect(fixtureBuild).toBeDefined();
  });

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
    //
    // A miss THROWS rather than returning 0. Returning 0 turns "the fixture no longer
    // contains the line this assertion is about" into an assertion about line 0, which
    // then fails somewhere else with a number nobody can trace back to here — or, worse,
    // passes against a message that happens to render `:0`.
    const sourceLineOf = (relPath: string, needle: string) => {
      const index = readFileSync(id(relPath), 'utf8')
        .split('\n')
        .findIndex((line) => line.includes(needle));
      if (index === -1) {
        throw new Error(
          `No line of ${relPath} contains ${JSON.stringify(needle)}. The fixture changed ` +
            'under an assertion that is about that exact line; fix the assertion rather ' +
            'than deleting it.',
        );
      }
      return index + 1;
    };

    it('flags a page that reads the key off import.meta.env', () => {
      const page = 'src/pages/service-role-import-meta.astro';
      const violation = findRef(page);

      expect(violation).toBeDefined();
      expect(violation!.refs).toEqual([
        {
          line: sourceLineOf(page, 'import.meta.env.SUPABASE_SERVICE_ROLE_KEY'),
          snippet: 'const serviceRoleKey = import.meta.env.SUPABASE_SERVICE_ROLE_KEY;',
          source: 'file',
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
          source: 'file',
        },
      ]);
    });

    // Shape #4: the same key without its `SUPABASE_` prefix. The prefix says which service
    // an environment variable belongs to; it is not part of the key's identity, and a rule
    // that only knew the prefixed spelling would read this page and find nothing while the
    // page shipped the credential.
    it('flags the service-role key named without its SUPABASE_ prefix', () => {
      const page = 'src/pages/service-role-unprefixed.astro';
      const violation = findRef(page);

      expect(violation).toBeDefined();
      expect(violation!.refs).toEqual([
        {
          line: sourceLineOf(page, 'import.meta.env.SERVICE_ROLE_KEY'),
          snippet: 'const serviceRoleKey = import.meta.env.SERVICE_ROLE_KEY;',
          source: 'file',
        },
      ]);
    });

    // Shape #5: Supabase's newer name for the same key. Both names are in circulation, and
    // a rule that knew only the legacy one would go green the day this project adopted the
    // current one — silently, which is the failure mode a name-bound rule has.
    it('flags SUPABASE_SECRET_KEY, the newer name for the same privileged key', () => {
      const page = 'src/pages/supabase-secret-key.astro';
      const violation = findRef(page);

      expect(violation).toBeDefined();
      expect(violation!.refs).toEqual([
        {
          line: sourceLineOf(page, 'import.meta.env.SUPABASE_SECRET_KEY'),
          snippet: 'const secretKey = import.meta.env.SUPABASE_SECRET_KEY;',
          source: 'file',
        },
      ]);
    });

    /**
     * Shape #6: the VALUE, with no variable name anywhere near it. Every other pattern is
     * name-based, and a name-based rule cannot see the shortest path there is from "I need
     * this working locally" to a shipped credential — pasting the key into the call. The
     * `sb_secret_` prefix is what makes the value recognisable on its own.
     *
     * The second assertion is not decoration. A failure message goes into a CI log, and a
     * guardrail that prints the live key it has just found has published it further than
     * the commit did. So the matched text is masked before it is rendered, and the mask is
     * asserted here rather than left to whoever next edits the snippet code.
     */
    it('flags a pasted sb_secret_ value, and REDACTS it rather than printing it', () => {
      const page = 'src/pages/pasted-secret.astro';
      const violation = findRef(page);

      expect(violation).toBeDefined();
      expect(violation!.refs).toEqual([
        {
          line: sourceLineOf(page, "const privilegedKey = 'sb_secret_"),
          snippet: "const privilegedKey = 'sb_secret_REDACTED';",
          source: 'file',
        },
      ]);
      expect(violation!.message).not.toContain('EXAMPLE_NOT_A_REAL_KEY');
    });

    /**
     * Shape #7, and the only case here where the file is not the evidence: the module's
     * own file is clean, and the reference is put into its transformed text by a plugin
     * registered in the fixture's astro.config.mjs. That models the real mechanisms —
     * `vite.define` substitution, an integration's generated wrapper, codegen — and it is
     * the case that fails if either of two plausible-looking simplifications is made.
     *
     * Detect from the file only, and this module is clean forever. Gate the "there is
     * nothing to open at that line" caveat on the MODULE having no file on disk — which is
     * what it used to do — and this violation prints a confident `path:line` into a file
     * whose line at that number says something else entirely, with no warning at all.
     */
    it('flags a reference that exists only in the transformed text, with the caveat attached', () => {
      const module = 'src/lib/generated-only-key.ts';
      const violation = findRef(module);

      // The premise: the file on disk really is clean, so this is not the file scan.
      expect(scanForPrivilegedKey(readFileSync(id(module), 'utf8'), 'file')).toEqual([]);

      expect(violation).toBeDefined();
      expect(violation!.refs.map((ref) => ref.source)).toEqual(['transform']);
      expect(violation!.refs.map((ref) => ref.snippet)).toEqual([
        'const injectedPrivilegedKey = process.env.SUPABASE_SERVICE_ROLE_KEY;',
      ]);
      expect(violation!.message).toContain('BUILD TRANSFORMED IT');

      // The page that imports it is clean and stays unreported.
      expect(findRef('src/pages/generated-only-key.astro')).toBeUndefined();
    });

    // The other side of that gate: a violation whose refs all came from a real file must
    // NOT carry the caveat, or it says "there is nothing to open at that line" about a
    // line the reader can open, and the caveat stops meaning anything.
    it('does not attach the generated-text caveat to a reference read from a file', () => {
      const message = findRef('src/pages/service-role-import-meta.astro')!.message;
      expect(message).not.toContain('BUILD TRANSFORMED IT');
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
     * That module holds two spellings, and the second one is the one an earlier version of
     * this file got wrong. It claimed `'SUPABASE_' + 'SERVICE_ROLE_KEY'` was CAUGHT because
     * esbuild folds adjacent string literals during transform. This project builds with
     * rolldown and no folding happens: inserting that exact expression into the real site
     * left the whole suite green under the then-current single-pattern rule. So the third
     * assertion here is the corrected claim, made executable — a concatenation split where
     * neither fragment is itself a banned spelling produces no match anywhere, in the file
     * or in the transformed text.
     *
     * Whoever narrows this boundary later: the case to beat is this file. Whoever widens
     * it — a regex loose enough to match `SERVICE_ROLE` in fragments — should know that is
     * how a guardrail starts failing on prose and gets deleted.
     */
    it('does NOT flag a key name assembled at runtime, by join or by concatenation', () => {
      const module = 'src/lib/runtime-named-key.ts';

      expect(fixtureBuild.graph.has(id(module))).toBe(true);
      expect(fixtureBuild.transformedIds.has(id(module))).toBe(true);
      expect(findRef(module)).toBeUndefined();

      // Both spellings are genuinely present in the module, so "not flagged" is not
      // "the fixture stopped containing the case".
      const text = readFileSync(id(module), 'utf8');
      expect(text).toContain("SEGMENTS.join('_')");
      expect(text).toContain("'SUPABASE_SERVICE' + '_ROLE_KEY'");
      // And the build did not fold that concatenation back into a contiguous name: if it
      // ever starts doing so, the transform record picks it up and this goes red, which
      // is the signal that the boundary has moved and this comment needs rewriting.
      expect(fixtureBuild.serviceRoleRefs.get(id(module))).toBeUndefined();
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
    // module really does name the key, and it is still not reported. Delete the
    // `startsWith(authDir)` skip and this goes red.
    //
    // The evidence is taken through the channel the checker itself uses — scanning the
    // module's file, which is what it prefers whenever there is a file — rather than
    // through `serviceRoleRefs`, which for a file-backed module the checker never consults.
    // Asserting through a channel the code under test does not use proves the fixture is
    // dirty without proving the checker would have noticed.
    it('does NOT flag a module inside src/lib/auth/ that names the key', () => {
      const module = 'src/lib/auth/service-role.ts';

      expect(fixtureBuild.graph.has(id(module))).toBe(true);
      expect(scanForPrivilegedKey(readFileSync(id(module), 'utf8'), 'file').length).toBeGreaterThan(
        0,
      );
      expect(findRef(module)).toBeUndefined();
    });

    // The other half of "not vacuous", and the assertion that fails if the scan ever
    // starts matching something it should not — a fragment, a comment in a dependency, a
    // page that merely imports a module holding the key.
    //
    // It covers every id in the graph, node_modules included, which is what makes it the
    // evidence that the broad scoping is affordable. It is NOT evidence that every one of
    // those dependencies was read: an externalised dependency is in the graph as a bare
    // specifier with no text behind it at all, and contributes nothing to this list for
    // that reason rather than for being clean. The test below is the one that measures
    // that set.
    it('reports exactly those modules, no more and no fewer', () => {
      const violations = checkServiceRoleKey(fixtureBuild, fixtureRoot);
      expect(violations.map((v) => rel(v.module))).toEqual(FIXTURE_SERVICE_ROLE_MODULES);
    });

    /**
     * The measurement the test above is not. This fixture's build externalises a dozen or
     * so packages (twelve ids at the time of writing, one of which is a Node builtin), so
     * their graph ids are bare specifiers with no file and no transform record — the scan
     * has no text for them whatsoever, and they are silently absent from every result
     * rather than present and clean.
     *
     * Pinned here as a property, not a count, because the count moves with every adapter
     * and Astro version: they are all bare specifiers, none is a first-party file, and the
     * set is a small minority of the graph. The real-site block holds the assertion with
     * teeth — there, this set must stay inside an explicit allow-list.
     */
    it('has modules it cannot read at all, and every one of them is a bare specifier', () => {
      const { scanned, unscanned } = partitionScannability(fixtureBuild);

      expect(unscanned.length).toBeGreaterThan(0);
      expect(unscanned.filter((moduleId) => isAbsolute(moduleId))).toEqual([]);
      expect(scanned.length + unscanned.length).toBe(fixtureBuild.graph.size);
      expect(scanned.length).toBeGreaterThan(unscanned.length);
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

      // Anchored on the whole rendered location line, indentation and newline included.
      // A bare `toContain('…:1')` is satisfied by a rendered `…:11`, so the loose form
      // passes for a message pointing at the wrong line — the one thing this assertion
      // exists to rule out.
      expect(message).toContain(
        `    ${page}:${sourceLineOf(page, 'import.meta.env.SUPABASE_SERVICE_ROLE_KEY')}\n`,
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

      // The advice must not send the reader into a different red build without warning:
      // moving the key behind src/lib/auth/ and importing it from a route trades this
      // failure for an Invariant A failure about a $6,000/month auth bill, which has
      // nothing to do with what they just did.
      expect(message).toContain('is ALSO blocked right now');
      expect(message).toContain('Invariant A');
      expect(message).toContain('checkAnonymousReadPath');

      // And it must say which spellings it knows, because "this rule does not know my
      // key's name" and "this rule does not care about my key" look identical otherwise.
      expect(message).toContain('name-bound');
      expect(message).toContain('PRIVILEGED_KEY_PATTERNS');
      expect(message).toContain('SUPABASE_SECRET_KEY');
    });
  });
});

describe('the parts of Invariant C a real build does not currently exercise', () => {
  /**
   * `\0` is Rollup's marker for a module with no file, and the shape that matters here is
   * `\0` followed by an ABSOLUTE PATH — @rollup/plugin-commonjs emits exactly that for the
   * proxy module it wraps each CJS dependency in, so it arrives with the first CJS
   * dependency the graph acquires. Nothing in either build graph is CJS today, which is
   * the only reason this has not been hit.
   *
   * Stripping the marker before the syscall — which is what this used to do — crashes the
   * whole check with ERR_INVALID_ARG_VALUE: `throwIfNoEntry: false` suppresses ENOENT, not
   * a null byte in a path. Returning null is not merely the way to avoid the crash, it is
   * the correct answer: that id denotes a generated wrapper AROUND the file, not the file,
   * so the file's text and line numbers do not describe it. Its text comes from the
   * transform record like any other virtual module's, or from nowhere.
   */
  it('returns no file text for a \\0-prefixed absolute id instead of throwing on the NUL', () => {
    const realFile = join(repoRoot, 'src', 'lib', 'auth', 'index.ts');

    expect(readFileForId(realFile)).toContain('choke point');
    expect(readFileForId(`\0${realFile}`)).toBeNull();
    expect(hasNoFileOnDisk(`\0${realFile}`)).toBe(true);
  });

  /**
   * The transform record and the graph are not the same set of ids, and iterating only the
   * graph discards findings from the difference in silence. It is not hypothetical: this
   * build has `\0rolldown/runtime.js`, which the hook fires for and which never becomes a
   * graph key. It happens to be clean, so nothing is lost today — but "we lose nothing
   * because the module we cannot see is clean" is an argument that only works until it
   * doesn't, and there is no assertion anywhere that it stays clean.
   *
   * A real build cannot demonstrate this, because making it demonstrate it would mean
   * finding a module that is both invisible to the graph and dirty. A synthetic BuildGraph
   * can say it directly.
   */
  it('reports a module the transform hook saw that never became a graph key', () => {
    const build: BuildGraph = {
      graph: new Map(),
      pageEntries: new Map(),
      emittedHtml: new Map(),
      serviceRoleRefs: new Map([
        [
          '\0some-plugin/runtime.js',
          [{ line: 4, snippet: 'const k = SUPABASE_SERVICE_ROLE_KEY;', source: 'transform' }],
        ],
      ]),
      transformedIds: new Set(['\0some-plugin/runtime.js']),
    };

    const violations = checkServiceRoleKey(build, repoRoot);

    expect(violations.map((v) => v.module)).toEqual(['\0some-plugin/runtime.js']);
    // Rendered without the NUL, which prints as a stray blank and makes a failure message
    // look mis-indented, and with the caveat, because the ref came from transformed text.
    expect(violations[0].message).toContain('some-plugin/runtime.js:4');
    expect(violations[0].message).not.toContain('\0');
    expect(violations[0].message).toContain('BUILD TRANSFORMED IT');
  });

  // The named-package escape hatch both docstrings promise. It was documented long before
  // it existed, which meant the remedy offered to somebody staring at a red build was to
  // do a thing the code had no way of doing.
  it('exempts a dependency listed in the package allow-list, by package and not by substring', () => {
    const inside = join(repoRoot, 'node_modules', 'some-admin-sdk', 'dist', 'env.js');
    const lookalike = join(repoRoot, 'node_modules', 'some-admin-sdk-fork', 'dist', 'env.js');

    expect(isExemptPackage(inside, ['some-admin-sdk'])).toBe(true);
    expect(isExemptPackage(lookalike, ['some-admin-sdk'])).toBe(false);
    expect(isExemptPackage(join(repoRoot, 'src', 'pages', 'index.astro'), ['some-admin-sdk'])).toBe(
      false,
    );
    // Nothing is exempt today, and the list is meant to stay a list of named exceptions.
    expect(PACKAGES_EXEMPT_FROM_KEY_SCAN).toEqual([]);
  });

  // A minified dependency is one line of several hundred kilobytes. Slicing from column 0
  // — which is what this used to do — yields a 120-character snippet from the start of
  // that line, which does not contain the identifier the message says was found on it.
  it('windows a long line around the match rather than slicing from its start', () => {
    const line = `${'x'.repeat(4000)}const k=process.env.SUPABASE_SERVICE_ROLE_KEY;${'y'.repeat(4000)}`;
    const [ref] = scanForPrivilegedKey(line, 'file');

    expect(ref.snippet).toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(ref.snippet.length).toBeLessThanOrEqual(SNIPPET_LIMIT + 2);
    expect(ref.snippet.startsWith('…')).toBe(true);
    expect(ref.snippet.endsWith('…')).toBe(true);
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
