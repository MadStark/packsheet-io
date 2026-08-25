import { describe, expect, it } from 'vitest';
import { createSSRApp } from 'vue';
// The names the island's forms are written with, asserted through the same constants the
// page's POST handler reads them back through: the point of these assertions is that the
// markup and the parser agree, and comparing two hand-typed copies of `'save-item'` would
// only prove that this file agrees with itself.
import { PACK_EDITOR_FIELD, PACK_INTENT } from '../src/lib/packs/editor';
import { PACK_ITEM_FORM_FIELD, parsePackItemForm } from '../src/lib/packs/form';
import { PACK_ITEM_CARRIAGES, PACK_ITEM_CARRIAGE_LABELS } from '../src/lib/packs/fields';
import type { PackTreeGearItem, PackTreeItem } from '../src/lib/totals';

/**
 * ---------------------------------------------------------------------------
 * PK-73 — THE ONE-LINE ROW, THE STEPPER AND THE `…` MENU
 * ---------------------------------------------------------------------------
 *
 * `tests/packs-drag.test.ts` owns the two claims PK-37 made about this component's server
 * output — every control is there, and no drag affordance is — and it still owns them. This
 * file is about what PK-73 CHANGED, and it exists as its own file rather than as another
 * describe block in that one for a reason worth stating: PK-72 is landing in parallel and
 * claims `tests/packs-*.test.ts`, so a new file named outside that glob is a file the two
 * tickets cannot collide in. The edits `packs-drag.test.ts` did need are the handful of
 * assertions that named markup this ticket deleted, and nothing else.
 *
 * WHAT IS WORTH PINNING HERE, AND WHY EACH ONE IS NOT OBVIOUS:
 *
 *   1. EVERY CONTROL POSTS A COMPLETE, VALID TRIPLE. `parsePackItemForm` writes all three
 *      per-item columns on every save. A stepper form that forgot its `carriage` field would
 *      be REFUSED, and one that forgot `packed` would quietly unpack the row — a data loss
 *      with no error and no sign on screen. This is the assertion that would have caught it,
 *      and it is made by feeding the rendered form back through the real parser rather than
 *      by eyeballing the markup for hidden inputs.
 *
 *   2. WORN-AND-CONSUMABLE STAYS UNREPRESENTABLE. The radio group this replaced could not
 *      express it because a browser refuses two checked radios of one name. Three separate
 *      submit buttons cannot express it either, and the reason is different enough to be
 *      worth a test: each button carries ONE `carriage` value and only the pressed button's
 *      name/value is submitted, so no request built from this markup can carry two.
 *      `pack_items_worn_consumable_exclusive` is the constraint on the other end.
 *
 *   3. THE STEPPER CANNOT REACH ZERO. `check (quantity > 0)`, so the `−` at quantity 1 is
 *      disabled rather than offering a submission the database would refuse.
 *
 *   4. NOTHING NEEDS JAVASCRIPT. The menu is a `<details>` in the server output, not a
 *      `<button>` waiting for a click handler, and the three controls that moved into it are
 *      three forms that post. This is the claim that makes moving them there acceptable at
 *      all, given this component's no-JS contract.
 *
 * All of it is asserted against `renderToString`, Vue's own SSR entry, which needs no DOM and
 * therefore runs in this suite's `node` environment — the same route `packs-drag.test.ts`
 * takes, and for the same reason.
 */

const CATEGORY_ID = '11111111-1111-4111-8111-111111111111';
const ITEM_ID = '22222222-2222-4222-8222-222222222222';
const PACK_ID = '44444444-4444-4444-8444-444444444444';
const PACKED_ITEM_ID = '55555555-5555-4555-8555-555555555555';
const SELF_PATH = `/packs/${PACK_ID}`;

interface TreeItem extends PackTreeItem {
  readonly position: number;
}

interface TreeCategory {
  readonly id: string;
  readonly name: string;
  readonly position: number;
  readonly pack_items: readonly TreeItem[];
}

function gear(overrides: Partial<PackTreeGearItem> = {}): PackTreeGearItem {
  return { name: 'Gear', weight_grams: 100, price: null, currency: null, ...overrides };
}

