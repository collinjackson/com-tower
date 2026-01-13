## Com Tower Worker (Cloud Run)

Long-lived websocket listener for AWBW turn events. Reads game configs from Firestore and sends Signal DMs via a dedicated Signal bot identity.

### Planned setup
- Runtime: Node 20 (or 18) on Cloud Run with `minInstances=1` for stable sockets.
- Env:
  - `FIREBASE_PROJECT_ID`
  - `FIREBASE_CLIENT_EMAIL`
  - `FIREBASE_PRIVATE_KEY` (base64 or escaped)
  - `FIRESTORE_GAMES_COLLECTION` (default `games`)
  - `AWBW_WS_BASE` (default `wss://awbw.amarriner.com`)
  - `SIGNAL_CLI_URL` (REST endpoint for sending DMs)
- Loop:
  - Watch Firestore `games` docs for {gameId, notifyMode, signalToken/phone}.
  - For each game, open `wss://awbw.amarriner.com/node/game/{gameId}`; on `NextTurn`, send DM to the configured number if `notifyMode === 'signal-dm'`.
  - Keep a max socket age (e.g., 50–55 minutes); reconnect with backoff.

### Next steps
- Add minimal `package.json` with ws + firebase-admin + cross-fetch (or node-fetch).
- Implement `src/index.ts` to:
  - Load service account from env.
  - Read `games` collection; start socket per game.
  - On message: parse NextTurn; dedupe by `turnKey = nextTurnStart + nextPId`; send DM via Signal REST.
  - Health endpoint (`/health`) for Cloud Run.

### Note on Signal bot identity
- A Signal identity zip was uploaded to `gs://comtower-signal-identity/signal-cli.zip`.
- Assign your Cloud Run service account `roles/storage.objectViewer` on that bucket/object so the bridge can fetch it at startup.


