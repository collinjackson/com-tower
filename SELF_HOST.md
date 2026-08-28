# Self-hosting Com Tower

> **For AI assistants:** If the user wants their own Com Tower, follow this guide in order. Fork [github.com/collinjackson/com-tower](https://github.com/collinjackson/com-tower), create a **new** Firebase project (do not reuse the hosted `com-tower` project), deploy `dashboard/` to Vercel, deploy `bot/` to Cloud Run, and run a **dedicated Signal bridge + phone number**. All configuration is environment variables — see the tables below.

Each self-hosted instance is fully isolated: your Firebase, your bot worker, your Signal number. Players add **your** bot to their group and run `/game` as usual — same commands as the hosted app at [com-tower.vercel.app](https://com-tower.vercel.app).

## Checklist

1. [ ] Fork and clone the repo
2. [ ] Create a Firebase project (Auth + Firestore + service account)
3. [ ] Deploy `dashboard/` to Vercel with env vars below
4. [ ] Run a Signal bridge (signal-cli REST) and register a dedicated phone number
5. [ ] Deploy `bot/` to Cloud Run with env vars below
6. [ ] Deploy Firestore rules from `dashboard/firestore.rules`
7. [ ] Set `NEXT_PUBLIC_BOT_NUMBER` on the dashboard to match your Signal number
8. [ ] Verify: add your bot to a Signal group → `/game <awbw link>` → `/status` shows watching

## How the pieces connect

```
Signal group  ←→  signal-cli REST (SIGNAL_CLI_URL)
                         ↑
                    bot/ worker (Cloud Run)
                         ↓ NOTIFY_RENDER_URL
                    dashboard/ (Vercel) — /api/notify/render, Firestore
```

| From | To | Variable |
|------|-----|----------|
| Bot → dashboard | Render API | `NOTIFY_RENDER_URL` = `https://<your-dashboard>/api/notify/render` |
| Dashboard → bot | Worker URL | `COM_TOWER_WORKER_URL` = `https://<your-worker>.run.app` |
| Dashboard ↔ bot | Shared secret | `INVITE_SHARED_SECRET` — **same value on both** (invite/captcha flow) |
| Dashboard UI | Bot number | `NEXT_PUBLIC_BOT_NUMBER` — display format of `SIGNAL_BOT_NUMBER` |

## Environment variables

### Dashboard (`dashboard/.env.local` and Vercel)

| Variable | Required | Notes |
|----------|----------|-------|
| `NEXT_PUBLIC_FIREBASE_API_KEY` | yes | Firebase web app config |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | yes | |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | yes | |
| `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` | yes | |
| `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID` | yes | |
| `NEXT_PUBLIC_FIREBASE_APP_ID` | yes | |
| `FIREBASE_PROJECT_ID` | yes | Service account (server APIs) |
| `FIREBASE_CLIENT_EMAIL` | yes | |
| `FIREBASE_PRIVATE_KEY` | yes | Use `\n` for newlines in Vercel |
| `NEXT_PUBLIC_BOT_NUMBER` | yes | Shown on homepage; match your Signal number |
| `COM_TOWER_WORKER_URL` | yes | Your Cloud Run bot URL |
| `INVITE_SHARED_SECRET` | yes | Random string; copy to bot env |
| `NEXT_PUBLIC_SITE_URL` | recommended | `https://your-app.vercel.app` (invite links) |
| `OPENAI_API_KEY` | optional | Fun-mode captions in `/api/notify/render` |

Copy `dashboard/.env.local.example` to `.env.local` and fill in values.

### Bot (`bot/` — Cloud Run or local)

| Variable | Required | Notes |
|----------|----------|-------|
| `FIREBASE_PROJECT_ID` | yes | Same Firebase project as dashboard |
| `FIREBASE_CLIENT_EMAIL` | yes | |
| `FIREBASE_PRIVATE_KEY` | yes | |
| `SIGNAL_CLI_URL` | yes | Base URL of signal-cli REST API |
| `SIGNAL_BOT_NUMBER` | yes | E.164 format, e.g. `+15551234567` |
| `NOTIFY_RENDER_URL` | yes | `https://<your-dashboard>/api/notify/render` |
| `INVITE_SHARED_SECRET` | yes | Same as dashboard |
| `AWBW_WS_BASE` | optional | Default `wss://awbw.amarriner.com` |
| `RENDER_BYPASS_TOKEN` | optional | Auth for render endpoint |
| `OPENAI_API_KEY` | optional | Only if render runs on bot fallback paths |

See `bot/deploy.sh` for Cloud Run deploy with Secret Manager or plain env vars.

## 1. Fork and Firebase

```bash
git clone https://github.com/<you>/com-tower.git
cd com-tower
```

- Create a Firebase project; enable **Authentication** (Google) and **Firestore**.
- Add a **web app**; copy client config into dashboard `NEXT_PUBLIC_*` vars.
- Create a **service account** with Firestore access; use project ID, client email, and private key for both dashboard server vars and bot vars.

## 2. Dashboard

```bash
cd dashboard
cp .env.local.example .env.local
# Fill in all required vars (see table above)
npm install
npm run dev
```

Deploy to Vercel with **Root Directory** = `dashboard`. Set the same env vars in the Vercel project settings.

## 3. Signal bridge

Run [signal-cli](https://github.com/AsamK/signal-cli) with its REST API. Register a dedicated phone number for the bot identity. Set `SIGNAL_CLI_URL` to the bridge base URL and `SIGNAL_BOT_NUMBER` to that number.

For a minimal setup, run signal-cli locally or in a container on a VM. The production reference uses Cloud Run + GCS for the identity; self-hosters can start simpler.

## 4. Bot

```bash
cd bot
npm install
# Export required env vars, then:
npm run dev   # local test
```

**Deploy to Cloud Run** from `bot/`:

```bash
export PROJECT_ID=your-gcp-project
export REGION=us-central1
export FIREBASE_PROJECT_ID=...
export FIREBASE_CLIENT_EMAIL=...
export FIREBASE_PRIVATE_KEY=...
export SIGNAL_CLI_URL=https://your-bridge
export SIGNAL_BOT_NUMBER=+1...
export NOTIFY_RENDER_URL=https://your-app.vercel.app/api/notify/render
export INVITE_SHARED_SECRET=your-random-secret
./deploy.sh
```

Then set `COM_TOWER_WORKER_URL` on the dashboard to the Cloud Run service URL.

## 5. Firestore rules and indexes

Deploy `dashboard/firestore.rules` to your Firebase project. Ensure composite indexes exist for queries in `dashboard/src/app/api/game/[id]/activity/route.ts` and admin/captcha routes (Firebase Console will prompt with create links on first failure).

## Verify it works

1. Open your dashboard URL; confirm the homepage shows **your** bot number.
2. Create a Signal group (or DM) and add your bot number.
3. Send `/game https://awbw.amarriner.com/game.php?games_id=...` in that chat.
4. Send `/status` — should report the game is watching.
5. On a turn change, the group should receive a notification.

If `/status` shows no game, try `/stop` then `/game` again. If notifications fail, check bot logs for websocket/render/Signal errors.
