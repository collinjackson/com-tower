# Com Tower on Peachy

Com Tower can serve [Peachy](https://pchy.app) group chats as well as Signal groups. On Peachy
the bridge is `peachy daemon` from [peachy-go](https://github.com/collinjackson/peachy-go): it
answers the same HTTP API as signal-cli-rest-api, so the worker is the same code, with
`MESSAGING_PLATFORM=peachy` and `SIGNAL_CLI_URL` pointed at the daemon. peachy-go's
[Bots on Peachy](https://github.com/collinjackson/peachy-go/blob/main/docs/bots.md) covers the
daemon itself and how Peachy differs from Signal.

Set up the rest of your tower first ([SELF_HOST.md](../../SELF_HOST.md): Firebase, dashboard,
Firestore rules). A Peachy worker can share that Firebase project with a Signal worker.

```
Peachy group chat  ⇄  peachy daemon (your Linux machine, systemd)
                           ⇅  SIGNAL_CLI_URL + bearer token, over a private network
                      bot/ worker  (MESSAGING_PLATFORM=peachy)
                           ⇅
                      Firestore, shared with a Signal worker if you run one
```

Each group game records the platform whose worker bound it, and a worker watches only its own
platform's games, so a Signal worker and a Peachy worker run side by side on one Firestore.
Games stored before platforms were recorded count as Signal's.

## 1. A Peachy account for the bot

Make a Peachy account for the bot in the Peachy app, on a phone with its own number. Keep the
app signed in there: you approve the daemon's device from it, and it is where you do the bot's
account chores (below).

## 2. The daemon

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

## 3. The worker

The worker's settings are the ones in [SELF_HOST.md](../../SELF_HOST.md), plus:

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

## 4. Groups and players

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
