// Turning Com Tower's per-turn samples into chart series. Kept free of canvas and Firestore
// so the placement rules — the part that has gone wrong before — can be tested directly.

/** `turn` is how far into the day the sample was taken, in [0, 1): 0 is the first player's turn. */
export type Sample = { day: number; turn: number; value: number };
export type Series = {
  key: string;
  label: string;
  army?: string;
  eliminated?: boolean;
  points: Sample[];
};

/** One stored turnStats doc: everyone's standing as one player's turn began. */
export type TurnSampleDoc = {
  day?: number;
  turnPlayerId?: string;
  players?: Record<string, Record<string, unknown>>;
};

/** One player's value for a metric in one sample. `armyValue` is derived: everything they
 *  could field, units on the board (HP-weighted) plus cash in hand, so a build moves value
 *  from funds to units instead of reading as a sudden gain. Anything not finite (funds a fog
 *  game withholds, say) is no point at all rather than a misleading zero. */
export function metricValue(player: Record<string, unknown>, metric: string): number {
  if (metric === 'armyValue') return Number(player.unitValue) + Number(player.funds);
  return Number(player[metric]);
}

/** Where in its day a sample sits: the turn-taker's rank in turn order over the player count.
 *  AWBW's players_order is a sort key, not a 1..n index (one game ran 3, 4, 9, 10), so it is
 *  ranked rather than used as an offset — as an offset it pushed late players into the next day. */
export function turnFraction(doc: TurnSampleDoc): number {
  return (doc.turnPlayerId && turnSlots(doc).get(String(doc.turnPlayerId))) || 0;
}

/** Every player's place in the day, as turnFraction would give for their turn. */
function turnSlots(doc: TurnSampleDoc): Map<string, number> {
  const order = Object.entries(doc.players ?? {})
    .sort(([, a], [, b]) => (Number(a.order) || 0) - (Number(b.order) || 0))
    .map(([pid]) => pid);
  return new Map(order.map((pid, rank) => [pid, rank / order.length]));
}

/** One point per player per finished day: their standing from the first sample after their
 *  own turn, once they have collected income, paid repairs and built. Mid-day samples are not
 *  comparable — whoever's turn just began holds unspent income the others have already spent
 *  or lost to repairs — so the chart compares players only where each has played the day.
 *  A day still in progress is left off; the point sits at the day's integer x. */
export function dailySeries(docs: TurnSampleDoc[], metric: string): Series[] {
  const samples = docs
    .filter((d) => typeof d.day === 'number' && d.players)
    .map((d) => ({ doc: d, at: d.day! + turnFraction(d), slots: turnSlots(d) }))
    .sort((a, b) => a.at - b.at);
  const latest = samples.at(-1);
  if (!latest) return [];
  // The day is over once everyone still playing has had their turn in it.
  const live = Object.entries(latest.doc.players!).filter(([, p]) => p.eliminated !== true);
  const lastSlot = Math.max(0, ...live.map(([pid]) => latest.slots.get(pid) ?? 0));

  const series: Series[] = [];
  for (const [pid, p] of Object.entries(latest.doc.players!)) {
    const slot = latest.slots.get(pid) ?? 0;
    const points: Sample[] = [];
    for (let day = samples[0].doc.day!; day + lastSlot < latest.at; day++) {
      // Before their next turn: that sample has the next day's income in it.
      const after = samples.find((s) => s.at > day + slot && s.at < day + slot + 1);
      const value = after?.doc.players?.[pid] && metricValue(after.doc.players[pid], metric);
      if (typeof value === 'number' && Number.isFinite(value)) points.push({ day, turn: 0, value });
    }
    series.push({
      key: pid,
      label: String(p.username || pid),
      army: (p.countryCode as string) || undefined,
      eliminated: p.eliminated === true,
      points,
    });
  }
  const order = (pid: string) => Number(latest.doc.players![pid].order) || 0;
  return series.filter((s) => s.points.length).sort((a, b) => order(a.key) - order(b.key));
}

/** Every sample gives every player one point, all at that sample's place in the day, so a
 *  day's samples line up in time instead of stacking at each player's own turn slot. Series
 *  come out in turn order, so a player's colour never depends on their current rank. */
export function samplesToSeries(docs: TurnSampleDoc[], metric: string): Series[] {
  const byPlayer = new Map<string, Series>();
  const turnOrder = new Map<string, number>(); // player id -> AWBW players_order
  const latest = new Map<string, number>(); // player id -> day + turn of the sample that set `eliminated`
  for (const d of docs) {
    if (typeof d.day !== 'number' || !d.players) continue;
    const turn = turnFraction(d);
    for (const [pid, p] of Object.entries(d.players)) {
      const value = metricValue(p, metric);
      if (!Number.isFinite(value)) continue;
      let series = byPlayer.get(pid);
      if (!series) {
        series = {
          key: pid,
          label: String(p.username || pid),
          army: (p.countryCode as string) || undefined,
          eliminated: false,
          points: [],
        };
        byPlayer.set(pid, series);
      }
      turnOrder.set(pid, Number(p.order) || 0);
      // Latest sample wins the elimination flag — a player knocked out stays on the chart,
      // dimmed, because their line up to that point is the story. Docs arrive by day then
      // doc id, not by time, so compare positions rather than trusting arrival order.
      if (d.day + turn >= (latest.get(pid) ?? -Infinity)) {
        latest.set(pid, d.day + turn);
        series.eliminated = p.eliminated === true;
      }
      series.points.push({ day: d.day, turn, value });
    }
  }
  return [...byPlayer.values()]
    .map((s) => ({ ...s, points: inTimeOrder(s.points) }))
    .sort((a, b) => (turnOrder.get(a.key) ?? 0) - (turnOrder.get(b.key) ?? 0));
}

/** Within a day, samples arrive in player-id order, so anything that reads "the last point"
 *  (the end label, the marker) must sort first or it reports a stale turn. */
export function inTimeOrder(points: Sample[]): Sample[] {
  return [...points].sort((a, b) => a.day - b.day || a.turn - b.turn);
}

/** The x range in fractional days: from the first day to just past the latest sample, so the
 *  axis never runs on into a day nothing has been recorded for. */
export function xDomain(points: Sample[]): { start: number; end: number } {
  const start = Math.min(...points.map((p) => p.day));
  const latest = Math.max(...points.map((p) => p.day + p.turn));
  return { start, end: start + Math.max(0.5, latest + 0.05 - start) };
}
