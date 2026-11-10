// Which stat a turn ping features. Kept free of canvas and Firestore so the choice can be
// tested directly. The chart should show what just changed, and rotate so the same picture
// doesn't arrive every turn (the way a market's odds chart is only interesting when it moves).
import type { Series } from './turn-series.ts';

export const FEATURED_METRICS = ['armyValue', 'unitCount', 'properties', 'income'] as const;
export type FeaturedMetric = (typeof FEATURED_METRICS)[number];

export const FEATURED_LABELS: Record<FeaturedMetric, string> = {
  armyValue: 'Army value',
  unitCount: 'Units',
  properties: 'Properties',
  income: 'Income',
};

/** How much the race in one metric moved over the last round: the change in the spread between
 *  the leader and the last-placed player, as a share of the leader's value. 0 when a series has
 *  fewer than `minPoints` points (too early for a chart). */
export function swing(series: Series[], minPoints = 3): number {
  const live = series.filter((s) => s.points.length >= minPoints);
  if (live.length < 2 || live.length !== series.length) return 0;
  const last = (s: Series, back: number) => s.points[s.points.length - 1 - back]?.value ?? 0;
  // One round back: each player has moved once, so the spread then and now are comparable.
  const back = Math.min(live.length, Math.min(...live.map((s) => s.points.length)) - 1);
  const spread = (b: number) => {
    const v = live.map((s) => last(s, b));
    return Math.max(...v) - Math.min(...v);
  };
  const top = Math.max(1, ...live.map((s) => last(s, 0)));
  return Math.abs(spread(0) - spread(back)) / top;
}

/** The metric to feature: the biggest swing, never `previous` again (rotation), and null when
 *  no metric has enough history yet (the ping keeps its hologram instead). */
export function pickMetric(
  byMetric: Partial<Record<FeaturedMetric, Series[]>>,
  previous?: string | null,
  minPoints = 3
): FeaturedMetric | null {
  let best: FeaturedMetric | null = null;
  let bestSwing = -1;
  for (const m of FEATURED_METRICS) {
    const s = byMetric[m];
    if (!s || !s.length || s.some((x) => x.points.length < minPoints)) continue;
    if (m === previous) continue;
    const w = swing(s, minPoints);
    if (w > bestSwing) {
      best = m;
      bestSwing = w;
    }
  }
  return best;
}
