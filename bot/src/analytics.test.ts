import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyticsConfig, anonId, commandName, track } from './analytics.ts';

test('off without a key', async () => {
  assert.equal(analyticsConfig({}), null);
  let called = false;
  await track('x', { group: 'g' }, {}, null, (async () => { called = true; return new Response(''); }) as unknown as typeof fetch);
  assert.equal(called, false);
});

test('sends a hashed group id, never the raw one, to PostHog', async () => {
  let url = '', body: any;
  const f = (async (u: string, init: RequestInit) => { url = String(u); body = JSON.parse(init.body as string); return new Response('{}'); }) as unknown as typeof fetch;
  const cfg = analyticsConfig({ POSTHOG_KEY: 'phc_test' })!;
  await track('command', { group: 'group-id-secret==' }, { command: '/reel' }, cfg, f);
  assert.equal(url, 'https://us.i.posthog.com/i/v0/e/');
  assert.equal(body.api_key, 'phc_test');
  assert.equal(body.event, 'command');
  assert.match(body.distinct_id, /^group_[0-9a-f]{16}$/);
  assert.equal(body.distinct_id, anonId('group', 'group-id-secret==', 'phc_test'));
  assert.ok(!JSON.stringify(body).includes('group-id-secret'));
  assert.equal(body.properties.command, '/reel');
});

test('unknown commands are reported as other, and failures never throw', async () => {
  assert.equal(commandName('/recap'), '/recap');
  assert.equal(commandName('/my secret message'), 'other');
  const cfg = analyticsConfig({ POSTHOG_KEY: 'k', POSTHOG_HOST: 'https://eu.i.posthog.com/' })!;
  assert.equal(cfg.host, 'https://eu.i.posthog.com');
  await track('x', { game: 1 }, {}, cfg, (async () => { throw new Error('down'); }) as unknown as typeof fetch);
});
