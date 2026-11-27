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
7. [ ] Give the bot's Signal account a username, and set `NEXT_PUBLIC_SIGNAL_USERNAME` (plus, optionally, `NEXT_PUBLIC_SIGNAL_USERNAME_LINK`) on the dashboard
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
| Dashboard UI | Bot contact | `NEXT_PUBLIC_SIGNAL_USERNAME` — the Signal username of the `SIGNAL_BOT_NUMBER` account |

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
| `NEXT_PUBLIC_SIGNAL_USERNAME` | yes | The bot's Signal username (e.g. `mytower.01`), shown on the homepage. Players reach the bot by username, so the phone number stays private |
| `NEXT_PUBLIC_SIGNAL_USERNAME_LINK` | optional | The username's `https://signal.me/#eu/...` link, copied from Signal; makes the homepage name a link |
| `COM_TOWER_WORKER_URL` | yes | Your Cloud Run bot URL |
| `INVITE_SHARED_SECRET` | yes | Random string; copy to bot env |
| `NEXT_PUBLIC_SITE_URL` | recommended | `https://your-app.vercel.app` (invite links) |

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
| `REEL_URL` | optional | A turn-video service (see [Turn videos](#turn-videos-optional)); unset: the usual image |
| `REEL_TOKEN` | optional | Bearer token sent to `REEL_URL` |
| `REEL_TIMEOUT_MS` | optional | How long a ping waits for its video (default `100000`) |

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

Run [signal-cli](https://github.com/AsamK/signal-cli) with its REST API. Register a dedicated phone number for the bot identity. Set `SIGNAL_CLI_URL` to the bridge base URL and `SIGNAL_BOT_NUMBER` to that number. Then give the account a Signal username (Signal requires a dot and at least two digits at the end, e.g. `mytower.01`): with signal-cli, `signal-cli -a +<number> updateAccount --username mytower.01`, or with signal-cli-rest-api, `POST /v1/accounts/<number>/username` with `{"username": "mytower.01"}`. Either prints the username and its `signal.me` link. Publish the username, not the number.

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

## Peachy

The same worker can serve [Peachy](https://pchy.app) group chats, as a Peachy bot: with
`MESSAGING_BACKEND=peachy-bot` it runs Peachy's bot SDK, `@peachysocial/bot`, in its own process,
and can share your Firebase project with a Signal worker. You create the bot in the Peachy app,
make a store key (`npx @peachysocial/bot keygen`), and link the store with the bot's one-time
Connect code. The bot's encrypted store must outlive the process, so it runs as one instance on
a VM with a disk, or on Cloud Run with a Postgres store; Cloud Run's own filesystem won't do.
[deploy/peachy/](deploy/peachy/README.md) has the steps and settings.

The older option, `peachy daemon` from [peachy-go](https://github.com/collinjackson/peachy-go)
(it answers signal-cli-rest-api's HTTP API, so the worker runs with `MESSAGING_PLATFORM=peachy` and
`SIGNAL_CLI_URL` pointed at it), is still described there too.

## Turn videos (optional)

The shared Com Tower posts a short video of the turn that just ended with each ping (the
"newscast"). It comes from a separate service that isn't part of this repo and only answers the
shared bot, so a self-hosted Com Tower sends its usual image instead. To get videos on your own,
point `REEL_URL` at any service that speaks this contract:

```
POST $REEL_URL
Authorization: Bearer $REEL_TOKEN
Content-Type: application/json

{
  "gameId": 1766972,            // the AWBW game
  "day": 8,                     // the current day, a hint for finding the turn
  "players": 5,                 // how many players, likewise
  "recent": ["..."],            // caption lines this game has already shown (avoid repeating them)
  "language": "Japanese",       // the player to move's /language
  "languages": {"alice": "Yoda"},  // every player's /language that isn't English (AWBW names)
  "toMove": "bob",              // the player to move
  "fresh": true                 // record again even if cached (the /reel command)
}
```

Every field but `gameId` may be missing. The video is of the **last finished turn**, which the
service finds itself (AWBW's replay data). Answer `200` with:

```
{"gif": "<base64>", "contentType": "image/gif", "filename": "day8-bob.gif", "captions": ["..."]}
```

`captions` (the lines the video shows) are remembered and sent back as `recent` next time.
An answer without `gif` (say `{"error": "no finished turn found"}` on day 1) means there was
nothing to record: the ping goes out with no image. A non-2xx answer, an exception or a timeout
(`REEL_TIMEOUT_MS`) is a failure: the ping says the newscast got lost and links the game.
A square GIF of a few seconds, under a few MB, previews best in chats. Fetch from AWBW gently:
one game's turn at a time, each replay once.

**Recaps (optional).** `/recap`, and the end of a watched game, ask the same service's `/recap`
(beside `REEL_URL`: `https://host/reel` -> `https://host/recap`) for the game in its biggest moments:

```
POST /recap   {"gameId": 1766972, "languages": {...}, "result": "Red wins", "over": true, "fresh": true}
-> 200 {"video": "<base64 MP4>", "contentType": "video/mp4", "filename": "recap-1766972.mp4"}
```

`result` (how the game ended) and `over` (the game is finished) come at the end of a game; `fresh`
from `/recap fresh`. Com Tower waits up to 14 minutes. No `video` means nothing to recap yet; a
service without `/recap` just means no recaps.

[libaw](https://github.com/collinjackson/libaw) has the pieces for a basic service: an AWBW
replay checker that turns a turn into a storyboard, and a browser replay player with a camera that
follows the action and ghost input, which its `web/capture.mjs` records to a GIF.

## Verify it works

1. Open your dashboard URL; confirm the homepage shows **your** bot number.
2. Create a Signal group (or DM) and add your bot number.
3. Send `/game https://awbw.amarriner.com/game.php?games_id=...` in that chat.
4. Send `/status` — should report the game is watching.
5. On a turn change, the group should receive a notification.

If `/status` shows no game, try `/stop` then `/game` again. If notifications fail, check bot logs for websocket/render/Signal errors.
