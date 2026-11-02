// How long each player sits on their turn — the "who is holding up the game" numbers behind
// /turntime. Kept free of Signal and the bot's globals so the timing rules can be tested.
//
// Where the times come from, best first:
//  1. AWBW's own players_turn_start. Every game page (and every replay turn) lists, for EVERY
//     player, when their most recent turn began — so one reading times the whole round before
//     it, and Com Tower's per-turn samples carry it from now on.
//  2. When Com Tower sampled a turn (`at` on its turnStats doc). The bot samples within seconds
//     of AWBW announcing the turn, so this matches AWBW to the second in practice; it is all a
//     game recorded before turnStart was captured has.
//  3. AWBW's replay API, for turns neither of the above covers (the bot was down, or the game
//     began before Com Tower watched it). One replay turn carries every player's last start,
//     so a whole day costs one request — fetched once and kept in games/{id}/turnClock.

export type ClockPlayer = {
  username?: string;
  countryCode?: string;
  coName?: string;
  order?: number;
  eliminated?: boolean;
  /** AWBW players_turn_start, server time ("2026-10-30 19:39:06", US Eastern). */
  turnStart?: string;
};

/** One reading of the game: whose turn it was on which day, and everyone's last turn start. */
export type ClockSnapshot = {
  day: number;
  turnPlayerId?: string;
  players: Record<string, ClockPlayer>;
  /** When Com Tower took this reading — only meaningful for a turn notification. */
  atMs?: number;
  source: 'notify' | 'replay' | 'live';
};

export type TurnTime = { day: number; ms: number };

export type PlayerTurnTimes = {
  pid: string;
  username: string;
  countryCode?: string;
  coName?: string;
  eliminated: boolean;
  turns: TurnTime[];
  /** How long they have been on the clock right now, if it is their turn. */
  currentMs?: number;
};

export type TurnTimesReport = {
  players: PlayerTurnTimes[];
  firstDay?: number;
  currentDay?: number;
  timedTurns: number;
  /** Days with a turn whose start is unknown, so its length (or the one before) is too. */
  missingDays: number[];
};

// ── AWBW server time ─────────────────────────────────────────────────────────

const nyParts = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** New York's offset from UTC at an instant, in ms (negative: -4h in summer, -5h in winter). */
function nyOffsetMs(utcMs: number): number {
  const parts = nyParts.formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const local = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return local - Math.floor(utcMs / 1000) * 1000;
}

/** AWBW writes times in US Eastern with no zone marker (checked against Com Tower's own
 *  notification times, to the second, on both sides of a DST change). */
export function awbwTimeToMs(s?: string): number | undefined {
  const m = s?.match(/^(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d):(\d\d)$/);
  if (!m) return undefined;
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  // Two passes settle the offset even right beside a DST switch.
  let utc = wall - nyOffsetMs(wall);
  utc = wall - nyOffsetMs(utc);
  return utc;
}

// ── Turn starts → turn lengths ───────────────────────────────────────────────

type Start = { ms: number; rank: number };

const orderOf = (p?: ClockPlayer) => Number(p?.order) || 0;
const slotKey = (day: number, pid: string) => `${day}:${pid}`;

/**
 * Every turn start the readings reveal, keyed by day and player.
 *
 * A reading on day D during player P's turn says, for each player, when their latest turn
 * began: players at or before P in turn order last started on day D, players after P on D-1.
 */
export function collectTurnStarts(snaps: ClockSnapshot[]): Map<string, number> {
  const best = new Map<string, Start>();
  const offer = (key: string, ms: number | undefined, rank: number) => {
    if (ms === undefined || !Number.isFinite(ms)) return;
    const cur = best.get(key);
    if (!cur || rank > cur.rank) best.set(key, { ms, rank });
  };

  // The earliest notification is usually Com Tower being pointed at the game partway through
  // a turn (/game, or a first /stats), not the turn beginning — so it never times anything.
  const notifies = snaps.filter((s) => s.source === 'notify' && s.atMs !== undefined);
  const firstNotify = notifies.reduce<ClockSnapshot | undefined>(
    (a, s) => (!a || s.atMs! < a.atMs! ? s : a),
    undefined
  );

  for (const snap of snaps) {
    const P = snap.turnPlayerId && String(snap.turnPlayerId);
    if (!P || !snap.players[P]) continue;
    const curOrder = orderOf(snap.players[P]);
    for (const [q, pl] of Object.entries(snap.players)) {
      if (pl.eliminated || !pl.turnStart) continue;
      const day = orderOf(pl) <= curOrder ? snap.day : snap.day - 1;
      if (day < 1) continue;
      // AWBW's start for the player whose turn it is is the most direct reading of all.
      offer(slotKey(day, q), awbwTimeToMs(pl.turnStart), q === P ? 3 : 2);
    }
    if (snap.source === 'notify' && snap !== firstNotify) offer(slotKey(snap.day, P), snap.atMs, 1);
  }
  return new Map([...best].map(([k, v]) => [k, v.ms]));
}

