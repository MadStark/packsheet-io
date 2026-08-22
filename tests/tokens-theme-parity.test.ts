import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, extname } from 'node:path';
import postcss from 'postcss';

/**
 * Invariant — a token that resolves to nothing.
 *
 * WHAT REPLACED WHAT, because this file is the answer to a deletion. PK-64 deleted
 * `tests/tokens-dark-parity.test.ts`, whose entire subject was the symmetry of the two
 * dark blocks in `tokens.css`. Dark mode is gone, so neither block exists and there was
 * nothing left for it to assert — but deleting it also took away the repo's only
 * CSS-level test and orphaned its `postcss` dependency. This file spends both on the
 * invariant the new design actually has.
 *
 * THE FAILURE THIS CATCHES IS SILENT, which is the whole reason to spend a test on it.
 * `src/styles/global.css` states it and guards it with nothing:
 *
 *     "THIS BLOCK AND tokens.css MOVE TOGETHER. Every entry below is a token→utility
 *      mapping, so deleting a token without deleting its line here leaves a utility
 *      resolving to nothing — `bg-surface` silently painting transparent rather than
 *      failing the build."
 *
 * An undefined custom property is not an error in CSS. `var(--gone)` with no fallback
 * makes the declaration invalid at computed-value time, so the element renders with the
 * inherited or initial value: transparent, unstyled, and perfectly quiet. Nothing in
 * `astro check`, ESLint, Prettier or the rest of this suite notices. PK-64 removed
 * thirteen `@theme` keys and nine custom properties in one change, which is exactly the
 * shape that leaves one behind.
 *
 * It also pins the removal of dark mode. That is not the deleted test's assertion
 * rewritten — that one checked the two dark blocks agreed with each other, and this
 * checks there are none — but it is the same property somebody undoes by pasting a block
 * back in, and it costs three lines here.
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const stylesDir = join(repoRoot, 'src', 'styles');

const read = (name: string): string => readFileSync(join(stylesDir, name), 'utf8');

/** Every `--foo: ...` declared anywhere in a stylesheet. */
function declaredCustomProperties(css: string): Set<string> {
  const names = new Set<string>();
  postcss.parse(css).walkDecls((decl) => {
    if (decl.prop.startsWith('--')) names.add(decl.prop);
  });
  return names;
}

/** Every `var(--foo)` referenced in a string, ignoring the fallback arm. */
function referencedCustomProperties(text: string): string[] {
  return [...text.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)/g)].map((match) => match[1] as string);
}

/** Source files that can carry a `var(--foo)` — a stylesheet, a scoped block, a style attribute. */
function sourceFilesWithStyles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (['.astro', '.vue', '.css'].includes(extname(entry))) out.push(full);
    }
  };
  walk(join(repoRoot, 'src'));
  walk(join(repoRoot, 'placeholder'));
  return out;
}

describe('the token graph resolves', () => {
  const defined = declaredCustomProperties(read('tokens.css'));

  it('defines tokens at all (tripwire — the checks below must not pass vacuously)', () => {
    expect(defined.size).toBeGreaterThan(20);
    expect(defined.has('--paper')).toBe(true);
    expect(defined.has('--font-system')).toBe(true);
  });

  it('maps every @theme inline entry onto a token that exists', () => {
    const mapped: { theme: string; token: string }[] = [];
    postcss.parse(read('global.css')).walkAtRules('theme', (atRule) => {
      atRule.walkDecls((decl) => {
        for (const token of referencedCustomProperties(decl.value)) {
          mapped.push({ theme: decl.prop, token });
        }
      });
    });

    // Tripwire: if the @theme block stops being found, an empty list would pass and
    // defend nothing.
    expect(mapped.length).toBeGreaterThan(20);

    // `--font-system: var(--font-system)` is the intended self-reference of `@theme
    // inline` — Tailwind's key and our token share a name on purpose. A dangling entry
    // is one naming a DIFFERENT token that nothing defines.
    const dangling = mapped.filter(({ theme, token }) => theme !== token && !defined.has(token));
    expect(dangling).toEqual([]);
  });

  it('references no token that nothing defines, anywhere a stylesheet can reach', () => {
    // Tokens may also be defined locally — a scoped block, a page-level override — so the
    // defined set is the union across every file. What must not exist is a reference no
    // file anywhere satisfies.
    const files = sourceFilesWithStyles();
    expect(files.length).toBeGreaterThan(10);

    const definedAnywhere = new Set(defined);
    for (const file of files) {
      for (const match of readFileSync(file, 'utf8').matchAll(/(--[A-Za-z0-9_-]+)\s*:/g)) {
        definedAnywhere.add(match[1] as string);
      }
    }

    const dangling: string[] = [];
    for (const file of files) {
      for (const token of referencedCustomProperties(readFileSync(file, 'utf8'))) {
        // Tailwind emits its own --tw-* internals; they are not ours to define.
        if (token.startsWith('--tw-')) continue;
        if (!definedAnywhere.has(token)) dangling.push(`${file.slice(repoRoot.length)}: ${token}`);
      }
    }

    expect(dangling).toEqual([]);
  });

  it('does not define a token the retired palette used to carry', () => {
    // The nine PK-64 removed. One reappearing without a decision is how a deleted
    // elevation model creeps back a call site at a time.
    for (const gone of [
      '--surface',
      '--sunk',
      '--bark',
      '--trail',
      '--clay',
      '--clay-ink',
      '--wheat',
      '--worn-ink',
      '--r-sm',
    ]) {
      expect(defined.has(gone)).toBe(false);
    }
  });
});

