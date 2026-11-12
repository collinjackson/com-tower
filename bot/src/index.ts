import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import WebSocket from 'ws';
import http from 'http';
import {
  createBackendFromEnv,
  messagingPlatform,
  platformOf,
  SignalCliRestBackend,
  type MessagingBackend,
} from './messaging/index.js';
import { FieldValue } from 'firebase-admin/firestore';
import { createOwnership, type Ownership, type LeaseStore } from './ownership.js';
import { parseTurnStats, recordTurnStats, type TurnStats } from './stats.js';
import { fetchStrategyNote } from './strategy-note.js';
import { fetchReel } from './reel.js';
import {
  backfillFromReplay,
  computeTurnTimes,
  formatSpan,
  rankBySlowest,
  replayToSnapshot,
  summarize,
  type ClockSnapshot,
} from './turn-times.js';

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
  /** The chat's /iam players (AWBW names): lets the strategy note coach a one-team chat. */
  members?: string[];
  countries?: string[];
  gameName?: string;
  funEnabled?: boolean;
  inviterUid?: string;
  reminderElapsed?: string; // set for turn reminders → the text becomes a "still your move" nudge
};
type RenderPayload = {
  text: string;
  imageUrl?: string;
  imageData?: string;
  imageContentType?: string;
  imageFilename?: string;
};

// The chat platform this worker serves (MESSAGING_PLATFORM, default "signal"), and how it reaches
// it. Group games carry the platform that bound them; this worker only watches its own.
const PLATFORM = messagingPlatform();
const messaging: MessagingBackend | null = createBackendFromEnv();
function requireMessaging(): MessagingBackend {
  if (!messaging) throw new Error('Messaging bridge not configured (SIGNAL_CLI_URL / SIGNAL_BOT_NUMBER)');
  return messaging;
}
/** The signal-cli-rest bridge, for endpoints outside the backend interface; null otherwise. */
function signalCliBridge(): SignalCliRestBackend | null {
  return messaging instanceof SignalCliRestBackend ? messaging : null;
}
/** Is this group game this worker's to watch? */
function isOurPlatform(gg: { platform?: string } | undefined): boolean {
  return platformOf(gg) === PLATFORM;
}
const renderUrl = process.env.NOTIFY_RENDER_URL;
// Which games this replica is responsible for (SCALING_MODE: singleton|leader|shard). Set in main().
let ownership: Ownership;
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

async function getGroupIdByName(groupName: string): Promise<string> {
  const groups = await requireMessaging().listGroups();

  // Simple exact match by name
  for (const group of groups) {
    if (group.name === groupName) {
      const groupId = group.id || null;
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
    // Two credential paths:
    //  - Explicit service-account key (current Cloud Run setup) -> cert(...).
    //  - No key present -> Application Default Credentials. Covers GKE Workload Identity
    //    (the k8s target) and the Firestore emulator (load tests: FIRESTORE_EMULATOR_HOST
    //    short-circuits auth, so only a projectId is needed).
    if (projectId && clientEmail && privateKey) {
      initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
    } else {
      const effectiveProject =
        projectId || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
      if (!effectiveProject && !process.env.FIRESTORE_EMULATOR_HOST) {
        throw new Error(
          'Missing Firebase config: set FIREBASE_* (cert), or ADC + GOOGLE_CLOUD_PROJECT, or FIRESTORE_EMULATOR_HOST'
        );
      }
      initializeApp(effectiveProject ? { projectId: effectiveProject } : {});
    }
  }
}

function buildAwbwSocketUrl(gameId: string) {
  const base = process.env.AWBW_WS_BASE || 'wss://awbw.amarriner.com';
  return `${base}/node/game/${gameId}`;
}

// Public, user-facing game URL — always the real AWBW host (goes into notification text).
function gameLink(gameId: string) {
  return `https://awbw.amarriner.com/game.php?games_id=${gameId}`;
}

// Base host the bot SCRAPES for game state. Defaults to the real AWBW host, but is overridable
// (e.g. a local stub in load tests) so the scrape traffic can be isolated. Prod is unchanged.
const AWBW_HTTP_BASE = (process.env.AWBW_HTTP_BASE || 'https://awbw.amarriner.com').replace(/\/+$/, '');
function gamePageUrl(gameId: string) {
  return `${AWBW_HTTP_BASE}/game.php?games_id=${gameId}`;
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
    const res = await fetch(gamePageUrl(gameId));
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

/** Scrape the AWBW game page for end-of-game state. game.php always emits
 *  `gameEndDate = "YYYY-MM-DD"` (empty string while live) and `endData = {...}` (null while
 *  live, with a winners message once over) — visible-text sniffing ("game over", "winner")
 *  matches template markup on LIVE pages too, so only these structurals are trustworthy. */
async function fetchGameEndInfo(gameId: string): Promise<{ ended: boolean; message?: string }> {
  try {
    const res = await fetch(gamePageUrl(gameId), { cache: 'no-store' as any });
    const html = await res.text();
    let message: string | undefined;
    const dataMatch = html.match(/endData\s*=\s*(\{[\s\S]*?\});/);
    if (dataMatch) {
      try {
        message =
          String(JSON.parse(dataMatch[1])?.message || '').replace(/\s+/g, ' ').trim() || undefined;
      } catch {
        /* endData shape changed — fall through to gameEndDate */
      }
    }
    const end = html.match(/gameEndDate\s*=\s*"([^"]*)"/);
    if (end) return { ended: end[1].trim().length > 0, message };
    return { ended: !!message, message };
  } catch (err) {
    console.warn('game end check failed', gameId, err);
    return { ended: false };
  }
}

/** Check if the game has ended by scraping the AWBW game page. */
async function isGameEnded(gameId: string): Promise<boolean> {
  return (await fetchGameEndInfo(gameId)).ended;
}

// Best-effort scrape of the current player from the game page to validate the socket payload
async function scrapeCurrentPlayerName(gameId: string): Promise<string | undefined> {
  try {
    const res = await fetch(gamePageUrl(gameId), { cache: 'no-store' as any });
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
  id?: string; // AWBW units_id (stable across turns, for HP-change tracking)
};

/** Resolve the current player from the game page: username, army, and their REAL living units.
 *  AWBW exposes `currentTurn = <players_id>` and a `unitsInfo = {...}` map of placed units
 *  (each with units_players_id, units_name, units_hit_points, units_fuel, countries_code). */
async function resolveCurrentTurn(gameId: string): Promise<
  | {
      username?: string;
      countryCode?: string;
      countryName?: string;
      co?: { name?: string; imageUrl?: string; power?: 'SCOP' | 'COP' };
      units: AwbwUnit[];
      stats?: TurnStats;
      day?: number;
      dayLimit?: number; // last day of the game; undefined when the game has no day limit
    }
  | undefined
> {
  try {
    const res = await fetch(gamePageUrl(gameId), { cache: 'no-store' as any });
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
    // Current player's CO (tag-aware: AWBW reports the ACTIVE CO in the current
    // player's block during their turn). Bound the window to THIS player's object
    // (up to the next players_id) so power values aren't read from another player.
    let coWindow = '';
    if (idMatch) {
      const rest = html.slice(idMatch.index + 12);
      const nextId = rest.search(/"players_id"\s*:\s*\d/);
      coWindow = html.slice(idMatch.index, idMatch.index + 12 + (nextId >= 0 ? nextId : 3000));
    }
    const coName = coWindow.match(/"co_name"\s*:\s*"([^"]+)"/)?.[1];
    const coPath = coWindow.match(/"co_image_path"\s*:\s*"([^"]+)"/)?.[1]; // JSON-escaped slashes
    const coImageUrl = coPath
      ? `${AWBW_HTTP_BASE}/${coPath.replace(/\\\//g, '/').replace(/^\//, '')}`
      : undefined;
    // CO power charge: is a CO Power / Super CO Power ready to fire?
    const numF = (re: RegExp): number => { const m = coWindow.match(re); return m ? Number(m[1]) : 0; };
    const coPow = numF(/"players_co_power"\s*:\s*"?(\d+)/);
    const coMaxP = numF(/"players_co_max_power"\s*:\s*"?(\d+)/) || numF(/"co_max_power"\s*:\s*"?(\d+)/);
    const coMaxS = numF(/"players_co_max_spower"\s*:\s*"?(\d+)/) || numF(/"co_max_spower"\s*:\s*"?(\d+)/);
    const power: 'SCOP' | 'COP' | undefined =
      coMaxS > 0 && coPow >= coMaxS ? 'SCOP' : coMaxP > 0 && coPow >= coMaxP ? 'COP' : undefined;
    const co = coName || coImageUrl ? { name: coName, imageUrl: coImageUrl, power } : undefined;

    // The current player's actual living units (the hologram features one of them).
    let units: AwbwUnit[] = [];
    const um = html.match(/unitsInfo\s*=\s*(\{[^;]*\})\s*;/);
    if (um) {
      try {
        const obj = JSON.parse(um[1]) as Record<string, any>;
        units = Object.entries(obj)
          .filter(([, u]) => String(u.units_players_id) === curId && Number(u.units_hit_points) > 0)
          .map(([id, u]) => ({
            name: String(u.units_name || ''),
            code: u.countries_code || undefined,
            hp: Number(u.units_hit_points),
            id,
          }))
          .filter((u) => u.name);
      } catch (e) {
        console.warn('unitsInfo parse failed', e);
      }
    }
    const day = Number(html.match(/\bgameDay\s*=\s*(\d+)/)?.[1]) || undefined;
    // Only in the settings table: `<td class=small_text>Day Limit:</td><td class=small_text>30</td>`
    // ("Off" when unset, which the \d+ skips).
    const dayLimit = Number(html.match(/Day Limit:\s*<\/td>\s*<td[^>]*>\s*(\d+)/i)?.[1]) || undefined;
    return { username, countryCode, countryName, co, units, stats: parseTurnStats(html, curId), day, dayLimit };
  } catch (err) {
    console.error('resolveCurrentTurn failed', err);
    return undefined;
  }
}

/** Just the current player's username (used by the backstop poll's change check). */
async function resolveCurrentPlayerName(gameId: string): Promise<string | undefined> {
  return (await resolveCurrentTurn(gameId))?.username;
}

/** The ping, with the turn's highlight reel (REEL_URL) as its image when the service has one;
 *  fetched alongside the rest, and any failure keeps the usual image. Reminders keep theirs. */
async function buildMessage(
  gameId: string,
  meta: NextTurnMeta,
  army?: { code?: string; name?: string },
  unit?: { name: string },
  co?: { name?: string; imageUrl?: string }
): Promise<RenderPayload> {
  const reel = meta.reminderElapsed ? Promise.resolve(null)
    : fetchReel(gameId, { day: meta.day, players: meta.players?.length || undefined });
  const [base, r] = await Promise.all([buildMessageBase(gameId, meta, army, unit, co), reel]);
  return r ? { ...base, imageUrl: undefined, imageData: r.dataB64, imageContentType: r.contentType, imageFilename: r.filename } : base;
}

async function buildMessageBase(
  gameId: string,
  meta: NextTurnMeta,
  army?: { code?: string; name?: string },
  unit?: { name: string },
  co?: { name?: string; imageUrl?: string }
): Promise<RenderPayload> {
  const link = gameLink(gameId);
  const gameName = meta.gameName || `Game ${gameId}`;
  const enableFun = !!meta.funEnabled;
  const effectivePlayerName = meta.playerName || meta.socketPlayerName;

  // A strategy note about the position, when a STRATEGY_NOTE_URL service is configured, in place
  // of the usual text. The render still runs for the image (chart or hologram). Reminders keep
  // their nudge. Any failure falls through to the usual text.
  let strategyText: string | null = null;
  if (!meta.reminderElapsed) {
    const strategy = await fetchStrategyNote(gameId, { playerName: effectivePlayerName, members: meta.members });
    if (strategy) {
      const nameChunk = meta.gameName ? `(${meta.gameName}) ` : '';
      const who = effectivePlayerName ? `${effectivePlayerName}, you're up.` : 'New turn.';
      strategyText = `${meta.day ? `Day ${meta.day}. ` : ''}${who} ${strategy.text} ${nameChunk}${link}`;
    }
  }
  if (strategyText && !renderUrl) return { text: strategyText };

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
          inviterUid: meta.inviterUid,
          day: meta.day,
          playerName: effectivePlayerName,
          players: meta.players,
          gameName,
          link,
          enableFun,
          army: enableFun && army?.code ? army : undefined,
          unit: enableFun && unit ? unit : undefined,
          co: enableFun && co ? co : undefined,
          reminderElapsed: enableFun && meta.reminderElapsed ? meta.reminderElapsed : undefined,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data?.error) {
          throw new Error(typeof data.error === 'string' ? data.error : JSON.stringify(data.error));
        }
        if (data?.text) {
          if (enableFun && !data.imageData) {
            console.warn(
              `Render returned no image for game ${gameId}${data.imageSkipReason ? ` (reason: ${data.imageSkipReason})` : ''}`
            );
          }
          let text = data.text as string;
          // Only append a REAL game name — never the "Game <id>" fallback, which
          // is redundant with the game id already in the URL.
          const nameChunk = meta.gameName ? `(${meta.gameName})` : '';
          if (!text.includes(link)) {
            text = `${text} ${nameChunk ? `${nameChunk} ` : ''}${link}`;
          } else if (nameChunk && !text.includes(nameChunk)) {
            text = `${text} ${nameChunk}`;
          }
          return {
            text: strategyText ?? text,
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
      if (strategyText) return { text: strategyText }; // the note stands on its own
      const errMsg = err instanceof Error ? err.message : 'Render fetch failed';
      const errParts = [
        meta.day ? `Day ${meta.day}.` : '',
        meta.playerName ? `${meta.playerName}, you're up.` : 'New turn.',
        gameName && gameName !== `Game ${gameId}` ? gameName : '',
        link,
        `[render error: ${errMsg}]`,
      ].filter(Boolean);
      return { text: errParts.join(' ') };
    }
  }
  const parts = [
    meta.day ? `Day ${meta.day}.` : '',
    meta.playerName ? `${meta.playerName}, you're up.` : 'New turn.',
    gameName && gameName !== `Game ${gameId}` ? gameName : '',
    link,
  ].filter(Boolean);
  return { text: parts.join(' ') };
}

