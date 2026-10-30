import { NextResponse } from 'next/server';
import { getAdminDb, adminAvailable } from '@/lib/firebase-admin';
import { buildChartPng } from '@/lib/chart';
import { dailySeries, samplesToSeries, turnFraction, type TurnSampleDoc } from '@/lib/turn-series';

// Charts are built from Com Tower's own per-turn recording, never the AWBW replay API — the
// bot already samples the game page on every turn change, so this costs AWBW nothing.
export const revalidate = 60;

const METRICS = {
  armyValue: { label: 'Army value', axis: 'Units (HP-weighted) + funds' },
  unitValue: { label: 'Unit value', axis: 'Unit value (HP-weighted)' },
  funds: { label: 'Funds', axis: 'Funds' },
  income: { label: 'Income', axis: 'Income per turn' },
  properties: { label: 'Properties', axis: 'Properties held' },
  unitCount: { label: 'Unit count', axis: 'Units on the board' },
} as const;
type MetricKey = keyof typeof METRICS;

export async function GET(req: Request, ctx: { params: Promise<{ gameId: string }> }) {
  const { gameId } = await ctx.params;
  const url = new URL(req.url);
  const metric = (url.searchParams.get('metric') || 'armyValue') as MetricKey;
  const logScale = url.searchParams.get('scale') === 'log';
  if (!METRICS[metric]) {
    return NextResponse.json({ error: `unknown metric; try ${Object.keys(METRICS).join(', ')}` }, { status: 400 });
  }
  if (!adminAvailable) return NextResponse.json({ error: 'not configured' }, { status: 500 });

  try {
    const db = getAdminDb();
    const snap = await db
      .collection('games')
      .doc(gameId)
      .collection('turnStats')
      .orderBy('day', 'asc')
      .limit(600)
      .get();

    // One point per finished day. Before any day has finished, the latest sample alone is
    // drawn as a current standing.
    const docs = snap.docs.map((doc) => doc.data() as TurnSampleDoc);
    let series = dailySeries(docs, metric);
    const standing = series.length === 0 && docs.length > 0;
    if (standing) {
      const at = (d: TurnSampleDoc) => (d.day ?? 0) + turnFraction(d);
      series = samplesToSeries([docs.reduce((a, b) => (at(b) > at(a) ? b : a))], metric);
    }

    const gameDoc = await db.collection('games').doc(gameId).get();
    const gameName = (gameDoc.data() as { name?: string } | undefined)?.name;

    const days = series.flatMap((s) => s.points.map((p) => p.day));

    const png = buildChartPng({
      series,
      title: `${METRICS[metric].label} — ${gameName || `Game ${gameId}`}`,
      subtitle: standing
        ? `Day ${days[0]} · current standing — no full day recorded yet`
        : days.length
          ? `End of each day, ${Math.min(...days)}–${Math.max(...days)} · recorded by Com Tower`
          : 'No turns recorded yet',
      yLabel: METRICS[metric].axis,
      logScale,
    });

    return new NextResponse(new Uint8Array(png), {
      headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=60' },
    });
  } catch (err) {
    console.error('chart failed', err);
    return NextResponse.json({ error: 'chart failed' }, { status: 500 });
  }
}
