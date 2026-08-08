import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, existsSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

/**
 * The origin lock.
 *
 * Azure gives every Static Web App a permanent, public *.azurestaticapps.net hostname.
 * It cannot be disabled, it serves the same build as the custom domain, and it bypasses
 * Cloudflare entirely — no edge cache, no WAF, no rate limiting, and a second crawlable
 * copy of every page. `staticwebapp.config.json` cannot fix that alone: route rules match
 * on `route` and `methods` only, never on hostname, so any noindex header would land on
 * packsheet.io too.
 *
 * Production therefore refuses requests that did not arrive through Cloudflare. A
 * Cloudflare transform sets `X-Origin-Verify`; `forwardingGateway.requiredHeaders` makes
 * Azure demand it.
 *
 * An earlier version of this file asserted only on the workflow YAML, and a review proved
 * it green through both mutations that cause an outage: writing the config outside the
 * artifact directory (lock silently never applied) and misspelling the header name
 * (production refuses every request). Those two strings are the only things here that must
 * agree with state outside this repository, so the logic now lives in a script this suite
 * actually runs, and both strings are pinned by behaviour rather than by regex.
 */

const repoPath = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url));

/** Duplicated in exactly one other place on earth: the Cloudflare transform rule. */
const HEADER_NAME = 'X-Origin-Verify';
const SCRIPT = repoPath('scripts/write-origin-lock.sh');

// ---------------------------------------------------------------------------
// Behaviour — the script is executed, not read
// ---------------------------------------------------------------------------

describe('write-origin-lock.sh', () => {
  let dir: string;
  let out: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'origin-lock-'));
    out = join(dir, 'dist');
    mkdirSync(out);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const run = (originVerify: string | undefined, outDir = out) =>
    execFileSync(SCRIPT, [outDir], {
      env: {
        ...process.env,
        ...(originVerify === undefined ? {} : { ORIGIN_VERIFY: originVerify }),
      },
      encoding: 'utf8',
      stdio: 'pipe',
    });

  const configAt = (outDir = out) => join(outDir, 'staticwebapp.config.json');

  it('writes the config into the directory it is given', () => {
    run('a-real-value');
    expect(existsSync(configAt())).toBe(true);
  });

  // The mutation that silently disables the lock: write outside the artifact directory
  // and the file is never uploaded, forwardingGateway is never applied, and the Azure
  // hostname stays wide open. Nothing about the deploy looks wrong.
  it('writes nowhere else', () => {
    run('a-real-value');
    expect(existsSync(join(dir, 'staticwebapp.config.json'))).toBe(false);
  });

  // The mutation that takes production down: a header name Cloudflare does not send.
  it('uses exactly the header name Cloudflare sets', () => {
    run('a-real-value');
    const config = JSON.parse(readFileSync(configAt(), 'utf8'));
    expect(config).toEqual({
      forwardingGateway: { requiredHeaders: { [HEADER_NAME]: 'a-real-value' } },
    });
  });

  it('preserves the value byte for byte', () => {
    const awkward = 'aB3/+=_-.~value';
    run(awkward);
    const config = JSON.parse(readFileSync(configAt(), 'utf8'));
    expect(config.forwardingGateway.requiredHeaders[HEADER_NAME]).toBe(awkward);
  });

  // Each of these produces a config demanding a header Cloudflare never sends, which is
  // a total outage on the next deploy. `-z` alone catches only the first.
  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['a single space', ' '],
    ['whitespace', '   \t  '],
    ['a trailing newline only', '\n'],
  ])('refuses to write when the secret is %s', (_label, value) => {
    expect(() => run(value)).toThrow();
    expect(existsSync(configAt())).toBe(false);
  });

  it('refuses when the output directory does not exist', () => {
    expect(() => run('a-real-value', join(dir, 'no-such-dir'))).toThrow();
  });

  // Two secrets of wildly different lengths must produce byte-identical output. That is
  // the property an earlier version broke by printing `wc -c` of the config: the file is
  // a fixed prefix plus the secret, so its size discloses the secret's length to logs
  // that are public on this repository. Masking replaces the value; it cannot redact a
  // number derived from it. Comparing two runs catches any such leak, not just this one.
  it('prints nothing that varies with the value', () => {
    const short = run('a');
    const long = run('a'.repeat(512));
    expect(short).toBe(long);
  });

  it('never prints the value itself', () => {
    const secret = 'correct-horse-battery-staple';
    expect(run(secret)).not.toContain(secret);
  });
});

