import { NextResponse, NextRequest } from 'next/server';
import { getAdminAuth, getAdminDb, adminAvailable } from '@/lib/firebase-admin';

export async function DELETE(
  req: NextRequest,
  context: { params: Promise<{ id: string; handle: string }> }
) {
  if (!adminAvailable) {
    return NextResponse.json({ error: 'Admin not configured' }, { status: 500 });
  }

  const { id: patchId, handle } = await context.params;
  if (!patchId || !handle) {
    return NextResponse.json({ error: 'Missing patch id or handle' }, { status: 400 });
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
  const decodedHandle = decodeURIComponent(handle);
  const type = req.nextUrl.searchParams.get('type') || 'dm';
  
  const updated = subscribers.filter(
    (s) => !(s.type === type && s.handle === decodedHandle)
  );

  await patchRef.update({
    subscribers: updated,
  });

  return NextResponse.json({ ok: true, subscribers: updated });
}
