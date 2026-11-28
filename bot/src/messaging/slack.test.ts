import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSlackText,
  renderSlack,
  SlackBackend,
  type SlackClient,
  type SlackCommandPayload,
  type SlackMentionEvent,
  type SlackReceiver,
  type SlackRespond,
} from './slack.ts';

/** A Web API client that records each call. `fail` makes a method throw a Slack error once. */
function fakeClient(opts: { member?: boolean; isPrivate?: boolean; fail?: Record<string, string> } = {}) {
  const calls: Array<{ method: string; args: any }> = [];
  const fail = { ...(opts.fail || {}) };
  const maybeFail = (method: string) => {
    if (fail[method]) {
      const e = Object.assign(new Error(`An API error occurred: ${fail[method]}`), { data: { error: fail[method] } });
      delete fail[method];
      throw e;
    }
  };
  const client: SlackClient = {
    chat: { async postMessage(args) { calls.push({ method: 'chat.postMessage', args }); maybeFail('chat.postMessage'); return { ts: '1700000000.123456' }; } },
    files: { async uploadV2(args) { calls.push({ method: 'files.uploadV2', args }); maybeFail('files.uploadV2'); return {}; } },
    conversations: {
      async join(args) { calls.push({ method: 'conversations.join', args }); maybeFail('conversations.join'); return {}; },
      async info(args) { calls.push({ method: 'conversations.info', args }); return { channel: { is_member: !!opts.member, is_private: !!opts.isPrivate } }; },
      async open(args) { calls.push({ method: 'conversations.open', args }); return { channel: { id: 'D99' } }; },
    },
    auth: { async test() { return { user_id: 'UBOT', team_id: 'T1' }; } },
  };
  return { client, calls };
}

function fakeReceiver() {
  let on: Parameters<SlackReceiver['start']>[0] | undefined;
  let name = '';
  const r: SlackReceiver = {
    async start(handlers, commandName) { on = handlers; name = commandName; },
    stop() { on = undefined; },
    connected: () => !!on,
  };
  return {
    r,
    commandName: () => name,
    command: (p: Partial<SlackCommandPayload>, respond?: SlackRespond) =>
      on!.command({ team_id: 'T1', channel_id: 'C1', user_id: 'U1', user_name: 'ann', text: '', ...p }, respond ?? (async () => undefined)),
    mention: (e: Partial<SlackMentionEvent>) => on!.mention({ team: 'T1', channel: 'C1', user: 'U1', text: '', ts: '1700000000.5', ...e }),
  };
}

test('Slack text: the first word becomes a command, mentions and links are unwrapped', () => {
  assert.deepEqual(parseSlackText('', 'T1'), { text: '/help', mentions: [] });
  assert.equal(parseSlackText('game <https://awbw.amarriner.com/game.php?games_id=1&amp;x=2>', 'T1').text,
    '/game https://awbw.amarriner.com/game.php?games_id=1&x=2');
  assert.equal(parseSlackText('/game 123', 'T1').text, '/game 123');
  const r = parseSlackText('<@UBOT> setplayer <@U2|bob> bob_aw', 'T1', 'UBOT');
  assert.equal(r.text, '/setplayer @bob bob_aw');
  assert.deepEqual(r.mentions, [{ uuid: 'slack:T1:U2', number: null, name: 'bob', start: 11, length: 4 }]);
  assert.equal(r.text.slice(11, 15), '@bob');
  assert.equal(parseSlackText('addmod <@U3>', 'T1').text, '/addmod @U3');
  assert.equal(parseSlackText('stats in <#C5|general>', 'T1').text, '/stats in #general');
});

test('outgoing text is escaped and mentions become <@U…>', () => {
  const msg = 'Day 2 <Red> & co, you\'re up @';
  assert.equal(renderSlack({ message: msg, mentions: [{ author: 'slack:T1:U2', start: msg.length - 1, length: 1 }] }),
    'Day 2 &lt;Red&gt; &amp; co, you\'re up <@U2>');
  // A mention that isn't a Slack user is dropped.
  assert.equal(renderSlack({ message: 'hi @', mentions: [{ author: 'discord:1', start: 3, length: 1 }] }), 'hi ');
});

test('a turn ping posts the text; one with a video uploads it with the text as its comment', async () => {
  const { client, calls } = fakeClient();
  const b = new SlackBackend({ platform: 'slack', client });
  const ts = await b.sendToGroup('slack:T1:C1', { message: 'go @', mentions: [{ author: 'slack:T1:U2', start: 3, length: 1 }] });
  assert.equal(ts, 1700000000123);
  assert.deepEqual(calls[0], { method: 'chat.postMessage', args: { channel: 'C1', text: 'go <@U2>', unfurl_links: false, unfurl_media: false } });
  await b.sendToGroup('slack:T1:C1', { message: 'https://x', attachment: { dataB64: Buffer.from('mp4').toString('base64'), contentType: 'video/mp4', filename: 'r.mp4' } });
  const up = calls[1];
  assert.equal(up.method, 'files.uploadV2');
  assert.equal(up.args.channel_id, 'C1');
  assert.equal(up.args.initial_comment, 'https://x');
  assert.equal(up.args.filename, 'r.mp4');
  assert.equal(up.args.file.toString(), 'mp4');
});

