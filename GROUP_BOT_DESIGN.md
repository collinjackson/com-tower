# Com Tower — Group-Bot Redesign

Status: proposal / drawing-board. Supersedes the web-auth + phone-entry + invite flow
described in `README.md`.

## Why redesign

The current live design has two structural problems:

1. **People must type their phone number** (web invite page) before they can be notified.
2. **Signal CAPTCHA challenges** intermittently block the bot, and we can't solve them.

Both are consequences of the same root cause: the bot is an **outbound** sender. It
initiates contact with phone numbers it has no prior session with, which (a) forces us to
collect numbers and (b) is exactly the behavior Signal's rate-limiter throws CAPTCHA
proof-of-work challenges at.

## The new model in one sentence

The bot lives **inside the game's group chat**, learns everything from messages it
receives there, and only ever **replies into groups it already belongs to** — so it never
types a phone number and almost never trips a CAPTCHA.

## Ideal flow

1. Game creator creates a Signal group for the game and **adds the bot**.
2. Creator runs `/game <awbw url|id>` to bind the group to a game.
3. Players map themselves with `/iam <awbw_username>` (or the creator assigns with
   `/setplayer @member <awbw_username>`).
4. When it's someone's turn, the bot posts in the group and **@-mentions the player whose
   turn it is**. No DMs, no phone numbers, no web app.

## Why this kills both problems

