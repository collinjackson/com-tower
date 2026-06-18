import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import WebSocket from 'ws';
import { GoogleAuth, IdTokenClient } from 'google-auth-library';
import http from 'http';
import { FieldValue } from 'firebase-admin/firestore';

/** once = first notification only; hourly = at most once per hour; undefined = every turn */
export type NotifyFrequency = 'once' | 'hourly';

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
  /** When to send: once, hourly; omit = every turn */
  notifyFrequency?: NotifyFrequency;
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

/** Returns true if this subscriber should get a notification based on notifyFrequency and last-sent times.
 *  - every turn (undefined): notify on every turn change.
 *  - hourly: notify immediately on turn changes (same as every turn); no throttle.
 *  - once: only the first notification for this game. */
function shouldNotifyByFrequency(
  sub: Subscriber,
  lastSentMsByHandle: Map<string, number>
): boolean {
  const freq = sub.notifyFrequency;
  if (freq === undefined) return true; // every turn
  if (freq === 'hourly') return true; // notify immediately on turn changes (no max-once-per-hour throttle)
  const lastSent = lastSentMsByHandle.get(sub.handle);
  if (freq === 'once') return lastSent === undefined;
  return true;
}

/** Load map of handle -> latest sent timestamp (ms) for this game from messages collection.
 *  Requires composite index: messages (gameId asc, status asc, sentAt desc). */
async function getLastSentMap(db: Firestore, gameId: string): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  try {
    const snap = await db
      .collection('messages')
      .where('gameId', '==', gameId)
      .where('status', '==', 'sent')
      .orderBy('sentAt', 'desc')
      .limit(50)
      .get();
    for (const d of snap.docs) {
      const data = d.data() as { sentAt?: { toDate: () => Date }; deliveries?: Array<{ handle: string; status: string }> };
      const sentAt = data.sentAt?.toDate?.();
      if (!sentAt || !Array.isArray(data.deliveries)) continue;
      const ts = sentAt.getTime();
      for (const del of data.deliveries) {
        if (del.status === 'sent' && del.handle && !map.has(del.handle)) map.set(del.handle, ts);
      }
    }
  } catch (err) {
    console.warn('getLastSentMap failed (index may be missing)', err);
  }
  return map;
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

