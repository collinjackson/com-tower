import { NextResponse, NextRequest } from 'next/server';
import { getAdminAuth, getAdminDb, adminAvailable } from '@/lib/firebase-admin';

export async function POST(req: NextRequest) {
  if (!adminAvailable) {
    return NextResponse.json({ error: 'Admin not configured' }, { status: 500 });
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

  let body: { phone?: string; challengeToken?: string; captchaToken?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const phone = (body.phone || '').trim();
  const challengeToken = (body.challengeToken || '').trim();
  let captchaToken = (body.captchaToken || '').trim();
  
  // Extract token from signalcaptcha:// URL if user pasted the full link
  if (captchaToken.startsWith('signalcaptcha://')) {
    captchaToken = captchaToken.replace('signalcaptcha://', '').split('?')[0].split('#')[0];
  } else if (captchaToken.includes('signalcaptcha://')) {
    const match = captchaToken.match(/signalcaptcha:\/\/([^\s?#]+)/);
    if (match) {
      captchaToken = match[1];
    }
  }

  if (!phone || !challengeToken || !captchaToken) {
    return NextResponse.json(
      { error: 'phone, challengeToken, and captchaToken required' },
      { status: 400 }
    );
  }

  // Verify this phone number is a subscriber in one of the user's patches
  const db = getAdminDb();
  const patchesSnap = await db
    .collection('patches')
    .where('inviterUid', '==', uid)
    .get();

  let isAuthorized = false;
  for (const patchDoc of patchesSnap.docs) {
    const patchData = patchDoc.data() as { subscribers?: any[] };
    const subscribers = patchData.subscribers || [];
    const isSubscriber = subscribers.some(
      (s) => s.type === 'dm' && s.handle === phone
    );
    if (isSubscriber) {
      isAuthorized = true;
      break;
    }
  }

  if (!isAuthorized) {
    return NextResponse.json(
      { error: 'Not authorized to resolve CAPTCHA for this phone number' },
      { status: 403 }
    );
  }

  // Submit CAPTCHA via worker
  const workerUrl =
    process.env.COM_TOWER_WORKER_URL ||
    'https://com-tower-worker-33713971134.us-central1.run.app';
  const sharedSecret = process.env.INVITE_SHARED_SECRET;

  try {
    const res = await fetch(`${workerUrl}/submit-captcha`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(sharedSecret ? { 'x-shared-secret': sharedSecret } : {}),
      },
      body: JSON.stringify({
        challengeToken,
        captchaToken,
        phone,
      }),
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      return NextResponse.json(
        { error: data.error || 'Failed to submit CAPTCHA', details: data },
        { status: res.status }
      );
    }

    return NextResponse.json({ ok: true, ...data });
  } catch (err: any) {
    console.error('[admin submit-captcha] failed', err);
    return NextResponse.json(
      { error: err?.message || 'Failed to submit CAPTCHA' },
      { status: 500 }
    );
  }
}