function item(id: string, position: number, overrides: Partial<TreeItem> = {}): TreeItem {
  return {
    id,
    position,
    quantity: 1,
    worn: false,
    consumable: false,
    packed: false,
    overrides: {},
    snapshot: null,
    gear_items: gear(),
    ...overrides,
  };
}

/**
 * Two rows, chosen so that both sides of every conditional in the row render at once: `Tarp`
 * is quantity 1, carried and unpacked (so the `−` is disabled and the packed toggle offers
 * to PACK it), and `Socks` is quantity 3, worn and packed (so the `−` is live, the tick is
 * drawn, and the toggle offers to UNPACK it). A fixture where every row looked the same
 * would let a template that ignored its input pass.
 */
const TREE: TreeCategory[] = [
  {
    id: CATEGORY_ID,
    name: 'Shelter',
    position: 0,
    pack_items: [
      item(ITEM_ID, 0, { gear_items: gear({ name: 'Tarp', weight_grams: 450 }) }),
      item(PACKED_ITEM_ID, 1, {
        quantity: 3,
        worn: true,
        packed: true,
        gear_items: gear({ name: 'Socks', weight_grams: 60 }),
      }),
    ],
  },
];

interface EditorState {
  readonly renameError?: { readonly categoryId: string; readonly message: string } | null;
  readonly itemError?: {
    readonly itemId: string;
    readonly errors: Readonly<Record<string, string>>;
    readonly values: {
      readonly quantity: string;
      readonly carriage: string;
      readonly packed: string;
    };
  } | null;
  readonly pendingCategoryDeleteId?: string | null;
}

async function render(state: EditorState = {}): Promise<string> {
  // Imported inside the function and suppressed the same way `packs-drag.test.ts` does it —
  // see that file's own note for why `@ts-ignore` rather than `@ts-expect-error`, and why a
  // global `declare module '*.vue'` shim would be worse than either.
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore tsc cannot resolve an SFC; astro check, which can, is what checks this one
  const component = (await import('../src/components/PackContents.vue')) as {
    default: Parameters<typeof createSSRApp>[0];
  };
  const { renderToString } = await import('vue/server-renderer');
  return renderToString(
    createSSRApp(component.default, {
      packId: PACK_ID,
      categories: TREE,
      weightSystem: 'metric',
      selfPath: SELF_PATH,
      renameError: state.renameError ?? null,
      itemError: state.itemError ?? null,
      pendingCategoryDeleteId: state.pendingCategoryDeleteId ?? null,
    }),
  );
}

// ---------------------------------------------------------------------------
// Reading the rendered forms back
// ---------------------------------------------------------------------------

/**
 * A `<form>` from the rendered markup, turned into the `FormData` a browser would submit for
 * one of its submit buttons.
 *
 * WHY THIS IS PARSED RATHER THAN PATTERN-MATCHED. The interesting claim is not "the markup
 * contains a hidden carriage input" — it is "what this button posts is a submission
 * `parsePackItemForm` accepts, and it says what the visitor asked for and nothing else". That
 * is a statement about a FormData, so the test has to build one. Substring assertions on
 * hidden inputs would pass just as happily against a form carrying the wrong item's id.
 *
 * The browser rule being modelled is the one this whole design rests on: a submission carries
 * every successful control in the form, PLUS the name/value of the ONE submit button that was
 * pressed, and no other. That is why each control here is its own form.
 *
 * Deliberately small and deliberately strict: it understands `<input type="hidden">` and
 * `<button type="submit">` and nothing else, so a control shape it was not written for fails
 * loudly here instead of being silently skipped.
 */
