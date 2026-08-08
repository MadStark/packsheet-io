import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdtempSync,
  rmSync,
  mkdirSync,
  chmodSync,
  readdirSync,
} from 'node:fs';
import { spawnSync, spawn, execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

/**
 * The origin lock.
 *
 * Azure gives every Static Web App a permanent, public *.azurestaticapps.net hostname.
 * It cannot be disabled, it serves the same build as the custom domain, and it bypasses
 * Cloudflare entirely. `staticwebapp.config.json` route rules match on `route` and
 * `methods` only, never on hostname, so any noindex header would land on packsheet.io
 * too. Production therefore refuses requests without `X-Origin-Verify`, which a
 * Cloudflare transform sets on the way to the origin.
 *
 * Both shell scripts are executed here rather than pattern-matched, and the history is
 * the argument for it. Two rounds of review each showed the same failure: whatever was
 * asserted by substring could be broken while the suite stayed green — first the writer
 * (wrong output directory, misspelt header name), then the verifier itself (all three
 * failure branches replaced with an echo). Anything load-bearing in this feature is now
 * driven by running it.
 */

const repoPath = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url));

/** Duplicated in exactly two other places: the Cloudflare transform rule, and
 *  scripts/write-origin-lock.sh. The duplication is the point — importing the constant
 *  would pin nothing. The README's rotation procedure names all three. */
const HEADER_NAME = 'X-Origin-Verify';
const WRITE_SCRIPT = repoPath('scripts/write-origin-lock.sh');
const VERIFY_SCRIPT = repoPath('scripts/verify-origin-lock.sh');

/** Both streams. Actions writes stderr into the same publicly-readable log, so a leak
 *  guard that only inspects stdout is enforcing the invariant on half the output. */
