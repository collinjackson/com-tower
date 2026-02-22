'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  firebaseAvailable,
  signInWithGoogle,
  signOutFirebase,
  subscribeToAuth,
} from '@/lib/firebase';
import { parseAndNormalizePhone } from '@/lib/phone';
import type { User } from 'firebase/auth';
import {
  collection,
  doc,
  getDocs,
  getDoc,
  setDoc,
  query,
  updateDoc,
  serverTimestamp,
  where,
  getFirestore,
  onSnapshot,
  orderBy,
  limit as fsLimit,
} from 'firebase/firestore';
import { getAuth } from 'firebase/auth';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

type GameInfo = {
  gameId: string;
  gameName: string;
  mapName: string;
};

type NotifyMode = 'none' | 'signal-dm';
/** '' = every turn; hourly = at most once per hour (default when adding) */
type NotifyFrequency = '' | 'hourly';
type ActivityItem = {
  kind?: 'message' | 'patch_activity';
  text: string;
  textClassic?: string | null;
  textFun?: string | null;
  recipientsClassic?: string[];
  recipientsFun?: string[];
  deliveries?: Array<{ handle: string; variant: string; status: string; error?: string }>;
  recipient: string | null;
  createdAt: string | null;
  imageUrl?: string | null;
  status?: string;
  /** Audit log: subscriber_added | subscriber_removed | subscriber_updated */
  action?: string;
  handle?: string;
  type?: string;
  details?: string;
};

