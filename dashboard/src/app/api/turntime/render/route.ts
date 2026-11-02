import { NextResponse } from 'next/server';
import { buildTurnTimePng, type TurnTimeRow } from '@/lib/turntime-chart';

// The bot works out the turn times (it owns the AWBW reads and the replay backfill) and posts
// them here only to be drawn — this route touches neither Firestore nor AWBW.

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
const str = (v: unknown, max = 60) => (typeof v === 'string' && v ? v.slice(0, max) : undefined);

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || !Array.isArray(body.players)) {
    return NextResponse.json({ error: 'expected { title, players: [...] }' }, { status: 400 });
  }
  const rows: TurnTimeRow[] = body.players.slice(0, 16).map((p: Record<string, unknown>) => ({
    name: str(p?.name) || '?',
    co: str(p?.co),
    army: str(p?.army, 3),
    eliminated: p?.eliminated === true,
    turnsMs: (Array.isArray(p?.turnsMs) ? p.turnsMs : []).map(num).filter((v): v is number => v !== undefined).slice(0, 1000),
    currentMs: num(p?.currentMs),
  }));
  try {
    const png = buildTurnTimePng({
      rows,
      title: str(body.title, 120) || 'Turn time',
      subtitle: str(body.subtitle, 160),
      referenceMs: num(body.referenceMs) ?? null,
    });
    return new NextResponse(new Uint8Array(png), { headers: { 'Content-Type': 'image/png' } });
  } catch (err) {
    console.error('turntime render failed', err);
    return NextResponse.json({ error: 'render failed' }, { status: 500 });
  }
}
