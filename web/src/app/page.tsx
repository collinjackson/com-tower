'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  firebaseAvailable,
  signInWithGoogle,
  signOutFirebase,
  subscribeToAuth,
} from '@/lib/firebase';
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
import { useRouter } from 'next/navigation';

type GameInfo = {
  gameId: string;
  gameName: string;
  mapName: string;
};

type NotifyMode = 'none' | 'signal-dm';
type ActivityItem = {
  text: string;
  recipient: string | null;
  createdAt: string | null;
  imageUrl?: string | null;
  status?: string;
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
  const [experimentalExtended, setExperimentalExtended] = useState(false);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [activityLoading, setActivityLoading] = useState(false);
  const [funChoice, setFunChoice] = useState<'fun' | 'plain' | null>(null);
  const [scopeChoice, setScopeChoice] = useState<'my-turn' | 'all'>('all');
  const [mentionsRaw, setMentionsRaw] = useState('');
  const [selectedGroupName, setSelectedGroupName] = useState('');
  const [groups, setGroups] = useState<any[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [currentSubscribers, setCurrentSubscribers] = useState<any[]>([]);
  const [subscribersLoading, setSubscribersLoading] = useState(false);
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

  // Live activity feed (Firestore only; surface errors)
  useEffect(() => {
    if (!lockedGameId) {
      setActivity([]);
      return;
    }
    setActivityLoading(true);
    
    // Use API endpoint instead of direct Firestore to avoid auth issues
    const fetchActivity = async () => {
      try {
        const res = await fetch(`/api/game/${lockedGameId}/activity`);
        if (res.ok) {
          const data = await res.json();
          const rows: ActivityItem[] = (data.messages || []).map((m: any) => ({
            text: m.text || '',
            recipient: m.recipient || null,
            createdAt: m.createdAt || null,
            imageUrl: m.imageUrl || null,
            status: m.status || null,
          }));
          setActivity(rows);
        } else {
          console.error('Activity feed API failed:', res.status, res.statusText);
          setActivity([]);
        }
      } catch (err) {
        console.error('Activity feed fetch failed:', err);
        setActivity([]);
      } finally {
        setActivityLoading(false);
      }
    };
    
    fetchActivity();
    // Poll every 5 seconds for updates
    const interval = setInterval(fetchActivity, 5000);
    return () => clearInterval(interval);
  }, [lockedGameId]);

  const statusLine = useMemo(() => {
    if (!firebaseAvailable) return 'Firestore not configured; using local mock.';
    if (!user) return 'Sign in to start.';
    return null;
  }, [user]);

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
            handle: trimmed, // For groups, this is the groupId
            funEnabled: funChoice === 'fun',
            scope: scopeChoice,
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
    } else {
      setCurrentSubscribers([]);
    }
  }, [gameInfo?.gameId, user]);

  return (
    <div className="min-h-screen bg-black text-zinc-100 flex items-center justify-center">
      <main className="w-full max-w-3xl px-6 py-16 flex flex-col gap-8">
        <div className="flex items-start justify-between gap-4">
        <div className="space-y-3">
          <p className="text-xs uppercase tracking-[0.2em] text-zinc-400">Com Tower</p>
            {!user && (
              <>
          <h1 className="text-3xl font-semibold">AWBW turn notifications</h1>
          <p className="text-sm text-zinc-400">
                  Patch your AWBW game to receive turn alerts.
          </p>
              </>
            )}
        </div>
          <div className="flex flex-col items-end gap-2 text-xs text-zinc-400">
            <div className="flex items-center gap-2">
              {firebaseAvailable ? (
                user ? (
                  <>
                    <span>{user.email}</span>
                    {view === 'settings' ? (
                      <button
                        onClick={() => setView('main')}
                        className="px-3 py-2 rounded-lg border border-zinc-700 hover:border-zinc-500"
                      >
                        Back
                      </button>
                    ) : (
                    <button
                        onClick={() => setView('settings')}
                      className="px-3 py-2 rounded-lg border border-zinc-700 hover:border-zinc-500"
                    >
                        Settings
                    </button>
                    )}
                  </>
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
            <div className="flex items-center justify-between">
                <div>
                <p className="text-xs uppercase tracking-[0.2em] text-zinc-400">Patched games</p>
                <p className="text-sm text-zinc-400">Select to manage notifications.</p>
              </div>
              {lookupPending && <p className="text-xs text-zinc-500">Looking up…</p>}
            </div>

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

        {user && view === 'settings' && (
          <section className="rounded-2xl border border-zinc-800 bg-zinc-950 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-zinc-400">Settings</p>
                <p className="text-sm text-zinc-400">Default Signal DM and session.</p>
              </div>
              <button
                onClick={signOutFirebase}
                className="px-3 py-2 rounded-lg border border-zinc-700 hover:border-zinc-500 text-xs"
              >
                Sign out
              </button>
            </div>
            <div className="space-y-2">
              <p className="text-xs uppercase tracking-[0.2em] text-zinc-400">Default Signal number</p>
              {userPhoneLoading && <p className="text-xs text-zinc-500">Loading…</p>}
              <div className="flex flex-col sm:flex-row gap-2">
                <input
                  value={userPhone}
                  onChange={(e) => setUserPhone(e.target.value)}
                  className="flex-1 rounded-xl bg-black border border-zinc-800 px-3 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-500"
                  placeholder="Your Signal phone (DM default)"
                />
                <button
                  onClick={async () => {
                    if (!firebaseAvailable || !user) return;
                    setSaving(true);
                    setStatus(null);
                    try {
                      const db = getFirestore();
                      const ref = doc(db, 'users', user.uid);
                      await setDoc(
                        ref,
                        {
                          signalPhone: userPhone.trim(),
                          updatedAt: serverTimestamp(),
                        },
                        { merge: true }
                      );
                      setStatus('Default Signal number saved.');
                    } catch (err: unknown) {
                      setStatus(err instanceof Error ? err.message : 'Failed to save number');
                    } finally {
                      setSaving(false);
                    }
                  }}
                  disabled={saving}
                  className="px-4 py-3 rounded-xl bg-white text-black font-semibold shadow disabled:opacity-50"
                >
                  Save number
                </button>
              </div>
            </div>
          </section>
        )}

        {view === 'main' && gameInfo && (
          <div className="space-y-4">
            <div className="flex items-start justify-between">
                  <div>
                <p className="text-xs uppercase tracking-[0.2em] text-zinc-400">Selected game</p>
                    <p className="text-lg font-semibold text-zinc-100">{gameInfo.gameName}</p>
                    <p className="text-sm text-zinc-400">{gameInfo.mapName || 'Map unknown'}</p>
                  </div>
                  <button
                    onClick={() => {
                  router.push('/');
                  setLockedGameId(null);
                      setGameInfo(null);
                      setSignalToken('');
                      setNotifyMode('signal-dm');
                  setPatchedEnsured(false);
                  setExperimentalExtended(false);
                    }}
                className="px-3 py-2 rounded-lg border border-zinc-700 text-zinc-300 hover:border-zinc-500 text-xs"
                  >
                Back to list
                  </button>
                </div>
            {user ? (
              <>
            <div className="flex items-center justify-between">
              <div>
                    <p className="text-xs uppercase tracking-[0.2em] text-zinc-400">Signal notifications</p>
                    <p className="text-lg font-semibold text-zinc-100">DM or group</p>
                    <p className="text-sm text-zinc-400">
                      Choose notification type, then enter your Signal phone or group ID.
                    </p>
              </div>
            </div>
            
            <div className="space-y-2">
              <p className="text-xs uppercase tracking-[0.2em] text-zinc-400">Notification type</p>
              <div className="grid sm:grid-cols-2 gap-3">
                <button
                  onClick={() => {
                    setNotificationType('dm');
                    setSignalToken('');
                    setSelectedGroupName('');
                    setMentionsRaw('');
                  }}
                  className={`rounded-xl border px-3 py-3 text-left ${
                    notificationType === 'dm'
                      ? 'bg-[#13211f] border-[#1f3c35] text-[#b5f5e4]'
                      : 'bg-black border-zinc-800 text-zinc-300'
                  }`}
                >
                  <p className="text-sm font-semibold">Direct Message (DM)</p>
                  <p className="text-xs text-zinc-400">
                    Send notifications to a phone number
                  </p>
                </button>
                <button
                  onClick={() => {
                    setNotificationType('group');
                    setSignalToken('');
                    setSelectedGroupName('');
                    setMentionsRaw('');
                  }}
                  className={`rounded-xl border px-3 py-3 text-left ${
                    notificationType === 'group'
                      ? 'bg-[#1a1b2f] border-[#2e315a] text-[#c7d0ff]'
                      : 'bg-black border-zinc-800 text-zinc-300'
                  }`}
                >
                  <p className="text-sm font-semibold">Group Chat</p>
                  <p className="text-xs text-zinc-400">
                    Send notifications to a Signal group
                  </p>
                </button>
              </div>
            </div>

            {notificationType && (
              <>
                <div className="space-y-2">
                  <label className="text-xs uppercase tracking-[0.2em] text-zinc-400">
                    {notificationType === 'dm' ? 'Signal phone number' : 'Group ID'}
                  </label>
                  <input
                    value={signalToken}
                    onChange={(e) => setSignalToken(e.target.value)}
                    className="w-full rounded-xl bg-black border border-zinc-800 px-3 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-500"
                    placeholder={notificationType === 'dm' 
                      ? 'Your Signal phone number (e.g., +15551234567)'
                      : 'Group ID (e.g., group.CjQKICLkMKbor17qZpL...)'
                    }
                  />
                </div>
                
                {notificationType === 'group' && (
                  <>
                    <div className="space-y-2">
                      <label className="text-xs uppercase tracking-[0.2em] text-zinc-400">
                        Group name
                      </label>
                      <div className="flex gap-2">
                        <input
                          value={selectedGroupName}
                          onChange={(e) => setSelectedGroupName(e.target.value)}
                          className="flex-1 rounded-xl bg-black border border-zinc-800 px-3 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-500"
                          placeholder="Enter the exact group name"
                        />
                        <button
                          onClick={async () => {
                            if (!user) return;
                            setGroupsLoading(true);
                            setStatus(null);
                            try {
                              const idToken = await getAuth().currentUser?.getIdToken();
                              const res = await fetch('/api/groups/list', {
                                headers: {
                                  ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
                                },
                              });
                              if (res.ok) {
                                const data = await res.json();
                                setGroups(data.groups || []);
                                if (data.groups && data.groups.length > 0) {
                                  // Auto-select if only one group
                                  if (data.groups.length === 1) {
                                    setSelectedGroupName(data.groups[0].name || '');
                                    setStatus(`Found 1 group: ${data.groups[0].name || 'unnamed'}`);
                                  } else {
                                    setStatus(`Found ${data.groups.length} groups. Select from dropdown or type name.`);
                                  }
                                } else {
                                  setStatus('No groups found. You can type the group name manually.');
                                }
                              } else {
                                const errData = await res.json().catch(() => ({}));
                                setStatus(`Could not load groups: ${errData.error || res.statusText}. You can type the group name manually.`);
                              }
                            } catch (err) {
                              console.error('Failed to load groups:', err);
                              setStatus('Could not load groups. You can type the group name manually.');
                            } finally {
                              setGroupsLoading(false);
                            }
                          }}
                          disabled={groupsLoading}
                          className="px-4 py-3 rounded-xl bg-[#152029] border border-[#20415a] text-[#c7e6ff] text-sm disabled:opacity-50 whitespace-nowrap"
                          title="Try to load groups from Signal (may be slow)"
                        >
                          {groupsLoading ? 'Loading…' : 'Load'}
                        </button>
                      </div>
                      {groups.length > 0 && (
                        <select
                          value={selectedGroupName}
                          onChange={async (e) => {
                            const selectedName = e.target.value;
                            setSelectedGroupName(selectedName);
                            
                            // Find the selected group and set its ID
                            const selectedGroup = groups.find((g) => g.name === selectedName);
                            if (selectedGroup) {
                              const groupId = selectedGroup.id || (selectedGroup.internal_id ? `group.${selectedGroup.internal_id}` : null);
                              if (groupId) {
                                setSignalToken(groupId);
                                
                                // Automatically fetch members and populate mentions
                                try {
                                  const idToken = await getAuth().currentUser?.getIdToken();
                                  const membersRes = await fetch(`/api/groups/members?groupId=${encodeURIComponent(groupId)}`, {
                                    headers: {
                                      ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
                                    },
                                  });
                                  if (membersRes.ok) {
                                    const membersData = await membersRes.json();
                                    if (membersData.members && Array.isArray(membersData.members) && membersData.members.length > 0) {
                                      setMentionsRaw(membersData.members.join(', '));
                                      setStatus(`Loaded ${membersData.members.length} members from "${selectedName}". Mentions auto-populated.`);
                                    } else {
                                      setStatus(`Group "${selectedName}" has no members or members couldn't be loaded.`);
                                    }
                                  } else {
                                    const errData = await membersRes.json().catch(() => ({}));
                                    setStatus(`Could not load members: ${errData.error || membersRes.statusText}`);
                                  }
                                } catch (err) {
                                  console.error('Failed to load group members:', err);
                                  setStatus('Could not load group members automatically.');
                                }
                              }
                            }
                          }}
                          className="w-full rounded-xl bg-black border border-zinc-800 px-3 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-500"
                        >
                          <option value="">Or choose from loaded groups…</option>
                          {groups.map((g) => {
                            const groupId = g.id || (g.internal_id ? `group.${g.internal_id}` : null);
                            return (
                              <option key={groupId || g.name} value={g.name || ''}>
                                {g.name || `Group ${groupId || 'unnamed'}`}
                              </option>
                            );
                          })}
                        </select>
                      )}
                      <p className="text-[11px] text-zinc-500">
                        Select a group from the dropdown to auto-fill the group ID and members. The bot must already be in the group.
                      </p>
                    </div>
                    <div className="space-y-2">
                      <label className="text-xs uppercase tracking-[0.2em] text-zinc-400">
                        Group mentions (optional)
                      </label>
                      <input
                        value={mentionsRaw}
                        onChange={(e) => setMentionsRaw(e.target.value)}
                        className="w-full rounded-xl bg-black border border-zinc-800 px-3 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-500"
                        placeholder="+15551234567, +15557654321"
                      />
                      <p className="text-[11px] text-zinc-500">
                        We'll @ these numbers in the group message. Use Signal-registered numbers,
                        comma or space separated.
                      </p>
                    </div>
                )}
              </>
            )}
                <div className="flex gap-2 items-start">
              <button
                onClick={saveSignalToken}
                    disabled={saving || !(signalToken.trim() || userPhone.trim())}
                className="flex-1 rounded-xl px-4 py-3 bg-[#152029] border border-[#20415a] text-[#c7e6ff] disabled:opacity-50"
              >
                    Save notification number/link
              </button>
              {signalToken && (
                <button
                  onClick={() => setSignalToken('')}
                  className="px-3 py-2 rounded-lg border border-zinc-700 text-zinc-300 hover:border-zinc-500"
                >
                  Clear
                </button>
              )}
                  {!signalToken && (
                    <p className="text-[11px] text-zinc-500 pt-3">
                      We just store your Signal number or group invite link—no other token needed.
                    </p>
                  )}
            </div>


                {(subscribersLoading || currentSubscribers.length > 0) && (
                  <div className="space-y-2">
                    <p className="text-xs uppercase tracking-[0.2em] text-zinc-400">Current subscribers</p>
                    {subscribersLoading ? (
                      <p className="text-xs text-zinc-500">Loading subscribers…</p>
                    ) : (
                      <div className="rounded-xl border border-zinc-800 bg-zinc-950 divide-y divide-zinc-800">
                      {currentSubscribers.map((sub, idx) => (
                        <div key={idx} className="flex items-center justify-between p-3">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-[10px] uppercase tracking-wide px-2 py-1 rounded-full bg-zinc-800 text-zinc-300">
                                {sub.type}
                              </span>
                              <span className="text-sm text-zinc-200 truncate">{sub.handle}</span>
                            </div>
                            <div className="flex items-center gap-3 mt-1 text-xs text-zinc-400">
                              <span>{sub.scope === 'my-turn' ? 'Only my turn' : 'All turns'}</span>
                              <span>•</span>
                              <span>{sub.funEnabled ? 'Fun mode' : 'Classic'}</span>
                              {sub.needsGroupSelection && (
                                <>
                                  <span>•</span>
                                  <span className="text-amber-400">Needs group selection</span>
                                </>
                              )}
                            </div>
                          </div>
                          <button
                            onClick={() => deleteSubscriber(sub)}
                            disabled={saving}
                            className="ml-3 p-2 rounded-lg border border-zinc-700 text-zinc-400 hover:border-red-600 hover:text-red-400 disabled:opacity-50 transition-colors"
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
                      ))}
                      </div>
                    )}
                  </div>
                )}

            <div className="pt-3 space-y-2">
              <p className="text-xs uppercase tracking-[0.2em] text-zinc-400">Notifications</p>
                  <div className="grid sm:grid-cols-2 gap-3">
                <button
                      onClick={() => setScopeChoice('my-turn')}
                      className={`rounded-xl border px-3 py-3 text-left ${
                        scopeChoice === 'my-turn'
                          ? 'bg-[#13211f] border-[#1f3c35] text-[#b5f5e4]'
                          : 'bg-black border-zinc-800 text-zinc-300'
                      }`}
                    >
                      <p className="text-sm font-semibold">Only my turn</p>
                      <p className="text-xs text-zinc-400">
                        DM me when it’s my move. Good for team games.
                      </p>
                </button>
                <button
                      onClick={() => setScopeChoice('all')}
                      className={`rounded-xl border px-3 py-3 text-left ${
                        scopeChoice === 'all'
                          ? 'bg-[#1a1b2f] border-[#2e315a] text-[#c7d0ff]'
                          : 'bg-black border-zinc-800 text-zinc-300'
                      }`}
                    >
                      <p className="text-sm font-semibold">All turns</p>
                      <p className="text-xs text-zinc-400">
                        Follow every turn in this game (spectator-friendly).
                      </p>
                </button>
              </div>

                  <div className="pt-4 space-y-2">
                    <p className="text-xs uppercase tracking-[0.2em] text-zinc-400">Message style</p>
                    <div className="grid sm:grid-cols-2 gap-3">
                      <button
                        onClick={() => setFunChoice('plain')}
                        className={`rounded-xl border px-4 py-4 text-left ${
                          funChoice === 'plain'
                            ? 'bg-[#101010] border-zinc-500 text-zinc-50'
                            : 'bg-black border-zinc-800 text-zinc-300'
                        }`}
                      >
                        <p className="text-sm font-semibold">Classic</p>
                        <p className="text-xs text-zinc-400">
                          Straightforward turn pings, no images.
                        </p>
                        <div className="mt-2 text-[11px] text-zinc-500 border border-zinc-800 rounded-lg p-2">
                          “Day 12 – You’re up. [Game link]”
                        </div>
                      </button>
                      <button
                        onClick={() => setFunChoice('fun')}
                        className={`rounded-xl border px-4 py-4 text-left ${
                          funChoice === 'fun'
                            ? 'bg-[#13182a] border-[#2f3c7a] text-[#d5e0ff]'
                            : 'bg-black border-zinc-800 text-zinc-300'
                        }`}
                      >
                        <p className="text-sm font-semibold">Fun mode</p>
                        <p className="text-xs text-zinc-400">
                          AI caption + image with your faction vibe.
                        </p>
                        <div className="mt-2 text-[11px] text-zinc-500 border border-zinc-800 rounded-lg p-2">
                          “Grit’s infantry raises the Com Tower flag under orange skies.”
                        </div>
                      </button>
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <p className="text-sm text-zinc-400">Sign in to configure notifications for this game.</p>
            )}

            <div className="pt-4 space-y-2">
              <p className="text-xs uppercase tracking-[0.2em] text-zinc-400">Activity feed</p>
              {activityLoading && <p className="text-xs text-zinc-500">Loading activity…</p>}
              {!activityLoading && activity.length === 0 && (
                <p className="text-xs text-zinc-500">No messages yet.</p>
              )}
              {!activityLoading && activity.length > 0 && (
                <div className="space-y-2 rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                  {activity.map((item, idx) => (
                    <div key={idx} className="text-sm text-zinc-200 space-y-1">
                      <div className="flex items-center gap-2">
                        {item.status && (
                          <span className="text-[10px] uppercase tracking-wide px-2 py-1 rounded-full bg-zinc-800 text-zinc-300">
                            {item.status}
                          </span>
                        )}
                        <p className="flex-1">{item.text || 'Pending…'}</p>
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
                      <div className="text-[11px] text-zinc-500 flex gap-3">
                        {item.createdAt && <span>{new Date(item.createdAt).toLocaleString()}</span>}
                      </div>
                    </div>
                  ))}
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
