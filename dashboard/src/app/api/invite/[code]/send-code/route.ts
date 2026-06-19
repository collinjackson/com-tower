import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { adminAvailable, getAdminDb } from '@/lib/firebase-admin';
import { parseAndNormalizePhone } from '@/lib/phone';

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function generateVerificationId() {
  return randomBytes(16).toString('hex');
}

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

  let body: { phone?: string };
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
    const patch = await getPatchByInviteCode(code);
    if (!patch) {
      return NextResponse.json({ error: 'Invite not found' }, { status: 404 });
    }

    const db = getAdminDb();
    const verificationId = generateVerificationId();
    const verificationCode = generateCode();
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

    await db.collection('inviteVerifications').doc(verificationId).set({
      verificationId,
      code: verificationCode,
      phone,
      patchId: patch.id,
      inviteCode: code,
      createdAt: FieldValue.serverTimestamp(),
      expiresAt,
      used: false,
    });

    const workerUrl =
      process.env.COM_TOWER_WORKER_URL ||
      'https://com-tower-worker-33713971134.us-central1.run.app';
    const sharedSecret = process.env.INVITE_SHARED_SECRET;
    try {
      const res = await fetch(`${workerUrl}/send-verification`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(sharedSecret ? { 'x-shared-secret': sharedSecret } : {}),
        },
        body: JSON.stringify({
          phone,
          message: `Your Com Tower code is ${verificationCode}. Enter this to manage your subscription.`,
        }),
      });
      if (!res.ok) {
        const errText = await res.text();
        console.error('[send-code] worker send failed', res.status, errText);
        return NextResponse.json({ error: 'Failed to send verification code' }, { status: 502 });
      }
    } catch (err) {
      console.error('[send-code] worker call failed', err);
      return NextResponse.json({ error: 'Failed to send verification code' }, { status: 502 });
    }

    return NextResponse.json({
      ok: true,
      verificationId,
      phone,
      // Surface the code in dev/non-secret mode to unblock testing.
      ...(sharedSecret ? {} : { verificationCode }),
    });
  } catch (err: any) {
    console.error('[invite send-code] failed', err);
    return NextResponse.json(
      { error: err?.message || 'Internal server error' },
      { status: 500 }
    );
  }
}

