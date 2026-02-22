import { NextRequest, NextResponse } from 'next/server';
import { adminAvailable, getAdminDb } from '@/lib/firebase-admin';

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ code: string }> }
) {
  if (!adminAvailable) {
    return NextResponse.json({ error: 'Admin not configured' }, { status: 500 });
  }

  const { code } = await context.params;
  if (!code) {
    return NextResponse.json({ error: 'Missing invite code' }, { status: 400 });
  }

  let body: { challengeToken?: string; captchaToken?: string; phone?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const challengeToken = (body.challengeToken || '').trim();
  const captchaToken = (body.captchaToken || '').trim();
  const phone = (body.phone || '').trim();

  if (!challengeToken || !captchaToken) {
    return NextResponse.json({ error: 'challengeToken and captchaToken required' }, { status: 400 });
  }

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
    console.error('[submit-captcha] failed', err);
    return NextResponse.json(
      { error: err?.message || 'Failed to submit CAPTCHA' },
      { status: 500 }
    );
  }
}
