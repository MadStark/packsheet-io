import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * PK-56 — the `[remotes.*]` blocks in supabase/config.toml, and the outage shape they
 * can produce silently.
 *
 * `supabase config push` does not push a diff. It resolves the WHOLE `auth` block —
 * this file's top-level values, with whatever a `[remotes.<name>]` block sets layered
 * on top — and pushes THAT to the hosted project named by that block's `project_id`.
 * The top-level values in supabase/config.toml are deliberately LOCAL DEV settings, and
 * there are SIX of them a remote must therefore restate: Mailpit rather than
 * `[auth.email.smtp]`, `site_url = "http://localhost:4321"`, no confirmation email
 * (`enable_confirmations = false`), a one-second resend floor (`max_frequency = "1s"`),
 * a two-per-hour cap (`[auth.rate_limit] email_sent = 2`), and an
 * `additional_redirect_urls` allow-list containing nothing but two LOOPBACK callback
 * URLs. A `[remotes.*]` block that forgets to restate even one of those does not leave
 * the hosted project's existing setting alone — it silently RESETS that one key to the
 * local value, indistinguishable in a diff from "no change". That is a live outage —
 * hosted confirmation email going dark, or a hosted project's redirect allow-list
 * narrowing to a hostname nothing external can reach — that produces no error, no
 * failed step and no red build.
 *
 * ALL SIX ARE PINNED BELOW, AND UNTIL THE PK-56 REVIEW ONLY FOUR WERE — while this
 * comment and config.toml's both claimed "all five". The two that were missing are the
 * two whose leak is quietest, which is exactly why nobody noticed they were missing:
 *
 *   - `[auth.rate_limit] email_sent`. Delete `[remotes.production.auth.rate_limit]`, or
 *     add a third remote without one, and hosted auth mail silently goes back to TWO
 *     PER HOUR — the precise bug this whole ticket exists to fix, reinstated with CI
 *     green.
 *   - `auth.additional_redirect_urls`. Same deletion replaces a hosted project's
 *     allow-list with this file's two loopback URLs, so the hosted origin is no longer
 *     on its own allow-list at all and GoTrue quietly falls back to `site_url` for every
 *     redirect it is asked to make.
 *
 * This file is the check that stands where CI would otherwise have nothing: it reads
 * supabase/config.toml, finds every `[remotes.*]` block that exists (not a
 * hard-coded list of the two known today), and asserts each one explicitly overrides
 * every local-dev value that must never leak to a hosted project. A third remote
 * added later inherits this guardrail automatically, because the assertions are
 * driven by whatever `remotes` keys the file actually declares — the same shape as
 * the `it.each(files)` pattern in migration-hygiene.test.ts, for the same reason: a
 * check that only knows about today's two remotes is a check that silently stops
 * covering the third one.
 *
 * The mirror-image mistake — "fixing" this test by making LOCAL DEV look like
 * production instead of making each remote override correctly — is pinned too: the
 * top-level block must still read as local-only, or `npm run db:start` starts
 * confirming email against Mailpit while believing it is production-safe, and every
 * other test in this suite that signs up a throwaway user starts waiting on an email
 * nobody sends.
 *
 * NO TOML PARSER IS A DEPENDENCY OF THIS PROJECT (see package.json — only
 * jsonc-parser and yaml are present, both for other file formats). Adding one for a
 * single file this small and this structurally simple — no inline tables, no arrays
 * of tables, no multi-line strings — would be more surface area than the problem
 * warrants, so `parseSupabaseToml` below is a small hand-rolled reader scoped
 * deliberately to what supabase/config.toml actually uses: `[dotted.table]` headers,
 * `key = value` pairs, double-quoted strings, bare booleans/integers, and
 * single- or multi-line arrays of strings. It is not a general TOML parser and must
 * not be asked to be one — anything supabase/config.toml does not already use (inline
 * tables, arrays of tables, literal/multi-line strings, dotted keys on one line) is
 * out of scope and will parse wrong or be skipped rather than silently guessed at.
 */

