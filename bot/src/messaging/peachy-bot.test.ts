import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakePeachy } from '@peachysocial/bot/testing';
// The leaf module, as .ts: tests run the sources directly.
import { PEACHY_COMMANDS, PeachyBotBackend } from './peachy-bot.ts';
import type { IncomingItem, MessagingBackend } from './backend.ts';

/** A backend on an in-memory Peachy. `answer` stands in for the bot: it gets each incoming
 *  item and may send through the backend, as Com Tower's command handlers do. */
async function start(
  answer: (item: IncomingItem, backend: MessagingBackend) => Promise<void> = async () => {},
  opts: { unavailableRetryMs?: number[] } = {}
) {
  const peachy = new FakePeachy({ handle: 'comtower', name: 'Com Tower' });
  const backend = new PeachyBotBackend({
    platform: 'peachy',
    bot: peachy.bot({ logger: false }),
    unavailableRetryMs: opts.unavailableRetryMs ?? [10, 10],
  });
  const got: IncomingItem[] = [];
  await backend.startReceiving(async (item) => {
    got.push(item);
    await answer(item, backend);
  });
  const alice = peachy.person('Alice', 'alice');
  const bob = peachy.person('Bob', 'bob');
  return { peachy, backend, got, alice, bob };
}

/** Reply the way Com Tower does: to the group the command came from, or to its sender. */
const echo = (text: string) => async (item: IncomingItem, backend: MessagingBackend) => {
  const env = item.envelope;
  const groupId = env.dataMessage.groupInfo?.groupId;
  if (groupId) await backend.sendToGroup(groupId, { message: text });
  else await backend.sendToPerson(`+${env.sourceNumber || env.sourceUuid}`, { message: text });
};

test("Com Tower's commands are in Peachy's command picker", async () => {
  const { peachy, backend } = await start();
  assert.deepEqual([...peachy.listedCommands].sort(), PEACHY_COMMANDS.map(([n]) => n).sort());
  assert.equal(backend.botId, 'comtower');
});

test('a command in a group arrives as a signal-cli envelope, and its reply goes to the thread and the chat', async () => {
  const { peachy, got, alice, bob } = await start(echo('📡 Watching game 123.'));
  const group = await peachy.addToChat({ by: alice, members: [bob], name: 'Our game' });
  const asked = await group.say(alice, '@comtower /game 123', { mentionsBot: true });

  assert.equal(got.length, 1);
  const env = got[0].envelope;
  assert.equal(env.sourceUuid, alice.actorId);
  assert.equal(env.sourceName, 'Alice');
  assert.equal(env.sourceNumber, null);
  assert.equal(env.dataMessage.message, '/game 123');
  assert.deepEqual(env.dataMessage.groupInfo, { groupId: group.id, groupName: 'Our game' });

  assert.deepEqual(
    group.posts.map((p) => p.kind === 'reply' && [p.text, p.replyTo, p.alsoSendToChat]),
    [['📡 Watching game 123.', asked, true]]
  );
});

test('a bare /command needs the post grant for its reply', async () => {
  let refused: unknown;
  const { peachy, got, alice } = await start(async (item, backend) => {
    const groupId = item.envelope.dataMessage.groupInfo.groupId;
    refused = await backend.sendToGroup(groupId, { message: 'pong' }).then(() => null, (e) => e);
  });
  const group = await peachy.addToChat({ by: alice });
  await group.say(alice, '/ping');
  assert.equal(got.length, 1);
  assert.match(String((refused as Error)?.message), /post grant/);
  assert.deepEqual(group.posts, []);

  const { peachy: p2, alice: a2 } = await start(echo('pong'));
  const granted = await p2.addToChat({ by: a2, grants: ['post'] });
  await granted.say(a2, '/ping');
  assert.deepEqual(granted.posts.map((p) => p.text), ['pong']);
});

test('members a command names with @ come through as mentions; ordinary chat never reaches the bot', async () => {
  const { peachy, got, alice, bob } = await start();
  const group = await peachy.addToChat({ by: alice, members: [bob], grants: ['post'] });
  await group.say(alice, 'anyone up for a game?');
  await group.say(alice, '@comtower /setplayer @bob some_player', { mentionsBot: true, mentions: [bob] });
  await group.say(alice, '/who');

  assert.deepEqual(got.map((i) => i.envelope.dataMessage.message), ['/setplayer @bob some_player', '/who']);
  assert.deepEqual(got[0].envelope.dataMessage.mentions, [
    { uuid: bob.actorId, number: null, name: 'Bob', handle: 'bob', start: '/setplayer '.length, length: '@bob'.length },
  ]);
  assert.equal(got[1].envelope.dataMessage.mentions, undefined);
});

test('a turn ping posts to the group and mentions the player for real', async () => {
  const { peachy, backend, alice, bob } = await start();
  const group = await peachy.addToChat({ by: alice, members: [bob], grants: ['post'] });
  const text = "It's Bob's turn (day 3).";
  const ts = await backend.sendToGroup(group.id, {
    message: `${text} @`,
    mentions: [{ author: bob.actorId, start: text.length + 1, length: 1 }],
  });
  assert.ok(typeof ts === 'number' && ts > 0);
  assert.deepEqual(
    group.posts.map((p) => [p.kind, p.text, p.mentions?.map((m) => m.actorId)]),
    [['post', "It's Bob's turn (day 3). @bob", [bob.actorId]]]
  );
});

