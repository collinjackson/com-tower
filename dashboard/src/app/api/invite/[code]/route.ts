import { NextResponse } from 'next/server';
import { adminAvailable, getAdminDb } from '@/lib/firebase-admin';

async function getPatchByInviteCode(code: string) {
  const db = getAdminDb();
  const snap = await db
    .collection('patches')
    .where('inviteCode', '==', code)
    .limit(1)
    .get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { id: doc.id, data: doc.data() as any };
}

export async function GET(
  _req: Request,
  context: { params: Promise<{ code: string }> }
) {
  if (!adminAvailable) {
    return NextResponse.json({ error: 'Admin not configured' }, { status: 500 });
  }

  const { code } = await context.params;
  if (!code) {
    return NextResponse.json({ error: 'Missing invite code' }, { status: 400 });
  }

  try {
    const patch = await getPatchByInviteCode(code);
    if (!patch) {
      return NextResponse.json({ error: 'Invite not found' }, { status: 404 });
    }
    const db = getAdminDb();
    const gameId = patch.data.gameId;
    const gameDoc = gameId ? await db.collection('games').doc(gameId).get() : null;
    const playersDoc = gameId ? await db.collection('gamePlayers').doc(gameId).get() : null;

    const gameData = gameDoc?.data() as { gameName?: string; mapName?: string } | undefined;
    const playersData = playersDoc?.data() as { players?: string[]; countries?: string[] } | undefined;

    return NextResponse.json({
      patchId: patch.id,
      gameId: gameId || null,
      gameName: gameData?.gameName || (gameId ? `Game ${gameId}` : 'Game'),
      mapName: gameData?.mapName || '',
      players: playersData?.players || [],
      countries: playersData?.countries || [],
    });
  } catch (err: any) {
    console.error('[invite GET] failed', err);
    return NextResponse.json(
      { error: err?.message || 'Internal server error' },
      { status: 500 }
    );
  }
}

