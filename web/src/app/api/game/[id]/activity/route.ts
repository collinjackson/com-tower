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
    // Try with orderBy, fall back if index missing
    let snap;
    try {
      snap = await db
        .collection('messages')
        .where('gameId', '==', gameId)
        .orderBy('createdAt', 'desc')
        .limit(50)
        .get();
    } catch (err: any) {
      // If orderBy fails (missing index), try without it
      if (err?.code === 'failed-precondition' || err?.message?.includes('index')) {
        console.log('Activity API: orderBy failed, trying without it');
        snap = await db
          .collection('messages')
          .where('gameId', '==', gameId)
          .limit(50)
          .get();
      } else {
        throw err;
      }
    }

    const messages = snap.docs.map((d) => {
      const data = d.data() as {
        text?: string;
        textClassic?: string | null;
        textFun?: string | null;
        recipientsClassic?: string[];
        recipientsFun?: string[];
        deliveries?: Array<{ handle: string; variant: string; status: string; error?: string }>;
        recipient?: string;
        createdAt?: { toDate: () => Date };
        imageUrl?: string;
        status?: string;
      };
      return {
        text: data.text || '',
        textClassic: data.textClassic || null,
        textFun: data.textFun || null,
        recipientsClassic: data.recipientsClassic || [],
        recipientsFun: data.recipientsFun || [],
        deliveries: data.deliveries || [],
        recipient: data.recipient || null,
        createdAt: data.createdAt ? data.createdAt.toDate().toISOString() : null,
        imageUrl: data.imageUrl || null,
        status: data.status || null,
      };
    });

    // Sort by createdAt descending (in case orderBy didn't work)
    messages.sort((a, b) => {
      if (!a.createdAt || !b.createdAt) return 0;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

    return NextResponse.json({ messages });
  } catch (err) {
    console.error('Activity fetch failed', err);
    return NextResponse.json({ error: 'Failed to fetch activity' }, { status: 500 });
  }
}