function runScript(script: string, args: string[], env: NodeJS.ProcessEnv) {
  const r = spawnSync(script, args, { env, encoding: 'utf8' });
  return { status: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

// ---------------------------------------------------------------------------
// write-origin-lock.sh — behaviour
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

  /** Built explicitly rather than spreading process.env: an exported ORIGIN_VERIFY in
   *  the parent shell otherwise leaks into the "unset" case and fails it spuriously. */
  const run = (originVerify: string | undefined, outDir = out, extra: NodeJS.ProcessEnv = {}) => {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ...extra,
    };
    if (originVerify !== undefined) env.ORIGIN_VERIFY = originVerify;
    return runScript(WRITE_SCRIPT, [outDir], env);
  };

  const configAt = (outDir = out) => join(outDir, 'staticwebapp.config.json');
  const readConfig = () => JSON.parse(readFileSync(configAt(), 'utf8'));

  it('writes the config into the directory it is given', () => {
    expect(run('a-real-value').status).toBe(0);
    expect(existsSync(configAt())).toBe(true);
  });

  // The mutation that silently disables the lock: written outside the artifact directory
  // it is never uploaded, forwardingGateway never applies, and the Azure hostname stays
  // open. Nothing about the deploy looks wrong.
  it('writes nowhere else', () => {
    run('a-real-value');
    expect(existsSync(join(dir, 'staticwebapp.config.json'))).toBe(false);
  });

  // The mutation that takes production down: a header name Cloudflare does not send.
  it('uses exactly the header name Cloudflare sets', () => {
    run('a-real-value');
    expect(readConfig()).toEqual({
      forwardingGateway: { requiredHeaders: { [HEADER_NAME]: 'a-real-value' } },
    });
  });

  it('preserves the value byte for byte', () => {
    const awkward = 'aB3/+=_-.~value';
    run(awkward);
    expect(readConfig().forwardingGateway.requiredHeaders[HEADER_NAME]).toBe(awkward);
  });

  // Entirely-empty values. None of these is a plausible secret; they are the easy half.
  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['a single space', ' '],
    ['whitespace', '   \t  '],
    ['a newline alone', '\n'],
  ])('refuses when the secret is %s', (_label, value) => {
    const { status, output } = run(value);
    expect(status).toBe(1);
    expect(output).toMatch(/empty or entirely whitespace/);
    expect(existsSync(configAt())).toBe(false);
  });

  // The realistic failure, and the one an earlier version of this script got wrong: it
  // tested a trimmed copy and then wrote the untrimmed value, so content-plus-whitespace
  // passed the guard and wrote a header value Cloudflare can never match — a total
  // outage with a green build. A secret pasted into the GitHub UI with a trailing
  // newline is the single most likely way this happens.
  it.each([
    ['a trailing newline', 'abc123\n'],
    ['a leading space', ' abc123'],
    ['a trailing carriage return', 'abc123\r'],
    ['internal whitespace', 'abc 123'],
    ['a trailing tab', 'abc123\t'],
  ])('refuses a value with %s', (_label, value) => {
    const { status, output } = run(value);
    expect(status).toBe(1);
    expect(output).toMatch(/contains whitespace/);
    expect(existsSync(configAt())).toBe(false);
  });

  it('refuses when the output directory does not exist', () => {
    const { status, output } = run('a-real-value', join(dir, 'no-such-dir'));
    expect(status).toBe(1);
    expect(output).toMatch(/does not exist/);
  });

  // Astro copies public/ verbatim into the build output, so the moment anyone adds a
  // staticwebapp.config.json for route rules or security headers it lands here — and
  // this script runs after Build, so a blind `>` wins every time and silently drops
  // their CSP in production. The .gitignore comment in this same feature explicitly
  // invites adding that file, so the affordance and the shredder would ship together.
  it('refuses to overwrite a config it did not create', () => {
    const existing = '{"globalHeaders":{"content-security-policy":"default-src https:"}}';
    writeFileSync(configAt(), existing);
    const { status, output } = run('a-real-value');
    expect(status).toBe(1);
    expect(output).toMatch(/already exists/);
    // and crucially, left it alone
    expect(readFileSync(configAt(), 'utf8')).toBe(existing);
  });

  // Without the marker the verifier cannot tell this release from the previous one: an
  // edge still serving the older, locked deployment answers exactly like a correctly
  // locked new one.
  it('stamps the release marker when a SHA is supplied', () => {
    run('a-real-value', out, { DEPLOY_SHA: 'abc123def' });
    expect(readFileSync(join(out, '_deploy.txt'), 'utf8').trim()).toBe('abc123def');
  });

  it('omits the marker when no SHA is supplied, so it stays runnable outside CI', () => {
    run('a-real-value');
    expect(existsSync(join(out, '_deploy.txt'))).toBe(false);
  });

  // `set -euo pipefail` is the single line that turns every internal failure into a loud
  // one. Removing it produced exit 0, "Wrote", and a ZERO-BYTE config in the artifact —
  // Azure gets an empty config, the lock never applies, the origin stays open. Nothing
  // previously exercised a mid-script command failure, so that line was deletable with
  // no signal at all.
  it('fails loudly, and writes nothing, when jq fails', () => {
    const binDir = join(dir, 'fakebin');
    mkdirSync(binDir);
    const fakeJq = join(binDir, 'jq');
    writeFileSync(fakeJq, '#!/bin/sh\nexit 3\n');
    chmodSync(fakeJq, 0o755);

    const { status } = run('a-real-value', out, { PATH: `${binDir}:${process.env.PATH}` });
    expect(status).not.toBe(0);
    // No config, and no partial temp file left behind for the deploy step to upload.
    expect(existsSync(configAt())).toBe(false);
    expect(readdirSync(out).filter((f) => f.startsWith('.origin-lock.'))).toHaveLength(0);
  });

  // Two secrets of very different lengths must produce byte-identical output across
  // BOTH streams. An earlier version printed `wc -c` of the config — a fixed prefix plus
  // the secret — publishing the secret's length to logs that are public on this repo.
  // Masking replaces a verbatim value; it cannot redact a number derived from one.
  it('prints nothing that varies with the value, on either stream', () => {
    const short = run('a');
    rmSync(configAt());
    const long = run('a'.repeat(512));
    // Without the status assertions these pass whenever BOTH runs fail identically —
    // which is exactly what happens if the script is broken.
    expect(short.status).toBe(0);
    expect(long.status).toBe(0);
    expect(short.output).toBe(long.output);
  });

  it('never prints the value itself, on either stream', () => {
    const secret = 'correct-horse-battery-staple';
    const { status, output } = run(secret);
    expect(status).toBe(0);
    expect(output).not.toContain(secret);
  });
});

