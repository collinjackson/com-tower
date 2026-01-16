#!/usr/bin/env bash
set -euo pipefail

# Simple Cloud Run deploy helper for the worker.
# Usage:
#   export FIREBASE_PROJECT_ID=...
#   export FIREBASE_CLIENT_EMAIL=...
#   export FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n... \n-----END PRIVATE KEY-----\n"
#   export SIGNAL_CLI_URL=https://signal-bridge-xyz-uc.a.run.app
#   export SIGNAL_BOT_NUMBER=+15551234567
#   # Optional:
#   # export NOTIFY_RENDER_URL=https://com-tower.vercel.app/api/notify/render
#   # export AWBW_WS_BASE=wss://awbw.amarriner.com
#   # export RENDER_BYPASS_TOKEN=...
#   ./deploy.sh
#
# You can override defaults:
#   PROJECT_ID, REGION, SERVICE_NAME, MAX_INSTANCES, MIN_INSTANCES

PROJECT_ID="${PROJECT_ID:-com-tower}"
REGION="${REGION:-us-central1}"
SERVICE_NAME="${SERVICE_NAME:-com-tower-worker}"
MIN_INSTANCES="${MIN_INSTANCES:-1}"
MAX_INSTANCES="${MAX_INSTANCES:-5}"
RENDER_URL="${NOTIFY_RENDER_URL:-https://com-tower.vercel.app/api/notify/render}"

missing=0
for var in FIREBASE_PROJECT_ID FIREBASE_CLIENT_EMAIL FIREBASE_PRIVATE_KEY SIGNAL_CLI_URL SIGNAL_BOT_NUMBER; do
  if [[ -z "${!var:-}" ]]; then
    echo "Missing required env: $var" >&2
    missing=1
  fi
done
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
  --set-env-vars "FIREBASE_PROJECT_ID=${FIREBASE_PROJECT_ID}" \
  --set-env-vars "FIREBASE_CLIENT_EMAIL=${FIREBASE_CLIENT_EMAIL}" \
  --set-env-vars "FIREBASE_PRIVATE_KEY=${FIREBASE_PRIVATE_KEY}" \
  --set-env-vars "NOTIFY_RENDER_URL=${RENDER_URL}" \
  --set-env-vars "SIGNAL_CLI_URL=${SIGNAL_CLI_URL}" \
  --set-env-vars "SIGNAL_BOT_NUMBER=${SIGNAL_BOT_NUMBER}" \
  --set-env-vars "AWBW_WS_BASE=${AWBW_WS_BASE:-wss://awbw.amarriner.com}" \
  --set-env-vars "RENDER_BYPASS_TOKEN=${RENDER_BYPASS_TOKEN:-}" \
  "$@"

echo "Done. Confirm with: gcloud run services describe $SERVICE_NAME --project $PROJECT_ID --region $REGION"
