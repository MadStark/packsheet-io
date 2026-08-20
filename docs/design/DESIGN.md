# The Notebook Paper design language

A description of the visual system Packsheet is built in, written so it can be lifted onto any site. It is not a page-by-page spec — it explains the materials, the rules that hold them together, and the CSS recipes that produce them, so a different surface with different content can be built in the same language and still feel like the same thing.

Where a rule exists because something was tried and failed, the failure is written down. Those are the parts most likely to be undone by someone who does not know why they are there.

---

## 1. The idea in one paragraph

**The screen is a printed form, and everything the visitor has entered is what they wrote on it.** The page is a sheet of squared notebook paper; the content sits on flat white sheets lying on it. Two physical layers, and only two: the **paper** (the ground, squared, faintly warm) and the **sheets** (white cards that carry all content). Depth comes from shadow, never from borders or colour. Nothing is ever written directly on the paper, and no two papers ever overlap. Nothing is tilted, taped, pinned or clipped. Ink is quiet and dark; colour is scarce and always means something. Two typefaces divide the page between them: one prints, one writes. The effect should read as _calm and tactile_ — a well-kept notebook — not as a scrapbook and not as a SaaS dashboard.

That one sentence — the app prints, the visitor writes — is the whole system. Almost every rule below follows from it, and a decision that cannot be justified by it is probably wrong.

---

## 2. Materials

### 2.1 The paper

The paper is the page ground and the only place a pattern is allowed. It is very nearly white with a whisper of yellow, `#fdfcf6`, and carries a **squared grid on a 20px cell** — _petits carreaux_, the French exercise book.

```css
--paper: #fdfcf6;
--grid-ink: rgba(70, 105, 150, 0.1);

background:
  linear-gradient(var(--grid-ink) 1px, transparent 1px) 0 0 / 20px 20px,
  linear-gradient(90deg, var(--grid-ink) 1px, transparent 1px) 0 0 / 20px 20px,
  var(--paper);
```

**One finish, not a menu.** Dots, ruled, Seyès, graph and plain were all built and compared on the real closet; squared won. They are not alternatives to keep documented — a site that offers four finishes gets four finishes. If you want to see what was rejected and why, that history is on the ticket, not in this file.

The pattern ink is a **desaturated slate blue** — never grey, never the text ink. Real notebook printing is a pale blue-grey and the eye recognises it instantly; a grey grid reads as a wireframe.

The grid is set at `.10` rather than the more cautious `.085` you would use for a pattern that content sits on. It can be stronger here because **every sheet is opaque, so the grid is only ever seen in the margins and in the 30px gaps between sheets** — never read through. This also makes the finish a desktop-width decision: on a narrow viewport, where sheets go full width at 20px padding, very little of it survives, and that is expected.

A **paper grain** overlay sits over the whole ground: an inline SVG `feTurbulence` (`baseFrequency .85`, two octaves) tinted warm, at very low alpha, `mix-blend-mode: multiply`, `pointer-events: none`. It is nearly invisible alone and stops the ground reading as a flat vector fill. It must never be strong enough to notice on the white sheets.

The page is **full-bleed**: the paper is the viewport. There is no framed "sheet on a desk" variant. The language is light-only, because paper is.

### 2.2 The ground must not sit at a negative z-index

This has its own section because it fails silently and takes the entire design with it.

The obvious implementation is a `position: fixed` layer at `z-index: -2`, behind everything. **Do not.** A negative-z descendant paints between the _root element's_ background and the _in-flow backgrounds of its siblings_ — so the moment `<body>` has a background of its own, that background covers the ground and the paper disappears completely. No error, no warning, just a blank page. It is invisible in any context where `body` happens to be transparent and fatal in any context where something paints behind the page.

```css
/* the ground and the grain sit at z-index 0 and rely on DOM order */
.ground {
  position: fixed;
  inset: 0;
  z-index: 0;
}
.grain {
  position: fixed;
  inset: 0;
  z-index: 0;
  pointer-events: none;
}
.page {
  position: relative;
  z-index: 0;
} /* later in the DOM, paints above both */
```

