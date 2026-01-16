import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import WebSocket from 'ws';
import { GoogleAuth, IdTokenClient } from 'google-auth-library';
import http from 'http';
import { FieldValue } from 'firebase-admin/firestore';

type Subscriber = { 
  type: 'dm' | 'group'; 
  handle: string; 
  groupId?: string; 
  groupName?: string; 
  mentions?: string[];
  // Mapping of AWBW username -> Signal phone number for this subscriber
  playerPhoneMap?: Record<string, string>;
  scope?: 'my-turn' | 'all';
  playerName?: string;
  country?: string;
  funEnabled?: boolean;
  lastVerifiedAt?: any;
};
type PatchData = {
  gameId: string;
  subscribers: Subscriber[];
  patchId: string;
  experimentalExtended?: boolean;
};
type NextTurnMeta = {
  day?: number;
  playerName?: string;
  socketPlayerName?: string;
  playerId?: string | number;
  includeImage?: boolean;
  players?: string[];
  countries?: string[];
  gameName?: string;
  funEnabled?: boolean;
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

function shouldNotify(sub: Subscriber, currentPlayerName?: string) {
  if (!sub) return false;
  if (sub.scope === 'my-turn') {
    if (!currentPlayerName) return false;
    const target = (sub.playerName || '').toString().toLowerCase();
    return target.length > 0 && target === String(currentPlayerName).toLowerCase();
  }
  return true;
}

function readJsonBody<T>(req: http.IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8') || '{}';
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', (err) => reject(err));
  });
}

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