/** Ask the dashboard to render a chart of this game's recorded history. Built entirely from
 *  Com Tower's own per-turn samples — no replay API call, so nothing here can rate-limit AWBW. */
/** How /stats names each chart metric in its caption. armyValue is the default: units plus
 *  cash, so a player who banks funds does not look weak until they spend it. */
const METRIC_LABELS: Record<string, string> = {
  armyValue: 'Army value (units + funds)',
  unitValue: 'Unit value',
  funds: 'Funds',
  income: 'Income',
  properties: 'Properties',
  unitCount: 'Unit count',
};

/** /stats arguments in any order: a metric (armyValue by default) and `log` for a log axis. */
function parseStatsArgs(args: string[]): { metric: string; logScale: boolean } {
  const logScale = args.some((a) => a.toLowerCase() === 'log');
  const metric = args.find((a) => a.toLowerCase() !== 'log') || 'armyValue';
  return { metric: metric.replace(/[^a-zA-Z]/g, ''), logScale };
}

async function buildStatsChart(
  gameId: string,
  metric: string,
  logScale = false
): Promise<
  | {
      caption: string;
      attachment: { dataB64: string; contentType: string; filename: string };
    }
  | undefined
> {
  if (!renderUrl) return undefined;
  try {
    // Nothing recorded yet — usually a game Com Tower started watching mid-way. Take a sample
    // right now rather than answering with an empty chart: it makes /stats useful immediately
    // (as a current standing) and doubles as the first point of the history.
    const existing = await getFirestore()
      .collection('games')
      .doc(gameId)
      .collection('turnStats')
      .limit(1)
      .get();
    if (existing.empty) {
      const turn = await resolveCurrentTurn(gameId).catch(() => undefined);
      if (turn?.stats) {
        await recordTurnStats(gameId, turn.stats);
        console.log(`[stats] seeded game ${gameId} from a live read (day ${turn.stats.day})`);
      } else {
        return undefined;
      }
    }

    const url = new URL(`/api/chart/${gameId}`, renderUrl);
    url.searchParams.set('metric', metric);
    if (logScale) url.searchParams.set('scale', 'log');
    const bypass = process.env.RENDER_BYPASS_TOKEN;
    const res = await fetch(url.toString(), {
      headers: bypass
        ? { 'x-vercel-protection-bypass': bypass, cookie: `x-vercel-protection-bypass=${bypass}` }
        : {},
    });
    if (!res.ok) {
      console.warn(`[stats] chart render failed ${res.status}`);
      return undefined;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      caption: `📈 ${METRIC_LABELS[metric] || metric}${logScale ? ' (log scale)' : ''} — ${gameLink(gameId)}`,
      attachment: {
        dataB64: buf.toString('base64'),
        contentType: 'image/png',
        filename: `awbw-${gameId}-${metric}.png`,
      },
    };
  } catch (err) {
    console.warn('[stats] chart fetch failed', err);
    return undefined;
  }
}