`body` must be given an **explicit background** from the token rather than left transparent. A page that only works because `body` happens to have no background is one stylesheet away from losing its ground.

`.page` being its own stacking context is also what keeps the sheets' curl shadows working — see §2.4.

### 2.3 Sheets

A sheet is a flat, straight, white rectangle lying on the paper, and it is the unit of page composition. Every region of content — the top bar, a header, a table, a form — lives on a sheet. Sheets are pure white (`#ffffff`; nothing else on the page is pure white), have a 1px border of near-nothing (`rgba(60,45,20,.08)`), 40px of padding, and sit 30px apart so the paper shows between them. A **strip** is a sheet with zero padding and a fixed height, used for the navigation bar.

The composition rule is _few, large sheets_: one sheet per part of the document, never one per widget. **A page whose only job is one form gets one sheet, with its title inside it** — a cover sheet carrying nothing but an `h1` is a second sheet doing no work, and it looks like a mistake because it is one.

Sheets are never nested, never overlap, never rotate, and their edges always align to the same content column. If a page needs more than four or five sheets, it is trying to be a dashboard and this language will fight it.

The sheet's shadow is the corner curl of §2.4 at its softer setting, over a light ambient shadow: `0 1px 2px rgba(60,45,20,.08), 0 6px 18px -6px rgba(60,45,20,.10)`.

### 2.4 The corner-curl shadow

This is the one trick that makes flat rectangles read as paper. Instead of a uniform drop shadow, the shadow is deepest at the two bottom corners and fades toward the middle and the top edge — as if the sheet were resting on its centre and lifting very slightly at the corners. It is built from two pseudo-elements inside the bottom of the element, rotated a couple of degrees in opposite directions, casting a blurred shadow that leaks out from under the box:

```css
.paper-object {
  position: relative;
  background: #fff;
}
.paper-object::before,
.paper-object::after {
  content: '';
  position: absolute;
  z-index: -1;
  bottom: 14px;
  width: 40%;
  height: 24%;
  max-height: 120px;
  box-shadow: 0 12px 14px rgba(60, 45, 20, 0.2);
}
.paper-object::before {
  left: 10px;
  transform: rotate(-2.2deg);
}
.paper-object::after {
  right: 10px;
  transform: rotate(2.2deg);
}
```

The height is capped so a very tall sheet does not grow a huge shadow. The shadow colour is always the warm ink `60,45,20`, never black — a black shadow on warm paper looks like a hole.

**The element that owns the curl must not create a stacking context.** No `transform`, no `isolation`, no `z-index`, no `filter` on it. If it does, its own `z-index:-1` pseudo-elements paint _above_ its background and you see two grey slabs on the card. This is also the mechanical reason nothing is tilted: a rotation is a transform.

### 2.5 Notes, and the no-overlap rule

**No two papers ever overlap.** Nothing lies on top of a sheet, and nothing hangs off its edge.

This retires the note-on-a-sheet, which used to be the language's emphasis device. A **note** is still a white card with a stronger curl — but it may only lie **directly on the paper**, as a sibling of the sheets, never on one. In practice that means notes are page-level interruptions: an error banner, a delete confirmation.

Emphasis inside a sheet therefore comes from **rules, size and position** rather than from a second surface. In practice this is enough; a closet has nothing that genuinely needs to shout. Headline figures are set flat inside their sheet, ruled off with a hairline above and separated from each other by hairlines — see §7.

_(The yellow "sticky" variant and the index tab are both gone. See the appendix.)_

### 2.6 Ink and rules

