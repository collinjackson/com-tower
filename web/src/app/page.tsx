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
} from 'firebase/firestore';
import { getAuth } from 'firebase/auth';

type GameInfo = {
  gameId: string;
  gameName: string;
  mapName: string;
};

type NotifyMode = 'none' | 'signal-dm';

export default function Home() {
  const [user, setUser] = useState<User | null>(null);
  const [gameLink, setGameLink] = useState('');
  const [gameInfo, setGameInfo] = useState<GameInfo | null>(null);
  const [signalToken, setSignalToken] = useState('');
  const [notifyMode, setNotifyMode] = useState<NotifyMode>('signal-dm');
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [lookupPending, setLookupPending] = useState(false);
  const [patchedEnsured, setPatchedEnsured] = useState(false);
  const [patchedGames, setPatchedGames] = useState<GameInfo[]>([]);
  const [patchedLoading, setPatchedLoading] = useState(false);
  const [userPhone, setUserPhone] = useState('');
  const [userPhoneLoading, setUserPhoneLoading] = useState(false);

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
    setSaving(true);
    setStatus(null);
    try {
      await ensurePatched();
      if (firebaseAvailable && user) {
        const idToken = await getAuth().currentUser?.getIdToken();
        const trimmed = (signalToken || userPhone).trim();
        if (!trimmed) {
          throw new Error('Enter a Signal phone or group invite link.');
        }
        const isGroup = /^https?:\/\//i.test(trimmed);
        const res = await fetch(`/api/patch/${gameInfo.gameId}-${user.uid}/subscribers`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
          },
          body: JSON.stringify({ type: isGroup ? 'group' : 'dm', handle: trimmed }),
        });
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.error || 'Failed to store subscriber');
        }
        setStatus('Subscriber stored.');
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
                    <button
                      onClick={signOutFirebase}
                      className="px-3 py-2 rounded-lg border border-zinc-700 hover:border-zinc-500"
                    >
                      Sign out
                    </button>
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

        {user && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-zinc-400">Default Signal number</p>
                <p className="text-sm text-zinc-400">
                  Used for DM notifications unless you paste a group invite link.
                </p>
              </div>
              {userPhoneLoading && <p className="text-xs text-zinc-500">Loading…</p>}
            </div>
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
        )}

        {user && !gameInfo && (
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

        {user && gameInfo && (
          <div className="space-y-4">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-zinc-400">Selected game</p>
                <p className="text-lg font-semibold text-zinc-100">{gameInfo.gameName}</p>
                <p className="text-sm text-zinc-400">{gameInfo.mapName || 'Map unknown'}</p>
              </div>
              <button
                onClick={() => {
                  setGameInfo(null);
                  setSignalToken('');
                  setNotifyMode('signal-dm');
                  setPatchedEnsured(false);
                }}
                className="px-3 py-2 rounded-lg border border-zinc-700 text-zinc-300 hover:border-zinc-500 text-xs"
              >
                Back to list
              </button>
            </div>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-zinc-400">Signal notifications</p>
                <p className="text-lg font-semibold text-zinc-100">DM or group</p>
                <p className="text-sm text-zinc-400">
                  Enter your Signal phone for DMs, or paste a Signal group invite link (bot joins silently).
                </p>
              </div>
            </div>
            <input
              value={signalToken}
              onChange={(e) => setSignalToken(e.target.value)}
              className="w-full rounded-xl bg-black border border-zinc-800 px-3 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-500"
              placeholder="Signal phone (DM) or group invite link"
            />
            <div className="flex gap-2">
              <button
                onClick={saveSignalToken}
                disabled={saving}
                className="flex-1 rounded-xl px-4 py-3 bg-[#152029] border border-[#20415a] text-[#c7e6ff] disabled:opacity-50"
              >
                Save token
              </button>
              {signalToken && (
                <button
                  onClick={() => setSignalToken('')}
                  className="px-3 py-2 rounded-lg border border-zinc-700 text-zinc-300 hover:border-zinc-500"
                >
                  Clear
                </button>
              )}
            </div>

            <div className="pt-3 space-y-2">
              <p className="text-xs uppercase tracking-[0.2em] text-zinc-400">Notifications</p>
              <div className="flex gap-2">
                <button
                  onClick={() => saveNotifyMode('signal-dm')}
                  className={`flex-1 rounded-lg px-3 py-3 border text-sm ${
                    notifyMode === 'signal-dm'
                      ? 'bg-[#152029] border-[#20415a] text-[#c7e6ff]'
                      : 'bg-black border-zinc-800 text-zinc-400'
                  }`}
                >
                  Signal DM
                </button>
                <button
                  onClick={() => saveNotifyMode('none')}
                  className={`flex-1 rounded-lg px-3 py-3 border text-sm ${
                    notifyMode === 'none'
                      ? 'bg-[#152029] border-[#20415a] text-[#c7e6ff]'
                      : 'bg-black border-zinc-800 text-zinc-400'
                  }`}
                >
                  No notifications
                </button>
              </div>
              <p className="text-xs text-zinc-500">
                For this 1v1 demo, only your DM token is used. Other players stay silent.
              </p>
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