/** Every reading of a game's turn clock Com Tower has: its own turn samples, plus any replay
 *  turns fetched earlier to fill gaps. */
async function loadClockSnapshots(gameId: string): Promise<ClockSnapshot[]> {
  const game = getFirestore().collection('games').doc(gameId);
  const [stats, clock] = await Promise.all([
    game.collection('turnStats').limit(2000).get(),
    game.collection('turnClock').limit(2000).get(),
  ]);
  const snaps: ClockSnapshot[] = [];
  for (const doc of stats.docs) {
    const d = doc.data() as TurnStats & { at?: { toMillis?: () => number } };
    if (typeof d.day !== 'number' || !d.players) continue;
    snaps.push({ ...turnStatsToClock(d), atMs: d.at?.toMillis?.(), source: 'notify' });
  }
  for (const doc of clock.docs) snaps.push({ ...(doc.data() as ClockSnapshot), source: 'replay' });
  return snaps;
}

function turnStatsToClock(s: TurnStats): Omit<ClockSnapshot, 'source'> {
  const players: ClockSnapshot['players'] = {};
  for (const [pid, p] of Object.entries(s.players)) {
    players[pid] = {
      username: p.username,
      countryCode: p.countryCode,
      coName: p.coName,
      order: p.order,
      eliminated: p.eliminated,
      turnStart: p.turnStart,
    };
  }
  return { day: s.day, turnPlayerId: s.turnPlayerId, players };
}

/** One turn of the replay. Only reached for turns Com Tower has no reading of. */
async function fetchReplayTurn(gameId: string, index: number): Promise<ClockSnapshot | undefined> {
  const res = await fetch(`${AWBW_HTTP_BASE}/api/game/load_replay.php`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      Origin: 'https://awbw.amarriner.com',
      Referer: 'https://awbw.amarriner.com',
    },
    body: JSON.stringify({ gameId: Number(gameId), turn: index, initial: index === 0 }),
  });
  if (!res.ok) return undefined;
  const data = (await res.json().catch(() => undefined)) as any;
  if (!data || data.err) return undefined;
  return replayToSnapshot(data);
}

/** Who is holding up the game: every player's turn lengths, slowest first, as a caption and
 *  (when the renderer is reachable) a chart in each player's army colour. */
async function buildTurnTimeReport(
  gameId: string,
  referenceMs: number | null = DEFAULT_REMINDER_MS
): Promise<
  | { caption: string; attachment?: { dataB64: string; contentType: string; filename: string } }
  | undefined
> {
  const snaps = await loadClockSnapshots(gameId);
  // A live read: it times the current turn, and the whole round before it.
  const live = await resolveCurrentTurn(gameId).catch(() => undefined);
  if (live?.stats) snaps.push({ ...turnStatsToClock(live.stats), source: 'live' });
  if (snaps.length === 0) return undefined;

  const added = await backfillFromReplay(snaps, (i) => fetchReplayTurn(gameId, i)).catch((err) => {
    console.warn(`[turntime] replay backfill failed for ${gameId}`, err);
    return [] as ClockSnapshot[];
  });
  if (added.length) {
    console.log(`[turntime] game ${gameId}: filled ${added.length} turn(s) from the replay`);
    const col = getFirestore().collection('games').doc(gameId).collection('turnClock');
    await Promise.all(
      added.map((s) => {
        const { source: _source, ...doc } = s;
        return col
          .doc(`d${String(s.day).padStart(4, '0')}-p${s.turnPlayerId || 'x'}`)
          .set({ ...doc, fetchedAt: FieldValue.serverTimestamp() })
          .catch((err) => console.warn('[turntime] turnClock write failed', err));
      })
    );
  }

  const report = computeTurnTimes([...snaps, ...added], Date.now());
  if (report.timedTurns === 0 && !report.players.some((p) => p.currentMs)) return undefined;
  const ranked = rankBySlowest(report.players);

  const lines = ranked.map((p) => {
    const s = summarize(p.turns.map((t) => t.ms));
    const who = `${p.username}${p.coName ? ` (${p.coName})` : ''}${p.eliminated ? ' — out' : ''}`;
    const nums = s
      ? `avg ${formatSpan(s.mean)} · med ${formatSpan(s.median)} · min ${formatSpan(s.min)} · max ${formatSpan(s.max)} · ${s.count} turn${s.count === 1 ? '' : 's'}`
      : 'no finished turns timed';
    const now = p.currentMs !== undefined ? `\n   ⏳ on the clock ${formatSpan(p.currentMs)}` : '';
    return `${who}\n   ${nums}${now}`;
  });
  const span =
    report.firstDay && report.currentDay
      ? `Day ${report.firstDay}–${report.currentDay}, ${report.timedTurns} turns timed`
      : `${report.timedTurns} turns timed`;
  const caption = `⏱️ Turn time, slowest first (${span})\n\n${lines.join('\n')}\n\n${gameLink(gameId)}`;

  let attachment: { dataB64: string; contentType: string; filename: string } | undefined;
  if (renderUrl) {
    try {
      const gameName = await loadGameName(gameId);
      const bypass = process.env.RENDER_BYPASS_TOKEN;
      const res = await fetch(new URL('/api/turntime/render', renderUrl).toString(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(bypass ? { 'x-vercel-protection-bypass': bypass, cookie: `x-vercel-protection-bypass=${bypass}` } : {}),
        },
        body: JSON.stringify({
          title: `Turn time — ${gameName || `Game ${gameId}`}`,
          subtitle: `${span} · slowest average first`,
          referenceMs,
          players: ranked.map((p) => ({
            name: p.username,
            co: p.coName,
            army: p.countryCode,
            eliminated: p.eliminated,
            turnsMs: p.turns.map((t) => t.ms),
            currentMs: p.currentMs,
          })),
        }),
      });
      if (res.ok) {
        attachment = {
          dataB64: Buffer.from(await res.arrayBuffer()).toString('base64'),
          contentType: 'image/png',
          filename: `awbw-${gameId}-turntime.png`,
        };
      } else {
        console.warn(`[turntime] render failed ${res.status}`);
      }
    } catch (err) {
      console.warn('[turntime] render fetch failed', err);
    }
  }
  return { caption, attachment };
}

// Track recent NextTurn events to prevent duplicate processing
const recentNextTurns = new Map<string, number>(); // key: `${gameId}-${day}-${playerId}`, value: timestamp
const NEXT_TURN_DEDUP_WINDOW_MS = 5000; // Ignore duplicate NextTurn events within 5 seconds
// ── Receive diagnostics ──────────────────────────────────────────────────────
// What the receiver has seen, exposed via the /debug/receive endpoint so receive can be
// verified without Cloud Run log access. (How it receives is the messaging backend's business.)
let receiverActive = false; // is this replica currently running the receiver?
let snapshotReady = false; // has the groupGames listener attached (initial snapshot received)?
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
              inviterUid: patchId.replace(`${data.gameId}-`, ''),
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
  const backend = requireMessaging();

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

  const outgoing = {
    message: messageText,
    mentions: mentionPlaceholders.map((m) => ({ author: m.number, start: m.start, length: m.length })),
  };
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
    const groupRecipient = rawId;
    console.log(`[sendSignal] Group send to ${groupRecipient.substring(0, 60)}...`);

    const doGroupSend = async () => {
      if (abortSignal?.aborted) throw new Error('Request aborted');
      return backend.sendToGroup(rawId, outgoing, { timeoutMs: 30000, signal: abortSignal });
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
    return backend.sendToPerson(dmRecipient, outgoing, { timeoutMs: 30000, signal: abortSignal });
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
): Promise<number | undefined> {
  return requireMessaging().sendToGroup(groupId, { message, mentions, attachment });
}

/** Reply straight to one person. A DM recipient is their number (or, when Signal withholds
 *  it, their ACI) rather than a group id — otherwise identical to a group send. */
