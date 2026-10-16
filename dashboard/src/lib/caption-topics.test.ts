import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BACKFILL_BATCH,
  backfillTopics,
  claimTopic,
  eligibleInOrder,
  isTopicUsed,
  loadUsedTopics,
  parseJudgeVerdict,
  topicKey,
  topicKeywords,
} from './caption-topics.ts';

const used = (...topics: string[]) => topics.map((t) => ({ keywords: topicKeywords(t) }));

test('the same bit matches however the judge words its topic', () => {
  // The ladder joke went out four times in game 1744366 as "ladder to battle", "ladder to the
  // bar", "ladder ... new heights" — one premise, several labels.
  const sent = used('ladder');
  assert.ok(isTopicUsed('ladder to battle', sent));
  assert.ok(isTopicUsed("soldier's ladders", sent));
  assert.ok(isTopicUsed('Ladder!', sent));
  assert.ok(!isTopicUsed('music school', sent));
});

test('generic war words never count as a topic, or every caption would collide', () => {
  assert.deepEqual(topicKeywords('soldier at the battle for victory'), []);
  assert.ok(!isTopicUsed('troops advance', used('battle')));
  assert.equal(topicKey('the soldier'), '');
});

test('keys are stable across word order, case and punctuation', () => {
  assert.equal(topicKey('Coffee Break'), topicKey('break, coffee'));
  assert.equal(topicKey('rusty wrenches'), 'rusty-wrench');
  assert.equal(topicKey('batteries'), 'battery');
  assert.equal(topicKey('ladders'), 'ladder');
  assert.equal(topicKey('boxes of brass'), 'box-brass');
});

test('candidates come out in judge order with used topics skipped', () => {
  const verdict = parseJudgeVerdict(
    { ranking: [2, 0, 1], topics: ['ladder', 'pencil', 'ladder heights'], score: 85 },
    3
  );
  assert.deepEqual(eligibleInOrder(verdict, used('ladder')), [1]);
  assert.deepEqual(eligibleInOrder(verdict, []), [2, 0, 1]);
});

test('every candidate repeating a topic leaves nothing eligible', () => {
  const verdict = parseJudgeVerdict({ ranking: [0, 1], topics: ['ladder', 'new heights ladder'] }, 2);
  assert.deepEqual(eligibleInOrder(verdict, used('ladder')), []);
  assert.equal(verdict.ranking[0], 0); // the caller's fallback
});

test('topics keyed by candidate index stay with their candidate whatever the ranking', () => {
  const v = parseJudgeVerdict({ ranking: [2, 0, 1], topics: { 2: 'pencil', 0: 'ladder', 1: 'coffee break' } }, 3);
  assert.deepEqual(v.topics, ['ladder', 'coffee break', 'pencil']);
});

test('a malformed judge reply still ranks every candidate once', () => {
  const v = parseJudgeVerdict({ ranking: [3, 'x', 3, 9, -1], topics: ['a'] }, 4);
  assert.deepEqual(v.ranking, [3, 0, 1, 2]);
  assert.deepEqual(v.topics, ['a', '', '', '']);
  assert.equal(v.score, null);
  // The old {best} shape still works.
  assert.deepEqual(parseJudgeVerdict({ best: 1, score: 150 }, 3), { ranking: [1, 0, 2], topics: ['', '', ''], score: 100 });
  assert.deepEqual(parseJudgeVerdict(null, 2).ranking, [0, 1]);
});

/** Firestore stand-in: create() fails with ALREADY_EXISTS like the real one. */
function fakeDb() {
  const docs = new Map<string, Record<string, unknown>>();
  const sub = (game: string) => ({
    doc: (key: string) => ({
      create: async (data: Record<string, unknown>) => {
        const path = `${game}/${key}`;
        if (docs.has(path)) throw Object.assign(new Error('ALREADY_EXISTS'), { code: 6 });
        docs.set(path, data);
      },
      set: async (data: Record<string, unknown>) => void docs.set(`${game}/${key}`, data),
    }),
    limit: () => ({
      get: async () => ({
        docs: [...docs.entries()].filter(([p]) => p.startsWith(`${game}/`)).map(([, d]) => ({ data: () => d })),
      }),
    }),
  });
  const db = { collection: () => ({ doc: (game: string) => ({ collection: () => sub(game) }) }) };
  return { db, docs };
}

test('two groups captioning the same turn cannot both claim a topic', async () => {
  // Day 14: both groups watching game 1744366 sent the ladder joke at 16:44.
  const { db } = fakeDb();
  const [a, b] = await Promise.all([
    claimTopic(db, '1744366', 'ladder', 'first group'),
    claimTopic(db, '1744366', 'Ladders', 'second group'),
  ]);
  assert.deepEqual([a, b].sort(), [false, true]);
  assert.equal(await claimTopic(db, '1744366', 'pencil', 'x'), true);
});

test('a topic with nothing distinctive needs no claim', async () => {
  const { db, docs } = fakeDb();
  assert.equal(await claimTopic(db, 'g', 'soldier battle', 'x'), true);
  assert.equal(docs.size, 0);
});

test('claimed topics load back as used', async () => {
  const { db } = fakeDb();
  await claimTopic(db, 'g', 'Music School', 'x');
  const loaded = await loadUsedTopics(db, 'g');
  assert.deepEqual(loaded, [{ topic: 'music school', keywords: ['music', 'school'] }]);
  assert.ok(isTopicUsed('school of music', loaded));
});

test('backfill labels an old game once and makes its jokes count', async () => {
  const { db } = fakeDb();
  const sent = ['Why did the soldier bring a ladder?', 'Coffee break is over!', 'Advance!'];
  let calls = 0;
  const topics = await backfillTopics(db, 'g', sent, async (texts) => {
    calls++;
    assert.equal(texts.length, 3);
    return ['ladder', 'coffee break', 'soldier']; // the last has nothing distinctive
  });
  assert.equal(calls, 1);
  assert.deepEqual(topics.map((t) => t.topic).sort(), ['coffee break', 'ladder']);
  assert.ok(isTopicUsed('ladder to the bar', await loadUsedTopics(db, 'g')));
  assert.deepEqual(await backfillTopics(db, 'g', [], async () => assert.fail('no call for no captions')), []);
});

test('backfill labels in small batches, and a failed batch costs only its own captions', async () => {
  const { db } = fakeDb();
  const sent = Array.from({ length: BACKFILL_BATCH * 2 + 3 }, (_, i) => `caption ${i}`);
  const sizes: number[] = [];
  const topics = await backfillTopics(db, 'g', sent, async (texts) => {
    sizes.push(texts.length);
    if (texts[0] === `caption ${BACKFILL_BATCH}`) throw new Error('truncated JSON');
    return texts.map((t) => `prop ${t.split(' ')[1]}`.replace(/\d+/, (n) => 'abcdefghijklmnopqrstuvwxyz'[Number(n) % 26] + 'xyz'));
  });
  assert.deepEqual(sizes.sort((a, b) => a - b), [3, BACKFILL_BATCH, BACKFILL_BATCH]);
  assert.equal(topics.length, BACKFILL_BATCH + 3); // the middle batch failed
});
