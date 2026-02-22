import { NextResponse } from 'next/server';
import { adminAvailable, getAdminDb } from '@/lib/firebase-admin';

function parsePlayers(html: string) {
  const players = Array.from(
    new Set(
      Array.from(html.matchAll(/profile\.php\?username=([A-Za-z0-9_]+)/g)).map((m) => m[1])
    )
  );
  const countries = Array.from(
    new Set(
      Array.from(html.matchAll(/countries_code["']?\s*:\s*["']([a-z]{2,3})["']/gi)).map(
        (m) => m[1]
      )
    )
  );
  return { players, countries };
}

async function fetchPlayers(gameId: string) {
  const res = await fetch(`https://awbw.amarriner.com/game.php?games_id=${encodeURIComponent(gameId)}`);
  if (!res.ok) {
    throw new Error(`Upstream error ${res.status}`);
  }
  const html = await res.text();
  return parsePlayers(html);
}

export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string }> }
) {
  if (!adminAvailable) {
    return NextResponse.json({ error: 'Admin not configured' }, { status: 500 });
  }

  const { id: gameId } = await context.params;
  if (!gameId) {
    return NextResponse.json({ error: 'Missing gameId' }, { status: 400 });
  }

  try {
    const db = getAdminDb();
    const cacheRef = db.collection('gamePlayers').doc(gameId);
    const cacheSnap = await cacheRef.get();
    if (cacheSnap.exists) {
      const data = cacheSnap.data() as { players?: string[]; countries?: string[] };
      if (data.players?.length) {
        return NextResponse.json({
          gameId,
          players: data.players || [],
          countries: data.countries || [],
          cached: true,
        });
      }
    }

    const info = await fetchPlayers(gameId);
    await cacheRef.set(info, { merge: true });
    return NextResponse.json({ gameId, ...info, cached: false });
  } catch (err: any) {
    console.error('[players GET] failed', err);
    return NextResponse.json(
      { error: err?.message || 'Internal server error' },
      { status: 500 }
    );
  }
}

