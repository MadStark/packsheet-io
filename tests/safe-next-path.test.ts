import { describe, expect, it } from 'vitest';
import { ACCOUNT_PATH, safeNextPath } from '../src/lib/auth-routes';

/**
 * `safeNextPath` — the open-redirect guard on `?next=`, in its own file rather than
 * inside auth-flow.test.ts because it needs neither the local Supabase stack nor a
 * cookie round trip: it is a pure function, and this suite runs it exactly that way,
 * table-driven, the same shape as the function's own doc comment already argues for.
 *
 * The doc comment on `safeNextPath` in src/lib/auth-routes.ts spells out WHY each
 * rejected shape is dangerous rather than merely disallowed; this file exists to pin
 * the behaviour it describes rather than re-explain it. Read that comment first if a
 * case below looks arbitrary.
 */

describe('safeNextPath', () => {
  const accepted: [label: string, input: string][] = [
    ['a bare path', '/account'],
    ['a nested path with a query string', '/a/b?x=1'],
  ];

  const rejected: [label: string, input: string | null | undefined][] = [
    // Protocol-relative — resolves against a DIFFERENT host, and a same-origin check
    // on the string alone has no host to compare it against.
    ['a protocol-relative URL', '//evil.com'],
    // A full URL naming a different origin outright.
    ['an absolute URL to another origin', 'https://evil.com'],
    // A colon anywhere is how a scheme gets introduced (javascript:, https:); this
    // malformed-but-still-a-scheme spelling is exactly the case a "starts with a
    // recognised bad prefix" check would miss.
    ['a malformed scheme', 'http:/evil.com'],
    // Some browsers normalise a leading backslash to a forward slash before
    // resolving a URL, so this is "//evil.com" wearing a disguise.
    ['a backslash-prefixed host', '\\/evil.com'],
    // No leading slash at all — a scheme-relative or bare-host string, not a path.
    ['a bare host with no leading slash', 'evil.com'],
    ['an empty string', ''],
    ['undefined — no ?next= was supplied at all', undefined],
    ['null', null],
  ];

  it.each(accepted)('accepts %s (%s) unchanged', (_label, input) => {
    expect(safeNextPath(input)).toBe(input);
  });

  it.each(rejected)('falls back to ACCOUNT_PATH for %s (%s)', (_label, input) => {
    expect(safeNextPath(input)).toBe(ACCOUNT_PATH);
  });
});
