import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { adminAvailable, getAdminAuth, getAdminDb } from '@/lib/firebase-admin';

function generateInviteCode() {
  return randomBytes(9).toString('base64url').replace(/[^a-zA-Z0-9]/g, '').slice(0, 12);
}

export async function GET(
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

  let uid: string | null = null;
  if (authHeader?.startsWith('Bearer ')) {
    try {
      const token = authHeader.slice('Bearer '.length);
      const decoded = await getAdminAuth().verifyIdToken(token);
      uid = decoded.uid;
    } catch {
      // ignore, treat as unauthenticated below
      uid = null;
    }
  }

  const db = getAdminDb();
  const patchRef = db.collection('patches').doc(patchId);
  const snap = await patchRef.get();
  if (!snap.exists) {
    return NextResponse.json({ error: 'Patch not found' }, { status: 404 });
  }
  const data = snap.data() as { inviterUid?: string; inviteCode?: string; gameId?: string };

  // If there is already an inviteCode, anyone (even unauthenticated) can read it.
  // Creation/regeneration is only allowed for the inviter (or when inviter missing and caller is authenticated).
  let inviteCode = data.inviteCode;
  if (!inviteCode) {
    if (!uid) {
      return NextResponse.json({ error: 'Invite not available (no code yet). Sign in as inviter to create one.' }, { status: 403 });
    }
    if (data.inviterUid && data.inviterUid !== uid) {
      return NextResponse.json({ error: 'Invite not available (owned by another user). Ask the inviter to open this page to generate the link.' }, { status: 403 });
    }
    inviteCode = generateInviteCode();
    await patchRef.set(
      {
        inviteCode,
        inviterUid: data.inviterUid || uid,
      },
      { merge: true }
    );
  }

  const origin =
    req.nextUrl?.origin || process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000';
  const inviteUrl = `${origin.replace(/\/$/, '')}/invite/${inviteCode}`;

  return NextResponse.json({
    inviteCode,
    inviteUrl,
    gameId: data.gameId || null,
  });
}

