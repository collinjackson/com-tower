# Com Tower

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)

<img height="250" alt="Preview" src="https://github.com/user-attachments/assets/3e17d888-b04d-4fb3-a762-1171fbb8b9a7" align="right" />


**Turn notifications for [Advance Wars By Web](https://awbw.amarriner.com)** — get Signal alerts when it’s your turn.

**Live app:** [com-tower.vercel.app](https://com-tower.vercel.app)

---

## What it does

- **Invite others** — Create a Signal group and invite the bot along with the other players.
- **Patch a game** — Use slash commands to add your game. Com Tower watches the game and notifies the channel when it’s your turn.
- **Fun mode** — Optional flavor: each turn ping comes as an in-character radio call from one of the player’s real units, with a holographic unit or CO sprite in the army’s color. On by default for new games.

---

## Architecture

Com Tower is **primarily a bot**. Two deployables:

- **`bot/`** — the core service (Cloud Run). Holds long-lived AWBW websocket connections, triggers on turn change, asks the dashboard for the notification text/art, and sends it via a **Signal bridge** (signal-cli). Also handles the in-Signal `/game`, `/iam`, `/fun`, `/status` etc. group commands.
- **`dashboard/`** — the companion web app (Next.js on Vercel). Google auth, patch management, the invite/CAPTCHA flow, the activity feed, and the `/api/notify/render` endpoint the bot calls to generate message text and the hologram unit image.

| Directory     | Purpose |
|---------------|---------|
| `bot/`        | Cloud Run service: Firestore listeners, AWBW websockets, render calls, Signal send, message logging, group commands. Deployed manually with `gcloud`. |
| `dashboard/`  | Next.js app (Vercel): UI, Firebase auth, API routes (game lookup, patches, `notify/render`, invite, admin). Auto-deploys from `main`. |
| `scripts/`    | Operator helper scripts (Signal group-id lookup, etc.). |

The **Signal bridge** (signal-cli REST) is separate infrastructure, not a folder in this repo — the bot reaches it over a private network via `SIGNAL_CLI_URL`.

**Data (Firestore):** `groupGames`, `patches`, `users`, `messages`, `patchActivity`, `captchaChallenges`.

---

## Running your own instance

### Prerequisites

- **Node.js** 18+
- **Firebase** project (Auth + Firestore)
- **Signal** number/identity for the bridge (e.g. [signal-cli](https://github.com/AsamK/signal-cli))
- (Optional) **OpenAI API key** for “fun mode” notification captions

### 1. Firebase

- Create a project and enable **Authentication** (Google sign-in) and **Firestore**.
- Create a **web app** in Firebase and copy the client config (apiKey, authDomain, projectId, etc.).
- Create a **service account** with Firestore access; use the private key, client email, and project ID for the bot and dashboard server-side APIs.

### 2. Dashboard (`dashboard/`)

```bash
cd dashboard
cp .env.local.example .env.local
# Edit .env.local and fill in your Firebase and optional vars
npm install
npm run dev
```

**`.env.local` (and Vercel env vars):**

- **Client (required for auth):**
  `NEXT_PUBLIC_FIREBASE_API_KEY`, `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`, `NEXT_PUBLIC_FIREBASE_PROJECT_ID`, `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`, `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID`, `NEXT_PUBLIC_FIREBASE_APP_ID`
- **Server (for API routes that use Firestore/admin):**
  `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`
- **Optional:**
  `OPENAI_API_KEY` (fun-mode captions in `/api/notify/render`),
  `NEXT_PUBLIC_SITE_URL` (e.g. `https://your-app.vercel.app` for invite links),
  `COM_TOWER_WORKER_URL` (your bot URL),
  `INVITE_SHARED_SECRET` (shared secret for bot ↔ dashboard invite/captcha calls)

Deploy to Vercel (Root Directory = `dashboard`) and set the same env vars in the dashboard.

### 3. Bot (`bot/`)

The bot needs Firestore (admin), the URL of the dashboard’s notify/render endpoint, and the Signal bridge.

**Required env (or Secret Manager equivalents):**

- `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`
- `SIGNAL_CLI_URL` — base URL of your signal-cli REST API (the Signal bridge)
- `SIGNAL_BOT_NUMBER` — Signal number used by the bridge
- `NOTIFY_RENDER_URL` — e.g. `https://your-app.vercel.app/api/notify/render`

**Optional:** `RENDER_BYPASS_TOKEN`, `AWBW_WS_BASE`, `OPENAI_API_KEY`, `JOIN_SHIM_URL`/`JOIN_SHIM_SECRET`, etc.

**Local run:**

```bash
cd bot
npm install
# Set env vars, then:
npm run dev
```

**Deploy to Cloud Run:** the bot is a Cloud Run service (`com-tower-worker`). Deploy with `gcloud run deploy com-tower-worker --source=. --region=us-central1` from `bot/` — a bare source deploy preserves the existing env/secrets/VPC config and just rebuilds. `bot/deploy.sh` documents the full env/Secret-Manager mapping for a first-time deploy.

### 4. Signal bridge

You need a running signal-cli REST API the bot can call. The reference setup runs it on Cloud Run / a VM with the Signal identity in a GCS bucket; the bot calls it over a private network. For a minimal self-host, run signal-cli locally or in a container and set `SIGNAL_CLI_URL`.

### 5. Firestore rules and indexes

Deploy rules and indexes for your Firebase project (see `dashboard/firestore.rules`). Ensure indexes exist for the queries used in `dashboard/src/app/api/game/[id]/activity/route.ts` and the admin/captcha routes.

---

## Contributor guide

### Setup

1. Fork and clone the repo.
2. Set up Firebase and `.env.local` for `dashboard/` as above (a dev project is fine).
3. `cd dashboard && npm install && npm run dev` — the app runs at http://localhost:3000. You can use the UI without a running bot (patch UI, invite links, activity feed load if Firestore is populated).
4. To test the bot locally, run it with env pointing at your Firestore and a Signal bridge (or a stub).

### Codebase overview

- **Dashboard:** Next.js App Router. Main UI is `dashboard/src/app/page.tsx`; API routes live under `dashboard/src/app/api/`. Firebase client config in `dashboard/src/lib/firebase.ts`, admin in `dashboard/src/lib/firebase-admin.ts`. The fun-mode caption + hologram renderer is `dashboard/src/app/api/notify/render/route.ts` (`dashboard/scripts/holo-proto.mjs` is a standalone preview harness for the hologram look).
- **Bot:** Single entry `bot/src/index.ts` — Firestore listeners, AWBW websocket per game, render call to the dashboard, Signal send, message logging, and the in-Signal group commands.

### Making changes

- **Dashboard:** Follow existing patterns (React hooks, Tailwind, existing API shapes). Run `npm run lint` in `dashboard/`.
- **Bot:** TypeScript; keep env and error handling consistent with the current style.
- **API contracts:** If you change request/response shapes for `/api/notify/render`, `/api/game/...`, or invite/captcha routes, update the bot or any callers that depend on them.

### Submitting changes

1. Open an issue or discussion first if you’re planning a larger change.
2. Branch from `main`, make focused commits, and open a PR with a short description of what and why.
3. Ensure the app still builds and that you haven’t broken the flow (patch → bot → Signal → messages).

---

## Flow (reference)

1. A user adds a game and subscribers in the dashboard (or shares an invite link). Patches and subscribers are stored in Firestore.
2. The bot listens to Firestore, opens an AWBW websocket per game, and on a turn change fetches notification text/art from the dashboard (`NOTIFY_RENDER_URL`).
3. The bot sends messages via the Signal bridge and writes results to Firestore `messages`.
4. The dashboard shows an activity feed from `messages` and patch activity; users resolve CAPTCHAs from the game page when needed.

---

## License

Com Tower is licensed under the [GNU Affero General Public License v3.0](LICENSE). See [LICENSE](LICENSE) for the full text.
