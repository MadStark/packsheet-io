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

# Fetch a URL into a file and echo the status code, retrying while the answer is not one
# the caller is willing to believe. Cloudflare's managed challenge, bot-fight mode and
# rate limiting all answer a datacenter IP running curl with a 4xx, and an edge seconds
# after a deploy can still be catching up — believing the first bad answer produces the
# most dangerous false alarm available here, which sends someone to "fix" a site that is
# healthy for every real browser.
#
# `want` is an extended regex over the status code and defaults to exactly 200, which is
# what every check had until an on-demand route was added below: that one's correct answer
# is a REDIRECT, so "retry until 200" would have retried five times and then reported the
# right answer as the wrong one. Redirects are deliberately not followed — where a
# signed-out visitor is sent is the thing being checked, not an obstacle on the way to a
# page.
#
# Response headers go to `$4` when the caller wants them, which is how that check reads
# `Location` without a second request. Default /dev/null: nothing else needs them, and a
# file written per call that nobody reads is a temp file to get wrong.
#
# A curl that cannot run at all yields 000, which matches no caller's `want`, so a broken
# or missing curl exhausts the retries and fails. It never reports success without having
# looked.
fetch() {
  local url="$1" out="$2" want="${3:-^200$}" head="${4:-/dev/null}" attempt=1 status
  while :; do
    status="$(curl -sS -o "$out" -D "$head" -w '%{http_code}' --max-time "$TIMEOUT" "$url" 2>/dev/null || echo '000')"
    if printf '%s' "$status" | grep -Eq "$want" || [ "$attempt" -ge "$ATTEMPTS" ]; then
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

# ---------------------------------------------------------------------------
# The WORKER runs, not just the assets binding
# ---------------------------------------------------------------------------
# Neither check above touches the Worker at all. `/` and `/robots.txt` are both
# prerendered: Cloudflare's assets binding serves them straight off the uploaded files,
# and the script that PK-19 gave real runtime secrets to never executes. So every check
# in this file was green for a release in which every on-demand route 500s.
#
# That stopped being hypothetical with PK-19. `/sign-in`, `/sign-up`, `/account`,
# `/auth/callback` and `/auth/signout` are all on-demand now, they all reach
# `src/lib/auth/index.ts`, and that module throws at request time when
# PUBLIC_SUPABASE_URL or PUBLIC_SUPABASE_ANON_KEY is missing or unparseable. A deploy that
# built without those secrets — a renamed GitHub secret, an environment that lost one —
# produces exactly that: a perfect landing page, an indexable robots.txt, and a 500 on
# every route a person can sign in through.
#
# `/account` is the route chosen, and its correct signed-out answer is a redirect to
# sign-in. That makes this a check with a specific expectation rather than "did not 500":
#
#   - It proves middleware ran (it is what resolves the user), that `getUser()` completed
#     against a real Supabase URL rather than throwing, and that the page's own guard
#     branched. A 500 fails it, and so does a 200 — a signed-out visitor being served the
#     account page is the more serious of the two and would pass any "is it up" check.
#   - It stays CREDENTIAL-FREE. No cookie is sent, nothing is signed in to, and no account
#     exists for this to touch. The verifier runs against production after every release
#     and must never hold a session.
#
# The two paths are duplicated from src/lib/auth-routes.ts because a shell script cannot
# import a TypeScript constant. tests/deploy-workers.test.ts asserts the copies agree, so
# renaming a route breaks the build here rather than silently checking a 404.
account_headers="$work/account.headers"
account_status="$(fetch "$SITE/account" "$work/account.html" '^30[12378]$' "$account_headers")"
if ! printf '%s' "$account_status" | grep -Eq '^30[12378]$'; then
  fail "$SITE/account answered $account_status, expected a redirect to /sign-in — the on-demand routes are not working, which is what a missing or wrong PUBLIC_SUPABASE_* secret looks like."
else
  # Last Location wins, `\r` stripped: a header dump is CRLF and, on a redirect chain,
  # carries one set of headers per hop. `|| true` because a redirect with no Location at
  # all must be reported by the check below rather than killing the script under `set -e`.
  location="$(grep -i '^location:' "$account_headers" | tail -1 | tr -d '\r' | sed 's/^[Ll]ocation:[[:space:]]*//' || true)"
  # Relative is what Astro emits; the absolute form is accepted only on THIS site's own
  # origin. Accepting any host that happens to end in /sign-in would pass an open redirect
  # — which is precisely the defect safeNextPath exists to prevent, so it is not a shape to
  # wave through in the check that verifies the release.
  case "$location" in
    /sign-in | /sign-in\?* | "$SITE"/sign-in | "$SITE"/sign-in\?*) ;;
    *)
      fail "$SITE/account redirected to '$location', expected the sign-in page on this site."
      ;;
  esac
fi

# Every check runs even when an earlier one fails, and the count is reported. The
# alternative — exiting at the first problem — hides the second one until someone
# fixes the first and deploys again.
if [ "$problems" -gt 0 ]; then
  echo "Release verification FAILED: $problems problem(s) at $SITE"
  exit 1
fi

echo "Verified: $SITE serves 200 HTML, an indexable robots.txt, and an on-demand route that redirects a signed-out visitor to sign-in."
