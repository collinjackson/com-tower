import { NextResponse, NextRequest } from 'next/server';
import { getAdminAuth, getAdminDb, adminAvailable } from '@/lib/firebase-admin';

export async function GET(req: NextRequest) {
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

  try {
    const db = getAdminDb();
    
    // Get all patches where this user is the inviter
    const patchesSnap = await db
      .collection('patches')
      .where('inviterUid', '==', uid)
      .get();
    
    const patchIds = patchesSnap.docs.map((d) => d.id);
    
    // Get all pending CAPTCHA challenges
    const challengesSnap = await db
      .collection('captchaChallenges')
      .where('resolved', '==', false)
      .get();
    
    // Build a map of all challenges with their full data
    const challengesMap = new Map<string, any>();
    challengesSnap.docs.forEach((doc) => {
      const data = doc.data();
      challengesMap.set(doc.id, {
        phone: doc.id,
        challengeToken: data.challengeToken,
        waitSeconds: data.waitSeconds,
        createdAt: data.createdAt?.toDate?.()?.toISOString() || data.createdAt || null,
        source: data.source || 'verification',
        resolved: data.resolved || false,
      });
    });
    
    // Get all phone numbers that are subscribers in this user's patches
    const subscriberPhones = new Set<string>();
    const phoneToPatchMap = new Map<string, { patchId: string; gameId: string | null }>();
    
    for (const patchId of patchIds) {
      const patchDoc = await db.collection('patches').doc(patchId).get();
      if (!patchDoc.exists) continue;
      
      const patchData = patchDoc.data() as { subscribers?: any[]; gameId?: string };
      const subscribers = patchData.subscribers || [];
      
      subscribers.forEach((s: any) => {
        if (s.type === 'dm' && s.handle) {
          subscriberPhones.add(s.handle);
          if (!phoneToPatchMap.has(s.handle)) {
            phoneToPatchMap.set(s.handle, {
              patchId,
              gameId: patchData.gameId || null,
            });
          }
        }
      });
    }
    
    // Also check messages collection for recent CAPTCHA errors that might not be in captchaChallenges yet
    // Look for messages with recipientStatuses containing CAPTCHA errors
    const gameIds = new Set<string>();
    for (const patchId of patchIds) {
      const patchDoc = await db.collection('patches').doc(patchId).get();
      if (patchDoc.exists) {
        const gameId = (patchDoc.data() as any)?.gameId;
        if (gameId) gameIds.add(gameId);
      }
    }
    
    // Get recent messages with CAPTCHA errors for these games
    const captchaErrorsFromMessages = new Map<string, { phone: string; gameId: string; error: string; createdAt: string | null }>();
    if (gameIds.size > 0) {
      // Query messages for each game (can't do OR query easily)
      for (const gameId of gameIds) {
        try {
          // Try with status filter first
          let messagesSnap;
          try {
            messagesSnap = await db
              .collection('messages')
              .where('gameId', '==', gameId)
              .where('status', 'in', ['partial-failed', 'failed'])
              .orderBy('createdAt', 'desc')
              .limit(50)
              .get();
          } catch (indexErr: any) {
            // If index missing, try without status filter
            if (indexErr?.code === 'failed-precondition' || indexErr?.message?.includes('index')) {
              messagesSnap = await db
                .collection('messages')
                .where('gameId', '==', gameId)
                .orderBy('createdAt', 'desc')
                .limit(50)
                .get();
            } else {
              throw indexErr;
            }
          }
          
          messagesSnap.docs.forEach((doc) => {
            const data = doc.data();
            const recipientStatuses = data.recipientStatuses || [];
            recipientStatuses.forEach((status: any) => {
              if (!status.ok && status.error && status.error.includes('CAPTCHA')) {
                const phone = status.handle;
                if (phone && !captchaErrorsFromMessages.has(phone)) {
                  captchaErrorsFromMessages.set(phone, {
                    phone,
                    gameId,
                    error: status.error,
                    createdAt: data.createdAt?.toDate?.()?.toISOString() || data.createdAt || null,
                  });
                }
              }
            });
          });
        } catch (err) {
          // If query fails (e.g., missing index), continue
          console.error(`Failed to query messages for game ${gameId}:`, err);
        }
      }
    }
    
    // Include challenges for:
    // 1. Phone numbers that are subscribers in this user's patches
    // 2. All verification challenges (people who tried to subscribe but hit CAPTCHA)
    // 3. All notification challenges (from failed notification sends)
    // 4. Phone numbers that failed with CAPTCHA in recent messages
    const relevantChallenges = [];
    const seenPhones = new Set<string>();
    
    // Add challenges from Firestore
    for (const [phone, challenge] of challengesMap.entries()) {
      if (seenPhones.has(phone)) continue;
      const isSubscriber = subscriberPhones.has(phone);
      const isVerification = challenge.source === 'verification' || !challenge.source;
      const isNotification = challenge.source === 'notification';
      
      // Show ALL challenges for subscribers, or any verification/notification challenges
      // This ensures we show challenges even if they're already subscribers
      if (isSubscriber || isVerification || isNotification) {
        const patchInfo = phoneToPatchMap.get(phone);
        relevantChallenges.push({
          ...challenge,
          patchId: patchInfo?.patchId || null,
          gameId: patchInfo?.gameId || null,
          isSubscriber,
        });
        seenPhones.add(phone);
      }
    }
    
    // Add challenges from message errors (even if not in captchaChallenges collection yet)
    for (const [phone, errorInfo] of captchaErrorsFromMessages.entries()) {
      if (seenPhones.has(phone)) continue;
      
      // Extract challenge token from error message if possible
      const errorMsg = errorInfo.error || '';
      const captchaMatch = errorMsg.match(/challenge token "([^"]+)"/);
      const challengeToken = captchaMatch ? captchaMatch[1] : null;
      
      if (challengeToken) {
        const patchInfo = phoneToPatchMap.get(phone);
        relevantChallenges.push({
          phone,
          challengeToken,
          waitSeconds: null,
          createdAt: errorInfo.createdAt,
          source: 'notification',
          patchId: patchInfo?.patchId || null,
          gameId: errorInfo.gameId || patchInfo?.gameId || null,
          isSubscriber: subscriberPhones.has(phone),
          fromMessage: true, // Flag to indicate this came from message analysis
        });
        seenPhones.add(phone);
      }
    }
    
    return NextResponse.json({ challenges: relevantChallenges });
  } catch (err: any) {
    console.error('[admin captcha-challenges] failed', err);
    return NextResponse.json(
      { error: err?.message || 'Failed to fetch CAPTCHA challenges' },
      { status: 500 }
    );
  }
}
