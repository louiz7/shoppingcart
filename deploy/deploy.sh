#!/bin/bash
# deploy/deploy.sh — deploy the API, dashboard, and Evi agent to production.
set -euo pipefail

SERVER="${RESCOVA_SERVER:-root@178.105.55.189}"
APP_DIR="${RESCOVA_APP_DIR:-/opt/rescova}"
SSH_KEY="${RESCOVA_SSH_KEY:-${HOME}/.ssh/rescova_deploy}"
LOCAL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SSH=(ssh -i "$SSH_KEY" -o IdentitiesOnly=yes "$SERVER")
RSYNC_SSH="ssh -i $SSH_KEY -o IdentitiesOnly=yes"

say() { printf "\n\033[1;36m==> %s\033[0m\n" "$*"; }

test -f "$SSH_KEY" || {
  echo "Deployment key not found: $SSH_KEY" >&2
  exit 1
}

say "Checking production target"
"${SSH[@]}" "test -d '$APP_DIR' && test -f '$APP_DIR/.env' && test -f '$APP_DIR/agent/.env'"

say "Syncing code to $SERVER:$APP_DIR (secrets and generated files excluded)"
rsync -az -e "$RSYNC_SSH" \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude '.env' \
  --exclude '.venv' \
  --exclude 'agent/.venv' \
  --exclude 'agent/data' \
  --exclude 'dashboard/.svelte-kit' \
  --exclude 'dashboard/build' \
  --exclude 'website/dist' \
  --exclude '.DS_Store' \
  "$LOCAL_DIR/" "$SERVER:$APP_DIR/"

say "Installing Node deps"
"${SSH[@]}" "cd '$APP_DIR' && npm ci --omit=dev"

say "Installing dashboard deps and building"
"${SSH[@]}" "cd '$APP_DIR/dashboard' && npm ci && npm run build"

say "Running migrations"
"${SSH[@]}" "cd '$APP_DIR' && node scripts/migrate.js"

say "Updating agent Python environment"
"${SSH[@]}" "
  set -e
  cd '$APP_DIR/agent'
  test -d .venv || python3 -m venv .venv
  .venv/bin/pip install -r requirements.txt --quiet
"

say "Restarting application services"
"${SSH[@]}" "systemctl restart rescova-api rescova-dashboard rescova-agent"

say "Status"
"${SSH[@]}" "systemctl is-active rescova-api rescova-dashboard rescova-agent"

echo
echo "URLs:"
echo "  API health:   https://api.rescova.de/healthz"
echo "  Dashboard:    https://app.rescova.de/login"
echo "  Agent logs:   ssh -i $SSH_KEY $SERVER 'journalctl -u rescova-agent -f'"
