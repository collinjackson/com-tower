# Com Tower on Peachy

Com Tower can serve [Peachy](https://pchy.app) group chats as well as Signal groups. On Peachy it
runs as a bot, through Peachy's bot SDK, [`@peachysocial/bot`](https://pchy.app/developers): the
worker runs the SDK in its own process, with `MESSAGING_BACKEND=peachy-bot`. There is nothing else
to run. (The older way, through `peachy daemon`, is [at the end](#the-older-option-peachy-daemon).)

Set up the rest of your tower first ([SELF_HOST.md](../../SELF_HOST.md): Firebase, dashboard,
Firestore rules). A Peachy worker can share that Firebase project with a Signal worker.

```
Peachy group chat  ⇄  Peachy  ⇄  bot/ worker (MESSAGING_BACKEND=peachy-bot, one process)
                                     ⇅                 ⇅
                                 Firestore         the bot's encrypted store
                                                   (SQLite on a disk, or Postgres)
```

Each group game records the platform whose worker bound it, and a worker watches only its own
platform's games, so a Signal worker and a Peachy worker run side by side on one Firestore.
Games stored before platforms were recorded count as Signal's.

## 1. Create the bot in Peachy

In the Peachy app: **Settings › Organizations and bots › New bot** (on a Mac, **You ›
Organizations and bots**; on the web, pchy.app/settings/organizations-and-bots). Fill in its
listing:

- **Where messages go**: your tower. The worker hands only commands (messages starting with `/`)
  to Com Tower's code; it stores the sender's Peachy id and name for `/iam`, mods and the game
  binding, in your Firestore. It logs no message text.
- **What it can do**: **Post on its own** (turn pings and reminders). It doesn't react or join
  calls.
- **Who can use it**: **You and testers** while you try it; publish it when groups beyond your
  testers should add it.

You don't type its commands: the worker sends them when it starts, and they show in Peachy's
command picker. Keep this bot for the server. For trying things on your computer, make a second
bot: a store links one bot, and a second store linked to the same bot signs the first one out.

## 2. The store key

The store is the bot's identity: its device keys and its state in every chat, encrypted under a
store key. Make the key on a machine you trust:

```bash
cd bot && npm install
npx @peachysocial/bot keygen --out .peachy-store-key   # mode 0600; git-ignored
```

The key is a secret. Put it in your secret store (or a 0600 file on the server), keep a copy
somewhere safe, and never put it in the image, the repository or next to the store. Without it
the store can't be opened, and the way back is **Link a new server** on the bot's page, which takes
the bot out of every chat.

## 3. Where it runs

The worker with this backend is **one long-running process** with **storage that outlives it**:

- One process: one store is one bot device. Run `SCALING_MODE=singleton` (the default) and one
  replica; the worker refuses to start this backend in another mode. A second copy waits up to a
  minute for the first to stop, then exits.
- Lasting storage: the store moves on with every message. Lose it and the bot leaves its chats.
  Never restore it from an old backup (the SDK refuses a store older than the one it last ran).

So, either:

**A. A Linux VM with a disk** (a small one is plenty; the machine that ran `peachy daemon` works).
Keep the store on its disk, for example `/var/lib/com-tower-peachy`, owned by the user the worker
runs as, mode 0700. With the worker's Docker image:

```bash
sudo mkdir -p /var/lib/com-tower-peachy && sudo chown 1000:1000 /var/lib/com-tower-peachy
sudo chmod 0700 /var/lib/com-tower-peachy
docker run -d --name com-tower-peachy --restart unless-stopped \
  -v /var/lib/com-tower-peachy:/data \
  --env-file /etc/com-tower-peachy/env \
  <worker image>
```

`/etc/com-tower-peachy/env` (root only, mode 0600) holds the worker's settings from SELF_HOST.md
and the ones below, `PEACHY_BOT_STORE_KEY` among them. The worker needs no inbound port for Peachy:
it connects out. Its health port (8080) is for your own checks.

**B. Cloud Run with a Postgres store.** Cloud Run's filesystem goes with each instance, so a SQLite
store there would be lost at every restart or deploy. Point `PEACHY_BOT_DATABASE_URL` at a Postgres
database instead (Cloud SQL, reached over your VPC), with one instance and CPU always on:

```bash
cd bot
PROJECT_ID=<your-gcp-project> REGION=<region> \
SERVICE_NAME=com-tower-worker-peachy MIN_INSTANCES=1 MAX_INSTANCES=1 \
FIREBASE_PROJECT_ID=... FIREBASE_CLIENT_EMAIL=... FIREBASE_PRIVATE_KEY=... \
INVITE_SHARED_SECRET=... NOTIFY_RENDER_URL=https://<your-dashboard>/api/notify/render \
./deploy.sh \
  --set-env-vars MESSAGING_BACKEND=peachy-bot \
  --set-secrets PEACHY_BOT_STORE_KEY=<store-key-secret>:latest,PEACHY_BOT_DATABASE_URL=<db-url-secret>:latest \
  --network <vpc> --subnet <subnet> --vpc-egress private-ranges-only \
  --no-cpu-throttling
```

(`deploy.sh` still asks for `SIGNAL_CLI_URL` and `SIGNAL_BOT_NUMBER`; any placeholder will do, as
this backend doesn't read them.) Every value is encrypted under the store key before it is
written, so the database holds no readable key or message. A deploy starts the new instance
before the old one stops; the new one waits for the old one's lease, so expect up to a minute
without the bot.

## 4. Link it: the Connect code

On the bot's page in Peachy, tap **Connect** for a one-time code (it lasts 15 minutes). Then
either:

- run `connect` where the store lives, as the user the worker runs as, with the worker stopped:

  ```bash
  PEACHY_BOT_STORE_KEY_FILE=/path/to/.peachy-store-key \
    npx @peachysocial/bot connect --store /var/lib/com-tower-peachy/bot.db
  ```

  (In the container: `docker run --rm -it -v /var/lib/com-tower-peachy:/data -e PEACHY_BOT_STORE_KEY_FILE=... <worker image> npx @peachysocial/bot connect --store /data/bot.db`.)

- or set `PEACHY_CONNECT_CODE` for the first start (the way to do it on Cloud Run). The worker
  links an empty store with it and logs `@<handle> is running`. Remove the setting afterwards.

The Connect screen in Peachy then says **Connected**.

## 5. The worker's settings

The worker's settings are the ones in [SELF_HOST.md](../../SELF_HOST.md), without
`SIGNAL_CLI_URL` and `SIGNAL_BOT_NUMBER`, plus:

| Variable | Value |
|----------|-------|
| `MESSAGING_BACKEND` | `peachy-bot` |
| `MESSAGING_PLATFORM` | Optional. Default `peachy`. See [moving from the daemon](#moving-from-peachy-daemon). |
| `PEACHY_BOT_STORE_KEY` | The store key. A secret. Or `PEACHY_BOT_STORE_KEY_FILE`: a 0600 file holding it. |
| `PEACHY_BOT_DB` | The SQLite store's path. Default `./data/bot.db`; `/data/bot.db` in the image. |
| `PEACHY_BOT_DATABASE_URL` | Optional. A Postgres store instead of SQLite. A secret. |
| `PEACHY_CONNECT_CODE` | Optional. A Connect code for a first start with an empty store. Remove it after. |
| `SCALING_MODE` | `singleton` (the default). |

The worker lists the chats the bot is in from the SDK's store, so it keeps no file of its own: a
`chats.json` that an earlier worker left beside the store is no longer read and can be deleted.

The SDK needs Node.js 22.13 or newer; the worker's image has it. If the bot stops for good
(another copy took over, its token was revoked, its keys were reset), the worker exits non-zero
so your host restarts it or tells you; the log line says why.

## 6. Groups and players

A member adds the bot to their game's group (chat info › Add a bot, or type `@` and pick it), and
lets it post on its own (the group's `post` grant for the bot). Then `/game <AWBW link>` binds the game, as on Signal. Commands are in
Peachy's command picker; picking one sends `@<bot> /command`.

What's different from Signal, because of Peachy's rules for bots:

- **Turn pings need the Post grant.** A turn ping or a reminder is the bot posting on its own,
  which a group grants it (and a group where only admins may send messages refuses it whatever it
  grants). Without it the send fails, and the worker logs it as a failed send. `/game` says
  so when the group doesn't let the bot post.
- **When Peachy can't take a send.** While Peachy is out of reach, or the bot's copy of a chat is
  behind, a send fails with `UnavailableError`. The worker tries it again after 2 and 8 seconds;
  a turn ping that still can't go is retried in minutes, as any failed ping is.
- **Replies.** The bot answers a command in the command's thread and also in the main chat. A
  command picked from the picker, or with `@<bot>` in front, always gets its answer. A bare
  `/command` typed without the `@` gets one only where the bot has Post; elsewhere it still runs,
  silently.
- **Who the bot hears.** Peachy hands the bot the messages of members who added it or said OK to
  it (a member's first `@<bot>` asks them). Someone who hasn't can't run its commands.
- **Mentions.** A turn ping or a reminder mentions the player who has claimed their slot (`/iam`,
  `/setplayer`) as a real Peachy mention: their `@handle` shows in the message and their phone
  notifies them, even with the group on "Mentions only". Only the players the bot means are
  mentioned; any other `@word` in its text stays words.
- **Naming a member** (`/setplayer @member`, `/addmod @member`): pick them from the `@` list, or
  type their handle, as for any mention.
- **A group that removes the bot and adds it again** keeps its id, so the game it watched, its
  players and its mods carry on; it only needs to grant Post again if the new add doesn't.
- The dashboard's invite and captcha pages, and joining a group by link, are Signal-only.
- People are Peachy accounts, not phone numbers. A DM to someone who never wrote to the bot lands
  as a message request.

## Moving from `peachy daemon`

The bot is a new Peachy account, so the groups the daemon's account is in don't carry over: each
group adds the bot and runs `/game` again. Two ways to switch:

- **Side by side** (no gap): run the new worker with `MESSAGING_PLATFORM=peachy-bot` (any name but
  `peachy`) next to the daemon's worker. Groups move when they add the bot and run `/game`, which
  binds the game to the new platform. Stop the daemon's worker once its games have moved or ended.
- **Cut over**: stop the daemon's worker and run the new one with the default `peachy`. Games the
  daemon bound stay in Firestore, but the new bot isn't in their chats: their pings fail until the
  group adds the bot and runs `/game`.

Don't run two workers with the same platform on different backends: they elect one leader between
them and share the same games.

## The older option: `peachy daemon`

Before Peachy had bots, Com Tower reached Peachy through `peachy daemon` from
[peachy-go](https://github.com/collinjackson/peachy-go), which answers signal-cli-rest-api's HTTP API,
so the worker runs its Signal backend against it. It still works, but it signs in a person's
account on its own phone number rather than a bot. Prefer the bot SDK above for a new tower.
peachy-go's [Bots on Peachy](https://github.com/collinjackson/peachy-go/blob/main/docs/bots.md)
covers the daemon itself.

```
Peachy group chat  ⇄  peachy daemon (your Linux machine, systemd)
                           ⇅  SIGNAL_CLI_URL + bearer token, over a private network
                      bot/ worker  (MESSAGING_PLATFORM=peachy)
```

### D1. A Peachy account for the bot

Make a Peachy account for the bot in the Peachy app, on a phone with its own number. Keep the
app signed in there: you approve the daemon's device from it, and it is where you do the bot's
account chores (below).

### D2. The daemon

You need a Linux machine that stays up (a small VM is plenty) and a `peachy` binary built for
it from peachy-go (see its README).

```bash
# on the machine, from a checkout of this repo
sudo ./deploy/peachy/install.sh /path/to/peachy
sudo -u peachy-bot /usr/local/bin/peachy -d /var/lib/peachy-bot login -name "Com Tower" +<bot phone number>
# type the texted code, approve the new device in Peachy on the bot's phone, then:
sudo LISTEN=0.0.0.0:8081 ./deploy/peachy/install.sh /path/to/peachy
```

[install.sh](install.sh) makes a `peachy-bot` system user, keeps the device in
`/var/lib/peachy-bot`, installs [peachy-daemon.service](peachy-daemon.service), and writes the
daemon's bearer token to `/etc/peachy-daemon/env` (root only). Pipe a token in on stdin to use
your own (for example from your secret store); otherwise it makes one. Run it again to update the
binary: it backs up the device folder and the old binary first.

`LISTEN` defaults to `127.0.0.1:8081`, for a worker on the same machine. For a worker elsewhere,
listen on the private network only: open no firewall rule to the internet. Every request also
needs the token.

The device folder is the bot's identity and its group state. Run one daemon per device, and
don't copy the folder to run it somewhere else at the same time: two running copies fork the
group state and one stops decrypting. To move the bot to a new machine, stop the old daemon,
archive the folder, and install with `DEVICE_TGZ=<archive>`. Then delete the old copy.

Logs: `sudo journalctl -u peachy-daemon -f`. The daemon writes to the device folder with every
message; keep an eye on free disk space.

### D3. The worker

The worker's settings are the ones in [SELF_HOST.md](../../SELF_HOST.md), plus (with `MESSAGING_BACKEND` unset):

| Variable | Value |
|----------|-------|
| `MESSAGING_PLATFORM` | `peachy` |
| `SIGNAL_CLI_URL` | the daemon, e.g. `http://<machine's private IP>:8081` (plain http, no Google auth) |
| `SIGNAL_CLI_TOKEN` | the daemon's token, from `/etc/peachy-daemon/env` |
| `SIGNAL_BOT_NUMBER` | any stable id for the bot; the daemon doesn't check it. The bot's phone number is fine. |

On Cloud Run, [bot/deploy.sh](../../bot/deploy.sh) passes extra arguments on to `gcloud run deploy`.
For a worker that reaches the daemon over your VPC, with the token in Secret Manager:

```bash
cd bot
PROJECT_ID=<your-gcp-project> REGION=<region> \
SERVICE_NAME=com-tower-worker-peachy MIN_INSTANCES=1 MAX_INSTANCES=1 \
SIGNAL_CLI_URL=http://<machine's private IP>:8081 SIGNAL_BOT_NUMBER=<bot id> \
FIREBASE_PROJECT_ID=... FIREBASE_CLIENT_EMAIL=... FIREBASE_PRIVATE_KEY=... \
INVITE_SHARED_SECRET=... NOTIFY_RENDER_URL=https://<your-dashboard>/api/notify/render \
./deploy.sh \
  --set-env-vars MESSAGING_PLATFORM=peachy \
  --set-secrets SIGNAL_CLI_TOKEN=<daemon-token-secret>:latest \
  --network <vpc> --subnet <subnet> --vpc-egress private-ranges-only \
  --no-cpu-throttling
```

One replica (`MAX_INSTANCES=1`) with CPU always on: the worker holds the daemon's receive
WebSocket open, and the daemon is one process for one device.

The worker should log `receive websocket open` once it's connected.

### D4. Groups and players

People friend the bot's account on Peachy and add it to their game's group chat. Then, in that
chat, `/game <AWBW link>` binds the game, as on Signal. Mentions on a player's turn are real
Peachy mentions.

Account chores the daemon doesn't do, such as accepting friend requests, are done in the Peachy
app on the bot's phone.

Differences from Signal:

- The dashboard's invite and captcha pages, and joining a group by link, are Signal-only. On
  Peachy, people add the bot themselves.
- People are Peachy ids, not phone numbers. The bot can DM someone only after they've messaged
  it.
- See peachy-go's [Bots on Peachy](https://github.com/collinjackson/peachy-go/blob/main/docs/bots.md)
  for the rest: reactions, disappearing messages, and how a chat the bot fell behind in recovers.