/** The 6-digit hex a token is declared with, from the `:root` block in tokens.css. */
function tokenValue(css: string, name: string): string {
  let found: string | undefined;
  postcss.parse(css).walkDecls(name, (decl) => {
    found = decl.value.trim();
  });
  if (found === undefined) throw new Error(`${name} is not declared in tokens.css`);
  return found;
}

/** WCAG 2.x relative luminance of a #rrggbb colour. */
function luminance(hex: string): number {
  const channel = (pair: string): number => {
    const c = parseInt(pair, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = [1, 3, 5].map((i) => channel(hex.slice(i, i + 2))) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two #rrggbb colours, ordered either way. */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Every border-ish declaration on the rule with exactly this selector. */
function borderDecls(css: string, selector: string): string[] {
  const values: string[] = [];
  postcss.parse(css).walkRules((rule) => {
    if (rule.selector !== selector) return;
    rule.walkDecls(/^border/, (decl) => {
      values.push(decl.value);
    });
  });
  if (values.length === 0) throw new Error(`no border declaration found on \`${selector}\``);
  return values;
}

/**
 * PK-68 — a field's outline must not be the same ink as the value inside it.
 *
 * THE FAILURE THIS CATCHES IS A REVERT, not a typo. `border: 1px solid var(--ink)` is
 * what every control in this file said for four months, and it is what anyone adding a
 * new field will copy from the button rule twelve lines above it. Nothing else in the
 * suite can tell the two apart — both resolve, both render, and the only symptom is that
 * the box competes with its own contents again, which is precisely the complaint that
 * produced this token.
 *
 * It pins the value as well as the reference, because "soften the fields" has an obvious
 * wrong answer in the other direction: keep going until the outline is nearly --rule and
 * the field stops reading as a boxed control at all. The 3:1 floor below is WCAG 1.4.11
 * for a UI component boundary, and it is asserted against the SUNK ground as well as the
 * white sheet — #9d9284 passes on --note at 3.05:1 and fails on --paper-deep at 2.70:1,
 * so checking only the sheet would wave through the one mistake worth catching.
 */
describe('a field outline is softer than the value inside it', () => {
  const tokens = read('tokens.css');
  const paper = read('paper.css');
  const fieldLine = tokenValue(tokens, '--field-line');

  it('declares --field-line as its own colour, distinct from --ink and --rule', () => {
    expect(fieldLine).toMatch(/^#[0-9a-f]{6}$/);
    expect(fieldLine).not.toBe(tokenValue(tokens, '--ink'));
    expect(fieldLine).not.toBe(tokenValue(tokens, '--rule'));
  });

  it('sits between --ink and --rule rather than beside either', () => {
    const onNote = (hex: string): number => contrast(hex, tokenValue(tokens, '--note'));

    // Lighter than the value it must stop competing with...
    expect(onNote(fieldLine)).toBeLessThan(onNote(tokenValue(tokens, '--ink')));
    // ...and darker than a table rule, which is a different job (§7).
    expect(onNote(fieldLine)).toBeGreaterThan(onNote(tokenValue(tokens, '--rule')));
  });

  it('clears the 3:1 boundary floor on every ground in the palette', () => {
    for (const ground of ['--note', '--paper', '--paper-deep']) {
      expect(contrast(fieldLine, tokenValue(tokens, ground))).toBeGreaterThanOrEqual(3);
    }
  });

  it.each(['.field', '.search', '.checkbox'])('draws %s in --field-line, never --ink', (sel) => {
    const borders = borderDecls(paper, sel);
    expect(borders.some((value) => value.includes('var(--field-line)'))).toBe(true);
    expect(borders.filter((value) => value.includes('var(--ink)'))).toEqual([]);
  });

  it.each(['.btn', '.segmented'])('leaves %s in --ink — a button is not a field', (sel) => {
    // The other direction of the same revert: softening the fields must not creep into
    // the button box. DESIGN.md §6 calls the segmented control "the button's box split
    // by 1px ink dividers", and its selected segment fills with ink.
    expect(borderDecls(paper, sel).some((value) => value.includes('var(--ink)'))).toBe(true);
  });
});

describe('the language is light only', () => {
  it('declares no dark cut and no theme selector in any stylesheet', () => {
    for (const name of ['tokens.css', 'global.css', 'paper.css', 'fonts.css']) {
      const root = postcss.parse(read(name));

      const themeSelectors: string[] = [];
      root.walkRules((rule) => {
        if (rule.selector.includes('[data-theme')) themeSelectors.push(`${name}: ${rule.selector}`);
      });
      expect(themeSelectors).toEqual([]);

      const darkQueries: string[] = [];
      root.walkAtRules('media', (atRule) => {
        if (atRule.params.includes('prefers-color-scheme')) {
          darkQueries.push(`${name}: ${atRule.params}`);
        }
      });
      expect(darkQueries).toEqual([]);
    }
  });

  it('leaves no theme-bootstrap script in the layout', () => {
    // The inline pre-paint script existed only to set data-theme before first paint. With
    // no theme to set it is dead weight, and re-adding one is how a half-wired dark mode
    // comes back.
    const layout = readFileSync(join(repoRoot, 'src', 'layouts', 'Layout.astro'), 'utf8');
    expect(layout).not.toContain('packsheet-theme');
    expect(layout).not.toContain('data-theme');
  });
});