- **No phone numbers.** Signal identity comes from the message envelope (`sourceUuid` /
  ACI) and from @-mentions (which carry the mentioned member's ACI). We map
  `awbw_username → Signal ACI`. The only thing anyone types is the AWBW username they
  already know.
- **Near-zero CAPTCHA.** The bot only sends *into a group it's a member of*, reacting to
  inbound traffic. It establishes sessions passively and never cold-contacts strangers,
  which is what drives the rate-limit challenges. (Not literally impossible — see CAPTCHA
  fallback below — but rare enough to handle in-band.)

## Identity: key on ACI, not phone number

**This is the linchpin and the #1 thing to verify before building.** Modern Signal lets
users hide their phone number, so `envelope.sourceNumber` and mention `number` can be
absent. The design keys every player on their **ACI/UUID**:

- **Receive:** `envelope.sourceUuid` is the sender; `dataMessage.mentions[].uuid` are the
  mentioned members. (signal-cli's receive payload includes these.)
- **Send mentions:** `/v2/send` must mention by `uuid`, not `number`. The current
  `sendSignal()` builds mentions keyed on `number` (worker/src/index.ts ~L781-815) — this
  must change, or phone-privacy players can't be pinged.

> **Spike before implementing:** confirm our signal-cli-rest-api version returns
> `sourceUuid` + mention `uuid` on `/v1/receive`, and accepts `mentions: [{uuid, start,
> length}]` on `/v2/send`. Everything below assumes yes; if the bridge is number-only we
> revisit.

The bot itself still needs a one-time phone number to register/link with Signal — that's
the operator's setup, unavoidable, and unrelated to players.

## Data model (Firestore — kept; web UI retired)

Replace the `patches` / `users` / `subscribers[]` / `playerPhoneMap` machinery with one
collection keyed by the Signal group.

```
collection: groupGames
  doc id: <signal groupId>          // the internal/base64 group id
  {
    groupId,
    gameId,                          // active AWBW game (one per group)
    gameName,
    status: 'active' | 'stopped' | 'ended',
    createdBy:  { aci, number? },    // first activator
    admins:     [aci, ...],          // may run /game, /setplayer, /stop
    players: {
      "<awbwUsername>": {
        aci,                         // Signal ACI — the join key
        number?,                     // display only, may be absent
        displayName?,                // Signal profile name at claim time
        country?,                    // AWBW country, scraped
        claimedBy: 'self' | 'admin',
        claimedAt,
      },
      ...
    },
    funEnabled: boolean,
    scope: 'mine' | 'all',           // ping only the current player, or everyone
    lastTurn: { day?, awbwUsername?, at },   // dedupe / status
    createdAt, updatedAt,
  }
```

Retired: `patches`, `users`, `invite*`, `captchaChallenges` web flows. `gamePlayers` stays
useful (player/country scrape cache).

## Commands (all run inside the group)

| Command | Who | Effect |
|---|---|---|
| `/game <url\|id>` | admin | Bind this group to an AWBW game. Scrapes roster, replies with players + which are unmapped. First caller becomes admin. |
| `/iam <awbw_username>` | anyone | Caller self-claims a player slot. Bot stores `sourceUuid -> username`. |
| `/setplayer @member <username>` | admin | Assign/override a mapping using the mention's ACI. |
| `/unsetplayer @member` | admin | Remove a mapping. |
| `/players` (`/who`) | anyone | Show current `awbw <-> signal` mapping; flag unmapped slots. |
| `/scope mine\|all` | admin | Ping only the player whose turn it is (default) or the whole group. |
| `/fun [on\|off]` | admin | Toggle fun-mode captions. |
| `/status` | anyone | Active game, last turn seen, watch state. |
| `/stop` | admin | Stop watching; closes the socket. |
| `/help` | anyone | Command list. |
| `/captcha <signalcaptcha://...>` | admin | (Fallback) submit a CAPTCHA token if the bot ever gets challenged. |

Nice-to-have onboarding touches:
- On being added to a group → post a one-line welcome + `/game` hint.
- When an **unmapped** player's turn comes up → bot posts "Whoever is *X*, send `/iam X` to
  get pinged" instead of a silent mention.

## Worker changes

The socket/turn-detection core (`startSocket`, AWBW websocket, `scrapeCurrentPlayerName`,
`loadPlayers`, game-ended checks) is **kept**. What changes:

- **Driver:** `onSnapshot` listens to `groupGames` (status `active`) instead of `patches`.
  One socket per active game.
- **On NextTurn:** resolve current AWBW player → `players[username].aci` → send one group
  message mentioning that ACI (or the whole group if `scope: 'all'`). Delete the entire
  `Subscriber` / `shouldNotify` / `notifyFrequency` / `playerPhoneMap` / hourly-reminder /
  `MIN_NOTIFICATION_GAP` apparatus — turn-change is the only trigger now.
- **Command handling:** extend the existing `handleSignalCommand` / `pollSignalMessages`
  loop (already present, worker/src/index.ts ~L955-1129) with the table above; route by
  `groupId`, gate admin commands on `admins[]`.
- **Mentions:** rewrite to key on `uuid` (see Identity section).

## CAPTCHA fallback (rare path)

If a group send returns a rate-limit challenge:
1. Catch it, store the challenge token, mark the group `status: 'captcha'`.
2. Post in the group: "Signal needs a quick CAPTCHA — an admin can solve at `<signal url>`
   and reply `/captcha <token>`."
3. `/captcha` reuses the existing `rate-limit-challenge` submit logic (worker
   ~L1267-1273), then resumes.

This keeps the human-solve path but moves it from the web page into the chat.

## Open questions / risks

1. **Bridge ACI support** (spike above) — blocks everything if number-only.
2. **`/v1/receive` reliability** — the bot is now command-driven, so a flaky receive poll
   degrades UX more than before. The existing code already no-ops on 404; consider
   JSON-RPC receive mode for lower latency.
3. **One bot, many groups** — receive returns all groups' traffic; route strictly by
   `groupId` (already the case). Watch send fan-out if the bot joins many games.
4. **Admin model** — proposed: first `/game` caller is admin; add `/addadmin` later if a
   game needs co-admins. Friendly games may not need strict gating.
5. **Migration** — existing `patches`/invite data is abandoned, not migrated; one-time
   cleanup. No user-facing migration since the old flow required re-onboarding anyway.

## Web app → static "Field Orders" memo

The web app stops being an interactive control panel and becomes a single static page: a
**military orders memo** explaining how to enlist the bot and the command roster. It needs
no auth, no Firebase, no client state.

What's kept exactly as-is:
- `layout.tsx` + `components/BackgroundCanvas.tsx` — the animated night-battle background
  (parallax terrain, dogfighting planes, infantry, the CRT console). It already mounts as a
  fixed full-screen layer behind `children`, independent of page content, so it survives
  untouched. (The console's terminal screens even scroll `> AWBW POLL / > TURN 4` — on theme.)
- The frosted-glass card styling from the current page
  (`backdrop-blur-xl bg-white/10 rounded-3xl border border-white/10 shadow-2xl`) — reused
  for the memo panel so it reads as a briefing pinned over the battlefield.

What changes:
- `page.tsx` drops the entire `ComTowerApp` client component (Firebase auth, patches,
  invites, subscribers, CAPTCHA) and renders a static, server-rendered memo.

Memo content (sketch):

```
┌─────────────────────────────────────────────┐
│  COM TOWER — FIELD ORDERS            CLASSIFIED│
│  RE: AWBW TURN NOTIFICATIONS VIA SIGNAL        │
├─────────────────────────────────────────────┤
│  TO DEPLOY THE BOT                             │
│   1. Create a Signal group for your game.      │
│   2. Add the Com Tower bot to the group.       │
│      (link / number / QR here)                 │
│   3. Run  /game <awbw link>  to bind the game. │
│   4. Each player runs  /iam <awbw_username>    │
│      (or the CO assigns with /setplayer).      │
│                                                │
│  COMMAND ROSTER                                │
│   /game <url|id>        bind this group's game │
│   /iam <username>       claim your player slot │
│   /setplayer @m <user>  CO assigns a player    │
│   /players              show the roster        │
│   /scope mine|all       who gets pinged        │
│   /fun [on|off]         flavor text            │
│   /status               current orders         │
│   /stop                 stand down             │
│   /help                 this memo              │
└─────────────────────────────────────────────┘
```

The bot-invite element (step 2) is the one piece needing a real value: a `signal.group`
invite link, the bot's number, or a QR code — TBD by how we want people to add the bot.

## What gets deleted

- `web/`: the `ComTowerApp` client UI, auth, invite pages (`invite/[code]`), the dynamic
  `game/[gameId]` dashboard, `/api/invite/*`, phone entry, send-code, CAPTCHA solve page,
  `/send-verification`, subscriber/group-resolve APIs. (Keep `layout.tsx` +
  `BackgroundCanvas.tsx`; replace `page.tsx` with the static memo.)
- Worker: `Subscriber` / `playerPhoneMap` / `scope` / `notifyFrequency` / hourly-reminder code.
- Firestore: `patches`, `users`, `captchaChallenges`, invite docs.

