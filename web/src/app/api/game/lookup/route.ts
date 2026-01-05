import { NextResponse } from 'next/server';
import { adminAvailable, getAdminDb, getAdminAuth } from '@/lib/firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';

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

function cleanGameName(name: string) {
  return name
    .replace(/\s+AWBW\b/i, '')
    .replace(/^\s*Game\s*-?\s*/i, '')
    .replace(/-\s*$/i, '')
    .trim();
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
    const gameName = cleanGameName(extractGameName(html) || `Game ${gameId}`);
    const mapName = extractMapName(html) || '';

    // Cache in Firestore on the server if admin creds are present.
    // Also upsert a patch doc for the authenticated inviter (many-to-many).
    let inviterUid: string | null = null;
    if (adminAvailable) {
      const authHeader = req.headers.get('authorization') || req.headers.get('Authorization');
      if (authHeader?.startsWith('Bearer ')) {
        const token = authHeader.slice('Bearer '.length);
        try {
          const decoded = await getAdminAuth().verifyIdToken(token);
          inviterUid = decoded.uid;
        } catch {
          inviterUid = null;
        }
      }
    }

    if (adminAvailable) {
      const db = getAdminDb();
      await db.collection('games').doc(gameId).set(
        {
          gameId,
          gameName,
          mapName,
          updatedAt: FieldValue.serverTimestamp(),
          createdAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      if (inviterUid) {
        const patchId = `${gameId}-${inviterUid}`;
        await db.collection('patches').doc(patchId).set(
          {
            gameId,
            inviterUid,
            subscribers: [], // add on demand
            updatedAt: FieldValue.serverTimestamp(),
            createdAt: FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      }
    }

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

