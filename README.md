# Com Tower

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)

<img height="250" alt="Preview" src="https://github.com/user-attachments/assets/3e17d888-b04d-4fb3-a762-1171fbb8b9a7" align="right" />


**Turn notifications for [Advance Wars By Web](https://awbw.amarriner.com)** — get Signal alerts when it’s your turn.

**Live app:** [com-tower.vercel.app](https://com-tower.vercel.app)

---

## Get started

Com Tower is a Signal bot. Add it to your AWBW game’s group chat (or DM it one-on-one), bind your game, and it posts when turns change.

1. **Add Com Tower** to your game’s Signal group — the bot number is on the [homepage](https://com-tower.vercel.app). A DM works too.
2. **Bind the game** — in that chat, run `/game <AWBW link>`. Whoever runs it first becomes the **mod**.
3. **Turn on notifications** for the group in Signal (or run `/iam <your_awbw_name>` for a personal @ping on your turn).
4. **Play** — Com Tower watches the game and posts each turn. Fun mode is on by default: in-character radio calls with a holographic unit sprite.

Send `/help` in the group for the full command list.

### Commands

| Command | Who | What |
|---------|-----|------|
| `/game <link>` | mod | Watch an AWBW game |
| `/iam <awbw_name>` | anyone | Get an @ping on your turn |
| `/setplayer @x <name>` | mod | Map a member to an AWBW player |
| `/players` | anyone | Show the roster |
| `/fun [on\|off]` | mod | Toggle flavor-text notifications |
| `/language <lang>` | anyone | Turn pings in another language (after `/iam`) |
| `/status` | anyone | Current watch state |
| `/sync` | anyone | Check AWBW now; post if a turn was missed |
| `/stop` | mod | Stop watching |
| `/ping` | anyone | Connectivity check |

**Mods** can change the game, stop watching, toggle fun mode, and manage player mappings. The first person to run `/game` in a group is the mod; mods can add others with `/addmod @x`.

**Fun mode** (on by default) turns each notification into a short in-character radio message from one of your units, with a hologram image. Turn it off with `/fun off` if you prefer plain text.

**Stuck?** Run `/status` to see whether the bot is watching your game. If turns aren’t coming through, try `/sync` once, or `/stop` then `/game` again to re-bind.

---

## Host your own Com Tower

The hosted app at [com-tower.vercel.app](https://com-tower.vercel.app) is a **shared instance** — one Signal number, one worker, one database. That’s great for trying Com Tower or running a single game, but every group routes through the same bot.

**Self-hosting** gives you your own stack:

- **Your own Signal number** — your games don’t add load to the shared bot
- **Your own data** — isolated Firebase project, your players and games only
- **Same experience** — players still add the bot to a group and run `/game`; all the same commands
- **Fork-friendly** — Com Tower is AGPL; fork the repo, set env vars, deploy

Good fit if you run a league, juggle many concurrent games, or want full control over uptime and configuration.

**→ [SELF_HOST.md](SELF_HOST.md)** — step-by-step deploy guide (Firebase, Vercel, Cloud Run, Signal bridge). Point an AI assistant at that file if you want help wiring it up.

---

## Architecture

Com Tower is **primarily a bot**. Two deployables:

- **`bot/`** — the core service (Cloud Run). Holds long-lived AWBW websocket connections, triggers on turn change, asks the dashboard for notification text/art, and sends via a **Signal bridge** (signal-cli). Handles in-Signal `/game`, `/iam`, `/fun`, `/status`, etc.
- **`dashboard/`** — companion web app (Next.js on Vercel). Google auth, patch management, invite/CAPTCHA flow, activity feed, and `/api/notify/render` (message text + hologram image).

| Directory     | Purpose |
|---------------|---------|
| `bot/`        | Cloud Run: Firestore listeners, AWBW websockets, render calls, Signal send, group commands. |
| `dashboard/`  | Next.js (Vercel): UI, Firebase auth, API routes, notify renderer. |
| `scripts/`    | Operator helpers (Signal group-id lookup, etc.). |

The **Signal bridge** (signal-cli REST) is separate infrastructure — the bot reaches it via `SIGNAL_CLI_URL`.

**Data (Firestore):** `groupGames`, `patches`, `users`, `messages`, `patchActivity`, `captchaChallenges`.

**Flow:** User binds a game in Signal (`/game`) → bot opens an AWBW websocket → on turn change, bot calls dashboard `NOTIFY_RENDER_URL` → bot sends via Signal bridge → activity logged to Firestore.

---

## Contributor guide

### Setup

1. Fork and clone the repo.
2. Follow [SELF_HOST.md](SELF_HOST.md) with a dev Firebase project (dashboard + bot env vars).
3. `cd dashboard && npm install && npm run dev` — runs at http://localhost:3000. UI works without a running bot if Firestore is populated.
4. To test the bot locally, run it with env pointing at your Firestore and a Signal bridge.

### Codebase overview

- **Dashboard:** Next.js App Router. Main UI is `dashboard/src/app/page.tsx`; API routes under `dashboard/src/app/api/`. Firebase client in `dashboard/src/lib/firebase.ts`, admin in `dashboard/src/lib/firebase-admin.ts`. Fun-mode renderer: `dashboard/src/app/api/notify/render/route.ts`.
- **Bot:** Single entry `bot/src/index.ts` — Firestore listeners, AWBW websocket per game, render call, Signal send, group commands.

### Making changes

- **Dashboard:** Follow existing patterns (React hooks, Tailwind). Run `npm run lint` in `dashboard/`.
- **Bot:** TypeScript; keep env and error handling consistent with current style.
- **API contracts:** If you change `/api/notify/render`, `/api/game/...`, or invite/captcha routes, update the bot and callers.

### Submitting changes

1. Open an issue or discussion first for larger changes.
2. Branch from `main`, focused commits, PR with what and why.
3. Ensure the app still builds and patch → bot → Signal → messages flow works.

---

## License

Com Tower is licensed under the [GNU Affero General Public License v3.0](LICENSE). See [LICENSE](LICENSE) for the full text.
