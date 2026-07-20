# Vendored typefaces

These four `.woff2` files are committed deliberately rather than pulled from a package
or a CDN.

| File | Family | Role | Axis / weight |
| --- | --- | --- | --- |
| `bricolage-grotesque-latin-var.woff2` | Bricolage Grotesque | display | variable, 200–800 |
| `hanken-grotesk-latin-var.woff2` | Hanken Grotesk | body | variable, 100–900 |
| `ibm-plex-mono-latin-400.woff2` | IBM Plex Mono | data | 400 |
| `ibm-plex-mono-latin-500.woff2` | IBM Plex Mono | data | 500 |

## Why vendored

Linking Google's font CDN would leak the IP address of every share-page visitor to a
third party. The share page is served overwhelmingly to strangers who never log in, so
that is not a trade worth making.

## Why latin only

These were extracted from the Fontsource packages, which also ship Cyrillic, Vietnamese
and latin-ext cuts. Bundling those would have put roughly four times the font weight into
`dist/` for glyphs this audience does not render, against a hosting plan with a hard
bandwidth ceiling. The `@font-face` rules in `src/styles/fonts.css` carry a matching
`unicode-range`, so text outside the latin range falls back to a system face.

The Fontsource packages themselves are **not** dependencies — they were installed once to
obtain these binaries and their licences, then removed.

## Licensing

All three families are licensed under the **SIL Open Font License 1.1**. Full texts are
in `licenses/`, copied verbatim from the upstream packages.

- Bricolage Grotesque — © 2022 The Bricolage Grotesque Project Authors
- Hanken Grotesk — © 2021 The Hanken Grotesk Project Authors
- IBM Plex Mono — © 2017 IBM Corp.

**These files are not under the AGPL.** OFL 1.1 condition 5 requires the Font Software to
be "distributed entirely under this license, and must not be distributed under any other
license", so the repository's AGPL does not — and cannot — extend to them. See `NOTICE`.

### Why shipping the files here is fine

OFL 1.1 grants permission to "use, study, copy, merge, embed, modify, redistribute, and
sell modified and unmodified copies". Self-hosting a webfont is the intended use, not an
edge case. Condition 2 attaches one obligation — each copy must carry the copyright notice
and licence — which `licenses/` satisfies. Condition 1 forbids selling the fonts by
themselves, which is not something this project does.

### Why we do not avoid this by "just referencing" them

Serving a `.woff2` to a browser **is** distribution, wherever the file happens to live in
the source tree. Depending on the Fontsource npm packages instead would still put the same
binaries into `dist/` and still ship them to every visitor — identical distribution, but
with the licence texts no longer in the repository. That is strictly worse compliance for
no benefit.

The only ways to genuinely not distribute these fonts are to let a third party serve them
(a CDN, rejected because it leaks every share-page visitor's IP) or to not use webfonts at
all. Carrying ~14 KB of licence text is the cheaper trade.

### Maintenance

If a font file is ever added, replaced or re-subset here, update its licence and `NOTICE`
in step. None of the three currently declares a Reserved Font Name, which is why the
subset versions may keep their original family names — re-check this if a family is
swapped.
