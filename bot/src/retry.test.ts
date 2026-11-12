import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SendRetries, sendRetryDelay, SEND_RETRY_DELAYS_MS } from './retry.ts';

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
