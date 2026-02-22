# Com Tower

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)

<img width="1195" height="751" alt="Screenshot 2026-02-22 at 2 16 07 PM" src="https://github.com/user-attachments/assets/a53506d7-636f-4015-830f-663c2a8d94cc" />

**Turn notifications for [Advance Wars By Web](https://awbw.amarriner.com)** — get Signal alerts when it’s your turn.

**Live app:** [com-tower.vercel.app](https://com-tower.vercel.app)

---

## What it does

- **Patch a game** — Sign in with Google, paste an AWBW game link, and add your game. Com Tower watches the game and notifies you when it’s your turn.
- **Choose how you’re notified** — Signal DM or group, “all turns” or “only my turn,” once per turn or hourly reminders.
- **Invite others** — Share an invite link so friends can subscribe without signing in (they pick their number and settings on the invite page).
- **Activity feed** — See sent notifications, CAPTCHA issues, and subscriber changes. Solve Signal CAPTCHAs from the game page when needed.

The **web app** (Next.js on Vercel) handles auth, patches, and rendering notification text. The **worker** (Cloud Run) keeps AWBW websocket connections, triggers on turn change, calls the web app for message content, and sends via a **Signal bridge** (signal-cli).

---

## Project structure

| Directory       | Purpose |
|----------------|--------|
| `web/`         | Next.js app: UI, Firebase auth, API routes (game lookup, patches, notify/render, invite, admin). Deploy to Vercel. |
| `worker/`      | Cloud Run service: Firestore listeners, AWBW websockets, send via Signal bridge, log to `messages`. |
| `signal-bridge/` | Cloud Run service: runs signal-cli REST API with a mounted Signal identity (e.g. GCS bucket). Called by worker. |

**Data (Firestore):** `games`, `patches`, `users`, `messages`, `patchActivity`, `captchaChallenges`.

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
- Create a **service account** with Firestore access; download the JSON or use the private key, client email, and project ID for the worker and web server-side APIs.

### 2. Web app (`web/`)

```bash
cd web
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
  `COM_TOWER_WORKER_URL` (your worker URL),  
  `INVITE_SHARED_SECRET` (shared secret for worker ↔ web invite/captcha calls)

Deploy to Vercel and set the same env vars in the dashboard.

### 3. Worker (`worker/`)

The worker needs Firestore (admin), the URL of your web app’s notify/render endpoint, and the Signal bridge.

**Required env (or Secret Manager equivalents, see below):**

- `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`
- `SIGNAL_CLI_URL` — base URL of your signal-cli REST API (e.g. the Signal bridge)
- `SIGNAL_BOT_NUMBER` — Signal number used by the bridge
- `NOTIFY_RENDER_URL` — e.g. `https://your-app.vercel.app/api/notify/render`

**Optional:** `RENDER_BYPASS_TOKEN`, `AWBW_WS_BASE`, `OPENAI_API_KEY`, etc.

**Local run:**

```bash
cd worker
npm install
# Set env vars, then:
npm run dev
```

**Deploy to Cloud Run:** use `worker/deploy.sh`. It supports plain env or GCP Secret Manager (e.g. `SECRET_FIREBASE_PRIVATE_KEY=your-secret-name`). See the comments at the top of `deploy.sh` for the full list.

### 4. Signal bridge

You need a running signal-cli REST API that the worker can call. The reference setup runs it on Cloud Run with the Signal identity in a GCS bucket; the worker calls it with IAM (Invoker). For a minimal self-host, run signal-cli locally or in a container and set `SIGNAL_CLI_URL` (and optionally protect it with a shared secret if you add that to the worker).

### 5. Firestore rules and indexes

Deploy rules and indexes for your Firebase project (see Firebase console or `firebase deploy` if you have a config). Ensure indexes exist for the queries used in `web/src/app/api/game/[id]/activity/route.ts` and any admin/captcha routes (e.g. `gameId` + `createdAt`, `status`, etc.).

---

## Contributor guide

### Setup

1. Fork and clone the repo.
2. Set up Firebase and `.env.local` for `web/` as above (you can use a dev project).
3. `cd web && npm install && npm run dev` — the app runs at http://localhost:3000. You can use the UI without a worker (patch UI, invite links, activity feed will load if Firestore is populated).
4. To test the worker locally, run it with env pointing at your Firestore and a Signal bridge (or a stub).

### Codebase overview

- **Web:** Next.js App Router. Main UI is `web/src/app/page.tsx`; API routes live under `web/src/app/api/`. Firebase client config in `web/src/lib/firebase.ts`, admin in `web/src/lib/firebase-admin.ts`.
- **Worker:** Single entry `worker/src/index.ts` — Firestore listeners, AWBW websocket per game, render call to web, Signal send, message logging. Deploy script and env in `worker/deploy.sh`.

### Making changes

- **Web:** Follow existing patterns (React hooks, Tailwind, existing API shapes). Run `npm run lint` in `web/`.
- **Worker:** TypeScript; ensure env and error handling stay consistent with the current style.
- **API contracts:** If you change request/response shapes for `/api/notify/render`, `/api/game/...`, or invite/captcha routes, update the worker or any callers that depend on them.

### Submitting changes

1. Open an issue or discussion first if you’re planning a larger change.
2. Branch from `main`, make focused commits, and open a PR with a short description of what and why.
3. Ensure the app still builds and that you haven’t broken the flow (patch → worker → Signal → messages).

---

## Flow (reference)

1. User adds a game in the web app and adds subscribers (or shares an invite link). Patches and subscribers are stored in Firestore (`patches`, `users`).
2. Worker listens to `patches`, opens an AWBW websocket per game, and on `NextTurn` fetches notification text from the web app (`NOTIFY_RENDER_URL`).
3. Worker sends messages via the Signal bridge and writes results to Firestore `messages`.
4. The web app shows an activity feed from `messages` and patch activity; users can resolve CAPTCHAs from the game page when needed.

---

## License

Com Tower is licensed under the [GNU Affero General Public License v3.0](LICENSE). See [LICENSE](LICENSE) for the full text.
