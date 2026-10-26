import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BACKFILL_BATCH,
  RECENT_TOPIC_DAYS,
  backfillTopics,
  chooseCandidate,
  claimTopic,
  eligibleInOrder,
  isRepeat,
  isTopicUsed,
  loadUsedTopics,
  parseJudgeVerdict,
  topicKey,
  topicKeywords,
  type UsedTopic,
} from './caption-topics.ts';

const used = (...topics: string[]): UsedTopic[] => topics.map((t) => ({ topic: t, keywords: topicKeywords(t) }));
const sent = (topic: string, text: string, scope: 'game' | 'recent' = 'game'): UsedTopic => ({
  topic,
  text,
  keywords: topicKeywords(topic),
  scope,
});

// Production's labelled history: game 1744366's 70 captions and game 1751089's first 10, in
// the order they went out, each with the topic the judge (or the backfill) gave it.
const history = JSON.parse(readFileSync(new URL('./caption-topics.fixture.json', import.meta.url), 'utf8')) as Record<
  string,
  Array<{ topic: string; text: string }>
>;

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
  const texts = ['A ladder joke', 'A pencil joke', 'Another ladder joke'];
  assert.deepEqual(eligibleInOrder(verdict, texts, used('ladder')), [1]);
  assert.deepEqual(eligibleInOrder(verdict, texts, []), [2, 0, 1]);
});