async function sendDirect(
  recipient: string,
  message: string,
  attachment?: { dataB64: string; contentType: string; filename: string }
): Promise<number | undefined> {
  return requireMessaging().sendToPerson(recipient, { message, attachment });
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
              platform: PLATFORM,
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
  '/fun [on|off]        — unit/CO hologram image on turn pings (mod)\n' +
  '/remind <dur|off>    — nudge the current player if they sit on their turn (mod)\n' +
  '/stats [metric] [log] — chart the game so far (armyValue, unitValue, funds, income, properties)\n' +
  '/turntime            — how long each player takes per turn, slowest first\n' +
  '/status              — current state\n' +
  '/sync                — check AWBW now and post if we missed a turn\n' +
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
  /** Chat platform the group is on (see messaging/). Absent on games bound before it was
   *  recorded, which are all Signal's. */
  platform?: string;
  gameId?: string;
  gameName?: string;
  status: 'pending' | 'active' | 'stopped' | 'ended';
  createdBy?: { aci?: string; number?: string };
  mods?: string[];
  players?: Record<string, PlayerMapping>;
  funEnabled?: boolean;
  scope?: 'mine' | 'all';
  lastTurn?: { day?: number | null; awbwUsername?: string };
  lastUnitHp?: Record<string, number>; // units_id -> hp at last sighting, for HP-change detection
  // Turn reminders: nudge the current player if they sit on their turn.
  turnStartedAt?: number;     // ms epoch when the current player's turn began (from our POV)
  reminderMs?: number | null; // override threshold; null = reminders off; undefined = default
  lastReminderAt?: number;    // ms epoch of the most recent reminder sent this turn (repeat cadence)
  dayLimitNoticeDay?: number; // game day the last day-limit countdown was posted for
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

// Signal group internal IDs are standard base64 (alphabet A–Z a–z 0–9 + / =), which can contain
// '/'. Firestore treats '/' in a doc id as a PATH separator, so `.doc('a/b/c')` silently writes to
// a nested subcollection instead of a top-level doc. Such a binding stays readable via ggRef (same
// mangled path every time) but is INVISIBLE to `collection('groupGames')` queries/listeners — so
// the watcher socket never starts and no turn pings fire. Map '/' -> '_' for the doc id only.
// Standard base64 never emits '_', so this is collision-free and a no-op for slash-free ids (no
// migration needed for those); '_' -> '/' recovers the raw group id from a doc id.
function groupDocId(groupId: string): string {
  return groupId.replace(/\//g, '_');
}
function groupIdFromDocId(docId: string): string {
  return docId.replace(/_/g, '/');
}

function ggRef(groupId: string) {
  return getFirestore().collection('groupGames').doc(groupDocId(groupId));
}

// Append-only audit log of binding lifecycle changes (bound / rebound / stopped / ended /
// reminder_config). The bot never deletes or overwrites-away a binding without leaving a trace
// here, so a disappeared/changed binding is always traceable. Fire-and-forget.
function logBindingEvent(groupId: string, event: string, data: Record<string, unknown> = {}): void {
  getFirestore()
    .collection('bindingEvents')
    .add({ groupId, event, at: FieldValue.serverTimestamp(), ...data })
    .catch((e) => console.error('[audit] bindingEvent write failed', e));
}

// Turn-reminder helpers.
const DEFAULT_REMINDER_MS = 24 * 60 * 60 * 1000; // 1 day — AWBW's default per-turn increment
/** Parse a duration like "12h", "2d", "90m", "1d12h" → ms, or null if invalid. */
function parseDurationMs(s: string): number | null {
  let ms = 0;
  let matched = false;
  const re = /(\d+)\s*(d|h|m)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s.toLowerCase()))) {
    matched = true;
    const n = Number(m[1]);
    ms += m[2] === 'd' ? n * 86400000 : m[2] === 'h' ? n * 3600000 : n * 60000;
  }
  return matched && ms > 0 ? ms : null;
}
function formatDurationMs(ms: number): string {
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  const mn = Math.floor((ms % 3600000) / 60000);
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (mn && !d) parts.push(`${mn}m`);
  return parts.join(' ') || '0m';
}
/** Reminder threshold for a group: null = disabled, a number override, else the default. */
function reminderThresholdMs(gg: GroupGame): number | null {
  if (gg.reminderMs === null) return null;
  if (typeof gg.reminderMs === 'number' && gg.reminderMs > 0) return gg.reminderMs;
  return DEFAULT_REMINDER_MS;
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
  // A command arrived here, so the group is on this worker's platform. Record it on a game bound
  // before platforms were recorded, so only this platform's worker watches it.
  if (gg && !gg.platform) {
    await ggRef(groupId).set({ platform: PLATFORM }, { merge: true }).catch((e) =>
      console.error('[gg] platform tag failed', e)
    );
  }

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
    // Switching to a different game invalidates the old game's turn state. Clearing lastTurn
    // also makes the bind-time sync below announce whose move it is in the new game. On a
    // same-game re-bind, lastTurn is kept (no duplicate announcement) but the reminder clock
    // still restarts — any prior clock predates this bind.
    const gameChanged = !!gg?.gameId && gg.gameId !== gameId;
    const staleTurnState = {
      turnStartedAt: Date.now(),
      lastReminderAt: null,
      ...(gameChanged ? { lastTurn: FieldValue.delete(), lastUnitHp: FieldValue.delete(), dayLimitNoticeDay: FieldValue.delete() } : {}),
    };
    await ggRef(groupId).set(
      {
        groupId,
        platform: PLATFORM,
        gameId,
        gameName: gameName || null,
        status: 'active',
        createdBy: gg?.createdBy || { aci: senderAci || null, number: senderNumber || null },
        mods: gg?.mods || (senderAci ? [senderAci] : []),
        players: existingPlayers,
        funEnabled: gg?.funEnabled ?? true, // fun mode is the default for new games; preserves an explicit /fun off
        ...staleTurnState,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    logBindingEvent(groupId, gg?.gameId && gg.gameId !== gameId ? 'rebound' : 'bound', {
      gameId,
      prevGameId: gg?.gameId || null,
      actor: { aci: senderAci || null, name: senderName || null },
    });
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
    applyGroupGameWatch(groupId, { ...gg, groupId, gameId, status: 'active' } as GroupGame, 'modified');
    void syncGroupGameIfTurnChanged(groupId, gameId, '/game bind').catch((e) =>
      console.error('[gg] /game sync failed', e)
    );
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
      await reply('Only a mod can toggle the hologram image.');
      return;
    }
    const explicit = (args[0] || '').toLowerCase();
    const newFun = explicit === 'on' ? true : explicit === 'off' ? false : !gg.funEnabled;
    await ggRef(groupId).update({ funEnabled: newFun, updatedAt: FieldValue.serverTimestamp() });
    await reply(`Hologram image ${newFun ? 'on ✨' : 'off'}.`);
    return;
  }

  if (cmd === '/stats') {
    if (!gg.gameId) {
      await reply('No game bound yet. Run /game <link> first.');
      return;
    }
    const { metric, logScale } = parseStatsArgs(args);
    const chart = await buildStatsChart(gg.gameId, metric, logScale);
    if (!chart) {
      await reply(
        'No turns recorded yet. Com Tower charts from its own record of the game rather than ' +
          'the replay API, so the history starts from the first turn after it began watching.'
      );
      return;
    }
    await sendGroupRaw(groupId, chart.caption, undefined, chart.attachment);
    return;
  }

  if (cmd === '/turntime' || cmd === '/clock' || cmd === '/thinktime') {
    if (!gg.gameId) {
      await reply('No game bound yet. Run /game <link> first.');
      return;
    }
    const report = await buildTurnTimeReport(gg.gameId, reminderThresholdMs(gg)).catch((err) => {
      console.warn('[turntime] failed', err);
      return undefined;
    });
    if (!report) {
      await reply('No turns timed yet — Com Tower needs to see at least one turn change first.');
      return;
    }
    await sendGroupRaw(groupId, report.caption, undefined, report.attachment);
    return;
  }

  if (cmd === '/remind') {
    if (!isGgMod(gg, senderAci)) {
      await reply('Only a mod can change turn reminders.');
      return;
    }
    const actor = { aci: senderAci || null, name: senderName || null };
    const arg = (args[0] || '').toLowerCase();
    if (arg === 'off' || arg === 'disable' || arg === 'none') {
      await ggRef(groupId).update({ reminderMs: null, updatedAt: FieldValue.serverTimestamp() });
      logBindingEvent(groupId, 'reminder_config', { gameId: gg.gameId, reminderMs: null, actor });
      await reply('Turn reminders: off.');
      return;
    }
    if (arg === '' || arg === 'default' || arg === 'reset') {
      await ggRef(groupId).update({ reminderMs: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() });
      logBindingEvent(groupId, 'reminder_config', { gameId: gg.gameId, reminderMs: 'default', actor });
      await reply(`Turn reminders: default (every ${formatDurationMs(DEFAULT_REMINDER_MS)}).`);
      return;
    }
    const ms = parseDurationMs(args.join(' '));
    if (!ms) {
      await reply('Usage: /remind <duration like 12h, 2d, 1d12h | off | default>');
      return;
    }
    await ggRef(groupId).update({ reminderMs: ms, updatedAt: FieldValue.serverTimestamp() });
    logBindingEvent(groupId, 'reminder_config', { gameId: gg.gameId, reminderMs: ms, actor });
    await reply(`Turn reminders: every ${formatDurationMs(ms)} until the player moves. (/remind off to disable)`);
    return;
  }

  if (cmd === '/status') {
    const n = Object.keys(gg.players || {}).length;
    const modCount = (gg.mods || []).length;
    const st = activeGGSockets.get(groupId);
    const wsState =
      st?.ws.readyState === WebSocket.OPEN
        ? 'connected'
        : st
          ? `state ${st.ws.readyState}`
          : 'not watching';
    let msg = `Game ${gg.gameId}${gg.gameName ? ` (${gg.gameName})` : ''} — ${gg.status}\n${gameLink(gg.gameId)}\n`;
    msg += `Players mapped: ${n} · mods: ${modCount} · fun: ${gg.funEnabled ? 'on' : 'off'} · ws: ${wsState}`;
    if (gg.lastTurn?.awbwUsername)
      msg += `\nLast turn seen: ${gg.lastTurn.awbwUsername}${gg.lastTurn.day ? ` (day ${gg.lastTurn.day})` : ''}`;
    else msg += `\nLast turn seen: never — run /sync to catch up`;
    if (st?.lastNextTurnAt)
      msg += `\nLast ws NextTurn: ${new Date(st.lastNextTurnAt).toISOString()}`;
    const rt = reminderThresholdMs(gg);
    msg += `\nReminders: ${rt === null ? 'off' : `every ${formatDurationMs(rt)}${typeof gg.reminderMs === 'number' ? '' : ' (default)'}`}`;
    await reply(msg);
    return;
  }

  if (cmd === '/sync' || cmd === '/catchup') {
    const result = await syncGroupGameIfTurnChanged(groupId, gg.gameId, '/sync');
    if (result === 'notified') {
      await reply('✅ Posted a turn notification for whoever is up now.');
    } else if (result === 'unchanged') {
      const last = gg.lastTurn?.awbwUsername || 'never';
      const current = (await resolveCurrentPlayerName(gg.gameId).catch(() => undefined)) || '?';
      await reply(`Up to date — ${current} is up (last notified: ${last}).`);
    } else if (result === 'no_player') {
      await reply("Couldn't read the current player from AWBW — try again in a moment.");
    } else {
      await reply('Not watching an active game.');
    }
    return;
  }

  if (cmd === '/stop' || cmd === '/unwatch') {
    if (!isGgMod(gg, senderAci)) {
      await reply('Only a mod can stop watching.');
      return;
    }
    await ggRef(groupId).update({ status: 'stopped', updatedAt: FieldValue.serverTimestamp() });
    logBindingEvent(groupId, 'stopped', { gameId: gg.gameId, actor: { aci: senderAci || null, name: senderName || null } });
    await reply(`Stopped watching game ${gg.gameId}. Run /game <link> to resume.`);
    return;
  }

  await reply(HELP_TEXT);
}

