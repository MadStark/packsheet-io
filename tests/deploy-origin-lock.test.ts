import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
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
 * Azure demand it. deploy-production.yml writes that config at deploy time from a secret.
 *
 * This is the one change in the project that reaches production untested — forwardingGateway
 * needs the Standard plan and staging is deliberately on Free, so staging cannot rehearse
 * it. What CAN be checked without deploying is checked here: that the step exists, that it
 * runs in the only order that works, that it refuses to emit a config from an empty secret,
 * and that the value is never committed to what is a public repository.
 */

const repoUrl = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url));

interface Step {
  name?: string;
  run?: string;
  uses?: string;
  env?: Record<string, string>;
}

function stepsOf(workflow: string): Step[] {
  const doc = parse(readFileSync(repoUrl(`.github/workflows/${workflow}`), 'utf8'));
  const jobs = doc?.jobs ?? {};
  const firstJob = Object.values(jobs)[0] as { steps?: Step[] } | undefined;
  return firstJob?.steps ?? [];
}

/** Index of the first step matching a predicate, or -1. */
const indexWhere = (steps: Step[], pred: (s: Step) => boolean) => steps.findIndex(pred);

const isBuild = (s: Step) => s.name === 'Build';
const isDeploy = (s: Step) => (s.uses ?? '').startsWith('Azure/static-web-apps-deploy');
const isOriginLock = (s: Step) => (s.run ?? '').includes('staticwebapp.config.json');

describe('production origin lock', () => {
  const steps = stepsOf('deploy-production.yml');

  it('writes the config as part of the production deploy', () => {
    expect(indexWhere(steps, isOriginLock)).toBeGreaterThanOrEqual(0);
  });

  // Order is the whole ballgame. The file has to exist inside dist/ before the upload
  // reads it, and it needs a dist/ to be written into. Between Build and Deploy is the
  // only window where both are true — before Build there is no directory, after Deploy
  // the artifact has already shipped without it.
  it('writes it after the build and before the upload', () => {
    const build = indexWhere(steps, isBuild);
    const lock = indexWhere(steps, isOriginLock);
    const deploy = indexWhere(steps, isDeploy);

    expect(build).toBeGreaterThanOrEqual(0);
    expect(deploy).toBeGreaterThanOrEqual(0);
    expect(lock).toBeGreaterThan(build);
    expect(lock).toBeLessThan(deploy);
  });

  // An empty secret yields a config demanding X-Origin-Verify: "" — a value Cloudflare
  // never sends — so every request 403s and the site is down until another deploy lands.
  // The guard turns that outage into a red build. It is the single most important line
  // in the step, and it is one `if` away from being deleted by someone tidying up.
  it('refuses to emit a config when the secret is empty', () => {
    const step = steps.find(isOriginLock);
    expect(step?.run).toMatch(/if\s+\[\s+-z\s+"\$ORIGIN_VERIFY"\s+\]/);
    expect(step?.run).toMatch(/exit 1/);
  });

  it('takes the value from the secret rather than a literal', () => {
    const step = steps.find(isOriginLock);
    expect(step?.env?.ORIGIN_VERIFY).toBe('${{ secrets.SWA_ORIGIN_VERIFY }}');
    // The value must reach jq through the environment, never interpolated into the
    // script body, where it would be printed by `set -x` and captured in run logs.
    expect(step?.run).toContain('--arg v "$ORIGIN_VERIFY"');
    expect(step?.run).not.toContain('secrets.SWA_ORIGIN_VERIFY');
  });
});

describe('the secret stays out of a public repository', () => {
  // The repo is public and AGPL. A committed staticwebapp.config.json carrying the real
  // header value would publish the thing the lock depends on, and the lock would then be
  // decoration. Generating the file at deploy time is what keeps it out — this asserts
  // nobody later "simplifies" that by checking a file in.
  it.each(['staticwebapp.config.json', 'public/staticwebapp.config.json'])(
    'does not commit %s',
    (path) => {
      expect(existsSync(repoUrl(path))).toBe(false);
    },
  );
});

describe('staging deliberately has no origin lock', () => {
  // forwardingGateway requires the Standard plan; staging is on Free on purpose, to halve
  // the hosting cost. Staging therefore cannot carry this and must not pretend to — a
  // config demanding a header on a plan that ignores the setting is worse than none,
  // because it reads as protection that is not there.
  it('does not write the config in the staging deploy', () => {
    expect(indexWhere(stepsOf('deploy-staging.yml'), isOriginLock)).toBe(-1);
  });

  // pr-preview.yml builds against the staging app for the same reason.
  it('does not write the config in the PR preview deploy', () => {
    expect(indexWhere(stepsOf('pr-preview.yml'), isOriginLock)).toBe(-1);
  });
});
