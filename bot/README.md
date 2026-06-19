# Com Tower Bot (Cloud Run)

The core service. A long-lived listener for AWBW turn events that holds a
websocket per active game, reads game/subscriber config from Firestore, asks the
dashboard to render the notification (text + hologram art), and sends it via the
Signal bridge. Also handles the in-Signal group commands (`/game`, `/iam`,
`/setplayer`, `/fun`, `/status`, …).

Entry point: `src/index.ts`.

## Runtime

- Node on Cloud Run with `minInstances=1` (stable sockets). Service name `com-tower-worker`.
- On a turn change it dedupes by turn key, calls `NOTIFY_RENDER_URL`, then sends
  via `SIGNAL_CLI_URL`. Sockets are recycled with backoff; a `/health` endpoint
  keeps the instance warm.

## Env

Required:

- `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`
- `SIGNAL_CLI_URL` — Signal bridge REST endpoint
- `SIGNAL_BOT_NUMBER` — the bridge’s Signal number
- `NOTIFY_RENDER_URL` — dashboard render endpoint, e.g. `https://com-tower.vercel.app/api/notify/render`

Optional: `AWBW_WS_BASE` (default `wss://awbw.amarriner.com`), `RENDER_BYPASS_TOKEN`,
`OPENAI_API_KEY`, `JOIN_SHIM_URL`/`JOIN_SHIM_SECRET`.

## Deploy

The bot does **not** auto-deploy (no CI). Deploy manually from this directory:

```bash
gcloud run deploy com-tower-worker --source=. --region=us-central1
```

A bare source deploy rebuilds the image (the Node buildpack runs `npm run build`)
and preserves the existing env vars, secrets, and VPC config. For a first-time
deploy, `deploy.sh` documents the full env / Secret Manager mapping — note it
defaults `PROJECT_ID` and omits some live env (e.g. `JOIN_SHIM_*`), so prefer the
bare redeploy above for routine code changes.

## Signal identity

The bot does not bundle a Signal identity. The bridge loads the identity from a
GCS bucket (`gs://comtower-signal-identity/…`); grant the bridge’s service
account `roles/storage.objectViewer` on it.