const DM_HELP =
  '📋 Com Tower — direct commands\n' +
  'A DM has no bound game, so name one:\n' +
  '/stats <awbw link or game id> [metric] [log]\n' +
  '     — chart the game (armyValue, unitValue, funds, income, properties, unitCount)\n' +
  '/turntime <awbw link or game id> — how long each player takes per turn\n' +
  '/ping — connectivity check\n' +
  '\n' +
  'Everything else lives in a group chat: add Com Tower there and run /game <link>.';

/** Commands sent straight to the bot rather than in a group. Stateless by design — there is
 *  no binding in a DM, so anything game-specific names its game inline. */
async function handleDmCommand(env: any, text: string): Promise<void> {
  const to: string | undefined = env?.sourceNumber || env?.sourceUuid;
  if (!to) return;
  const parts = text.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1);
  const reply = (msg: string) => sendDirect(to, msg).catch(() => undefined);
  console.log(`[dm] command "${cmd}" from ${env.sourceName || to}`);

  if (cmd === '/ping') {
    await reply('🛰️ Com Tower online.');
    return;
  }
  if (cmd === '/stats') {
    const gameId = extractGameIdFromArg(args[0]);
    if (!gameId) {
      await reply('Which game? /stats <awbw link or game id> [metric]');
      return;
    }
    const { metric, logScale } = parseStatsArgs(args.slice(1));
    const chart = await buildStatsChart(gameId, metric, logScale);
    if (!chart) {
      await reply(
        `No turns recorded for game ${gameId} yet. Com Tower charts from its own record ` +
          'rather than the replay API, so history starts once it is watching the game.'
      );
      return;
    }
    await sendDirect(to, chart.caption, chart.attachment);
    return;
  }
  if (cmd === '/turntime' || cmd === '/clock' || cmd === '/thinktime') {
    const gameId = extractGameIdFromArg(args[0]);
    if (!gameId) {
      await reply('Which game? /turntime <awbw link or game id>');
      return;
    }
    const report = await buildTurnTimeReport(gameId).catch((err) => {
      console.warn('[turntime] failed', err);
      return undefined;
    });
    if (!report) {
      await reply(`No turns timed for game ${gameId} yet.`);
      return;
    }
    await sendDirect(to, report.caption, report.attachment);
    return;
  }
  await reply(DM_HELP);
}

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
  if (!text.startsWith('/')) return;
  if (!groupId) {
    // A DM has no bound game, so only the stateless queries make sense here — they take the
    // game on the command line instead. Previously every DM command was silently dropped,
    // which is worse than saying so.
    await handleDmCommand(env, text).catch((err) => console.error('[dm] command failed:', err));
    return;
  }
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

/** Record a received item for diagnostics and route it. */
async function handleIncomingItem(item: any): Promise<void> {
  recordRaw(item);
  await handleSignalIncoming(item).catch((err) =>
    console.error('[bot] Error handling incoming message:', err)
  );
}

/** Start receiving through the messaging backend. */
async function startSignalReceiver(): Promise<void> {
  if (!messaging) {
    console.warn('[bot] receiver disabled: messaging bridge not configured (SIGNAL_CLI_URL / SIGNAL_BOT_NUMBER)');
    return;
  }
  await messaging.startReceiving(handleIncomingItem);
}

/** Stop the receiver on this replica (used when it loses the receiver role). */
function stopSignalReceiver(): void {
  messaging?.stopReceiving();
}

/** Start/stop the receiver so exactly the replica that currently holds the receiver role runs it.
 *  Called at startup and whenever ownership changes (leader handover / shard receiver failover). */
