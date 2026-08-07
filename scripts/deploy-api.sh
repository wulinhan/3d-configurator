#!/usr/bin/env bash
# Deploy the service to Fly.
#
# The checks run FIRST and locally. A deploy that fails its own unit suite
# should never reach a machine merchants are using, and finding that out from
# `flyctl logs` afterwards costs a rollback.
set -euo pipefail

cd "$(dirname "$0")/.."

command -v flyctl >/dev/null || { echo "flyctl not found — see DEPLOY.md §3"; exit 1; }

echo "→ unit suites"
npm run test:unit

echo "→ required secrets"
# Not a substitute for reading DEPLOY.md, but it catches the deploy where one
# secret was forgotten and the service comes up unable to email anybody.
missing=()
for key in DATABASE_URL APP_BASE PUBLIC_BASE STUDIO_ORIGINS; do
  flyctl secrets list --config packages/api/fly.toml 2>/dev/null | grep -q "^$key" || missing+=("$key")
done
if [ ${#missing[@]} -gt 0 ]; then
  echo "missing secrets: ${missing[*]}"
  echo "set them with flyctl secrets set — see DEPLOY.md §3"
  exit 1
fi

echo "→ deploy"
# From the repository root: the image needs the workspace lockfile and
# packages/embed, because the service imports the embed's validator rather
# than keeping a second opinion about what a valid product is.
flyctl deploy --config packages/api/fly.toml --dockerfile packages/api/Dockerfile "$@"

echo "→ health"
base=$(flyctl status --config packages/api/fly.toml --json | node -e \
  'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s);console.log("https://"+(a.Hostname??a.hostname))})')
curl -fsS "$base/health" && echo && echo "deployed: $base"
