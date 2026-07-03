#!/usr/bin/env bash
# One-command load test: build the bot, start an OFFLINE Firestore emulator, run the orchestrator.
# Zero cloud — uses a `demo-*` project id so the emulator needs no credentials/login.
#
#   ./loadtest/run.sh                          # default sweep, singleton mode
#   GAMES=50,100,200 SCALING_MODE=singleton ./loadtest/run.sh
#   BRIDGE_LATENCY_MS=250 SLO_MS=8000 ./loadtest/run.sh
set -euo pipefail
cd "$(dirname "$0")/.."   # -> bot/

echo "[loadtest] building bot..."
npm run build >/dev/null

echo "[loadtest] starting offline Firestore emulator + orchestrator..."
# `command firebase` bypasses any shell wrapper. demo-* project => fully offline emulator.
command firebase emulators:exec \
  --only firestore \
  --project "${LOADTEST_PROJECT:-demo-comtower}" \
  --config loadtest/firebase.json \
  "node loadtest/run.mjs"
