import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SendRetries, sameTurn, sendRetryDelay, SEND_RETRY_DELAYS_MS } from './retry.ts';

test('delays: 2, 5, 15, 30 minutes, then none', () => {
  assert.deepEqual(SEND_RETRY_DELAYS_MS.map((d) => d / 60000), [2, 5, 15, 30]);
  assert.equal(sendRetryDelay(0), 120000);
  assert.equal(sendRetryDelay(4), null);
});

test('one timer a group, attempts until the retries run out, reset on success', async () => {
  const fired: string[] = [];
  const pending: Array<() => void> = [];
  const r = new SendRetries(async (k) => { fired.push(k); }, [10, 20], (fn) => { pending.push(fn); return 0 as unknown as ReturnType<typeof setTimeout>; });
  assert.equal(r.failed('g'), 10);
  assert.equal(r.failed('g'), null);            // a retry is already pending
  pending.shift()!();                           // the timer fires
  await Promise.resolve();
  assert.deepEqual(fired, ['g']);
  assert.equal(r.failed('g'), 20);              // second retry
  pending.shift()!();
  assert.equal(r.failed('g'), null);            // used up: back to the hourly poll
  assert.equal(r.failed('g'), 10);              // a later failure starts over
  r.succeeded('g');
  assert.equal(r.failed('g'), 10);
});

test('sameTurn: player and day must both match', () => {
  const last = { day: 9, awbwUsername: 'p1' };
  assert.equal(sameTurn(last, 'p1', 9), true);
  assert.equal(sameTurn(last, 'P1', 9), true);
  // The other player's turn was missed: the same name a day later is a new turn.
  assert.equal(sameTurn(last, 'p1', 10), false);
  assert.equal(sameTurn(last, 'p2', 9), false);
  // No day on either side: the name decides.
  assert.equal(sameTurn({ awbwUsername: 'p1' }, 'p1', 10), true);
  assert.equal(sameTurn(last, 'p1', undefined), true);
  // Never pinged, or the last ping didn't name a player.
  assert.equal(sameTurn(undefined, 'p1', 9), false);
  assert.equal(sameTurn({ day: 9, awbwUsername: null }, 'p1', 9), false);
});
