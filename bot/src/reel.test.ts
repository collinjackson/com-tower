import { test } from 'node:test';
import assert from 'node:assert/strict';
import { failWhale, fetchReel, reelConfig } from './reel.ts';

test('off without a URL', async () => {
  assert.equal(reelConfig({}), null);
  assert.equal(await fetchReel(1, {}, null), null);
});

test('returns the GIF and sends the token, day and player count', async () => {
  let seen: RequestInit | undefined;
  const f = (async (u: string, init: RequestInit) => {
    if (String(u).includes('metadata.google.internal')) throw new Error('not on GCP');
    seen = init; return new Response(JSON.stringify({ gif: 'R0lG', filename: 'day3.gif' }));
  }) as unknown as typeof fetch;
  const r = await fetchReel(42, { day: 3, players: 2 }, { url: 'http://x/reel', token: 't' }, f);
  assert.deepEqual(r, { dataB64: 'R0lG', contentType: 'image/gif', filename: 'day3.gif' });
  assert.equal((seen!.headers as Record<string, string>).Authorization, 'Bearer t');
  assert.equal((seen!.headers as Record<string, string>)['X-Reel-Token'], 't');
  assert.deepEqual(JSON.parse(seen!.body as string), { gameId: 42, day: 3, players: 2 });
});

test('falls back on errors, a missing gif and exceptions', async () => {
  const cfg = { url: 'http://x/reel' };
  const ok = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  assert.equal(await fetchReel(1, {}, cfg, ok({}, 500)), null);
  assert.equal(await fetchReel(1, {}, cfg, ok({ error: 'no finished turn found' })), null);
  assert.equal(await fetchReel(1, {}, cfg, (async () => { throw new Error('down'); }) as unknown as typeof fetch), null);
});

test('on Cloud Run: identity token for the service origin, own token alongside', async () => {
  const seen: Record<string, RequestInit> = {};
  const f = (async (u: string, init: RequestInit) => {
    seen[String(u)] = init;
    if (String(u).includes('metadata.google.internal')) return new Response('ID.TOKEN');
    return new Response(JSON.stringify({ gif: 'R0lG' }));
  }) as unknown as typeof fetch;
  await fetchReel(7, {}, { url: 'https://reel.example.run.app/reel', token: 't' }, f);
  const meta = Object.keys(seen).find((u) => u.includes('metadata'))!;
  assert.ok(meta.endsWith(`audience=${encodeURIComponent('https://reel.example.run.app')}`));
  const h = seen['https://reel.example.run.app/reel'].headers as Record<string, string>;
  assert.equal(h.Authorization, 'Bearer ID.TOKEN');
  assert.equal(h['X-Reel-Token'], 't');
});

test('waits up to REEL_TIMEOUT_MS, 100 s by default', () => {
  assert.equal(reelConfig({ REEL_URL: 'https://r.example/reel' })?.timeoutMs, 100_000);
  assert.equal(reelConfig({ REEL_URL: 'https://r.example/reel', REEL_TIMEOUT_MS: '45000' })?.timeoutMs, 45_000);
  assert.equal(reelConfig({ REEL_URL: 'https://r.example/reel', REEL_TIMEOUT_MS: 'soon' })?.timeoutMs, 100_000);
});

test('failWhale quotes Cypher and ends with the link', () => {
  const t = failWhale('https://awbw.amarriner.com/game.php?games_id=1');
  assert.match(t, /too much information to decode the Matrix/);
  assert.ok(t.endsWith('https://awbw.amarriner.com/game.php?games_id=1'));
});
