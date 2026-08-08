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
# A 200 is retried before failing. The first request after an upload can land on an edge
# still serving the previous deployment, which has no forwardingGateway — failing
# immediately would send an operator down the slow, site-down revert path over what a few
# seconds of patience resolves. `http_status` does not retry a 200 (a definite answer is
# normally what it is looking for), so the wait is done here.
origin_status="$(http_status "$origin/")"
i=0
while [ "$origin_status" = "200" ] && [ "$i" -lt "$ATTEMPTS" ]; do
  sleep "$DELAY"
  origin_status="$(http_status "$origin/")"
  i=$((i + 1))
done

# 404 is REJECTED, not accepted as a refusal. Azure's front door answers 404 for any
# *.azurestaticapps.net name that is not a live app, so a typo in AZURE_HOSTNAME — or the
# Static Web App being recreated, the one thing that changes this hostname — produces a
# 404 that is indistinguishable from a lock working. Accepting it would report "verified"
# while the real origin serves the site unprotected, which is the exact silent, permanent
# failure this script exists to prevent.
#
# If it turns out Azure uses 404 for a missing required header, this fails on the first
# release with the site already up and serving. That is the safe direction: a red step
# telling us the real code, rather than a green one telling us nothing.
case "$origin_status" in
  404) fail "$origin/ returned 404. That is what Azure returns for a hostname that is not a live Static Web App, so it does NOT prove the lock is working. Check AZURE_HOSTNAME is the current default hostname of the production app. If the hostname is right, Azure is using 404 for the missing required header — pin that here rather than accepting 404 in general." ;;
  4*) ;;
  200) fail "$origin/ still returns 200 after $ATTEMPTS retries — the origin lock is NOT in effect. The config did not reach the artifact, or forwardingGateway was not applied. The Azure hostname is serving the site directly, bypassing Cloudflare." ;;
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
