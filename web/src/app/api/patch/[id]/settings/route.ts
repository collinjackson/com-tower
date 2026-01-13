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

  let body: { experimentalExtended?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const db = getAdminDb();
  const patchRef = db.collection('patches').doc(patchId);
  const snap = await patchRef.get();
  if (!snap.exists) {
    return NextResponse.json({ error: 'Patch not found' }, { status: 404 });
  }
  const data = snap.data() as { inviterUid?: string };
  if (data.inviterUid && data.inviterUid !== uid) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  await patchRef.set(
    {
      experimentalExtended: !!body.experimentalExtended,
      inviterUid: data.inviterUid || uid,
    },
    { merge: true }
  );

  return NextResponse.json({ ok: true, experimentalExtended: !!body.experimentalExtended });
}


