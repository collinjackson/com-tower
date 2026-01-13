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
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (!body.type || !body.handle) {
    return NextResponse.json({ error: 'type and handle required' }, { status: 400 });
  }

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
  
  // If it's a group invite link, try to match it to an actual groupId
  let groupId: string | undefined = existingGroupId; // Preserve existing if we can't match
  let needsGroupSelection = false;
  
  if (body.type === 'group' && body.handle.includes('signal.group/#')) {
    try {
      // Call worker to list groups and try to match
      const workerUrl = process.env.WORKER_URL || 'https://com-tower-worker-33713971134.us-central1.run.app';
      const groupsRes = await fetch(`${workerUrl}/list-groups`);
      if (groupsRes.ok) {
        const groupsData = await groupsRes.json();
        const groups = groupsData.groups || [];
        
        // Extract base64 from invite link
        const inviteMatch = body.handle.match(/signal\.group\/#(.+)$/);
        const inviteBase64 = inviteMatch ? inviteMatch[1] : null;
        
        // Try to match by invite_link field
        for (const group of groups) {
          const groupInviteLink = group.invite_link || '';
          const groupBase64 = groupInviteLink.includes('#') 
            ? groupInviteLink.split('#')[1] 
            : groupInviteLink;
          
          if (groupInviteLink === body.handle || 
              (inviteBase64 && groupBase64 === inviteBase64) ||
              (inviteBase64 && groupBase64.includes(inviteBase64)) ||
              (inviteBase64 && inviteBase64.includes(groupBase64))) {
            groupId = group.id || (group.internal_id ? `group.${group.internal_id}` : undefined);
            break;
          }
        }
        
        if (!groupId && !existingGroupId) {
          needsGroupSelection = true;
        }
      }
    } catch (err) {
      console.error('Failed to match group:', err);
      if (!existingGroupId) {
        needsGroupSelection = true;
      }
    }
  }
  
  const newSub: any = {
    type: body.type,
    handle: body.handle,
    funEnabled: !!body.funEnabled,
    scope: body.scope === 'my-turn' || body.scope === 'all' ? body.scope : 'all',
    mentions: Array.isArray(body.mentions)
      ? body.mentions.filter((m) => typeof m === 'string' && m.trim().length > 0)
      : undefined,
  };
  
  // Use matched groupId, or fall back to existing, or leave undefined
  if (groupId) {
    newSub.groupId = groupId;
  } else if (existingGroupId) {
    newSub.groupId = existingGroupId;
  }
  
  // Only set needsGroupSelection if we don't have a groupId at all
  if (needsGroupSelection && !newSub.groupId) {
    newSub.needsGroupSelection = true;
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
    groupId,
    needsGroupSelection,
  });
}

