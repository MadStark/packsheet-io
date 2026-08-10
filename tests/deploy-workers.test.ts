import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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
  jobs: Record<string, { steps?: Step[]; environment?: unknown; if?: string }>;
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
const isMigrate = (s: Step) => executable(s.run).includes('supabase db push');

/**
 * The deploy workflows, and the pull-request preview, which is a deploy in every
 * respect that can go wrong.
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

  // The other half: previews have to work, and they are staging's. Asserted so that
  // "turn preview_urls off everywhere" cannot silently break every pull request
  // preview while looking like a tightening.
  it('does enable version preview URLs on staging, which is where previews live', () => {
    expect(config.env?.staging?.preview_urls).toBe(true);
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
  it.each(DEPLOYS)('binds $env as a custom domain, not a route pattern', ({ env }) => {
    for (const route of config.env?.[env]?.routes ?? []) {
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

  // Only "production" produces an indexable site, so a preview must be anything else.
  // Asserted rather than trusted to the fail-safe default, because the cost of the
  // preview build being indexable is duplicate content under a URL nobody controls.
  it('builds previews as something other than production', () => {
    const build = stepsOf('pr-preview.yml', 'preview').find(isBuild);
    expect(build?.env?.PUBLIC_SITE_ENV).toBeDefined();
    expect(build?.env?.PUBLIC_SITE_ENV).not.toBe('production');
  });

  // A preview built against production's config would be uploaded to the Worker that
  // serves packsheet.io, where preview_urls is off — so it would either fail or, worse,
  // succeed as a version of production.
  it('builds previews against the staging Worker, never production', () => {
    expect(stepsOf('pr-preview.yml', 'preview').find(isBuild)?.env?.CLOUDFLARE_ENV).toBe('staging');
  });

  // `wrangler deploy --env staging` reads plausibly and does nothing: by deploy time
  // the generated config has no environments left in it. Someone reaching for it has
  // misunderstood where the choice is made, and the deploy would go to production.
  it.each([...DEPLOYS, { file: 'pr-preview.yml', job: 'preview' }])(
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

  // `deploy` in the preview workflow points staging.packsheet.io at an unmerged pull
  // request. `versions upload` mints a URL and routes no traffic.
  it('the preview workflow uploads a version and does not deploy one', () => {
    const command =
      stepsOf('pr-preview.yml', 'preview').find(isWranglerAction)?.with?.command ?? '';
    expect(command.trim().startsWith('versions upload')).toBe(true);
  });

  // Two wrangler invocations — the build's and the deploy's — must agree about the
  // config format. Letting the action install its own latest is the drift .nvmrc
  // exists to prevent, one layer down.
  it.each([...DEPLOYS, { file: 'pr-preview.yml', job: 'preview' }])(
    '$file pins the same wrangler the lockfile installs',
    ({ file, job }) => {
      const lock = JSON.parse(readFileSync(repoPath('package-lock.json'), 'utf8'));
      const installed = lock.packages['node_modules/wrangler'].version;
      expect(stepsOf(file, job).find(isWranglerAction)?.with?.wranglerVersion).toBe(installed);
    },
  );

  // Credentials reach wrangler from the environment-scoped secret store, never from
  // the workflow body.
  it.each([...DEPLOYS, { file: 'pr-preview.yml', job: 'preview' }])(
    '$file takes its credentials from secrets',
    ({ file, job }) => {
      const step = stepsOf(file, job).find(isWranglerAction);
      expect(step?.with?.apiToken).toBe('${{ secrets.CLOUDFLARE_API_TOKEN }}');
      expect(step?.with?.accountId).toBe('${{ secrets.CLOUDFLARE_ACCOUNT_ID }}');
    },
  );

  // `continue-on-error` or an `if:` on the deploy turns a failed release into a green
  // tick. Both are plausible edits when someone is fighting a flaky run.
  it.each([...DEPLOYS, { file: 'pr-preview.yml', job: 'preview' }])(
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
  it.each([...DEPLOYS, { file: 'pr-preview.yml', job: 'preview' }])(
    '$file runs the tests before building',
    ({ file, job }) => {
      const steps = stepsOf(file, job);
      const test = steps.findIndex(isTest);
      const build = steps.findIndex(isBuild);
      expect(test).toBeGreaterThanOrEqual(0);
      expect(build).toBeGreaterThan(test);
    },
  );

  // A release that deploys code before the schema it queries has a window in which the
  // site is live against a database that does not have the column yet.
  it.each(DEPLOYS)('$file migrates the database before deploying', ({ file, job }) => {
    const steps = stepsOf(file, job);
    const migrate = steps.findIndex(isMigrate);
    const deploy = steps.findIndex(isWranglerAction);
    expect(migrate).toBeGreaterThanOrEqual(0);
    expect(deploy).toBeGreaterThan(migrate);
  });

  // Previews share staging's database. Running an unmerged branch's migrations against
  // it would let a pull request that is never merged permanently alter staging.
  it('the preview workflow does not migrate any database', () => {
    expect(stepsOf('pr-preview.yml', 'preview').filter(isMigrate)).toHaveLength(0);
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
    const verify = steps.findIndex((s) => executable(s.run).includes('robots.txt'));
    expect(verify).toBeGreaterThan(steps.findIndex(isWranglerAction));
  });

  // Unbounded curl retries can spend twenty minutes going red, all of it after the
  // release is already live.
  it('bounds the verify step', () => {
    const verify = stepsOf('deploy-production.yml', 'deploy').find((s) =>
      executable(s.run).includes('robots.txt'),
    );
    expect(verify?.['timeout-minutes']).toBeGreaterThan(0);
    expect(verify?.['continue-on-error']).toBeUndefined();
  });

  // Each deploy job is scoped to a GitHub environment, which is what keeps a workflow
  // running from a feature branch or a fork away from production's credentials.
  it.each(DEPLOYS)('$file scopes its job to a GitHub environment', ({ file, job }) => {
    expect(workflow(file).jobs[job].environment).toBeDefined();
  });

  // Fork pull requests get a read-only token and no secrets. Without this guard the
  // preview job fails on every external contribution to a public repository, which
  // reads as "your PR is broken" to someone who did nothing wrong.
  it('skips the preview job for pull requests from forks', () => {
    expect(workflow('pr-preview.yml').jobs.preview.if).toContain(
      'github.event.pull_request.head.repo.full_name',
    );
  });
});

// ---------------------------------------------------------------------------
// Azure is gone
// ---------------------------------------------------------------------------

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