function formData(formHtml: string, buttonIndex = 0): FormData {
  const data = new FormData();

  for (const tag of formHtml.match(/<input\b[^>]*>/g) ?? []) {
    if (!/type="hidden"/.test(tag)) continue;
    const name = /\bname="([^"]*)"/.exec(tag)?.[1];
    const value = /\bvalue="([^"]*)"/.exec(tag)?.[1];
    if (name === undefined || value === undefined) throw new Error(`Unparseable input: ${tag}`);
    data.append(name, value);
  }

  const buttons = formHtml.match(/<button\b[^>]*>/g) ?? [];
  const button = buttons[buttonIndex];
  if (button === undefined) throw new Error(`No button ${buttonIndex} in: ${formHtml}`);
  // A disabled control is not "successful" and submits nothing at all — which is exactly
  // what the `−` at quantity 1 must do, so modelling it is not pedantry.
  //
  // MATCHES THE ATTRIBUTE, NOT THE SUBSTRING. Vue's SSR never writes `disabled="false"` or
  // `aria-disabled` here — a boolean prop bound false is omitted entirely — but `\bdisabled\b`
  // would treat one as a disabled control if it ever did, which is a live button silently
  // failing to submit rather than the test failing loudly. `[\s>]` requires the word to end
  // the attribute, not continue into `="false"` or into `aria-disabled`.
  if (/(?:^|\s)disabled[\s>]/.test(button)) return data;
  const name = /\bname="([^"]*)"/.exec(button)?.[1];
  const value = /\bvalue="([^"]*)"/.exec(button)?.[1];
  if (name !== undefined && value !== undefined) data.append(name, value);

  return data;
}

/**
 * Every `<form>` in the markup, as raw strings. Forms cannot nest in parseable HTML, so a
 * non-greedy match between the tags is exact rather than approximate.
 *
 * COMMENTS ARE STRIPPED FIRST, and that is not tidiness — it is a bug this helper had. Vue's
 * SSR keeps HTML comments, this component's template is mostly comments, and one of them
 * contains the literal string `<form>` while explaining why each control IS one. The match
 * then started inside the prose and swallowed everything up to the next real `</form>`, which
 * is how "one form posts carriage=carried" came back as four.
 */
function forms(html: string): string[] {
  return html.replace(/<!--[\s\S]*?-->/g, '').match(/<form\b[\s\S]*?<\/form>/g) ?? [];
}

/** The forms belonging to one item, which is every form carrying that item's id. */
function formsForItem(html: string, itemId: string): string[] {
  return forms(html).filter((form) => form.includes(`value="${itemId}"`));
}

/**
 * The one form whose SUBMIT BUTTON carries this name/value pair.
 *
 * "Its button", not "the form contains that string anywhere", and the difference is the whole
 * usefulness of this helper. Every form on a row also carries the two settings it is not
 * changing as HIDDEN inputs with the same names — so Tarp, whose stored carriage is
 * `carried`, has four forms containing `name="carriage" value="carried"` and exactly one that
 * POSTS it as the visitor's choice. Matching the hidden copies would have made
 * "produces exactly one carriage per submission" pass by looking at the wrong form.
 */
function formWith(html: string, itemId: string, name: string, value: string): string {
  const match = formsForItem(html, itemId).filter((form) =>
    (form.match(/<button\b[^>]*>/g) ?? []).some((button) =>
      button.includes(`name="${name}" value="${value}"`),
    ),
  );
  if (match.length !== 1) {
    throw new Error(`Expected one form whose button posts ${name}=${value}, found ${match.length}`);
  }
  return match[0]!;
}

