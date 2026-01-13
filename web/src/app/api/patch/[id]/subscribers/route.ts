import { NextResponse, NextRequest } from 'next/server';
import { getAdminAuth, getAdminDb, adminAvailable } from '@/lib/firebase-admin';

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  if (!adminAvailable) {
    return NextResponse.json({ error: 'Admin not configured' }, { status: 500 });
  }

  const { id: patchId } = await context.params;
  if (!patchId) {
    return NextResponse.json({ error: 'Missing patch id' }, { status: 400 });
  }

  const authHeader =
    req.headers.get('authorization') || req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let uid: string | null = null;
  try {
    const token = authHeader.slice('Bearer '.length);
    const decoded = await getAdminAuth().verifyIdToken(token);
    uid = decoded.uid;
  } catch {
    return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
  }

  let body: {
    type?: 'dm' | 'group';
    handle?: string;
    funEnabled?: boolean;
    scope?: 'my-turn' | 'all';
    mentions?: string[];
    groupName?: string;
    groupId?: string;
    playerPhoneMap?: Record<string, string>; // AWBW username -> Signal phone number
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (!body.type || !body.handle) {
    return NextResponse.json({ error: 'type and handle required' }, { status: 400 });
  }

  try {
    const db = getAdminDb();
    const patchRef = db.collection('patches').doc(patchId);
    const snap = await patchRef.get();
    if (!snap.exists) {
      return NextResponse.json({ error: 'Patch not found' }, { status: 404 });
    }
    const data = snap.data() as { inviterUid?: string; subscribers?: any[] };
    if (data.inviterUid && data.inviterUid !== uid) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const subscribers = Array.isArray(data.subscribers) ? data.subscribers : [];
    
    // Check if there's an existing subscriber with the same handle/type to preserve groupId
    const existingSub = subscribers.find(
      (s) => s.type === body.type && s.handle === body.handle
    );
    const existingGroupId = existingSub?.groupId;
    
    const newSub: any = {
      type: body.type,
      handle: body.handle,
      funEnabled: !!body.funEnabled,
      scope: body.scope === 'my-turn' || body.scope === 'all' ? body.scope : 'all',
    };
    
    // Only include mentions if it's a non-empty array (Firestore doesn't allow undefined)
    const filteredMentions = Array.isArray(body.mentions)
      ? body.mentions.filter((m) => typeof m === 'string' && m.trim().length > 0)
      : [];
    if (filteredMentions.length > 0) {
      newSub.mentions = filteredMentions;
    }
    
    // For groups, store the groupName, groupId, and playerPhoneMap
    if (body.type === 'group') {
      if (body.groupName) {
        newSub.groupName = body.groupName;
      }
      // Use provided groupId, or existing one, or handle as fallback
      if (body.groupId) {
        newSub.groupId = body.groupId;
      } else if (existingGroupId) {
        newSub.groupId = existingGroupId;
      } else if (/^group\./i.test(body.handle)) {
        // If handle is already a groupId, use it
        newSub.groupId = body.handle;
      }
      // Store player-to-phone mapping if provided
      if (body.playerPhoneMap && typeof body.playerPhoneMap === 'object') {
        newSub.playerPhoneMap = body.playerPhoneMap;
      }
    }
    
    const nextSubs = [
      ...subscribers.filter((s) => !(s.type === body.type && s.handle === body.handle)),
      newSub,
    ];

    await patchRef.set(
      {
        subscribers: nextSubs,
        inviterUid: data.inviterUid || uid,
      },
      { merge: true }
    );

    return NextResponse.json({ 
      ok: true, 
      subscribers: nextSubs,
    });
  } catch (err: any) {
    console.error('[subscribers POST] Error:', err);
    return NextResponse.json(
      { 
        error: err?.message || 'Internal server error',
        details: err?.stack?.substring(0, 500),
      },
      { status: 500 }
    );
  }
}

