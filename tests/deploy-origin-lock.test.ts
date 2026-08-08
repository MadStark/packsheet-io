import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, existsSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
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
  const run = (originVerify: string | undefined, outDir = out) => {
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME };
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

  // Two secrets of very different lengths must produce byte-identical output across
  // BOTH streams. An earlier version printed `wc -c` of the config — a fixed prefix plus
  // the secret — publishing the secret's length to logs that are public on this repo.
  // Masking replaces a verbatim value; it cannot redact a number derived from one.
  it('prints nothing that varies with the value, on either stream', () => {
    expect(run('a').output).toBe(run('a'.repeat(512)).output);
  });

  it('never prints the value itself, on either stream', () => {
    const secret = 'correct-horse-battery-staple';
    expect(run(secret).output).not.toContain(secret);
  });
});

// ---------------------------------------------------------------------------
// verify-origin-lock.sh — behaviour, against stub origins
// ---------------------------------------------------------------------------

describe('verify-origin-lock.sh', () => {
  const servers: Server[] = [];

  /** A stub HTTP origin. `routes` maps a path to [status, body]. */
  async function stub(routes: Record<string, [number, string]>): Promise<string> {
    const server = createServer((req, res) => {
      const [status, body] = routes[req.url ?? '/'] ?? [404, 'not found'];
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
  ): Promise<{ status: number | null; output: string }> {
    return new Promise((resolve) => {
      const child = spawn(VERIFY_SCRIPT, [site, origin], {
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          VERIFY_ATTEMPTS: '1',
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

  const OK_SITE: Record<string, [number, string]> = {
    '/': [200, '<html>packsheet</html>'],
    '/staticwebapp.config.json': [404, 'not found'],
  };

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
  ])('fails when the origin returns %s rather than a 4xx refusal', async (_l, code) => {
    const { status, output } = await verify(await stub(OK_SITE), await stub({ '/': [code, 'x'] }));
    expect(status).toBe(1);
    expect(output).toMatch(/expected a 4xx refusal/);
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
    const { output } = await verify(await stub(OK_SITE), await stub({ '/': [403, 'no'] }));
    expect(output).toMatch(/site=200/);
    expect(output).toMatch(/origin=403/);
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
    expect(steps.find(isDeploy)?.with?.output_location).toBeUndefined();
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
