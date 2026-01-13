import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import WebSocket from 'ws';
import { GoogleAuth, IdTokenClient } from 'google-auth-library';
import http from 'http';
import { FieldValue } from 'firebase-admin/firestore';

type Subscriber = { type: 'dm' | 'group'; handle: string; groupId?: string; groupName?: string; mentions?: string[] };
type PatchData = {
  gameId: string;
  subscribers: Subscriber[];
  patchId: string;
  experimentalExtended?: boolean;
};
type NextTurnMeta = {
  day?: number;
  playerName?: string;
  includeImage?: boolean;
  players?: string[];
  countries?: string[];
  gameName?: string;
};
type RenderPayload = {
  text: string;
  imageUrl?: string;
  imageData?: string;
  imageContentType?: string;
  imageFilename?: string;
};

const auth = new GoogleAuth();
const idTokenClients = new Map<string, IdTokenClient>();
const renderUrl = process.env.NOTIFY_RENDER_URL;
const playersCache = new Map<string, { players: string[]; countries: string[] }>();
const gameNameCache = new Map<string, string>();
const MAX_INLINE_IMAGE_BYTES = 1_500_000; // 1.5 MB guard

async function getIdTokenClient(url: string): Promise<IdTokenClient> {
  if (idTokenClients.has(url)) return idTokenClients.get(url)!;
  const client = await auth.getIdTokenClient(url);
  idTokenClients.set(url, client);
  return client;
}

