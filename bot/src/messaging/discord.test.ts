import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  commandText,
  DISCORD_COMMANDS,
  discordCommandBodies,
  DiscordBackend,
  renderDiscord,
  type DiscordCommandInteraction,
  type DiscordGateway,
  type DiscordReply,
  type DiscordRest,
} from './discord.ts';

/** A REST client that records each call and answers from `answer`. */
function fakeRest(answer: (route: string, opts: any) => unknown = () => ({ id: 'm1', timestamp: '2026-11-27T12:00:00.000Z' })) {
  const calls: Array<{ method: string; route: string; opts: any }> = [];
  const rest: DiscordRest = {
    async post(route, opts) { calls.push({ method: 'POST', route, opts }); return answer(route, opts); },
    async put(route, opts) { calls.push({ method: 'PUT', route, opts }); return []; },
  };
  return { rest, calls };
}

/** A slash command interaction that records its replies. */
function fakeInteraction(over: Partial<DiscordCommandInteraction> = {}) {
  const log: Array<{ kind: string; reply?: DiscordReply }> = [];
  const i: DiscordCommandInteraction = {
    commandName: 'ping',
    channelId: '111',
    guildId: '999',
    createdTimestamp: 1_700_000_000_000,
    user: { id: '42', username: 'ann', globalName: 'Ann' },
    member: { displayName: 'Ann the Mod' },
    options: { data: [] },
    async deferReply() { log.push({ kind: 'defer' }); },
    async editReply(reply) { log.push({ kind: 'edit', reply }); },
    async followUp(reply) { log.push({ kind: 'followUp', reply }); },
    async deleteReply() { log.push({ kind: 'delete' }); },
    ...over,
  };
  return { i, log };
}

function fakeGateway() {
  let handler: ((i: DiscordCommandInteraction) => Promise<void>) | undefined;
  let stopped = false;
  const g: DiscordGateway = {
    async start(on) { handler = on; },
    stop() { stopped = true; },
    connected: () => !!handler && !stopped,
    canPost: (id) => (id === '111' ? true : id === '222' ? false : undefined),
  };
  return { g, fire: (i: DiscordCommandInteraction) => handler!(i), isStopped: () => stopped };
}

test('every command registers with valid names, and DM-capable ones say so', () => {
  const bodies = discordCommandBodies() as any[];
  assert.equal(bodies.length, DISCORD_COMMANDS.length);
  for (const b of bodies) {
    assert.match(b.name, /^[a-z_]{1,32}$/);
    assert.ok(b.description.length >= 1 && b.description.length <= 100, b.name);
    for (const o of b.options) assert.match(o.name, /^[a-z_]{1,32}$/);
    // Required options first, as Discord demands.
    const req = b.options.map((o: any) => o.required);
    assert.deepEqual(req, [...req].sort((x: boolean, y: boolean) => Number(y) - Number(x)), b.name);
  }
  const names = bodies.map((b) => b.name);
  for (const c of ['game', 'iam', 'setplayer', 'players', 'remind', 'stats', 'status', 'sync', 'reel', 'recap', 'stop', 'help']) assert.ok(names.includes(c), c);
  assert.deepEqual(bodies.find((b) => b.name === 'stats').contexts, [0, 1]);
  assert.deepEqual(bodies.find((b) => b.name === 'game').contexts, [0]);
  assert.equal(bodies.find((b) => b.name === 'setplayer').options[0].type, 6);
});

test('a slash command reads as the text command, with user options as mentions', () => {
  const { i } = fakeInteraction({
    commandName: 'setplayer',
    options: { data: [{ name: 'member', type: 6, user: { id: '77', username: 'bob', globalName: 'Bob' } }, { name: 'awbw_name', type: 3, value: ' bob_aw ' }] },
  });
  const { text, mentions } = commandText(i);
  assert.equal(text, '/setplayer @Bob bob_aw');
  assert.deepEqual(mentions, [{ uuid: 'discord:77', number: null, name: 'Bob', start: 11, length: 4 }]);
  assert.equal(text.slice(mentions[0].start, mentions[0].start + mentions[0].length), '@Bob');

  // Flags become their word; a DM-only option is dropped in a server, kept in a DM.
  const stats = (guildId: string | null) => commandText(fakeInteraction({
    commandName: 'stats', guildId,
    options: { data: [{ name: 'log', type: 5, value: true }, { name: 'metric', type: 3, value: 'funds' }, { name: 'game', type: 3, value: '123' }] },
  }).i).text;
  assert.equal(stats('999'), '/stats funds log');
  assert.equal(stats(null), '/stats 123 funds log');
  assert.equal(commandText(fakeInteraction({ commandName: 'recap', options: { data: [{ name: 'fresh', type: 5, value: false }] } }).i).text, '/recap');
});

