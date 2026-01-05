import { NextResponse } from 'next/server';

function parseGameId(link: string | null) {
  if (!link) return '';
  const m = link.match(/games_id=(\d+)/);
  if (m) return m[1];
  return link.trim();
}

function extractMapName(html: string) {
  const mapMatch = html.match(/prevmaps\.php\?maps_id=\d+[^>]*>([^<]+)</i);
  return mapMatch ? mapMatch[1].trim() : '';
}

function extractGameName(html: string) {
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleMatch) return titleMatch[1].trim();
  const hMatch = html.match(/<h[12][^>]*>([^<]+)<\/h[12]>/i);
  return hMatch ? hMatch[1].trim() : '';
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const link = searchParams.get('link');
  const gameId = parseGameId(link);
  if (!gameId) {
    return NextResponse.json({ error: 'Missing game link or id' }, { status: 400 });
  }

  try {
    const url = `https://awbw.amarriner.com/game.php?games_id=${encodeURIComponent(gameId)}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'com-tower/preview (community tool)',
      },
    });
    if (!res.ok) {
      return NextResponse.json(
        { error: `Upstream error ${res.status}` },
        { status: 502 }
      );
    }
    const html = await res.text();
    const gameName = extractGameName(html) || `Game ${gameId}`;
    const mapName = extractMapName(html) || '';
    return NextResponse.json({
      gameId,
      gameName,
      mapName,
      source: 'scrape',
      fetchedAt: Date.now(),
    });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Lookup failed' },
      { status: 500 }
    );
  }
}

