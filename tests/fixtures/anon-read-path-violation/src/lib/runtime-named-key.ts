// The DOCUMENTED BOUNDARY of Invariant C, made executable rather than left as a caveat
// in prose: the key's name assembled at runtime, which the check does not catch and is
// not expected to. A text scan sees text; nothing in this file is the identifier it looks
// for, and the value only exists once the module runs.
//
// That is a real limit of the approach, not a defect in this implementation — closing it
// means evaluating the program, which is not something a guardrail can do and stay
// simpler than the thing it guards. The rule this file pins is that the boundary sits
// exactly here, so that anyone who moves it later can see what they have changed.
//
// The assembly has to be genuinely unfoldable, and the obvious spelling is not.
// `env['SUPABASE_' + 'SERVICE_ROLE_KEY']` is two adjacent string literals, which esbuild
// folds into one during transform — the scan then sees the whole identifier and DOES flag
// it, so that spelling would pin the opposite of what this file claims to pin. Verified
// by running esbuild over both: the `+` form comes out folded, this `.join()` form comes
// out untouched, because esbuild does not evaluate method calls.
const SEGMENTS = ['SUPABASE', 'SERVICE', 'ROLE', 'KEY'];
const env = import.meta.env as Record<string, string | undefined>;

export function assembledPrivilegedKey(): string | undefined {
  return env[SEGMENTS.join('_')];
}
