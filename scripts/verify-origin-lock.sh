#!/usr/bin/env bash
#
# Verifies, against the running site, that THIS release's origin lock is in effect.
#
# The compensating control for a change that cannot be rehearsed: staging is on the Free
# plan and cannot host forwardingGateway, so nothing upstream of production exercises it.
# It is also the only thing that notices if the Cloudflare transform rule is later
# edited, disabled, narrowed, or a record is grey-clouded — in which case Azure refuses
# every request while CI, the deploy and the environment all still report green.
#
# It lives in a script, not inline in the workflow, so the tests can drive it against a
# stub. Asserting on YAML let all of its failure branches be replaced with an echo while
# the suite stayed green.
#
# Usage:  scripts/verify-origin-lock.sh <site-base-url> <origin-base-url> [expected-sha]
#
# Every check runs, and their failures are collected rather than short-circuited — the
# most security-critical one (is the secret being served?) is independent of the others
# and used to be skipped exactly when the deploy was in a weird state.
set -euo pipefail

readonly site="${1:?usage: verify-origin-lock.sh <site-url> <origin-url> [expected-sha]}"
readonly origin="${2:?usage: verify-origin-lock.sh <site-url> <origin-url> [expected-sha]}"
readonly expected_sha="${3-}"

readonly ATTEMPTS="${VERIFY_ATTEMPTS:-6}"
readonly DELAY="${VERIFY_DELAY:-5}"
readonly TIMEOUT="${VERIFY_TIMEOUT:-20}"

failures=0
note() { echo "::error::$1" >&2; failures=$((failures + 1)); }

# Populated by http_get: the response status, the body, and curl's own stderr. That last
# one matters — `-sS` exists to keep the diagnosis, and discarding it collapses an
# expired certificate, a DNS failure and a refused connection into an indistinguishable
# `000`, after which the operator is told in capitals to fix a Cloudflare rule that is
# perfectly fine.
STATUS=''
BODY=''
CURL_ERR=''

# `retry_statuses` is a space-separated list of extra statuses worth waiting out, on top
# of 000 and 5xx which are always transient-ish.
http_get() {
  local url="$1" retry_statuses="${2-}" i=0 body_file err_file
  body_file="$(mktemp)"
  err_file="$(mktemp)"
  while :; do
    set +e
    STATUS="$(curl -sS -o "$body_file" -w '%{http_code}' \
      -H 'Cache-Control: no-cache' -H 'Pragma: no-cache' \
      -A 'packsheet-deploy-verifier' \
      --max-time "$TIMEOUT" "$url" 2>"$err_file")"
    set -e
    [ -n "$STATUS" ] || STATUS=000
    case " 000 5xx $retry_statuses " in
      *" $STATUS "*) ;;
      *)
        case "$STATUS" in
          5*) ;;
          *) break ;;
        esac
        ;;
    esac
    i=$((i + 1))
    [ "$i" -ge "$ATTEMPTS" ] && break
    sleep "$DELAY"
  done
  BODY="$(cat "$body_file")"
  CURL_ERR="$(cat "$err_file")"
  rm -f "$body_file" "$err_file"
}

# ---------------------------------------------------------------------------
# 1. The site must be reachable through Cloudflare.
#
# 403 and 429 are retried rather than failed on. Cloudflare's own managed challenge, bot
# fight mode and rate limiting all answer a datacenter IP running curl with a 4xx, and
# that produces the most dangerous false alarm this script can raise: it tells an
# operator, in capitals, to go and edit the one Cloudflare rule holding the site up,
# while production is perfectly healthy for every real browser.
# ---------------------------------------------------------------------------
http_get "$site/" "403 429"
site_status="$STATUS"
if [ "$site_status" != "200" ]; then
  note "$site/ returned $site_status, expected 200.${CURL_ERR:+ curl said: $CURL_ERR}
  - A 403 that persists means Cloudflare is not sending the origin-verify header. RESTORE THE CLOUDFLARE TRANSFORM RULE (seconds) rather than reverting the deploy (minutes, site down throughout). See the README.
  - A 403 with a Cloudflare challenge body may just be bot protection blocking this checker rather than a real outage — open the site in a browser before touching anything."
fi

