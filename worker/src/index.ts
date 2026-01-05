import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import WebSocket from 'ws';

type Subscriber = { type: 'dm' | 'group'; handle: string };

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

function sendSignal(recipient: Subscriber, text: string) {
  const bridgeUrl = process.env.SIGNAL_CLI_URL;
  if (!bridgeUrl) throw new Error('SIGNAL_CLI_URL not set');
  return fetch(`${bridgeUrl}/v2/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      number: process.env.SIGNAL_BOT_NUMBER,
      message: text,
      recipients: [recipient.handle],
    }),
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

      // Simple socket per patch; no dedupe/backoff in this scaffold.
      const url = buildAwbwSocketUrl(data.gameId);
      console.log(`Connecting to ${url} for patch ${change.doc.id}`);
      const ws = new WebSocket(url);

      ws.on('message', (msg) => {
        try {
          const parsed = JSON.parse(msg.toString());
          if (parsed?.type === 'NextTurn') {
            const text = `Next turn for game ${data.gameId}.`;
            data.subscribers!.forEach((sub) => {
              if (sub.type === 'dm') {
                sendSignal(sub, text).catch((err) =>
                  console.error('Signal send failed', err)
                );
              }
            });
          }
        } catch (err) {
          console.error('WS parse error', err);
        }
      });

      ws.on('error', (err) => console.error('WS error', err));
      ws.on('close', () => console.log(`WS closed for ${data.gameId}`));
    });
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

