import { describe, it, expect, afterEach, afterAll, beforeAll } from 'vitest';
import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
  chmodSync,
  existsSync,
  statSync,
  readdirSync,
} from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';

/**
 * The deploy pipeline.
 *
 * This file replaces tests/deploy-origin-lock.test.ts, which pinned the Azure Static
 * Web Apps release: a forwardingGateway config written into the artifact after the
 * build, and a post-release probe proving that *.azurestaticapps.net refused traffic
 * that had not come through Cloudflare. That whole apparatus existed because Azure
 * published a second, permanent, public hostname that could not be turned off. On
 * Workers `workers_dev: false` means the second hostname is never created, so the
 * lock has nothing to lock and the scripts are gone.
 *
 * What is NOT gone is the reason that suite was expensive. Every assertion there was
 * added because a plausible edit had silently disabled something, and two rounds of
 * review found the same failure mode both times: whatever was checked by substring
 * could be broken while the suite stayed green. The invariants below are the same
 * ones, restated against the mechanism that replaced them —
 *
 *   - the tests gate the artifact, not just the merge button
 *   - the step that decides WHICH environment ships is set explicitly, in both
 *     directions, and cannot be defaulted into
 *   - production is not cancellable mid-release
 *   - the deploy tool's version cannot drift from the one the build used
 *   - nothing re-publishes the site on a hostname nobody is watching
 *
 * — plus the one genuinely new failure this architecture makes possible, which is
 * the staging workflow deploying to the production Worker.
 */

const repoPath = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url));

interface Step {
  name?: string;
  run?: string;
  uses?: string;
  id?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
  if?: string;
  'continue-on-error'?: boolean;
  'timeout-minutes'?: number;
}

interface Workflow {
  on?: unknown;
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
  jobs: Record<
    string,
    { steps?: Step[]; environment?: string | { name?: string; url?: string }; if?: string }
  >;
}

const workflow = (name: string): Workflow =>
  parse(readFileSync(repoPath(`.github/workflows/${name}`), 'utf8'));

/** By name. `Object.values(jobs)[0]` silently relocates every assertion to the wrong
 *  job the moment a workflow gains one ahead of the deploy job. */
function stepsOf(name: string, jobName: string): Step[] {
  const job = workflow(name).jobs?.[jobName];
  if (!job) throw new Error(`No job "${jobName}" in ${name}`);
  return job.steps ?? [];
}

/** Comment lines are stripped before matching, so a step that *documents* something is
 *  never mistaken for one that does it, and a decoy comment satisfies nothing. */
const executable = (run: string | undefined) =>
  (run ?? '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n');

const isBuild = (s: Step) => s.name === 'Build';
const isTest = (s: Step) => executable(s.run).trim() === 'npm test';
const isWranglerAction = (s: Step) => (s.uses ?? '').startsWith('cloudflare/wrangler-action');
const isMigrate = (s: Step) => /(^|\/|\s)supabase(\.sh)? db push\b/.test(executable(s.run));
const isVerify = (s: Step) => executable(s.run).includes('verify-release.sh');

/**
 * The two deploy workflows. There is no third: per-pull-request previews were
 * removed deliberately — staging.packsheet.io auto-deploys from the staging branch
 * and everything else is exercised locally.
 */
const DEPLOYS = [
  { file: 'deploy-production.yml', job: 'deploy', env: 'production', worker: 'packsheet-io' },
  { file: 'deploy-staging.yml', job: 'deploy', env: 'staging', worker: 'packsheet-io-staging' },
] as const;

// ---------------------------------------------------------------------------
// wrangler.jsonc — the settings that decide what is publicly reachable
// ---------------------------------------------------------------------------