test('only the people the bot means are mentioned; a placeholder for someone gone is dropped', async () => {
  const { peachy, backend, alice, bob } = await start();
  const carol = peachy.person('Carol', 'carol');
  const group = await peachy.addToChat({ by: alice, members: [bob], grants: ['post'] });
  // Typed @handles stay words; a mention of someone not in the chat leaves no stray "@".
  await backend.sendToGroup(group.id, {
    message: 'Ask @bob about it. @',
    mentions: [{ author: carol.actorId, start: 'Ask @bob about it. '.length, length: 1 }],
  });
  await backend.sendToGroup(group.id, { message: 'Roster: @alice, @bob' });
  assert.deepEqual(
    group.posts.map((p) => [p.text, p.mentions?.length ?? 0]),
    [['Ask @bob about it.', 0], ['Roster: @alice, @bob', 0]]
  );
});

test('a reply to a command mentions the members it names', async () => {
  const { peachy, got, alice, bob } = await start(async (item, backend) => {
    const groupId = item.envelope.dataMessage.groupInfo.groupId;
    const [m] = item.envelope.dataMessage.mentions;
    const text = 'Mapped ';
    await backend.sendToGroup(groupId, {
      message: `${text}@ to some_player.`,
      mentions: [{ author: m.uuid, start: text.length, length: 1 }],
    });
  });
  const group = await peachy.addToChat({ by: alice, members: [bob], grants: ['post'] });
  await group.say(alice, '@comtower /setplayer @bob some_player', { mentionsBot: true, mentions: [bob] });
  assert.equal(got.length, 1);
  assert.deepEqual(
    group.posts.map((p) => [p.kind, p.text, p.mentions?.map((m) => m.actorId)]),
    [['reply', 'Mapped @bob to some_player.', [bob.actorId]]]
  );
});

test('a send Peachy cannot take right now is tried again, then left to the caller', async () => {
  const { peachy, backend, alice } = await start(undefined, { unavailableRetryMs: [50, 50] });
  const group = await peachy.addToChat({ by: alice, grants: ['post'] });
  await peachy.setReachable(false);
  const sent = backend.sendToGroup(group.id, { message: 'Day 5' });
  setTimeout(() => void peachy.setReachable(true), 20);
  await sent;
  assert.deepEqual(group.posts.map((p) => p.text), ['Day 5']);

  await peachy.setReachable(false);
  await assert.rejects(backend.sendToGroup(group.id, { message: 'Day 6' }), { name: 'UnavailableError' });
  await peachy.setReachable(true);
  assert.deepEqual(group.posts.map((p) => p.text), ['Day 5']);
});

test('a turn ping in a group without the post grant is refused, and the bot is told it may not post', async () => {
  const { peachy, backend, alice } = await start();
  const group = await peachy.addToChat({ by: alice });
  assert.equal(await backend.postsUnprompted(group.id), false);
  await assert.rejects(backend.sendToGroup(group.id, { message: 'Your move' }), { name: 'GrantMissingError' });
  assert.deepEqual(group.posts, []);
  group.setGrants(['post']);
  assert.equal(await backend.postsUnprompted(group.id), true);
});

test('an attachment goes as a photo with the post', async () => {
  const { peachy, backend, alice } = await start();
  const group = await peachy.addToChat({ by: alice, grants: ['post'] });
  // A 1x1 GIF, as a turn ping's unit image.
  const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  await backend.sendToGroup(group.id, {
    message: 'Day 4',
    attachment: { dataB64: gif.toString('base64'), contentType: 'image/gif', filename: 'unit.gif' },
  });
  const [post] = group.posts;
  assert.equal(post.text, 'Day 4');
  assert.equal(post.files?.length, 1);
  const f = post.files![0];
  assert.equal(f.contentType, 'image/gif');
  assert.equal(f.name, 'unit.gif');
  assert.deepEqual(Buffer.from(f.bytes), gif);
});

test('a DM command arrives without a group, and its reply is inline in the DM', async () => {
  const { peachy, got, alice } = await start(echo('🛰️ Com Tower online.'));
  const out = await peachy.dm(alice, '/ping');
  assert.equal(got.length, 1);
  assert.equal(got[0].envelope.dataMessage.groupInfo, undefined);
  assert.equal(got[0].envelope.sourceUuid, alice.actorId);
  assert.deepEqual(out, { kind: 'reply', text: '🛰️ Com Tower online.', alsoSendToChat: false, inline: true, typed: true });

  // A group-only command typed in the DM still reaches the bot, which answers with its DM help.
  await peachy.dm(alice, '/game 123');
  assert.equal(got[1].envelope.dataMessage.message, '/game 123');
});

test('a DM to someone outside a handler writes to them first', async () => {
  const { peachy, backend, bob } = await start();
  await backend.sendToPerson(`+${bob.actorId}`, { message: 'Your turn' });
  assert.deepEqual(peachy.dmPosts(bob).map((p) => [p.text, p.request]), [['Your turn', true]]);
});

test('listGroups lists the chats the bot is in, and a chat that adds it again keeps its id', async () => {
  const { peachy, backend, alice, bob } = await start();
  const one = await peachy.addToChat({ by: alice, name: 'One', grants: ['post'] });
  const two = await peachy.addToChat({ by: bob, name: 'Two' });
  const groups = await backend.listGroups();
  assert.deepEqual(
    groups.map((g) => [g.id, g.name, g.mayPost, g.grants]).sort(),
    [[one.id, 'One', true, ['post']], [two.id, 'Two', true, []]].sort()
  );
  await two.remove();
  assert.deepEqual((await backend.listGroups()).map((g) => g.id), [one.id]);

  // Added back, it is the same chat: the game bound to its id carries on.
  await two.addAgain({ grants: ['post'] });
  assert.deepEqual((await backend.listGroups()).map((g) => g.id).sort(), [one.id, two.id].sort());
  await backend.sendToGroup(two.id, { message: 'Still watching' });
  assert.deepEqual(two.posts.map((p) => p.text), ['Still watching']);
});