# ---------------------------------------------------------------------------
# 2. The deployment being verified must be THIS one.
#
# Without this, edge lag makes a broken release look verified: if this release fails to
# apply the lock but an edge still serves the previous, locked deployment, every check
# below passes on the strength of the deployment this one was meant to replace. That is
# the fast path, too — a definite answer breaks out of the retry loop immediately.
# ---------------------------------------------------------------------------
# Both "not there yet" (404) and "there, but still the old one" (a stale SHA) are the
# same condition — the edge has not caught up — and both are expected in the seconds
# after an upload. Two production releases went red here in a row, once for each,
# because only the absent case was waited out and a stale-but-present marker was taken
# as a definite answer. Waiting for the marker to MATCH, rather than merely to exist, is
# the whole condition, so it gets one loop.
served_sha=''
if [ -n "$expected_sha" ]; then
  i=0
  while :; do
    http_get "$site/_deploy.txt" "404"
    served_sha="$(printf '%s' "$BODY" | tr -d '[:space:]')"
    [ "$STATUS" = "200" ] && [ "$served_sha" = "$expected_sha" ] && break
    i=$((i + 1))
    [ "$i" -ge "$ATTEMPTS" ] && break
    sleep "$DELAY"
  done

  if [ "$STATUS" != "200" ]; then
    note "$site/_deploy.txt returned $STATUS after $ATTEMPTS attempts — cannot confirm which release is live, so nothing below is evidence about THIS one.${CURL_ERR:+ curl said: $CURL_ERR}"
  elif [ "$served_sha" != "$expected_sha" ]; then
    note "$site/ is still serving release $served_sha, not $expected_sha, after $ATTEMPTS attempts. The checks below would describe the PREVIOUS deployment. If the deploy itself succeeded this is propagation taking longer than the wait allows — re-run the job rather than reverting."
  fi
fi

# ---------------------------------------------------------------------------
# 3. The origin must refuse a direct request.
#
# Pinned to 403. Observed on the first production release (2026-08-08): that is what
# Azure returns when forwardingGateway's required header is absent. Until then this
# accepted 401 as well, because the docs never state the code — a guess worth removing
# now there is evidence, since every status this accepts is one that could mask a
# different fault. 404 is what Azure's front door returns for any
# *.azurestaticapps.net name that is not a live app, so accepting it would report
# "verified" when AZURE_HOSTNAME is simply wrong — or when the Static Web App has been
# recreated, the one thing that changes this hostname. The same reasoning rules out 410,
# 429 and the rest: none of them is evidence that forwardingGateway is doing anything.
#
# A 200 is retried before failing, because the first request after an upload can land on
# an edge still serving the previous deployment.
# ---------------------------------------------------------------------------
http_get "$origin/" "200"
origin_status="$STATUS"
case "$origin_status" in
  403) ;;
  200)
    note "$origin/ still returns 200 after $ATTEMPTS attempts — the origin lock is NOT in effect. The config did not reach the artifact, or forwardingGateway was not applied. The Azure hostname is serving the site directly, bypassing Cloudflare."
    ;;
  404)
    note "$origin/ returned 404. That is what Azure returns for a hostname that is not a live Static Web App, so it does NOT prove the lock is working. Check AZURE_HOSTNAME is the current default hostname of the production app. If the hostname is right, Azure is using 404 for the missing required header — pin that here rather than accepting 404 in general."
    ;;
  *)
    note "$origin/ returned $origin_status; expected 403, which is what Azure was observed to return for the missing required header on 2026-08-08. This is not evidence that the lock is working, and a false pass here is silent and permanent. If Azure has genuinely changed its refusal code, confirm that by hand and update this script rather than widening it back out.${CURL_ERR:+ curl said: $CURL_ERR}"
    ;;
esac

# ---------------------------------------------------------------------------
# 4. The config must not be served.
#
# This deploy is the first thing to put a secret inside the build output. Static Web Apps
# is expected to consume staticwebapp.config.json rather than serve it; if that is ever
# wrong, the secret is published at a stable public URL.
#
# A request that never completed is its own outcome, NOT "not served". Reporting
# `config=not-served` off the back of a timeout is a positive claim about the secret's
# safety made without having looked.
#
# Asserts on the BODY, not the status: with a navigationFallback that URL returns 200
# with index.html, and a status check would cry "the secret is public" falsely.
# ---------------------------------------------------------------------------
http_get "$site/staticwebapp.config.json"
config_state='not-served'
# A 5xx is as uninformative as a dead connection: neither tells you whether the secret is
# being served, so neither may be reported as "not-served".
if [ "$STATUS" = "000" ] || case "$STATUS" in 5*) true ;; *) false ;; esac; then
  config_state='UNVERIFIED'
  note "Could not determine whether $site/staticwebapp.config.json is served — the request never completed.${CURL_ERR:+ curl said: $CURL_ERR} This is not the same as 'not served': the secret's exposure is unknown."
else
  case "$BODY" in
    *forwardingGateway*)
      config_state='SERVED'
      note "staticwebapp.config.json is being SERVED at $site — the origin-verify secret is public. Rotate it immediately (see the README's rotation procedure)."
      ;;
  esac
fi

if [ "$failures" -gt 0 ]; then
  echo "verification FAILED with $failures problem(s): site=$site_status origin=$origin_status config=$config_state" >&2
  exit 1
fi

echo "site=$site_status origin=$origin_status config=$config_state${expected_sha:+ release=$expected_sha}"