const CONFIG_PATH = fileURLToPath(new URL('../supabase/config.toml', import.meta.url));

type TomlValue = string | number | boolean | TomlValue[] | TomlTable;
interface TomlTable {
  [key: string]: TomlValue;
}

function parseValue(raw: string): TomlValue {
  const text = raw.trim();
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (/^-?\d+$/.test(text)) return Number(text);
  if (text.startsWith('[') && text.endsWith(']')) {
    const inner = text.slice(1, -1);
    return inner
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .map((part) => parseValue(part));
  }
  if (text.startsWith('"') && text.endsWith('"')) return text.slice(1, -1);
  return text;
}

/** Walks `root`, creating any missing table along `path`, without clobbering a table
 *  a previous header already populated — `[remotes.staging]` sets keys directly on
 *  `remotes.staging`, and the later `[remotes.staging.auth]` header must extend that
 *  same object rather than replace it. */
function tableAt(root: TomlTable, path: string[]): TomlTable {
  let node = root;
  for (const segment of path) {
    const next = node[segment];
    if (next && typeof next === 'object' && !Array.isArray(next)) {
      node = next as TomlTable;
    } else {
      const created: TomlTable = {};
      node[segment] = created;
      node = created;
    }
  }
  return node;
}

function parseSupabaseToml(text: string): TomlTable {
  const root: TomlTable = {};
  let current = root;
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    i++;
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const header = trimmed.match(/^\[([^\]]+)\]$/);
    if (header) {
      current = tableAt(
        root,
        header[1].split('.').map((s) => s.trim()),
      );
      continue;
    }

    const kv = trimmed.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (!kv) continue; // out of scope for this file — see the header comment.
    const [, key, firstLine] = kv;

    let valueText = firstLine;
    // A multi-line array: keep consuming lines until the closing bracket shows up.
    if (valueText.trim().startsWith('[') && !valueText.includes(']')) {
      while (i < lines.length && !valueText.includes(']')) {
        valueText += `\n${lines[i]}`;
        i++;
      }
    }
    current[key] = parseValue(valueText);
  }
  return root;
}

const config = parseSupabaseToml(readFileSync(CONFIG_PATH, 'utf8'));

function get(table: TomlValue | undefined, ...path: string[]): TomlValue | undefined {
  let node: TomlValue | undefined = table;
  for (const segment of path) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return undefined;
    node = (node as TomlTable)[segment];
  }
  return node;
}

describe('supabase/config.toml parses the way this test needs it to', () => {
  it('finds top-level auth settings, so the parser is reading the real file', () => {
    expect(get(config, 'auth', 'site_url')).toBeTypeOf('string');
  });

  it('finds at least one [remotes.*] block, so the checks below are not vacuous', () => {
    const remotes = get(config, 'remotes') as TomlTable | undefined;
    expect(Object.keys(remotes ?? {}).length).toBeGreaterThan(0);
  });
});

describe('local dev config stays local (the top-level block)', () => {
  // If this ever reads true or https, the guard below — which trusts that ONLY a
  // `[remotes.*]` override makes a project production-safe — has been defeated by
  // making local dev look like production instead of making a remote block correct.
  it('does not confirm email locally', () => {
    expect(get(config, 'auth', 'email', 'enable_confirmations')).toBe(false);
  });

  it('still points site_url at a loopback address', () => {
    const siteUrl = get(config, 'auth', 'site_url');
    expect(siteUrl).toMatch(/^http:\/\/(localhost|127\.0\.0\.1)(:|\/)/);
  });
});

