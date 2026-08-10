#!/usr/bin/env bash
#
# Generate src/lib/database.types.ts from the local database, or check that the file
# committed here still matches it.
#
#   scripts/database-types.sh          # regenerate  (npm run db:types)
#   scripts/database-types.sh check    # fail if what is committed is out of date
#
# WHY THE GENERATED FILE IS COMMITTED AT ALL
#
# supabase-js is generic over a `Database` type and falls back to `any`-shaped rows
# without one. That is not a missing convenience, it is a missing failure: a column
# renamed in a migration goes on type-checking perfectly at every call site that still
# says the old name, and returns `undefined` at request time — on the share page, to a
# stranger, with nothing in the build to have caught it. The generated types are what
# turn that into a compile error, and they can only do that if they are in the tree
# the compiler reads.
#
# WHY THIS COMPARES RATHER THAN REWRITES
#
# A CI step that regenerated the file and carried on would keep the file correct and
# tell nobody the schema had moved. Worse, it would quietly rewrite the types to agree
# with the new schema while the call sites still named the old columns — the exact
# breakage this exists to surface, repaired out of view. So the check is the same shape
# as `prettier --check`: it says the file is wrong and names the command that fixes it,
# and it never touches the file itself.
#
# WHY --local RATHER THAN A HOSTED PROJECT
#
# Generated against a hosted project this would report drift whenever somebody had
# hand-edited that database. That is a real problem, but a different one wearing the
# same error message, and it would arrive on the pull request of whoever happened to
# push next. `--local` reads the stack that `supabase start` builds by replaying
# supabase/migrations/ from empty, so the only thing it can disagree with the committed
# file about is the migrations on this branch.

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
target='src/lib/database.types.ts'

mode="${1:-write}"
if [ "$#" -gt 1 ] || { [ "$mode" != 'write' ] && [ "$mode" != 'check' ]; }; then
  echo "usage: $(basename "$0") [write|check]" >&2
  exit 2
fi

# scripts/supabase.sh when it exists, the CLI directly otherwise — the same resolution
# tests/support/local-database.ts makes, for the same reason. Ref 54 moves this
# project's ports into the environment so that each worktree gets its own stack, and at
# that point supabase/config.toml no longer parses without the wrapper: a direct
# `supabase` call dies with `failed to read config: ProjectConfigParseError`, which says
# nothing about the cause. On this branch the wrapper does not exist yet. Resolving it
# here means nobody has to remember to come back to this file.
#
# `-f` rather than `-x`: if the executable bit were ever lost, `-x` would silently fall
# through to a bare `supabase` that cannot parse the config, and the failure would look
# like a broken stack rather than a broken checkout.
if [ -f "$root/scripts/supabase.sh" ]; then
  supabase_cli=("$root/scripts/supabase.sh")
else
  supabase_cli=(supabase --workdir "$root")
fi

generated="$(mktemp)"
trap 'rm -f "$generated"' EXIT

# Generated into a temp file and copied into place, never redirected straight at the
# target. `>` truncates before the command runs, so a generation that failed — stack
# down, CLI missing — would leave an empty committed file behind, and the check would
# then agree with it as soon as it was regenerated the same way.
if ! "${supabase_cli[@]}" gen types typescript --local >"$generated"; then
  cat >&2 <<EOF
error: could not generate types from the local database.

Start it with \`supabase start\`, then \`supabase db reset\` to replay the migrations.
EOF
  exit 1
fi

if [ "$mode" = 'write' ]; then
  cat "$generated" >"$root/$target"
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

if diff -u \
  --label "$target (committed)" \
  --label "$target (generated from the local database)" \
  "$root/$target" "$generated" >&2; then
  exit 0
fi

cat >&2 <<EOF

error: $target does not match the schema the migrations produce.

The diff above IS the schema change. Whatever it renames or removes, the call sites
still using the old name are the reason this is a failed build rather than a note.

Regenerate the file and commit it:

    npm run db:types

If you have changed a migration without replaying it, the difference is a stale local
stack rather than a stale file — reset first:

    supabase db reset && npm run db:types
EOF
exit 1
