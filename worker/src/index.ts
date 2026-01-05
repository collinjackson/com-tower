import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import WebSocket from 'ws';
import { GoogleAuth, IdTokenClient } from 'google-auth-library';
import http from 'http';
import { FieldValue } from 'firebase-admin/firestore';

type Subscriber = { type: 'dm' | 'group'; handle: string };
type PatchData = { gameId: string; subscribers: Subscriber[]; patchId: string };
type NextTurnMeta = { day?: number; playerName?: string };

const auth = new GoogleAuth();
const idTokenClients = new Map<string, IdTokenClient>();
const renderUrl = process.env.NOTIFY_RENDER_URL;

async function getIdTokenClient(url: string): Promise<IdTokenClient> {
  if (idTokenClients.has(url)) return idTokenClients.get(url)!;
  const client = await auth.getIdTokenClient(url);
  idTokenClients.set(url, client);
  return client;
}

function ensureFirebase() {
  if (getApps().length === 0) {
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
    if (!projectId || !clientEmail || !privateKey) {
      throw new Error('Missing Firebase admin env vars');
    }
    initializeApp({
      credential: cert({ projectId, clientEmail, privateKey }),
    });
  }
}

function buildAwbwSocketUrl(gameId: string) {
  const base = process.env.AWBW_WS_BASE || 'wss://awbw.amarriner.com';
  return `${base}/node/game/${gameId}`;
}

function gameLink(gameId: string) {
  return `https://awbw.amarriner.com/game.php?games_id=${gameId}`;
}

async function buildMessage(gameId: string, meta: NextTurnMeta) {
  const link = gameLink(gameId);
  if (renderUrl) {
    try {
      const res = await fetch(renderUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          gameId,
          day: meta.day,
          playerName: meta.playerName,
          link,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data?.text) return data.text as string;
      } else {
        console.error('Render endpoint failed', await res.text());
      }
    } catch (err) {
      console.error('Render fetch failed', err);
    }
  }
  const parts = [`Next turn is up.`];
  if (meta.day) parts.push(`Day ${meta.day}.`);
  if (meta.playerName) parts.push(`${meta.playerName}, you're up.`);
  parts.push(link);
  return parts.join(' ');
}

function startSocket(data: PatchData) {
  const url = buildAwbwSocketUrl(data.gameId);
  console.log(`Connecting to ${url} for patch ${data.patchId}`);
  const ws = new WebSocket(url);

  const reopen = () => {
    console.log(`Reconnecting to ${data.gameId} after close/error`);
    setTimeout(() => startSocket(data), 1000);
  };

  ws.on('open', () => {
    console.log(`WS open for game ${data.gameId} (patch ${data.patchId})`);
  });

  ws.on('message', (msg) => {
    try {
      const parsed = JSON.parse(msg.toString());
      const msgType =
        parsed?.type ||
        (parsed?.NextTurn && 'NextTurn') ||
        (parsed?.Pause && 'Pause') ||
        (parsed?.ActivityUpdate && 'ActivityUpdate') ||
        (parsed?.JoinRoom && 'JoinRoom') ||
        (parsed?.LeaveRoom && 'LeaveRoom') ||
        'unknown';
      console.log(`WS message for game ${data.gameId}: type=${msgType}`);
      if (msgType === 'unknown') {
        console.log(`WS payload for game ${data.gameId}: ${msg.toString()}`);
      }
      if (msgType === 'NextTurn') {
        const next = parsed?.NextTurn || parsed?.nextTurn || {};
        const meta: NextTurnMeta = {
          day: next.day,
          playerName: undefined,
        };
        buildMessage(data.gameId, meta)
          .then((text) => {
            data.subscribers.forEach((sub) => {
              if (sub.type === 'dm') {
                sendSignal(sub, text)
                  .then(() => {
                    console.log(
                      `Signal sent to ${sub.handle} for game ${data.gameId} (NextTurn)`
                    );
                    try {
                      getFirestore()
                        .collection('messages')
                        .add({
                          gameId: data.gameId,
                          text,
                          recipient: sub.handle,
                          createdAt: FieldValue.serverTimestamp(),
                        })
                        .catch((err) =>
                          console.error('Failed to store message log', err)
                        );
                    } catch (err) {
                      console.error('Message log store failed', err);
                    }
                  })
                  .catch((err) => console.error('Signal send failed', err));
              }
            });
          })
          .catch((err) => console.error('Message build failed', err));
      }
    } catch (err) {
      console.error('WS parse error', err);
    }
  });

  ws.on('error', (err) => {
    console.error(`WS error for game ${data.gameId}`, err);
    ws.close();
  });
  ws.on('close', () => {
    console.log(`WS closed for ${data.gameId}`);
    reopen();
  });
}

async function sendSignal(recipient: Subscriber, text: string) {
  const bridgeUrl = process.env.SIGNAL_CLI_URL;
  const botNumber = process.env.SIGNAL_BOT_NUMBER;
  if (!bridgeUrl) throw new Error('SIGNAL_CLI_URL not set');
  if (!botNumber) throw new Error('SIGNAL_BOT_NUMBER not set');

  const client = await getIdTokenClient(bridgeUrl);
  return client.request({
    url: `${bridgeUrl}/v2/send`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    data: {
      number: botNumber,
      message: text,
      recipients: [recipient.handle],
    },
  });
}

async function main() {
  ensureFirebase();
  const db = getFirestore();

  console.log('Worker starting. Watching patches for subscribers...');
  db.collection('patches').onSnapshot((snap) => {
    snap.docChanges().forEach((change) => {
      if (change.type === 'removed') return;
      const data = change.doc.data() as {
        gameId?: string;
        subscribers?: Subscriber[];
      };
      if (!data.gameId || !data.subscribers?.length) return;

      startSocket({
        gameId: data.gameId,
        subscribers: data.subscribers,
        patchId: change.doc.id,
      });
    });
  });

  // Simple health server for Cloud Run
  const port = Number(process.env.PORT) || 8080;
  const server = http.createServer((_, res) => {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/plain');
    res.end('ok');
  });
  server.listen(port, () => {
    console.log(`Health server listening on ${port}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

