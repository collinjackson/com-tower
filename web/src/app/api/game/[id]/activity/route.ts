import { NextResponse } from 'next/server';
import { getAdminDb, getAdminAuth, adminAvailable } from '@/lib/firebase-admin';

export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  if (!adminAvailable) {
    return NextResponse.json({ error: 'Firebase Admin not configured' }, { status: 500 });
  }

  const { id: gameId } = await context.params;
  if (!gameId) {
    return NextResponse.json({ error: 'Missing game id' }, { status: 400 });
  }

  let uid: string | null = null;
  const authHeader = req.headers.get('authorization') || req.headers.get('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    try {
      const decoded = await getAdminAuth().verifyIdToken(authHeader.slice('Bearer '.length));
      uid = decoded.uid;
    } catch {
      uid = null;
    }
  }

  try {
    const db = getAdminDb();

    // Messages (notification deliveries)
    let snap;
    try {
      snap = await db
        .collection('messages')
        .where('gameId', '==', gameId)
        .orderBy('createdAt', 'desc')
        .limit(50)
        .get();
    } catch (err: any) {
      if (err?.code === 'failed-precondition' || err?.message?.includes('index')) {
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

    messages.sort((a, b) => {
      if (!a.createdAt || !b.createdAt) return 0;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

    // Patch activity (subscriber audit) – only for authenticated user's own events
    let patchActivity: Array<{
      action?: string | null;
      handle?: string | null;
      type?: string | null;
      details?: string | null;
      createdAt: string | null;
    }> = [];
    if (uid) {
      try {
        let patchSnap;
        try {
          patchSnap = await db
            .collection('patchActivity')
            .where('gameId', '==', gameId)
            .orderBy('createdAt', 'desc')
            .limit(50)
            .get();
        } catch {
          patchSnap = await db
            .collection('patchActivity')
            .where('gameId', '==', gameId)
            .limit(50)
            .get();
        }
        const all = patchSnap.docs.map((d) => {
          const data = d.data() as {
            inviterUid?: string;
            action?: string;
            handle?: string;
            type?: string;
            details?: string;
            createdAt?: { toDate: () => Date };
          };
          return {
            inviterUid: data.inviterUid,
            action: data.action || null,
            handle: data.handle ?? null,
            type: data.type ?? null,
            details: data.details ?? null,
            createdAt: data.createdAt ? data.createdAt.toDate().toISOString() : null,
          };
        });
        patchActivity = all
          .filter((a) => a.inviterUid === uid)
          .map(({ inviterUid: _, ...rest }) => rest);
        patchActivity.sort((a, b) => {
          if (!a.createdAt || !b.createdAt) return 0;
          return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
        });
      } catch (err) {
        console.error('Activity API: patchActivity fetch failed', err);
      }
    }

    return NextResponse.json({ messages, patchActivity });
  } catch (err) {
    console.error('Activity fetch failed', err);
    return NextResponse.json({ error: 'Failed to fetch activity' }, { status: 500 });
  }
}


