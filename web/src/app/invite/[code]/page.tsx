'use client';

import { use, useEffect, useState } from 'react';
import { parseAndNormalizePhone } from '@/lib/phone';

const INVITE_PHONE_STORAGE_KEY = 'com-tower-invite-phone';

function getStoredInvitePhone(): string {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem(INVITE_PHONE_STORAGE_KEY) || '';
}

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
  useEffect(() => {
    setPhone(getStoredInvitePhone());
  }, []);
  const [playerName, setPlayerName] = useState('');
  const [scope, setScope] = useState<'all' | 'my-turn'>('all');
  const [notifyFrequency, setNotifyFrequency] = useState<'' | 'hourly'>('hourly');
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

  const submit = async () => {
    const candidate = phone && !phone.trim().startsWith('+') ? `+${phone.trim()}` : phone;
    const normalized = parseAndNormalizePhone(candidate);
    if (!normalized) {
      setStatus('Enter a valid Signal number with country code (e.g., +15551234567).');
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
          notifyFrequency,
          playerName: playerName || undefined,
          action,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Could not save subscription');
      }
      const data = await res.json();
      const scopeMsg =
        scope === 'my-turn'
          ? 'You will get DMs when it is your turn.'
          : 'You will get DMs on every player\'s turn.';
      const freqMsg =
        notifyFrequency === 'hourly'
          ? " You'll get a DM when the turn changes, then hourly reminders until the turn ends."
          : ' One notification per turn.';
      setStatus(
        action === 'unsubscribe'
          ? 'You have been unsubscribed.'
          : `Subscription saved. ${scopeMsg}${freqMsg}`
      );
      if (data.subscriber?.playerName) {
        setPlayerName(data.subscriber.playerName);
      }
      if (action === 'subscribe' && typeof window !== 'undefined') {
        localStorage.setItem(INVITE_PHONE_STORAGE_KEY, normalized);
      }
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

            <div className="space-y-2">
              <p className="text-xs uppercase tracking-[0.2em] text-zinc-400">When to notify</p>
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
                  <p className="text-xs text-zinc-400">Get notified for every player's turn.</p>
                </button>
                <button
                  onClick={() => setScope('my-turn')}
                  className={`rounded-xl border px-3 py-3 text-left ${
                    scope === 'my-turn'
                      ? 'bg-[#13211f] border-[#1f3c35] text-[#b5f5e4]'
                      : 'bg-black border-zinc-800 text-zinc-300'
                  }`}
                >
                  <p className="text-sm font-semibold">Only my turn</p>
                  <p className="text-xs text-zinc-400">Needs your player name above.</p>
                </button>
              </div>
            </div>

            <div className="space-y-2">
              <p className="text-xs uppercase tracking-[0.2em] text-zinc-400">How often to notify</p>
              <div className="grid sm:grid-cols-2 gap-3">
                <button
                  onClick={() => setNotifyFrequency('hourly')}
                  className={`rounded-xl border px-3 py-3 text-left ${
                    notifyFrequency === 'hourly'
                      ? 'bg-[#2d1f0f] border-[#5c3d1a] text-[#ffd4a3]'
                      : 'bg-black border-zinc-800 text-zinc-300'
                  }`}
                >
                  <p className="text-sm font-semibold">Hourly</p>
                  <p className="text-xs text-zinc-400">On turn change, then every hour until the turn ends.</p>
                </button>
                <button
                  onClick={() => setNotifyFrequency('')}
                  className={`rounded-xl border px-3 py-3 text-left ${
                    notifyFrequency === ''
                      ? 'bg-[#2d1f0f] border-[#5c3d1a] text-[#ffd4a3]'
                      : 'bg-black border-zinc-800 text-zinc-300'
                  }`}
                >
                  <p className="text-sm font-semibold">Once</p>
                  <p className="text-xs text-zinc-400">One notification per turn change only.</p>
                </button>
              </div>
            </div>

            <div className="space-y-2">
              <p className="text-xs uppercase tracking-[0.2em] text-zinc-400">Message style</p>
              <div className="grid sm:grid-cols-2 gap-3">
                <button
                  onClick={() => setFunEnabled(false)}
                  className={`rounded-xl border px-3 py-3 text-left ${
                    !funEnabled
                      ? 'bg-[#1a1b2f] border-[#2e315a] text-[#c7d0ff]'
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
                      ? 'bg-[#1a1b2f] border-[#2e315a] text-[#c7d0ff]'
                      : 'bg-black border-zinc-800 text-zinc-300'
                  }`}
                >
                  <p className="text-sm font-semibold">Fun mode</p>
                  <p className="text-xs text-zinc-400">Adds flair to messages.</p>
                </button>
              </div>
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