test('a public channel the app isn\'t in is joined, then the send is tried again', async () => {
  const { client, calls } = fakeClient({ fail: { 'chat.postMessage': 'not_in_channel' } });
  const b = new SlackBackend({ platform: 'slack', client });
  await b.sendToGroup('slack:T1:C1', { message: 'x' });
  assert.deepEqual(calls.map((c) => c.method), ['chat.postMessage', 'conversations.join', 'chat.postMessage']);
});

test('a DM opens the app\'s conversation with the person', async () => {
  const { client, calls } = fakeClient();
  const b = new SlackBackend({ platform: 'slack', client });
  await b.sendToPerson('slack:T1:U1', { message: 'hi' });
  assert.deepEqual(calls[0], { method: 'conversations.open', args: { users: 'U1' } });
  assert.equal(calls[1].args.channel, 'D99');
});

test('the slash command and mentions reach the bot as namespaced group commands', async () => {
  const { client, calls } = fakeClient();
  const rx = fakeReceiver();
  const b = new SlackBackend({ platform: 'slack', client, receiver: () => rx.r, command: 'awbw' });
  const items: any[] = [];
  await b.startReceiving(async (item) => {
    items.push(item);
    await b.sendToGroup(item.envelope.dataMessage.groupInfo?.groupId ?? 'x', { message: 'ok' });
  });
  assert.equal(rx.commandName(), '/awbw');
  assert.equal(b.botId, 'UBOT');
  assert.equal(b.receiverDiagnostics().mode, 'slack-socket');

  await rx.command({ text: 'iam ann_aw' });
  const env = items[0].envelope;
  assert.equal(env.sourceUuid, 'slack:T1:U1');
  assert.equal(env.sourceName, 'ann');
  assert.equal(env.dataMessage.message, '/iam ann_aw');
  assert.deepEqual(env.dataMessage.groupInfo, { groupId: 'slack:T1:C1' });
  assert.equal(calls[0].args.text, 'ok', 'no help note on a real command');

  await rx.mention({ text: '<@UBOT> /status' });
  assert.equal(items[1].envelope.dataMessage.message, '/status');
  assert.equal(items[1].envelope.timestamp, 1700000000500);
  // The app's own posts and bot posts are ignored.
  await rx.mention({ text: '<@UBOT> hi', bot_id: 'B1' });
  assert.equal(items.length, 2);
});

test('help says how to type commands on Slack; a DM slash command has no group', async () => {
  const { client, calls } = fakeClient();
  const rx = fakeReceiver();
  const b = new SlackBackend({ platform: 'slack', client, receiver: () => rx.r });
  const items: any[] = [];
  await b.startReceiving(async (item) => {
    items.push(item);
    const g = item.envelope.dataMessage.groupInfo?.groupId;
    if (g) await b.sendToGroup(g, { message: 'HELP' });
    else await b.sendToPerson(item.envelope.sourceUuid, { message: 'DM HELP' });
  });
  await rx.command({ text: '' });
  assert.equal(items[0].envelope.dataMessage.message, '/help');
  assert.match(calls[0].args.text, /^HELP\n\nOn Slack, type these after \/comtower \(\/comtower game &lt;link&gt;\)/);
  await rx.command({ channel_id: 'D5', text: 'stats 123' });
  assert.equal(items[1].envelope.dataMessage.groupInfo, undefined);
  assert.equal(calls.at(-1)!.args.channel, 'D99');
});

test('a private channel the app can\'t post in gets the answer through response_url', async () => {
  const { client, calls } = fakeClient({ fail: { 'chat.postMessage': 'channel_not_found' } });
  const rx = fakeReceiver();
  const b = new SlackBackend({ platform: 'slack', client, receiver: () => rx.r });
  await b.startReceiving(async (item) => { await b.sendToGroup(item.envelope.dataMessage.groupInfo.groupId, { message: 'Watching game 1.' }); });
  const responded: any[] = [];
  await rx.command({ text: 'game 1' }, async (m) => { responded.push(m); });
  assert.equal(calls.length, 1);
  assert.equal(responded[0].response_type, 'in_channel');
  assert.match(responded[0].text, /^Watching game 1\.\n_\(invite Com Tower to this channel/);
});

test('outside a command, a failed send goes to the caller (the bot\'s retries)', async () => {
  const { client } = fakeClient({ fail: { 'chat.postMessage': 'channel_not_found' } });
  const b = new SlackBackend({ platform: 'slack', client });
  await assert.rejects(b.sendToGroup('slack:T1:C1', { message: 'x' }), /channel_not_found/);
});

test('postsUnprompted: a member may; a public channel is joined; a private one needs an invite', async () => {
  assert.equal(await new SlackBackend({ platform: 's', client: fakeClient({ member: true }).client }).postsUnprompted('slack:T1:C1'), true);
  const pub = fakeClient();
  assert.equal(await new SlackBackend({ platform: 's', client: pub.client }).postsUnprompted('slack:T1:C1'), true);
  assert.deepEqual(pub.calls.map((c) => c.method), ['conversations.info', 'conversations.join']);
  assert.equal(await new SlackBackend({ platform: 's', client: fakeClient({ isPrivate: true }).client }).postsUnprompted('slack:T1:G1'), false);
});
