import { describe, expect, it } from 'vitest';
import { ACCOUNT_PATH, NEXT_PARAM, nextFromForm, safeNextPath } from '../src/lib/auth-routes';

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
 *
 * ---------------------------------------------------------------------------
 * THE TABLE THAT LOOKED FULL AND TESTED ONE CLAUSE
 * ---------------------------------------------------------------------------
 *
 * `safeNextPath` has four rules: a leading `/`, not `//`, no backslash, no colon. Every
 * rejected input this file originally listed failed the FIRST of them — `//evil.com` and
 * `\/evil.com` and `evil.com` and `''` are all caught before the interesting clauses are
 * reached — so deleting the `\\` and `:` checks from the function left the entire suite
 * green. Eight rejection cases, one rule exercised.
 *
 * The two inputs that fix it are the ones that get PAST the leading-slash check and are
 * refused by nothing else: `/\evil.com` (a real path, containing a backslash) and
 * `/javascript:alert(1)` (a real path, containing a colon). They are marked below with
 * which clause is the only thing standing between them and being returned unchanged, and
 * each was confirmed by deleting that clause and watching this file — and only this file
 * — go red.
 *
 * When a rule is added to `safeNextPath`, the case for it has to be one that survives
 * every rule already there, or the table grows without the coverage growing with it.
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

    // ---------------------------------------------------------------------------
    // The two that actually reach the interesting clauses
    // ---------------------------------------------------------------------------

    // ONLY the no-backslash rule refuses this. It starts with a single `/`, so it is a
    // path by every other test here — and browsers that normalise `\` to `/` before
    // resolving read it as `//evil.com`, i.e. a different host. Every other backslash
    // case in this table is caught by the leading-slash check long before the backslash
    // is looked at, which is why deleting that clause used to change nothing.
    ['a path whose second character is a backslash', '/\\evil.com'],
    // ONLY the no-colon rule refuses this. It starts with a single `/`, contains no
    // backslash, and is a perfectly well-formed relative path — which is the point: it
    // is also `javascript:alert(1)` to anything that resolves the string as a URL rather
    // than as a path, and a redirect target is resolved, not opened as a file.
    ['a path carrying a javascript: scheme', '/javascript:alert(1)'],
  ];

  it.each(accepted)('accepts %s (%s) unchanged', (_label, input) => {
    expect(safeNextPath(input)).toBe(input);
  });

  it.each(rejected)('falls back to ACCOUNT_PATH for %s (%s)', (_label, input) => {
    expect(safeNextPath(input)).toBe(ACCOUNT_PATH);
  });
});

/**
 * `nextFromForm`, which exists because the hidden `<input name="next">` in all four
 * sign-in and sign-up forms was DEAD: nothing read `form.get('next')`, and the value
 * survived a POST only because a `<form method="POST">` with no `action` re-posts to the
 * current URL, query string included. The field worked by coincidence and its comment
 * claimed it was the mechanism.
 */
describe('nextFromForm', () => {
  const url = (query = '') => new URL(`https://packsheet.io/sign-in${query}`);
  const form = (entries: Record<string, string>) => {
    const data = new FormData();
    for (const [name, value] of Object.entries(entries)) data.append(name, value);
    return data;
  };

  it('reads the hidden field the forms actually render', () => {
    expect(nextFromForm(form({ [NEXT_PARAM]: '/a/b' }), url())).toBe('/a/b');
  });

  // The field wins, so the carrier is the carrier. If the query string won instead, the
  // field would still be decoration and this whole function would be ceremony.
  it('prefers the field over the query string', () => {
    expect(nextFromForm(form({ [NEXT_PARAM]: '/from-field' }), url('?next=/from-query'))).toBe(
      '/from-field',
    );
  });

  // And the query string is the safety net, for a form that lost the field — a crafted
  // POST, a stale cached page, or a future edit that gives one of these forms an
  // `action` and does not think about it.
  it('falls back to the query string when the form carries no field', () => {
    expect(nextFromForm(form({}), url('?next=/from-query'))).toBe('/from-query');
  });

  it('falls back to ACCOUNT_PATH when neither carries one', () => {
    expect(nextFromForm(form({}), url())).toBe(ACCOUNT_PATH);
  });

  /**
   * A hidden field is not a trusted one — it is a string an attacker POSTs, exactly like
   * a query parameter, and `type="hidden"` describes only what a browser draws. Both
   * sources go through safeNextPath for that reason, and this is the assertion that
   * fails if a future edit reads the field directly because "the form is ours".
   */
  it.each([
    ['a protocol-relative URL', '//evil.com'],
    ['an absolute URL', 'https://evil.com'],
    ['a javascript: scheme behind a slash', '/javascript:alert(1)'],
    ['a backslash-disguised host', '/\\evil.com'],
  ])('refuses %s in the hidden field, exactly as in the query string', (_label, value) => {
    expect(nextFromForm(form({ [NEXT_PARAM]: value }), url())).toBe(ACCOUNT_PATH);
    expect(nextFromForm(form({}), url(`?next=${encodeURIComponent(value)}`))).toBe(ACCOUNT_PATH);
  });

  // A file upload under that name is not a string. `FormData.get` returns a `File` for
  // one, and `String(file)` is "[object File]" — a value that is neither a path nor
  // null, and that a naive cast would hand to safeNextPath as if it were input.
  it('ignores a non-string entry under that name', () => {
    const data = new FormData();
    data.append(NEXT_PARAM, new File(['x'], 'next.txt'));
    expect(nextFromForm(data, url('?next=/from-query'))).toBe('/from-query');
  });
});
