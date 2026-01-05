'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  firebaseAvailable,
  getFirebaseDb,
  signInWithGoogle,
  signOutFirebase,
  subscribeToAuth,
} from '@/lib/firebase';
import type { User } from 'firebase/auth';
import { doc, setDoc, updateDoc, serverTimestamp } from 'firebase/firestore';

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

  useEffect(() => {
    if (!firebaseAvailable) return;
    const unsub = subscribeToAuth(setUser);
    return () => unsub && unsub();
  }, []);

  const statusLine = useMemo(() => {
    if (!firebaseAvailable) return 'Firestore not configured; using local mock.';
    if (!user) return 'Sign in to start.';
    if (gameInfo) return 'Line is clean.';
    return 'Ready to patch a game.';
  }, [user, gameInfo]);

  const lookupGame = async () => {
    if (!gameLink.trim()) {
      setStatus('Enter a game link or ID.');
      return;
    }
    setSaving(true);
    setStatus(null);
    try {
      const res = await fetch(`/api/game/lookup?link=${encodeURIComponent(gameLink)}`);
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'Lookup failed');
      }
      const data = await res.json();
      setGameInfo({
        gameId: data.gameId,
        gameName: data.gameName || `Game ${data.gameId}`,
        mapName: data.mapName || '',
      });
      setStatus('Game loaded. Save to Firestore to cache.');
    } catch (err: unknown) {
      setStatus(err instanceof Error ? err.message : 'Lookup failed');
    } finally {
      setSaving(false);
    }
  };

  const saveGame = async () => {
    if (!gameInfo?.gameId) return;
    setSaving(true);
    setStatus(null);
    try {
      if (firebaseAvailable && user) {
        const db = getFirebaseDb();
        const ref = doc(db, 'games', gameInfo.gameId);
        await setDoc(ref, {
          ...gameInfo,
          signalToken: signalToken || '',
            notifyMode,
          inviterUid: user.uid,
          updatedAt: serverTimestamp(),
          createdAt: serverTimestamp(),
        });
        setStatus('Saved to Firestore.');
      } else {
        setStatus('Saved locally (no Firebase config).');
      }
    } catch (err: unknown) {
      setStatus(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const saveSignalToken = async () => {
    if (!gameInfo?.gameId) return;
    setSaving(true);
    setStatus(null);
    try {
      if (firebaseAvailable && user) {
        const db = getFirebaseDb();
        const ref = doc(db, 'games', gameInfo.gameId);
        await updateDoc(ref, {
          signalToken,
          updatedAt: serverTimestamp(),
        });
        setStatus('Signal token stored.');
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
      if (firebaseAvailable && user) {
        const db = getFirebaseDb();
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
        <div className="space-y-3">
          <p className="text-xs uppercase tracking-[0.2em] text-zinc-400">Com Tower</p>
          <h1 className="text-3xl font-semibold">AWBW turn notifications</h1>
          <p className="text-sm text-zinc-400">
            Patch a game, cache it in Firestore, and set your Signal DM token for turn alerts.
          </p>
        </div>

        <section className="rounded-2xl border border-zinc-800 bg-zinc-950 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-zinc-400">Auth</p>
              <p className="text-sm text-zinc-200">Inviter session</p>
            </div>
            <div className="flex items-center gap-2 text-xs text-zinc-400">
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
          </div>
          <p className="text-xs text-zinc-500">{statusLine}</p>
        </section>

        <section className="rounded-2xl border border-zinc-800 bg-zinc-950 p-4 space-y-4">
          {!gameInfo ? (
            <>
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-zinc-400">Patch game</p>
                <p className="text-lg font-semibold text-zinc-100">Lookup and save</p>
                <p className="text-sm text-zinc-400">Paste the AWBW game link. Name/map will be auto-looked up.</p>
              </div>
              <input
                value={gameLink}
                onChange={(e) => setGameLink(e.target.value)}
                className="w-full rounded-xl bg-black border border-zinc-800 px-3 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-500"
                placeholder="https://awbw.amarriner.com/game.php?games_id=123456"
              />
              <button
                onClick={lookupGame}
                disabled={saving || !gameLink.trim()}
                className="w-full sm:w-auto rounded-xl bg-white text-black font-semibold px-4 py-3 shadow disabled:opacity-50"
              >
                Lookup
              </button>
            </>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs uppercase tracking-[0.2em] text-zinc-400">Patched</p>
                  <p className="text-lg font-semibold text-zinc-100">{gameInfo.gameName}</p>
                  <p className="text-sm text-zinc-400">{gameInfo.mapName || 'Map unknown'}</p>
                </div>
                <button
                  onClick={() => {
                    setGameInfo(null);
                    setSignalToken('');
                    setNotifyMode('signal-dm');
                  }}
                  className="px-3 py-2 rounded-lg border border-zinc-700 text-zinc-300 hover:border-zinc-500"
                >
                  Disconnect
                </button>
              </div>
              <div className="flex flex-col sm:flex-row gap-2">
                <button
                  onClick={saveGame}
                  disabled={saving}
                  className="px-4 py-3 rounded-xl bg-white text-black font-semibold shadow disabled:opacity-50"
                >
                  Save to Firestore
                </button>
              </div>
            </div>
          )}
        </section>

        {gameInfo && (
          <section className="rounded-2xl border border-zinc-800 bg-zinc-950 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-zinc-400">Signal DM token</p>
                <p className="text-lg font-semibold text-zinc-100">DM auth</p>
                <p className="text-sm text-zinc-400">Store your Signal auth/token for DM notifications.</p>
              </div>
            </div>
            <input
              value={signalToken}
              onChange={(e) => setSignalToken(e.target.value)}
              className="w-full rounded-xl bg-black border border-zinc-800 px-3 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-500"
              placeholder="Signal auth token (kept server-side)"
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
          </section>
        )}

        {status && (
          <div className="text-xs text-amber-300 bg-[#1b1b26] border border-[#2a2a36] rounded-xl px-3 py-2">
            {status}
          </div>
        )}
      </main>
    </div>
  );
}
