'use client';

import { use, useEffect, useState } from 'react';

type InviteInfo = {
  patchId: string;
  gameId: string;
  gameName: string;
  mapName: string;
  players: string[];
  countries: string[];
};

export default function InvitePage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = use(params);
  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<string | null>(null);
  const [phone, setPhone] = useState('');
  const [playerName, setPlayerName] = useState('');
  const [scope, setScope] = useState<'all' | 'my-turn'>('all');
  const [funEnabled, setFunEnabled] = useState(false);
  const [action, setAction] = useState<'subscribe' | 'unsubscribe'>('subscribe');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/invite/${code}`);
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || 'Invite not found');
        }
        const data = await res.json();
        setInfo({
          patchId: data.patchId,
          gameId: data.gameId,
          gameName: data.gameName,
          mapName: data.mapName,
          players: data.players || [],
          countries: data.countries || [],
        });

        // Refresh players list from scraper if empty
        if (data.gameId && (!data.players || data.players.length === 0)) {
          try {
            const playersRes = await fetch(`/api/game/${data.gameId}/players`);
            if (playersRes.ok) {
              const playersData = await playersRes.json();
              setInfo((prev) =>
                prev
                  ? {
                      ...prev,
                      players: playersData.players || prev.players,
                      countries: playersData.countries || prev.countries,
                    }
                  : prev
              );
            }
          } catch {
            // ignore player refresh errors
          }
        }
      } catch (err: any) {
        setStatus(err?.message || 'Failed to load invite');
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [code]);

  const normalizePhone = (value: string) => {
    const digits = value.trim();
    if (!digits) return '';
    return digits.startsWith('+') ? digits : `+${digits}`;
  };

  const isValidPhone = (value: string) => /^\+[0-9]{7,15}$/.test(value);

  const submit = async () => {
    const normalized = normalizePhone(phone);
    if (!normalized) {
      setStatus('Enter your phone number first.');
      return;
    }
    if (!isValidPhone(normalized)) {
      setStatus('Enter a valid phone number with country code (e.g., +15551234567).');
      return;
    }
    setPhone(normalized);
    setSending(true);
    setStatus(null);
    try {
      const res = await fetch(`/api/invite/${code}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone: normalized,
          funEnabled,
          scope,
          playerName: playerName || undefined,
          action,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Could not save subscription');
      }
      const data = await res.json();
      setStatus(
        action === 'unsubscribe'
          ? 'You have been unsubscribed.'
          : 'Subscription saved. You will get DMs when it is your turn.'
      );
      if (data.subscriber?.playerName) {
        setPlayerName(data.subscriber.playerName);
      }
      setPhone('');
    } catch (err: any) {
      setStatus(err?.message || 'Could not save subscription');
    } finally {
      setSending(false);
    }
  };

  return (
    <main className="min-h-screen bg-black text-zinc-100 flex items-center justify-center px-6 py-12">
      <div className="w-full max-w-2xl space-y-6">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-zinc-400">Com Tower</p>
          <h1 className="text-3xl font-semibold">Game invite</h1>
          <p className="text-sm text-zinc-400">
            Subscribe to turn DMs with your Signal number. No login needed.
          </p>
        </div>

        {loading && <p className="text-sm text-zinc-400">Loading invite…</p>}
        {!loading && !info && (
          <p className="text-sm text-red-400">Invite not found or expired.</p>
        )}

        {info && (
          <section className="space-y-4 rounded-2xl border border-zinc-800 bg-zinc-950 p-4">
            <div className="space-y-1">
              <p className="text-xs uppercase tracking-[0.2em] text-zinc-400">Game</p>
              <p className="text-lg font-semibold text-zinc-100">{info.gameName}</p>
              <p className="text-sm text-zinc-400">{info.mapName || 'Map unknown'}</p>
            </div>

            <div className="space-y-2">
              <label className="text-xs uppercase tracking-[0.2em] text-zinc-400">
                Signal phone number
              </label>
              <input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className="w-full rounded-xl bg-black border border-zinc-800 px-3 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-500"
                placeholder="+15551234567"
              />
              <p className="text-[11px] text-zinc-500">
                We’ll add the + automatically. Must be digits with country code. DMs only.
              </p>
            </div>

            {status && (
              <p className="text-sm text-zinc-300 bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2">
                {status}
              </p>
            )}

            <div className="space-y-2">
              <label className="text-xs uppercase tracking-[0.2em] text-zinc-400">
                Player name (optional)
              </label>
              <select
                value={playerName}
                onChange={(e) => setPlayerName(e.target.value)}
                className="w-full rounded-xl bg-black border border-zinc-800 px-3 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-500"
              >
                <option value="">All players</option>
                {info.players.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
              <p className="text-[11px] text-zinc-500">
                Pick your AWBW username to only alert on your turns.
              </p>
            </div>

            <div className="grid sm:grid-cols-2 gap-3">
              <button
                onClick={() => setScope('all')}
                className={`rounded-xl border px-3 py-3 text-left ${
                  scope === 'all'
                    ? 'bg-[#13211f] border-[#1f3c35] text-[#b5f5e4]'
                    : 'bg-black border-zinc-800 text-zinc-300'
                }`}
              >
                <p className="text-sm font-semibold">All turns</p>
                <p className="text-xs text-zinc-400">Get notified for every turn.</p>
              </button>
              <button
                onClick={() => setScope('my-turn')}
                className={`rounded-xl border px-3 py-3 text-left ${
                  scope === 'my-turn'
                    ? 'bg-[#1a1b2f] border-[#2e315a] text-[#c7d0ff]'
                    : 'bg-black border-zinc-800 text-zinc-300'
                }`}
              >
                <p className="text-sm font-semibold">Only my turn</p>
                <p className="text-xs text-zinc-400">Needs your player name above.</p>
              </button>
            </div>

            <div className="grid sm:grid-cols-2 gap-3">
              <button
                onClick={() => setFunEnabled(false)}
                className={`rounded-xl border px-3 py-3 text-left ${
                  !funEnabled
                    ? 'bg-[#0f1823] border-[#1f3048] text-[#c7e6ff]'
                    : 'bg-black border-zinc-800 text-zinc-300'
                }`}
              >
                <p className="text-sm font-semibold">Classic mode</p>
                <p className="text-xs text-zinc-400">Straightforward alerts.</p>
              </button>
              <button
                onClick={() => setFunEnabled(true)}
                className={`rounded-xl border px-3 py-3 text-left ${
                  funEnabled
                    ? 'bg-[#23150f] border-[#3d2217] text-[#ffd8c7]'
                    : 'bg-black border-zinc-800 text-zinc-300'
                }`}
              >
                <p className="text-sm font-semibold">Fun mode</p>
                <p className="text-xs text-zinc-400">Adds flair to messages.</p>
              </button>
            </div>

            <div className="flex gap-2">
              <label className="flex items-center gap-2 text-sm text-zinc-300">
                <input
                  type="radio"
                  checked={action === 'subscribe'}
                  onChange={() => setAction('subscribe')}
                />
                Subscribe / update
              </label>
              <label className="flex items-center gap-2 text-sm text-zinc-300">
                <input
                  type="radio"
                  checked={action === 'unsubscribe'}
                  onChange={() => setAction('unsubscribe')}
                />
                Unsubscribe
              </label>
            </div>

            <div className="flex flex-col sm:flex-row gap-2">
              <button
                onClick={submit}
                disabled={sending}
                className="flex-1 rounded-xl bg-white text-black font-semibold px-4 py-3 shadow disabled:opacity-50"
              >
                Subscribe
              </button>
            </div>
          </section>
        )}
      </div>
    </main>
  );
}

