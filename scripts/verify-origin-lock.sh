#!/usr/bin/env bash
#
# Verifies, against the running site, that the origin lock is actually in effect.
#
# This is the compensating control for a change that cannot be rehearsed: staging is on
# the Free plan and cannot host forwardingGateway, so nothing upstream of production
# exercises it. It is also the only thing anywhere that notices if the Cloudflare
# transform rule is later edited, disabled, narrowed, or a record is grey-clouded — in
# which case Azure refuses every request while CI, the deploy and the environment all
# still report green.
#
# It lives in a script, not inline in the workflow, for the same reason the writer does:
# a review demonstrated that all three `exit 1` here could be replaced with an `echo`
# and the suite stayed green, because the tests could only assert that the step
# *mentioned* the right URLs. The tests now run this against a stub server instead.
#
# Usage:  scripts/verify-origin-lock.sh <site-base-url> <origin-base-url>
#
# Exits non-zero, loudly, on any of:
#   - the site is not reachable through Cloudflare
#   - the origin still answers directly, i.e. the lock is NOT applied
#   - the config file (which carries the secret) is being served
set -euo pipefail

readonly site="${1:?usage: verify-origin-lock.sh <site-base-url> <origin-base-url>}"
readonly origin="${2:?usage: verify-origin-lock.sh <site-base-url> <origin-base-url>}"

readonly ATTEMPTS="${VERIFY_ATTEMPTS:-6}"
readonly DELAY="${VERIFY_DELAY:-5}"
readonly TIMEOUT="${VERIFY_TIMEOUT:-20}"

# curl's own --retry only covers a fixed transient list (408/429/500/502/504 and 503),
# which notably excludes Cloudflare's 520-524. Retrying here instead keeps one policy
# for every request and lets the tests drive it to zero delay.
http_status() {
  local url="$1" status='' i=0
  while [ "$i" -lt "$ATTEMPTS" ]; do
    # `-w '%{http_code}'` already prints 000 when the request never completes, so a
    # `|| echo 000` fallback would concatenate onto it and yield "000000". Suspend
    # errexit around the call instead and treat only genuinely empty output as 000.
    set +e
    status="$(curl -sS -o /dev/null -w '%{http_code}' --max-time "$TIMEOUT" "$url" 2>/dev/null)"
    set -e
    [ -n "$status" ] || status=000
    case "$status" in
      000 | 5*) ;; # connection failure or server-side: worth retrying
      *) break ;;  # any definite answer, including 4xx: report it
    esac
    i=$((i + 1))
    [ "$i" -lt "$ATTEMPTS" ] && sleep "$DELAY"
  done
  printf '%s' "$status"
}

fail() {
  echo "::error::$1" >&2
  exit 1
}

# 1. The site must be reachable through Cloudflare.
site_status="$(http_status "$site/")"
if [ "$site_status" != "200" ]; then
  fail "$site/ returned $site_status, expected 200. If this is 403, Cloudflare is not sending the origin-verify header — RESTORE THE CLOUDFLARE TRANSFORM RULE (seconds) rather than reverting the deploy (minutes, site down throughout). See the README."
fi

# 2. The origin must refuse a direct request.
#
# Requires a 4xx rather than merely "not 200". Seconds after an upload the origin can
# emit a transient 404 or 503 while the deployment settles, and accepting any non-200
# would report "the lock is in effect" when it may not be — a false pass on the only
# check that the lock works at all, whose failure mode is silent and permanent.
#
# Not pinned to exactly 403: the Azure docs never state which status a missing required
# header produces. The observed value is printed below so it can be pinned once seen.
origin_status="$(http_status "$origin/")"
case "$origin_status" in
  4*) ;;
  200) fail "$origin/ still returns 200 — the origin lock is NOT in effect. The config did not reach the artifact, or forwardingGateway was not applied. The Azure hostname is serving the site directly, bypassing Cloudflare." ;;
  *) fail "$origin/ returned $origin_status; expected a 4xx refusal. This does not prove the lock is working, and a false pass here is silent and permanent." ;;
esac

# 3. The config must not be served.
#
# This deploy is the first thing to put a secret inside the build output. Static Web Apps
# is expected to consume staticwebapp.config.json rather than serve it; if that is ever
# wrong, the secret is published at a stable public URL.
#
# Asserts on the BODY, not the status: with a navigationFallback the URL would return 200
# with index.html, and a status check would then cry "the secret is public" falsely.
config_body="$(curl -sS --max-time "$TIMEOUT" "$site/staticwebapp.config.json" || true)"
case "$config_body" in
  *forwardingGateway*) fail "staticwebapp.config.json is being SERVED at $site — the origin-verify secret is public. Rotate it immediately (see the README's rotation procedure)." ;;
esac

echo "site=$site_status origin=$origin_status config=not-served"
