// The DOCUMENTED BOUNDARY of Invariant C, made executable rather than left as a caveat
// in prose: the key's name assembled at runtime, which the check does not catch and is
// not expected to. A text scan sees text; nothing in this file is any of the identifiers
// it looks for, and the values only exist once the module runs.
//
// That is a real limit of the approach, not a defect in this implementation — closing it
// means evaluating the program, which is not something a guardrail can do and stay
// simpler than the thing it guards. The rule this file pins is that the boundary sits
// exactly here, so that anyone who moves it later can see what they have changed.
//
// This file names nothing directly, deliberately: a comment spelling the identifier out
// would be reported exactly as an assignment is, which is the rule the whole fixture
// exists to demonstrate. Describe the key, do not name it — including here.
//
// Two spellings, because they fail to match for two different reasons and one of them is
// easy to get wrong:
//
//   assembledFromSegments  joins an array. No literal in the file is the name, and no
//                          bundler will ever fold a method call.
//
//   assembledByConcat      concatenates two string literals. THIS BUILD DOES NOT FOLD
//                          THAT. A previous version of this comment claimed esbuild
//                          constant-folds adjacent literals during transform and that the
//                          `+` form is therefore caught; that claim was false here. This
//                          project builds with rolldown (rolldown/runtime.js is in the
//                          module graph), and inserting the `+` form of the prefixed
//                          service-role name into src/pages/index.astro of the real site
//                          left the suite green under the old single-pattern rule, while
//                          the contiguous spelling turned it red. Measured, not reasoned
//                          about.
//
//                          So whether a `+` form is caught depends entirely on WHERE the
//                          author split it, and nothing else. Split it so that one
//                          fragment is itself a banned spelling and the scan matches that
//                          fragment; split it anywhere else — as here — and there is
//                          nothing to match. The unprefixed-name page in this fixture is
//                          the other side of that coin.
const SEGMENTS = ['SUPABASE', 'SERVICE', 'ROLE', 'KEY'];
const env = import.meta.env as Record<string, string | undefined>;

export function assembledFromSegments(): string | undefined {
  return env[SEGMENTS.join('_')];
}

export function assembledByConcat(): string | undefined {
  return env['SUPABASE_SERVICE' + '_ROLE_KEY'];
}
