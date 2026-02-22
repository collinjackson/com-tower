import type { Firestore } from 'firebase-admin/firestore';
import { FieldValue } from 'firebase-admin/firestore';

/** Parse gameId and inviterUid from patchId (format "gameId-inviterUid"). */
export function parsePatchId(patchId: string): { gameId: string; inviterUid: string } {
  const i = patchId.indexOf('-');
  if (i === -1) return { gameId: patchId, inviterUid: '' };
  return { gameId: patchId.slice(0, i), inviterUid: patchId.slice(i + 1) };
}

export type PatchActivityAction = 'subscriber_added' | 'subscriber_removed' | 'subscriber_updated';

export type PatchActivityPayload = {
  patchId: string;
  inviterUid: string;
  action: PatchActivityAction;
  handle?: string;
  type?: 'dm' | 'group';
  scope?: 'my-turn' | 'all';
  notifyFrequency?: string | null;
  funEnabled?: boolean;
  /** Human-readable summary of what changed (for subscriber_updated). */
  details?: string;
};

/** Append an audit event to patchActivity. Call from API routes after mutating patch subscribers. */
export async function writePatchActivity(
  db: Firestore,
  payload: PatchActivityPayload
): Promise<void> {
  const { gameId } = parsePatchId(payload.patchId);
  await db.collection('patchActivity').add({
    gameId,
    patchId: payload.patchId,
    inviterUid: payload.inviterUid,
    action: payload.action,
    handle: payload.handle ?? null,
    type: payload.type ?? null,
    scope: payload.scope ?? null,
    notifyFrequency: payload.notifyFrequency ?? null,
    funEnabled: payload.funEnabled ?? null,
    details: payload.details ?? null,
    createdAt: FieldValue.serverTimestamp(),
  });
}