Everything drawn on a sheet is drawn in ink. Rules are 1px and horizontal only — vertical rules do not exist in this language, with the single exception of the hairlines separating the headline figures of §7. (Not a table's totals row, which this said before implementation checked it: a totals row is separated from the body by a horizontal ink rule and has no vertical rules at all. The headline figures are the `<dl>` that sits flat inside a sheet, and the hairlines between them are the only verticals on the site.) Table body rows are separated by the **hairline** (`#e3dcd0`); the header row and any total row are underlined in full **ink** (`#1c1917`), which is what gives a table its ledger feel without borders. Section dividers inside a sheet are hairlines with 40px above and below. Nothing is boxed.

---

## 3. Rhythm

The layout sits on the paper's 20px cell: body text is 15/20, table rows 40px, table headers 20px, headings 40px, sheet padding 40px, section gaps 40 or 60px. Do this and text and rules land on the grid's lines instead of fighting them, which is a large part of why the pages look composed rather than merely aligned.

The content column is **1000px including 40px side padding**, so a sheet's inner width is ~920px. On narrow viewports sheets go full width at 20px padding.

Two deliberate exceptions, both recorded rather than fudged:

- The **30px gap between sheets**, chosen so sheets read as separate objects without wasting a full cell.
- A **display lead paragraph at 19/30**. The rhythm governs _rules and section boundaries_, which still land on the cell; a 19px lead at 19/20 is unreadably tight and at 19/40 is a different page.

**A wrapped table cell breaks the rhythm for every row below it**, because a 40px row becomes 60 and every hairline after it leaves the grid. So no data column wraps. Names are the one column allowed to be long; if the columns do not fit, remove a column rather than let one wrap.

---

## 4. Typography — two voices

**This is the centre of the system.** Two faces, and the rule for which is which is not stylistic — it is about who is speaking.

| Voice                                | Face                  | Sets                                                                                                                                                      |
| ------------------------------------ | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Written** — what the visitor wrote | **Klee One** 400/600  | Item names, brands, categories; every value in a form, including numeric fields; all figures; anything the visitor typed that became part of their record |
| **System** — what the app says       | **Inter** 400/500/600 | Page titles, column headers, section labels, buttons, navigation, hints, error messages, placeholders, totals' _labels_, pagination counts                |

Klee One is a Japanese textbook-hand design: it reads as written without being a script, and — crucially — it stays legible in a column of values at 15px, where an actual handwriting face does not. Inter is deliberately plain and screen-native; the two voices need to be far apart or the distinction stops doing any work.

**Where the line falls**, for the cases that are not obvious:

- A form field's **value** is written — you are typing it, so it is yours. Its **placeholder** is system: that is the form prompting you.
- A **unit select** beside a weight is written, because it is half of a value you did type. Rendering "539" in Klee One and "g" in Inter splits one quantity across two voices.
- A **bulk-action select** is system, because "Owned" there is an instruction to the app, not part of an item's record.
- A **search field** is system. The test is _did the visitor write this onto their list_ — a category they typed is on the list; a search query is a question asked of the app and gone a moment later.
- A **totals row** has a system label and written figures.
- The hand **never sets anything operable**. A button is the app speaking, always.

**Figures are written, and they still align.** Klee One's digits were measured in the browser: `111111`, `000000` and `478901` all render to exactly the same advance width. Its numerals are uniform width natively, so a written column of weights still aligns on its right edge. Keep `font-variant-numeric: tabular-nums` declared anyway, so a future face swap cannot silently lose the property.

Because of that measurement **there is no mono face in this system.** The earlier rule that every numeral be set in a monospace was there to make columns align; Klee One does that on its own, and a third family is weight and complexity for nothing.

**Sizes.** Body 15/20. Small 13. Section labels 12px uppercase at `.12em` tracking in the third ink. Section titles 18/20 at 600. Page titles 34/40 at 600. A landing wordmark may go to 54/60. Numerals sit at 14.5px, one notch below body, so a column of figures reads as data without shouting.

**A signed-out page has no written voice**, because the visitor has not written anything yet. Do not smuggle the hand in decoratively. Show the product instead — a specimen of real content, where the written voice appears honestly because it is depicting somebody's data. This is also a better landing page than a paragraph describing one.

Both families are self-hosted (latin subsets, WOFF2) so a public page loads nothing from a font CDN. **Preload the system face**, not the written one: Inter paints the chrome and headings, and is the face whose absence shows first.

---

## 5. Colour

The palette is the ink of one pen and a small box of coloured pencils. The neutrals are warm: paper `#fdfcf6`, sheet `#ffffff`, sunk `#f5f1e4`, hairline `#e3dcd0`, rule `#d2c8b8`, ink `#1c1917`, second ink `#6b6259`, third ink `#7a7468`. Never introduce a cool grey; a single blue-grey pixel next to this warmth looks dirty.

The third ink is `#7a7468`, **not** the `#8c8578` you might reach for. Measured: `#8c8578` scores 3.56:1 on paper and 3.66:1 on the sheet and fails AA for normal text, while the third ink sets 12px section labels and column headers. `#7a7468` keeps that colour's hue, clears AA at 4.51:1 / 4.64:1, and stays visibly lighter than the second ink.

Colour is semantic or absent. **Blue** (`#0070d4`, deep `#005aab`, ink `#003d73`, tint `#e4f0fc`) means _interactive_ — links, the primary button, a pressed toggle — and, in this domain, one measured quantity (base weight). It is never decorative. The state accents are mid-saturation earths so none of them shouts: **ochre** `#b5822e` (wishlist, consumables), **rust** `#b24a3c` (retired, danger), **moss** `#3d7a52` (owned, success), **worn purple** `#7a6a9b`. Ten category colours in the same register exist for fills only — dots, bars, segments — and are never used as text.

Where an accent must be legible on a light ground, use its `-ink` cut (`#8a6118` for ochre), which clears 4.5:1 on white and on the hover wash.

Fills are rare: a pressed segment fills with ink and shows paper-coloured type; a row hover is a 4% ink wash; a row in a state takes a 5.5% accent wash; a primary button takes the blue tint. That is the whole list.

---

## 6. Controls

Controls are drawn on the sheet with the same pen as everything else, and they all speak in the **system** voice.

**A button** is a 28px box with a 1px ink border, 6px radius, white fill, and a hard 1px offset shadow (`1px 1px 0 rgba(60,45,20,.18)`) that reads as a stamp. On hover it lifts a pixel and the shadow grows to 2px; on press it drops flat. The **primary** button swaps ink for deep blue and takes the blue tint. A **destructive** button swaps ink for rust on the same box — the same move, so it needs no new shape.

**A field is not a button.** Inputs, textareas and selects take the same box — 1px ink, 6px radius, white fill — but **never the stamp shadow**. The stamp is what says _press me_; borrowing it for a field makes every field look pressable. That single distinction is what lets one box shape serve both without ambiguity. Field values are set in the written face (§4).

**A search field** is the exception: a bare underline in ink with an icon, no box.

**A checkbox** is a 15px square in the same ink box at 3px radius. Checked, it **fills with ink** and shows a paper-coloured tick — the same "pressed fills with ink" move a segmented control uses, rather than a new idea.

**A choice of three or fewer is one segmented control, not a stack of radios.** It is the button's box split by 1px ink dividers; the selected segment fills with ink and its label and icon go paper-coloured. This says _exactly one of these is true_, which a radio stack only implies. Reserve real radios for longer lists.

**Focus is always visible**: a 2px blue outline offset by 2px, on `:focus-visible` only.

---

## 7. Lists and tables

Tables are ledgers. Column headers are 12px uppercase system labels in the third ink on a 20px row, underlined in ink. Body rows are 40px, separated by hairlines, with the first column flush left and the last flush right. Values are written; figures are right-aligned. A totals row is separated by an ink rule, its label in the system voice at 500 and its figures written. Row hover is the 4% ink wash.

**A row's state is shown at its left edge and across the row, never in the middle and never off the sheet:**

- an inline 16px **status icon** before the name, carrying its own accessible name
- a **5.5% wash** of the state's colour across the row
- a **3px bar** of that colour at the row's left edge
- a **strike** through a retired item's name

**The default state carries no mark.** In a closet where most items are owned, a tick on every owned row is the most repeated thing in the table and says nothing. Mark the exceptions only. Keep the icon cell's width so names stay aligned down the column.

**Headline figures** sit flat inside their sheet: a hairline above, the label above the figure, and hairlines between figures. Not a note, not a second surface.

Group headers, where a list is grouped, take a 40px row with a 10px colour dot, a count and a subtotal, and each group repeats the column labels so a reader dropping in mid-page is never lost.

---

## 8. Forms

A form page is **one sheet**, with the page title inside it.

Fields stack in a single column at a comfortable measure — a form is read down, not across — with two- and three-up rows only for genuinely paired values (weight and its unit, price and its currency). Gaps are one cell.

- **Label**: 12px uppercase system, third ink, above the field.
- **Required**: a rust asterisk on the label. Enforcement stays server-side; the asterisk and `aria-required` are what communicate it.
- **Hint**: 13px system, second ink, below the field.
- **Field error**: the field's own box turns rust with a faint inset, and the message sits below it in rust at 13px, in the system voice — the app is the one objecting. Nothing is filled; a filled error field would be the only filled control on the page.
- **Error summary**: a note carrying the 5.5% rust wash and a 3px inset rust bar, above the sheet. It lists what to fix and names each field.

A rejected submission **keeps everything the visitor typed** except the values the server refused. A form that also lost its contents would be a different, worse design.

---

## 9. States

- **Empty**: a short lead in the section-title size, a sentence of explanation in the second ink, and the one action that resolves it. On a sheet, centred, with real air — 60px of padding, not a bordered box.
- **No results**: the same shape, smaller, with the escape hatch (clear the filters) as a link rather than a button.
- **Alert / error**: a note on the paper carrying the 5.5% rust wash and the 3px inset rust bar. Not a boxed banner, and not a fill.
- **Destructive confirmation**: a note on the paper, same treatment, with the rust button and a plain cancel. It says what will happen, whether it can be undone, and what else it affects.
- **An empty page has no figures to report.** Hide the headline figures rather than showing zeros or, worse, a stale count above an empty state.

---

## 10. Charts

_The one section of this document not re-tested during the redesign. Treat it as inherited, and verify it against §4 and §5 before relying on it._

Charts are drawn straight onto the sheet in the category fills, with a hairline track behind them: a donut with the headline figure at its centre and a small uppercase label under it; horizontal bars on a hairline track, each preceded by its dot and name and followed by its value. No axes, no gridlines, no legends separate from the data, no gradients, no 3D. If a chart needs a title, it is a section label.

---

## 11. Motion

Paper does not animate. Sheets and notes never move, slide, fade in or parallax. The only motion is on controls (150ms `ease` on hover and press) and on values that change when a control is used. `prefers-reduced-motion` collapses even those to zero.

---

## 12. Accessibility

Contrast is measured, not hoped for: every ink and every accent used as text clears AA on both the paper and the white sheet, and the pattern is far below the contrast that would interfere with reading. Numerals are uniform-width so nothing jitters as values update. Every interactive element is a real button or link with a visible focus ring, and the written face never sets anything operable.

**Colour is never the only signal.** A row in a state carries an icon with an accessible name, a strike or a bar — shape as well as hue. This matters more now than it used to: the index tab, which carried a _word_, is gone.

---

## 13. What this language refuses

It refuses **text written directly on the paper** — the ground is a ground, and text on it looks like clutter within seconds. It refuses **two overlapping papers**: nothing lies on a sheet and nothing hangs off one. It refuses tilt of any kind, tape, pins, paperclips, torn edges, coffee rings and other scrapbook props; the paper feel comes from the grid and the corner-curl shadows, and anything more turns it into a theme. It refuses cool greys, pure black, gradients on surfaces, uniform drop shadows, boxed cards inside cards, borders as separators, and colour as decoration. It refuses **dark mode** as a theme — the language is light-only, because paper is. And it refuses density for its own sake: if a screen wants twelve widgets, it wants a different language.

---

## 14. Token sheet

```css
:root {
  /* ground */
  --paper: #fdfcf6;
  --note: #ffffff;
  --paper-deep: #f5f1e4; /* sunk areas: header rows, thumbnails */
  --cell: 20px;
  --grid-ink: rgba(70, 105, 150, 0.1);
  --shadow-ink: 60, 45, 20; /* every shadow is rgba(var(--shadow-ink), a) */

  /* ink */
  --ink: #1c1917;
  --ink-2: #6b6259;
  --ink-3: #7a7468; /* NOT #8c8578 — that fails AA. See §5. */
  --hairline: #e3dcd0;
  --rule: #d2c8b8;

  /* meaning */
  --blue: #0070d4;
  --blue-deep: #005aab;
  --blue-ink: #003d73;
  --blue-tint: #e4f0fc;
  --ochre: #b5822e;
  --ochre-ink: #8a6118;
  --rust: #b24a3c;
  --moss: #3d7a52;
  --worn: #7a6a9b;

  /* type — two voices, §4 */
  --font-system: 'Inter', ui-sans-serif, system-ui, sans-serif;
  --font-written: 'Klee One', ui-serif, Georgia, serif;

  /* shape */
  --radius: 6px; /* buttons, fields, segments. Sheets are square. */
}
```

---

## 15. Porting it to another site

Start with the ground: set the paper colour and the squared grid on a page-level wrapper, **at `z-index: 0`, not behind the body** (§2.2), give `body` an explicit background, and add the grain overlay. Then decide the sheets — usually a strip for navigation, one sheet per part of the document — and put every piece of content on one; if you find text on the paper, it belongs on a sheet. Give the sheets the softer curl and the 30px gap. Never put one paper on another.

Then split the type by voice, not by size: the app prints in the system face, the visitor writes in the written face, and figures are written. Map your states to the semantic accents and show them at the row's left edge and across the row. Set everything on the 20px cell. Then take things away until it is calm.

---

## Appendix — what changed, and why

For anyone holding the first version of this document. Each of these was decided against a working prototype, not in the abstract.

| Was                                                              | Is                                                | Why                                                                                                                                                                                       |
| ---------------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Klee One prints; Caveat writes, rationed to one phrase per sheet | **Klee One writes; Inter prints**                 | The roles were backwards. Klee One is a textbook hand — it _is_ the written voice, and unlike Caveat it survives a column of values. Caveat drops out entirely.                           |
| Every numeral in IBM Plex Mono, tabular                          | **Figures are written**                           | Klee One's digits are uniform width — measured, not assumed — so a written column still aligns. The mono face existed only for that alignment, so it goes, taking a whole family with it. |
| Four paper finishes to choose from                               | **Squared only**                                  | Five were built and compared on the real closet. Offering four finishes gets you four finishes.                                                                                           |
| Dots at `.24` on a 20px cell                                     | **Squared grid at `.10`**                         | Tuned against the sheets. Because sheets are opaque, the grid is only ever seen in the margins, so a cautious value reads as nothing.                                                     |
| A note is a card lying on a sheet                                | **No two papers overlap**                         | The emphasis device became the rule's first casualty. Notes now lie on the paper only; emphasis inside a sheet is rules, size and position.                                               |
| Index tabs hang off the sheet's right edge                       | **Removed**                                       | The last thing on the page that overlapped another paper. Its accessible word is replaced by the row's status icon, wash, bar and strike.                                                 |
| The ground sits at `z-index: -2`                                 | **`z-index: 0`, DOM order**                       | The old value fails silently the moment `body` has a background, taking the entire paper with it.                                                                                         |
| A status icon on every row                                       | **The default state is unmarked**                 | Most rows are owned; a tick on each was the most repeated mark in the table and carried no information.                                                                                   |
| Radios for a three-way choice                                    | **One segmented control**                         | Exactly one is always true, which a segmented control says and a radio stack only implies. It costs no new component — the box was already in §6.                                         |
| A cover sheet, then the content                                  | **A single-purpose page is one sheet**            | A cover carrying only an `h1` is a second sheet doing no work.                                                                                                                            |
| §6 covers a search field and two buttons                         | **Fields, checkboxes, segments, selects, errors** | The language was written from two read-only screens. Everything a form needs had to be designed.                                                                                          |
| A desk frame for landing pages                                   | **Removed**                                       | Full-bleed everywhere. It was the only dark thing in a light-only language.                                                                                                               |

---

## Appendix — what implementing it changed

This document was written from a prototype. PK-64 then built it across every surface of the
real site, and the things below are what that found. They are recorded here, in the
authority, rather than left on the ticket — a guideline that quietly disagrees with the code
stops being one.

### Corrections to this document

**The photo chip failed AA, and the rule it broke is now stated in §5.** The prototype set the
third ink on `--paper-deep` for the closet's photo chip: **4.11:1**. The third ink clears AA on
the paper (4.51:1) and on a sheet (4.64:1) and **nowhere else** — on a sunk area it fails. Use
the second ink there (5.29:1). `src/styles/tokens.css` carries the warning at the token.

**Nothing on the paper means the pager too.** The prototype put the closet's "Showing 1–12 of
47" and its Previous/Next controls directly on the paper. §13 refuses that. They sit inside the
list sheet, below a hairline.

**A segment never wraps.** §6 describes the segmented control but not its failure mode: it is a
fixed 30px box, so a label that folds to two lines overflows the control rather than growing
it. The same reasoning §3 already gives for a table cell applies — the box gets wider, the text
does not fold.

**A wash on a note must be mixed over the note, not over transparent.** §7 defines the 5.5%
state wash for a table row, where mixing with `transparent` is right because a row has no
surface of its own and composites over the sheet's white. A **note** is itself a white surface,
so the same mix replaces its background rather than tinting it: the note goes 94.5%
transparent and its own corner-curl pseudo-elements show through it as two grey slabs. This
shipped in the prototype and survived type-checking, linting and 1,847 passing tests. It was
found by looking at the page.

**The two voices need to beat the controls.** §4's role split is expressed in CSS as `.written`
and `.system`. As single classes they tie on specificity with `.field`, which also sets a
family, and lose on source order — so the `field system` pairing §4 prescribes for a
bulk-action select silently does nothing. They are written as doubled classes for that reason.
This is the **third** cascade bug of the same shape this design has produced; the other two are
a value class matching `<th>` as well as `<td>`, and a `font:` shorthand resetting the family.
All three look applied and are not.

### Where the site deviates, and why

**No category dot in the closet.** §7 puts a 10px colour dot beside a category, and the
prototype drew one. The real column is unconstrained, user-typed free text, so there is no
mapping onto the ten category fills. Deriving one — from a keyword list, or a hash of the
category string — was built and removed: it gives two unrelated categories the same colour, it
changes a category's colour when someone renames it, and it encodes nothing a reader can
decode. §5 is explicit that colour is semantic or absent and never decorative, and an arbitrary
colour is decorative by definition. A real mapping is a product decision, not a styling one.

**The landing page's specimen sets names in ink, not blue.** The prototype reused the closet's
markup, where a name is a link to that item. Nothing on the specimen is clickable, so a blue
name there would be the site's only decorative use of blue — which §5 forbids.

**The closet cover carries one figure, not three.** The prototype shows Items, Base weight and
Total worn + carried. Only the first has a data source: carriage is a property of a pack's
items, not of a gear item, so "base weight" is not a thing a raw closet has. The other two
would have to be invented.

**No page-subtotal row on the closet.** The prototype shows one totalling Qty, Weight and
Price. Price cannot be summed — the codebase treats cross-currency summing as impossible — and
a subtotal row that silently omits the money column is worse than none.

### One value that cannot follow its token

The checkbox's tick is a data-URI SVG, and a data URI cannot reference a custom property, so
its paper colour is written out as a literal. It is the only value in `paper.css` that will not
follow `--paper` if that token changes. The alternatives — a pseudo-element on a replaced
element, or an inline SVG per checkbox — are both worse.
