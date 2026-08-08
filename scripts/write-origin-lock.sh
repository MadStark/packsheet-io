#!/usr/bin/env bash
#
# Writes the production-only origin lock, and a release marker, into a build output
# directory.
#
# Azure gives every Static Web App a permanent, public *.azurestaticapps.net hostname.
# It cannot be disabled, it serves the production build, and it bypasses Cloudflare
# entirely. staticwebapp.config.json route rules match on `route` and `methods` only,
# never on hostname, so a noindex header aimed at it would also land on packsheet.io.
# Instead the origin refuses anything without X-Origin-Verify, which a Cloudflare
# request-header transform sets on requests it forwards to the origin.
#
# The release marker is a separate job done here rather than as an inline workflow step,
# so that it is covered by the same tests: without it the verifier cannot tell THIS
# release from the one before it, and an edge still serving the previous (locked)
# deployment makes a broken release look verified.
#
# This lives in a script rather than inline in the workflow so the tests can run it.
# Asserting on the YAML instead lets the mutations that cause an outage — a wrong output
# directory, a misspelt header name — pass a green suite.
#
# Usage:  ORIGIN_VERIFY=<value> [DEPLOY_SHA=<sha>] scripts/write-origin-lock.sh <output-dir>
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

# Refuse rather than overwrite. Astro copies public/ verbatim into the build output, so
# the moment anyone adds a staticwebapp.config.json for route rules, security headers or
# a navigationFallback, it lands here — and this script runs after Build, so a blind
# `>` would win every time and silently drop their CSP in production. Merging the two
# would be the friendlier fix, but it guesses at intent; failing names the collision and
# costs a red build rather than a security regression nobody sees.
if [ -e "$config_path" ]; then
  echo "::error::$config_path already exists. This script writes the origin lock and will not overwrite a config it did not create — merging the two is a deliberate decision, not something to do silently. Merge the forwardingGateway block into that file instead, and extend this script to expect it." >&2
  exit 1
fi

# Written to a temporary file and moved into place, so a failure part-way through cannot
# leave a truncated or empty config where the deploy step will happily upload it.
tmp_config="$(mktemp "$out_dir/.origin-lock.XXXXXX")"
readonly tmp_config
trap 'rm -f "$tmp_config"' EXIT

jq -n --arg name "$HEADER_NAME" --arg value "$ORIGIN_VERIFY" \
  '{forwardingGateway: {requiredHeaders: {($name): $value}}}' \
  > "$tmp_config"

# Assert the leaf that actually matters. `has("forwardingGateway")` would be a
# tautology — it reads back a key the literal above always contains — and would pass
# for an empty or absent header value, which is the case that causes the outage.
jq -e --arg name "$HEADER_NAME" \
  '(.forwardingGateway.requiredHeaders[$name] | type) == "string"
   and (.forwardingGateway.requiredHeaders[$name] | length) > 0' \
  "$tmp_config" > /dev/null

mv "$tmp_config" "$config_path"

# The release marker. Without it the verifier cannot distinguish this release from the
# previous one: an edge still serving the older, locked deployment answers exactly like a
# correctly locked new one, and the check passes on the strength of the deployment it was
# meant to replace. Optional so the script stays runnable outside CI.
if [ -n "${DEPLOY_SHA-}" ]; then
  printf '%s\n' "$DEPLOY_SHA" > "$out_dir/_deploy.txt"
fi

# Deliberately nothing derived from the value on stdout OR stderr: this file is a fixed
# prefix plus the secret, so printing its size publishes the secret's length to logs
# that are public on this repository, and GitHub's masking cannot redact a derived
# number. The tests compare both streams across two very different secrets.
echo "Wrote the origin lock"