function syncReceiver(): void {
  const shouldRun = ownership.isReceiver();
  if (shouldRun && !receiverActive) {
    receiverActive = true;
    console.log('[bot] becoming Signal receiver');
    startSignalReceiver().catch((err) => { receiverActive = false; console.error('[bot] receiver start failed:', err); });
  } else if (!shouldRun && receiverActive) {
    receiverActive = false;
    console.log('[bot] relinquishing Signal receiver');
    stopSignalReceiver();
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
  lastWsAt?: number;
  lastNextTurnAt?: number;
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

/** Announce the end of a watched game to the group, mark it ended, and stop watching.
 *  Safe to call from both detection paths (page check + websocket) — the status guard
 *  keeps a second detection from re-announcing. */
async function announceGameEnded(
  groupId: string,
  gameId: string,
  reason: string,
  message?: string
): Promise<void> {
  const snap = await ggRef(groupId).get().catch(() => undefined);
  const status = snap?.exists ? (snap.data() as GroupGame).status : undefined;
  stopGGSocket(groupId, reason);
  if (status === 'ended') return; // already announced (other detection path won the race)
  await ggRef(groupId)
    .update({ status: 'ended', updatedAt: FieldValue.serverTimestamp() })
    .catch(() => {});
  logBindingEvent(groupId, 'ended', { gameId });
  const headline = message || `Game ${gameId} is over.`;
  await sendGroupReply(
    groupId,
    `🏁 ${headline}\nI've stopped watching it — run /game <link> when the next one starts.`
  ).catch((e) => console.error('[gg] end-of-game announce failed', e));
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
    fetchGameEndInfo(gameId)
      .then((info) => {
        if (info.ended)
          return announceGameEnded(groupId, gameId, 'game ended (page check)', info.message);
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
      state.lastWsAt = Date.now();
      const msgType =
        parsed?.type ||
        (parsed?.NextTurn && 'NextTurn') ||
        (parsed?.Pause && 'Pause') ||
        (parsed?.GameOver && 'GameOver') ||
        (parsed?.GameEnd && 'GameEnd') ||
        'unknown';
      if (msgType !== 'NextTurn') {
        console.log(`[gg] ws ${gameId}: ${msgType}`);
        if (parsed?.GameOver || parsed?.GameEnd || msgType === 'GameOver' || msgType === 'GameEnd') {
          // Best-effort winners message from the page; announce generically if it's not up yet.
          void fetchGameEndInfo(gameId)
            .then((info) => announceGameEnded(groupId, gameId, 'game over (ws)', info.message))
            .catch(() => announceGameEnded(groupId, gameId, 'game over (ws)'));
        }
        return;
      }
      const next = parsed?.NextTurn || parsed?.nextTurn || parsed || {};
      const socketPlayer =
        next.playerName || next.player_name || next.player || next.username || next.name;
      const day = next.day;
      const nextPId = next.nextPId ?? next.playerId ?? next.player_id;
      const dedupKey = `gg-${groupId}-${gameId}-${day}-${nextPId ?? next.nextTurnStart ?? socketPlayer}`;
      const now = Date.now();
      const last = recentNextTurns.get(dedupKey);
      if (last && now - last < NEXT_TURN_DEDUP_WINDOW_MS) return;
      recentNextTurns.set(dedupKey, now);
      state.lastNextTurnAt = now;
      console.log(`[gg] NextTurn ${gameId} day=${day} pid=${nextPId ?? '?'}`);
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

/** The countdown posts at the start of each of the game's last this-many days (counting the final day). */
const DAY_LIMIT_NOTICE_DAYS = 6;

function dayLimitNotice(day: number, dayLimit: number): string | undefined {
  const left = dayLimit - day + 1;
  if (left < 1 || left > DAY_LIMIT_NOTICE_DAYS) return undefined;
  if (left === 1) {
    return `📯 Attention, warlords: this is the final day. The game ends after day ${dayLimit} for property assessment.`;
  }
  return `📯 Attention, warlords: ${left} days remain before property assessment. Day ${dayLimit} is the last.`;
}

/** Post the day-limit countdown once per game day, ahead of that day's first turn ping.
 *  Claimed in a transaction so a socket event and the poll fallback can't both post it. */
async function maybeAnnounceDayLimit(groupId: string, day?: number, dayLimit?: number): Promise<void> {
  if (!day || !dayLimit) return;
  const text = dayLimitNotice(day, dayLimit);
  if (!text) return;
  const claimed = await getFirestore()
    .runTransaction(async (tx) => {
      const snap = await tx.get(ggRef(groupId));
      if ((snap.data() as GroupGame | undefined)?.dayLimitNoticeDay === day) return false;
      tx.update(ggRef(groupId), { dayLimitNoticeDay: day });
      return true;
    })
    .catch((e) => {
      console.error('[gg] day-limit claim failed', e);
      return false;
    });
  if (!claimed) return;
  console.log(`[gg] day-limit notice group ${groupId.substring(0, 16)} day=${day}/${dayLimit}`);
  await sendGroupRaw(groupId, text).catch((e) => console.error('[gg] day-limit notice failed', e));
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
  if (!turn) {
    console.warn(`[gg] resolveCurrentTurn failed for game ${gameId} — no unit/CO context, ping will have no image`);
  }
  // Sample the game before anything else: this is the only chance to capture this turn
  // without going back through the replay API, and it must not depend on the send working.
  if (turn && !turn.stats) {
    console.warn(`[stats] no sample parsed for game ${gameId} — this turn will be missing from charts`);
  }
  if (turn?.stats) {
    await recordTurnStats(gameId, turn.stats);
    console.log(
      `[stats] game ${gameId} day ${turn.stats.day}: ` +
        Object.values(turn.stats.players)
          .map((p) => `${p.username}=${Math.round(p.unitValue / 100) / 10}k`)
          .join(' ')
    );
  }
  await maybeAnnounceDayLimit(groupId, turn?.day ?? meta.day, turn?.dayLimit);
  const currentPlayer =
    turn?.username ||
    (await scrapeCurrentPlayerName(gameId).catch(() => undefined)) ||
    meta.socketPlayer;
  // Feature a real living unit by default. Only feature the CO when there's a
  // CO-related reason — a CO Power / Super CO Power is charged — or there are no
  // units to feature (early game).
  const liveUnits = turn?.units || [];
  const lastHp = gg.lastUnitHp || {};
  // HP change since this player's last turn (damage taken in the round, or healing).
  const withDelta = liveUnits.map((u) => ({
    u,
    delta: u.id && lastHp[u.id] !== undefined ? u.hp - lastHp[u.id] : 0,
  }));
  const featureCo = liveUnits.length === 0 || !!turn?.co?.power;
  let chosenUnit: AwbwUnit | undefined;
  if (!featureCo && liveUnits.length) {
    // Prefer a unit that just took damage; else one that was healed; else any.
    const damaged = withDelta.filter((w) => w.delta < 0);
    const healed = withDelta.filter((w) => w.delta > 0);
    const pool = damaged.length ? damaged : healed.length ? healed : withDelta;
    chosenUnit = pool[Math.floor(Math.random() * pool.length)].u;
  }
  const co = featureCo ? turn?.co : undefined;
  const armyCode = chosenUnit?.code || turn?.countryCode;
  const army = armyCode ? { code: armyCode } : undefined;
  const unitInfo = chosenUnit ? { name: chosenUnit.name } : undefined;
  if (!currentPlayer) {
    // Couldn't name the player, but a turn DID change — notify anyway so it's never silent.
    console.log('[gg] turn changed but current player unresolved; sending generic notice');
    await sendGroupRaw(
      groupId,
      `⏭️${meta.day ? ` Day ${meta.day}.` : ''} New turn.\n${gameLink(gameId)}`
    ).catch((e) => console.error('[gg] generic notice failed', e));
    await ggRef(groupId)
      .update({ lastTurn: { day: meta.day ?? null, awbwUsername: null }, turnStartedAt: Date.now(), lastReminderAt: null, updatedAt: FieldValue.serverTimestamp() })
      .catch(() => {});
    return;
  }
  const info = await loadPlayers(gameId).catch(() => ({ players: [] as string[], countries: [] as string[] }));
  const gameName = gg.gameName || (await loadGameName(gameId)) || undefined;
  const payload = await buildMessage(
    gameId,
    {
      day: meta.day,
      playerName: currentPlayer,
      socketPlayerName: meta.socketPlayer,
      players: info.players,
      members: Object.keys(gg.players || {}),
      gameName,
      funEnabled: gg.funEnabled,
    },
    army,
    unitInfo,
    co
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

  // Snapshot the current player's unit HP (merged) so next time we can detect damage/healing.
  const newUnitHp: Record<string, number> = { ...(gg.lastUnitHp || {}) };
  for (const u of liveUnits) if (u.id) newUnitHp[u.id] = u.hp;

  try {
    try {
      await sendGroupRaw(groupId, message, mentions.length ? mentions : undefined, attachment);
    } catch (sendErr) {
      if (attachment) {
        // Attachment uploads are the slow window where a competing connection on the same
        // Signal account kills the send (ConnectedElsewhereException) — a second attempt
        // usually lands, so retry WITH the image before giving up on it.
        console.warn('[gg] send with attachment failed; retrying with attachment', sendErr);
        await new Promise((r) => setTimeout(r, 2000));
        try {
          await sendGroupRaw(groupId, message, mentions.length ? mentions : undefined, attachment);
        } catch (retryErr) {
          console.warn('[gg] attachment retry failed; sending text-only', retryErr);
          await sendGroupRaw(groupId, message, mentions.length ? mentions : undefined);
        }
      } else {
        throw sendErr;
      }
    }
    await ggRef(groupId)
      .update({
        lastTurn: { day: meta.day ?? null, awbwUsername: currentPlayer },
        lastUnitHp: newUnitHp,
        turnStartedAt: Date.now(), // reminder clock: this player's turn started now (from our POV)
        lastReminderAt: null,      // re-arm reminders for the new turn
        updatedAt: FieldValue.serverTimestamp(),
      })
      .catch(() => {});
    console.log(
      `[gg] notified group ${groupId.substring(0, 16)} turn=${currentPlayer} mentioned=${mentions.length > 0} attachment=${attachment ? `${attachment.filename} (${Math.round(attachment.dataB64.length * 0.75 / 1024)}KB)` : 'none'}`
    );
  } catch (err) {
    console.error('[gg] send failed', err);
  }
}

/** Scrape current player vs lastTurn; notify if the turn advanced (websocket fallback). */
async function syncGroupGameIfTurnChanged(
  groupId: string,
  gameId: string,
  reason: string
): Promise<'notified' | 'unchanged' | 'no_player' | 'inactive'> {
  const snap = await ggRef(groupId).get();
  if (!snap.exists) return 'inactive';
  const gg = snap.data() as GroupGame;
  if (gg.status !== 'active' || gg.gameId !== gameId) return 'inactive';
  const currentPlayer = await resolveCurrentPlayerName(gameId).catch(() => undefined);
  if (!currentPlayer) return 'no_player';
  if (currentPlayer === (gg.lastTurn?.awbwUsername || undefined)) return 'unchanged';
  console.log(`[gg] ${reason}: turn=${currentPlayer} for group ${groupId.substring(0, 16)}`);
  try {
    await onGroupGameNextTurn(groupId, gameId, { socketPlayer: currentPlayer });
    return 'notified';
  } catch (e) {
    console.error('[gg] sync notify failed', e);
    return 'no_player';
  }
}

function applyGroupGameWatch(groupId: string, gg: GroupGame, changeType: string) {
  if (gg.status !== 'active' || !gg.gameId) {
    stopGGSocket(groupId, changeType === 'removed' ? 'doc removed' : `status ${gg.status}`);
    return;
  }
  // Only watch games this replica owns (singleton owns all; shard owns its slice; leader owns
  // all iff elected). Games we don't own are another replica's responsibility — drop any socket.
  if (!isOurPlatform(gg)) {
    stopGGSocket(groupId, `on ${platformOf(gg)}, not ${PLATFORM}`);
    return;
  }
  if (!ownership.owns(gg.gameId)) {
    stopGGSocket(groupId, 'not owned by this replica');
    return;
  }
  const st = activeGGSockets.get(groupId);
  if (st && st.gameId === gg.gameId && st.shouldReopen) return;
  startGroupGameSocket(groupId, gg.gameId);
}

/** Re-evaluate every active group game against current ownership (start owned, drop unowned).
 *  Fired when ownership changes (leadership won/lost). No-op churn for static strategies. */
async function reevaluateOwnership() {
  let snap;
  try {
    snap = await getFirestore().collection('groupGames').where('status', '==', 'active').get();
  } catch (err) {
    console.warn('[gg] ownership re-eval query failed', err);
    return;
  }
  console.log(`[gg] re-evaluating ownership over ${snap.size} active games (receiver=${ownership.isReceiver()})`);
  for (const doc of snap.docs) {
    applyGroupGameWatch(groupIdFromDocId(doc.id), doc.data() as GroupGame, 'ownership-change');
  }
}

const TURN_POLL_MS = 60 * 60 * 1000; // hourly — slow is fine; this exists so missed turns are eventually caught
/** Poll the game page and compare current player to lastTurn. Independent of websocket health.
 *  The websocket is the fast path; this is the recovery path when we never noticed a turn change. */
async function runTurnPoll() {
  let snap;
  try {
    snap = await getFirestore().collection('groupGames').where('status', '==', 'active').get();
  } catch (err) {
    console.warn('[gg] backstop query failed', err);
    return;
  }
  for (const doc of snap.docs) {
    const gg = { ...(doc.data() as GroupGame), groupId: groupIdFromDocId(doc.id) };
    if (!gg.gameId || !isOurPlatform(gg)) continue;
    if (!ownership.owns(gg.gameId)) continue; // another replica's game
    await syncGroupGameIfTurnChanged(gg.groupId, gg.gameId, 'turn-poll');
  }
}

const REMINDER_CHECK_MS = 15 * 60 * 1000; // check every 15 min; thresholds are coarse (~hours/days)
/** Nudge the current player when they've sat on their turn past the threshold, and keep nudging
 *  every threshold until they move (or a mod /stops the game). The @-ping targets only the current
 *  player, so it doesn't burden the rest of the group. */
async function runReminderCheck() {
  let snap;
  try {
    snap = await getFirestore().collection('groupGames').where('status', '==', 'active').get();
  } catch (err) {
    console.warn('[remind] query failed', err);
    return;
  }
  const now = Date.now();
  for (const doc of snap.docs) {
    const gg = { ...(doc.data() as GroupGame), groupId: groupIdFromDocId(doc.id) };
    if (!gg.gameId || !isOurPlatform(gg) || !ownership.owns(gg.gameId)) continue;
    const threshold = reminderThresholdMs(gg);
    if (threshold === null) continue; // reminders disabled for this group
    const current = gg.lastTurn?.awbwUsername;
    if (!current) continue; // player unknown (generic-notice turn) — can't target a nudge
    if (!gg.turnStartedAt) {
      // No baseline yet (e.g. a game already in progress before this feature shipped) — start the
      // clock now so a stuck turn gets nudged ~a threshold from here rather than never.
      await ggRef(gg.groupId).update({ turnStartedAt: now }).catch(() => {});
      continue;
    }
    const sinceLast = now - (gg.lastReminderAt || gg.turnStartedAt);
    if (sinceLast < threshold) continue; // not due yet
    // A reminder is due, so we're touching AWBW anyway — first make sure the game isn't over
    // (catches an end the websocket missed; without this we'd nudge a finished game forever).
    const endInfo = await fetchGameEndInfo(gg.gameId).catch(() => ({ ended: false as const }));
    if (endInfo.ended) {
      await announceGameEnded(gg.groupId, gg.gameId, 'game ended (reminder check)', (endInfo as { message?: string }).message).catch(() => {});
      continue;
    }
    // Confirm they still haven't moved — catches a websocket-missed turn change (then no nudge).
    const scraped = await resolveCurrentPlayerName(gg.gameId).catch(() => undefined);
    if (scraped && scraped.toLowerCase() !== String(current).toLowerCase()) {
      await syncGroupGameIfTurnChanged(gg.groupId, gg.gameId, 'reminder-detected-move').catch(() => {});
      continue;
    }
    await sendTurnReminder(gg, now - gg.turnStartedAt).catch((e) => console.error('[remind] send failed', e));
    await ggRef(gg.groupId).update({ lastReminderAt: now }).catch(() => {});
  }
}

/** Build a reminder nudge with the hologram image for the current player. Mirrors the turn-ping
 *  context (a featured living unit, or the CO early / on a charged power); the render returns the
 *  "still your move" text via `reminderElapsed`. Returns undefined if the render degraded, so the
 *  caller falls back to the plain line. */
async function buildFunReminder(
  gg: GroupGame,
  currentPlayer: string,
  elapsed: string
): Promise<
  | {
      text: string;
      attachment?: { dataB64: string; contentType: string; filename: string };
    }
  | undefined
> {
  const gameId = gg.gameId!;
  const turn = await resolveCurrentTurn(gameId).catch(() => undefined);
  const liveUnits = turn?.units || [];
  // Feature the CO early (no units) or when a power is charged; else a random living unit. No
  // HP-delta preference — a reminder is the same turn, so there's no "damaged this round" to lean on.
  const featureCo = liveUnits.length === 0 || !!turn?.co?.power;
  const chosenUnit =
    !featureCo && liveUnits.length ? liveUnits[Math.floor(Math.random() * liveUnits.length)] : undefined;
  const co = featureCo ? turn?.co : undefined;
  const armyCode = chosenUnit?.code || turn?.countryCode;
  const army = armyCode ? { code: armyCode } : undefined;
  const unitInfo = chosenUnit ? { name: chosenUnit.name } : undefined;

  const info = await loadPlayers(gameId).catch(() => ({ players: [] as string[], countries: [] as string[] }));
  const gameName = gg.gameName || (await loadGameName(gameId)) || undefined;

  const payload = await buildMessage(
    gameId,
    {
      playerName: currentPlayer,
      players: info.players,
      gameName,
      funEnabled: true,
      reminderElapsed: elapsed,
    },
    army,
    unitInfo,
    co
  );
  // buildMessage degrades to a "[render error]" string rather than throwing — treat that (and empty)
  // as failure so we send the clean plain nudge instead of an error-tagged "you're up".
  if (!payload?.text || /\[render error/i.test(payload.text)) return undefined;
  const attachment = payload.imageData
    ? {
        dataB64: payload.imageData,
        contentType: payload.imageContentType || 'image/gif',
        filename: payload.imageFilename || 'unit.gif',
      }
    : undefined;
  return { text: payload.text, attachment };
}

/** Send a single turn-reminder nudge that @-pings only the current player: a plain "still your
 *  move" line, plus the unit/CO hologram from the render endpoint when the image is on (/fun),
 *  falling back to the plain line if that path fails. */
async function sendTurnReminder(gg: GroupGame, elapsedMs: number): Promise<void> {
  const current = gg.lastTurn?.awbwUsername;
  if (!gg.gameId || !current) return;
  const players = gg.players || {};
  const key = Object.keys(players).find((k) => k.toLowerCase() === String(current).toLowerCase());
  const mapping = key ? players[key] : undefined;
  const elapsed = formatDurationMs(elapsedMs);

  // Plain nudge — the whole message when the image is off, and the fallback if the render fails.
  let message = `⏰ Still your move, ${current} — ${elapsed} on the clock.\n${gameLink(gg.gameId)}`;
  let attachment: { dataB64: string; contentType: string; filename: string } | undefined;

  if (gg.funEnabled) {
    try {
      const built = await buildFunReminder(gg, current, elapsed);
      if (built?.text) {
        message = built.text;
        attachment = built.attachment;
      }
    } catch (e) {
      console.warn('[remind] hologram reminder build failed; sending plain nudge', e);
    }
  }

  const mentions: Array<{ author: string; start: number; length: number }> = [];
  if (mapping?.aci) {
    const spacer = message.endsWith(' ') || message.endsWith('\n') ? '' : ' ';
    const start = (message + spacer).length;
    message = `${message}${spacer}@`;
    mentions.push({ author: mapping.aci, start, length: 1 });
  }

  try {
    await sendGroupRaw(gg.groupId, message, mentions.length ? mentions : undefined, attachment);
  } catch (sendErr) {
    if (attachment) {
      // Same slow-attachment-upload race as the turn ping: retry with the image, then text-only.
      console.warn('[remind] send with attachment failed; retrying, then text-only', sendErr);
      await new Promise((r) => setTimeout(r, 2000));
      try {
        await sendGroupRaw(gg.groupId, message, mentions.length ? mentions : undefined, attachment);
      } catch (retryErr) {
        console.warn('[remind] attachment retry failed; sending text-only', retryErr);
        await sendGroupRaw(gg.groupId, message, mentions.length ? mentions : undefined);
      }
    } else {
      throw sendErr;
    }
  }
  console.log(
    `[remind] nudged ${gg.groupId.substring(0, 16)} player=${current} elapsed=${elapsed} fun=${gg.funEnabled ? 'on' : 'off'} img=${attachment ? 'yes' : 'no'}`
  );
}

// Firestore-backed leader-election lease. A single doc `_locks/leader` holds { holder, expiresAt }.
// A transaction grants/renews the lease only if it's unheld, expired, or already ours — so at most
// one replica is leader at a time. (The k8s-native swap-in later is a coordination.k8s.io/Lease.)
function firestoreLeaseStore(db: Firestore): LeaseStore {
  // Each platform's workers elect among themselves. Signal keeps the unprefixed keys it always had.
  const ref = (key: string) => db.collection('_locks').doc(PLATFORM === 'signal' ? key : `${PLATFORM}-${key}`);
  return {
    async tryAcquire(key: string, holderId: string, ttlMs: number): Promise<string | null> {
      return db.runTransaction(async (tx) => {
        const snap = await tx.get(ref(key));
        const data = snap.data() as { holder?: string; expiresAt?: number } | undefined;
        const now = Date.now();
        const held = data?.holder && (data.expiresAt ?? 0) > now && data.holder !== holderId;
        if (held) return data!.holder!; // someone else holds a live lease
        tx.set(ref(key), { holder: holderId, expiresAt: now + ttlMs });
        return holderId;
      });
    },
    async release(key: string, holderId: string): Promise<void> {
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref(key));
        if ((snap.data() as any)?.holder === holderId) tx.set(ref(key), { holder: null, expiresAt: 0 });
      });
    },
  };
}

async function main() {
  ensureFirebase();
  const db = getFirestore();

  // Decide which games this replica owns (SCALING_MODE). start() acquires any lease (leader).
  ownership = createOwnership({ leaseStore: firestoreLeaseStore(db) });
  await ownership.start();
  ownership.onChange(() => {
    // Ownership moved (leader handover / shard receiver failover): re-evaluate which games we watch
    // and whether we should be running the singleton Signal receiver.
    reevaluateOwnership().catch((err) => console.error('[gg] ownership re-eval failed', err));
    syncReceiver();
  });
  console.log(
    `Worker starting. PLATFORM=${PLATFORM}, SCALING_MODE=${ownership.mode}, receiver=${ownership.isReceiver()}. Watching groupGames...`
  );

  // Run the Signal receiver only on the replica that currently holds the receiver role, so incoming
  // commands aren't processed N times. syncReceiver() also handles start/stop on role changes.
  syncReceiver();

  // Hourly page poll: if current player ≠ last notified, we missed a turn — post now.
  setInterval(() => {
    runTurnPoll().catch((err) => console.error('[gg] turn-poll error', err));
  }, TURN_POLL_MS);

  // Turn reminders: nudge the current player if they sit on their turn past the threshold.
  setInterval(() => {
    runReminderCheck().catch((err) => console.error('[remind] check error', err));
  }, REMINDER_CHECK_MS);

  // Drive one AWBW socket per active group game; notify the group on each turn change. In shard
  // mode the query is narrowed to this replica's shardKey slice, so listener memory + Firestore
  // read load scale with replicas instead of every replica streaming the whole collection.
  let ggSnapshotBootstrapped = false;
  ownership.narrowSnapshotQuery(db.collection('groupGames')).onSnapshot((snap) => {
    if (!ggSnapshotBootstrapped) {
      ggSnapshotBootstrapped = true;
      snapshotReady = true; // readiness: we're now watching our games
      for (const doc of snap.docs) {
        applyGroupGameWatch(groupIdFromDocId(doc.id), doc.data() as GroupGame, 'bootstrap');
      }
    }
    snap.docChanges().forEach((change) => {
      applyGroupGameWatch(groupIdFromDocId(change.doc.id), change.doc.data() as GroupGame, change.type);
    });
  });


  // Simple health server for Cloud Run
  const port = Number(process.env.PORT) || 8080;
  const server = http.createServer(async (_, res) => {
    try {
      const url = new URL(_.url || '/', 'http://localhost');
      // Liveness: cheap, dependency-free — is the process/event loop alive? (restart on fail)
      if (url.pathname === '/healthz') {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, mode: ownership?.mode, receiver: receiverActive }));
        return;
      }
      // Readiness: are we actually doing our job? Ready once the groupGames listener has attached.
      // (Removed from Service endpoints while not ready; NOT restarted.)
      if (url.pathname === '/readyz') {
        res.statusCode = snapshotReady ? 200 : 503;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ready: snapshotReady, watching: activeGGSockets.size, receiver: receiverActive }));
        return;
      }
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
              platform: PLATFORM,
              mode: messaging?.receiverDiagnostics().mode ?? 'off',
              bridgeConfigured: !!messaging,
              lastReceiveError: messaging?.receiverDiagnostics().lastError ?? null,
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
          const bridge = signalCliBridge();
          if (!bridge) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Bridge not configured' }));
            return;
          }
          const challengeRes = await bridge.request(bridge.accountPath('/rate-limit-challenge'), {
            method: 'POST',
            data: { challenge: challengeToken, captcha: captchaToken },
            timeoutMs: 15000,
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
        const bridge = signalCliBridge();
        console.log(`[list-groups] Starting request. Bridge: ${bridge?.url}, Bot: ${bridge?.botId}`);
        if (!bridge) {
          console.error(`[list-groups] Bridge not configured.`);
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Bridge not configured' }));
          return;
        }
        const startTime = Date.now();
        try {
          const requestPath = `/v1/groups/${encodeURIComponent(bridge.botId)}`;
          console.log(`[list-groups] Making request to: ${bridge.url}${requestPath}`);
          // Try with a longer timeout - Signal bridge can be slow
          const timeoutMs = 30000; // 30 seconds
          console.log(`[list-groups] Setting timeout to ${timeoutMs}ms`);

          const groupsPromise = bridge.request(requestPath, { timeoutMs });
          
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
        if (!messaging) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Bridge not configured' }));
          return;
        }
        try {
          const groups: any[] = await messaging.listGroups();

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
          const bridge = signalCliBridge();
          if (!bridge) {
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
          console.log(`[join-group] Joining with URI: ${joinUri}`);
          const joinRes = await bridge.request(
            `/v1/groups/${encodeURIComponent(bridge.botId)}/join/${encodeURIComponent(joinUri)}`,
            { method: 'POST', timeoutMs: 30000 }
          );
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

