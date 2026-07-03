# Com Tower bot — load test harness

Measures how many concurrent games ("clients") one bot process (or a set of replicas) can sustain
while delivering every turn notification within an SLO, and compares the `SCALING_MODE` strategies
(`singleton` / `leader` / `shard`). Runs **fully local — zero cloud**: an offline Firestore
emulator, local mock servers, and the bot as a normal child process.

## What it stands up

| Piece | Stands in for | How |
|---|---|---|
| Firestore **emulator** | cloud Firestore | `firebase emulators:exec`, `demo-*` project id (offline, no login) |
| `mocks.mjs` AWBW mock | AWBW websocket + game-page scrape | one HTTP+WS server; emits `NextTurn` on demand |
| `mocks.mjs` render stub | dashboard `/api/notify/render` | returns `{ text }` instantly |
| `mocks.mjs` bridge stub | Signal bridge `/v2/send` | records every send (for delivery/latency/dupe metrics) |

The bot reaches all of these through its normal env vars (`AWBW_WS_BASE`, `AWBW_HTTP_BASE`,
`NOTIFY_RENDER_URL`, `SIGNAL_CLI_URL`, `FIRESTORE_EMULATOR_HOST`) — no bot code is special-cased
for tests. `SIGNAL_CLI_NO_AUTH=1` skips the Google OIDC the real bridge uses.

## Run

```bash
cd bot
./loadtest/run.sh                                  # default sweep 25,50,100,200 in singleton mode
GAMES=100,250,500 ./loadtest/run.sh                # custom sweep
SCALING_MODE=shard SHARD_COUNT=2 ...               # (once leader/shard land + multi-proc support)
BRIDGE_LATENCY_MS=250 SLO_MS=8000 ./loadtest/run.sh  # model a slow Signal bridge
```

Prereqs: `firebase` CLI + a JRE (both already present here), and the bot's `npm install` done.

## Knobs (env)

| Var | Default | Meaning |
|---|---|---|
| `GAMES` | `25,50,100,200` | comma list of game counts to sweep |
| `ROUNDS` | `10` | turns emitted per game |
| `TURN_INTERVAL_MS` | `1000` | delay between rounds |
| `SCALING_MODE` | `singleton` | `singleton` \| `leader` \| `shard` |
| `BRIDGE_LATENCY_MS` | `0` | simulated per-send bridge service time |
| `BRIDGE_CONCURRENCY` | ∞ | max in-flight sends at the bridge (a single-VM model). Ceiling ≈ `CONCURRENCY*1000/LATENCY` sends/sec — a *global* limit shared by all replicas, so sharding the bot can't raise it |
| `SLO_MS` | `5000` | p95 emit→send latency ceiling for PASS |
| `MEM_CEILING_MB` | `450` | peak-RSS ceiling for PASS (~Cloud Run 512Mi) |

## Output

Per game count: `delivered / drops / dupes`, emit→send latency `p50/p95/max`, peak bot RSS, and
PASS/FAIL. Ends with the **max sustained clients** meeting the SLO and writes
`results-<mode>.json`. Per-run bot logs are `bot-<mode>-g<N>.log`.

**Reading the modes** (see the migration log §9): `singleton`/`shard` report a capacity curve;
`leader` capacity is ~flat vs singleton — its real metric is failover (kill the leader mid-run and
watch for drops/dupes during handover). Don't compare `leader` on the capacity axis.

## Note on the group model

The live model sends **one group message per turn** (not per-subscriber fan-out), so a "client" is
a watched **game**; subscribers-per-game don't multiply send load. Load = games × turn rate.
