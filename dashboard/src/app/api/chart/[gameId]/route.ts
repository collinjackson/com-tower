import { NextResponse } from 'next/server';
import { getAdminDb, adminAvailable } from '@/lib/firebase-admin';
import { buildChartSvg, type Series } from '@/lib/chart';

// Charts are built from Com Tower's own per-turn recording, never the AWBW replay API — the
// bot already samples the game page on every turn change, so this costs AWBW nothing.
export const revalidate = 60;

const METRICS = {
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
  const metric = (url.searchParams.get('metric') || 'unitValue') as MetricKey;
  const wantSvg = url.searchParams.get('format') === 'svg';
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

    const byPlayer = new Map<string, Series>();
    for (const doc of snap.docs) {
      const d = doc.data() as {
        day?: number;
        players?: Record<string, Record<string, unknown>>;
      };
      if (typeof d.day !== 'number' || !d.players) continue;
      for (const [pid, p] of Object.entries(d.players)) {
        const value = Number(p[metric]);
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
        // Latest sample wins the elimination flag — a player knocked out stays on the chart,
        // dimmed, because their line up to that point is the story.
        series.eliminated = p.eliminated === true;
        series.points.push({ day: d.day, order: Number(p.order) || 0, value });
      }
    }

    const gameDoc = await db.collection('games').doc(gameId).get();
    const gameName = (gameDoc.data() as { name?: string } | undefined)?.name;

    // Stable order by turn order, so a player's colour never depends on their current rank.
    const series = [...byPlayer.values()].sort(
      (a, b) => (a.points[0]?.order ?? 0) - (b.points[0]?.order ?? 0)
    );
    const days = series.flatMap((s) => s.points.map((p) => p.day));

    const svg = buildChartSvg({
      series,
      title: `${METRICS[metric].label} — ${gameName || `Game ${gameId}`}`,
      subtitle: days.length
        ? `Day ${Math.min(...days)}–${Math.max(...days)} · ${snap.size} turns recorded by Com Tower`
        : 'No turns recorded yet',
      yLabel: METRICS[metric].axis,
    });

    if (wantSvg) {
      return new NextResponse(svg, {
        headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=60' },
      });
    }
    const sharp = (await import('sharp')).default;
    const png = await sharp(Buffer.from(svg), { density: 144 }).png().toBuffer();
    return new NextResponse(new Uint8Array(png), {
      headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=60' },
    });
  } catch (err) {
    console.error('chart failed', err);
    return NextResponse.json({ error: 'chart failed' }, { status: 500 });
  }
}
