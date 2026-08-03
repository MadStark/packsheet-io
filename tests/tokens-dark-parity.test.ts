import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import postcss, { type Rule } from 'postcss';

/**
 * Invariant 2 — dark-block symmetry in the token file.
 *
 * src/styles/tokens.css expresses dark mode through two deliberately duplicated
 * selectors:
 *
 *   @media (prefers-color-scheme: dark) { :root:not([data-theme='light']) { ... } }
 *   :root[data-theme='dark'] { ... }
 *
 * They cannot be merged: the first lets an explicit light choice override a dark OS
 * preference, the second lets an explicit dark choice win on a light OS. The file
 * itself explains this.
 *
 * The regression this guards against is a token added or changed in one block and
 * not its twin. The OS-preference path and the in-app toggle then render different
 * colours, and which one a user sees depends on settings they may never have
 * touched. Nothing else in the toolchain notices.
 */

const TOKENS_PATH = fileURLToPath(new URL('../src/styles/tokens.css', import.meta.url));

/** Selector comparison that survives reformatting and a quote-style change. */
const normaliseSelector = (selector: string): string =>
  selector.replace(/\s+/g, '').replace(/["']/g, '');

const OS_PREFERENCE_SELECTOR = ':root:not([data-theme=light])';
const EXPLICIT_TOGGLE_SELECTOR = ':root[data-theme=dark]';

function findBlocks(): { osPreference?: Rule; explicitToggle?: Rule } {
  const root = postcss.parse(readFileSync(TOKENS_PATH, 'utf8'), { from: TOKENS_PATH });

  let osPreference: Rule | undefined;
  let explicitToggle: Rule | undefined;

  root.walkAtRules('media', (atRule) => {
    if (!/prefers-color-scheme\s*:\s*dark/.test(atRule.params)) return;
    atRule.walkRules((rule) => {
      if (normaliseSelector(rule.selector) === OS_PREFERENCE_SELECTOR) osPreference = rule;
    });
  });

  root.walkRules((rule) => {
    // Top-level only: the toggle selector must not be matched from inside the media
    // query, or a refactor that nests it there would still look like a pass.
    if (rule.parent?.type !== 'root') return;
    if (normaliseSelector(rule.selector) === EXPLICIT_TOGGLE_SELECTOR) explicitToggle = rule;
  });

  return { osPreference, explicitToggle };
}

/** Sorted "prop: value" lines — an array rather than a Map so failures diff readably. */
function declarationsOf(rule: Rule): string[] {
  const declarations: string[] = [];
  // Block body, not a concise arrow: postcss types the walker's return as
  // `false | void`, where `false` means stop walking. Returning push()'s number
  // would be a type error, and any truthy return risks aborting the walk early.
  rule.walkDecls((decl) => {
    declarations.push(`${decl.prop}: ${decl.value}`);
  });
  return declarations.sort();
}

describe('tokens.css dark-block symmetry', () => {
  // These two guards are the point. Without them, renaming or deleting a selector
  // makes both sides empty and the equality assertion below passes vacuously —
  // which is the exact class of silent failure this file exists to prevent.
  it('finds the OS-preference dark block', () => {
    expect(
      findBlocks().osPreference,
      `No rule matching "${OS_PREFERENCE_SELECTOR}" inside a prefers-color-scheme: dark ` +
        `media query in ${TOKENS_PATH}. If the selector was renamed deliberately, update ` +
        `OS_PREFERENCE_SELECTOR here too — do not delete this assertion.`,
    ).toBeDefined();
  });

  it('finds the explicit-toggle dark block', () => {
    expect(
      findBlocks().explicitToggle,
      `No top-level rule matching "${EXPLICIT_TOGGLE_SELECTOR}" in ${TOKENS_PATH}. ` +
        `If the selector was renamed deliberately, update EXPLICIT_TOGGLE_SELECTOR here too.`,
    ).toBeDefined();
  });

  it('declares at least one token in each block', () => {
    const { osPreference, explicitToggle } = findBlocks();

    expect(declarationsOf(osPreference!).length).toBeGreaterThan(0);
    expect(declarationsOf(explicitToggle!).length).toBeGreaterThan(0);
  });

  it('declares each token exactly once per block', () => {
    const { osPreference, explicitToggle } = findBlocks();

    for (const [name, rule] of [
      ['OS-preference', osPreference!],
      ['explicit-toggle', explicitToggle!],
    ] as const) {
      const declarations = declarationsOf(rule);
      const properties = declarations.map((line) => line.split(':')[0]);

      // A duplicated property would collapse silently and weaken the parity check
      // below, since the later declaration simply wins.
      expect(new Set(properties).size, `${name} block declares a property twice`).toBe(
        properties.length,
      );
    }
  });

  it('declares an identical set of tokens in both blocks', () => {
    const { osPreference, explicitToggle } = findBlocks();

    // Asserted as whole sorted arrays rather than per-property so the failure output
    // names every drifted token at once instead of stopping at the first.
    expect(declarationsOf(osPreference!)).toEqual(declarationsOf(explicitToggle!));
  });
});