// ---------------------------------------------------------------------------
// Wiring — that the workflows call it, in the right place, with the right argument
// ---------------------------------------------------------------------------

interface Step {
  name?: string;
  run?: string;
  uses?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
}

/** Select the job by name: `Object.values(jobs)[0]` silently relocates every assertion
 *  to the wrong job the moment a workflow gains one ahead of the deploy job. */
function stepsOf(workflow: string, jobName = 'deploy'): Step[] {
  const doc = parse(readFileSync(repoPath(`.github/workflows/${workflow}`), 'utf8'));
  const job = doc?.jobs?.[jobName] as { steps?: Step[] } | undefined;
  if (!job) throw new Error(`No job "${jobName}" in ${workflow}`);
  return job.steps ?? [];
}

/** Comment lines are stripped before matching, so a step that *documents* the lock is
 *  not mistaken for one that runs it — and a decoy comment cannot satisfy an assertion. */
const executable = (run: string | undefined) =>
  (run ?? '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n');

const callsScript = (s: Step) => executable(s.run).includes('write-origin-lock.sh');
const isBuild = (s: Step) => s.name === 'Build';
const isDeploy = (s: Step) => (s.uses ?? '').startsWith('Azure/static-web-apps-deploy');
const isSmokeTest = (s: Step) => executable(s.run).includes('packsheet.io/');

describe('production workflow wiring', () => {
  const steps = stepsOf('deploy-production.yml');

  // dist/ must exist to be written into, and must be written before it is uploaded.
  it('writes the lock after the build and before the upload', () => {
    const build = steps.findIndex(isBuild);
    const lock = steps.findIndex(callsScript);
    const deploy = steps.findIndex(isDeploy);
    expect(build).toBeGreaterThanOrEqual(0);
    expect(lock).toBeGreaterThan(build);
    expect(lock).toBeLessThan(deploy);
  });

  // The directory passed to the script and the directory uploaded are two independent
  // strings that must agree. If they drift the config is written somewhere that never
  // ships, which is invisible at deploy time and only shows up as an unlocked origin.
  it('writes into exactly the directory that gets uploaded', () => {
    const lockStep = steps.find(callsScript);
    const deployStep = steps.find(isDeploy);
    const argument = executable(lockStep?.run).trim().split(/\s+/).pop();
    expect(argument).toBe(deployStep?.with?.app_location);
  });

  it('takes the value from the environment, never the script body', () => {
    const step = steps.find(callsScript);
    expect(step?.env?.ORIGIN_VERIFY).toBe('${{ secrets.SWA_ORIGIN_VERIFY }}');
    expect(step?.run).not.toContain('secrets.SWA_ORIGIN_VERIFY');
  });

  // The compensating control for a change that cannot be rehearsed on staging. Without
  // it the workflow ends at "upload succeeded" and a broken Cloudflare rule produces a
  // fully green deploy over a site returning 403 to everyone.
  it('verifies the running site after deploying', () => {
    const deploy = steps.findIndex(isDeploy);
    const smoke = steps.findIndex(isSmokeTest);
    expect(smoke).toBeGreaterThan(deploy);
  });

  it('checks both hostnames and that the config is not served', () => {
    const smoke = executable(steps.find(isSmokeTest)?.run);
    expect(smoke).toContain('https://packsheet.io/');
    expect(smoke).toContain('AZURE_HOSTNAME');
    expect(smoke).toContain('staticwebapp.config.json');
  });
});

describe('the secret stays out of a public repository', () => {
  // existsSync would fail on an untracked local file — anyone who runs the script by
  // hand in the repo root — and would miss a file committed at some other path. Ask git.
  it('has no committed staticwebapp.config.json anywhere', () => {
    const tracked = execFileSync('git', ['ls-files', '*staticwebapp.config.json'], {
      cwd: repoPath('.'),
      encoding: 'utf8',
    }).trim();
    expect(tracked).toBe('');
  });
});

describe('staging deliberately has no origin lock', () => {
  // forwardingGateway requires the Standard plan; staging is on Free on purpose, to halve
  // hosting cost. A config demanding a header on a plan that ignores the setting is worse
  // than none — it reads as protection that is not there.
  it.each(['deploy-staging.yml', 'pr-preview.yml'])('does not run the script in %s', (wf) => {
    const jobs = parse(readFileSync(repoPath(`.github/workflows/${wf}`), 'utf8')).jobs;
    const everyStep = Object.values(jobs).flatMap((j) => (j as { steps?: Step[] }).steps ?? []);
    expect(everyStep.filter(callsScript)).toHaveLength(0);
  });
});