// ---------------------------------------------------------------------------
// verify-origin-lock.sh — behaviour, against stub origins
// ---------------------------------------------------------------------------

describe('verify-origin-lock.sh', () => {
  const servers: Server[] = [];

  /** A stub HTTP origin. `routes` maps a path to [status, body], or to a SEQUENCE of
   *  them consumed one per request — which is how the retry paths get exercised. */
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
      // from ever firing its close callback, which hangs the teardown rather than
      // failing it.
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

  // Asynchronous on purpose. The stub servers run on this process's event loop, so a
  // synchronous spawn would block it for the lifetime of the child and the server could
  // never answer the very request the child is waiting on — a deadlock that presents as
  // curl timing out against a server that is definitely listening.
  function verify(
    site: string,
    origin: string,
    sha?: string,
    attempts = '1',
  ): Promise<{ status: number | null; output: string }> {
    return new Promise((resolve) => {
      const args = sha === undefined ? [site, origin] : [site, origin, sha];
      const child = spawn(VERIFY_SCRIPT, args, {
        env: {
          PATH: process.env.PATH,
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

  const OK_SITE: Record<string, Route | Route[]> = {
    '/': [200, '<html>packsheet</html>'],
    '/staticwebapp.config.json': [404, 'not found'],
    '/_deploy.txt': [200, 'sha-current\n'],
  };
  const REFUSING_ORIGIN: Record<string, Route | Route[]> = { '/': [403, 'no'] };

  it('passes when the site serves and the origin refuses', async () => {
    const { status, output } = await verify(await stub(OK_SITE), await stub({ '/': [403, 'no'] }));
    expect(status).toBe(0);
    expect(output).toContain('config=not-served');
  });

  // The outage this exists to catch: Cloudflare stopped sending the header.
  it('fails when the site itself is refused', async () => {
    const site = await stub({ ...OK_SITE, '/': [403, 'no'] });
    const { status, output } = await verify(site, await stub({ '/': [403, 'no'] }));
    expect(status).toBe(1);
    expect(output).toMatch(/RESTORE THE CLOUDFLARE TRANSFORM RULE/);
  });

  // The lock silently not applied — the config never reached the artifact.
  it('fails when the origin still answers directly', async () => {
    const { status, output } = await verify(
      await stub(OK_SITE),
      await stub({ '/': [200, '<html>packsheet</html>'] }),
    );
    expect(status).toBe(1);
    expect(output).toMatch(/origin lock is NOT in effect/);
  });

  // A transient 5xx from the origin is not proof the lock works. Accepting any non-200
  // would report success on a 404 or 503 while the deployment settles — a false pass on
  // the only check that the lock functions at all, whose failure is silent and permanent.
  it.each([
    ['503', 503],
    ['500', 500],
    ['302', 302],
  ])('fails when the origin returns %s rather than a refusal', async (_l, code) => {
    const { status, output } = await verify(await stub(OK_SITE), await stub({ '/': [code, 'x'] }));
    expect(status).toBe(1);
    expect(output).toMatch(/expected 401 or 403/);
  });

  // Azure answers 404 for any *.azurestaticapps.net name that is not a live app, so a
  // typo in AZURE_HOSTNAME looks identical to a working lock. Accepting it would report
  // "verified" while the real origin serves the site unprotected — the precise silent,
  // permanent failure this script exists to prevent.
  it('rejects 404, which is indistinguishable from a wrong hostname', async () => {
    const { status, output } = await verify(await stub(OK_SITE), await stub({ '/': [404, 'x'] }));
    expect(status).toBe(1);
    expect(output).toMatch(/Check AZURE_HOSTNAME/);
  });

  it('fails when the config file is served', async () => {
    const site = await stub({
      ...OK_SITE,
      '/staticwebapp.config.json': [200, '{"forwardingGateway":{"requiredHeaders":{}}}'],
    });
    const { status, output } = await verify(site, await stub({ '/': [403, 'no'] }));
    expect(status).toBe(1);
    expect(output).toMatch(/secret is public/);
  });

  // Asserting on the body rather than the status matters: with a navigationFallback that
  // URL returns 200 with index.html, and a status check would cry "the secret is public"
  // falsely on every deploy.
  it('passes when the config URL returns a SPA fallback rather than the config', async () => {
    const site = await stub({
      ...OK_SITE,
      '/staticwebapp.config.json': [200, '<html>packsheet</html>'],
    });
    const { status } = await verify(site, await stub({ '/': [403, 'no'] }));
    expect(status).toBe(0);
  });

  it('reports the observed statuses so the refusal code can be pinned later', async () => {
    const { output } = await verify(await stub(OK_SITE), await stub(REFUSING_ORIGIN));
    expect(output).toMatch(/site=200/);
    expect(output).toMatch(/origin=403/);
  });

  it('accepts 401 as a refusal', async () => {
    const { status } = await verify(await stub(OK_SITE), await stub({ '/': [401, 'no'] }));
    expect(status).toBe(0);
  });

  // None of these is evidence that forwardingGateway is doing anything. 404 already had
  // its own case; the same reasoning rules out the rest.
  it.each([
    ['410', 410],
    ['429', 429],
    ['418', 418],
  ])('rejects %s, which is not evidence the lock works', async (_l, code) => {
    const { status, output } = await verify(await stub(OK_SITE), await stub({ '/': [code, 'x'] }));
    expect(status).toBe(1);
    expect(output).toMatch(/expected 401 or 403/);
  });

  // A request that never completed is its own outcome. Reporting `not-served` off the
  // back of a timeout is a positive claim about the secret's safety, made without
  // having looked — and the old `|| true` did exactly that, silently, exit 0.
  it('reports UNVERIFIED rather than not-served when the config request fails', async () => {
    const site = await stub({ ...OK_SITE, '/staticwebapp.config.json': [599, ''] });
    const { status, output } = await verify(site, await stub(REFUSING_ORIGIN));
    expect(status).toBe(1);
    expect(output).toMatch(/UNVERIFIED/);
    expect(output).not.toMatch(/config=not-served/);
  });

  // Without the release marker, an edge still serving the PREVIOUS locked deployment
  // answers exactly like a correctly locked new one — so the check would pass on the
  // strength of the deployment it was meant to replace.
  it('fails when the site is still serving a different release', async () => {
    const site = await stub({ ...OK_SITE, '/_deploy.txt': [200, 'sha-previous\n'] });
    const { status, output } = await verify(site, await stub(REFUSING_ORIGIN), 'sha-current');
    expect(status).toBe(1);
    expect(output).toMatch(/still serving release sha-previous/);
  });

  it('passes when the served release matches', async () => {
    const { status, output } = await verify(
      await stub(OK_SITE),
      await stub(REFUSING_ORIGIN),
      'sha-current',
    );
    expect(status).toBe(0);
    expect(output).toMatch(/release=sha-current/);
  });

  it('fails when the release marker is missing entirely', async () => {
    const site = await stub({ ...OK_SITE, '/_deploy.txt': [404, 'nope'] });
    const { status, output } = await verify(site, await stub(REFUSING_ORIGIN), 'sha-current');
    expect(status).toBe(1);
    expect(output).toMatch(/cannot confirm which release is live/);
  });

  // Cloudflare's managed challenge, bot-fight mode and rate limiting all answer a
  // datacenter IP running curl with a 4xx. Failing on the first one produces the most
  // dangerous false alarm here: it sends an operator to edit the one rule holding the
  // site up, while production is healthy for every real browser.
  it('retries a 403 on the site before believing it', async () => {
    const site = await stub({
      ...OK_SITE,
      '/': [
        [403, 'cf challenge'],
        [200, '<html>packsheet</html>'],
      ],
    });
    const { status } = await verify(site, await stub(REFUSING_ORIGIN), undefined, '4');
    expect(status).toBe(0);
  });

  // The security-critical check used to be skipped exactly when the deploy was in a
  // weird state, because an earlier failure exited first.
  it('runs every check even when an earlier one fails, and counts them', async () => {
    const site = await stub({
      '/': [403, 'no'],
      '/staticwebapp.config.json': [200, '{"forwardingGateway":{}}'],
      '/_deploy.txt': [200, 'sha-current\n'],
    });
    const { status, output } = await verify(
      site,
      await stub({ '/': [200, 'open'] }),
      'sha-current',
    );
    expect(status).toBe(1);
    expect(output).toMatch(/secret is public/);
    expect(output).toMatch(/origin lock is NOT in effect/);
    expect(output).toMatch(/3 problem\(s\)/);
  });
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

interface Step {
  name?: string;
  run?: string;
  uses?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
  if?: string;
  'continue-on-error'?: boolean;
  'timeout-minutes'?: number;
}

/** By name: `Object.values(jobs)[0]` silently relocates every assertion to the wrong job
 *  the moment a workflow gains one ahead of the deploy job. */
function stepsOf(workflow: string, jobName = 'deploy'): Step[] {
  const doc = parse(readFileSync(repoPath(`.github/workflows/${workflow}`), 'utf8'));
  const job = doc?.jobs?.[jobName] as { steps?: Step[] } | undefined;
  if (!job) throw new Error(`No job "${jobName}" in ${workflow}`);
  return job.steps ?? [];
}

/** Comment lines are stripped before matching, so a step that *documents* the lock is
 *  not mistaken for one that runs it, and a decoy comment satisfies nothing. */
const executable = (run: string | undefined) =>
  (run ?? '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n');

const callsWriter = (s: Step) => executable(s.run).includes('write-origin-lock.sh');
const callsVerifier = (s: Step) => executable(s.run).includes('verify-origin-lock.sh');
const isBuild = (s: Step) => s.name === 'Build';
const isDeploy = (s: Step) => (s.uses ?? '').startsWith('Azure/static-web-apps-deploy');

describe('production workflow wiring', () => {
  const steps = stepsOf('deploy-production.yml');

  it('writes the lock after the build and before the upload', () => {
    const build = steps.findIndex(isBuild);
    const lock = steps.findIndex(callsWriter);
    const deploy = steps.findIndex(isDeploy);
    expect(build).toBeGreaterThanOrEqual(0);
    expect(lock).toBeGreaterThan(build);
    expect(lock).toBeLessThan(deploy);
  });

  // The directory passed to the writer and the directory uploaded are independent
  // strings that must agree, or the config is written somewhere that never ships.
  it('writes into exactly the directory that gets uploaded', () => {
    const lockStep = steps.find(callsWriter);
    const deployStep = steps.find(isDeploy);
    const args = executable(lockStep?.run).trim().split('\n')[0].trim().split(/\s+/);
    expect(args.length).toBe(2); // script + one argument, no trailing comment or extras
    expect(args[1]).toBe(deployStep?.with?.app_location);
  });

  // A third string can move where SWA looks for the config: the docs require it at the
  // root of output_location when that is set. Pinned rather than reasoned about.
  it('does not set output_location, which would move where the config must live', () => {
    const deployStep = steps.find(isDeploy);
    // Without this the assertion below is also satisfied when no deploy step exists.
    expect(deployStep).toBeDefined();
    expect(deployStep?.with?.output_location).toBeUndefined();
  });

  // Neither step may be un-gated. `continue-on-error: true` on the WRITER means an empty
  // or whitespace secret no longer stops the deploy and production ships with no lock at
  // all; on the VERIFIER it removes the only check that the release works. Both are
  // plausible edits — someone hits a flaky Cloudflare challenge and "temporarily"
  // un-gates it — and both previously passed the whole suite.
  it.each([
    ['writer', callsWriter],
    ['verifier', callsVerifier],
  ])('does not let the %s step fail silently or be skipped', (_label, pred) => {
    const step = steps.find(pred);
    expect(step).toBeDefined();
    expect(step?.['continue-on-error']).toBeUndefined();
    expect(step?.if).toBeUndefined();
  });

  // The same token-count check that makes the writer immune to `|| true` and to an
  // `echo` prefix. Its absence here is why all three of those mutations passed.
  it('invokes the verifier directly, with exactly its three arguments', () => {
    const args = executable(steps.find(callsVerifier)?.run)
      .trim()
      .split('\n')[0]
      .trim()
      .split(/\s+/);
    expect(args.length).toBe(4);
    expect(args[0]).toBe('scripts/verify-origin-lock.sh');
  });

  it('passes the commit SHA to both the writer and the verifier', () => {
    expect(steps.find(callsWriter)?.env?.DEPLOY_SHA).toBe('${{ github.sha }}');
    expect(executable(steps.find(callsVerifier)?.run)).toContain('GITHUB_SHA');
  });

  it('bounds the verify step so it cannot retry for twenty minutes', () => {
    expect(steps.find(callsVerifier)?.['timeout-minutes']).toBeGreaterThan(0);
  });

  // The README's entire "the site stays up" argument for a half-finished rotation rests
  // on the tests running before the build and before the config is written.
  it('runs the test suite before building', () => {
    const test = steps.findIndex((s) => executable(s.run).trim() === 'npm test');
    const build = steps.findIndex(isBuild);
    expect(test).toBeGreaterThanOrEqual(0);
    expect(test).toBeLessThan(build);
  });
  // You cannot cancel an upload that already happened. A run cancelled between the
  // upload and the verify step leaves a live, unverified release, shown as a grey
  // "cancelled" rather than a failure, with no notification.
  it('does not cancel in-progress production deploys', () => {
    const doc = parse(readFileSync(repoPath('.github/workflows/deploy-production.yml'), 'utf8'));
    expect(doc.concurrency['cancel-in-progress']).toBe(false);
  });

  // Oryx re-running its own build would regenerate the artifact and discard the config.
  it('keeps the platform build disabled so the artifact is the one we wrote into', () => {
    expect(steps.find(isDeploy)?.with?.skip_app_build).toBe(true);
  });

  it('takes the value from the environment, never the script body', () => {
    const step = steps.find(callsWriter);
    expect(step?.env?.ORIGIN_VERIFY).toBe('${{ secrets.SWA_ORIGIN_VERIFY }}');
    expect(step?.run).not.toContain('secrets.SWA_ORIGIN_VERIFY');
  });

  it('verifies the running site after deploying', () => {
    expect(steps.findIndex(callsVerifier)).toBeGreaterThan(steps.findIndex(isDeploy));
  });

  it('points the verifier at the real site and the Azure hostname', () => {
    const step = steps.find(callsVerifier);
    expect(executable(step?.run)).toContain('https://packsheet.io');
    expect(executable(step?.run)).toContain('AZURE_HOSTNAME');
    expect(step?.env?.AZURE_HOSTNAME).toMatch(/\.azurestaticapps\.net$/);
  });
});

describe('the secret stays out of a public repository', () => {
  // existsSync would fail on an untracked local file — anyone who runs the script by
  // hand — and would miss a file committed at some other path. Ask git.
  it('has no committed staticwebapp.config.json anywhere', () => {
    const tracked = execFileSync('git', ['ls-files', '*staticwebapp.config.json'], {
      cwd: repoPath('.'),
      encoding: 'utf8',
    }).trim();
    expect(tracked).toBe('');
  });
});

describe('staging deliberately has no origin lock', () => {
  // forwardingGateway requires the Standard plan; staging is Free on purpose, to halve
  // hosting cost. A config demanding a header on a plan that ignores the setting is
  // worse than none — it reads as protection that is not there.
  it.each(['deploy-staging.yml', 'pr-preview.yml'])('does not run the scripts in %s', (wf) => {
    const jobs = parse(readFileSync(repoPath(`.github/workflows/${wf}`), 'utf8')).jobs;
    const everyStep = Object.values(jobs).flatMap((j) => (j as { steps?: Step[] }).steps ?? []);
    expect(everyStep.filter((s) => callsWriter(s) || callsVerifier(s))).toHaveLength(0);
  });
});
