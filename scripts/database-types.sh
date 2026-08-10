#!/usr/bin/env bash
#
# Compare src/lib/database.types.ts against the schema in the local database, or
# regenerate it from that schema.
#
#   scripts/database-types.sh          # compare  (the default; what `npm test` runs)
#   scripts/database-types.sh write    # regenerate  (npm run db:types)
#
# WHY THE GENERATED FILE IS COMMITTED AT ALL
#
# supabase-js is generic over a `Database` type and falls back to `any`-shaped rows
# without one. That is not a missing convenience, it is a missing failure: a column
# renamed in a migration goes on type-checking perfectly at every call site that still
# says the old name, and returns `undefined` at request time — on the share page, to a
# stranger, with nothing in the build to have caught it. The generated types are what
# turn that into a compile error, and they can only do that if they are in the tree the
# compiler reads.
#
# WHY THIS COMPARES RATHER THAN REWRITES, AND WHY COMPARING IS THE DEFAULT
#
# A CI step that regenerated the file and carried on would keep the file correct and
# tell nobody the schema had moved. Worse, it would quietly rewrite the types to agree
# with the new schema while the call sites still named the old columns — the exact
# breakage this exists to surface, repaired out of view. So the check is the same shape
# as `prettier --check`: it says the file is wrong and names the command that fixes it,
# and it never touches the file itself.
#
# `write` therefore has to be asked for by name. It used to be the default, with the
# comparing mode selected by an argument in tests/database-types.test.ts — which meant
# one dropped or misspelled argument turned the guardrail into the silent repair job
# this paragraph condemns, and turned it green while doing so. A mode that can damage
# the artefact is not a mode to arrive at by omission.
#
# WHAT IT COMPARES AGAINST — AND WHAT THAT IS NOT
#
# `gen types typescript --local` reads the schema that is in the running local stack.
# It does not replay anything. An earlier version of this comment claimed it compared
# against "the migrations replayed from empty", which is true only immediately after a
# `npm run db:reset` and in CI, where `.github/actions/local-database` starts a stack on
# a fresh runner and `supabase start` applies every migration on the way up.
#
# Locally that gap is the difference between a guardrail and a green tick: add a
# migration, forget to reset, and the stack, the committed types and every schema test
# agree with each other about a schema that was never applied. So the replay is not
# assumed here, it is checked — see `assert_migrations_applied` below, which refuses to
# generate or compare against a stack that is not level with supabase/migrations/.
#
# `--local` rather than a hosted project is still the right target. Generated against
# hosted, this would report drift whenever somebody had hand-edited that database: a
# real problem, but a different one wearing the same error message, arriving on the
# pull request of whoever pushed next.

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
target='src/lib/database.types.ts'

mode="${1:-check}"
if [ "$#" -gt 1 ] || { [ "$mode" != 'write' ] && [ "$mode" != 'check' ]; }; then
  echo "usage: $(basename "$0") [check|write]" >&2
  exit 2
fi

# scripts/supabase.sh when it exists, the CLI directly otherwise — the same resolution
# tests/support/local-database.ts makes, for the same reason. Ref 54 moves this
# project's ports into the environment so that each worktree gets its own stack, and at
# that point supabase/config.toml no longer parses without the wrapper: the fallback
# below dies with `failed to read config: ProjectConfigParseError`, which says nothing
# about the cause. On this branch the wrapper does not exist yet and the fallback parses
# the config fine. Resolving it here means nobody has to remember to come back.
#
# `-f` rather than `-x`: if the executable bit were ever lost, `-x` would skip a wrapper
# that is right there and fall through to a CLI invocation that cannot read the config,
# so the failure would read as a broken stack rather than a broken checkout. `-f` runs
# it and fails with permission denied, naming the file.
if [ -f "$root/scripts/supabase.sh" ]; then
  supabase_cli=("$root/scripts/supabase.sh")
else
  supabase_cli=(supabase --workdir "$root")
fi

# tests/support/local-database.ts lets SUPABASE_API_URL / _ANON_KEY / _DB_URL /
# _JWT_SECRET override the CLI outright, for pointing the suite at a stack the CLI does
# not know about. The Supabase CLI has no equivalent for `gen types --local`, which
# always resolves the stack described by supabase/config.toml.
#
# Left alone, that means one `npm test` run can certify the committed types against one
# database while the row-level-security tests read another, and report green twice about
# two different schemas. This project runs a stack per worktree, so "another database" is
# the same schema at a different version — the failure mode local-database.ts already
# warns about, arriving from the other side. Refused rather than silently ignored.
if [ -n "${SUPABASE_DB_URL:-}" ]; then
  cat >&2 <<EOF
error: SUPABASE_DB_URL is set, and this check cannot honour it.