/** The latest reading: the current day and whose turn it is. */
function latest(snaps: ClockSnapshot[]): ClockSnapshot | undefined {
  const pos = (s: ClockSnapshot) =>
    s.day * 1000 + orderOf(s.turnPlayerId ? s.players[s.turnPlayerId] : undefined);
  return snaps.filter((s) => s.turnPlayerId).reduce<ClockSnapshot | undefined>(
    (a, s) => (!a || pos(s) > pos(a) || (pos(s) === pos(a) && s.source === 'live') ? s : a),
    undefined
  );
}

/**
 * Each player's turn lengths: a turn lasts from its start to the start of the turn after it.
 *
 * The expected turn sequence is built from turn order, skipping players once they are
 * eliminated, so a turn whose successor's start is unknown is left untimed rather than being
 * merged with the next one into one implausibly long turn.
 */
export function computeTurnTimes(snaps: ClockSnapshot[], nowMs: number): TurnTimesReport {
  const now = latest(snaps);
  if (!now) return { players: [], timedTurns: 0, missingDays: [] };
  const currentDay = now.day;
  const currentPid = String(now.turnPlayerId);

  // Who is in the game, described by the most recent reading that names them.
  const meta = new Map<string, ClockPlayer & { seenDay: number }>();
  const elimDay = new Map<string, number>();
  for (const s of [...snaps].sort((a, b) => a.day - b.day)) {
    for (const [pid, p] of Object.entries(s.players)) {
      const prev = meta.get(pid);
      meta.set(pid, {
        ...prev,
        ...Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)),
        seenDay: s.day,
      });
      if (p.eliminated && !(elimDay.get(pid)! <= s.day)) elimDay.set(pid, s.day);
    }
  }
  const order = [...meta.keys()].sort((a, b) => orderOf(meta.get(a)) - orderOf(meta.get(b)));
  const starts = collectTurnStarts(snaps);
  // A player knocked out on day D may still have taken their day-D turn first.
  const alive = (pid: string, day: number) =>
    !(elimDay.get(pid)! <= day) || starts.has(slotKey(day, pid));
  const firstDay = Math.min(
    ...[...starts.keys()].map((k) => Number(k.split(':')[0])),
    currentDay
  );

  // The turns that should have happened, in order, up to and including the current one.
  const slots: Array<{ day: number; pid: string }> = [];
  for (let day = 1; day <= currentDay; day++) {
    for (const pid of order) {
      if (!alive(pid, day) && !(day === currentDay && pid === currentPid)) continue;
      slots.push({ day, pid });
      if (day === currentDay && pid === currentPid) break;
    }
  }

  const turns = new Map<string, TurnTime[]>();
  const missing = new Set<number>();
  for (let i = 0; i < slots.length; i++) {
    const a = slots[i];
    const t0 = starts.get(slotKey(a.day, a.pid));
    if (t0 === undefined) missing.add(a.day);
    const b = slots[i + 1];
    if (!b || t0 === undefined) continue;
    const t1 = starts.get(slotKey(b.day, b.pid));
    if (t1 === undefined || t1 <= t0) continue;
    if (!turns.has(a.pid)) turns.set(a.pid, []);
    turns.get(a.pid)!.push({ day: a.day, ms: t1 - t0 });
  }

  const currentStart = starts.get(slotKey(currentDay, currentPid));
  const players: PlayerTurnTimes[] = order.map((pid) => {
    const m = meta.get(pid)!;
    return {
      pid,
      username: m.username || `player ${pid}`,
      countryCode: m.countryCode,
      coName: m.coName,
      eliminated: !!m.eliminated,
      turns: turns.get(pid) || [],
      currentMs:
        pid === currentPid && currentStart !== undefined && nowMs > currentStart
          ? nowMs - currentStart
          : undefined,
    };
  });

  return {
    players,
    firstDay: Number.isFinite(firstDay) ? firstDay : undefined,
    currentDay,
    timedTurns: players.reduce((n, p) => n + p.turns.length, 0),
    missingDays: [...missing].sort((a, b) => a - b),
  };
}

export type TurnSummary = { count: number; min: number; max: number; mean: number; median: number; total: number };

export function summarize(ms: number[]): TurnSummary | undefined {
  if (ms.length === 0) return undefined;
  const s = [...ms].sort((a, b) => a - b);
  const mid = s.length >> 1;
  const total = s.reduce((a, b) => a + b, 0);
  return {
    count: s.length,
    min: s[0],
    max: s[s.length - 1],
    mean: total / s.length,
    median: s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2,
    total,
  };
}