describe('PK-73: every per-item control is a form that posts a complete, valid save', () => {
  /**
   * CLAIM 1, and the one that would have caught the worst possible bug in this ticket. Each
   * control changes ONE of the three columns and has to carry the other two forward, because
   * `parsePackItemForm` writes all three every time. A stepper that dropped `packed` would
   * unpack a row every time somebody changed its quantity, with no error and nothing on
   * screen to say it had happened.
   *
   * Asserted through the real parser, over the real rendered markup, for both rows — the
   * packed/worn one is the row where a dropped field is actually visible.
   */
  it('posts the two settings it is not changing, for every control on the row', async () => {
    const html = await render();

    const increment = formWith(html, PACKED_ITEM_ID, PACK_ITEM_FORM_FIELD.quantity, '4');
    const parsed = parsePackItemForm(formData(increment));

    expect(parsed.ok).toBe(true);
    // Quantity is what this button changes; worn and packed are what it must NOT lose.
    expect(parsed).toMatchObject({
      ok: true,
      values: { quantity: 4, worn: true, consumable: false, packed: true },
    });
  });

  it('changes only the carriage when a carriage command is pressed', async () => {
    const html = await render();

    const consumable = formWith(html, PACKED_ITEM_ID, PACK_ITEM_FORM_FIELD.carriage, 'consumable');
    const parsed = parsePackItemForm(formData(consumable));

    expect(parsed).toMatchObject({
      ok: true,
      // Was worn; is now consumable, and neither flag is left on. Quantity and packed ride
      // through untouched.
      values: { quantity: 3, worn: false, consumable: true, packed: true },
    });
  });

  /**
   * One button that both packs and unpacks, which it does by carrying the hidden `packed`
   * field exactly when the row is NOT already packed. An absent checkbox field is how
   * `parseCheckbox` reads false — the same shape the checkbox this replaced posted when it
   * was left unticked.
   */
  it('offers to pack an unpacked row and to unpack a packed one', async () => {
    const html = await render();

    const packTarp = formsForItem(html, ITEM_ID).find((form) => form.includes('Mark as packed'));
    const unpackSocks = formsForItem(html, PACKED_ITEM_ID).find((form) =>
      form.includes('Mark as not packed'),
    );
    expect(packTarp).toBeDefined();
    expect(unpackSocks).toBeDefined();

    expect(parsePackItemForm(formData(packTarp!))).toMatchObject({
      ok: true,
      values: { quantity: 1, worn: false, consumable: false, packed: true },
    });
    expect(parsePackItemForm(formData(unpackSocks!))).toMatchObject({
      ok: true,
      values: { quantity: 3, worn: true, consumable: false, packed: false },
    });
  });

  /**
   * THE STEPPER STEPS FROM THE STORED QUANTITY. `values.quantity` holds the visitor's
   * REJECTED input on the one row a submission failed for, and a stepper reading that would
   * offer to move from a number the database never accepted — `'0'` here, so `+` would offer
   * 1 and `−` would offer -1. Both buttons must be computed from the stored 1 instead.
   */
  it('steps from the stored quantity, not from a rejected submission', async () => {
    const html = await render({
      itemError: {
        itemId: ITEM_ID,
        errors: { quantity: 'Enter a whole number greater than zero for quantity.' },
        values: { quantity: '0', carriage: 'carried', packed: '' },
      },
    });

    const row = formsForItem(html, ITEM_ID).join('');
    expect(row).toContain(`name="${PACK_ITEM_FORM_FIELD.quantity}" value="2"`);
    expect(row).not.toContain(`name="${PACK_ITEM_FORM_FIELD.quantity}" value="-1"`);
    // The message itself still renders, and still carries the id the stepper group points at.
    expect(html).toContain(`id="item-${ITEM_ID}-error-quantity"`);
    expect(html).toContain(`aria-describedby="item-${ITEM_ID}-error-quantity"`);
  });
});

describe('PK-73: the stepper cannot ask for a quantity the database would refuse', () => {
  /**
   * `pack_items_quantity_check` is `quantity > 0`. At 1 there is no lower value, so the `−`
   * is disabled — which in a browser means it submits nothing at all, not that it submits 0.
   * Both halves are asserted: the attribute is there, and a submission built from that form
   * carries no quantity (which `parsePackItemForm` then reads as "the visitor did not say",
   * leaving the column at its default of 1 — the same value it already held).
   */
  it('disables the decrement at quantity 1', async () => {
    const html = await render();

    const tarpDecrement = formsForItem(html, ITEM_ID).find((form) =>
      form.includes(`name="${PACK_ITEM_FORM_FIELD.quantity}" value="0"`),
    );
    expect(tarpDecrement).toBeDefined();
    expect(tarpDecrement).toContain('disabled');

    const parsed = parsePackItemForm(formData(tarpDecrement!));
    expect(parsed).toMatchObject({ ok: true, values: { quantity: 1 } });
  });

  it('leaves the decrement live above quantity 1', async () => {
    const html = await render();

    const socksDecrement = formWith(html, PACKED_ITEM_ID, PACK_ITEM_FORM_FIELD.quantity, '2');
    expect(socksDecrement).not.toContain('disabled');
    expect(parsePackItemForm(formData(socksDecrement))).toMatchObject({
      ok: true,
      values: { quantity: 2 },
    });
  });

  /** There is no free number field left on the row at all — that is the design feedback's
   *  actual request, and a `type="text"` quantity input surviving anywhere would mean the
   *  old control had been left beside the new one. */
  it('offers no free quantity field', async () => {
    const html = await render();
    expect(html).not.toContain('inputmode="numeric"');
    expect(html).not.toMatch(new RegExp(`type="text"[^>]*name="${PACK_ITEM_FORM_FIELD.quantity}"`));
  });
});

