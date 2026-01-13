import { NextResponse } from 'next/server';
import { getAdminDb, adminAvailable } from '@/lib/firebase-admin';

export async function GET(_: Request, context: { params: Promise<{ id: string }> }) {
  if (!adminAvailable) {
    return NextResponse.json({ error: 'Firebase Admin not configured' }, { status: 500 });
  }

  const { id: gameId } = await context.params;
  if (!gameId) {
    return NextResponse.json({ error: 'Missing game id' }, { status: 400 });
  }

  try {
    const db = getAdminDb();
    const snap = await db
      .collection('messages')
      .where('gameId', '==', gameId)
      .orderBy('createdAt', 'desc')
      .limit(50)
      .get();

    const messages = snap.docs.map((d) => {
      const data = d.data() as {
        text?: string;
        recipient?: string;
        createdAt?: { toDate: () => Date };
      };
      return {
        text: data.text || '',
        recipient: data.recipient || null,
        createdAt: data.createdAt ? data.createdAt.toDate().toISOString() : null,
      };
    });

    return NextResponse.json({ messages });
  } catch (err) {
    console.error('Activity fetch failed', err);
    return NextResponse.json({ error: 'Failed to fetch activity' }, { status: 500 });
  }
}


