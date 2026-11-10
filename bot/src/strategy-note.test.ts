import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchStrategyNote, strategyNoteConfig } from './strategy-note.ts';

const ok = (body: unknown, status = 200) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

test('off without a URL', async () => {
  assert.equal(strategyNoteConfig({}), null);
  assert.equal(await fetchStrategyNote(1, 'x', null), null);
});

test('returns the note and sends the token', async () => {
  let seen: RequestInit | undefined;
  const f = (async (_u: string, init: RequestInit) => { seen = init; return new Response(JSON.stringify({ text: ' Hold the bridge. ', send: true })); }) as unknown as typeof fetch;
  const n = await fetchStrategyNote(42, 'p', { url: 'http://x/note', token: 't' }, f);
  assert.deepEqual(n, { text: 'Hold the bridge.', send: true, why: undefined });
  assert.equal((seen!.headers as Record<string, string>).Authorization, 'Bearer t');
  assert.deepEqual(JSON.parse(seen!.body as string), { gameId: 42, playerName: 'p', audience: 'all' });
});

test('falls back on errors and empty text', async () => {
  const cfg = { url: 'http://x/note' };
  assert.equal(await fetchStrategyNote(1, 'p', cfg, ok({ error: 'x' }, 500)), null);
  assert.equal(await fetchStrategyNote(1, 'p', cfg, ok({ text: '  ' })), null);
  const boom = (async () => { throw new Error('down'); }) as unknown as typeof fetch;
  assert.equal(await fetchStrategyNote(1, 'p', cfg, boom), null);
});

test('with the chat\'s members the service picks the audience', async () => {
  let seen: RequestInit | undefined;
  const f = (async (_u: string, init: RequestInit) => { seen = init; return new Response(JSON.stringify({ text: 'Push the left.' })); }) as unknown as typeof fetch;
  await fetchStrategyNote(7, { playerName: 'p', members: ['p', 'q'] }, { url: 'http://x/note' }, f);
  assert.deepEqual(JSON.parse(seen!.body as string), { gameId: 7, playerName: 'p', audience: 'auto', members: ['p', 'q'] });
  await fetchStrategyNote(7, { playerName: 'p', members: [] }, { url: 'http://x/note' }, f);
  assert.equal(JSON.parse(seen!.body as string).audience, 'all');
});
