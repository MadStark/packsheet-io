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

# The header name is duplicated in exactly one other place on earth: the Cloudflare
# transform rule. Changing it here without changing it there takes production down
# completely, so the tests pin this exact string.
readonly HEADER_NAME='X-Origin-Verify'

readonly out_dir="${1:?usage: write-origin-lock.sh <output-dir>}"

if [ ! -d "$out_dir" ]; then
  echo "::error::Output directory '$out_dir' does not exist. Run this after the build." >&2
  exit 1
fi

# `-z` alone only catches an unset or empty secret. A value that is whitespace, or has
# picked up a trailing newline, produces a config demanding a header Cloudflare never
# sends — the same total outage the guard exists to prevent, but passing the guard.
# Stripping first means those cases fail here, where it costs a red build.
readonly trimmed="$(printf '%s' "${ORIGIN_VERIFY-}" | tr -d '[:space:]')"
if [ -z "$trimmed" ]; then
  echo "::error::ORIGIN_VERIFY is empty or whitespace. Refusing to write a config that would reject every request." >&2
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
