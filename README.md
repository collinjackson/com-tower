# Com Tower

**Overview**
- `web/` — Next.js (Vercel) frontend + API:
  - Auth: Google (Firebase).
  - Patch UI: select/create patches, store default Signal number, add subscribers.
  - API: `/api/game/lookup` (scrape/cache AWBW), `/api/patch/[id]/subscribers` (store subscribers), `/api/notify/render` (generate message text, optional AI caption).
- `worker/` — Cloud Run service:
  - Watches Firestore `patches` for games/subscribers.
  - Opens AWBW websockets per game; on `NextTurn`, fetches rendered message from `web` (`NOTIFY_RENDER_URL`), sends via Signal bridge, and logs to Firestore `messages`.
  - Keeps sockets alive with reconnect; health check on `/health`.
- `signal-bridge/` — Cloud Run service:
  - Runs `signal-cli-rest-api` with mounted Signal identity (GCS bucket).
  - Protected by IAM (Run Invoker); worker calls it with ID token.

**Data**
- Firestore collections:
  - `games` (metadata)
  - `patches` (per game+inviter, holds subscribers)
  - `users` (default Signal number per user)
  - `messages` (sent notification log: gameId, text, recipient, createdAt)

**Secrets / env**
- Signal identity in GCS (`comtower-signal-identity`), mounted to bridge.
- `firebase-admin-key` (Secret Manager) for worker/admin.
- `openai-api-key` (Secret Manager) for fun-mode captions in `worker` and `web` render API.
- Worker env: `NOTIFY_RENDER_URL`, `SIGNAL_CLI_URL`, `SIGNAL_BOT_NUMBER`, Firebase admin vars, AWBW_WS_BASE.
- Web env: `OPENAI_API_KEY` (for `/api/notify/render`), Firebase client config in `.env.local`.

**Flow**
1. User patches a game in the UI; `patches/{game-inviter}` and subscribers are stored server-side.
2. Worker sees the patch, opens AWBW websocket for that game.
3. On `NextTurn`, worker calls `/api/notify/render` for text, sends via `signal-bridge`, and logs to `messages`.
4. Frontend can show activity feed from `messages`.

