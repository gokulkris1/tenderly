#!/usr/bin/env bash
# Netlify's build "ignore" hook: exit 0 to SKIP the build, non-zero to run it.
#
# Every pull request triggered a deploy preview, and across this and other
# projects that ran the account into a build-credit block. Builds are therefore
# off by default and switched on deliberately.
#
# To turn deploys back on, set TENDERLY_NETLIFY_DEPLOYS=on in the site's
# environment variables (Site configuration -> Environment variables), or run
#   node scripts/netlify-deploys.mjs on
#
# Nothing here changes what is built — only whether a build runs at all.
set -euo pipefail

if [ "${TENDERLY_NETLIFY_DEPLOYS:-off}" = "on" ]; then
  echo "TENDERLY_NETLIFY_DEPLOYS=on — building."
  exit 1   # non-zero: proceed with the build
fi

echo "TENDERLY_NETLIFY_DEPLOYS is not 'on' — skipping this build to preserve build credits."
exit 0     # zero: skip
