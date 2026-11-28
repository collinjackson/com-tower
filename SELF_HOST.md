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
9. [ ] Optional: a [Discord](#discord) or [Slack](#slack) worker beside it (same Firebase)

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
| `POSTHOG_KEY` | optional | Your PostHog project key: usage counts go to your PostHog (README "Analytics"). Unset: none are sent |
| `POSTHOG_HOST` | optional | PostHog's ingest host (default `https://us.i.posthog.com`; EU: `https://eu.i.posthog.com`) |
| `ANALYTICS_SALT` | optional | Salt for the hashed group ids (default: the key) |
| `MESSAGING_BACKEND` | optional | `signal-cli-rest` (default), `peachy-bot`, `discord` or `slack`. With no `SIGNAL_CLI_URL`, `DISCORD_TOKEN` or `SLACK_BOT_TOKEN` alone picks Discord or Slack |
| `DISCORD_TOKEN` | Discord | The bot's token (a secret) |
| `DISCORD_APP_ID` | Discord | The application id |
| `DISCORD_GUILD_ID` | optional | Register the slash commands in this one server only (they show at once; for testing). Unset: everywhere, which can take a little while the first time |
| `DISCORD_REGISTER_COMMANDS` | optional | `0` to not register the slash commands at start |
| `DISCORD_MAX_UPLOAD_BYTES` | optional | Largest video to upload (default 10 MiB, Discord's limit without server boosts); a bigger one is left off with a note |
| `SLACK_BOT_TOKEN` | Slack | The Bot User OAuth Token, `xoxb-…` (a secret) |
| `SLACK_APP_TOKEN` | Slack | An app-level token, `xapp-…`, with `connections:write` (Socket Mode; a secret). Without it turn pings still go out, but no commands come in |
| `SLACK_COMMAND` | optional | The slash command's name (default `/comtower`; match the app's manifest) |

A Discord or Slack worker needs no `SIGNAL_*` variables. Leave `SLACK_SIGNING_SECRET` unset: Socket
Mode doesn't use it.

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

## Discord

A Discord worker is the same `bot/` with `MESSAGING_BACKEND=discord`, as its own service beside a
Signal worker on the same Firebase project (each group game records its platform; a worker watches
only its own). It connects to Discord's Gateway with discord.js, so it needs no public URL, and it
reads only slash commands: no privileged intents, no message content.

**Why the Gateway and not HTTP interactions:** the worker is already a long-running process (one
instance at least) that holds AWBW websockets, and one replica runs the receiver. A Gateway
connection fits that as it is: nothing to expose or signature-check on Cloud Run, and it works on
a home server behind NAT. Sends (turn pings, from whichever replica owns the game) go over Discord's
REST API.

1. **Create the application.** [discord.com/developers/applications](https://discord.com/developers/applications)
   → **New Application**, name it (e.g. "Com Tower").
2. **General Information:** copy the **Application ID** → `DISCORD_APP_ID`. Leave **Interactions
   Endpoint URL** empty (if set, Discord sends commands there instead of over the Gateway).
3. **Bot:** **Reset Token** and copy it → `DISCORD_TOKEN` (a secret; put it in Secret Manager).
   Leave all three **Privileged Gateway Intents** off. Turn **Public Bot** off if only you should
   invite it.
4. **Installation:** **Installation Contexts**: **Guild Install** only. **Install Link**: Discord
   Provided Link, with scopes `bot` and `applications.commands`, and these bot permissions, which are
   all it needs:
   - View Channels
   - Send Messages
   - Send Messages in Threads
   - Attach Files

   That's permissions integer `274877942784`, so the invite URL is
   `https://discord.com/oauth2/authorize?client_id=<DISCORD_APP_ID>&scope=bot+applications.commands&permissions=274877942784`.
5. **Deploy the worker** (from `bot/`, a separate Cloud Run service; CPU always on, since the
   Gateway is a background connection):
   ```bash
   SERVICE_NAME=com-tower-discord MESSAGING_BACKEND=discord \
     SECRET_DISCORD_TOKEN=discord-token DISCORD_APP_ID=<id> \
     SECRET_FIREBASE_PROJECT_ID=... SECRET_FIREBASE_CLIENT_EMAIL=... SECRET_FIREBASE_PRIVATE_KEY=... \
     ./deploy.sh --no-cpu-throttling
   ```
   Keep `SCALING_MODE` at its default (`singleton`) or `leader`: one replica runs the Gateway. At
   start it registers the slash commands (all of Com Tower's; `DISCORD_GUILD_ID` puts them in one
   server only, at once, for testing).
6. **Use it:** open the invite URL, pick a server, then in a channel: `/game link:<AWBW link>`, and
   each player `/iam awbw_name:<name>`. Turn pings mention the player's Discord account. If the bot
   can't post in that channel, `/game` says which permissions to give it.

Turn videos go up as files when they fit `DISCORD_MAX_UPLOAD_BYTES`; a bigger one is left off and
the ping says so (the game link is still there). Commands answer through the slash command itself
(Discord's "thinking…", then the answer); turn pings and late answers (a recap, minutes later) are
ordinary channel messages. `/stats` and `/turntime` also work in a DM with the bot, with a `game`
field.

## Slack

A Slack worker is the same `bot/` with `MESSAGING_BACKEND=slack`, as its own service. It uses Bolt
in **Socket Mode**: the worker connects out to Slack, so there's no request URL to expose. Slack
slash-command names are workspace-wide, so Com Tower has one, `/comtower`, and every command follows
it: `/comtower game <link>`. Mentioning the app works too: `@Com Tower iam <name>`.

1. **Create the app from the manifest.** [api.slack.com/apps](https://api.slack.com/apps) →
   **Create New App** → **From a manifest** → pick the workspace → paste
   [`deploy/slack/manifest.yml`](deploy/slack/manifest.yml) → **Create**. It sets the bot user, the
   `/comtower` command (with "escape users" on, so `@mentions` reach the bot as ids), the
   `app_mention` event, Socket Mode, and these bot scopes, which are all it needs:
   `commands`, `app_mentions:read`, `chat:write`, `files:write`, `channels:read`, `groups:read`,
   `channels:join`, `im:write`.
2. **App-level token:** **Basic Information** → **App-Level Tokens** → **Generate Token and
   Scopes**, scope `connections:write` → copy the `xapp-…` token → `SLACK_APP_TOKEN` (a secret).
3. **Install:** **Install App** → **Install to Workspace** → allow → copy the **Bot User OAuth
   Token** (`xoxb-…`) → `SLACK_BOT_TOKEN` (a secret).
4. **Deploy the worker** (from `bot/`, a separate Cloud Run service, CPU always on):
   ```bash
   SERVICE_NAME=com-tower-slack MESSAGING_BACKEND=slack \
     SECRET_SLACK_BOT_TOKEN=slack-bot-token SECRET_SLACK_APP_TOKEN=slack-app-token \
     SECRET_FIREBASE_PROJECT_ID=... SECRET_FIREBASE_CLIENT_EMAIL=... SECRET_FIREBASE_PRIVATE_KEY=... \
     ./deploy.sh --no-cpu-throttling
   ```
   One replica runs the Socket Mode connection (`SCALING_MODE` `singleton` or `leader`).
5. **Use it:** in a channel, `/comtower game <AWBW link>`; each player `/comtower iam <name>`. In a
   public channel the app joins by itself; in a private one, `/invite @Com Tower` first (until then
   `/game` answers but warns that turn pings can't post). Turn pings mention the player's Slack
   account, with the turn video uploaded beside them.

One app is one workspace (its bot token). For several workspaces, make an app in each and a worker
for each, or add Slack's OAuth install flow (not built yet).

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