describe('PK-73: worn and consumable stay mutually exclusive', () => {
  /**
   * The constraint on the other end is `pack_items_worn_consumable_exclusive`, and the
   * component's old defence was that a radio group cannot check two radios of one name. The
   * new defence is stronger and needs saying out loud: a form submission carries the name and
   * value of the ONE submit button that was pressed, so each of these three forms can only
   * ever post one `carriage`. Asserted by pressing each button in turn and checking that the
   * flags `carriageFlags` produces are never both true — which is every submission this
   * markup can produce for this row.
   */
  it('produces exactly one carriage per submission, whichever command is pressed', async () => {
    const html = await render();

    for (const carriage of PACK_ITEM_CARRIAGES) {
      const form = formWith(html, ITEM_ID, PACK_ITEM_FORM_FIELD.carriage, carriage);
      const data = formData(form);

      // One value for the field, not three: the two buttons NOT pressed contribute nothing.
      expect(data.getAll(PACK_ITEM_FORM_FIELD.carriage)).toEqual([carriage]);

      const parsed = parsePackItemForm(data);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) throw new Error('unreachable');
      expect(parsed.values.worn && parsed.values.consumable).toBe(false);
    }
  });

  /** The three options are offered by their words, not by their icons alone. A pictogram for
   *  "used up during the trip" that everybody reads correctly cold does not exist, and
   *  `PACK_ITEM_CARRIAGE_MEANINGS`' own comment says a hint may never be the substitute. */
  it('labels each option with its word as well as its icon', async () => {
    const html = await render();
    for (const carriage of PACK_ITEM_CARRIAGES) {
      expect(html).toContain(PACK_ITEM_CARRIAGE_LABELS[carriage]);
    }
  });

  /** A menu of commands has no selected state of its own the way a radio group does, so the
   *  one in force is marked in the two channels that are left: `aria-current` for a screen
   *  reader, a tick for everybody else. Exactly one per row, or the mark means nothing. */
  it('marks exactly one carriage as current per row', async () => {
    const html = await render();
    const socks = formsForItem(html, PACKED_ITEM_ID).filter((form) =>
      form.includes(`name="${PACK_ITEM_FORM_FIELD.carriage}" value=`),
    );

    const current = socks.filter((form) => form.includes('aria-current="true"'));
    expect(current).toHaveLength(1);
    expect(current[0]).toContain(`name="${PACK_ITEM_FORM_FIELD.carriage}" value="worn"`);
  });
});