describe('every [remotes.*] block overrides what config push would otherwise reset', () => {
  const remotes = get(config, 'remotes') as TomlTable | undefined;
  const names = Object.keys(remotes ?? {});

  it.each(names)('%s: site_url is https and not a loopback address', (name) => {
    const siteUrl = get(remotes, name, 'auth', 'site_url');
    expect(siteUrl, `${name} has no auth.site_url override`).toBeTypeOf('string');
    expect(siteUrl as string).toMatch(/^https:\/\//);
    expect(siteUrl as string).not.toMatch(/localhost|127\.0\.0\.1/);
  });

  // The confirmation-email switch itself. `false` here — inherited silently from the
  // top-level block — is the headline failure this whole file exists to catch: a
  // hosted project that lets anyone sign in as anyone else's unverified address.
  it.each(names)('%s: enable_confirmations is true', (name) => {
    expect(get(remotes, name, 'auth', 'email', 'enable_confirmations')).toBe(true);
  });

  // Not a specific value — just NOT the local "1s" testing floor. With the hourly cap
  // deliberately opened up (below), this per-address minimum is one of the two guards
  // actually limiting how fast email goes out, and "1s" is not a limit at all.
  it.each(names)('%s: max_frequency is not the local "1s" floor', (name) => {
    expect(get(remotes, name, 'auth', 'email', 'max_frequency')).not.toBe('1s');
  });

  it.each(names)('%s: SMTP is enabled', (name) => {
    expect(get(remotes, name, 'auth', 'email', 'smtp', 'enabled')).toBe(true);
  });

  // The one check in this file that is not about a value silently reverting — it is
  // about a secret silently becoming permanent. `env(...)` means config push reads
  // the password from the environment at push time; a literal here would commit
  // Resend's API key to a public repository the moment anyone typed it in.
  it.each(names)('%s: the SMTP password is env(...), never a literal secret', (name) => {
    const pass = get(remotes, name, 'auth', 'email', 'smtp', 'pass');
    expect(pass, `${name} has no auth.email.smtp.pass`).toBeTypeOf('string');
    expect(pass as string).toMatch(/^env\([A-Za-z0-9_]+\)$/);
  });

  it.each(names)('%s: admin_email is on mail.packsheet.io', (name) => {
    const adminEmail = get(remotes, name, 'auth', 'email', 'smtp', 'admin_email');
    expect(adminEmail, `${name} has no auth.email.smtp.admin_email`).toBeTypeOf('string');
    expect(adminEmail as string).toMatch(/@mail\.packsheet\.io$/);
  });

  /**
   * The two keys nobody enumerated, added after the first real `config push`.
   *
   * Everything above was on the list because somebody reasoned about it. These two were
   * not, and the push found them: staging's email OTP silently went from EIGHT digits
   * to six, and its MFA TOTP enrolment and verification were both switched OFF, because
   * this file's top-level values are the CLI template's local defaults and both hosted
   * projects were on the platform's. Neither appeared in the PR diff, the commit
   * message, or anything a reviewer would have read — only in the diff `config push`
   * itself prints, at the moment it applies.
   *
   * They are pinned here for the same reason as everything above, but the lesson is
   * wider than two keys and is written out in config.toml: the dangerous keys are the
   * ones nobody thought about, so the diff `config push` prints must actually be READ
   * the first time it runs against any project. This block cannot grow to cover a key
   * nobody has noticed yet — it can only stop a noticed one from quietly reverting.
   */
  it.each(names)('%s: otp_length is the hosted 8, not the local template default', (name) => {
    expect(get(remotes, name, 'auth', 'email', 'otp_length')).toBe(8);
  });

  // MFA is not a feature this project uses. That is exactly why it needs pinning: an
  // unused capability being switched off is the change least likely to be noticed by
  // anyone, and switching it back on is not something a deploy should decide either.
  it.each(names)('%s: MFA TOTP stays enabled, as both hosted projects have it', (name) => {
    expect(get(remotes, name, 'auth', 'mfa', 'totp', 'enroll_enabled')).toBe(true);
    expect(get(remotes, name, 'auth', 'mfa', 'totp', 'verify_enabled')).toBe(true);
  });

  /**
   * The hourly email cap, added in the PK-56 review. Nothing checked this before, and it
   * is the one key on the list whose silent reversion recreates the ORIGINAL fault: with
   * `[remotes.<name>.auth.rate_limit]` absent, `config push` sends the top-level `2`, and
   * a hosted project sends two auth emails an hour and then stops — no error, nothing in
   * the deploy log, and a signup queue that simply goes quiet.
   *
   * Compared against whatever the top-level block ACTUALLY says rather than a hard-coded
   * `2`, so that raising or lowering the local value can never make this check agree with
   * it by coincidence. The `toBeGreaterThan` is the second half and the more important
   * one: `not.toBe(2)` alone is satisfied by `3`, which is the same outage one digit
   * along. The specific figure below is not a claim about the right cap — the product
   * owner's decision (see the config.toml comments) is that Supabase is not the send
   * limiter at all, and Resend's quota is the real ceiling — it is only far enough above
   * the local value that no edit drifting back toward local dev can pass.
   */
  it.each(names)('%s: the hourly email cap is not the local dev value', (name) => {
    const localCap = get(config, 'auth', 'rate_limit', 'email_sent');
    expect(localCap, 'the top-level [auth.rate_limit] email_sent has gone').toBeTypeOf('number');

    const cap = get(remotes, name, 'auth', 'rate_limit', 'email_sent');
    expect(cap, `${name} has no auth.rate_limit.email_sent override`).toBeTypeOf('number');
    expect(cap, `${name} inherits the local cap of ${String(localCap)}`).not.toBe(localCap);
    expect(cap as number).toBeGreaterThan(1000);
  });

  /**
   * The redirect allow-list, also added in the PK-56 review, and the one whose failure is
   * the least like the others: inheriting the top-level value here is not a hosted project
   * being made TOO PERMISSIVE, it is a hosted project being made unreachable. The
   * top-level list is two loopback callback URLs and nothing else, so a remote that omits
   * this override ships an allow-list that does not contain its own origin, and GoTrue
   * answers every redirect it is asked for by silently falling back to `site_url`.
   *
   * WHY THIS IS NOT "no entry may mention localhost", which is the obvious rule and the
   * wrong one here. `[remotes.staging]` keeps loopback entries ON PURPOSE and says so at
   * length in its own comment — developers point `astro dev` (4321) and `wrangler dev`
   * (8787) at the staging project, so those entries are the feature. A blanket ban would
   * be a check this repository's own reviewed configuration fails, i.e. a check that gets
   * deleted rather than obeyed. The two properties below hold for both remotes as written
   * AND fail the moment either override is removed:
   *
   *   - the list admits this remote's own `site_url` origin, which the loopback-only
   *     top-level list never can, for any remote;
   *   - nothing on it is plaintext `http://` to a host that is not a loopback address, so
   *     the deliberate developer entries are allowed and a `http://staging.packsheet.io`
   *     (or any other cleartext host, where a one-time code would cross the network in the
   *     open) is not.
   */
  it.each(names)('%s: the redirect allow-list is its own, and admits its own origin', (name) => {
    const siteUrl = get(remotes, name, 'auth', 'site_url');
    expect(siteUrl, `${name} has no auth.site_url to check the allow-list against`).toBeTypeOf(
      'string',
    );

    const urls = get(remotes, name, 'auth', 'additional_redirect_urls');
    expect(urls, `${name} has no auth.additional_redirect_urls override`).toBeInstanceOf(Array);
    const entries = urls as TomlValue[];
    expect(entries, `${name}'s allow-list is empty`).not.toEqual([]);
    for (const entry of entries) {
      expect(entry, `${name} has a non-string entry in additional_redirect_urls`).toBeTypeOf(
        'string',
      );
    }

    const strings = entries as string[];
    expect(
      strings.some((entry) => entry.startsWith(`${siteUrl as string}/`)),
      `${name}'s allow-list does not admit its own site_url (${String(siteUrl)}): ${JSON.stringify(strings)}`,
    ).toBe(true);

    for (const entry of strings) {
      if (entry.startsWith('https://')) continue;
      expect(
        entry,
        `${name} allows a cleartext redirect target that is not a loopback address`,
      ).toMatch(/^http:\/\/(localhost|127\.0\.0\.1)(:|\/)/);
    }
  });
});

/**
 * PK-56, second half — the part of `config push` that has nothing to do with this
 * ticket, and is the more dangerous half precisely because of that.
 *
 * `supabase config push` does not push only `auth`. It also pushes `[api]`, `[storage]`
 * and `[db.settings]`, and the `[remotes.*]` blocks above override AUTH KEYS ONLY —
 * every non-auth value below therefore reaches BOTH hosted projects verbatim from this
 * file's top-level, local-development values, on every deploy, for as long as
 * `config push` runs in the workflows. There is no `[remotes.*.storage]` making that
 * per-environment, and adding one would not help: the risk is not that these values are
 * wrong today, it is that nothing notices when they change.
 *
 * They are correct today, and that was verified rather than assumed — read off both
 * hosted projects' `/config/storage` and `/postgrest` on 12 August 2026, every value
 * below already matches what is live on staging AND production, including
 * `vectorBuckets` already being enabled with the same 10/5 limits. So `config push`
 * is a no-op outside `auth` right now.
 *
 * But it is a no-op by ALIGNMENT, not by enforcement. Both sides happen to sit on
 * Supabase's defaults. Nothing structural keeps them there, and the failure mode is
 * ugly and quiet: someone raises `file_size_limit` for a local import experiment, or
 * flips `[storage.analytics] enabled` to try Iceberg on their laptop, and the next
 * merge to `staging` or `main` carries that change onto a hosted project with no
 * mention of storage anywhere in the diff, the PR title, or the deploy log. Two of
 * these switches — vector buckets and analytics buckets — gate PAID Pro-plan features,
 * and the CLI's confirmation prompt does not save anyone: in CI there is no TTY, so it
 * auto-answers YES after 100ms, and its cost warning only ever covers the two MFA
 * addons, never storage.
 *
 * So this block pins the local values as the deliberate, reviewed contents of what gets
 * pushed. It asserts nothing about whether these numbers are good — only that changing
 * one is a decision somebody made on purpose, in a diff that says so, rather than a
 * local convenience that escaped. If you are here because this test failed: you have
 * just changed live configuration on staging and production. Update the expectation
 * only once you actually want that, and check the value against both hosted projects.
 */
describe('what config push sends to hosted projects OUTSIDE the auth block', () => {
  it('api: schemas, search path and max_rows are the reviewed values', () => {
    expect(get(config, 'api', 'schemas')).toEqual(['public', 'graphql_public']);
    expect(get(config, 'api', 'extra_search_path')).toEqual(['public', 'extensions']);
    expect(get(config, 'api', 'max_rows')).toBe(1000);
  });

  it('storage: the file size limit is the reviewed value', () => {
    expect(get(config, 'storage', 'file_size_limit')).toBe('50MiB');
  });

  it('storage: the S3 protocol toggle is the reviewed value', () => {
    expect(get(config, 'storage', 's3_protocol', 'enabled')).toBe(true);
  });

  // Vector Buckets is a paid Pro-plan feature, and these toggles are asymmetric: a push
  // can switch one ON, but an `enabled = false` is not sent at all, so a push can never
  // switch it back OFF. Already enabled on both hosted projects with these same limits.
  it('storage: the vector bucket toggle and limits are the reviewed values', () => {
    expect(get(config, 'storage', 'vector', 'enabled')).toBe(true);
    expect(get(config, 'storage', 'vector', 'max_buckets')).toBe(10);
    expect(get(config, 'storage', 'vector', 'max_indexes')).toBe(5);
  });

  // Analytics/Iceberg buckets are the other paid toggle. This one is OFF locally, which
  // is why it is currently sent nowhere — and why flipping it to `true` for a local
  // experiment would be the single easiest way to turn a paid feature on in production
  // by accident. The hosted projects have their own Iceberg settings; a push must not
  // start reaching them.
  it('storage: the analytics bucket toggle stays off, so it is never pushed', () => {
    expect(get(config, 'storage', 'analytics', 'enabled')).toBe(false);
  });
});