export function ComTowerApp({ initialGameId }: { initialGameId?: string }) {
  const [user, setUser] = useState<User | null>(null);
  const [gameLink, setGameLink] = useState('');
  const [gameInfo, setGameInfo] = useState<GameInfo | null>(null);
  const [lockedGameId, setLockedGameId] = useState<string | null>(initialGameId || null);
  const [signalToken, setSignalToken] = useState('');
  const [notificationType, setNotificationType] = useState<'dm' | 'group' | null>(null);
  const [notifyMode, setNotifyMode] = useState<NotifyMode>('signal-dm');
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [lookupPending, setLookupPending] = useState(false);
  const [patchedEnsured, setPatchedEnsured] = useState(false);
  const [patchedGames, setPatchedGames] = useState<GameInfo[]>([]);
  const [patchedLoading, setPatchedLoading] = useState(false);
  const [userPhone, setUserPhone] = useState('');
  const [userPhoneLoading, setUserPhoneLoading] = useState(false);
  const [view, setView] = useState<'main' | 'settings'>('main');
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const accountMenuRef = useRef<HTMLDivElement>(null);
  const accountMenuCloseTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [experimentalExtended, setExperimentalExtended] = useState(false);
  const [activityMessages, setActivityMessages] = useState<ActivityItem[]>([]);
  const [activityPatch, setActivityPatch] = useState<ActivityItem[]>([]);
  const [activityLoading, setActivityLoading] = useState(false);
  const [patchActivityLoading, setPatchActivityLoading] = useState(false);

  const activity = useMemo(() => {
    const combined = [...activityMessages, ...activityPatch];
    combined.sort((a, b) => {
      const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return tb - ta;
    });
    return combined.slice(0, 50);
  }, [activityMessages, activityPatch]);

  const ACTIVITY_PAGE_SIZE = 15;
  const [activityPage, setActivityPage] = useState(0);
  const activityPaginated = useMemo(
    () => activity.slice(activityPage * ACTIVITY_PAGE_SIZE, (activityPage + 1) * ACTIVITY_PAGE_SIZE),
    [activity, activityPage]
  );
  const activityTotalPages = Math.max(1, Math.ceil(activity.length / ACTIVITY_PAGE_SIZE));
  const canActivityPrev = activityPage > 0;
  const canActivityNext = activityPage < activityTotalPages - 1;

  useEffect(() => {
    setActivityPage(0);
  }, [lockedGameId]);

  useEffect(() => {
    return () => {
      if (accountMenuCloseTimeoutRef.current) {
        clearTimeout(accountMenuCloseTimeoutRef.current);
      }
    };
  }, []);

  const [funChoice, setFunChoice] = useState<'fun' | 'plain' | null>(null);
  const [scopeChoice, setScopeChoice] = useState<'my-turn' | 'all'>('all');
  const [frequencyChoice, setFrequencyChoice] = useState<NotifyFrequency>('hourly');
  const [mentionsRaw, setMentionsRaw] = useState('');
  const [selectedGroupName, setSelectedGroupName] = useState('');
  const [groups, setGroups] = useState<any[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [currentSubscribers, setCurrentSubscribers] = useState<any[]>([]);
  const [subscribersLoading, setSubscribersLoading] = useState(false);
  const [inviteLink, setInviteLink] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [inviteLoading, setInviteLoading] = useState(false);
  const router = useRouter();
  const effectiveLockedId = lockedGameId || initialGameId || null;

  // Seed detail view immediately when arriving via /game/[id]
  useEffect(() => {
    if (initialGameId && !gameInfo) {
      setGameInfo({
        gameId: initialGameId,
        gameName: `Game ${initialGameId}`,
        mapName: '',
      });
      setLockedGameId(initialGameId);
      setGameLink(`https://awbw.amarriner.com/game.php?games_id=${initialGameId}`);
    }
  }, [initialGameId, gameInfo]);

  useEffect(() => {
    if (!firebaseAvailable) return;
    const unsub = subscribeToAuth(setUser);
    return () => unsub && unsub();
  }, []);

  useEffect(() => {
    const fetchProfile = async () => {
      if (!firebaseAvailable || !user) {
        setUserPhone('');
        return;
      }
      setUserPhoneLoading(true);
      try {
        const db = getFirestore();
        const ref = doc(db, 'users', user.uid);
        const snap = await getDoc(ref);
        const data = snap.data() as { signalPhone?: string } | undefined;
        setUserPhone(data?.signalPhone || '');
      } catch {
        // ignore fetch errors; optional profile
      } finally {
        setUserPhoneLoading(false);
      }
    };
    fetchProfile();
  }, [user]);

  useEffect(() => {
    const loadPatched = async () => {
      if (!firebaseAvailable || !user) {
        setPatchedGames([]);
        return;
      }
      setPatchedLoading(true);
      try {
        const db = getFirestore();
        const patchesRef = collection(db, 'patches');
        const q = query(patchesRef, where('inviterUid', '==', user.uid));
        const snap = await getDocs(q);
        const results: GameInfo[] = [];
        for (const docSnap of snap.docs) {
          const data = docSnap.data() as { gameId?: string };
          const gameId = data.gameId;
          if (!gameId) continue;
          const gameDoc = await getDoc(doc(db, 'games', gameId));
          const gData = gameDoc.data() as Partial<GameInfo> | undefined;
          results.push({
            gameId,
            gameName: (gData?.gameName || `Game ${gameId}`).trim(),
            mapName: gData?.mapName || '',
          });
        }
        setPatchedGames(results);
      } catch (err) {
        console.error('load patched failed', err);
      } finally {
        setPatchedLoading(false);
      }
    };
    loadPatched();
  }, [user]);

  useEffect(() => {
    if (!initialGameId) return;
    const link = `https://awbw.amarriner.com/game.php?games_id=${initialGameId}`;
    setGameLink(link);
    setLockedGameId(initialGameId);
    setPatchedEnsured(false);
    lookupGame(link, false);
  }, [initialGameId]);

  useEffect(() => {
    const loadPatchSettings = async () => {
      if (!firebaseAvailable || !user || !gameInfo?.gameId) {
        setExperimentalExtended(false);
        return;
      }
      try {
        const db = getFirestore();
        const patchRef = doc(db, 'patches', `${gameInfo.gameId}-${user.uid}`);
        const snap = await getDoc(patchRef);
        const data = snap.data() as { experimentalExtended?: boolean } | undefined;
        setExperimentalExtended(!!data?.experimentalExtended);
      } catch {
        setExperimentalExtended(false);
      }
    };
    loadPatchSettings();
  }, [firebaseAvailable, user, gameInfo?.gameId]);

  // Activity feed via API polling (avoids client Firestore permission errors and SDK assertion bugs)
  useEffect(() => {
    if (!lockedGameId) {
      setActivityMessages([]);
      setActivityPatch([]);
      setActivityLoading(false);
      setPatchActivityLoading(false);
      return;
    }
    setActivityLoading(true);
    setPatchActivityLoading(true);

    const ACTIVITY_POLL_MS = 15000;
    const fetchActivity = async () => {
      try {
        let idToken: string | null = null;
        if (user) {
          try {
            idToken = await getAuth().currentUser?.getIdToken() ?? null;
          } catch {
            idToken = null;
          }
        }
        const res = await fetch(`/api/game/${lockedGameId}/activity`, {
          headers: idToken ? { Authorization: `Bearer ${idToken}` } : {},
        });
        if (!res.ok) return;
        const data = await res.json();
        const messageRows: ActivityItem[] = (data.messages || []).map((m: any) => ({
          kind: 'message',
          text: m.text || '',
          textClassic: m.textClassic ?? null,
          textFun: m.textFun ?? null,
          recipientsClassic: m.recipientsClassic || [],
          recipientsFun: m.recipientsFun || [],
          deliveries: m.deliveries || [],
          recipient: null,
          createdAt: m.createdAt ?? null,
          imageUrl: m.imageUrl ?? null,
          status: m.status ?? null,
        }));
        const patchRows: ActivityItem[] = (data.patchActivity || []).map((a: any) => ({
          kind: 'patch_activity',
          text: '',
          recipient: null,
          createdAt: a.createdAt ?? null,
          action: a.action ?? null,
          handle: a.handle ?? null,
          type: a.type ?? null,
          details: a.details ?? null,
        }));
        setActivityMessages(messageRows);
        setActivityPatch(patchRows);
      } catch (err) {
        console.error('Activity feed fetch failed', err);
      } finally {
        setActivityLoading(false);
        setPatchActivityLoading(false);
      }
    };

    fetchActivity();
    const interval = setInterval(fetchActivity, ACTIVITY_POLL_MS);

    return () => clearInterval(interval);
  }, [lockedGameId, user]);

  const statusLine = useMemo(() => {
    if (!firebaseAvailable) return 'Firestore not configured; using local mock.';
    return null;
  }, [firebaseAvailable]);

  const lookupGame = async (link: string, includeAuth = false) => {
    const pattern = /^https:\/\/awbw\.amarriner\.com\/game\.php\?games_id=\d+$/;
    if (!pattern.test(link)) return;
    try {
      let idToken: string | null = null;
      if (includeAuth && user) {
        try {
          idToken = (await getAuth().currentUser?.getIdToken()) ?? null;
        } catch {
          idToken = null;
        }
      }

      const res = await fetch(`/api/game/lookup?link=${encodeURIComponent(link)}`, {
        headers: idToken ? { Authorization: `Bearer ${idToken}` } : undefined,
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'Lookup failed');
      }
      const data = await res.json();
      const nextGame = {
        gameId: data.gameId,
        gameName: (data.gameName || `Game ${data.gameId}`).trim(),
        mapName: data.mapName || '',
      };
      setGameInfo(nextGame);
      if (includeAuth) {
        setPatchedEnsured(true);
        setStatus('Patched and cached on server.');
      } else {
        setStatus('Game loaded.');
      }
    } catch (err: unknown) {
      setStatus(err instanceof Error ? err.message : 'Lookup failed');
    }
  };

  const ensurePatched = async () => {
    if (patchedEnsured) return;
    if (!gameLink) return;
    setStatus('Confirming patch…');
    await lookupGame(gameLink, true);
  };

  const loadInviteLink = async () => {
    if (!user || !gameInfo?.gameId) {
      setInviteLink('');
      setInviteCode('');
      return;
    }
    setInviteLoading(true);
    try {
      await ensurePatched();
      const idToken = await getAuth().currentUser?.getIdToken();
      const res = await fetch(
        `/api/patch/${gameInfo.gameId}-${user.uid}/invite`,
        {
          headers: {
            ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
          },
        }
      );
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'Failed to load invite link');
      }
      const data = await res.json();
      setInviteLink(data.inviteUrl || '');
      setInviteCode(data.inviteCode || '');
    } catch (err: any) {
      setInviteLink('');
      setInviteCode('');
      setStatus(err?.message || 'Could not load invite link');
    } finally {
      setInviteLoading(false);
    }
  };

  // Debounced lookup when link matches expected pattern.
  useEffect(() => {
    const pattern = /^https:\/\/awbw\.amarriner\.com\/game\.php\?games_id=\d+$/;
    if (!gameLink || !pattern.test(gameLink)) return;
    const handle = setTimeout(async () => {
      setLookupPending(true);
      setStatus('Looking up game…');
      await lookupGame(gameLink, false);
      setLookupPending(false);
    }, 500);
    return () => clearTimeout(handle);
  }, [gameLink]);

  const saveSignalToken = async () => {
    if (!gameInfo?.gameId) return;
    if (!funChoice) {
      setStatus('Pick a message style (fun or classic).');
      return;
    }
    if (!notificationType) {
      setStatus('Select notification type (DM or Group).');
      return;
    }
    setSaving(true);
    setStatus(null);
    try {
      await ensurePatched();
      if (firebaseAvailable && user) {
        const idToken = await getAuth().currentUser?.getIdToken();
        const trimmed = (signalToken || (notificationType === 'dm' ? userPhone : '')).trim();
        if (!trimmed) {
          throw new Error(`Enter a ${notificationType === 'dm' ? 'Signal phone number' : 'group ID'}.`);
        }
        const dmCandidate =
          notificationType === 'dm' && trimmed && !trimmed.startsWith('+')
            ? `+${trimmed}`
            : trimmed;
        const normalizedHandle =
          notificationType === 'dm' ? parseAndNormalizePhone(dmCandidate) : trimmed;
        if (notificationType === 'dm' && !normalizedHandle) {
          throw new Error('Enter a valid Signal number with country code (e.g., +15551234567).');
        }
        const mentions = notificationType === 'group'
          ? mentionsRaw
              .split(/[,\s]+/)
              .map((m) => m.trim())
              .filter((m) => m.length > 0)
          : [];
        const res = await fetch(`/api/patch/${gameInfo.gameId}-${user.uid}/subscribers`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
          },
          body: JSON.stringify({
            type: notificationType,
            handle: normalizedHandle || trimmed, // For groups, this is the groupId
            funEnabled: funChoice === 'fun',
            scope: scopeChoice,
            ...(frequencyChoice ? { notifyFrequency: frequencyChoice } : {}),
            ...(notificationType === 'group' ? { 
              mentions, 
              groupName: selectedGroupName || undefined,
              groupId: trimmed, // Store groupId directly
            } : {}),
          }),
        });
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.error || 'Failed to store subscriber');
        }
        setStatus('Subscriber stored.');
        setSelectedGroupName('');
        setSignalToken('');
        setNotificationType(null);
        loadSubscribers();
      } else {
        setStatus('Stored locally (no Firebase config).');
      }
    } catch (err: unknown) {
      setStatus(err instanceof Error ? err.message : 'Failed to store token');
    } finally {
      setSaving(false);
    }
  };

  const saveNotifyMode = async (mode: NotifyMode) => {
    setNotifyMode(mode);
    if (!gameInfo?.gameId) return;
    try {
      await ensurePatched();
      if (firebaseAvailable && user) {
        const db = getFirestore();
        const ref = doc(db, 'games', gameInfo.gameId);
        await updateDoc(ref, {
          notifyMode: mode,
          updatedAt: serverTimestamp(),
        });
      }
    } catch {
      // ignore
    }
  };


  const loadSubscribers = async () => {
    if (!gameInfo?.gameId || !user || !firebaseAvailable) {
      setCurrentSubscribers([]);
      return;
    }
    setSubscribersLoading(true);
    try {
      const db = getFirestore();
      const patchRef = doc(db, 'patches', `${gameInfo.gameId}-${user.uid}`);
      const snap = await getDoc(patchRef);
      if (snap.exists()) {
        const data = snap.data() as { subscribers?: any[] };
        setCurrentSubscribers(Array.isArray(data.subscribers) ? data.subscribers : []);
      } else {
        setCurrentSubscribers([]);
      }
    } catch (err) {
      console.error('Failed to load subscribers:', err);
      setCurrentSubscribers([]);
    } finally {
      setSubscribersLoading(false);
    }
  };

  const deleteSubscriber = async (sub: { type: string; handle: string }) => {
    if (!gameInfo?.gameId || !user) return;
    if (!confirm(`Remove ${sub.type === 'group' ? 'group' : 'DM'} notification for ${sub.handle}?`)) {
      return;
    }
    setSaving(true);
    setStatus(null);
    try {
      const idToken = await getAuth().currentUser?.getIdToken();
      const encodedHandle = encodeURIComponent(sub.handle);
      const res = await fetch(
        `/api/patch/${gameInfo.gameId}-${user.uid}/subscribers/${encodedHandle}?type=${sub.type}`,
        {
          method: 'DELETE',
          headers: {
            ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
          },
        }
      );
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'Failed to delete subscriber');
      }
      setStatus('Subscriber removed.');
      loadSubscribers();
    } catch (err: unknown) {
      setStatus(err instanceof Error ? err.message : 'Failed to delete subscriber');
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    if (gameInfo?.gameId && user) {
      loadSubscribers();
      loadInviteLink();
    } else {
      setCurrentSubscribers([]);
      setInviteLink('');
      setInviteCode('');
    }
  }, [gameInfo?.gameId, user]);

  return (
    <div className="min-h-screen bg-transparent text-zinc-100 flex items-center justify-center p-4">
      <main
        className={`w-full max-w-3xl px-6 pb-16 flex flex-col gap-8 backdrop-blur-xl bg-white/10 rounded-3xl border border-white/10 shadow-2xl ${
          user && view === 'main' && !gameInfo ? 'pt-6' : 'pt-16'
        }`}
      >
        <div className="flex items-start justify-between gap-4 min-w-0">
        <div className="space-y-3 min-w-0 flex-1 overflow-hidden">
          {user && view === 'main' && gameInfo ? (
            <div className="relative min-w-0">
              <div className="flex items-center gap-2 min-w-0">
                <Link
                  href="/"
                  onClick={() => {
                    setLockedGameId(null);
                    setGameInfo(null);
                    setSignalToken('');
                    setNotifyMode('signal-dm');
                    setPatchedEnsured(false);
                    setExperimentalExtended(false);
                  }}
                  className="text-base uppercase tracking-[0.2em] text-zinc-400 hover:text-zinc-200 focus:outline-none focus:underline shrink-0"
                >
                  COM TOWER
                </Link>
                <span className="text-zinc-600 shrink-0" aria-hidden>/</span>
                <span
                  className="text-zinc-200 font-medium truncate min-w-0 block"
                  title={[gameInfo.gameName, gameInfo.mapName].filter(Boolean).join(' · ') || undefined}
                >
                  {gameInfo.gameName}
                  {gameInfo.mapName && (
                    <span className="text-zinc-400 font-normal"> · {gameInfo.mapName}</span>
                  )}
                </span>
              </div>
            </div>
          ) : (
            <>
              {!(user && view === 'main' && gameInfo) && (
                <p className="text-xs uppercase tracking-[0.2em] text-zinc-400">Com Tower</p>
              )}
              {!user && (
                <>
                  <h1 className="text-3xl font-semibold">AWBW turn notifications</h1>
                  <p className="text-sm text-zinc-400">
                    AWBW turn alerts via Signal.
                  </p>
                </>
              )}
            </>
          )}
        </div>
          <div className="flex flex-col items-end gap-2 text-xs text-zinc-400 shrink-0">
            <div className="flex items-center gap-2 flex-wrap justify-end">
              {firebaseAvailable ? (
                user ? (
                  <div
                    className="relative"
                    ref={accountMenuRef}
                    onMouseEnter={() => {
                      if (accountMenuCloseTimeoutRef.current) {
                        clearTimeout(accountMenuCloseTimeoutRef.current);
                        accountMenuCloseTimeoutRef.current = null;
                      }
                      setAccountMenuOpen(true);
                    }}
                    onMouseLeave={() => {
                      accountMenuCloseTimeoutRef.current = setTimeout(() => {
                        setAccountMenuOpen(false);
                        accountMenuCloseTimeoutRef.current = null;
                      }, 150);
                    }}
                  >
                    <button
                      type="button"
                      className="text-zinc-400 hover:text-zinc-200 focus:outline-none truncate max-w-[200px] sm:max-w-none"
                      title={user.email ?? undefined}
                    >
                      {user.email}
                    </button>
                    {accountMenuOpen && (
                      <div className="absolute right-0 top-full mt-1 z-50 min-w-[140px] rounded-lg border border-zinc-700 bg-zinc-900 py-1 shadow-xl">
                        <button
                          type="button"
                          onClick={() => {
                            signOutFirebase();
                            setAccountMenuOpen(false);
                          }}
                          className="w-full px-3 py-2 text-left text-sm text-zinc-300 hover:bg-zinc-800 focus:outline-none focus:bg-zinc-800"
                        >
                          Log out
                        </button>
                      </div>
                    )}
                  </div>
                ) : (
                  <button
                    onClick={signInWithGoogle}
                    className="px-3 py-2 rounded-lg bg-white text-black font-semibold"
                  >
                    Sign in with Google
                  </button>
                )
              ) : (
                <span className="text-amber-300">Firebase config missing</span>
              )}
            </div>
            {statusLine && <p className="text-[11px] text-zinc-500">{statusLine}</p>}
          </div>
        </div>

        {user && view === 'main' && !effectiveLockedId && !gameInfo && (
          <div className="space-y-4">
            {lookupPending && <p className="text-xs text-zinc-500">Looking up…</p>}

            {patchedLoading && <p className="text-xs text-zinc-500">Loading your patched games…</p>}

            {!patchedLoading && patchedGames.length > 0 && (
              <div className="overflow-hidden rounded-xl border border-zinc-800">
                <table className="w-full text-sm text-zinc-300">
                  <thead className="bg-zinc-950/80 text-zinc-400 text-xs uppercase tracking-wide">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">Game</th>
                      <th className="px-3 py-2 text-left font-medium">Map</th>
                    </tr>
                  </thead>
                  <tbody>
                    {patchedGames.map((pg) => (
                      <tr
                        key={pg.gameId}
                        className="hover:bg-zinc-900/80 cursor-pointer transition-colors"
                        onClick={() => {
                          router.push(`/game/${pg.gameId}`);
                          setLockedGameId(pg.gameId);
                          setGameInfo(pg);
                          setGameLink(`https://awbw.amarriner.com/game.php?games_id=${pg.gameId}`);
                          setPatchedEnsured(true);
                        }}
                      >
                        <td className="px-3 py-2">{pg.gameName}</td>
                        <td className="px-3 py-2 text-zinc-400">{pg.mapName || 'Map unknown'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
            )}

            <div className="space-y-2">
              <p className="text-xs uppercase tracking-[0.2em] text-zinc-400">New game</p>
                <input
                  value={gameLink}
                onChange={(e) => {
                  setGameLink(e.target.value);
                  setPatchedEnsured(false);
                  setGameInfo(null);
                }}
                  className="w-full rounded-xl bg-black border border-zinc-800 px-3 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-500"
                  placeholder="https://awbw.amarriner.com/game.php?games_id=123456"
              />
            </div>
          </div>
        )}

        {view === 'main' && gameInfo && (
          <div className="space-y-4">
            {user && (
              <section className="rounded-2xl border border-zinc-800 bg-zinc-950 p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs uppercase tracking-[0.2em] text-zinc-400">Invite link</p>
                    <p className="text-sm text-zinc-400">Share with players so they can subscribe without signing in.</p>
                  </div>
                  {inviteLoading && <span className="text-[11px] text-zinc-500">Loading…</span>}
                </div>
                <div className="flex flex-col sm:flex-row gap-2 items-stretch">
                  <input
                    value={inviteLink || 'Loading invite link'}
                    readOnly
                    className="flex-1 rounded-xl bg-black border border-zinc-800 px-3 py-3 text-sm text-zinc-200 focus:outline-none"
                  />
                  <button
                    onClick={async () => {
                      if (!inviteLink) return;
                      try {
                        await navigator.clipboard.writeText(inviteLink);
                        setStatus('Invite link copied.');
                      } catch {
                        setStatus('Copy failed—select and copy manually.');
                      }
                    }}
                    className="px-4 py-3 rounded-xl bg-white text-black font-semibold shadow disabled:opacity-50"
                    disabled={!inviteLink}
                  >
                    Copy link
                  </button>
                </div>
              </section>
            )}
            {user ? (
              <>
                <section className="rounded-2xl border border-zinc-800 bg-zinc-950 p-4 space-y-2">
                  <p className="text-xs uppercase tracking-[0.2em] text-zinc-400">Current subscribers</p>
                  {subscribersLoading ? (
                    <p className="text-xs text-zinc-500">Loading subscribers…</p>
                  ) : currentSubscribers.length > 0 ? (
                    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 divide-y divide-zinc-800">
                      {currentSubscribers.map((sub, idx) => (
                        <div key={idx} className="flex items-center justify-between gap-3 p-3">
                          <div className="min-w-0 flex items-center gap-2 flex-wrap">
                            <span className="text-[10px] uppercase tracking-wide px-2 py-1 rounded-full bg-zinc-800 text-zinc-300 shrink-0">
                              {sub.type}
                            </span>
                            <span className="text-sm text-zinc-200 truncate">{sub.handle}</span>
                            {sub.playerName && (
                              <span className="text-xs text-zinc-500">Player {sub.playerName}</span>
                            )}
                            {sub.country && (
                              <span className="text-xs text-zinc-500 uppercase">{sub.country}</span>
                            )}
                            {sub.needsGroupSelection && (
                              <span className="text-xs text-amber-400">Needs group selection</span>
                            )}
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <select
                              value={sub.scope === 'my-turn' ? 'my-turn' : 'all'}
                              onChange={async (e) => {
                                const val = e.target.value as 'my-turn' | 'all';
                                if (!gameInfo?.gameId || !user || !firebaseAvailable) return;
                                setSaving(true);
                                setStatus(null);
                                try {
                                  const idToken = await getAuth().currentUser?.getIdToken();
                                  const res = await fetch(`/api/patch/${gameInfo.gameId}-${user.uid}/subscribers`, {
                                    method: 'PATCH',
                                    headers: {
                                      'Content-Type': 'application/json',
                                      ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
                                    },
                                    body: JSON.stringify({ type: sub.type, handle: sub.handle, scope: val }),
                                  });
                                  if (!res.ok) {
                                    const errData = await res.json().catch(() => ({}));
                                    throw new Error(errData.error || 'Failed to update');
                                  }
                                  setStatus('Updated.');
                                  loadSubscribers();
                                } catch (err: unknown) {
                                  setStatus(err instanceof Error ? err.message : 'Update failed');
                                } finally {
                                  setSaving(false);
                                }
                              }}
                              disabled={saving}
                              className="rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-200 focus:outline-none focus:ring-1 focus:ring-zinc-500"
                            >
                              <option value="all">All turns</option>
                              <option value="my-turn">Only my turn</option>
                            </select>
                            <select
                              value={sub.notifyFrequency === 'hourly' ? 'hourly' : ''}
                              onChange={async (e) => {
                                const val = e.target.value as '' | 'hourly';
                                if (!gameInfo?.gameId || !user || !firebaseAvailable) return;
                                setSaving(true);
                                setStatus(null);
                                try {
                                  const idToken = await getAuth().currentUser?.getIdToken();
                                  const res = await fetch(`/api/patch/${gameInfo.gameId}-${user.uid}/subscribers`, {
                                    method: 'PATCH',
                                    headers: {
                                      'Content-Type': 'application/json',
                                      ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
                                    },
                                    body: JSON.stringify({
                                      type: sub.type,
                                      handle: sub.handle,
                                      notifyFrequency: val === '' ? null : val,
                                    }),
                                  });
                                  if (!res.ok) {
                                    const errData = await res.json().catch(() => ({}));
                                    throw new Error(errData.error || 'Failed to update');
                                  }
                                  setStatus('Updated.');
                                  loadSubscribers();
                                } catch (err: unknown) {
                                  setStatus(err instanceof Error ? err.message : 'Update failed');
                                } finally {
                                  setSaving(false);
                                }
                              }}
                              disabled={saving}
                              className="rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-200 focus:outline-none focus:ring-1 focus:ring-zinc-500"
                            >
                              <option value="">Once per turn</option>
                              <option value="hourly">Hourly</option>
                            </select>
                            <select
                              value={sub.funEnabled ? 'fun' : 'plain'}
                              onChange={async (e) => {
                                const val = e.target.value === 'fun';
                                if (!gameInfo?.gameId || !user || !firebaseAvailable) return;
                                setSaving(true);
                                setStatus(null);
                                try {
                                  const idToken = await getAuth().currentUser?.getIdToken();
                                  const res = await fetch(`/api/patch/${gameInfo.gameId}-${user.uid}/subscribers`, {
                                    method: 'PATCH',
                                    headers: {
                                      'Content-Type': 'application/json',
                                      ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
                                    },
                                    body: JSON.stringify({ type: sub.type, handle: sub.handle, funEnabled: val }),
                                  });
                                  if (!res.ok) {
                                    const errData = await res.json().catch(() => ({}));
                                    throw new Error(errData.error || 'Failed to update');
                                  }
                                  setStatus('Updated.');
                                  loadSubscribers();
                                } catch (err: unknown) {
                                  setStatus(err instanceof Error ? err.message : 'Update failed');
                                } finally {
                                  setSaving(false);
                                }
                              }}
                              disabled={saving}
                              className="rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-200 focus:outline-none focus:ring-1 focus:ring-zinc-500"
                            >
                              <option value="plain">Classic</option>
                              <option value="fun">Fun mode</option>
                            </select>
                            <button
                              onClick={() => deleteSubscriber(sub)}
                              disabled={saving}
                              className="p-2 rounded-lg border border-zinc-700 text-zinc-400 hover:border-red-600 hover:text-red-400 disabled:opacity-50 transition-colors"
                              title="Remove subscriber"
                            >
                              <svg
                                xmlns="http://www.w3.org/2000/svg"
                                className="h-4 w-4"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  strokeWidth={2}
                                  d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                                />
                              </svg>
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-zinc-500">
                      Share the invite link above to add subscribers. They’ll choose their settings on the invite page.
                    </p>
                  )}
                </section>
              </>
            ) : (
              <p className="text-sm text-zinc-400">Sign in to configure notifications for this game.</p>
            )}

            <div className="pt-4 space-y-2">
              <p className="text-xs uppercase tracking-[0.2em] text-zinc-400">Activity feed</p>
              {(activityLoading || patchActivityLoading) && <p className="text-xs text-zinc-500">Loading activity…</p>}
              {!activityLoading && !patchActivityLoading && activity.length === 0 && (
                <p className="text-xs text-zinc-500">No activity yet. Changes to subscribers will appear here.</p>
              )}
              {(!activityLoading || !patchActivityLoading) && activity.length > 0 && (
                <div className="space-y-2">
                  <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3 space-y-2">
                  {activityPaginated.map((item, idx) => (
                    <div key={activityPage * ACTIVITY_PAGE_SIZE + idx} className="text-sm text-zinc-200 space-y-1">
                      {item.kind === 'patch_activity' ? (
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-[10px] uppercase tracking-wide px-2 py-1 rounded-full bg-zinc-800 text-zinc-300">
                            {item.action === 'subscriber_added' ? 'Added' : item.action === 'subscriber_removed' ? 'Removed' : 'Updated'}
                          </span>
                          <span className="text-zinc-300">{item.handle ?? '—'}</span>
                          {item.details && <span className="text-zinc-400">{item.details}</span>}
                          {item.createdAt && (
                            <span className="text-[11px] text-zinc-500 ml-auto">{new Date(item.createdAt).toLocaleString()}</span>
                          )}
                        </div>
                      ) : (
                      <>
                      <div className="flex items-center gap-2">
                        {item.status && (
                          <span className="text-[10px] uppercase tracking-wide px-2 py-1 rounded-full bg-zinc-800 text-zinc-300">
                            {item.status}
                          </span>
                        )}
                        {!item.textClassic && !item.textFun ? (
                          <p className="flex-1">{item.text || 'Pending…'}</p>
                        ) : (
                          <div className="flex-1 space-y-1">
                            {item.textClassic && (
                              <div className="rounded-lg border border-zinc-800 bg-zinc-900 px-2 py-1">
                                <span className="text-[10px] uppercase tracking-wide text-zinc-400">Classic</span>
                                <p className="text-sm text-zinc-100">{item.textClassic}</p>
                              </div>
                            )}
                            {item.textFun && (
                              <div className="rounded-lg border border-indigo-900/60 bg-indigo-950/40 px-2 py-1">
                                <span className="text-[10px] uppercase tracking-wide text-indigo-300">Fun</span>
                                <p className="text-sm text-zinc-100">{item.textFun}</p>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                      {item.imageUrl && (
                        <img
                          src={item.imageUrl}
                          alt="Rendered turn"
                          className="mt-1 rounded-lg border border-zinc-800 max-h-64 object-contain"
                          onError={(e) => {
                            // Hide broken images
                            (e.target as HTMLImageElement).style.display = 'none';
                          }}
                        />
                      )}
                      {(!!item.recipientsClassic?.length || !!item.recipientsFun?.length) && (
                        <div className="text-[11px] text-zinc-400 flex flex-col gap-1">
                          {item.recipientsClassic?.length ? (
                            <div className="flex flex-wrap gap-1">
                              <span className="px-2 py-1 rounded-full bg-zinc-800 text-[10px] uppercase tracking-wide text-zinc-300">
                                Classic
                              </span>
                              <span className="text-zinc-400">
                                {item.recipientsClassic.join(', ')}
                              </span>
                            </div>
                          ) : null}
                          {item.recipientsFun?.length ? (
                            <div className="flex flex-wrap gap-1">
                              <span className="px-2 py-1 rounded-full bg-indigo-900/60 text-[10px] uppercase tracking-wide text-indigo-200">
                                Fun
                              </span>
                              <span className="text-zinc-400">
                                {item.recipientsFun.join(', ')}
                              </span>
                            </div>
                          ) : null}
                        </div>
                      )}
                      {!!item.deliveries?.length && (
                        <div className="text-[11px] text-zinc-400 space-y-1">
                          {item.deliveries.map((d, i) => (
                            <div key={i} className="flex flex-wrap items-center gap-2">
                              <span
                                className={`px-2 py-0.5 rounded-full text-[10px] uppercase tracking-wide ${
                                  d.variant === 'fun'
                                    ? 'bg-indigo-900/70 text-indigo-200'
                                    : 'bg-zinc-800 text-zinc-200'
                                }`}
                              >
                                {d.variant}
                              </span>
                              <span
                                className={`px-2 py-0.5 rounded-full text-[10px] uppercase tracking-wide ${
                                  d.status === 'sent'
                                    ? 'bg-emerald-900/70 text-emerald-200'
                                    : 'bg-rose-900/60 text-rose-200'
                                }`}
                              >
                                {d.status}
                              </span>
                              <span className="text-zinc-300">{d.handle}</span>
                              {d.error && <span className="text-rose-200">{d.error}</span>}
                            </div>
                          ))}
                        </div>
                      )}
                      <div className="text-[11px] text-zinc-500 flex gap-3">
                        {item.createdAt && <span>{new Date(item.createdAt).toLocaleString()}</span>}
                      </div>
                      </>
                      )}
                    </div>
                  ))}
                  </div>
                  {activityTotalPages > 1 && (
                    <div className="flex items-center justify-between gap-2 text-xs text-zinc-400">
                      <span>
                        {activityPage * ACTIVITY_PAGE_SIZE + 1}–{Math.min((activityPage + 1) * ACTIVITY_PAGE_SIZE, activity.length)} of {activity.length}
                      </span>
                      <div className="flex gap-1">
                        <button
                          type="button"
                          onClick={() => setActivityPage((p) => Math.max(0, p - 1))}
                          disabled={!canActivityPrev}
                          className="rounded-lg border border-zinc-700 px-2 py-1.5 text-zinc-300 hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          Previous
                        </button>
                        <button
                          type="button"
                          onClick={() => setActivityPage((p) => Math.min(activityTotalPages - 1, p + 1))}
                          disabled={!canActivityNext}
                          className="rounded-lg border border-zinc-700 px-2 py-1.5 text-zinc-300 hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          Next
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {status && !/Game loaded\./i.test(status) && (
          <div className="text-xs text-amber-300 bg-[#1b1b26] border border-[#2a2a36] rounded-xl px-3 py-2">
            {status}
          </div>
        )}
      </main>
    </div>
  );
}

export default function Home() {
  return <ComTowerApp />;
}