describe('PK-73: the row menu needs no JavaScript', () => {
  /**
   * THE CLAIM THAT MAKES MOVING THREE CONTROLS INTO A MENU ACCEPTABLE. This component's
   * contract is that the markup the server sends IS the editor; a menu built from a
   * `<button>` and a click handler would have put the carriage choice, the packed toggle and
   * Remove behind a bundle. `<details>`/`<summary>` opens with no script, is focusable, and
   * toggles on Enter and on Space.
   *
   * Pinned as "a `<details>` is in the SSR output and it is closed", because both halves
   * matter: an `open` attribute here would mean forty expanded menus on a forty-item pack for
   * anybody whose JavaScript never arrives.
   */
  it('renders the menu as a closed <details> in the server output', async () => {
    const html = await render();

    expect(html).toContain('<details class="row-menu"');
    expect(html).toContain('<summary');
    expect(html).not.toContain('<details open');
    expect(html).not.toMatch(/<details[^>]*\sopen[\s>]/);
  });

  /** The three controls that moved are three real forms inside it, posting the same intents
   *  the page's handler has always read. */
  it('keeps the moved controls as plain posting forms', async () => {
    const html = await render();

    const remove = formsForItem(html, ITEM_ID).find((form) =>
      form.includes(`value="${PACK_INTENT.removeItem}"`),
    );
    expect(remove).toBeDefined();
    expect(remove).toContain('method="post"');
    expect(formData(remove!).get(PACK_EDITOR_FIELD.itemId)).toBe(ITEM_ID);
  });

  /**
   * The trigger is an icon, so its accessible name is the only name it has — and it has to
   * say which row, for the reason every other named control in this component gives: a pack
   * of forty items otherwise offers forty controls called "Actions".
   */
  it('names each menu for the row it belongs to', async () => {
    const html = await render();
    expect(html).toContain('aria-label="Actions for Tarp"');
    expect(html).toContain('aria-label="Actions for Socks"');
    expect(html).toContain('aria-label="Actions for Shelter"');
  });

  /**
   * WCAG 2.5.3, Label in Name, for the stepper. The visible control is a pair of icons, so
   * there is no visible string to contain — but "Qty" was what the control was called before
   * PK-73, it is what a speech-input user has learned to say, and both labels keep it.
   */
  it('keeps "Qty" in the name of every quantity control', async () => {
    const html = await render();
    expect(html).toContain('aria-label="Qty for Tarp"');
    expect(html).toContain('aria-label="Decrease Qty for Tarp"');
    expect(html).toContain('aria-label="Increase Qty for Tarp"');
  });
});

describe('PK-73: the figures are a sheet of their own, and there is still one of them', () => {
  /**
   * The design feedback moved the weights out of the gear area. What must NOT have happened
   * is that they were re-rendered from the page's own server-side `computeTotals` call: that
   * would fork one set of figures into two sources that a drag can pull apart. They are still
   * derived from this component's tree — this pins that they are still HERE, exactly once,
   * and now on a sheet that is not the Categories sheet.
   */
  it('renders the figures once, on their own sheet, outside the list', async () => {
    const html = await render();

    expect(html.split('Base weight')).toHaveLength(2);
    expect(html).toContain('class="sheet pack-weights"');
    // 450 g carried + 3 × 60 g worn. Base weight is the carried half only.
    expect(html).toContain('450 g');
    expect(html).toContain('630 g');
    // The figures sheet opens before the Categories sheet, which is what puts them up top.
    expect(html.indexOf('pack-weights')).toBeLessThan(html.indexOf('pack-contents-heading'));
  });

  /** §9: an empty page has no figures to report. The whole sheet goes, not just the `<dl>` —
   *  an empty white rectangle above an empty-state invitation is worse than no rectangle. */
  it('renders no figures sheet for a pack with no categories', async () => {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore tsc cannot resolve an SFC; astro check, which can, is what checks this one
    const component = (await import('../src/components/PackContents.vue')) as {
      default: Parameters<typeof createSSRApp>[0];
    };
    const { renderToString } = await import('vue/server-renderer');
    const html = await renderToString(
      createSSRApp(component.default, {
        packId: PACK_ID,
        categories: [],
        weightSystem: 'metric',
        selfPath: SELF_PATH,
        renameError: null,
        itemError: null,
        pendingCategoryDeleteId: null,
      }),
    );

    expect(html).not.toContain('pack-weights');
    expect(html).not.toContain('Base weight');
    expect(html).toContain('This pack has no categories yet.');
  });
});

describe('PK-73: the packed state is still visible on the row', () => {
  /**
   * The checkbox went into the menu, and a state that is only in a menu is a state nobody
   * sees. The figures above report "Packed 1 / 2", so the list has to be able to say WHICH —
   * a tick on the row, and a sentence for anybody who is not looking at it.
   */
  it('marks a packed row and leaves an unpacked one unmarked', async () => {
    const html = await render();

    expect(html).toContain('title="Socks is packed"');
    expect(html).not.toContain('title="Tarp is packed"');
    expect(html.split('Packed.')).toHaveLength(2);
    // COUNTS ARE QUANTITIES, NOT ROWS (src/lib/totals.ts): three packed socks out of four
    // things, not one packed row out of two. The tick marks the ROW, and the figure counts
    // what is in the bag — asserted together here so that a future change making the tick
    // per-unit, or the count per-row, has to notice that the two say different things.
    expect(html).toContain('3 / 4');
  });
});
