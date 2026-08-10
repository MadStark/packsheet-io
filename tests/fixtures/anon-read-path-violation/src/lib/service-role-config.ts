// Invariant C, shape #3: the key as a DESTRUCTURED BINDING, in a shared library module
// rather than in a page. Two things are pinned by that.
//
// The identifier never appears after a dot — there is no member expression to spot — so a
// check that looked for property access rather than for the identifier itself would read
// this file and find nothing, while from here the value can be handed on under any name at
// all. And this is not a page: Invariant C iterates the whole build graph rather than a
// route list precisely so a module a page merely imports is in scope. Scope it to pages
// and every shared module in the codebase is free to hold the key.
const env = import.meta.env as Record<string, string | undefined>;
const { SUPABASE_SERVICE_ROLE_KEY } = env;

export function hasPrivilegedKey(): boolean {
  return Boolean(SUPABASE_SERVICE_ROLE_KEY);
}

// The other documented boundary, and it is deliberate rather than an accident of this
// file: the line below is a COMMENT, and it is reported exactly as the two lines of code
// above are. The check reads text; it cannot tell code from a comment, and teaching it to
// would mean giving the guardrail its own parser to be wrong in.
//
// SUPABASE_SERVICE_ROLE_KEY
//
// So the fixture asserts three reported lines for this file, not two. The instruction that
// follows from it — describe the key rather than naming it — is in the failure message,
// where the person tripping over it will actually read it.
