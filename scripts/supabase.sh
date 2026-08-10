#!/usr/bin/env bash
#
# The entry point for every Supabase CLI command in this project — local and CI.
#
# supabase/config.toml reads its project name and all seven of its ports from the
# environment rather than hard-coding them, so that each git worktree gets its own
# Docker stack and its own database. Without that, every worktree shares one set of
# container names and one set of ports: two checkouts cannot run at the same time,
# and switching branches silently inherits the other branch's data.
#
# The CLI has no way to express a default for `env(...)`. If a variable is unset the
# whole file fails to parse and the command dies with
#
#     failed to read config: ProjectConfigParseError
#
# which says nothing about the cause. That is the price of per-worktree isolation, and
# it is why this script exists and why nothing should call `supabase` directly —
# including the deploy workflows, which never start a local stack but do parse this
# same config to run `link` and `db push`. tests/deploy-workers.test.ts asserts they go
# through here.
#
#   scripts/supabase.sh start          # this worktree's stack
#   scripts/supabase.sh db reset       # replay migrations from empty
#   scripts/supabase.sh status
#
# or, more usually, `npm run db:start` / `npm run db:reset` / `npm run db:status`.
#
# Every variable is only defaulted, never overridden, so you can pin any of them by
# exporting it first — useful if you want two worktrees on ports you have chosen
# yourself, or to point at a colleague's stack.

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# One checksum of the ABSOLUTE path, used for both the stack name and the ports.
#
# It has to be the absolute path, and the stack name has to use it too. An earlier
# version keyed the ports on the absolute path and the stack NAME on the basename alone,
# which quietly undid the isolation the name is responsible for: the name becomes the
# Docker container prefix (supabase_db_<name>) and the volume names, so two checkouts
# whose directories share a basename — `~/Dev/packsheet-io/worktrees/fix-1` and
# `~/review/packsheet-io/worktrees/fix-1` — got *the same containers and the same
# volumes* while believing they were isolated. Reproduced: with the port bases also
# colliding (1 in 25, since the base is a modulo of the same class of checksum), the
# second checkout resolved cleanly onto the first one's database and `db reset` would
# have replayed its migrations there.
root_sum="$(printf '%s' "$root" | cksum | awk '{print $1}')"

# Legible first, unique second: the directory name is what makes `docker ps` readable, and
# the checksum suffix is what makes it correct. A bare hash would isolate just as well and
# tell you nothing.
if [ -z "${PACKSHEET_STACK:-}" ]; then
  slug="$(basename "$root" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9' '-' | sed 's/-\{2,\}/-/g; s/^-//; s/-$//')"
  slug="${slug:-default}"
  # The primary checkout is itself called packsheet-io, and "packsheet-packsheet-io"
  # reads like a mistake in `docker ps`.
  case "$slug" in
    packsheet*) PACKSHEET_STACK="$slug" ;;
    *) PACKSHEET_STACK="packsheet-$slug" ;;
  esac
  PACKSHEET_STACK="$PACKSHEET_STACK-$(printf '%x' "$root_sum")"
fi
export PACKSHEET_STACK

# Ports move as one block, because the defaults occupy a contiguous 54320-54329 range
# and keeping the offsets between them makes a running stack readable: whatever the
# base, the API is always base+1 and Studio always base+3.
#
# From the same absolute-path checksum as the stack name, so the two cannot disagree
# about which checkout they belong to. Collisions are possible — it is a modulo, not a
# registry — but now they are only PORT collisions, which surface immediately and loudly
# as "port is already allocated" when the second stack starts, rather than two checkouts
# silently sharing one database. Export PACKSHEET_PORT_BASE to step around one.
if [ -z "${PACKSHEET_PORT_BASE:-}" ]; then
  PACKSHEET_PORT_BASE=$(( 54320 + (root_sum % 25) * 20 ))
fi
export PACKSHEET_PORT_BASE

: "${PACKSHEET_PORT_SHADOW:=$(( PACKSHEET_PORT_BASE + 0 ))}"
: "${PACKSHEET_PORT_API:=$(( PACKSHEET_PORT_BASE + 1 ))}"
: "${PACKSHEET_PORT_DB:=$(( PACKSHEET_PORT_BASE + 2 ))}"
: "${PACKSHEET_PORT_STUDIO:=$(( PACKSHEET_PORT_BASE + 3 ))}"
: "${PACKSHEET_PORT_SMTP:=$(( PACKSHEET_PORT_BASE + 4 ))}"
: "${PACKSHEET_PORT_ANALYTICS:=$(( PACKSHEET_PORT_BASE + 7 ))}"
: "${PACKSHEET_PORT_POOLER:=$(( PACKSHEET_PORT_BASE + 9 ))}"
export PACKSHEET_PORT_SHADOW PACKSHEET_PORT_API PACKSHEET_PORT_DB \
  PACKSHEET_PORT_STUDIO PACKSHEET_PORT_SMTP PACKSHEET_PORT_ANALYTICS \
  PACKSHEET_PORT_POOLER

if ! command -v supabase >/dev/null 2>&1; then
  echo "supabase CLI not found on PATH. Install it: https://supabase.com/docs/guides/cli" >&2
  exit 1
fi

# --workdir so the command reads THIS worktree's supabase/ directory regardless of
# where it was invoked from.
exec supabase --workdir "$root" "$@"
