#!/usr/bin/env bash
# Install or update `peachy daemon` as a systemd service, for a Com Tower that runs on Peachy.
# Run as root on the Linux machine that will hold the bot's Peachy device. See README.md.
#
#   sudo ./install.sh PEACHY_BINARY
#
# Settings (environment):
#   LISTEN       where the daemon answers (default 127.0.0.1:8081). Use 0.0.0.0:8081, or the
#                machine's private IP, only when the worker reaches it over a private network.
#   DEVICE_TGZ   first install only: a tar.gz of an existing device folder to move here. Stop
#                and retire the old copy first; two running copies of one device break it.
#
# The daemon's bearer token: piped on stdin if you have one (e.g. from your secret store),
# otherwise the one from a previous install, otherwise a new random one. It is written to
# /etc/peachy-daemon/env (root only) and never printed.
#
# Re-runnable. On a binary swap it backs up the device folder and the old binary to
# /var/backups/peachy-daemon first.
set -euo pipefail

BIN_SRC="${1:-}"
LISTEN="${LISTEN:-127.0.0.1:8081}"
DATA=/var/lib/peachy-bot
ETC=/etc/peachy-daemon
HERE="$(cd "$(dirname "$0")" && pwd)"

[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
[ -n "$BIN_SRC" ] && [ -x "$BIN_SRC" ] || { echo "usage: sudo $0 PEACHY_BINARY" >&2; exit 2; }

id peachy-bot >/dev/null 2>&1 ||
  useradd --system --home-dir "$DATA" --shell /usr/sbin/nologin peachy-bot
install -d -m 0700 -o peachy-bot -g peachy-bot "$DATA"
install -d -m 0700 -o root -g root "$ETC"

# Token: stdin, else the existing one, else a new one.
token=""
if [ ! -t 0 ]; then token="$(cat)"; fi
if [ -z "$token" ] && [ -f "$ETC/env" ]; then
  token="$(sed -n 's/^PEACHY_DAEMON_TOKEN=//p' "$ETC/env")"
fi
if [ -z "$token" ]; then token="$(openssl rand -hex 32)"; echo "made a new daemon token"; fi
umask 077
printf 'PEACHY_DAEMON_TOKEN=%s\nPEACHY_LISTEN=%s\n' "$token" "$LISTEN" > "$ETC/env"
chmod 0600 "$ETC/env"

# The device folder holds the bot's keys and its group state, which moves on with every
# message. Never overwrite it.
if [ ! -f "$DATA/device.json" ] && [ -n "${DEVICE_TGZ:-}" ]; then
  tar -xzf "$DEVICE_TGZ" -C "$DATA"
  rm -f "$DATA/lock"
  chown -R peachy-bot:peachy-bot "$DATA"
  chmod -R go-rwx "$DATA"
  echo "device moved in from $DEVICE_TGZ; delete that archive and the old folder"
fi

# Binary swap: stop the daemon and keep a rollback copy of the device folder and old binary.
if [ -x /usr/local/bin/peachy ] && ! cmp -s "$BIN_SRC" /usr/local/bin/peachy; then
  systemctl stop peachy-daemon 2>/dev/null || true
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  install -d -m 0700 -o root -g root /var/backups/peachy-daemon
  tar -czf "/var/backups/peachy-daemon/device-$stamp.tgz" -C "$DATA" .
  cp -p /usr/local/bin/peachy "/var/backups/peachy-daemon/peachy-$stamp"
  echo "backed up device and binary to /var/backups/peachy-daemon/*-$stamp"
fi
install -m 0755 -o root -g root "$BIN_SRC" /usr/local/bin/peachy
install -m 0644 -o root -g root "$HERE/peachy-daemon.service" /etc/systemd/system/peachy-daemon.service
systemctl daemon-reload
systemctl enable peachy-daemon >/dev/null

if [ ! -f "$DATA/device.json" ]; then
  cat <<EOF
Installed, not started: the bot has no Peachy device here yet. Link one (it texts a code to
the bot account's phone, then asks you to approve the device in Peachy on that phone):

  sudo -u peachy-bot /usr/local/bin/peachy -d $DATA login -name "Com Tower" +<bot phone number>

then run this script again to start the daemon.
EOF
  exit 0
fi

systemctl restart peachy-daemon
host="${LISTEN%:*}"; [ "$host" = 0.0.0.0 ] && host=127.0.0.1
for _ in $(seq 1 30); do
  # The header goes in on stdin, so the token isn't in curl's argv.
  if printf 'Authorization: Bearer %s\n' "$token" |
    curl -fsS -m 3 -H @- "http://$host:${LISTEN##*:}/v1/about" >/dev/null 2>&1; then
    echo "peachy daemon is up on $LISTEN"
    exit 0
  fi
  sleep 2
done
echo "peachy daemon did not answer; recent log:" >&2
journalctl -u peachy-daemon -n 40 --no-pager >&2
exit 1
