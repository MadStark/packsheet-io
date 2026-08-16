// Invariant C, shape #7, and the one case where the FILE is not the evidence.
//
// Read this file on disk and it is clean — it names nothing, and grep over the repository
// will never find anything here. The reference arrives during the build: the fixture's
// astro.config.mjs registers a plugin that prepends one to this module's transformed text,
// which is how a real one gets in too (a `vite.define` substitution, an integration's
// generated wrapper, a codegen step). The module still ships with the reference in it.
//
// Two things are pinned by that, and neither is pinned by any other case here:
//
//   Detection is a UNION of the file's text and the transform hook's, not a preference for
//   one. Scan only the file and this module is clean forever.
//
//   The caveat in the failure message belongs to the REF, not to the module. This module
//   HAS a file, so a caveat gated on "no file on disk" would be omitted — and the message
//   would print a confident path:line into a file whose line says something else entirely,
//   or in this case says nothing at all. The reader trusts it and goes looking.
//
// The padding below is deliberate: it makes the file long enough that the injected line
// number could plausibly be a line in it, so the wrong-line failure is a realistic
// mistake rather than an obviously impossible one.
export const GENERATED_ONLY_MARKER = 'generated-only';

export function describeGeneratedOnly(): string {
  return GENERATED_ONLY_MARKER;
}
