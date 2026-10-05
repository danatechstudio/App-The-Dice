#!/usr/bin/env bash
# One-command Cloudflare setup for the RTD app. Safe to re-run: every step
# checks what already exists and only does what is missing.
#
#   ./scripts/cloudflare-setup.sh [admin-email]
#
# Auth: either `npx wrangler login` first, or set CLOUDFLARE_API_TOKEN and
# CLOUDFLARE_ACCOUNT_ID (token needs Workers Scripts Edit + D1 Edit).
#
# Does: install deps -> run tests -> create D1 `rtd-app` (if missing) and write
# its id into wrangler.jsonc -> apply migrations -> deploy -> create the
# INTERNAL_SYNC_TOKEN secret (if missing) -> optionally add the first admin.
# Cloudflare Access (staff sign-in) is a separate step: docs/RTD_DEPLOYMENT.md §4.

set -euo pipefail
cd "$(dirname "$0")/.."

export WRANGLER_SEND_METRICS=false
DB_NAME=rtd-app
TOKEN_FILE=.rtd-sync-token
ADMIN_EMAIL="${1:-}"
wrangler() { npx --no-install wrangler "$@"; }
step() { printf '\n== %s\n' "$*"; }

step "Dependencies and tests"
[ -d node_modules ] || npm ci
npm run --silent typecheck
npm test --silent

step "Cloudflare account"
if ! wrangler whoami >/dev/null 2>&1; then
  echo "Not signed in. Run 'npx wrangler login' or set CLOUDFLARE_API_TOKEN, then re-run." >&2
  exit 1
fi
wrangler whoami | grep -iE 'account|email' || true

step "D1 database '$DB_NAME'"
db_id() {
  wrangler d1 list --json | node -e '
    let s = ""; process.stdin.on("data", d => (s += d)).on("end", () => {
      const db = JSON.parse(s).find(d => d.name === process.argv[1]);
      if (db) process.stdout.write(db.uuid);
    });' "$DB_NAME"
}
DB_ID="$(db_id)"
if [ -z "$DB_ID" ]; then
  wrangler d1 create "$DB_NAME" >/dev/null
  DB_ID="$(db_id)"
fi
[ -n "$DB_ID" ] || { echo "Could not find or create D1 database $DB_NAME" >&2; exit 1; }
echo "database_id: $DB_ID"
node -e '
  const fs = require("fs");
  const s = fs.readFileSync("wrangler.jsonc", "utf8");
  const t = s.replace(/("database_id":\s*")[^"]*(")/, `$1${process.argv[1]}$2`);
  if (t !== s) { fs.writeFileSync("wrangler.jsonc", t); console.log("wrangler.jsonc updated (commit this)"); }
' "$DB_ID"

step "Migrations"
wrangler d1 migrations apply "$DB_NAME" --remote

step "Deploy"
DEPLOY_OUT="$(wrangler deploy 2>&1)" || { echo "$DEPLOY_OUT" >&2; exit 1; }
echo "$DEPLOY_OUT" | tail -n 6
APP_URL="$(echo "$DEPLOY_OUT" | grep -oE 'https://[a-zA-Z0-9.-]+\.workers\.dev' | head -n 1 || true)"

step "Sync token secret"
if wrangler secret list --format json 2>/dev/null | grep -q '"INTERNAL_SYNC_TOKEN"'; then
  echo "INTERNAL_SYNC_TOKEN already set (not changed)."
else
  umask 077
  openssl rand -hex 32 | tr -d '\n' > "$TOKEN_FILE"
  wrangler secret put INTERNAL_SYNC_TOKEN < "$TOKEN_FILE" >/dev/null
  echo "Created INTERNAL_SYNC_TOKEN. Its value is in $TOKEN_FILE (git-ignored):"
  echo "copy it into the n8n 'RTD App Sync' credential, then delete the file."
fi

if [ -n "$ADMIN_EMAIL" ]; then
  step "First admin: $ADMIN_EMAIL"
  case "$ADMIN_EMAIL" in *[!A-Za-z0-9@._+-]*|*\'*) echo "Unexpected characters in email" >&2; exit 1;; esac
  wrangler d1 execute "$DB_NAME" --remote --command \
    "INSERT INTO users (user_id, email, role, created_at, updated_at)
     SELECT 'admin-' || lower(hex(randomblob(6))), '$ADMIN_EMAIL', 'admin',
            strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE NOT EXISTS (SELECT 1 FROM users WHERE email = '$ADMIN_EMAIL')" >/dev/null
  echo "Admin present."
fi

step "Check"
if [ -n "$APP_URL" ]; then
  curl -fsS --max-time 15 "$APP_URL/api/health" && echo || echo "(health check could not reach $APP_URL from here)"
  echo "App URL: $APP_URL"
else
  echo "Deployed. Find the URL under Workers & Pages -> rtd-app."
fi
echo "Next: Cloudflare Access for staff sign-in (docs/RTD_DEPLOYMENT.md §4)."