test('every candidate repeating a topic leaves nothing eligible', () => {
  const verdict = parseJudgeVerdict({ ranking: [0, 1], topics: ['ladder', 'new heights ladder'] }, 2);
  assert.deepEqual(eligibleInOrder(verdict, ['', ''], used('ladder')), []);
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

/** Firestore stand-in: per-game docs live at "<game>/<key>", cross-game ones at "recent/<key>";
 *  create() fails with ALREADY_EXISTS like the real one. */
function fakeDb() {
  const docs = new Map<string, Record<string, unknown>>();
  const snap = (prefix: string, keep: (d: Record<string, unknown>) => boolean = () => true) => ({
    docs: [...docs.entries()]
      .filter(([p, d]) => p.startsWith(prefix) && keep(d))
      .map(([, d]) => ({ data: () => d })),
  });
  const docAt = (path: string) => ({
    create: async (data: Record<string, unknown>) => {
      if (docs.has(path)) throw Object.assign(new Error('ALREADY_EXISTS'), { code: 6 });
      docs.set(path, data);
    },
    set: async (data: Record<string, unknown>) => void docs.set(path, data),
  });
  const db = {
    collection: (name: string) => ({
      doc: (id: string) => ({
        ...docAt(`recent/${id}`),
        collection: () => ({ doc: (key: string) => docAt(`${id}/${key}`), limit: () => ({ get: async () => snap(`${id}/`) }) }),
      }),
      where: (_field: string, _op: '>=', since: Date) => {
        assert.equal(name, 'recentCaptionTopics');
        return {
          orderBy: () => ({ limit: () => ({ get: async () => snap('recent/', (d) => (d.at as Date) >= since) }) }),
        };
      },
    }),
  };
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
  assert.deepEqual(loaded, [{ topic: 'music school', keywords: ['music', 'school'], text: 'x', scope: 'game' }]);
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

// ---- Game 1751089, Oct 26: the ladder joke went out labelled "high stakes" ----------------

const LADDER_1 = 'Why did the soldier bring a ladder to the battlefield? He wanted to climb the ranks! Alecnexus, this is Infantry.';
const LADDER_2 =
  'Why did the soldier bring a ladder to battle? Because he heard the stakes were high! Ready to climb higher—alecnexus, awaiting orders. Over.';

test('a candidate that names a used topic repeats it, whatever the judge labelled it', () => {
  assert.ok(!isTopicUsed('high stakes', [sent('ladder', LADDER_1)])); // what let it through
  assert.ok(isRepeat('high stakes', LADDER_2, [sent('ladder', LADDER_1)]));
});

test('a candidate whose topic an earlier caption names repeats it', () => {
  // The other way round: the earlier joke got the odd label, the new one the obvious one.
  assert.ok(isRepeat('ladder', LADDER_1, [sent('high stakes', LADDER_2)]));
});

test('captions sharing only backdrop words are not repeats', () => {
  const earlier = sent('banana peel', "Infantry on the line! Why did the monkey like the banana? 'Cause it had appeal! Orange Star, waiting on orders, over.");
  assert.ok(!isRepeat('pencil', 'Why did the soldier bring a pencil to battle? To draw fire! Orange Star awaiting orders, over.', [earlier]));
  // An army name, a day number or "charge ahead" is how a turn ping talks, not a bit.
  for (const topic of ['orange star', 'day eleven', 'charge ahead', 'open ground', 'waiting']) {
    assert.ok(!isRepeat('rusty wrench', 'Orange Star, day eleven: charge ahead over open ground, waiting on you!', [sent(topic, '')]), topic);
  }
});

test("replaying production's history flags the ladder repeats", () => {
  // Game 1751089 after game 1744366, the same group: each caption checked against all before it.
  const before = history['1744366'].map((h) => sent(h.topic, h.text, 'recent'));
  const flagged: string[] = [];
  for (const h of history['1751089']) {
    if (isRepeat(h.topic, h.text, before)) flagged.push(h.topic);
    before.push(sent(h.topic, h.text));
  }
  // Both of game 1751089's ladder jokes (1744366 told it three times), plus banana, pencil and
  // scarecrow-field bits 1744366 had also told.
  for (const t of ['ladder', 'high stakes', 'pencil', 'field', 'banana peel']) assert.ok(flagged.includes(t), t);
  // Fresh ones get through.
  for (const t of ['space', 'roots']) assert.ok(!flagged.includes(t), t);
});

test("most of a busy game's captions are not flagged against each other", () => {
  // 1744366 really did repeat itself (a pile of cats twice, the boa constructor twice), but a
  // filter flagging most of a game would leave the judge nothing to choose from.
  const before: UsedTopic[] = [];
  let flagged = 0;
  for (const h of history['1744366']) {
    if (isRepeat(h.topic, h.text, before)) flagged++;
    before.push(sent(h.topic, h.text));
  }
  assert.ok(flagged / history['1744366'].length < 0.3, `${flagged} of ${history['1744366'].length}`);
});

// ---- Across games ---------------------------------------------------------------------------

test("a topic claimed in one game is used in the group's next game", async () => {
  const { db } = fakeDb();
  await claimTopic(db, '1744366', 'ladder', LADDER_1);
  const next = await loadUsedTopics(db, '1751089');
  assert.deepEqual(next, [{ topic: 'ladder', keywords: ['ladder'], text: LADDER_1, scope: 'recent' }]);
  assert.ok(isRepeat('high stakes', LADDER_2, next));
  // The game that told it sees it once, as its own, not again as "recent".
  assert.deepEqual((await loadUsedTopics(db, '1744366')).map((u) => u.scope), ['game']);
});

test(`topics from other games lapse after ${RECENT_TOPIC_DAYS} days`, async () => {
  const { db } = fakeDb();
  await claimTopic(db, 'old', 'ladder', LADDER_1);
  const later = new Date(Date.now() + (RECENT_TOPIC_DAYS + 1) * 86_400_000);
  assert.deepEqual(await loadUsedTopics(db, 'new', later), []);
});

test('a failed cross-game read still leaves the game its own topics', async () => {
  const { db } = fakeDb();
  await claimTopic(db, 'g', 'pencil', 'x');
  const broken = {
    collection: (name: string) => ({
      ...db.collection(name),
      where: () => ({ orderBy: () => ({ limit: () => ({ get: async () => Promise.reject(new Error('index')) }) }) }),
    }),
  };
  assert.deepEqual((await loadUsedTopics(broken, 'g')).map((u) => u.topic), ['pencil']);
});

test('the best candidate that repeats nothing is sent, and its topic claimed', async () => {
  const { db, docs } = fakeDb();
  const candidates = [LADDER_2, 'Why did the soldier bring a pencil? To draw fire!', 'Coffee break is over, commander!'];
  const verdict = parseJudgeVerdict({ ranking: [0, 1, 2], topics: { 0: 'high stakes', 1: 'pencil', 2: 'coffee break' } }, 3);
  const used = [sent('ladder', LADDER_1, 'recent'), sent('pencil', 'Bring a pencil to draw fire!')];
  assert.deepEqual(await chooseCandidate(db, 'g', verdict, candidates, used), { index: 2, fresh: 'yes' });
  assert.ok(docs.has('g/break-coffee') && docs.has('recent/break-coffee'));
});

test("when every candidate repeats, another game's bit goes out before this game's", async () => {
  const { db } = fakeDb();
  const candidates = ['A ladder to battle!', 'A pencil to battle!'];
  const verdict = parseJudgeVerdict({ ranking: [0, 1], topics: { 0: 'ladder', 1: 'pencil' } }, 2);
  // Ladder was told this game; pencil only last game.
  const used = [sent('ladder', 'ladder', 'game'), sent('pencil', 'pencil', 'recent')];
  assert.deepEqual(await chooseCandidate(db, 'g', verdict, candidates, used), { index: 1, fresh: 'this-game' });
  // Both told this game: the judge's top pick goes out anyway, rather than no caption.
  const both = [sent('ladder', 'ladder'), sent('pencil', 'pencil')];
  assert.deepEqual(await chooseCandidate(fakeDb().db, 'g', verdict, candidates, both), { index: 0, fresh: 'no' });
});

test('a topic another group just claimed for this turn passes to the next candidate', async () => {
  const { db } = fakeDb();
  await claimTopic(db, 'g', 'coffee break', 'the other group');
  const verdict = parseJudgeVerdict({ ranking: [0, 1], topics: { 0: 'coffee break', 1: 'rusty wrench' } }, 2);
  const pick = await chooseCandidate(db, 'g', verdict, ['Coffee break!', 'Hand me that rusty wrench!'], []);
  assert.deepEqual(pick, { index: 1, fresh: 'yes' });
});
