#!/usr/bin/env bash
#
# Writes the production-only origin lock into a build output directory.
#
# Azure gives every Static Web App a permanent, public *.azurestaticapps.net hostname.
# It cannot be disabled, it serves the production build, and it bypasses Cloudflare
# entirely. staticwebapp.config.json route rules match on `route` and `methods` only,
# never on hostname, so a noindex header aimed at it would also land on packsheet.io.
# Instead the origin refuses anything without X-Origin-Verify, which a Cloudflare
# request-header transform sets on requests it forwards to the origin.
#
# This lives in a script rather than inline in the workflow so the tests can run it.
# Asserting on the YAML instead lets both of the mutations that cause an outage — a
# wrong output directory and a misspelt header name — pass a green suite.
#
# Usage:  ORIGIN_VERIFY=<value> scripts/write-origin-lock.sh <output-dir>
set -euo pipefail

# Duplicated in exactly two other places: the Cloudflare transform rule, and
# tests/deploy-origin-lock.test.ts. The test's copy is deliberate — importing this
# constant would pin nothing — so rotating the header name means editing all three.
# The README's rotation procedure lists them.
readonly HEADER_NAME='X-Origin-Verify'

readonly out_dir="${1:?usage: write-origin-lock.sh <output-dir>}"

if [ ! -d "$out_dir" ]; then
  echo "::error::Output directory '$out_dir' does not exist. Run this after the build." >&2
  exit 1
fi

# Reject any whitespace rather than stripping it. Two reasons:
#
#  1. `-z` alone only catches a value that is entirely empty or entirely whitespace. The
#     realistic failure is a secret pasted into the GitHub UI with a trailing newline —
#     content PLUS whitespace — which passes an emptiness test and then writes a header
#     value Cloudflare can never match. Total production outage, green build.
#  2. Writing a trimmed value would be worse than refusing: `tr -d '[:space:]'` removes
#     *internal* whitespace too, so a legitimate value would be silently rewritten into
#     something that no longer matches what Cloudflare sends.
#
# Refusing keeps the value Azure demands byte-identical to the one pasted into
# Cloudflare, which is the only property that matters here.
#
# Assigned in two statements: `readonly x="$(cmd)"` masks the command's exit status from
# `set -e`. Harmless for printf|tr, but not a pattern to leave lying around.
stripped="$(printf '%s' "${ORIGIN_VERIFY-}" | tr -d '[:space:]')"
readonly stripped

if [ -z "$stripped" ]; then
  echo "::error::ORIGIN_VERIFY is empty or entirely whitespace. Refusing to write a config that would reject every request." >&2
  exit 1
fi

if [ "${ORIGIN_VERIFY-}" != "$stripped" ]; then
  echo "::error::ORIGIN_VERIFY contains whitespace. Cloudflare cannot send a header value with whitespace, so this would reject every request. Re-set the secret with no leading, trailing or internal whitespace." >&2
  exit 1
fi

readonly config_path="$out_dir/staticwebapp.config.json"

jq -n --arg name "$HEADER_NAME" --arg value "$ORIGIN_VERIFY" \
  '{forwardingGateway: {requiredHeaders: {($name): $value}}}' \
  > "$config_path"

# Assert the leaf that actually matters. `has("forwardingGateway")` would be a
# tautology — it reads back a key the literal above always contains — and would pass
# for an empty or absent header value, which is the case that causes the outage.
jq -e --arg name "$HEADER_NAME" \
  '(.forwardingGateway.requiredHeaders[$name] | type) == "string"
   and (.forwardingGateway.requiredHeaders[$name] | length) > 0' \
  "$config_path" > /dev/null

# Deliberately no byte count and no length: this file is a fixed prefix plus the
# secret, so printing its size publishes the secret's length to logs that are public
# on this repository, and GitHub's masking cannot redact a derived number.
echo "Wrote $config_path"
