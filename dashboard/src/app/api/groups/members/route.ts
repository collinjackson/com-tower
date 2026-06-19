import { NextResponse, NextRequest } from 'next/server';
import { getAdminAuth, adminAvailable } from '@/lib/firebase-admin';

export async function GET(req: NextRequest) {
  if (!adminAvailable) {
    return NextResponse.json({ error: 'Admin not configured' }, { status: 500 });
  }

  const authHeader =
    req.headers.get('authorization') || req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    await getAdminAuth().verifyIdToken(authHeader.slice('Bearer '.length));
  } catch {
    return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
  }

  const groupId = req.nextUrl.searchParams.get('groupId');
  if (!groupId) {
    return NextResponse.json({ error: 'Missing groupId parameter' }, { status: 400 });
  }

  // Call worker endpoint to get group members
  const workerUrl = process.env.WORKER_URL || 'https://com-tower-worker-33713971134.us-central1.run.app';
  try {
    const res = await fetch(`${workerUrl}/group-members?groupId=${encodeURIComponent(groupId)}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });
    if (!res.ok) {
      const text = await res.text();
      return NextResponse.json(
        { error: `Worker request failed: ${res.status} ${text}` },
        { status: 502 }
      );
    }
    const data = await res.json();
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to get group members' },
      { status: 500 }
    );
  }
}