test('mentions become <@id> and only those people may be pinged', () => {
  const out = renderDiscord({ message: 'Day 3. @everyone your move @', mentions: [{ author: 'discord:42', start: 27, length: 1 }] });
  assert.equal(out.content, 'Day 3. @everyone your move <@42>');
  assert.deepEqual(out.users, ['42']);
  // Someone who isn't a Discord user (a stray id) is dropped, placeholder and all.
  assert.equal(renderDiscord({ message: 'hi @', mentions: [{ author: 'not-a-snowflake', start: 3, length: 1 }] }).content, 'hi ');
});

test('an attachment over the upload limit is left off with a note; one under it goes as a file', () => {
  const small = { dataB64: Buffer.alloc(10).toString('base64'), contentType: 'video/mp4', filename: 'r.mp4' };
  const big = { dataB64: Buffer.alloc(3 * 1024 * 1024).toString('base64'), contentType: 'video/mp4', filename: 'r.mp4' };
  const a = renderDiscord({ message: 'link', attachment: small }, 2 * 1024 * 1024);
  assert.equal(a.file?.name, 'r.mp4');
  assert.equal(a.file?.data.length, 10);
  const b = renderDiscord({ message: 'link', attachment: big }, 2 * 1024 * 1024);
  assert.equal(b.file, undefined);
  assert.match(b.content, /^link\n\(The video is 3 MB, over Discord's 2 MB upload limit/);
  assert.ok(renderDiscord({ message: 'x'.repeat(5000) }).content.length <= 2000);
});

test('a turn ping posts to the channel over REST, with the file and allowed mentions', async () => {
  const { rest, calls } = fakeRest();
  const b = new DiscordBackend({ platform: 'discord', appId: 'app1', rest });
  const ts = await b.sendToGroup('discord:111', {
    message: 'https://awbw/game @',
    mentions: [{ author: 'discord:42', start: 18, length: 1 }],
    attachment: { dataB64: Buffer.from('gif').toString('base64'), contentType: 'image/gif', filename: 'day8.gif' },
  });
  assert.equal(ts, Date.parse('2026-11-27T12:00:00.000Z'));
  const [c] = calls;
  assert.equal(c.route, '/channels/111/messages');
  assert.equal(c.opts.body.content, 'https://awbw/game <@42>');
  assert.deepEqual(c.opts.body.allowed_mentions, { parse: [], users: ['42'] });
  assert.deepEqual(c.opts.body.attachments, [{ id: 0, filename: 'day8.gif' }]);
  assert.equal(c.opts.files[0].data.toString(), 'gif');
  assert.equal(c.opts.files[0].contentType, 'image/gif');
});

test('a DM opens the DM channel, then posts', async () => {
  const { rest, calls } = fakeRest((route) => (route === '/users/@me/channels' ? { id: 'dm9' } : {}));
  const b = new DiscordBackend({ platform: 'discord', appId: 'app1', rest });
  assert.equal(await b.sendToPerson('discord:42', { message: 'hi' }), undefined);
  assert.deepEqual(calls.map((c) => c.route), ['/users/@me/channels', '/channels/dm9/messages']);
  assert.deepEqual(calls[0].opts.body, { recipient_id: '42' });
});

test('a command registers the slash commands, is deferred, reaches the bot, and its replies answer the interaction', async () => {
  const { rest, calls } = fakeRest();
  const gw = fakeGateway();
  const b = new DiscordBackend({ platform: 'discord', appId: 'app1', rest, gateway: () => gw.g, guildId: 'g5' });
  const items: any[] = [];
  await b.startReceiving(async (item) => {
    items.push(item);
    const gid = item.envelope.dataMessage.groupInfo.groupId;
    await b.sendToGroup(gid, { message: 'first' });
    await b.sendToGroup(gid, { message: 'second' });
  });
  assert.equal(calls[0].method, 'PUT');
  assert.equal(calls[0].route, '/applications/app1/guilds/g5/commands');
  assert.equal(b.receiverDiagnostics().mode, 'discord-gateway');

  const { i, log } = fakeInteraction({ commandName: 'iam', options: { data: [{ name: 'awbw_name', type: 3, value: 'ann_aw' }] } });
  await gw.fire(i);
  const env = items[0].envelope;
  assert.equal(env.sourceUuid, 'discord:42');
  assert.equal(env.sourceNumber, null);
  assert.equal(env.sourceName, 'Ann the Mod');
  assert.equal(env.dataMessage.message, '/iam ann_aw');
  assert.deepEqual(env.dataMessage.groupInfo, { groupId: 'discord:111' });
  assert.deepEqual(log.map((l) => l.kind), ['defer', 'edit', 'followUp']);
  assert.equal(log[1].reply!.content, 'first');
  assert.equal(calls.length, 1, 'no channel posts while answering');

  // After the command is done, a late send (a recap minutes later) is a channel message.
  await b.sendToGroup('discord:111', { message: 'later' });
  assert.equal(calls[1].route, '/channels/111/messages');

  b.stopReceiving();
  assert.ok(gw.isStopped());
  assert.equal(b.receiverDiagnostics().mode, 'off');
});

test('a command that says nothing has its thinking reply removed; a DM command has no group', async () => {
  const { rest } = fakeRest();
  const gw = fakeGateway();
  const b = new DiscordBackend({ platform: 'discord', appId: 'app1', rest, gateway: () => gw.g, registerCommands: false });
  const items: any[] = [];
  await b.startReceiving(async (item) => { items.push(item); });
  const { i, log } = fakeInteraction({ commandName: 'ping', guildId: null, member: null });
  await gw.fire(i);
  assert.deepEqual(log.map((l) => l.kind), ['defer', 'delete']);
  assert.equal(items[0].envelope.dataMessage.groupInfo, undefined);
  assert.equal(items[0].envelope.sourceName, 'Ann');
  // Unknown commands and other bots are ignored.
  await gw.fire(fakeInteraction({ commandName: 'nope' }).i);
  await gw.fire(fakeInteraction({ user: { id: '1', username: 'b', bot: true } }).i);
  assert.equal(items.length, 1);
});

test('a DM command is answered through the interaction', async () => {
  const { rest, calls } = fakeRest();
  const gw = fakeGateway();
  const b = new DiscordBackend({ platform: 'discord', appId: 'app1', rest, gateway: () => gw.g, registerCommands: false });
  await b.startReceiving(async (item) => { await b.sendToPerson(item.envelope.sourceUuid, { message: 'pong' }); });
  const { i, log } = fakeInteraction({ guildId: null });
  await gw.fire(i);
  assert.deepEqual(log.map((l) => l.kind), ['defer', 'edit']);
  assert.equal(calls.length, 0);
});

test('if the interaction reply fails, the message goes to the channel instead', async () => {
  const { rest, calls } = fakeRest();
  const gw = fakeGateway();
  const b = new DiscordBackend({ platform: 'discord', appId: 'app1', rest, gateway: () => gw.g, registerCommands: false });
  await b.startReceiving(async () => { await b.sendToGroup('discord:111', { message: 'hello' }); });
  const { i } = fakeInteraction({ async editReply() { throw new Error('Unknown interaction'); } });
  await gw.fire(i);
  assert.equal(calls[0].route, '/channels/111/messages');
});

test('a failed command registration is reported, not fatal; postsUnprompted asks the gateway', async () => {
  const gw = fakeGateway();
  const rest: DiscordRest = { async post() { return {}; }, async put() { throw new Error('401: Unauthorized'); } };
  const b = new DiscordBackend({ platform: 'discord', appId: 'app1', rest, gateway: () => gw.g });
  await b.startReceiving(async () => {});
  assert.match(b.receiverDiagnostics().lastError!, /register commands: 401/);
  assert.equal(await b.postsUnprompted('discord:111'), true);
  assert.equal(await b.postsUnprompted('discord:222'), false);
  assert.equal(await b.postsUnprompted('discord:333'), undefined);
});
