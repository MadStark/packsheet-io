# Vendored typefaces

These three `.woff2` files are committed deliberately rather than pulled from a package
or a CDN.

| File | Family | Role | Axis / weight |
| --- | --- | --- | --- |
| `klee-one-latin-400.woff2` | Klee One | written | 400 |
| `klee-one-latin-600.woff2` | Klee One | written | 600 |
| `inter-latin-var.woff2` | Inter | system | variable, 100–900 (used 400–600) |

## Why vendored

Linking Google's font CDN would leak the IP address of every share-page visitor to a
third party. The share page is served overwhelmingly to strangers who never log in, so
that is not a trade worth making.

## Why latin only

These are the latin cuts Google Fonts serves, taken once from `fonts.gstatic.com` and
committed here. Both families also ship Cyrillic, Greek and Vietnamese cuts — and Klee
One a full Japanese one — and bundling those would have put many times the font weight
into `dist/` for glyphs this audience does not render, against a hosting plan with a hard
bandwidth ceiling. The `@font-face` rules in `src/styles/fonts.css` carry a matching
`unicode-range`, so text outside the latin range falls back to a system face.

Nothing on the font path is a dependency: the binaries were fetched once, and the licence
texts came from the upstream projects. Neither Google Fonts nor Fontsource is contacted at
build time or at run time.

## Licensing

Both families are licensed under the **SIL Open Font License 1.1**. Full texts are in
`licenses/`, copied verbatim from the upstream packages.

- Klee One — © 2020 The Klee Project Authors
- Inter — © 2020 The Inter Project Authors

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
all. Carrying ~8.6 KB of licence text is the cheaper trade.

### Maintenance

If a font file is ever added, replaced or re-subset here, update its licence and `NOTICE`
in step. Neither of the two currently declares a Reserved Font Name, which is why the
subset versions may keep their original family names — re-check this if a family is
swapped.