describe('wrangler.jsonc', () => {
  /**
   * Parsed, not read as text, so a comment that *says* workers_dev is false cannot
   * satisfy an assertion about the value.
   *
   * With a real JSONC parser rather than a regex that strips `//` lines and hands the
   * rest to JSON.parse. That shortcut works right up until prettier reformats the
   * file: `trailingComma: 'all'` is legal JSONC and legal wrangler, and it made this
   * whole describe block throw at collection time — 53 assertions about what is
   * publicly reachable, reported as one failure in a file nobody had edited.
   */
  const config = (() => {
    const errors: ParseError[] = [];
    const parsed = parseJsonc(readFileSync(repoPath('wrangler.jsonc'), 'utf8'), errors, {
      allowTrailingComma: true,
    });
    // Silent recovery is this parser's default: it returns a partial object and puts
    // the problems in `errors`. Ignoring them means a typo'd wrangler.jsonc reads here
    // as "the key is absent", and an absent key would fail these tests for entirely
    // the wrong reason.
    if (errors.length) {
      throw new Error(
        `wrangler.jsonc did not parse: ${errors.map((e) => `code ${e.error} at ${e.offset}`).join(', ')}`,
      );
    }
    return parsed as {
      compatibility_date?: string;
      env?: Record<
        string,
        {
          name?: string;
          workers_dev?: boolean;
          preview_urls?: boolean;
          routes?: { pattern?: string; custom_domain?: boolean }[];
          assets?: { directory?: string; not_found_handling?: string };
        }
      >;
    };
  })();

  it('defines exactly the two environments the workflows deploy', () => {
    expect(Object.keys(config.env ?? {}).sort()).toEqual(['production', 'staging']);
  });

  it.each(DEPLOYS)('names the $env Worker $worker', ({ env, worker }) => {
    expect(config.env?.[env]?.name).toBe(worker);
  });

  // The whole of Ref 46, reduced to one boolean. `true` republishes the site on
  // <worker>.packsheet-io.workers.dev: a second public hostname serving the same
  // build, outside the zone, with no WAF, no cache rules and no robots policy — the
  // exact problem that cost four releases on Azure, re-created by one keystroke.
  it.each(DEPLOYS)('never publishes the $env Worker on workers.dev', ({ env }) => {
    expect(config.env?.[env]?.workers_dev).toBe(false);
  });

  // Production must have exactly one URL. A version preview URL on production is an
  // unlisted, un-Access-gated copy of the live site.
  it('does not enable version preview URLs on production', () => {
    expect(config.env?.production?.preview_urls).toBe(false);
  });

  // Off on staging too, now that per-PR previews are gone. Turning it back on
  // republishes every uploaded version at
  // <version>-packsheet-io-staging.packsheet-io.workers.dev — a public hostname, since
  // the Cloudflare Access application that used to cover those URLs was deleted with
  // the workflow. That is the Ref 46 shape of problem arriving through a different door.
  it('does not enable version preview URLs on staging either', () => {
    expect(config.env?.staging?.preview_urls).toBe(false);
  });

  // The SPA fallback answers 200 with the home page for every unknown URL. Once
  // /p/<id> exists, a share link to a deleted pack would render the landing page
  // under a 200 — a bad read, and a search-indexable duplicate of the home page at
  // unlimited URLs.
  it.each(DEPLOYS)('serves a real 404 rather than the SPA fallback on $env', ({ env }) => {
    expect(config.env?.[env]?.assets?.not_found_handling).toBe('404-page');
  });

  it.each(DEPLOYS)('points $env at the directory astro actually builds', ({ env }) => {
    expect(config.env?.[env]?.assets?.directory).toBe('./dist/client');
  });

  // A moving compatibility date means the runtime under a release is not the one the
  // build ran against.
  it('pins a compatibility date rather than tracking today', () => {
    expect(config.compatibility_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  // Deploying binds these hostnames and rewrites their DNS records. Crossing them
  // over — staging's Worker answering on packsheet.io — is a single-character edit
  // that no build, test or deploy would otherwise notice, and it puts a
  // `Disallow: /` build on the live site behind an Access gate that locks everyone
  // out of it.
  it.each([
    { env: 'production', hostname: 'packsheet.io' },
    { env: 'staging', hostname: 'staging.packsheet.io' },
  ])('binds $env to exactly $hostname', ({ env, hostname }) => {
    expect(config.env?.[env]?.routes).toEqual([{ pattern: hostname, custom_domain: true }]);
  });

  // A route pattern rather than a custom domain leaves the DNS record pointing
  // wherever it already pointed — which, mid-migration, is Azure.
  //
  // The `?? []` used to make this vacuous: deleting the `routes` key entirely left it
  // green, because a loop over nothing asserts nothing. It failed OPEN, which is the
  // wrong direction for a test whose subject is what the site is reachable on. The
  // length assertion is what stops that.
  it.each(DEPLOYS)('binds $env as a custom domain, not a route pattern', ({ env }) => {
    const routes = config.env?.[env]?.routes;
    expect(routes?.length).toBeGreaterThan(0);
    for (const route of routes ?? []) {
      expect(route.custom_domain).toBe(true);
    }
  });

  // www serves a 301 to the apex from a zone redirect rule. Binding it to a Worker
  // would make it serve the site instead — the same pages under two hostnames, which
  // is the duplicate-content half of the problem workers_dev: false solves.
  it('binds no www hostname to any Worker', () => {
    const patterns = Object.values(config.env ?? {}).flatMap((e) =>
      (e.routes ?? []).map((r) => r.pattern ?? ''),
    );
    expect(patterns.filter((p) => p.startsWith('www.'))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Which environment ships
// ---------------------------------------------------------------------------

describe('environment selection', () => {
  // The failure this exists for: deploy-staging.yml losing CLOUDFLARE_ENV. The build
  // then resolves wrangler.jsonc's top level, the deploy succeeds, and staging's
  // build — robots.txt Disallow and all — lands on the Worker serving packsheet.io.
  // Nothing in the run looks wrong.
  it.each(DEPLOYS)(
    'sets CLOUDFLARE_ENV=$env explicitly when building $file',
    ({ file, job, env }) => {
      const build = stepsOf(file, job).find(isBuild);
      expect(build).toBeDefined();
      expect(build?.env?.CLOUDFLARE_ENV).toBe(env);
    },
  );

  it.each(DEPLOYS)(
    'sets PUBLIC_SITE_ENV on $file so robots.txt is deliberate',
    ({ file, job, env }) => {
      expect(stepsOf(file, job).find(isBuild)?.env?.PUBLIC_SITE_ENV).toBe(env);
    },
  );

  // `wrangler deploy --env staging` reads plausibly and does nothing: by deploy time
  // the generated config has no environments left in it. Someone reaching for it has
  // misunderstood where the choice is made, and the deploy would go to production.
  it.each(DEPLOYS)(
    'does not try to select the environment at deploy time in $file',
    ({ file, job }) => {
      for (const step of stepsOf(file, job).filter(isWranglerAction)) {
        expect(step.with?.environment).toBeUndefined();
        expect(step.with?.command ?? '').not.toMatch(/--env\b|(^|\s)-e\s/);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// The deploy step
// ---------------------------------------------------------------------------

describe('deploy steps', () => {
  it.each(DEPLOYS)('$file deploys with wrangler-action', ({ file, job }) => {
    expect(stepsOf(file, job).filter(isWranglerAction)).toHaveLength(1);
  });

  // The build writes dist/client/wrangler.json and the deploy must read that file, not
  // the repository root config — which still carries both environments and would
  // deploy the wrong one, or nothing.
  it.each(DEPLOYS)('$file deploys the generated config, not the source one', ({ file, job }) => {
    const command = stepsOf(file, job).find(isWranglerAction)?.with?.command ?? '';
    expect(command).toContain('-c dist/client/wrangler.json');
    expect(command.trim().startsWith('deploy')).toBe(true);
  });

  // Two wrangler invocations — the build's and the deploy's — must agree about the
  // config format. Letting the action install its own latest is the drift .nvmrc
  // exists to prevent, one layer down.
  it.each(DEPLOYS)('$file pins the same wrangler the lockfile installs', ({ file, job }) => {
    const lock = JSON.parse(readFileSync(repoPath('package-lock.json'), 'utf8'));
    const installed = lock.packages['node_modules/wrangler'].version;
    expect(stepsOf(file, job).find(isWranglerAction)?.with?.wranglerVersion).toBe(installed);
  });

  // Credentials reach wrangler from the environment-scoped secret store, never from
  // the workflow body.
  it.each(DEPLOYS)('$file takes its credentials from secrets', ({ file, job }) => {
    const step = stepsOf(file, job).find(isWranglerAction);
    expect(step?.with?.apiToken).toBe('${{ secrets.CLOUDFLARE_API_TOKEN }}');
    expect(step?.with?.accountId).toBe('${{ secrets.CLOUDFLARE_ACCOUNT_ID }}');
  });

  // `continue-on-error` or an `if:` on the deploy turns a failed release into a green
  // tick. Both are plausible edits when someone is fighting a flaky run.
  it.each(DEPLOYS)(
    'does not let the deploy in $file fail silently or be skipped',
    ({ file, job }) => {
      const step = stepsOf(file, job).find(isWranglerAction);
      expect(step?.['continue-on-error']).toBeUndefined();
      expect(step?.if).toBeUndefined();
    },
  );
});

// ---------------------------------------------------------------------------
// Ordering — the tests gate the artifact, migrations gate the code
// ---------------------------------------------------------------------------

describe('step order', () => {
  // ci.yml runs on the same push and nothing makes a deploy wait for it. The required
  // status check protects the merge button; this step is what protects the artifact.
  it.each(DEPLOYS)('$file runs the tests before building', ({ file, job }) => {
    const steps = stepsOf(file, job);
    const test = steps.findIndex(isTest);
    const build = steps.findIndex(isBuild);
    expect(test).toBeGreaterThanOrEqual(0);
    expect(build).toBeGreaterThan(test);
  });

  // A release that deploys code before the schema it queries has a window in which the
  // site is live against a database that does not have the column yet.
  it.each(DEPLOYS)('$file migrates the database before deploying', ({ file, job }) => {
    const steps = stepsOf(file, job);
    const migrate = steps.findIndex(isMigrate);
    const deploy = steps.findIndex(isWranglerAction);
    expect(migrate).toBeGreaterThanOrEqual(0);
    expect(deploy).toBeGreaterThan(migrate);
  });

  it.each(DEPLOYS)('$file takes the project ref from a secret, not the file', ({ file, job }) => {
    const step = stepsOf(file, job).find(isMigrate);
    expect(step?.env?.PROJECT_REF).toBe('${{ secrets.SUPABASE_PROJECT_REF }}');
    expect(executable(step?.run)).not.toMatch(/[a-z]{20}/); // no bare project ref inline
  });
});

// ---------------------------------------------------------------------------
// Release safety
// ---------------------------------------------------------------------------

describe('production release safety', () => {
  // You cannot cancel an upload that has already happened. A run cancelled part-way
  // leaves a live release nobody watched go out, shown as a grey "cancelled" rather
  // than a failure, with no notification.
  it('does not cancel in-progress production deploys', () => {
    expect(workflow('deploy-production.yml').concurrency?.['cancel-in-progress']).toBe(false);
  });

  // Staging is the opposite case on purpose: superseded runs there are waste, and the
  // branch moves faster than the deploy.
  it('does cancel superseded staging deploys', () => {
    expect(workflow('deploy-staging.yml').concurrency?.['cancel-in-progress']).toBe(true);
  });

  // "Upload succeeded" is not "the site answers". The old suite made this point about
  // the origin lock; it is just as true of the release itself, and this is the one
  // deploy nobody re-runs casually.
  it('verifies the running site after deploying to production', () => {
    const steps = stepsOf('deploy-production.yml', 'deploy');
    expect(steps.findIndex(isVerify)).toBeGreaterThan(steps.findIndex(isWranglerAction));
  });

  // Unbounded curl retries can spend twenty minutes going red, all of it after the
  // release is already live.
  it('bounds the verify step', () => {
    expect(
      stepsOf('deploy-production.yml', 'deploy').find(isVerify)?.['timeout-minutes'],
    ).toBeGreaterThan(0);
  });

  // The same token-count check the deleted suite used on the origin-lock verifier, and
  // for the same reason: it is what makes the invocation immune to a `|| true` suffix,
  // an `echo` prefix, or a second command appended after it. Without it, all three
  // mutations pass.
  it('invokes the verifier directly, with exactly its one argument', () => {
    const args = executable(stepsOf('deploy-production.yml', 'deploy').find(isVerify)?.run)
      .trim()
      .split('\n')[0]
      .trim()
      .split(/\s+/);
    expect(args.length).toBe(2);
    expect(args[0]).toBe('scripts/verify-release.sh');
  });

  // The verifier must address PRODUCTION. Pointing it at staging was a surviving
  // mutation: that particular swap yields a false red, but the invariant "the thing
  // being verified is the thing that was deployed" was unpinned entirely, and the
  // mirror-image edit is silent.
  it('points the verifier at production, from the environment', () => {
    const step = stepsOf('deploy-production.yml', 'deploy').find(isVerify);
    expect(step?.env?.SITE).toBe('https://packsheet.io');
    // Via $SITE, so the URL is in one place rather than duplicated into the command.
    expect(executable(step?.run)).toContain('"$SITE"');
  });

  // Each deploy job is scoped to a GitHub environment, which is what keeps a workflow
  // running from a feature branch or a fork away from production's credentials.
  //
  // The NAME, not merely its presence. `toBeDefined()` let `name: staging` on the
  // production workflow pass every test in this file — and the GitHub environment is
  // the only thing that decides which SUPABASE_PROJECT_REF a release resolves, so a
  // one-word copy-paste makes the production release run `supabase db push` against
  // the staging project, or the staging release migrate production.
  it.each(DEPLOYS)('$file scopes its job to the $env environment', ({ file, job, env }) => {
    const environment = workflow(file).jobs[job].environment;
    const name = typeof environment === 'string' ? environment : environment?.name;
    expect(name).toBe(env);
  });
});

// ---------------------------------------------------------------------------
// Nothing load-bearing may be made optional
// ---------------------------------------------------------------------------

/**
 * `continue-on-error: true` turns a failed step into a green tick. `if:` can skip it
 * outright. Both are plausible edits by someone fighting a flaky run at 6pm, both
 * survive review as one added line, and both were demonstrated to pass this entire
 * suite before this block existed — including on `npm test` in the production
 * workflow, the step its own comment calls "the last gate before production. Nothing
 * downstream re-checks."
 *
 * What that specifically means: a red `anonymous-read-path.test.ts` — the guard on
 * the invariant this project spends the most on — would stop blocking releases,
 * permanently and invisibly.
 *
 * Ordering tests do not cover this. They compare indices, and a skipped step still
 * has an index.
 */
describe('load-bearing steps cannot be made optional', () => {
  const GATES = [
    { file: 'deploy-production.yml', job: 'deploy', label: 'npm test', pred: isTest },
    { file: 'deploy-production.yml', job: 'deploy', label: 'migrate', pred: isMigrate },
    { file: 'deploy-production.yml', job: 'deploy', label: 'deploy', pred: isWranglerAction },
    { file: 'deploy-production.yml', job: 'deploy', label: 'verify', pred: isVerify },
    { file: 'deploy-production.yml', job: 'deploy', label: 'build', pred: isBuild },
    { file: 'deploy-staging.yml', job: 'deploy', label: 'npm test', pred: isTest },
    { file: 'deploy-staging.yml', job: 'deploy', label: 'migrate', pred: isMigrate },
    { file: 'deploy-staging.yml', job: 'deploy', label: 'deploy', pred: isWranglerAction },
    { file: 'deploy-staging.yml', job: 'deploy', label: 'build', pred: isBuild },
  ] as const;

  it.each(GATES)('$file: the $label step is present, un-skipped and un-swallowed', (gate) => {
    const step = stepsOf(gate.file, gate.job).find(gate.pred);
    // Present at all: `.find` returning undefined would make every assertion below
    // vacuously pass on an optional-chained value.
    expect(step).toBeDefined();
    expect(step?.['continue-on-error']).toBeUndefined();
    expect(step?.if).toBeUndefined();
  });

  // The job-level equivalents of the same two mutations. A job-level `if: false` or
  // `continue-on-error` skips every step inside it at once, which no per-step
  // assertion can see.
  it.each(DEPLOYS)(
    '$file does not gate its whole deploy job behind a condition',
    ({ file, job }) => {
      expect(workflow(file).jobs[job].if).toBeUndefined();
    },
  );
});

// ---------------------------------------------------------------------------
// Azure is gone
// ---------------------------------------------------------------------------

describe('the Supabase CLI is always called through the wrapper', () => {
  /**
   * supabase/config.toml reads its project name and all seven ports from the
   * environment, so that each git worktree gets its own Docker stack instead of
   * silently sharing one database. The CLI has no way to default an `env(...)`, so
   * with those variables unset the file does not parse at all:
   *
   *     failed to read config: ProjectConfigParseError
   *
   * These jobs never start a local stack — but `link` and `db push` parse that same
   * file. Calling `supabase` directly here therefore breaks the RELEASE, at the
   * migration step, with an error that names neither the cause nor the fix. The cost
   * lands a long way from the local-dev convenience that caused it, which is exactly
   * the kind of coupling worth pinning.
   */
  it.each(DEPLOYS)('$file calls scripts/supabase.sh, never bare supabase', ({ file, job }) => {
    const step = stepsOf(file, job).find(isMigrate);
    expect(step).toBeDefined();
    const run = executable(step?.run);
    // Every supabase invocation on its own line must go through the wrapper.
    const invocations = run
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /(^|\/)supabase(\.sh)?\s/.test(l));
    expect(invocations.length).toBeGreaterThan(0);
    for (const line of invocations) {
      expect(line.startsWith('scripts/supabase.sh ')).toBe(true);
    }
  });

  it('the wrapper is committed and executable', () => {
    const mode = statSync(repoPath('scripts/supabase.sh')).mode;
    expect(mode & 0o111).not.toBe(0);
  });
});

describe('per-pull-request previews are gone, not half-removed', () => {
  // Removing the workflow while leaving preview_urls on would keep minting public
  // <version>-packsheet-io-staging.packsheet-io.workers.dev hostnames with no
  // Cloudflare Access application in front of them — that app was deleted with the
  // workflow. A second public copy of the site on a hostname nobody watches is the
  // Ref 46 problem arriving through a different door.
  it('has no pull-request preview workflow', () => {
    expect(existsSync(repoPath('.github/workflows/pr-preview.yml'))).toBe(false);
  });

  it('no workflow uploads a Worker version', () => {
    const offenders = readdirSync(repoPath('.github/workflows')).filter((f) =>
      /versions upload/.test(readFileSync(repoPath(`.github/workflows/${f}`), 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});

describe('nothing still deploys to Azure', () => {
  // Tracked files only: node_modules and dist are full of unrelated matches, and a
  // reference that is not committed cannot deploy anything.
  const tracked = execFileSync('git', ['ls-files'], { cwd: repoPath('.'), encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);

  it('has no workflow step using an Azure action', () => {
    const offenders = tracked
      .filter((f) => f.startsWith('.github/workflows/'))
      .filter((f) => /uses:\s*Azure\//i.test(readFileSync(repoPath(f), 'utf8')));
    expect(offenders).toEqual([]);
  });

  // The secrets were deleted from the repository when Azure was decommissioned, so a
  // surviving reference expands to the empty string and fails at run time — or, worse,
  // silently, in a step that tolerates it.
  it('references no Azure secret', () => {
    const offenders = tracked.filter((f) =>
      /secrets\.(AZURE_|SWA_)/.test(readFileSync(repoPath(f), 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  // The origin lock's artifact. Nothing writes one now, and one committed here would
  // carry the origin-verify secret into a public repository.
  it('has no committed staticwebapp.config.json', () => {
    expect(tracked.filter((f) => f.endsWith('staticwebapp.config.json'))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// verify-release.sh — behaviour, against stub origins
// ---------------------------------------------------------------------------

/**
 * The script is EXECUTED here, not pattern-matched, and the history of this repository
 * is the argument for it.
 *
 * The deleted origin-lock suite learnt this lesson twice. Both times, whatever was
 * asserted by substring could be broken while the suite stayed green — first the
 * writer, then the verifier itself, whose three failure branches could each be
 * replaced with an `echo` undetectably. When this project's release check was
 * reintroduced as an inline `run:` block, the same hole reopened immediately: a review
 * demonstrated that inverting the robots condition passed every test in this file.
 * That mutation produces a step which fails every correct release AND passes silently
 * when a staging build is live on packsheet.io — the exact failure it exists to catch.
 *
 * So the detection mechanism is driven against real HTTP responses.
 */
describe('verify-release.sh', () => {
  const SCRIPT = repoPath('scripts/verify-release.sh');
  const servers: Server[] = [];

  /** A stub origin. `routes` maps a path to [status, body], or to a SEQUENCE of them
   *  consumed one per request, which is how the retry paths get exercised. */
  type Route = [number, string];
  async function stub(routes: Record<string, Route | Route[]>): Promise<string> {
    const server = createServer((req, res) => {
      const entry = routes[req.url ?? '/'] ?? ([404, 'not found'] as Route);
      const [status, body] = Array.isArray(entry[0])
        ? (entry as Route[]).length > 1
          ? (entry as Route[]).shift()!
          : (entry as Route[])[0]
        : (entry as Route);
      // Close each connection: a keep-alive socket left open by curl keeps the server
      // from firing its close callback, which hangs teardown rather than failing it.
      res.writeHead(status, { 'content-type': 'text/plain', connection: 'close' });
      res.end(body);
    });
    server.keepAliveTimeout = 0;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (s) =>
          new Promise<void>((resolve) => {
            s.closeAllConnections();
            s.close(() => resolve());
          }),
      ),
    );
  });

  /** Asynchronous on purpose. The stub servers run on this process's event loop, so a
   *  synchronous spawn would block it for the lifetime of the child and the server
   *  could never answer the request the child is waiting on — a deadlock that presents
   *  as curl timing out against a server that is definitely listening. */
  function verify(
    site: string,
    { attempts = '1', extraPath = '' } = {},
  ): Promise<{ status: number | null; output: string }> {
    return new Promise((resolve) => {
      const child = spawn(SCRIPT, [site], {
        env: {
          PATH: extraPath ? `${extraPath}:${process.env.PATH}` : process.env.PATH,
          HOME: process.env.HOME,
          VERIFY_ATTEMPTS: attempts,
          VERIFY_DELAY: '0',
          VERIFY_TIMEOUT: '5',
        },
      });
      let output = '';
      child.stdout.on('data', (d) => (output += d));
      child.stderr.on('data', (d) => (output += d));
      child.on('close', (status) => resolve({ status, output }));
    });
  }

  const PRODUCTION_ROBOTS =
    'User-agent: *\nAllow: /\n\nSitemap: https://packsheet.io/sitemap-index.xml\n';
  const STAGING_ROBOTS = '# Not the production site — do not index.\nUser-agent: *\nDisallow: /\n';

  const HEALTHY: Record<string, Route | Route[]> = {
    '/': [200, '<html>packsheet</html>'],
    '/robots.txt': [200, PRODUCTION_ROBOTS],
  };

  it('passes when the site serves the production build', async () => {
    const { status, output } = await verify(await stub(HEALTHY));
    expect(status).toBe(0);
    expect(output).toMatch(/Verified/);
  });

  // The catastrophe this exists for, and the mutation that used to survive: a staging
  // or preview build live on packsheet.io. Invisible from outside, and it costs the
  // site its search presence for as long as nobody notices.
  it('fails when a non-production build is live', async () => {
    const site = await stub({ ...HEALTHY, '/robots.txt': [200, STAGING_ROBOTS] });
    const { status, output } = await verify(site);
    expect(status).toBe(1);
    expect(output).toMatch(/disallows crawling/);
  });

  // Positive evidence, not merely the absence of Disallow. Without this, an empty
  // robots.txt, a 404 body or an error page all read as "production build is live".
  it('fails when robots.txt carries no Sitemap line', async () => {
    const site = await stub({ ...HEALTHY, '/robots.txt': [200, 'User-agent: *\nAllow: /\n'] });
    const { status, output } = await verify(site);
    expect(status).toBe(1);
    expect(output).toMatch(/no Sitemap/);
  });

  it.each([
    ['500', 500],
    ['404', 404],
    ['302', 302],
  ])('fails when the home page answers %s', async (_label, code) => {
    const { status, output } = await verify(await stub({ ...HEALTHY, '/': [code, 'x'] }));
    expect(status).toBe(1);
    expect(output).toMatch(/expected 200/);
  });

  // What an assets binding pointed at the wrong directory looks like: the deploy
  // succeeds and the site serves 200 of something that is not the site.
  it('fails when the home page is 200 but not HTML', async () => {
    const site = await stub({ ...HEALTHY, '/': [200, 'not a page'] });
    const { status, output } = await verify(site);
    expect(status).toBe(1);
    expect(output).toMatch(/not HTML/);
  });

  it('fails when robots.txt is not served at all', async () => {
    const site = await stub({ ...HEALTHY, '/robots.txt': [404, 'nope'] });
    const { status, output } = await verify(site);
    expect(status).toBe(1);
    expect(output).toMatch(/robots\.txt answered 404/);
  });

  // Cloudflare's managed challenge, bot-fight mode and rate limiting all answer a
  // datacenter IP running curl with a 4xx, and an edge seconds after a deploy can
  // still be catching up. Failing on the first bad answer produces the most dangerous
  // false alarm available: it sends someone to "fix" a site that is healthy for every
  // real browser.
  it('retries a transient failure before believing it', async () => {
    const site = await stub({
      '/': [
        [403, 'cf challenge'],
        [200, '<html>packsheet</html>'],
      ],
      '/robots.txt': [200, PRODUCTION_ROBOTS],
    });
    const { status } = await verify(site, { attempts: '4' });
    expect(status).toBe(0);
  });

  // A tool that cannot run is not evidence of anything. Reporting success off the back
  // of a curl that never executed would be a positive claim made without having
  // looked — which is what `|| true` on a fetch quietly does.
  it('fails, rather than passing, when curl cannot run', async () => {
    const binDir = mkdtempSync(join(tmpdir(), 'verify-release-bin-'));
    try {
      const fakeCurl = join(binDir, 'curl');
      writeFileSync(fakeCurl, '#!/bin/sh\nexit 3\n');
      chmodSync(fakeCurl, 0o755);
      const { status } = await verify(await stub(HEALTHY), { extraPath: binDir });
      expect(status).toBe(1);
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  // Exiting at the first problem hides the second until someone fixes the first and
  // deploys again — on the one deploy nobody re-runs casually.
  it('runs every check even when an earlier one fails, and counts them', async () => {
    const site = await stub({ '/': [500, 'x'], '/robots.txt': [200, STAGING_ROBOTS] });
    const { status, output } = await verify(site);
    expect(status).toBe(1);
    expect(output).toMatch(/expected 200/);
    expect(output).toMatch(/disallows crawling/);
    // Three, not two: a staging robots.txt trips both robots assertions — it has no
    // Sitemap line AND it disallows. The count is asserted exactly so that a check
    // quietly ceasing to run shows up as a smaller number rather than as nothing.
    expect(output).toMatch(/3 problem\(s\)/);
  });

  it('refuses to run without a site argument', async () => {
    const { status } = await verify('');
    expect(status).not.toBe(0);
  });

  // The script's only piece of local state. Left to `set -e`, a failed mktemp would be
  // an implicit dependency on a line that can be deleted with no test signal — which a
  // review demonstrated. Handled explicitly instead, so the guard is executable.
  //
  // Without it, an empty $work makes every path below absolute from the filesystem
  // root: the script writes to /home.html, greps a file it never created, and reports
  // problems that describe something other than the site.
  it('fails with a clear message when it cannot create a working directory', async () => {
    const binDir = mkdtempSync(join(tmpdir(), 'verify-release-bin-'));
    try {
      const fakeMktemp = join(binDir, 'mktemp');
      writeFileSync(fakeMktemp, '#!/bin/sh\nexit 1\n');
      chmodSync(fakeMktemp, 0o755);
      const { status, output } = await verify(await stub(HEALTHY), { extraPath: binDir });
      expect(status).toBe(1);
      expect(output).toMatch(/could not create a working directory/);
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// The artifact that actually deploys
// ---------------------------------------------------------------------------

/**
 * Everything above reads wrangler.jsonc — the SOURCE. What `wrangler deploy` reads is
 * dist/client/wrangler.json, which the build generates by resolving one environment
 * out of that source. Those are two different files, and only the second one decides
 * what is publicly reachable.
 *
 * The gap is not theoretical. Wrangler environments do not inherit every key: some are
 * inherited, some must be repeated per environment, and which is which is a property
 * of wrangler's config loader rather than of anything visible in the source file. A
 * key that silently fails to inherit reads perfectly in wrangler.jsonc and is absent
 * from the artifact — `workers_dev` defaulting back to true would republish the site
 * on workers.dev with every source-level assertion still green.
 *
 * So this block builds both environments the way the workflows do and asserts against
 * what came out. It is the only test here that can catch a wrangler behaviour change.
 */
describe('the generated deploy config', () => {
  const built = new Map<string, Record<string, unknown>>();
  const outDirs: string[] = [];

  beforeAll(() => {
    for (const { env } of DEPLOYS) {
      // Inside the project root, not tmpdir(): workerd prerendering cannot reach a
      // path outside it, and an outDir under /var/folders fails the build with "The
      // Workers runtime failed to start".
      const outDir = mkdtempSync(join(repoPath('.'), '.astro-build-out-'));
      outDirs.push(outDir);
      execFileSync('npx', ['astro', 'build', '--outDir', outDir], {
        cwd: repoPath('.'),
        env: { ...process.env, CLOUDFLARE_ENV: env, PUBLIC_SITE_ENV: env },
        stdio: 'pipe',
      });
      const generated = join(outDir, 'client', 'wrangler.json');
      if (!existsSync(generated)) {
        throw new Error(`No generated wrangler.json for ${env} at ${generated}`);
      }
      built.set(env, JSON.parse(readFileSync(generated, 'utf8')));
    }
  }, 180_000);

  it.each(DEPLOYS)('$env resolves to the $worker Worker', ({ env, worker }) => {
    expect(built.get(env)?.name).toBe(worker);
  });

  it.each(DEPLOYS)('$env is not published on workers.dev in the built config', ({ env }) => {
    expect(built.get(env)?.workers_dev).toBe(false);
  });

  it('production has no preview URLs in the built config', () => {
    expect(built.get('production')?.preview_urls).toBe(false);
  });

  it('staging has no preview URLs in the built config', () => {
    expect(built.get('staging')?.preview_urls).toBe(false);
  });

  it.each([
    { env: 'production', hostname: 'packsheet.io' },
    { env: 'staging', hostname: 'staging.packsheet.io' },
  ])('$env binds $hostname in the built config', ({ env, hostname }) => {
    expect(built.get(env)?.routes).toEqual([{ pattern: hostname, custom_domain: true }]);
  });

  it.each(DEPLOYS)('$env keeps the real-404 behaviour in the built config', ({ env }) => {
    expect((built.get(env)?.assets as { not_found_handling?: string })?.not_found_handling).toBe(
      '404-page',
    );
  });

  // The two builds must differ in exactly the way the workflows intend, and no other.
  // If CLOUDFLARE_ENV stopped selecting anything, both would resolve identically and
  // every per-environment assertion above would still pass on one of them.
  it('resolves the two environments to genuinely different Workers', () => {
    expect(built.get('production')?.name).not.toBe(built.get('staging')?.name);
  });

  // The other half of the same build: PUBLIC_SITE_ENV decides indexability, and only
  // the production build may be indexable. Asserted on the emitted file rather than on
  // the source, because this is what ships.
  it('emits an indexable robots.txt for production and only for production', () => {
    const read = (env: string) =>
      readFileSync(
        join(outDirs[DEPLOYS.findIndex((d) => d.env === env)], 'client', 'robots.txt'),
        'utf8',
      );
    expect(read('production')).toMatch(/^Sitemap:/m);
    expect(read('production')).not.toMatch(/^Disallow: \/$/m);
    expect(read('staging')).toMatch(/^Disallow: \/$/m);
  });

  afterAll(() => {
    for (const dir of outDirs) rmSync(dir, { recursive: true, force: true });
  });
});
