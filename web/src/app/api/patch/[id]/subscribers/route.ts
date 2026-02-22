import { NextResponse, NextRequest } from 'next/server';
import { getAdminAuth, getAdminDb, adminAvailable } from '@/lib/firebase-admin';
import { parseAndNormalizePhone } from '@/lib/phone';
import { parsePatchId, writePatchActivity } from '@/lib/patch-activity';

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

  const validFreq = ['once', 'hourly'] as const;
  type NotifyFreq = (typeof validFreq)[number];

  let body: {
    type?: 'dm' | 'group';
    handle?: string;
    funEnabled?: boolean;
    scope?: 'my-turn' | 'all';
    notifyFrequency?: NotifyFreq;
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
    
    // Normalize DM handles before deduping
    const normalizedHandle =
      body.type === 'dm' ? parseAndNormalizePhone(body.handle) : body.handle;
    if (body.type === 'dm' && !normalizedHandle) {
      return NextResponse.json({ error: 'Enter a valid phone number with country code' }, { status: 400 });
    }
    
    // Check if there's an existing subscriber with the same handle/type to preserve groupId
    const existingSub = subscribers.find(
      (s) => s.type === body.type && s.handle === normalizedHandle
    );
    const existingGroupId = existingSub?.groupId;
    
    const newSub: any = {
      type: body.type,
      handle: normalizedHandle,
      funEnabled: !!body.funEnabled,
      scope: body.scope === 'my-turn' || body.scope === 'all' ? body.scope : 'all',
    };
    if (body.notifyFrequency !== undefined && validFreq.includes(body.notifyFrequency)) {
      newSub.notifyFrequency = body.notifyFrequency;
    }

    
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
      
      // If we don't have a groupId yet, try to resolve it from the handle/invite link
      // This is done asynchronously - we save the subscriber first, then resolve in background
      if (!newSub.groupId && body.handle) {
        // Mark that we need to resolve the groupId
        newSub.groupIdPending = true;
      }
    }
    
    const nextSubs = [
      ...subscribers.filter((s) => !(s.type === body.type && s.handle === normalizedHandle)),
      newSub,
    ];

    await patchRef.set(
      {
        subscribers: nextSubs,
        inviterUid: data.inviterUid || uid,
      },
      { merge: true }
    );

    const { inviterUid } = parsePatchId(patchId);
    await writePatchActivity(getAdminDb(), {
      patchId,
      inviterUid: inviterUid || data.inviterUid || uid,
      action: 'subscriber_added',
      handle: newSub.type === 'dm' ? normalizedHandle : newSub.handle,
      type: newSub.type,
      scope: newSub.scope,
      notifyFrequency: newSub.notifyFrequency ?? null,
      funEnabled: newSub.funEnabled,
    }).catch((err) => console.error('[patchActivity] write failed', err));

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

/** Update one subscriber's notifyFrequency (and optionally scope, funEnabled) by type+handle. */
export async function PATCH(
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

  const validFreq = ['once', 'hourly'] as const;
  let body: { type?: 'dm' | 'group'; handle?: string; notifyFrequency?: typeof validFreq[number] | null | ''; scope?: 'my-turn' | 'all'; funEnabled?: boolean; playerName?: string | null };
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
    const idx = subscribers.findIndex((s: any) => s.type === body.type && s.handle === body.handle);
    if (idx === -1) {
      return NextResponse.json({ error: 'Subscriber not found' }, { status: 404 });
    }

    const updated = [...subscribers];
    const clearFreq = body.notifyFrequency === null || body.notifyFrequency === '';
    if (body.notifyFrequency !== undefined) {
      if (clearFreq) {
        const { notifyFrequency: _, ...rest } = updated[idx] as any;
        updated[idx] = rest;
      } else if (validFreq.includes(body.notifyFrequency as any)) {
        updated[idx] = { ...updated[idx], notifyFrequency: body.notifyFrequency };
      }
    }
    if (body.scope === 'my-turn' || body.scope === 'all') {
      updated[idx] = { ...updated[idx], scope: body.scope };
    }
    if (typeof body.funEnabled === 'boolean') {
      updated[idx] = { ...updated[idx], funEnabled: body.funEnabled };
    }
    if (body.playerName !== undefined) {
      const next = updated[idx] as any;
      if (body.playerName == null || body.playerName === '') {
        const { playerName: _, ...rest } = next;
        updated[idx] = rest;
      } else {
        updated[idx] = { ...next, playerName: String(body.playerName).trim() };
      }
    }

    await patchRef.update({ subscribers: updated });

    const parts: string[] = [];
    if (body.scope === 'my-turn' || body.scope === 'all') {
      parts.push(`Scope → ${body.scope === 'my-turn' ? 'Only my turn' : 'All turns'}`);
    }
    if (body.notifyFrequency !== undefined) {
      parts.push(`Frequency → ${body.notifyFrequency === 'hourly' ? 'Hourly' : 'Once per turn'}`);
    }
    if (typeof body.funEnabled === 'boolean') {
      parts.push(`Message style → ${body.funEnabled ? 'Fun mode' : 'Classic'}`);
    }
    if (body.playerName !== undefined) {
      parts.push(`Player → ${body.playerName == null || body.playerName === '' ? 'All' : body.playerName}`);
    }
    const { inviterUid } = parsePatchId(patchId);
    await writePatchActivity(getAdminDb(), {
      patchId,
      inviterUid,
      action: 'subscriber_updated',
      handle: body.handle,
      type: body.type as 'dm' | 'group',
      details: parts.length ? parts.join('; ') : undefined,
    }).catch((err) => console.error('[patchActivity] write failed', err));

    return NextResponse.json({ ok: true, subscribers: updated });
  } catch (err: any) {
    console.error('[subscribers PATCH] Error:', err);
    return NextResponse.json(
      { error: err?.message || 'Internal server error' },
      { status: 500 }
    );
  }
}

