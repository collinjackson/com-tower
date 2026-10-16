// Per-turn game stats: read off the AWBW game page the bot already loads each turn, and
// stored one sample per turn. Kept out of index.ts so it can be tested without a running bot.
import { getFirestore, FieldValue, type Firestore } from 'firebase-admin/firestore';

/** One player's standing at a single sample point. Everything here is on the game page the
 *  bot already loads each turn — no replay API call, so no rate limit to respect. */
export type PlayerStats = {
  username: string;
  countryCode?: string;
  countryName?: string;
  team?: string;
  order?: number;
  eliminated: boolean;
  /** HP-weighted value of everything they have on the board: sum(cost * hp/10). The metric
   *  the AWBW community charts — a 5 HP Md.Tank is half a Md.Tank. */
  unitValue: number;
  unitCount: number;
  funds?: number;
  income?: number;
  properties?: number;
  cities?: number;
  coName?: string;
  /** Power meter charge, and its two thresholds, so a chart can mark power plays. */
  coPower?: number;
  coMaxPower?: number;
  coMaxSpower?: number;
};

/** A whole-game sample: every player's standing at the moment one player's turn began. */
export type TurnStats = {
  day: number;
  turnPlayerId?: string;
  players: Record<string, PlayerStats>;
};

/** Read every player's standing out of the game page: unit value from unitsInfo (which
 *  carries cost and HP per unit for ALL players), everything else from playersInfo.
 *  Best-effort — a fog game may withhold fields, so each one is optional. */
export function parseTurnStats(html: string, currentPlayerId?: string): TurnStats | undefined {
  try {
    // `gameDay`, not `Day` — and the guard below means getting this wrong silently disables
    // the whole recorder rather than logging anything, so it is worth being exact.
    const day = Number(html.match(/\bgameDay\s*=\s*(\d+)/)?.[1]);
    const playersRaw = html.match(/playersInfo\s*=\s*(\{[\s\S]*?\});\s*\n/)?.[1];
    if (!playersRaw || !Number.isFinite(day)) {
      // Never fail quietly here: a sample missed is a sample that can only be recovered
      // through the replay API, and a silent undefined is indistinguishable from the
      // recorder simply not being deployed yet.
      console.warn(
        `[stats] cannot read game page (gameDay=${day}, playersInfo=${!!playersRaw}, len=${html.length}) — no sample recorded`
      );
      return undefined;
    }
    const playersInfo = JSON.parse(playersRaw) as Record<string, any>;

    // Unit value per player. unitsInfo lists every unit on the board with its cost and HP.
    const unitValue: Record<string, number> = {};
    const unitCount: Record<string, number> = {};
    const unitsRaw = html.match(/unitsInfo\s*=\s*(\{[\s\S]*?\});\s*\n/)?.[1];
    if (unitsRaw) {
      const unitsInfo = JSON.parse(unitsRaw) as Record<string, any>;
      for (const u of Object.values(unitsInfo)) {
        const owner = String(u?.units_players_id ?? '');
        const cost = Number(u?.units_cost);
        const hp = Number(u?.units_hit_points);
        if (!owner || !Number.isFinite(cost) || !Number.isFinite(hp)) continue;
        unitValue[owner] = (unitValue[owner] || 0) + cost * (hp / 10);
        unitCount[owner] = (unitCount[owner] || 0) + 1;
      }
    }

    const players: Record<string, PlayerStats> = {};
    for (const [pid, p] of Object.entries(playersInfo)) {
      const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : undefined);
      players[pid] = {
        username: String(p?.users_username ?? ''),
        countryCode: p?.countries_code || undefined,
        countryName: p?.countries_name || undefined,
        team: p?.players_team || undefined,
        order: num(p?.players_order),
        eliminated: p?.players_eliminated === 'Y',
        unitValue: Math.round(unitValue[pid] || 0),
        unitCount: unitCount[pid] || 0,
        funds: num(p?.players_funds),
        income: num(p?.players_income),
        properties: num(p?.numProperties),
        cities: num(p?.cities),
        coName: p?.co_name || undefined,
        coPower: num(p?.players_co_power),
        coMaxPower: num(p?.players_co_max_power),
        coMaxSpower: num(p?.players_co_max_spower),
      };
    }
    if (Object.keys(players).length === 0) return undefined;
    return { day, turnPlayerId: currentPlayerId, players };
  } catch (err) {
    console.warn('[stats] parseTurnStats failed', err);
    return undefined;
  }
}

/** Persist one sample. Keyed by day + whose turn it is, so the history stays one row per turn.
 *  The first sighting of a turn wins: a later re-notify, /sync or /game re-bind lands partway
 *  through that turn, and overwriting would replace the turn-start standing with a mid-turn one. */
export async function recordTurnStats(
  gameId: string,
  stats: TurnStats,
  db: Pick<Firestore, 'collection'> = getFirestore()
): Promise<void> {
  const key = `d${String(stats.day).padStart(4, '0')}-p${stats.turnPlayerId || 'x'}`;
  try {
    await db
      .collection('games')
      .doc(gameId)
      .collection('turnStats')
      .doc(key)
      .create({ ...stats, at: FieldValue.serverTimestamp() });
  } catch (err) {
    if ((err as { code?: number })?.code === 6) return; // ALREADY_EXISTS: this turn is already sampled
    console.warn('[stats] recordTurnStats failed', err);
  }
}
