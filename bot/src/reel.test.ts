import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchReel, reelConfig } from './reel.ts';

test('off without a URL', async () => {
  assert.equal(reelConfig({}), null);
  assert.equal(await fetchReel(1, {}, null), null);
});

test('returns the GIF and sends the token, day and player count', async () => {
  let seen: RequestInit | undefined;
  const f = (async (_u: string, init: RequestInit) => { seen = init; return new Response(JSON.stringify({ gif: 'R0lG', filename: 'day3.gif' })); }) as unknown as typeof fetch;
  const r = await fetchReel(42, { day: 3, players: 2 }, { url: 'http://x/reel', token: 't' }, f);
  assert.deepEqual(r, { dataB64: 'R0lG', contentType: 'image/gif', filename: 'day3.gif' });
  assert.equal((seen!.headers as Record<string, string>).Authorization, 'Bearer t');
  assert.deepEqual(JSON.parse(seen!.body as string), { gameId: 42, day: 3, players: 2 });
});

test('falls back on errors, a missing gif and exceptions', async () => {
  const cfg = { url: 'http://x/reel' };
  const ok = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  assert.equal(await fetchReel(1, {}, cfg, ok({}, 500)), null);
  assert.equal(await fetchReel(1, {}, cfg, ok({ error: 'no finished turn found' })), null);
  assert.equal(await fetchReel(1, {}, cfg, (async () => { throw new Error('down'); }) as unknown as typeof fetch), null);
});