// Best-effort scrape of the current player from the game page to validate the socket payload
async function scrapeCurrentPlayerName(gameId: string): Promise<string | undefined> {
  try {
    const res = await fetch(gameLink(gameId), { cache: 'no-store' as any });
    const html = await res.text();
    // Try multiple patterns we have seen on AWBW pages
    const patterns = [
      /currentplayer["']?\s*[:=]\s*["']([^"']+)["']/i, // JS variable
      /currentPlayer["']?\s*[:=]\s*["']([^"']+)["']/i, // camelCase variant
      /Current\s+Turn[^<]*profile\.php\?username=([^"'>\s]+)/i, // Current Turn: link
      /profile\.php\?username=([A-Za-z0-9_]+)[^<]{0,60}(?:['’]|&rsquo;|&#8217;|&#039;|&apos;)s\s+turn/i, // "<name>'s turn" with straight/curly/entity apostrophes
    ];
    for (const pat of patterns) {
      const m = html.match(pat);
      if (m && m[1]) {
        return m[1];
      }
    }
  } catch (err) {
    console.error('Current player scrape failed', err);
  }
  return undefined;
}

async function buildMessage(gameId: string, meta: NextTurnMeta): Promise<RenderPayload> {
  const link = gameLink(gameId);
  const gameName = meta.gameName || `Game ${gameId}`;
  const enableFun = !!meta.funEnabled;
  const effectivePlayerName = meta.playerName || meta.socketPlayerName;

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
          playerName: effectivePlayerName,
          players: meta.players,
          gameName,
          link,
          enableFun,
          includeImage: false, // Keep images off for now to focus on reliable sends
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

// Track recent NextTurn events to prevent duplicate processing
const recentNextTurns = new Map<string, number>(); // key: `${gameId}-${day}-${playerId}`, value: timestamp
const NEXT_TURN_DEDUP_WINDOW_MS = 5000; // Ignore duplicate NextTurn events within 5 seconds

// Track pending send requests for cancellation
const pendingSends = new Map<string, AbortController>(); // key: `${gameId}-${subscriber.handle}`, value: AbortController

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
        const next = parsed?.NextTurn || parsed?.nextTurn || parsed || {};
        console.log(`NextTurn payload: ${JSON.stringify(next)}`);
        
        // Extract player info from NextTurn - try different field names
        const socketPlayerName =
          next.playerName || next.player_name || next.player || next.username || next.name;
        const currentPlayerId = next.playerId || next.player_id || next.playerId || next.id;
        const day = next.day;
        
        // Deduplication: Check if we've seen this exact NextTurn recently
        const dedupKey = `${data.gameId}-${day}-${currentPlayerId}`;
        const now = Date.now();
        const lastSeen = recentNextTurns.get(dedupKey);
        if (lastSeen && (now - lastSeen) < NEXT_TURN_DEDUP_WINDOW_MS) {
          console.log(`Skipping duplicate NextTurn for game ${data.gameId}, day ${day}, player ${currentPlayerId} (seen ${now - lastSeen}ms ago)`);
          return;
        }
        recentNextTurns.set(dedupKey, now);
        
        // Clean up old dedup entries (older than 1 minute)
        for (const [key, timestamp] of recentNextTurns.entries()) {
          if (now - timestamp > 60000) {
            recentNextTurns.delete(key);
          }
        }
        
        // Scrape current player name from the page to double-check socket payload
        const scrapedPlayerNamePromise = scrapeCurrentPlayerName(data.gameId).catch(() => undefined);

        const candidateSubs = data.subscribers || [];
        if (candidateSubs.length === 0) {
          console.log(`NextTurn received for game ${data.gameId} but no subscribers configured`);
          return;
        }

        console.log(`Processing NextTurn for game ${data.gameId}, subscribers: ${candidateSubs.length}`);
        
        const meta: NextTurnMeta = {
          day: next.day,
          socketPlayerName,
          playerId: currentPlayerId,
          includeImage: false, // Temporarily disabled to troubleshoot basic chat sending
        };
        const db = getFirestore();
        const msgRef = db.collection('messages').doc();
        msgRef
          .set({
            gameId: data.gameId,
            status: 'processing',
            createdAt: FieldValue.serverTimestamp(),
            recipients: candidateSubs.map((s) => s.handle),
          })
          .catch((err) => console.error('Pre-log message create failed', err));

        Promise.all([
          loadPlayers(data.gameId).catch(() => ({ players: [], countries: [] })),
          loadGameName(data.gameId),
          scrapedPlayerNamePromise,
        ])
          .then(([info, gameName, scrapedPlayerName]) => {
            if (scrapedPlayerName && socketPlayerName && scrapedPlayerName !== socketPlayerName) {
              console.log(
                `Player mismatch for game ${data.gameId}: socket=${socketPlayerName}, scraped=${scrapedPlayerName}`
              );
            }
            const effectivePlayerName = scrapedPlayerName || socketPlayerName;
            const deliverSubs = candidateSubs.filter((s) =>
              shouldNotify(s, effectivePlayerName)
            );
            if (deliverSubs.length === 0) {
              console.log(
                `NextTurn for ${data.gameId} but no matching subscribers after scrape for ${
                  effectivePlayerName || socketPlayerName || 'unknown player'
                }`
              );
              return;
            }
            const baseMeta: NextTurnMeta = {
              ...meta,
              players: info.players,
              countries: info.countries,
              gameName,
              playerName: effectivePlayerName,
            };
            msgRef
              .update({
                socketPlayerName: socketPlayerName || null,
                scrapedPlayerName: scrapedPlayerName || null,
                effectivePlayerName: effectivePlayerName || null,
                recipients: deliverSubs.map((s) => s.handle),
              })
              .catch((err) => console.error('Message log player update failed', err));
            const funSubs = deliverSubs.filter((s) => !!s.funEnabled);
            const classicSubs = deliverSubs.filter((s) => !s.funEnabled);

            const payloadPromises: Array<Promise<[boolean, RenderPayload]>> = [];
            if (classicSubs.length > 0) {
              payloadPromises.push(
                buildMessage(data.gameId, { ...baseMeta, funEnabled: false }).then((payload) => {
                  (payload as any).currentPlayerName = meta.playerName;
                  return [false, payload];
                })
              );
            }
            if (funSubs.length > 0) {
              payloadPromises.push(
                buildMessage(data.gameId, { ...baseMeta, funEnabled: true }).then((payload) => {
                  (payload as any).currentPlayerName = meta.playerName;
                  return [true, payload];
                })
              );
            }

            return Promise.all(payloadPromises).then((entries) => {
              const payloadMap = new Map<boolean, RenderPayload>(entries);
              const logPayload = payloadMap.get(false) || payloadMap.get(true);
              if (!logPayload) {
                throw new Error('No payload generated for subscribers');
              }
              console.log(
                `Render payload for game ${data.gameId}: textLen=${logPayload.text.length}, imageData=${
                  logPayload.imageData ? logPayload.imageData.length : 0
                }, imageUrl=${logPayload.imageUrl ? 'yes' : 'no'}, variants=${entries.length}`
              );
              msgRef
                .update({
                  status: 'rendered',
                  text: logPayload.text,
                  imageUrl: logPayload.imageUrl || null,
                  imageDataPresent: !!logPayload.imageData,
                  renderedAt: FieldValue.serverTimestamp(),
                })
                .catch((err) => console.error('Message log render update failed', err));

              msgRef
                .update({ status: 'sending', sendStartedAt: FieldValue.serverTimestamp() })
                .catch((err) => console.error('Message log send-start update failed', err));

              // Cancel any pending sends for this game/subscriber combination
              deliverSubs.forEach((sub) => {
                const pendingKey = `${data.gameId}-${sub.handle}`;
                const pendingController = pendingSends.get(pendingKey);
                if (pendingController) {
                  console.log(`Cancelling pending send for ${pendingKey}`);
                  pendingController.abort();
                  pendingSends.delete(pendingKey);
                }
              });

              Promise.all(
                deliverSubs.map((sub) => {
                  const pendingKey = `${data.gameId}-${sub.handle}`;
                  const abortController = new AbortController();
                  pendingSends.set(pendingKey, abortController);

                  const payload = payloadMap.get(!!sub.funEnabled) || logPayload;

                  return sendSignal(sub, payload, data.patchId, abortController.signal)
                    .then(() => {
                      pendingSends.delete(pendingKey);
                      console.log(
                        `Signal ${sub.type === 'group' ? 'group ' : ''}sent to ${
                          sub.handle
                        } for game ${data.gameId} (NextTurn, fun=${!!sub.funEnabled})`
                      );
                    })
                    .catch((err) => {
                      pendingSends.delete(pendingKey);
                      if (err.name === 'AbortError') {
                        console.log(`Send cancelled for ${pendingKey}`);
                        return; // Don't throw for cancelled requests
                      }
                      console.error('Signal send failed', err);
                      throw err;
                    });
                })
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
            });
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

async function sendSignal(recipient: Subscriber, payload: RenderPayload, patchId: string, abortSignal?: AbortSignal) {
  const bridgeUrl = process.env.SIGNAL_CLI_URL;
  const botNumber = process.env.SIGNAL_BOT_NUMBER;
  if (!bridgeUrl) throw new Error('SIGNAL_CLI_URL not set');
  if (!botNumber) throw new Error('SIGNAL_BOT_NUMBER not set');

  // Normalize DM handle to include leading '+' if missing (bridge rejects bare numbers)
  const normalizedHandle =
    recipient.type === 'dm' && /^\d+$/.test(recipient.handle)
      ? `+${recipient.handle}`
      : recipient.handle;

  console.log(
    `[sendSignal] Sending to ${recipient.type} subscriber: handle=${normalizedHandle}, groupId=${recipient.groupId || 'none'}`
  );

  // Check if already aborted
  if (abortSignal?.aborted) {
    throw new Error('Request aborted');
  }

  const client = await getIdTokenClient(bridgeUrl);

  let messageText = payload.text;
  
  // Determine who to mention: only the person whose turn it is (if we have the mapping)
  let mentionNumbers: string[] = [];
  if (recipient.type === 'group') {
    // If we have a playerPhoneMap and know whose turn it is, use that
    const currentPlayerName = (payload as any).currentPlayerName;
    if (currentPlayerName && recipient.playerPhoneMap) {
      const phone = recipient.playerPhoneMap[currentPlayerName];
      if (phone) {
        mentionNumbers = [phone];
        console.log(`Mentioning ${currentPlayerName} (${phone}) for their turn`);
      } else {
        console.log(`No phone mapping found for player: ${currentPlayerName}`);
      }
    } else if (Array.isArray(recipient.mentions) && recipient.mentions.length > 0) {
      // Fallback to explicit mentions if no player mapping
      mentionNumbers = recipient.mentions.filter((m) => typeof m === 'string' && m.trim().length > 0);
    }
  }
  
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
  // Image sending temporarily disabled to troubleshoot basic chat sending
  // if (payload.imageData && payload.imageContentType) {
  //   console.log(
  //     `Sending Signal attachment size=${payload.imageData.length} ct=${payload.imageContentType}`
  //   );
  //   // signal-cli-rest-api expects base64Attachments as plain base64 strings.
  //   baseData.base64Attachments = [payload.imageData];
  //   baseData.attachmentFilenames = [
  //     payload.imageFilename || `image-${Date.now()}.png`,
  //   ];
  // }

  if (recipient.type === 'group') {
    // Use the cached groupId if available, otherwise use handle
    // The groupId should be resolved when the subscriber is added (via web API)
    const groupId = recipient.groupId || recipient.handle;
    
    if (!groupId) {
      throw new Error('Group subscriber missing groupId. Please resolve the group ID first.');
    }
    
    console.log(`[sendSignal] Using cached groupId: ${groupId.substring(0, 50)}...`);
    
    // signal-cli-rest-api expects "groupId" and also requires a non-empty recipients array.
    // We'll use the clean base64 group id and set recipients to the botNumber to satisfy validation.
    console.log(`[sendSignal] Group payload base: ${JSON.stringify(baseData).substring(0, 500)}`);
    const cleanGroupId = groupId.startsWith('group.') ? groupId.substring(6) : groupId;

    // Bridge insists on a non-empty recipients array. Use mention numbers if present; otherwise bot number.
    const recipientsForSend =
      mentionNumbers.length > 0 ? mentionNumbers : [botNumber];

    const sendWithId = async (gid: string) => {
      if (abortSignal?.aborted) throw new Error('Request aborted');
      return client.request({
        url: `${bridgeUrl}/v2/send`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        data: { ...baseData, groupId: gid, recipients: recipientsForSend },
        timeout: 30000,
        signal: abortSignal,
      });
    };
    const idsToTry = cleanGroupId === groupId ? [cleanGroupId] : [cleanGroupId, groupId];

    try {
      for (const gid of idsToTry) {
        try {
          console.log(`[sendSignal] Attempting group send with id=${gid.substring(0, 60)}...`);
          return await sendWithId(gid);
        } catch (err: any) {
          const isTimeout = err?.message?.toString().includes('timeout');
          if (abortSignal?.aborted || err.name === 'AbortError') {
            throw new Error('Request aborted');
          }
          if (isTimeout) {
            console.warn('[sendSignal] Group send timeout, retrying once...');
            return await sendWithId(gid);
          }
          // If this was the last ID to try, rethrow; otherwise continue to next.
          if (gid === idsToTry[idsToTry.length - 1]) {
            // Log detailed bridge response to diagnose
            const status = err?.response?.status;
            const statusText = err?.response?.statusText;
            const data = err?.response?.data;
            console.error('[sendSignal] Group send failed', {
              groupId: gid,
              status,
              statusText,
              data: typeof data === 'string' ? data : JSON.stringify(data || {}),
              message: err?.message,
              raw: err?.response || err?.toString?.() || String(err),
            });
            throw err;
          } else {
            console.warn(`[sendSignal] Group send failed with id=${gid.substring(0, 60)}..., trying next id`);
          }
        }
      }
      // Should not reach here
      throw new Error('Group send failed for all attempted IDs');
    } catch (err: any) {
      throw err;
    }
  }

  if (abortSignal?.aborted) throw new Error('Request aborted');
  const doSendDm = async () => {
    if (abortSignal?.aborted) throw new Error('Request aborted');
    const dmRecipient =
      normalizedHandle.startsWith('+') || normalizedHandle.startsWith('group.')
        ? normalizedHandle
        : `+${normalizedHandle}`;
    return client.request({
      url: `${bridgeUrl}/v2/send`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      data: { ...baseData, recipients: [dmRecipient] },
      timeout: 30000,
      signal: abortSignal,
    });
  };
  try {
    return await doSendDm();
  } catch (err: any) {
    const isTimeout = err?.message?.toString().includes('timeout');
    if (abortSignal?.aborted || err.name === 'AbortError') {
      throw new Error('Request aborted');
    }
    if (isTimeout) {
      console.warn('[sendSignal] DM send timeout, retrying once...');
      return await doSendDm();
    }
    throw err;
  }
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
      if (url.pathname === '/send-verification' && _.method === 'POST') {
        const sharedSecret = process.env.INVITE_SHARED_SECRET;
        if (sharedSecret) {
          const headerSecret = _.headers['x-shared-secret'];
          if (headerSecret !== sharedSecret) {
            res.statusCode = 401;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Unauthorized' }));
            return;
          }
        }
        try {
          const body = await readJsonBody<{ phone?: string; message?: string }>(_ as any);
          const phone = (body.phone || '').trim();
          const message = (body.message || '').trim();
          if (!phone || !message) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'phone and message required' }));
            return;
          }
          await sendSignal(
            { type: 'dm', handle: phone },
            { text: message },
            'verification'
          );
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true }));
        } catch (err: any) {
          console.error('[send-verification] error', err);
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({
              error: err?.message || 'Failed to send verification',
            })
          );
        }
        return;
      }
      if (url.pathname === '/list-groups') {
        const bridgeUrl = process.env.SIGNAL_CLI_URL;
        const botNumber = process.env.SIGNAL_BOT_NUMBER;
        console.log(`[list-groups] Starting request. Bridge: ${bridgeUrl}, Bot: ${botNumber}`);
        if (!bridgeUrl || !botNumber) {
          console.error(`[list-groups] Bridge not configured. bridgeUrl=${!!bridgeUrl}, botNumber=${!!botNumber}`);
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Bridge not configured' }));
          return;
        }
        const startTime = Date.now();
        try {
          console.log(`[list-groups] Getting ID token client for ${bridgeUrl}`);
          const client = await getIdTokenClient(bridgeUrl);
          const numberPath = encodeURIComponent(botNumber);
          const requestUrl = `${bridgeUrl}/v1/groups/${numberPath}`;
          console.log(`[list-groups] Making request to: ${requestUrl}`);
          console.log(`[list-groups] Encoded number path: ${numberPath}`);
          // Try with a longer timeout - Signal bridge can be slow
          const timeoutMs = 30000; // 30 seconds
          console.log(`[list-groups] Setting timeout to ${timeoutMs}ms`);
          
          const groupsPromise = client.request({
            url: requestUrl,
            method: 'GET',
            headers: { 'Content-Type': 'application/json' },
            timeout: timeoutMs,
          });
          
          const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => {
              const elapsed = Date.now() - startTime;
              console.error(`[list-groups] Request timed out after ${elapsed}ms`);
              reject(new Error(`Request timeout after ${elapsed}ms`));
            }, timeoutMs)
          );
          
          console.log(`[list-groups] Racing promise and timeout...`);
          const groupsRes = await Promise.race([groupsPromise, timeoutPromise]) as any;
          const elapsed = Date.now() - startTime;
          console.log(`[list-groups] Request completed in ${elapsed}ms`);
          console.log(`[list-groups] Response type: ${typeof groupsRes}, keys: ${groupsRes ? Object.keys(groupsRes).join(', ') : 'null'}`);
          console.log(`[list-groups] Raw response data:`, JSON.stringify(groupsRes, null, 2).substring(0, 1000));
          
          // Try different response structures
          let groups = groupsRes?.data || groupsRes?.groups || groupsRes || [];
          console.log(`[list-groups] Initial groups extraction: type=${typeof groups}, isArray=${Array.isArray(groups)}`);
          
          if (!Array.isArray(groups)) {
            // Maybe it's wrapped differently
            if (groupsRes?.data && typeof groupsRes.data === 'object' && !Array.isArray(groupsRes.data)) {
              console.log(`[list-groups] Trying to extract array from object data`);
              groups = Object.values(groupsRes.data).filter((g: any) => g && typeof g === 'object');
              console.log(`[list-groups] Extracted ${groups.length} groups from object`);
            } else {
              console.log(`[list-groups] Response is not an array, setting to empty`);
              groups = [];
            }
          }
          
          console.log(`[list-groups] Final groups count: ${groups.length}`);
          if (groups.length > 0) {
            console.log(`[list-groups] First group:`, JSON.stringify(groups[0], null, 2).substring(0, 500));
            // Log a concise summary of up to 5 groups for debugging
            const summary = groups.slice(0, 5).map((g: any) => ({
              name: g.name || '(unnamed)',
              id: g.id || null,
              internal_id: g.internal_id || null,
            }));
            console.log(`[list-groups] Summary (up to 5):`, JSON.stringify(summary));
            if (groups.length > 5) {
              console.log(`[list-groups] ...and ${groups.length - 5} more`);
            }
          } else {
            console.log(`[list-groups] No groups found. Full response keys:`, Object.keys(groupsRes || {}));
            if (groupsRes?.data) {
              console.log(`[list-groups] Response.data type: ${typeof groupsRes.data}, value:`, JSON.stringify(groupsRes.data).substring(0, 200));
            }
          }
          
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ groups: Array.isArray(groups) ? groups : [] }));
          console.log(`[list-groups] Successfully returned ${groups.length} groups`);
        } catch (err: any) {
          const elapsed = Date.now() - startTime;
          const errMsg = err?.response?.data || err?.message || String(err);
          const errCode = err?.code || err?.response?.status;
          const errStatus = err?.response?.statusText;
          console.error(`[list-groups] Error after ${elapsed}ms:`, {
            message: errMsg,
            code: errCode,
            status: errStatus,
            stack: err?.stack?.substring(0, 500),
            response: err?.response ? {
              status: err.response.status,
              statusText: err.response.statusText,
              data: JSON.stringify(err.response.data).substring(0, 500),
            } : null,
          });
          res.statusCode = 502;
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({
              error: errMsg,
              code: errCode,
              details: `Request failed after ${elapsed}ms. The Signal bridge may be slow or the endpoint may not be working.`,
            })
          );
        }
        return;
      }
      if (url.pathname === '/group-members') {
        const groupId = url.searchParams.get('groupId');
        if (!groupId) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Missing groupId query parameter' }));
          return;
        }
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
            timeout: 30000,
          });
          const groups = (groupsRes as any)?.data || [];
          if (!Array.isArray(groups)) {
            throw new Error(`Groups list response is not an array`);
          }
          
          // Find the group by ID (try both id and internal_id formats)
          const group = groups.find((g: any) => {
            const gId = g.id || (g.internal_id ? `group.${g.internal_id}` : null);
            return gId === groupId || g.id === groupId || g.internal_id === groupId;
          });
          
          if (!group) {
            res.statusCode = 404;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: `Group with id "${groupId}" not found` }));
            return;
          }
          
          // Extract members - they might be in different fields
          const members = group.members || group.member || group.participants || [];
          const memberNumbers = Array.isArray(members)
            ? members.map((m: any) => {
                // Handle different member formats
                if (typeof m === 'string') return m;
                return m.number || m.phoneNumber || m.phone_number || m;
              })
            : [];
          
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            groupId,
            groupName: group.name || '(unnamed)',
            members: memberNumbers.filter((n: any) => n && typeof n === 'string'),
            rawGroup: group, // Include full group object for debugging
          }));
        } catch (err: any) {
          console.error('[group-members] Error:', err);
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            error: err?.message || 'Failed to get group members',
            details: err?.response?.data || err?.stack?.substring(0, 500),
          }));
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