/** "2d 3h", "5h 12m", "14m" — two units at most; this is read at a glance in a chat. */
export function formatSpan(ms: number): string {
  const min = Math.round(ms / 60000);
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  if (d) return h ? `${d}d ${h}h` : `${d}d`;
  if (h) return m ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

/** Slowest first: ranked by average turn, which is what a long hold-up actually moves. */
export function rankBySlowest(players: PlayerTurnTimes[]): PlayerTurnTimes[] {
  const avg = (p: PlayerTurnTimes) => summarize(p.turns.map((t) => t.ms))?.mean ?? -1;
  return [...players].sort((a, b) => avg(b) - avg(a));
}

// ── Replay backfill ──────────────────────────────────────────────────────────

/** Read one replay turn (a 0-based turn index across the whole game) as a reading. */
export function replayToSnapshot(data: any): ClockSnapshot | undefined {
  const gs = data?.gameState;
  const day = Number(data?.day);
  if (!gs?.players || !Number.isFinite(day) || gs.currentTurnPId === undefined) return undefined;
  const players: Record<string, ClockPlayer> = {};
  for (const [pid, p] of Object.entries<any>(gs.players)) {
    players[pid] = {
      username: p?.users_username || undefined,
      countryCode: p?.countries_code || undefined,
      coName: p?.co_name || undefined,
      order: Number(p?.players_order) || undefined,
      eliminated: p?.players_eliminated === 'Y',
      turnStart: typeof p?.players_turn_start === 'string' ? p.players_turn_start : undefined,
    };
  }
  return { day, turnPlayerId: String(gs.currentTurnPId), players, source: 'replay' };
}

/**
 * Fill untimed days from the replay, aiming each request at the last turn of a missing day —
 * the one reading that times that whole day. Turn indexes are estimated from the player count
 * and corrected from what each response says it is, which absorbs eliminations.
 *
 * Bounded and sequential on purpose: this is AWBW's server, and a full rebuild of a 30-day
 * game is ~30 requests, done once and then cached by the caller.
 */
export async function backfillFromReplay(
  snaps: ClockSnapshot[],
  fetchTurn: (index: number) => Promise<ClockSnapshot | undefined>,
  opts: { maxRequests?: number; delayMs?: number; nowMs?: number } = {}
): Promise<ClockSnapshot[]> {
  const maxRequests = opts.maxRequests ?? 40;
  const delayMs = opts.delayMs ?? 300;
  const added: ClockSnapshot[] = [];
  const tried = new Map<number, number>(); // day -> attempts
  const exhausted = new Set<number>();
  let requests = 0;

  const all = () => [...snaps, ...added];
  const playerCount = Math.max(1, Object.keys(latest(snaps)?.players || {}).length);
  // Learned index -> position pairs, to aim later requests.
  let anchor: { index: number; day: number; rank: number; alive: number } | undefined;

  const rankIn = (s: ClockSnapshot) => {
    const alivePids = Object.entries(s.players)
      .filter(([pid, p]) => !p.eliminated || pid === s.turnPlayerId)
      .sort(([, a], [, b]) => orderOf(a) - orderOf(b))
      .map(([pid]) => pid);
    return { rank: alivePids.indexOf(String(s.turnPlayerId)), alive: alivePids.length };
  };

  while (requests < maxRequests) {
    const report = computeTurnTimes(all(), opts.nowMs ?? Date.now());
    const day = report.missingDays.find(
      (d) => !exhausted.has(d) && d < (report.currentDay ?? 0)
    );
    if (day === undefined) break;

    // Aim at the last turn of `day`.
    let index = day * playerCount - 1;
    if (anchor) index = anchor.index + (day - anchor.day) * anchor.alive + (anchor.alive - 1 - anchor.rank);
    index = Math.max(0, index);

    const attempt = (tried.get(day) || 0) + 1;
    tried.set(day, attempt);
    if (attempt >= 3) exhausted.add(day);

    if (requests > 0 && delayMs) await new Promise((r) => setTimeout(r, delayMs));
    requests++;
    const snap = await fetchTurn(index).catch(() => undefined);
    if (!snap) {
      exhausted.add(day);
      continue;
    }
    added.push(snap);
    const { rank, alive } = rankIn(snap);
    anchor = { index, day: snap.day, rank: Math.max(0, rank), alive: Math.max(1, alive) };
    // Landed on the right turn: whatever is still missing for that day, the replay cannot give.
    if (snap.day === day && rank === alive - 1) exhausted.add(day);
  }
  return added;
}
