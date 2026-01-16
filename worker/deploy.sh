#!/usr/bin/env bash
set -euo pipefail

# Cloud Run deploy helper for the worker.
# Supports reading secrets from Secret Manager. If SECRET_* are set, they win.
# Otherwise falls back to plain env values.
#
# Quick use (secrets recommended):
#   export PROJECT_ID=com-tower
#   export REGION=us-central1
#   export SECRET_FIREBASE_PRIVATE_KEY=firebase-private-key
#   export SECRET_FIREBASE_CLIENT_EMAIL=firebase-client-email
#   export SECRET_FIREBASE_PROJECT_ID=firebase-project-id
#   export SECRET_SIGNAL_CLI_URL=signal-cli-url
#   export SECRET_SIGNAL_BOT_NUMBER=signal-bot-number
#   # Optional:
#   # export SECRET_NOTIFY_RENDER_URL=notify-render-url
#   # export SECRET_RENDER_BYPASS_TOKEN=render-bypass-token
#   # export SECRET_AWBW_WS_BASE=awbw-ws-base
#   ./deploy.sh
#
# If you don’t want secrets, set the non-secret envs instead:
#   FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, SIGNAL_CLI_URL, SIGNAL_BOT_NUMBER
#   (and optionally NOTIFY_RENDER_URL, AWBW_WS_BASE, RENDER_BYPASS_TOKEN)
#
# Override defaults: PROJECT_ID, REGION, SERVICE_NAME, MAX_INSTANCES, MIN_INSTANCES

PROJECT_ID="${PROJECT_ID:-com-tower}"
REGION="${REGION:-us-central1}"
SERVICE_NAME="${SERVICE_NAME:-com-tower-worker}"
MIN_INSTANCES="${MIN_INSTANCES:-1}"
MAX_INSTANCES="${MAX_INSTANCES:-5}"
RENDER_URL="${NOTIFY_RENDER_URL:-https://com-tower.vercel.app/api/notify/render}"

# Helper to emit either --set-secrets or --set-env-vars flags.
flags=()

add_secret_or_env() {
  local var="$1"
  local secret_var="SECRET_${var}"
  if [[ -n "${!secret_var:-}" ]]; then
    flags+=(--set-secrets "${var}=${!secret_var}:latest")
  elif [[ -n "${!var:-}" ]]; then
    flags+=(--set-env-vars "${var}=${!var}")
  else
    echo "Missing required config: set $var or $secret_var" >&2
    missing=1
  fi
}

missing=0
add_secret_or_env "FIREBASE_PROJECT_ID"
add_secret_or_env "FIREBASE_CLIENT_EMAIL"
add_secret_or_env "FIREBASE_PRIVATE_KEY"
add_secret_or_env "SIGNAL_CLI_URL"
add_secret_or_env "SIGNAL_BOT_NUMBER"

# Optional configs
if [[ -n "${SECRET_NOTIFY_RENDER_URL:-}" ]]; then
  flags+=(--set-secrets "NOTIFY_RENDER_URL=${SECRET_NOTIFY_RENDER_URL}:latest")
else
  flags+=(--set-env-vars "NOTIFY_RENDER_URL=${RENDER_URL}")
fi

if [[ -n "${SECRET_RENDER_BYPASS_TOKEN:-}" ]]; then
  flags+=(--set-secrets "RENDER_BYPASS_TOKEN=${SECRET_RENDER_BYPASS_TOKEN}:latest")
elif [[ -n "${RENDER_BYPASS_TOKEN:-}" ]]; then
  flags+=(--set-env-vars "RENDER_BYPASS_TOKEN=${RENDER_BYPASS_TOKEN}")
fi

if [[ -n "${SECRET_AWBW_WS_BASE:-}" ]]; then
  flags+=(--set-secrets "AWBW_WS_BASE=${SECRET_AWBW_WS_BASE}:latest")
else
  flags+=(--set-env-vars "AWBW_WS_BASE=${AWBW_WS_BASE:-wss://awbw.amarriner.com}")
fi

if [[ $missing -eq 1 ]]; then
  exit 1
fi

echo "Deploying $SERVICE_NAME to project $PROJECT_ID ($REGION)..."

gcloud run deploy "$SERVICE_NAME" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --platform=managed \
  --source=. \
  --memory=512Mi \
  --cpu=1 \
  --timeout=900 \
  --min-instances="$MIN_INSTANCES" \
  --max-instances="$MAX_INSTANCES" \
  --allow-unauthenticated \
  "${flags[@]}" \
  "$@"

echo "Done. Confirm with: gcloud run services describe $SERVICE_NAME --project $PROJECT_ID --region $REGION"