async function getGroupIdByName(groupName: string): Promise<string> {
  const bridgeUrl = process.env.SIGNAL_CLI_URL;
  const botNumber = process.env.SIGNAL_BOT_NUMBER;
  if (!bridgeUrl || !botNumber) {
    throw new Error('Signal bridge not configured');
  }

  const client = await getIdTokenClient(bridgeUrl);
  const numberPath = encodeURIComponent(botNumber);
  const res = await client.request({
    url: `${bridgeUrl}/v1/groups/${numberPath}`,
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  });
  const groups = (res as any)?.data || [];
  if (!Array.isArray(groups)) {
    throw new Error(`Groups list response is not an array: ${JSON.stringify(groups)}`);
  }

  // Simple exact match by name
  for (const group of groups) {
    if (group.name === groupName) {
      const groupId = group.id || (group.internal_id ? `group.${group.internal_id}` : null);
      if (groupId) {
        console.log(`Found group "${groupName}" with id: ${groupId}`);
        return groupId;
      }
    }
  }
  
  throw new Error(
    `Group "${groupName}" not found. Available groups: ${groups.map((g: any) => g.name || '(unnamed)').join(', ')}`
  );
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

async function loadGameName(gameId: string): Promise<string | undefined> {
  if (gameNameCache.has(gameId)) return gameNameCache.get(gameId);
  try {
    const snap = await getFirestore().collection('games').doc(gameId).get();
    const name = (snap.data() as any)?.gameName;
    if (name) {
      gameNameCache.set(gameId, String(name));
      return String(name);
    }
  } catch (err) {
    console.error('Game name fetch failed', err);
  }
  return undefined;
}

async function loadPlayers(gameId: string): Promise<{ players: string[]; countries: string[] }> {
  if (playersCache.has(gameId)) return playersCache.get(gameId)!;
  const db = getFirestore();
  // Try Firestore cache
  try {
    const docRef = db.collection('gamePlayers').doc(gameId);
    const snap = await docRef.get();
    if (snap.exists) {
      const data = snap.data() as { players?: string[]; countries?: string[] };
      if (data?.players?.length) {
        const cached = {
          players: data.players || [],
          countries: data.countries || [],
        };
        playersCache.set(gameId, cached);
        return cached;
      }
    }
  } catch (err) {
    console.error('Player cache read failed', err);
  }

  try {
    const res = await fetch(gameLink(gameId));
    const html = await res.text();
    const matches = Array.from(html.matchAll(/profile\.php\?username=([A-Za-z0-9_]+)/g)).map(
      (m) => m[1]
    );
    const players = Array.from(new Set(matches));
    const countries = Array.from(
      new Set(
        Array.from(html.matchAll(/countries_code["']?\s*:\s*["']([a-z]{2,3})["']/gi)).map(
          (m) => m[1]
        )
      )
    );
    const record = { players, countries };
    playersCache.set(gameId, record);
    try {
      await getFirestore().collection('gamePlayers').doc(gameId).set(record);
    } catch (err) {
      console.error('Player cache write failed', err);
    }
    return record;
  } catch (err) {
    console.error('Player scrape failed', err);
    return { players: [], countries: [] };
  }
}

async function buildMessage(gameId: string, meta: NextTurnMeta): Promise<RenderPayload> {
  const link = gameLink(gameId);
  const gameName = meta.gameName || `Game ${gameId}`;

  if (renderUrl) {
    try {
      const bypass = process.env.RENDER_BYPASS_TOKEN;
      const res = await fetch(renderUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(bypass ? { 'x-vercel-protection-bypass': bypass, cookie: `x-vercel-protection-bypass=${bypass}` } : {}),
        },
        body: JSON.stringify({
          gameId,
          day: meta.day,
          playerName: meta.playerName,
          players: meta.players,
          gameName,
          link,
          enableFun: meta.includeImage,
          includeImage: meta.includeImage,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data?.error) {
          throw new Error(typeof data.error === 'string' ? data.error : JSON.stringify(data.error));
        }
        if (data?.text) {
          let text = data.text as string;
          const nameChunk = gameName ? `(${gameName})` : '';
          if (!text.includes(link)) {
            text = `${text} ${nameChunk ? `${nameChunk} ` : ''}${link}`;
          } else if (nameChunk && !text.includes(nameChunk)) {
            text = `${text} ${nameChunk}`;
          }
          return { text, imageUrl: data.imageUrl || undefined };
        }
        throw new Error('Render returned no text');
      } else {
        const body = await res.text();
        throw new Error(`Render endpoint failed ${res.status} ${res.statusText}: ${body}`);
      }
    } catch (err) {
      console.error('Render fetch failed', err);
      const errMsg = err instanceof Error ? err.message : 'Render fetch failed';
      return {
        text: `Next turn is up. ${meta.day ? `Day ${meta.day}. ` : ''}${
          meta.playerName ? `${meta.playerName}, you're up. ` : ''
        }${gameName ? `${gameName} ` : ''}${link} [render error: ${errMsg}]`,
      };
    }
  }
  const parts = [`Next turn is up.`];
  if (meta.day) parts.push(`Day ${meta.day}.`);
  if (meta.playerName) parts.push(`${meta.playerName}, you're up.`);
  parts.push(gameName, link);
  return { text: parts.join(' ') };
}

function startSocket(data: PatchData) {
  const url = buildAwbwSocketUrl(data.gameId);
  console.log(`Connecting to ${url} for patch ${data.patchId} with ${data.subscribers?.length || 0} subscribers`);
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
        if (!data.subscribers || data.subscribers.length === 0) {
          console.log(`NextTurn received for game ${data.gameId} but no subscribers configured`);
          return;
        }
        console.log(`Processing NextTurn for game ${data.gameId}, subscribers: ${data.subscribers.length}`);
        const next = parsed?.NextTurn || parsed?.nextTurn || parsed || {};
        console.log(`NextTurn payload: ${JSON.stringify(next)}`);
        const meta: NextTurnMeta = {
          day: next.day,
          playerName: undefined,
          includeImage: data.experimentalExtended,
        };
        const db = getFirestore();
        const msgRef = db.collection('messages').doc();
        msgRef
          .set({
            gameId: data.gameId,
            status: 'processing',
            createdAt: FieldValue.serverTimestamp(),
            recipients: data.subscribers.map((s) => s.handle),
          })
          .catch((err) => console.error('Pre-log message create failed', err));

        Promise.all([loadPlayers(data.gameId).catch(() => ({ players: [], countries: [] })), loadGameName(data.gameId)])
          .then(([info, gameName]) =>
            buildMessage(data.gameId, {
              ...meta,
              players: info.players,
              countries: info.countries,
              gameName,
            })
          )
          .then((payload) => {
            console.log(
              `Render payload for game ${data.gameId}: textLen=${payload.text.length}, imageData=${
                payload.imageData ? payload.imageData.length : 0
              }, imageUrl=${payload.imageUrl ? 'yes' : 'no'}`
            );
            msgRef
              .update({
                status: 'rendered',
                text: payload.text,
                imageUrl: payload.imageUrl || null,
                imageDataPresent: !!payload.imageData,
                renderedAt: FieldValue.serverTimestamp(),
              })
              .catch((err) => console.error('Message log render update failed', err));

            msgRef
              .update({ status: 'sending', sendStartedAt: FieldValue.serverTimestamp() })
              .catch((err) => console.error('Message log send-start update failed', err));

            Promise.all(
              data.subscribers.map((sub) =>
                sendSignal(sub, payload, data.patchId)
                  .then(() => {
                    console.log(
                      `Signal ${sub.type === 'group' ? 'group ' : ''}sent to ${
                        sub.handle
                      } for game ${data.gameId} (NextTurn)`
                    );
                  })
                  .catch((err) => {
                    console.error('Signal send failed', err);
                    throw err;
                  })
              )
            )
              .then(() =>
                msgRef.update({
                  status: 'sent',
                  sentAt: FieldValue.serverTimestamp(),
                })
              )
              .catch((err) =>
                msgRef.update({
                  status: 'failed',
                  error: err instanceof Error ? err.message : String(err),
                  sentAt: FieldValue.serverTimestamp(),
                })
              );
          })
          .catch((err) => {
            console.error('Message build failed', err);
            msgRef
              .update({
                status: 'failed',
                error: err instanceof Error ? err.message : String(err),
              })
              .catch(() => {});
          });
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

async function sendSignal(recipient: Subscriber, payload: RenderPayload, patchId: string) {
  const bridgeUrl = process.env.SIGNAL_CLI_URL;
  const botNumber = process.env.SIGNAL_BOT_NUMBER;
  if (!bridgeUrl) throw new Error('SIGNAL_CLI_URL not set');
  if (!botNumber) throw new Error('SIGNAL_BOT_NUMBER not set');

  const client = await getIdTokenClient(bridgeUrl);

  let messageText = payload.text;
  const mentionNumbers = Array.isArray(recipient.mentions)
    ? recipient.mentions.filter((m) => typeof m === 'string' && m.trim().length > 0)
    : [];
  const mentionPlaceholders: { start: number; length: number; number: string; name: string }[] =
    [];

  if (recipient.type === 'group' && mentionNumbers.length > 0) {
    const spacer = messageText.endsWith(' ') ? '' : ' ';
    const placeholders = mentionNumbers.map(() => '@').join(' ');
    const startIndex = (messageText + spacer).length;
    messageText = `${messageText}${spacer}${placeholders}`;
    let cursor = startIndex;
    mentionNumbers.forEach((num) => {
      mentionPlaceholders.push({ start: cursor, length: 1, number: num, name: '@' });
      cursor += 2; // '@' plus following space
    });
    if (mentionPlaceholders.length > 0) {
      // Trim trailing space offset
      const last = mentionPlaceholders[mentionPlaceholders.length - 1];
      mentionPlaceholders[mentionPlaceholders.length - 1] = {
        ...last,
        // the last placeholder has no trailing space in length calculation; length is 1 already
      };
    }
  }

  const baseData: any = {
    number: botNumber,
    message: messageText,
  };
  if (mentionPlaceholders.length > 0) {
    baseData.mentions = mentionPlaceholders.map((m) => ({
      name: m.name,
      number: m.number,
      start: m.start,
      length: m.length,
    }));
  }
  if (payload.imageData && payload.imageContentType) {
    console.log(
      `Sending Signal attachment size=${payload.imageData.length} ct=${payload.imageContentType}`
    );
    // signal-cli-rest-api expects base64Attachments as plain base64 strings.
    baseData.base64Attachments = [payload.imageData];
    baseData.attachmentFilenames = [
      payload.imageFilename || `image-${Date.now()}.png`,
    ];
  }

  if (recipient.type === 'group') {
    let groupId: string | undefined = recipient.groupId;
    
    // If we already have a groupId stored, use it
    if (groupId) {
      console.log(`Using stored groupId: ${groupId}`);
      return client.request({
        url: `${bridgeUrl}/v2/send`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        data: { ...baseData, groupId },
      });
    }
    
    // Get groupId by name - simple and deterministic
    if (!recipient.groupName) {
      throw new Error('Group name is required. Please select the group by name when adding the subscriber.');
    }
    
    groupId = await getGroupIdByName(recipient.groupName);
    
    // Cache the groupId on the patch to avoid re-lookup
    try {
      const db = getFirestore();
      await db
        .collection('patches')
        .doc(patchId)
        .update({
          subscribers: FieldValue.arrayUnion({ ...recipient, groupId }),
        });
    } catch (err) {
      console.error('Failed to cache groupId on patch', err);
    }

    return client.request({
      url: `${bridgeUrl}/v2/send`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      data: { ...baseData, groupId },
    });
  }

  return client.request({
    url: `${bridgeUrl}/v2/send`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    data: { ...baseData, recipients: [recipient.handle] },
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
        experimentalExtended?: boolean;
      };
      if (!data.gameId || !data.subscribers?.length) return;

      startSocket({
        gameId: data.gameId,
        subscribers: data.subscribers,
        patchId: change.doc.id,
        experimentalExtended: data.experimentalExtended,
      });
    });
  });


  // Simple health server for Cloud Run
  const port = Number(process.env.PORT) || 8080;
  const server = http.createServer(async (_, res) => {
    try {
      const url = new URL(_.url || '/', 'http://localhost');
      if (url.pathname === '/list-groups') {
        const bridgeUrl = process.env.SIGNAL_CLI_URL;
        const botNumber = process.env.SIGNAL_BOT_NUMBER;
        if (!bridgeUrl || !botNumber) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Bridge not configured' }));
          return;
        }
        try {
          const client = await getIdTokenClient(bridgeUrl);
          const numberPath = encodeURIComponent(botNumber);
          const groupsRes = await client.request({
            url: `${bridgeUrl}/v1/groups/${numberPath}`,
            method: 'GET',
            headers: { 'Content-Type': 'application/json' },
          });
          const groups = (groupsRes as any)?.data || [];
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ groups: Array.isArray(groups) ? groups : [] }));
        } catch (err) {
          res.statusCode = 502;
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
            })
          );
        }
        return;
      }
      if (url.pathname === '/set-group-id') {
        const invite = url.searchParams.get('invite');
        const groupId = url.searchParams.get('groupId');
        if (!invite || !groupId) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'missing invite or groupId' }));
          return;
        }
        // Update all patches that have this invite link to use the groupId
        db.collection('patches')
          .get()
          .then((snap) => {
            const updates: Promise<any>[] = [];
            snap.docs.forEach((doc) => {
              const data = doc.data() as { subscribers?: Subscriber[] };
              const subscribers = data.subscribers || [];
              const updated = subscribers.map((s) => {
                if (s.type === 'group' && s.handle === invite) {
                  return { ...s, handle: groupId, groupId };
                }
                return s;
              });
              if (JSON.stringify(subscribers) !== JSON.stringify(updated)) {
                updates.push(doc.ref.update({ subscribers: updated }));
              }
            });
            return Promise.all(updates);
          })
          .then(() => {
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ success: true, message: 'Updated patches with groupId' }));
          })
          .catch((err) => {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(
              JSON.stringify({
                error: err instanceof Error ? err.message : String(err),
              })
            );
          });
        return;
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/plain');
      res.end('ok');
    } catch (err) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'text/plain');
      res.end('error');
    }
  });
  server.listen(port, () => {
    console.log(`Health server listening on ${port}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

