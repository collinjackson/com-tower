import { NextRequest, NextResponse } from 'next/server';
import { getAdminAuth, adminAvailable } from '@/lib/firebase-admin';

export async function POST(req: NextRequest) {
  if (!adminAvailable) {
    return NextResponse.json({ error: 'Admin not configured' }, { status: 500 });
  }

  const authHeader = req.headers.get('authorization') || req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const token = authHeader.slice('Bearer '.length);
    await getAdminAuth().verifyIdToken(token);
  } catch {
    return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
  }

  let body: { inviteLink?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const inviteLink = (body.inviteLink || '').trim();
  if (!inviteLink) {
    return NextResponse.json({ error: 'inviteLink required' }, { status: 400 });
  }

  const workerUrl =
    process.env.COM_TOWER_WORKER_URL ||
    'https://com-tower-worker-33713971134.us-central1.run.app';
  const sharedSecret = process.env.INVITE_SHARED_SECRET;

  try {
    const workerRes = await fetch(`${workerUrl}/join-group`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(sharedSecret ? { 'x-shared-secret': sharedSecret } : {}),
      },
      body: JSON.stringify({ inviteLink }),
      signal: AbortSignal.timeout(35000),
    });

    const data = await workerRes.json().catch(() => ({}));
    if (!workerRes.ok) {
      return NextResponse.json(
        { error: (data as any).error || 'Join failed' },
        { status: workerRes.status }
      );
    }

    return NextResponse.json({ ok: true, data });
  } catch (err: any) {
    if (err.name === 'AbortError' || err.name === 'TimeoutError') {
      return NextResponse.json({ error: 'Request timed out' }, { status: 504 });
    }
    console.error('[join-group] Error:', err);
    return NextResponse.json({ error: err?.message || 'Failed to join group' }, { status: 500 });
  }
}
