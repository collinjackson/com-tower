import { NextResponse } from 'next/server';
import { adminAvailable, getAdminDb } from '@/lib/firebase-admin';
import { parseAndNormalizePhone } from '@/lib/phone';

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

export async function POST(
  req: Request,
  context: { params: Promise<{ code: string }> }
) {
  if (!adminAvailable) {
    return NextResponse.json({ error: 'Admin not configured' }, { status: 500 });
  }

  const { code } = await context.params;
  if (!code) {
    return NextResponse.json({ error: 'Missing invite code' }, { status: 400 });
  }

  let body: {
    phone?: string;
    funEnabled?: boolean;
    scope?: 'my-turn' | 'all';
    playerName?: string;
    country?: string;
    action?: 'subscribe' | 'unsubscribe';
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const phone = parseAndNormalizePhone(body.phone || '');
  if (!phone) {
    return NextResponse.json({ error: 'Enter a valid phone number with country code' }, { status: 400 });
  }

  try {
    const db = getAdminDb();
    const patch = await getPatchByInviteCode(code);
    if (!patch) {
      return NextResponse.json({ error: 'Invite not found' }, { status: 404 });
    }

    const patchRef = db.collection('patches').doc(patch.id);
    const patchSnap = await patchRef.get();
    if (!patchSnap.exists) {
      return NextResponse.json({ error: 'Patch not found' }, { status: 404 });
    }
    const patchData = patchSnap.data() as { subscribers?: any[]; inviterUid?: string };
    const subscribers = Array.isArray(patchData.subscribers) ? patchData.subscribers : [];

    const filtered = subscribers.filter(
      (s) => !(s.type === 'dm' && parseAndNormalizePhone(s.handle || '') === phone)
    );

    if (body.action === 'unsubscribe') {
      await patchRef.set(
        {
          subscribers: filtered,
          inviterUid: patchData.inviterUid || null,
          inviteCode: code,
        },
        { merge: true }
      );
      return NextResponse.json({ ok: true, subscribers: filtered });
    }

    const scope = body.scope === 'my-turn' ? 'my-turn' : 'all';
    const newSubscriber: any = {
      type: 'dm',
      handle: phone,
      funEnabled: !!body.funEnabled,
      scope,
      lastVerifiedAt: Date.now(),
    };
    const playerName = (body.playerName || '').trim();
    if (playerName) {
      newSubscriber.playerName = playerName;
    }
    // Country is currently omitted; can be derived later if needed.

    const nextSubs = [...filtered, newSubscriber];

    await patchRef.set(
      {
        subscribers: nextSubs,
        inviterUid: patchData.inviterUid || null,
        inviteCode: code,
      },
      { merge: true }
    );

    return NextResponse.json({ ok: true, subscriber: newSubscriber, subscribers: nextSubs });
  } catch (err: any) {
    console.error('[invite confirm] failed', err);
    return NextResponse.json(
      { error: err?.message || 'Internal server error' },
      { status: 500 }
    );
  }
}