\`gen types --local\` always reads the stack described by supabase/config.toml, so
continuing would compare $target against a different database from the one the rest of
the suite is reading. Unset it, or point supabase/config.toml at the stack you mean.
EOF
  exit 1
fi

# ---------------------------------------------------------------------------
# The stack has to be level with supabase/migrations/ before anything it says
# about the schema means anything.
# ---------------------------------------------------------------------------
assert_migrations_applied() {
  local list
  if ! list="$("${supabase_cli[@]}" migration list --local 2>&1)"; then
    cat >&2 <<EOF
error: could not list migrations against the local database.

$(printf '%s' "$list" | sed 's/^/  /')

Start the stack with \`npm run db:start\`.
EOF
    exit 1
  fi

  # The CLI answers with JSON: one object per migration, carrying the version on disk
  # as `local` and the version the stack has recorded as `remote`. A migration that has
  # not been applied has an empty `remote`; a migration the stack applied whose file is
  # not on this branch has an empty `local`, which is what switching branches without
  # resetting looks like.
  #
  # Asserted to have parsed at all before either is read. A check that silently stops
  # firing because an output format moved is the failure this whole file is written
  # against, and grepping for the absence of something is exactly how that happens.
  if ! printf '%s' "$list" | grep -q '"migrations"'; then
    cat >&2 <<EOF
error: could not read the migration list — \`migration list --local\` returned something
this script does not recognise, so whether the stack is up to date is unknown:

$(printf '%s' "$list" | sed 's/^/  /')
EOF
    exit 1
  fi

  # `grep -o | wc -l` rather than `grep -c`: the CLI emits every migration on ONE line,
  # so counting matching LINES reports 1 no matter how many are pending, and the numbers
  # below would be quietly wrong in the direction of looking smaller.
  local pending orphaned
  pending=$(printf '%s' "$list" | grep -oE '"remote":[[:space:]]*""' | wc -l | tr -d ' ' || true)
  orphaned=$(printf '%s' "$list" | grep -oE '"local":[[:space:]]*""' | wc -l | tr -d ' ' || true)

  if [ "$pending" -gt 0 ] || [ "$orphaned" -gt 0 ]; then
    cat >&2 <<EOF
error: the local database is not level with supabase/migrations/.

  migrations on disk that the stack has not applied: $pending
  migrations the stack has applied that are not on this branch: $orphaned

Nothing generated from this stack describes the schema on this branch, so the comparison
would certify the wrong thing. Replay the migrations from empty:

    npm run db:reset
EOF
    exit 1
  fi
}

# ---------------------------------------------------------------------------
# Generation
# ---------------------------------------------------------------------------
generated="$(mktemp)"
trap 'rm -f "$generated" "$generated.err"' EXIT INT TERM

assert_migrations_applied

# Generated into a temp file rather than redirected at the target, because `>` truncates
# before the command runs: a generation that failed would otherwise leave an empty
# committed file behind, and a later `write` would be the only thing that could restore
# it. Check mode exits before comparing, so it never reads a half-written target.
if ! "${supabase_cli[@]}" gen types typescript --local >"$generated" 2>"$generated.err"; then
  cat >&2 <<EOF
error: could not generate types from the local database.

$(cat "$generated.err" "$generated" 2>/dev/null | sed 's/^/  /')
EOF
  rm -f "$generated.err"
  exit 1
fi
rm -f "$generated.err"

# Exit status is not evidence that anything was described. `gen types` exits 0 and emits
# a structurally valid file saying `export type Database = {}` when the schema it read
# has no tables in it — an empty stack, or one whose `db reset` failed partway. Compared
# against a committed file generated the same way, that agrees with itself and reports
# green, having certified nothing. Observed against the real CLI, not imagined.
#
# `Row: {` appears once per table and nowhere else, so its absence means "no tables"
# without this script having to know which tables to expect — a list that would go stale
# the first time somebody added one.
if ! grep -q 'Row: {' "$generated"; then
  cat >&2 <<EOF
error: the generator described no tables at all.

It exited successfully, so the database answered — it simply has no tables in it. That is
a stack whose migrations did not apply, not a schema. Replay them from empty:

    npm run db:reset
EOF
  exit 1
fi

if [ "$mode" = 'write' ]; then
  # Moved rather than copied, so the target is replaced in one step: `cat >` would
  # truncate it first and leave it destroyed if the write then failed. mktemp puts the
  # temp file in $TMPDIR, which may be a different filesystem, so fall back to a copy
  # when rename cannot cross it.
  if ! mv "$generated" "$root/$target" 2>/dev/null; then
    cp "$generated" "$root/$target"
  fi
  trap - EXIT INT TERM
  rm -f "$generated"
  echo "Wrote $target"
  exit 0
fi

if [ ! -f "$root/$target" ]; then
  cat >&2 <<EOF
error: $target does not exist.

Generate it and commit it:

    npm run db:types
EOF
  exit 1
fi

# `diff` exits 0 for identical, 1 for different, and 2 for trouble — an unreadable
# operand, an I/O error. Folding 2 in with 1 would announce a schema change and print the
# remedy for one, when what happened is that the comparison could not be made.
# Captured into a variable rather than read from `$?` after an `if`: a bare `if diff`
# with no `else` leaves `$?` as the status of the compound statement, which is 0 when no
# branch ran — so the "trouble" case below would have read as success.
diff_status=0
diff -u \
  --label "$target (committed)" \
  --label "$target (generated from the local database)" \
  "$root/$target" "$generated" >&2 || diff_status=$?

if [ "$diff_status" -eq 0 ]; then
  # Said out loud, and asserted by tests/database-types.test.ts, because "the comparison
  # passed" and "the script exited 0 without comparing anything" are otherwise the same
  # observation. Every false green this script has had was reached through that gap.
  echo "Compared $target against the local database: $(grep -c 'Row: {' "$generated") tables, $(wc -l <"$generated" | tr -d ' ') lines, identical."
  exit 0
fi

if [ "$diff_status" -ne 1 ]; then
  echo "error: could not compare $target — diff exited $diff_status." >&2
  exit "$diff_status"
fi

cat >&2 <<EOF

error: $target does not match the schema in the local database.

The diff above IS the schema change. Whatever it renames or removes, the call sites
still using the old name are the reason this is a failed build rather than a note.

Regenerate the file and commit it:

    npm run db:types

If the diff shows no schema change — reordered keys, quoting, a wrapper type appearing or
disappearing — then it is the generator that moved, not the database. CI pins the Supabase
CLI version in .github/workflows/ci.yml; check yours against it before committing the
result.
EOF
exit 1
