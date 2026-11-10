import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
// The leaf modules, as .ts: tests run the sources directly (index.ts imports siblings as .js).
import { messagingPlatform, platformOf } from './backend.ts';
import { groupRecipient, SignalCliRestBackend } from './signal-cli-rest.ts';

test('games bound before platforms were recorded are Signal games', () => {
  assert.equal(platformOf(undefined), 'signal');
  assert.equal(platformOf({}), 'signal');
  assert.equal(platformOf({ platform: 'other' }), 'other');
});

test('platform comes from MESSAGING_PLATFORM, default signal', () => {
  assert.equal(messagingPlatform({}), 'signal');
  assert.equal(messagingPlatform({ MESSAGING_PLATFORM: ' Other ' }), 'other');
});

test('group ids become signal-cli group recipients', () => {
  assert.equal(groupRecipient('group.abc'), 'group.abc');
  assert.equal(groupRecipient('abc'), `group.${Buffer.from('abc').toString('base64')}`);
});

/** A fake bridge that records requests and answers each with `answer`. */
async function fakeBridge(answer: (req: { method: string; url: string; body: any }) => any) {
  const seen: Array<{ method: string; url: string; body: any; auth?: string }> = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined;
      seen.push({ method: req.method!, url: req.url!, body, auth: req.headers.authorization });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(answer({ method: req.method!, url: req.url!, body })));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, seen, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test('sends to groups and people, with a bearer token, and returns the timestamp', async () => {
  const bridge = await fakeBridge(() => ({ timestamp: '1700000000123' }));
  try {
    const b = new SignalCliRestBackend({ platform: 'p', url: bridge.url, botId: '+15550001', token: 'tok' });
    const ts = await b.sendToGroup('abc', {
      message: 'hi @x',
      mentions: [{ author: 'u1', start: 3, length: 2 }],
      attachment: { dataB64: 'AAAA', contentType: 'image/png', filename: 'a.png' },
    });
    assert.equal(ts, 1700000000123);
    await b.sendToPerson('15550002', { message: 'dm' });

    const [g, d] = bridge.seen;
    assert.equal(g.method, 'POST');
    assert.equal(g.url, '/v2/send');
    assert.equal(g.auth, 'Bearer tok');
    assert.deepEqual(g.body.recipients, [groupRecipient('abc')]);
    assert.equal(g.body.number, '+15550001');
    assert.deepEqual(g.body.mentions, [{ author: 'u1', start: 3, length: 2 }]);
    assert.deepEqual(g.body.base64_attachments, ['data:image/png;filename=a.png;base64,AAAA']);
    assert.deepEqual(d.body.recipients, ['+15550002']);
    assert.equal(d.body.mentions, undefined);
  } finally {
    await bridge.close();
  }
});

test('a send without a usable timestamp resolves undefined', async () => {
  const bridge = await fakeBridge(() => ({}));
  try {
    const b = new SignalCliRestBackend({ platform: 'p', url: bridge.url, botId: '+1' });
    assert.equal(await b.sendToPerson('+2', { message: 'x' }), undefined);
    assert.equal(bridge.seen[0].auth, undefined);
  } finally {
    await bridge.close();
  }
});

test('lists groups with an id send accepts', async () => {
  const bridge = await fakeBridge(() => [{ name: 'A', id: 'group.x' }, { name: 'B', internal_id: 'y' }]);
  try {
    const b = new SignalCliRestBackend({ platform: 'p', url: bridge.url, botId: '+1' });
    const groups = await b.listGroups();
    assert.deepEqual(groups.map((g) => g.id), ['group.x', 'group.y']);
    assert.equal(bridge.seen[0].url, `/v1/groups/${encodeURIComponent('+1')}`);
  } finally {
    await bridge.close();
  }
});

test('poll receive delivers queued items, then stops', async () => {
  let served = false;
  const bridge = await fakeBridge(() => {
    if (served) return [];
    served = true;
    return [{ envelope: { sourceUuid: 'u', dataMessage: { message: '/help' } }, account: '+1' }];
  });
  try {
    const b = new SignalCliRestBackend({ platform: 'p', url: bridge.url, botId: '+1' });
    const got: any[] = [];
    await b.startReceiving(async (item) => { got.push(item); });
    assert.equal(got.length, 1);
    assert.equal(got[0].envelope.dataMessage.message, '/help');
    assert.equal(b.receiverDiagnostics().mode, 'poll');
    b.stopReceiving();
    assert.equal(b.receiverDiagnostics().mode, 'off');
  } finally {
    await bridge.close();
  }
});