/** Check if the game has ended by scraping the AWBW game page. */
async function isGameEnded(gameId: string): Promise<boolean> {
  try {
    const res = await fetch(gameLink(gameId), { cache: 'no-store' as any });
    const html = await res.text();
    if (/game\s+over|game over/i.test(html)) return true;
    if (/winner\s*:|\bwinner\b.*(?:defeated|wins)/i.test(html)) return true;
    if (/has\s+ended|game\s+has\s+ended/i.test(html)) return true;
    if (/games_status\s*[=:]\s*["']?(?:finished|ended|complete|over)/i.test(html)) return true;
    if (/game_status\s*[=:]\s*["']?(?:finished|ended|complete|over)/i.test(html)) return true;
    return false;
  } catch (err) {
    console.warn('isGameEnded check failed', gameId, err);
    return false;
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

type AwbwUnit = {
  name: string;
  code?: string;
  hp: number;
  lowFuel: boolean;
  lowAmmo: boolean;
  terrainTile?: string; // AWBW terrain/aw1 tile filename the unit stands on (for the sprite backdrop)
};

// AWBW country code -> lowercase army name used in building tile filenames (e.g. orangestarhq.gif).
const ARMY_FULLNAME: Record<string, string> = {
  os: 'orangestar', bm: 'bluemoon', ge: 'greenearth', yc: 'yellowcomet', bh: 'blackhole',
  rf: 'redfire', gs: 'greysky', bd: 'browndesert', ab: 'amberblaze', js: 'jadesun',
  ci: 'cobaltice', pc: 'pinkcosmos', tg: 'tealgalaxy', pl: 'purplelightning', wn: 'whitenova',
};
// Building terrain_name -> tile word (army prefix added unless neutral; silo is always neutral art).
const BUILDING_WORD: Record<string, string> = {
  Headquarters: 'hq', HQ: 'hq', City: 'city', Base: 'base', Factory: 'base',
  Airport: 'airport', Port: 'port', Seaport: 'port',
  'Com Tower': 'comtower', 'Comm Tower': 'comtower', 'Communications Tower': 'comtower',
  Lab: 'lab', Laboratory: 'lab', 'Missile Silo': 'missilesilo',
};
// Base terrain_name -> verified tile filename. ('Wood' aw1 art is wrong/blue, so use plains.)
const BASE_TILE: Record<string, string> = {
  Plain: 'plain', Mountain: 'mountain', Sea: 'sea', Reef: 'sea', Shoal: 'sea',
  Wood: 'plain', Road: 'plain', Bridge: 'plain', River: 'plain',
};

/** Resolve the current player from the game page: username, army, and their REAL living units.
 *  AWBW exposes `currentTurn = <players_id>` and a `unitsInfo = {...}` map of placed units
 *  (each with units_players_id, units_name, units_hit_points, units_fuel, countries_code). */
async function resolveCurrentTurn(gameId: string): Promise<
  | {
      username?: string;
      countryCode?: string;
      countryName?: string;
      units: AwbwUnit[];
    }
  | undefined
> {
  try {
    const res = await fetch(gameLink(gameId), { cache: 'no-store' as any });
    const html = await res.text();
    const cur = html.match(/currentTurn\s*=\s*(\d+)/);
    if (!cur) return undefined;
    const curId = cur[1];
    const idMatch = new RegExp(`"players_id"\\s*:\\s*${curId}\\b`).exec(html);
    const before = idMatch ? html.slice(Math.max(0, idMatch.index - 500), idMatch.index) : '';
    const after = idMatch ? html.slice(idMatch.index, idMatch.index + 300) : '';
    const username = [...before.matchAll(/"users_username"\s*:\s*"([^"]+)"/g)].pop()?.[1];
    // Keep code + name from the SAME (tight) window after players_id for consistency.
    const countryCode = after.match(/"countries_code"\s*:\s*"([a-z]{2,3})"/i)?.[1];
    const countryName = after.match(/"countries_name"\s*:\s*"([^"]+)"/)?.[1];

    // Per-unit-type max fuel/ammo, to decide if the game would show a low warning.
    const maxByType: Record<string, { fuel: number; ammo: number }> = {};
    const gm = html.match(/genericUnits\s*=\s*(\{[^;]*\})\s*;/);
    if (gm) {
      try {
        const gu = JSON.parse(gm[1]) as Record<string, any>;
        for (const [name, def] of Object.entries(gu)) {
          maxByType[name] = { fuel: Number(def.units_fuel) || 0, ammo: Number(def.units_ammo) || 0 };
        }
      } catch (e) {
        console.warn('genericUnits parse failed', e);
      }
    }

    // Map data for the terrain backdrop: terrain name per (x,y), buildings per [x][y], player->code.
    const terrainByXY = new Map<string, string>();
    try {
      const tm = html.match(/terrainInfo\s*=\s*(\[[^;]*\])\s*;/);
      if (tm) {
        const walk = (o: any) => {
          if (Array.isArray(o)) o.forEach(walk);
          else if (o && typeof o === 'object' && o.tiles_x !== undefined)
            terrainByXY.set(`${o.tiles_x},${o.tiles_y}`, o.terrain_name);
        };
        walk(JSON.parse(tm[1]));
      }
    } catch (e) {
      console.warn('terrainInfo parse failed', e);
    }
    let buildingsByXY: Record<string, Record<string, any>> = {};
    try {
      const bm = html.match(/buildingsInfo\s*=\s*(\{[^;]*\})\s*;/);
      if (bm) buildingsByXY = JSON.parse(bm[1]);
    } catch (e) {
      console.warn('buildingsInfo parse failed', e);
    }

    // The current player's actual living units (grounds the unit pick + voice in reality).
    let units: AwbwUnit[] = [];
    const um = html.match(/unitsInfo\s*=\s*(\{[^;]*\})\s*;/);
    if (um) {
      try {
        const obj = JSON.parse(um[1]) as Record<string, any>;
        // players_id -> countries_code (for coloring buildings the unit stands on).
        const playerCode: Record<string, string> = {};
        for (const u of Object.values(obj)) {
          if (u.units_players_id && u.countries_code) playerCode[String(u.units_players_id)] = u.countries_code;
        }
        const tileAt = (x: number, y: number): string => {
          const b = buildingsByXY[String(x)]?.[String(y)];
          if (b?.terrain_name) {
            const word = BUILDING_WORD[b.terrain_name as string];
            if (word === 'missilesilo') return 'missilesilo';
            if (word) {
              const code = b.buildings_players_id ? playerCode[String(b.buildings_players_id)] : undefined;
              const full = code ? ARMY_FULLNAME[code] : 'neutral';
              if (full) return `${full}${word}`;
            }
          }
          const tn = terrainByXY.get(`${x},${y}`);
          return (tn && BASE_TILE[tn]) || 'plain';
        };
        units = Object.values(obj)
          .filter((u) => String(u.units_players_id) === curId && Number(u.units_hit_points) > 0)
          .map((u) => {
            const name = String(u.units_name || '');
            const fuel = Number(u.units_fuel);
            const ammo = Number(u.units_ammo);
            const fuelPerTurn = Number(u.units_fuel_per_turn) || 0;
            const max = maxByType[name] || { fuel: 0, ammo: 0 };
            // Low fuel: <=20% of max, or (for fuel-burning air/naval) within ~2 turns of stranding.
            const lowFuel =
              max.fuel > 0 &&
              (fuel <= Math.ceil(max.fuel * 0.2) || (fuelPerTurn > 0 && fuel <= fuelPerTurn * 2));
            // Low ammo: only for units that carry ammo, at/under ~1/3 of max.
            const lowAmmo = max.ammo > 0 && ammo <= Math.max(1, Math.floor(max.ammo / 3));
            return {
              name,
              code: u.countries_code || undefined,
              hp: Number(u.units_hit_points),
              lowFuel,
              lowAmmo,
              terrainTile: tileAt(Number(u.units_x), Number(u.units_y)),
            };
          })
          .filter((u) => u.name);
      } catch (e) {
        console.warn('unitsInfo parse failed', e);
      }
    }
    return { username, countryCode, countryName, units };
  } catch (err) {
    console.error('resolveCurrentTurn failed', err);
    return undefined;
  }
}

/** Just the current player's username (used by the backstop poll's change check). */
async function resolveCurrentPlayerName(gameId: string): Promise<string | undefined> {
  return (await resolveCurrentTurn(gameId))?.username;
}

async function buildMessage(
  gameId: string,
  meta: NextTurnMeta,
  recentChat?: Array<{ name?: string; text: string }>,
  army?: { code?: string; name?: string },
  unit?: { name: string; hp: number; lowFuel: boolean; lowAmmo: boolean; terrainTile?: string }
): Promise<RenderPayload> {
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
          recentChat: enableFun && recentChat?.length ? recentChat : undefined,
          army: enableFun && army?.code ? army : undefined,
          unit: enableFun && unit ? unit : undefined,
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
          return {
            text,
            imageData: data.imageData || undefined,
            imageContentType: data.imageContentType || undefined,
            imageFilename: data.imageFilename || undefined,
          };
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
const SIGNAL_RECEIVE_POLL_MS = 5000; // Poll for incoming Signal messages every 5 seconds

// ── Receive diagnostics ──────────────────────────────────────────────────────
// The bridge can run in poll (normal/native) mode where GET /v1/receive returns an
// array, or json-rpc mode where receiving is a WebSocket. We support both and expose
// what we've seen via the /debug/receive endpoint so receive can be verified without
// Cloud Run log access.
type ReceiverMode = 'unknown' | 'poll' | 'ws';
let receiverMode: ReceiverMode = 'unknown';
let receiverWs: WebSocket | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let wsFailCount = 0;
let lastReceiveError: string | null = null;
let lastReceiveAt: number | null = null;
const recentRawReceives: Array<{ at: string; raw: unknown }> = [];
const MAX_RECENT_RECEIVES = 25;

function recordRaw(raw: unknown) {
  lastReceiveAt = Date.now();
  recentRawReceives.push({ at: new Date().toISOString(), raw });
  while (recentRawReceives.length > MAX_RECENT_RECEIVES) recentRawReceives.shift();
}

// Track pending send requests for cancellation
const pendingSends = new Map<string, AbortController>(); // key: `${gameId}-${subscriber.handle}`, value: AbortController

// Active sockets by patchId so we can stop on game end or patch removal
const GAME_ENDED_CHECK_MS = 30 * 60 * 1000; // 30 minutes
const HOURLY_REMINDER_MS = 60 * 60 * 1000; // 1 hour
/** Minimum gap between any two notifications to the same subscriber (avoid burst). */
const MIN_NOTIFICATION_GAP_MS = 30 * 60 * 1000; // 30 minutes
type ActiveSocketState = {
  ws: WebSocket;
  shouldReopen: boolean;
  checkInterval?: ReturnType<typeof setInterval>;
  data: PatchData; // so hourly job can send reminders
};

const activeSockets = new Map<string, ActiveSocketState>();

function startSocket(data: PatchData) {
  const { patchId, gameId } = data;
  const url = buildAwbwSocketUrl(gameId);
  console.log(`Connecting to ${url} for patch ${patchId} with ${data.subscribers?.length || 0} subscribers`);

  // If we already have a socket for this patch, stop it first (e.g. patch data updated or duplicate)
  const existing = activeSockets.get(patchId);
  if (existing) {
    existing.shouldReopen = false;
    if (existing.checkInterval) clearInterval(existing.checkInterval);
    try {
      existing.ws.close();
    } catch {
      // ignore
    }
    activeSockets.delete(patchId);
  }

  const ws = new WebSocket(url);
  const state: ActiveSocketState = { ws, shouldReopen: true, data };
  activeSockets.set(patchId, state);

  const stopMonitoring = (reason: string) => {
    if (!state.shouldReopen) return;
    console.log(`Stopping monitoring game ${gameId} (patch ${patchId}): ${reason}`);
    state.shouldReopen = false;
    if (state.checkInterval) {
      clearInterval(state.checkInterval);
      state.checkInterval = undefined;
    }
    activeSockets.delete(patchId);
    try {
      ws.close();
    } catch {
      // ignore
    }
  };

  const reopen = () => {
    if (!state.shouldReopen) return;
    console.log(`Reconnecting to ${gameId} after close/error`);
    activeSockets.delete(patchId);
    if (state.checkInterval) clearInterval(state.checkInterval);
    setTimeout(() => startSocket(data), 1000);
  };

  // Periodic check: has the game ended? (e.g. via AWBW page)
  state.checkInterval = setInterval(() => {
    if (!state.shouldReopen) return;
    isGameEnded(gameId)
      .then((ended) => {
        if (ended) stopMonitoring('game ended (page check)');
      })
      .catch(() => {});
  }, GAME_ENDED_CHECK_MS);

  ws.on('open', () => {
    console.log(`WS open for game ${gameId} (patch ${patchId})`);
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
        (parsed?.GameOver && 'GameOver') ||
        (parsed?.GameEnd && 'GameEnd') ||
        (parsed?.game_over && 'GameOver') ||
        'unknown';
      console.log(`WS message for game ${data.gameId}: type=${msgType}`);
      if (msgType === 'GameOver' || msgType === 'GameEnd') {
        stopMonitoring('game over (WebSocket)');
        return;
      }
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
        Promise.all([
          loadPlayers(data.gameId).catch(() => ({ players: [], countries: [] })),
          loadGameName(data.gameId),
          scrapedPlayerNamePromise,
          getLastSentMap(db, data.gameId),
        ])
          .then(([info, gameName, scrapedPlayerName, lastSentMap]) => {
            if (scrapedPlayerName && socketPlayerName && scrapedPlayerName !== socketPlayerName) {
              console.log(
                `Player mismatch for game ${data.gameId}: socket=${socketPlayerName}, scraped=${scrapedPlayerName}`
              );
            }
            const effectivePlayerName = scrapedPlayerName || socketPlayerName;
            let deliverSubs = candidateSubs
              .filter((s) => shouldNotify(s, effectivePlayerName))
              .filter((s) => shouldNotifyByFrequency(s, lastSentMap));
            // Avoid two notifications less than 30 minutes apart (skip if we sent recently)
            deliverSubs = deliverSubs.filter((s) => {
              const lastSent = lastSentMap.get(s.handle);
              if (lastSent === undefined) return true;
              if (Date.now() - lastSent < MIN_NOTIFICATION_GAP_MS) {
                console.log(`Skipping notify to ${s.handle} for game ${data.gameId}: last sent ${Math.round((Date.now() - lastSent) / 60000)}m ago (< 30m gap)`);
                return false;
              }
              return true;
            });
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
            sendNotifications(data, baseMeta, deliverSubs, 'NextTurn').catch(() => {});
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
    if (state.checkInterval) {
      clearInterval(state.checkInterval);
      state.checkInterval = undefined;
    }
    activeSockets.delete(patchId);
    if (state.shouldReopen) reopen();
  });
}

/** Send notifications to deliverSubs (build message, send Signal, log to messages). Used for NextTurn and hourly reminders. */
async function sendNotifications(
  data: PatchData,
  baseMeta: NextTurnMeta,
  deliverSubs: Subscriber[],
  source: 'NextTurn' | 'hourly'
): Promise<void> {
  const db = getFirestore();
  const msgRef = db.collection('messages').doc();
  await msgRef.set({
    gameId: data.gameId,
    status: 'processing',
    createdAt: FieldValue.serverTimestamp(),
    recipients: deliverSubs.map((s) => s.handle),
  }).catch((err) => console.error('Pre-log message create failed', err));

  const funSubs = deliverSubs.filter((s) => !!s.funEnabled);
  const classicSubs = deliverSubs.filter((s) => !s.funEnabled);
  const payloadPromises: Array<Promise<[boolean, RenderPayload]>> = [];
  if (classicSubs.length > 0) {
    payloadPromises.push(
      buildMessage(data.gameId, { ...baseMeta, funEnabled: false }).then((payload) => {
        (payload as any).currentPlayerName = baseMeta.playerName;
        return [false, payload];
      })
    );
  }
  if (funSubs.length > 0) {
    payloadPromises.push(
      buildMessage(data.gameId, { ...baseMeta, funEnabled: true }).then((payload) => {
        (payload as any).currentPlayerName = baseMeta.playerName;
        return [true, payload];
      })
    );
  }

  let entries: [boolean, RenderPayload][];
  try {
    entries = await Promise.all(payloadPromises);
  } catch (err) {
    console.error('Message build failed', err);
    await msgRef.update({
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
    }).catch(() => {});
    return;
  }

  const payloadMap = new Map<boolean, RenderPayload>(entries);
  const logPayloadClassic = payloadMap.get(false);
  const logPayloadFun = payloadMap.get(true);
  const logPayload = logPayloadClassic || logPayloadFun;
  if (!logPayload) {
    await msgRef.update({ status: 'failed', error: 'No payload generated' }).catch(() => {});
    return;
  }
  console.log(
    `Render payload for game ${data.gameId} (${source}): textLen=${logPayload.text.length}, recipients=${deliverSubs.length}`
  );
  await msgRef.update({
    status: 'rendered',
    text: logPayload.text,
    textClassic: logPayloadClassic?.text || null,
    textFun: logPayloadFun?.text || null,
    recipientsClassic: classicSubs.map((s) => s.handle),
    recipientsFun: funSubs.map((s) => s.handle),
    imageUrl: logPayload.imageUrl || null,
    imageDataPresent: !!logPayload.imageData,
    renderedAt: FieldValue.serverTimestamp(),
  }).catch((err) => console.error('Message log render update failed', err));
  await msgRef.update({ status: 'sending', sendStartedAt: FieldValue.serverTimestamp() }).catch(() => {});

  const deliveries: Array<{ handle: string; variant: 'fun' | 'classic'; status: 'sent' | 'failed'; error?: string }> = [];
  deliverSubs.forEach((sub) => {
    const pendingKey = `${data.gameId}-${sub.handle}`;
    const pendingController = pendingSends.get(pendingKey);
    if (pendingController) {
      pendingController.abort();
      pendingSends.delete(pendingKey);
    }
  });

  const results = await Promise.allSettled(
    deliverSubs.map((sub) => {
      const pendingKey = `${data.gameId}-${sub.handle}`;
      const abortController = new AbortController();
      pendingSends.set(pendingKey, abortController);
      const payload = payloadMap.get(!!sub.funEnabled) || logPayload;
      const variant: 'fun' | 'classic' = sub.funEnabled ? 'fun' : 'classic';
      return sendSignal(sub, payload, data.patchId, abortController.signal)
        .then(() => {
          pendingSends.delete(pendingKey);
          deliveries.push({ handle: sub.handle, variant, status: 'sent' });
          console.log(`Signal sent to ${sub.handle} for game ${data.gameId} (${source})`);
        })
        .catch((err) => {
          pendingSends.delete(pendingKey);
          if (err.name === 'AbortError') return;
          deliveries.push({
            handle: sub.handle,
            variant,
            status: 'failed',
            error: err instanceof Error ? err.message : String(err),
          });
          console.error('Signal send failed', err);
          throw err;
        });
    })
  );
  const firstError = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  const hasFailed = deliveries.some((d) => d.status === 'failed');
  const hasSent = deliveries.some((d) => d.status === 'sent');
  const messageStatus = hasFailed && hasSent ? 'partial-failed' : hasFailed ? 'failed' : 'sent';
  await msgRef.update({
    status: messageStatus,
    ...(firstError ? { error: firstError.reason instanceof Error ? firstError.reason.message : String(firstError.reason) } : {}),
    sentAt: FieldValue.serverTimestamp(),
    deliveries,
  }).catch((err) => console.error('Message log final update failed', err));
}

/** Run hourly reminders for subscribers with notifyFrequency === 'hourly': send if still their turn and last sent ≥ 1h ago. */
async function runHourlyReminders(): Promise<void> {
  const db = getFirestore();
  for (const [_patchId, state] of activeSockets) {
    const data = state.data;
    if (!data?.subscribers?.length) continue;
    const hourlySubs = data.subscribers.filter((s) => s.notifyFrequency === 'hourly');
    if (hourlySubs.length === 0) continue;

    const [currentPlayerName, lastSentMap, info, gameName] = await Promise.all([
      scrapeCurrentPlayerName(data.gameId),
      getLastSentMap(db, data.gameId),
      loadPlayers(data.gameId).catch(() => ({ players: [] as string[], countries: [] as string[] })),
      loadGameName(data.gameId),
    ]);
    const deliverSubs = hourlySubs.filter((s) => {
      if (!shouldNotify(s, currentPlayerName)) return false;
      const lastSent = lastSentMap.get(s.handle);
      if (lastSent === undefined) return true;
      const gap = Date.now() - lastSent;
      if (gap < MIN_NOTIFICATION_GAP_MS) return false; // avoid two notifications < 30 min apart
      return gap >= HOURLY_REMINDER_MS;
    });
    if (deliverSubs.length === 0) continue;

    const baseMeta: NextTurnMeta = {
      playerName: currentPlayerName,
      players: info.players,
      countries: info.countries,
      gameName,
      includeImage: false,
    };
    await sendNotifications(data, baseMeta, deliverSubs, 'hourly');
  }
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
    const rawId = recipient.groupId || recipient.handle;
    if (!rawId) {
      throw new Error('Group subscriber missing groupId.');
    }
    // signal-cli-rest-api (v2/send) sends to a group by putting "group.<base64(internalId)>"
    // in the recipients array. Received messages give us groupInfo.groupId = the raw internal_id
    // (base64 of the group master id); the create/list "id" field is already "group.<base64>".
    const groupRecipient = rawId.startsWith('group.')
      ? rawId
      : `group.${Buffer.from(rawId, 'utf8').toString('base64')}`;
    console.log(`[sendSignal] Group send to ${groupRecipient.substring(0, 60)}...`);

    const doGroupSend = async () => {
      if (abortSignal?.aborted) throw new Error('Request aborted');
      return client.request({
        url: `${bridgeUrl}/v2/send`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        data: { ...baseData, recipients: [groupRecipient] },
        timeout: 30000,
        signal: abortSignal,
      });
    };

    try {
      return await doGroupSend();
    } catch (err: any) {
      if (abortSignal?.aborted || err.name === 'AbortError') {
        throw new Error('Request aborted');
      }
      if (err?.message?.toString().includes('timeout')) {
        console.warn('[sendSignal] Group send timeout, retrying once...');
        return await doGroupSend();
      }
      const status = err?.response?.status;
      const data = err?.response?.data;
      console.error('[sendSignal] Group send failed', {
        groupRecipient,
        status,
        data: typeof data === 'string' ? data : JSON.stringify(data || {}),
        message: err?.message,
      });
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


// ── Signal slash-command bot ─────────────────────────────────────────────────

function extractGameIdFromArg(arg?: string): string | null {
  if (!arg) return null;
  const urlMatch = arg.match(/games_id=(\d+)/);
  if (urlMatch) return urlMatch[1];
  const ctMatch = arg.match(/\/game\/(\d+)/);
  if (ctMatch) return ctMatch[1];
  if (/^\d{5,8}$/.test(arg.trim())) return arg.trim();
  return null;
}

/** Low-level group send to the bridge (v2/send), with optional ACI mentions and one attachment. */
async function sendGroupRaw(
  groupId: string,
  message: string,
  mentions?: Array<{ author: string; start: number; length: number }>,
  attachment?: { dataB64: string; contentType: string; filename: string }
): Promise<void> {
  const bridgeUrl = process.env.SIGNAL_CLI_URL;
  const botNumber = process.env.SIGNAL_BOT_NUMBER;
  if (!bridgeUrl || !botNumber) throw new Error('Signal bridge not configured');
  // v2/send takes the group as "group.<base64(internalId)>" in recipients.
  const groupRecipient = groupId.startsWith('group.')
    ? groupId
    : `group.${Buffer.from(groupId, 'utf8').toString('base64')}`;
  const client = await getIdTokenClient(bridgeUrl);
  const data: any = { number: botNumber, message, recipients: [groupRecipient] };
  if (mentions && mentions.length > 0) data.mentions = mentions;
  if (attachment?.dataB64) {
    // signal-cli-rest-api base64_attachments item: data:<mime>;filename=<name>;base64,<data>
    data.base64_attachments = [
      `data:${attachment.contentType};filename=${attachment.filename};base64,${attachment.dataB64}`,
    ];
  }
  await client.request({
    url: `${bridgeUrl}/v2/send`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    data,
    timeout: 45000,
  });
}

async function sendGroupReply(groupId: string, text: string): Promise<void> {
  try {
    await sendGroupRaw(groupId, text);
  } catch (err) {
    console.error('[bot] Failed to send group reply:', err);
  }
}

/** Join a Signal group via its invite link, by calling the VM join-shim
 *  (which forwards joinGroup to the signal-cli daemon — not exposed via the bridge REST API). */
async function joinViaLink(
  uri: string,
  sender?: { aci?: string; number?: string; name?: string }
): Promise<void> {
  const shimUrl = process.env.JOIN_SHIM_URL;
  const secret = process.env.JOIN_SHIM_SECRET || '';
  if (!shimUrl) {
    console.warn('[bot] JOIN_SHIM_URL not set; cannot auto-join from invite link');
    return;
  }
  try {
    const res = await fetch(`${shimUrl}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Secret': secret },
      body: JSON.stringify({ uri }),
    });
    const data: any = await res.json().catch(() => ({}));
    const groupId = data?.result?.groupId;
    const errMsg = data?.error?.message;
    console.log(`[bot] joinViaLink -> HTTP ${res.status} groupId=${groupId || '?'} ${errMsg ? `error="${errMsg}"` : 'ok'}`);
    if (res.ok && groupId && !errMsg) {
      // Whoever sent the invite link becomes the first mod (if none recorded yet).
      let firstMod = false;
      if (sender?.aci) {
        const ref = ggRef(groupId);
        const snap = await ref.get();
        const existing = (snap.data() as GroupGame | undefined)?.mods || [];
        if (existing.length === 0) {
          await ref.set(
            {
              groupId,
              status: snap.exists ? (snap.data() as GroupGame).status || 'pending' : 'pending',
              mods: [sender.aci],
              createdBy: { aci: sender.aci, number: sender.number || null },
              updatedAt: FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
          firstMod = true;
        }
      }
      await sendGroupReply(
        groupId,
        `👋 Com Tower reporting in.${firstMod && sender?.name ? ` ${sender.name} is the mod.` : ''}\n` +
          'Set the game with /game <AWBW link>. Players can optionally run /iam <awbw_name> for a personal @ping on their turn. /help for all commands.'
      );
    }
  } catch (err) {
    console.error('[bot] joinViaLink failed:', err);
  }
}

const HELP_TEXT =
  '📋 Com Tower — AWBW turn alerts\n' +
  '/game <link>         — watch an AWBW game (mod)\n' +
  '/iam <awbw_name>     — get an @ping on your turn (optional)\n' +
  '/setplayer @x <name> — @ping a member on their turn (mod, optional)\n' +
  '/unsetplayer @x      — remove a mapping (mod)\n' +
  '/players             — show the roster\n' +
  '/addmod @x           — make someone a mod (mod)\n' +
  '/removemod @x        — remove a mod (mod)\n' +
  '/fun [on|off]        — flavor text (mod)\n' +
  '/status              — current state\n' +
  '/stop                — stop watching (mod)\n' +
  '/ping                — connectivity check';

type PlayerMapping = {
  aci: string;
  number?: string;
  displayName?: string;
  claimedBy: 'self' | 'mod';
  claimedAt?: any;
};
type GroupGame = {
  groupId: string;
  gameId?: string;
  gameName?: string;
  status: 'pending' | 'active' | 'stopped' | 'ended';
  createdBy?: { aci?: string; number?: string };
  mods?: string[];
  players?: Record<string, PlayerMapping>;
  funEnabled?: boolean;
  scope?: 'mine' | 'all';
  lastTurn?: { day?: number | null; awbwUsername?: string };
};
type CmdCtx = {
  groupId: string;
  senderAci?: string;
  senderNumber?: string;
  senderName?: string;
  cmd: string;
  args: string[];
  mentions: Array<{ uuid?: string; number?: string; name?: string }>;
};

function ggRef(groupId: string) {
  return getFirestore().collection('groupGames').doc(groupId);
}
/** Permissive mod check: if no mods recorded yet, anyone may act (friendly games). */
function isGgMod(gg: GroupGame | undefined, aci?: string): boolean {
  if (!gg) return true;
  const mods = gg.mods || [];
  if (mods.length === 0) return true;
  return !!aci && mods.includes(aci);
}

async function handleSignalCommand(ctx: CmdCtx): Promise<void> {
  const { groupId, cmd, args, senderAci, senderNumber, senderName, mentions } = ctx;
  const reply = (t: string) => sendGroupReply(groupId, t);

  if (cmd === '/ping') {
    await reply('🟢 pong — Com Tower can hear this group. Receiving is working.');
    return;
  }
  if (cmd === '/help') {
    await reply(HELP_TEXT);
    return;
  }

  const snap = await ggRef(groupId).get();
  const gg = snap.exists ? ({ ...(snap.data() as GroupGame), groupId }) : undefined;

  if (cmd === '/game') {
    const gameId = extractGameIdFromArg(args[0]);
    if (!gameId) {
      await reply('Usage: /game <AWBW game link or id>');
      return;
    }
    if (gg && !isGgMod(gg, senderAci)) {
      await reply('Only a mod can change the game. (The mod is whoever brought the bot into this group.)');
      return;
    }
    const [info, gameName] = await Promise.all([
      loadPlayers(gameId).catch(() => ({ players: [] as string[], countries: [] as string[] })),
      loadGameName(gameId),
    ]);
    const existingPlayers = gg?.players || {};
    await ggRef(groupId).set(
      {
        groupId,
        gameId,
        gameName: gameName || null,
        status: 'active',
        createdBy: gg?.createdBy || { aci: senderAci || null, number: senderNumber || null },
        mods: gg?.mods || (senderAci ? [senderAci] : []),
        players: existingPlayers,
        funEnabled: gg?.funEnabled ?? true, // fun mode is the default for new games; preserves an explicit /fun off
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    const roster = info.players || [];
    const mapped = new Set(Object.keys(existingPlayers).map((s) => s.toLowerCase()));
    const switching = !!gg?.gameId && gg.gameId !== gameId;
    // Carried-over mappings that apply to the new game's roster (mappings are kept across switches).
    const keptRelevant = roster.filter((p) => mapped.has(p.toLowerCase())).length;
    let msg = `📡 Watching game ${gameId}${gameName ? ` (${gameName})` : ''}.\n${gameLink(gameId)}\n`;
    if (switching && keptRelevant > 0)
      msg += `♻️ Kept ${keptRelevant} player mapping${keptRelevant === 1 ? '' : 's'} from before.\n`;
    if (roster.length) msg += `Players: ${roster.join(', ')}\n`;
    msg +=
      `I'll post here each turn. To get a personal @ping on your turn, run /iam <your_awbw_name> ` +
      `(optional — or just turn on notifications for this group).`;
    await reply(msg);
    console.log(`[gg] /game ${gameId} set for group ${groupId.substring(0, 16)}`);
    return;
  }

  if (!gg || !gg.gameId) {
    await reply('No game set yet. Run /game <AWBW link> to start.');
    return;
  }

  if (cmd === '/iam') {
    const username = args[0];
    if (!username) {
      await reply('Usage: /iam <your_awbw_username>');
      return;
    }
    if (!senderAci) {
      await reply("Couldn't read your Signal identity — try again.");
      return;
    }
    const players = gg.players || {};
    for (const k of Object.keys(players)) if (players[k]?.aci === senderAci) delete players[k];
    players[username] = {
      aci: senderAci,
      number: senderNumber,
      displayName: senderName,
      claimedBy: 'self',
      claimedAt: FieldValue.serverTimestamp(),
    };
    await ggRef(groupId).update({ players, updatedAt: FieldValue.serverTimestamp() });
    await reply(`✅ Got it — you're ${username}. You'll be @mentioned on your turn.`);
    return;
  }

  if (cmd === '/setplayer') {
    if (!isGgMod(gg, senderAci)) {
      await reply('Only a mod can use /setplayer.');
      return;
    }
    const target = mentions[0];
    const username = args[args.length - 1];
    if (!target?.uuid || !username || username.startsWith('@')) {
      await reply('Usage: /setplayer @member <awbw_username>');
      return;
    }
    const players = gg.players || {};
    for (const k of Object.keys(players)) if (players[k]?.aci === target.uuid) delete players[k];
    players[username] = {
      aci: target.uuid,
      number: target.number,
      displayName: target.name,
      claimedBy: 'mod',
      claimedAt: FieldValue.serverTimestamp(),
    };
    await ggRef(groupId).update({ players, updatedAt: FieldValue.serverTimestamp() });
    await reply(`✅ Mapped ${target.name || 'member'} → ${username}.`);
    return;
  }

  if (cmd === '/unsetplayer' || cmd === '/forget') {
    if (!isGgMod(gg, senderAci)) {
      await reply('Only a mod can use /unsetplayer.');
      return;
    }
    const target = mentions[0];
    if (!target?.uuid) {
      await reply('Usage: /unsetplayer @member');
      return;
    }
    const players = gg.players || {};
    let removed: string | undefined;
    for (const k of Object.keys(players))
      if (players[k]?.aci === target.uuid) {
        removed = k;
        delete players[k];
      }
    await ggRef(groupId).update({ players, updatedAt: FieldValue.serverTimestamp() });
    await reply(removed ? `Removed mapping for ${removed}.` : 'No mapping found for that member.');
    return;
  }

  if (cmd === '/players' || cmd === '/who') {
    const players = gg.players || {};
    const info = await loadPlayers(gg.gameId).catch(() => ({ players: [] as string[], countries: [] as string[] }));
    const lines = Object.entries(players).map(
      ([uname, m]) => `• ${uname} → ${m.displayName || m.number || m.aci.slice(0, 8)}`
    );
    const mapped = new Set(Object.keys(players).map((s) => s.toLowerCase()));
    const unmapped = (info.players || []).filter((p) => !mapped.has(p.toLowerCase()));
    let msg = lines.length
      ? `Roster for game ${gg.gameId}:\n${lines.join('\n')}`
      : `No players mapped yet for game ${gg.gameId}.`;
    if (unmapped.length) msg += `\nUnmapped: ${unmapped.join(', ')} — /iam <name>`;
    await reply(msg);
    return;
  }

  if (cmd === '/addmod') {
    if (!isGgMod(gg, senderAci)) {
      await reply('Only a mod can add mods.');
      return;
    }
    const target = mentions[0];
    if (!target?.uuid) {
      await reply('Usage: /addmod @member');
      return;
    }
    const mods = Array.from(new Set([...(gg.mods || []), target.uuid]));
    await ggRef(groupId).update({ mods, updatedAt: FieldValue.serverTimestamp() });
    await reply(`✅ ${target.name || 'member'} is now a mod.`);
    return;
  }

  if (cmd === '/removemod') {
    if (!isGgMod(gg, senderAci)) {
      await reply('Only a mod can remove mods.');
      return;
    }
    const target = mentions[0];
    if (!target?.uuid) {
      await reply('Usage: /removemod @member');
      return;
    }
    const mods = (gg.mods || []).filter((m) => m !== target.uuid);
    await ggRef(groupId).update({ mods, updatedAt: FieldValue.serverTimestamp() });
    await reply(`Removed ${target.name || 'member'} as a mod.`);
    return;
  }

  if (cmd === '/fun') {
    if (!isGgMod(gg, senderAci)) {
      await reply('Only a mod can toggle fun mode.');
      return;
    }
    const explicit = (args[0] || '').toLowerCase();
    const newFun = explicit === 'on' ? true : explicit === 'off' ? false : !gg.funEnabled;
    await ggRef(groupId).update({ funEnabled: newFun, updatedAt: FieldValue.serverTimestamp() });
    await reply(`Fun mode ${newFun ? 'enabled ✨' : 'disabled'}.`);
    return;
  }

  if (cmd === '/status') {
    const n = Object.keys(gg.players || {}).length;
    const modCount = (gg.mods || []).length;
    let msg = `Game ${gg.gameId}${gg.gameName ? ` (${gg.gameName})` : ''} — ${gg.status}\n${gameLink(gg.gameId)}\n`;
    msg += `Players mapped: ${n} · mods: ${modCount} · fun: ${gg.funEnabled ? 'on' : 'off'}`;
    if (gg.lastTurn?.awbwUsername)
      msg += `\nLast turn seen: ${gg.lastTurn.awbwUsername}${gg.lastTurn.day ? ` (day ${gg.lastTurn.day})` : ''}`;
    await reply(msg);
    return;
  }

  if (cmd === '/stop' || cmd === '/unwatch') {
    if (!isGgMod(gg, senderAci)) {
      await reply('Only a mod can stop watching.');
      return;
    }
    await ggRef(groupId).update({ status: 'stopped', updatedAt: FieldValue.serverTimestamp() });
    await reply(`Stopped watching game ${gg.gameId}. Run /game <link> to resume.`);
    return;
  }

  await reply(HELP_TEXT);
}

// Recent non-command group chat per groupId, for fun-mode context (most recent last).
const recentChatByGroup = new Map<string, Array<{ name?: string; text: string; at: number }>>();

async function handleSignalIncoming(item: any): Promise<void> {
  const env = item?.envelope;
  const dataMessage = env?.dataMessage;
  if (!dataMessage) return;
  const text: string = (dataMessage.message || '').trim();
  // Onboarding: a Signal group invite link (works in a DM, before the bot is a member) -> join it.
  const linkMatch = text.match(/https:\/\/signal\.group\/#\S+/);
  if (linkMatch) {
    console.log('[bot] Received Signal group invite link; attempting join');
    await joinViaLink(linkMatch[0], { aci: env.sourceUuid, number: env.sourceNumber, name: env.sourceName });
    return;
  }
  const groupId: string | undefined = dataMessage.groupInfo?.groupId;
  // Buffer recent group chat (non-command) so fun-mode turn alerts can riff on it.
  if (groupId && text && !text.startsWith('/')) {
    const buf = recentChatByGroup.get(groupId) || [];
    buf.push({ name: env.sourceName, text: text.slice(0, 200), at: Date.now() });
    while (buf.length > 12) buf.shift();
    recentChatByGroup.set(groupId, buf);
  }
  if (!text.startsWith('/')) return;
  if (!groupId) return; // only handle group commands, not DMs
  const parts = text.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1);
  const mentions = Array.isArray(dataMessage.mentions)
    ? dataMessage.mentions.map((m: any) => ({ uuid: m.uuid, number: m.number, name: m.name }))
    : [];
  console.log(`[bot] command "${cmd}" from ${env.sourceName || env.sourceUuid || '?'} in group ${groupId.substring(0, 16)}`);
  await handleSignalCommand({
    groupId,
    senderAci: env.sourceUuid,
    senderNumber: env.sourceNumber,
    senderName: env.sourceName,
    cmd,
    args,
    mentions,
  });
}

/** Record a raw received item for diagnostics, normalize json-rpc wrapping, and route it. */
async function handleRawReceive(raw: any): Promise<void> {
  recordRaw(raw);
  // json-rpc WS sends { jsonrpc, method: 'receive', params: { envelope, account } }.
  // poll/GET sends { envelope, account }. Normalize to the latter.
  const item = raw && raw.method === 'receive' && raw.params ? raw.params : raw;
  await handleSignalIncoming(item).catch((err) =>
    console.error('[bot] Error handling incoming message:', err)
  );
}

/** One GET poll. Returns false if the bridge doesn't support poll-mode receive
 *  (non-array body, 400 json-rpc hint, or 404) so the caller can switch to WS. */
async function pollSignalMessagesOnce(): Promise<boolean> {
  const bridgeUrl = process.env.SIGNAL_CLI_URL!;
  const botNumber = process.env.SIGNAL_BOT_NUMBER!;
  try {
    const client = await getIdTokenClient(bridgeUrl);
    const numberPath = encodeURIComponent(botNumber);
    const res = await client.request({
      url: `${bridgeUrl}/v1/receive/${numberPath}`,
      method: 'GET',
      timeout: 10000,
    });
    const messages = (res as any)?.data;
    if (!Array.isArray(messages)) {
      lastReceiveError = `poll: non-array body (${typeof messages}) — bridge likely in json-rpc mode`;
      console.warn(`[bot] ${lastReceiveError}; switching to ws receiver`);
      return false;
    }
    if (messages.length > 0) {
      console.log(`[bot] Received ${messages.length} Signal message(s) via poll`);
      for (const item of messages) await handleRawReceive(item);
    }
    return true;
  } catch (err: any) {
    const status = err?.response?.status;
    const body =
      typeof err?.response?.data === 'string'
        ? err.response.data
        : JSON.stringify(err?.response?.data || '');
    const msg = String(err?.message || err);
    if (status === 404 || msg.includes('404') || msg.includes('Not Found')) {
      lastReceiveError = 'poll: 404 — trying ws receiver';
      console.warn('[bot] Signal receive GET 404; switching to ws receiver');
      return false;
    }
    if (status === 400 && /websocket|json[\s_-]?rpc/i.test(body)) {
      lastReceiveError = `poll: 400 json-rpc hint — switching to ws (${body.substring(0, 120)})`;
      console.warn('[bot] Signal receive GET says json-rpc/websocket; switching to ws receiver');
      return false;
    }
    lastReceiveError = `poll: ${msg}`;
    console.warn('[bot] Signal receive poll failed (will retry):', msg);
    return true; // transient — stay in poll mode
  }
}

function startPollReceiver(): void {
  receiverMode = 'poll';
  console.log('[bot] receive mode: poll (GET /v1/receive)');
  if (pollTimer) clearInterval(pollTimer);
  const tick = async () => {
    const ok = await pollSignalMessagesOnce().catch((e) => {
      lastReceiveError = `poll: ${String(e?.message || e)}`;
      return true;
    });
    if (ok === false) {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      startWsReceiver();
    }
  };
  pollTimer = setInterval(tick, SIGNAL_RECEIVE_POLL_MS);
  tick(); // immediate first poll
}

function startWsReceiver(): void {
  receiverMode = 'ws';
  const bridgeUrl = process.env.SIGNAL_CLI_URL!;
  const botNumber = process.env.SIGNAL_BOT_NUMBER!;
  const numberPath = encodeURIComponent(botNumber);
  const wsUrl = `${bridgeUrl.replace(/^http/i, 'ws')}/v1/receive/${numberPath}`;

  (async () => {
    let authorization: string | undefined;
    try {
      const client = await getIdTokenClient(bridgeUrl);
      const hdrs: any = await client.getRequestHeaders(bridgeUrl);
      authorization =
        hdrs?.Authorization ||
        hdrs?.authorization ||
        (typeof hdrs?.get === 'function' ? hdrs.get('Authorization') : undefined);
    } catch (e) {
      console.error('[bot] ws auth header fetch failed', e);
    }

    console.log(`[bot] receive mode: ws — connecting ${wsUrl}`);
    const ws = new WebSocket(wsUrl, authorization ? { headers: { Authorization: authorization } } : undefined);
    receiverWs = ws;
    let opened = false;

    ws.on('open', () => {
      opened = true;
      wsFailCount = 0;
      lastReceiveError = null;
      console.log('[bot] receive websocket open');
    });
    ws.on('message', (data) => {
      try {
        const parsed = JSON.parse(data.toString());
        handleRawReceive(parsed).catch(() => {});
      } catch (e) {
        console.warn('[bot] ws message parse error', e);
      }
    });
    ws.on('error', (err: any) => {
      lastReceiveError = `ws: ${String(err?.message || err)}`;
      console.error('[bot] receive websocket error:', err?.message || err);
    });
    ws.on('close', (code) => {
      receiverWs = null;
      console.warn(`[bot] receive websocket closed (code=${code}, opened=${opened})`);
      if (receiverMode !== 'ws') return;
      if (!opened) wsFailCount++;
      if (wsFailCount >= 3) {
        wsFailCount = 0;
        console.warn('[bot] ws failed to connect repeatedly; falling back to poll receiver');
        startPollReceiver();
        return;
      }
      setTimeout(() => {
        if (receiverMode === 'ws') startWsReceiver();
      }, 3000);
    });
  })();
}

/** Probe the bridge once and choose poll vs ws receive, then keep it running. */
async function startSignalReceiver(): Promise<void> {
  const bridgeUrl = process.env.SIGNAL_CLI_URL;
  const botNumber = process.env.SIGNAL_BOT_NUMBER;
  if (!bridgeUrl || !botNumber) {
    console.warn('[bot] receiver disabled: SIGNAL_CLI_URL / SIGNAL_BOT_NUMBER not set');
    return;
  }
  try {
    const client = await getIdTokenClient(bridgeUrl);
    const numberPath = encodeURIComponent(botNumber);
    const res = await client.request({
      url: `${bridgeUrl}/v1/receive/${numberPath}`,
      method: 'GET',
      timeout: 8000,
    });
    if (Array.isArray((res as any)?.data)) {
      const messages = (res as any).data as any[];
      if (messages.length > 0) {
        console.log(`[bot] probe drained ${messages.length} queued message(s)`);
        for (const item of messages) await handleRawReceive(item);
      }
      startPollReceiver();
      return;
    }
    console.warn('[bot] probe: receive GET returned non-array; using ws receiver');
    startWsReceiver();
  } catch (err: any) {
    const status = err?.response?.status;
    const body =
      typeof err?.response?.data === 'string'
        ? err.response.data
        : JSON.stringify(err?.response?.data || '');
    lastReceiveError = `probe: ${status || ''} ${body || err?.message || ''}`.trim();
    console.warn(`[bot] probe failed (${lastReceiveError}); defaulting to ws receiver`);
    // json-rpc mode commonly 400s the GET; ws receiver will fall back to poll if it can't connect.
    startWsReceiver();
  }
}

// ── End slash-command bot ────────────────────────────────────────────────────

// ── Group-game turn-notification driver ──────────────────────────────────────
type GGSocketState = {
  ws: WebSocket;
  shouldReopen: boolean;
  checkInterval?: ReturnType<typeof setInterval>;
  heartbeat?: ReturnType<typeof setInterval>;
  gameId: string;
};
const activeGGSockets = new Map<string, GGSocketState>();
// AWBW's own client keeps the socket alive by sending an empty-string DATA frame every 45s
// (webSocket.send("")) — a protocol-level ping frame does NOT reset its idle timer. Match it.
const GG_HEARTBEAT_MS = 40_000;

function stopGGSocket(groupId: string, reason: string) {
  const st = activeGGSockets.get(groupId);
  if (!st) return;
  st.shouldReopen = false;
  if (st.checkInterval) clearInterval(st.checkInterval);
  if (st.heartbeat) clearInterval(st.heartbeat);
  try {
    st.ws.close();
  } catch {
    /* ignore */
  }
  activeGGSockets.delete(groupId);
  console.log(`[gg] stopped watching for group ${groupId.substring(0, 16)} (${reason})`);
}

function startGroupGameSocket(groupId: string, gameId: string) {
  const existing = activeGGSockets.get(groupId);
  if (existing) {
    existing.shouldReopen = false;
    if (existing.checkInterval) clearInterval(existing.checkInterval);
    if (existing.heartbeat) clearInterval(existing.heartbeat);
    try {
      existing.ws.close();
    } catch {
      /* ignore */
    }
    activeGGSockets.delete(groupId);
  }
  const ws = new WebSocket(buildAwbwSocketUrl(gameId));
  const state: GGSocketState = { ws, shouldReopen: true, gameId };
  activeGGSockets.set(groupId, state);
  console.log(`[gg] watching game ${gameId} for group ${groupId.substring(0, 16)}`);

  state.checkInterval = setInterval(() => {
    if (!state.shouldReopen) return;
    isGameEnded(gameId)
      .then((ended) => {
        if (ended) {
          ggRef(groupId).update({ status: 'ended', updatedAt: FieldValue.serverTimestamp() }).catch(() => {});
          sendGroupReply(groupId, `🏁 Game ${gameId} has ended. Run /game <link> to watch another.`).catch(() => {});
          stopGGSocket(groupId, 'game ended (page check)');
        }
      })
      .catch(() => {});
  }, GAME_ENDED_CHECK_MS);

  ws.on('open', () => {
    console.log(`[gg] ws open ${gameId}`);
    if (state.heartbeat) clearInterval(state.heartbeat);
    state.heartbeat = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(''); // empty-string keepalive, exactly like AWBW's web client
        } catch {
          /* ignore */
        }
      }
    }, GG_HEARTBEAT_MS);
  });
  ws.on('message', (msg) => {
    try {
      const parsed = JSON.parse(msg.toString());
      if (parsed?.GameOver || parsed?.GameEnd || parsed?.type === 'GameOver' || parsed?.type === 'GameEnd') {
        ggRef(groupId).update({ status: 'ended', updatedAt: FieldValue.serverTimestamp() }).catch(() => {});
        stopGGSocket(groupId, 'game over (ws)');
        return;
      }
      const isNextTurn = parsed?.type === 'NextTurn' || parsed?.NextTurn;
      if (!isNextTurn) return;
      const next = parsed?.NextTurn || parsed?.nextTurn || parsed || {};
      const socketPlayer =
        next.playerName || next.player_name || next.player || next.username || next.name;
      const day = next.day;
      const dedupKey = `gg-${groupId}-${gameId}-${day}-${next.playerId || next.player_id || socketPlayer}`;
      const now = Date.now();
      const last = recentNextTurns.get(dedupKey);
      if (last && now - last < NEXT_TURN_DEDUP_WINDOW_MS) return;
      recentNextTurns.set(dedupKey, now);
      onGroupGameNextTurn(groupId, gameId, { day, socketPlayer }).catch((e) =>
        console.error('[gg] notify error', e)
      );
    } catch (err) {
      console.error('[gg] ws parse error', err);
    }
  });
  ws.on('error', (err: any) => {
    console.error(`[gg] ws error ${gameId}:`, err?.message || err);
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  });
  ws.on('close', (code) => {
    if (state.checkInterval) clearInterval(state.checkInterval);
    if (state.heartbeat) clearInterval(state.heartbeat);
    activeGGSockets.delete(groupId);
    if (state.shouldReopen) {
      console.log(`[gg] ws closed ${gameId} (code=${code}); reconnecting`);
      setTimeout(() => startGroupGameSocket(groupId, gameId), 1500);
    }
  });
}

async function onGroupGameNextTurn(
  groupId: string,
  gameId: string,
  meta: { day?: number; socketPlayer?: string }
) {
  const snap = await ggRef(groupId).get();
  if (!snap.exists) {
    stopGGSocket(groupId, 'group doc gone');
    return;
  }
  const gg = snap.data() as GroupGame;
  if (gg.status !== 'active') {
    stopGGSocket(groupId, 'not active');
    return;
  }
  const turn = await resolveCurrentTurn(gameId).catch(() => undefined);
  const currentPlayer =
    turn?.username ||
    (await scrapeCurrentPlayerName(gameId).catch(() => undefined)) ||
    meta.socketPlayer;
  // Pick one of the player's REAL living units so the voice + sprite are grounded in reality.
  const liveUnits = turn?.units || [];
  const chosenUnit = liveUnits.length
    ? liveUnits[Math.floor(Math.random() * liveUnits.length)]
    : undefined;
  const armyCode = chosenUnit?.code || turn?.countryCode;
  const army = armyCode ? { code: armyCode } : undefined;
  const unitInfo = chosenUnit
    ? {
        name: chosenUnit.name,
        hp: chosenUnit.hp,
        lowFuel: chosenUnit.lowFuel,
        lowAmmo: chosenUnit.lowAmmo,
        terrainTile: chosenUnit.terrainTile,
      }
    : undefined;
  if (!currentPlayer) {
    // Couldn't name the player, but a turn DID change — notify anyway so it's never silent.
    console.log('[gg] turn changed but current player unresolved; sending generic notice');
    await sendGroupRaw(
      groupId,
      `⏭️ Next turn is up${meta.day ? ` (day ${meta.day})` : ''}.\n${gameLink(gameId)}`
    ).catch((e) => console.error('[gg] generic notice failed', e));
    await ggRef(groupId)
      .update({ lastTurn: { day: meta.day ?? null, awbwUsername: null }, updatedAt: FieldValue.serverTimestamp() })
      .catch(() => {});
    return;
  }
  const info = await loadPlayers(gameId).catch(() => ({ players: [] as string[], countries: [] as string[] }));
  const gameName = gg.gameName || (await loadGameName(gameId)) || undefined;
  // For fun mode, pass recent group chat (last ~45 min) so the caption can riff on it.
  let recentChat: Array<{ name?: string; text: string }> | undefined;
  if (gg.funEnabled) {
    const cutoff = Date.now() - 45 * 60 * 1000;
    recentChat = (recentChatByGroup.get(groupId) || [])
      .filter((c) => c.at >= cutoff)
      .slice(-6)
      .map((c) => ({ name: c.name, text: c.text }));
  }
  const payload = await buildMessage(
    gameId,
    {
      day: meta.day,
      playerName: currentPlayer,
      socketPlayerName: meta.socketPlayer,
      players: info.players,
      gameName,
      funEnabled: gg.funEnabled,
    },
    recentChat,
    army,
    unitInfo
  );
  let message = payload.text;
  const players = gg.players || {};
  const mentions: Array<{ author: string; start: number; length: number }> = [];

  // The message always goes to the whole group and names whose turn it is, so anyone with
  // group notifications on is covered. Mapping is optional: if the current player has claimed
  // their slot (/iam) we ALSO @-mention them so they're pinged even without "always notify".
  // Unmapped players get no extra text — no per-turn nag.
  const key = Object.keys(players).find(
    (k) => k.toLowerCase() === String(currentPlayer).toLowerCase()
  );
  const mapping = key ? players[key] : undefined;
  if (mapping?.aci) {
    // Append a 1-char '@' placeholder signal-cli renders as the contact mention.
    // JS string .length is UTF-16 code units == signal-cli char offsets.
    const spacer = message.endsWith(' ') || message.endsWith('\n') ? '' : ' ';
    const start = (message + spacer).length;
    message = `${message}${spacer}@`;
    mentions.push({ author: mapping.aci, start, length: 1 });
  }

  const attachment = payload.imageData
    ? {
        dataB64: payload.imageData,
        contentType: payload.imageContentType || 'image/gif',
        filename: payload.imageFilename || 'unit.gif',
      }
    : undefined;

  try {
    await sendGroupRaw(groupId, message, mentions.length ? mentions : undefined, attachment);
    await ggRef(groupId)
      .update({ lastTurn: { day: meta.day ?? null, awbwUsername: currentPlayer }, updatedAt: FieldValue.serverTimestamp() })
      .catch(() => {});
    console.log(
      `[gg] notified group ${groupId.substring(0, 16)} turn=${currentPlayer} mentioned=${mentions.length > 0}`
    );
  } catch (err) {
    console.error('[gg] send failed', err);
  }
}

const BACKSTOP_POLL_MS = 60_000;
/** Failover only: the websocket is the low-latency path. This poll acts ONLY for games whose
 *  socket is currently down (e.g. nightly site maintenance) — it scrapes the current player and
 *  notifies if the turn changed while we were disconnected. When the socket is healthy it does
 *  nothing, so it never competes with the instant websocket path or double-notifies. */
async function runBackstopPoll() {
  let snap;
  try {
    snap = await getFirestore().collection('groupGames').where('status', '==', 'active').get();
  } catch (err) {
    console.warn('[gg] backstop query failed', err);
    return;
  }
  for (const doc of snap.docs) {
    const gg = { ...(doc.data() as GroupGame), groupId: doc.id };
    if (!gg.gameId) continue;
    const st = activeGGSockets.get(gg.groupId);
    if (st && st.ws.readyState === WebSocket.OPEN) continue; // socket healthy → trust the websocket
    const currentPlayer = await resolveCurrentPlayerName(gg.gameId).catch(() => undefined);
    if (currentPlayer && currentPlayer !== (gg.lastTurn?.awbwUsername || undefined)) {
      console.log(`[gg] backstop: socket down for ${gg.groupId.substring(0, 16)}, turn=${currentPlayer} — notifying`);
      await onGroupGameNextTurn(gg.groupId, gg.gameId, { socketPlayer: currentPlayer }).catch((e) =>
        console.error('[gg] backstop notify failed', e)
      );
    }
  }
}

async function main() {
  ensureFirebase();
  const db = getFirestore();

  console.log('Worker starting. Watching groupGames for active games...');

  // Signal slash-command receiver (poll or websocket, auto-detected)
  startSignalReceiver().catch((err) => console.error('[bot] receiver start failed:', err));

  // Failover backstop: catches turns missed while a game socket is down (site maintenance, etc.).
  setInterval(() => {
    runBackstopPoll().catch((err) => console.error('[gg] backstop poll error', err));
  }, BACKSTOP_POLL_MS);

  // Drive one AWBW socket per active group game; notify the group on each turn change.
  db.collection('groupGames').onSnapshot((snap) => {
    snap.docChanges().forEach((change) => {
      const groupId = change.doc.id;
      const gg = change.doc.data() as GroupGame;
      if (change.type === 'removed' || gg.status !== 'active' || !gg.gameId) {
        stopGGSocket(groupId, change.type === 'removed' ? 'doc removed' : `status ${gg.status}`);
        return;
      }
      const st = activeGGSockets.get(groupId);
      if (st && st.gameId === gg.gameId && st.shouldReopen) return; // already watching this game
      startGroupGameSocket(groupId, gg.gameId);
    });
  });


  // Simple health server for Cloud Run
  const port = Number(process.env.PORT) || 8080;
  const server = http.createServer(async (_, res) => {
    try {
      const url = new URL(_.url || '/', 'http://localhost');
      if (url.pathname === '/debug/receive') {
        // Diagnostics for the Signal receive path. Gated by INVITE_SHARED_SECRET when set
        // (pass ?secret=... or x-shared-secret header); open otherwise.
        const sharedSecret = process.env.INVITE_SHARED_SECRET;
        if (sharedSecret) {
          const provided = _.headers['x-shared-secret'] || url.searchParams.get('secret');
          if (provided !== sharedSecret) {
            res.statusCode = 401;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Unauthorized' }));
            return;
          }
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify(
            {
              mode: receiverMode,
              bridgeConfigured: !!(process.env.SIGNAL_CLI_URL && process.env.SIGNAL_BOT_NUMBER),
              lastReceiveError,
              lastReceiveAt: lastReceiveAt ? new Date(lastReceiveAt).toISOString() : null,
              count: recentRawReceives.length,
              recent: recentRawReceives,
            },
            null,
            2
          )
        );
        return;
      }
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
      if (url.pathname === '/submit-captcha' && _.method === 'POST') {
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
          const body = await readJsonBody<{ phone?: string; challengeToken?: string; captchaToken?: string }>(_ as any);
          let captchaToken = (body.captchaToken || '').trim();
          const challengeToken = (body.challengeToken || '').trim();
          if (captchaToken.startsWith('signalcaptcha://')) {
            captchaToken = captchaToken.replace('signalcaptcha://', '').split('?')[0].split('#')[0];
          } else if (captchaToken.includes('signalcaptcha://')) {
            const match = captchaToken.match(/signalcaptcha:\/\/([^\s?#]+)/);
            if (match) captchaToken = match[1];
          }
          if (!challengeToken || !captchaToken) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'challengeToken and captchaToken required' }));
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
          const client = await getIdTokenClient(bridgeUrl);
          const numberPath = encodeURIComponent(botNumber);
          const challengeRes = await client.request({
            url: `${bridgeUrl}/v1/accounts/${numberPath}/rate-limit-challenge`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            data: { challenge: challengeToken, captcha: captchaToken },
            timeout: 15000,
          });
          const data = (challengeRes as any)?.data ?? challengeRes;
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true, ...(typeof data === 'object' ? data : {}) }));
        } catch (err: any) {
          const errMsg = err?.response?.data?.error ?? err?.response?.data ?? err?.message ?? String(err);
          const status = err?.response?.status ?? 500;
          res.statusCode = status;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: typeof errMsg === 'string' ? errMsg : 'Failed to submit CAPTCHA', details: errMsg }));
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
      if (url.pathname === '/join-group' && _.method === 'POST') {
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
          const body = await readJsonBody<{ inviteLink?: string }>(_ as any);
          const inviteLink = (body.inviteLink || '').trim();
          if (!inviteLink) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'inviteLink required' }));
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
          // signal-cli expects a sgnl:// URI; convert https://signal.group/#hash if needed
          let joinUri = inviteLink;
          const hashMatch = inviteLink.match(/signal\.group\/#(.+)/);
          if (hashMatch) {
            joinUri = `https://signal.group/#${hashMatch[1]}`;
          }
          const client = await getIdTokenClient(bridgeUrl);
          const numberPath = encodeURIComponent(botNumber);
          console.log(`[join-group] Joining with URI: ${joinUri}`);
          const joinRes = await client.request({
            url: `${bridgeUrl}/v1/groups/${numberPath}/join/${encodeURIComponent(joinUri)}`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            timeout: 30000,
          });
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true, data: (joinRes as any)?.data }));
        } catch (err: any) {
          const errMsg = err?.response?.data?.error ?? err?.response?.data ?? err?.message ?? String(err);
          const status = err?.response?.status ?? 500;
          res.statusCode = status;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: typeof errMsg === 'string' ? errMsg : JSON.stringify(errMsg) }));
        }
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

