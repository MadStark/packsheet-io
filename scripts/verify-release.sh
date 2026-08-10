#!/usr/bin/env bash
#
# Verify that a release actually answers, immediately after deploying it.
#
# This is a script rather than an inline `run:` block for exactly the reason the
# origin-lock verifier it descends from was one: inline, its failure branches can be
# replaced with an `echo` — or its condition inverted — and every test stays green,
# because nothing can execute a YAML string. A review found precisely that mutation
# surviving here: inverting the robots check produced a step that fails every correct
# release and passes silently when a staging build is live on packsheet.io. As a
# script it can be driven against stub origins, which tests/deploy-workers.test.ts
# does.
#
#   usage: verify-release.sh <site-url>
#
# Exit 0 only if every check passed. Exit 1 with a count otherwise.
#
# Tunables, used by the tests to avoid a two-minute suite:
#   VERIFY_ATTEMPTS  tries per URL before believing a bad answer (default 5)
#   VERIFY_DELAY     seconds between tries (default 5)
#   VERIFY_TIMEOUT   seconds per request (default 20)

set -euo pipefail

SITE="${1:?usage: verify-release.sh <site-url>}"

ATTEMPTS="${VERIFY_ATTEMPTS:-5}"
DELAY="${VERIFY_DELAY:-5}"
TIMEOUT="${VERIFY_TIMEOUT:-20}"

# Checked explicitly rather than left to `set -e`.
#
# `set -euo pipefail` above is defence in depth here, not the mechanism: every external
# call in this script handles its own failure, which is deliberate and is the stronger
# property — a review found that deleting the `set` line changed no behaviour and
# tripped no test. The way to make a safety line matter is to not depend on it silently.
#
# What this specific guard prevents: an empty $work turns every path below into an
# absolute one at the filesystem root, so the script would go on to write to /home.html
# and grep a file it never created — reporting problems that describe the wrong thing.
work="$(mktemp -d)" || work=''
if [ -z "$work" ] || [ ! -d "$work" ]; then
  echo "::error::verify-release.sh could not create a working directory."
  exit 1
fi
trap 'rm -rf "$work"' EXIT

problems=0
fail() {
  # ::error:: renders in the Actions log as an annotation on the job.
  echo "::error::$1"
  problems=$((problems + 1))
}

# Fetch a URL into a file and echo the status code, retrying while the answer is not
# 200. Cloudflare's managed challenge, bot-fight mode and rate limiting all answer a
# datacenter IP running curl with a 4xx, and an edge seconds after a deploy can still
# be catching up — believing the first bad answer produces the most dangerous false
# alarm available here, which sends someone to "fix" a site that is healthy for every
# real browser.
#
# A curl that cannot run at all yields 000, which is not 200, so a broken or missing
# curl exhausts the retries and fails. It never reports success without having looked.
fetch() {
  local url="$1" out="$2" attempt=1 status
  while :; do
    status="$(curl -sS -o "$out" -w '%{http_code}' --max-time "$TIMEOUT" "$url" 2>/dev/null || echo '000')"
    if [ "$status" = "200" ] || [ "$attempt" -ge "$ATTEMPTS" ]; then
      printf '%s' "$status"
      return 0
    fi
    attempt=$((attempt + 1))
    sleep "$DELAY"
  done
}

# ---------------------------------------------------------------------------
# The home page is served, and is a page
# ---------------------------------------------------------------------------
home_status="$(fetch "$SITE/" "$work/home.html")"
if [ "$home_status" != "200" ]; then
  fail "$SITE/ answered $home_status, expected 200."
elif ! grep -qi '<html' "$work/home.html"; then
  # 200 with a non-HTML body is what an assets binding pointed at the wrong directory
  # looks like: the deploy succeeds and the site serves something that is not the site.
  fail "$SITE/ answered 200 but the body is not HTML."
fi

# ---------------------------------------------------------------------------
# The build that landed is the PRODUCTION build
# ---------------------------------------------------------------------------
# robots.txt is the only output that differs between the production and staging
# builds, which makes it the one cheap signal that the right artifact is live. Both
# halves are asserted on purpose:
#
#   - the Sitemap line is POSITIVE evidence, present only in the production build.
#     Checking merely for the absence of Disallow would pass on an empty file, a 404
#     body, or an error page.
#   - Disallow: / is the specific catastrophe — a staging or preview build on
#     packsheet.io, invisible from the outside, costing the site its search presence.
robots_status="$(fetch "$SITE/robots.txt" "$work/robots.txt")"
if [ "$robots_status" != "200" ]; then
  fail "$SITE/robots.txt answered $robots_status, expected 200."
else
  if ! grep -qi '^Sitemap:' "$work/robots.txt"; then
    fail "$SITE/robots.txt has no Sitemap: line — this is not the production build."
  fi
  if grep -q '^Disallow: /[[:space:]]*$' "$work/robots.txt"; then
    fail "$SITE/robots.txt disallows crawling — a non-production build is live."
  fi
fi

# Every check runs even when an earlier one fails, and the count is reported. The
# alternative — exiting at the first problem — hides the second one until someone
# fixes the first and deploys again.
if [ "$problems" -gt 0 ]; then
  echo "Release verification FAILED: $problems problem(s) at $SITE"
  exit 1
fi

echo "Verified: $SITE serves 200 HTML and an indexable robots.txt."
