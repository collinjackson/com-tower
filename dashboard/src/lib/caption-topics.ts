// Caption topics: the premise each fun-mode caption hinges on ("ladder", "music school"), kept
// per game so a bit is never reused. Repeat-avoidance used to mean pasting every sent caption
// into the generator's prompt, which taught the model to imitate them instead — with 66 prior
// captions in the prompt, 58 of 60 candidates opened "Cruiser here" (for a CO) and a quarter
// were the same ladder joke. Topics are short enough to list without priming, and the filter
// runs in code rather than relying on the judge to obey a rule.
//
// Labels alone weren't enough. In game 1751089 the judge called a ladder joke "high stakes" ("Why
// did the soldier bring a ladder to battle? Because he heard the stakes were high!"), a topic no
// one had used, so it went out though "ladder" was already spent. So a candidate also repeats when
// its text names a used topic, or when an earlier caption's text names the candidate's topic.
// And the same group plays game after game: the ladder joke went out in every one of its five
// games, so topics are shared across games for RECENT_TOPIC_DAYS too.

/** How a topic is described, shared by the judge (labelling candidates) and the backfill. */
export const TOPIC_RULE =
  `A topic is the 1-3 word premise the bit hinges on — the specific prop, place, or situation the ` +
  `punchline turns on (e.g. "ladder", "music school", "coffee break", "rusty wrench"), lowercase. ` +
  `Label the punchline's prop, not the joke's subject: "Why did the car bring a ladder? To reach new ` +
  `heights!" is "ladder", not "car". Never generic war words like soldier, battle, troops, victory, ` +
  `or advance: those are every caption's backdrop, not its topic.`;

// Words every caption shares, so a topic made of them alone would block everything.
const GENERIC = new Set(
  (
    'a an the to of and or in on at for with by from my our your their his her its this that ' +
    'soldier soldiers trooper troop troops battle battlefield war fight fighting victory army armies ' +
    'commander command orders order advance attack unit units day turn time move new big bring ' +
    // Backdrop of a turn ping, too common in caption text to count as having told a joke.
    'wait waiting ready over map ground charge charging power firepower next ' +
    // Everyday words that turned up as topics and then matched half the captions ("charge
    // ahead", "open ground", "sights high").
    'ahead more open high hot sharp tall stand strong loud wild fast great best good top line front way ' +
    // Day numbers: "day ten" is a date, not a bit.
    'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen ' +
    'twenty thirty first second third fourth fifth'
  ).split(' ')
);

/** AWBW's armies. Captions name them constantly, so a whole army name is backdrop ("Orange Star"
 *  isn't a joke), though one of its words alone may be ("moon", "ice"). */
const ARMIES = new RegExp(
  '\\b(' +
    'orange star|blue moon|green earth|yellow comet|black hole|red fire|grey sky|brown desert|' +
    'amber blaze|jade sun|cobalt ice|pink cosmos|teal galaxy|purple lightning|acid rain|' +
    'white nova|azure asteroid|noir eclipse|silver claw|umber wilds' +
    ')\\b',
  'g'
);

/** Lowercase letters and spaces only. */
export function normalizeTopic(topic: string): string {
  return topic.toLowerCase().replace(/[^a-z]+/g, ' ').trim();
}

/** Normalized, with army names taken out. */
function contentWords(s: string): string[] {
  return normalizeTopic(s).replace(ARMIES, ' ').split(' ').filter(Boolean);
}

/** The distinctive words of a topic, crudely singular so "ladders" and "ladder" meet. */
export function topicKeywords(topic: string): string[] {
  const words = contentWords(topic)
    .filter((w) => w.length >= 3 && !GENERIC.has(w))
    .map(singular);
  return Array.from(new Set(words));
}

/** Every word of a caption, singular, for checking whether it names a topic. */
export function textWords(text: string): Set<string> {
  return new Set(contentWords(text).map(singular));
}

/** Whether a caption names a topic: every distinctive word of the topic appears in it. */
function mentions(words: Set<string>, keywords: string[]): boolean {
  return keywords.length > 0 && keywords.every((k) => words.has(k));
}

/** Rough English singular — enough that "wrenches", "batteries" and "ladders" meet their singulars. */
function singular(w: string): string {
  if (w.length <= 4) return w;
  if (w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (/(ch|sh|x|z|ss)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

/** Stable Firestore doc id for a topic, or '' when it has nothing distinctive to claim. */
export function topicKey(topic: string): string {
  return topicKeywords(topic).sort().join('-');
}

/** A topic is used when it shares any distinctive word with one already sent: "ladder to the
 *  bar" and "soldier's ladder" are the same bit. Deliberately strict — the generator is told
 *  the used list, and if every candidate collides the caller still falls back to the best one. */
export function isTopicUsed(topic: string, used: Array<{ keywords: string[] }>): boolean {
  const mine = topicKeywords(topic);
  if (mine.length === 0) return false;
  return used.some((u) => u.keywords.some((k) => mine.includes(k)));
}

/** A candidate repeats a sent caption when their topics overlap, or when either's text names the
 *  other's topic — so one mislabel ("high stakes" for a ladder joke) can't let a bit through. */
export function isRepeat(topic: string, text: string, used: UsedTopic[]): boolean {
  if (isTopicUsed(topic, used)) return true;
  const mine = topicKeywords(topic);
  const words = textWords(text);
  return used.some((u) => mentions(words, u.keywords) || (!!u.text && mentions(textWords(u.text), mine)));
}

/** The judge's reply: candidate indices best first, and one topic per candidate (by candidate index). */
export type JudgeVerdict = { ranking: number[]; topics: string[]; score: number | null };

/** Read the judge's JSON defensively: an older-shape `{best}` reply, a ranking with gaps or junk,
 *  or missing topics all still yield every candidate exactly once, best first. */
export function parseJudgeVerdict(raw: unknown, candidateCount: number): JudgeVerdict {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const valid = (i: unknown): i is number => Number.isInteger(i) && (i as number) >= 0 && (i as number) < candidateCount;
  const ranked = (Array.isArray(r.ranking) ? r.ranking : [r.best]).map(Number).filter(valid);
  const ranking = Array.from(new Set(ranked));
  for (let i = 0; i < candidateCount; i++) if (!ranking.includes(i)) ranking.push(i);
  // Topics keyed by candidate index ({"0": "ladder", ...}). A parallel array was misread: asked
  // for topics "in candidate order" beside a best-first ranking, smaller models wrote them in
  // ranked order, so every label landed on the wrong candidate. An array is still accepted.
  const byIndex = (r.topics && typeof r.topics === 'object' ? r.topics : {}) as Record<string, unknown>;
  const topics = Array.from({ length: candidateCount }, (_, i) =>
    typeof byIndex[i] === 'string' ? (byIndex[i] as string) : ''
  );
  const score = Number(r.score);
  return { ranking, topics, score: Number.isFinite(score) ? Math.max(0, Math.min(100, score)) : null };
}

/** Candidates in the order to try them: the judge's ranking with repeats skipped. Empty when
 *  every candidate repeats — see chooseCandidate for what happens then. */
export function eligibleInOrder(verdict: JudgeVerdict, candidates: string[], used: UsedTopic[]): number[] {
  return verdict.ranking.filter((i) => !isRepeat(verdict.topics[i] || '', candidates[i] || '', used));
}

type Docs = { get(): Promise<{ docs: Array<{ data(): Record<string, unknown> }> }> };
type TopicDoc = {
  create(data: Record<string, unknown>): Promise<unknown>;
  set(data: Record<string, unknown>, opts?: { merge?: boolean }): Promise<unknown>;
};

/** The slice of Firestore this module touches, so tests can pass a fake. */
export type Db = {
  collection(name: string): {
    doc(id: string): {
      collection(name: string): { doc(id: string): TopicDoc; limit(n: number): Docs };
    } & TopicDoc;
    where(field: string, op: '>=', value: Date): { orderBy(field: string, dir: 'desc'): { limit(n: number): Docs } };
  };
};

/** A spent topic and the caption that spent it. `scope` is 'game' for this game's own topics and
 *  'recent' for ones another game used lately. */
export type UsedTopic = { topic: string; keywords: string[]; text?: string; scope?: 'game' | 'recent' };

/** How long a topic told in one game stays spent in the group's next games. */
export const RECENT_TOPIC_DAYS = 90;
const RECENT_TOPIC_LIMIT = 300;

function topicsOf(db: Db, gameId: string) {
  return db.collection('games').doc(gameId).collection('captionTopics');
}

/** Topics across every game, one doc per topic key, newest use wins. Not per group (the render
 *  route isn't told the group), which is fine while one group plays one game after another. */
function recentTopics(db: Db) {
  return db.collection('recentCaptionTopics');
}

function toUsed(d: Record<string, unknown>, scope: 'game' | 'recent'): UsedTopic | null {
  if (typeof d.topic !== 'string') return null;
  return { topic: d.topic, keywords: topicKeywords(d.topic), text: typeof d.text === 'string' ? d.text : undefined, scope };
}

/** This game's topics, plus those another game used in the last RECENT_TOPIC_DAYS. A failed
 *  cross-game read just leaves this game's own topics. */
export async function loadUsedTopics(db: Db, gameId: string, now = new Date()): Promise<UsedTopic[]> {
  const since = new Date(now.getTime() - RECENT_TOPIC_DAYS * 86_400_000);
  const [own, recent] = await Promise.all([
    topicsOf(db, gameId).limit(500).get(),
    recentTopics(db)
      .where('at', '>=', since)
      .orderBy('at', 'desc')
      .limit(RECENT_TOPIC_LIMIT)
      .get()
      .catch((err) => {
        console.warn('recent caption topics read failed', err);
        return { docs: [] };
      }),
  ]);
  const game = own.docs.map((d) => toUsed(d.data(), 'game')).filter((u): u is UsedTopic => !!u);
  const others = recent.docs
    .map((d) => d.data())
    .filter((d) => d.gameId !== gameId)
    .map((d) => toUsed(d, 'recent'))
    .filter((u): u is UsedTopic => !!u);
  return [...game, ...others];
}

/** Claim a topic for this game. Atomic (create fails if it exists), so when two groups watch the
 *  same game and caption the same turn at once, only one of them can send the bit. Returns false
 *  only when someone else already holds it; a storage error must not cost the turn its caption.
 *  A won claim is also recorded across games, so the group's next game knows the bit too. */
export async function claimTopic(db: Db, gameId: string, topic: string, text: string): Promise<boolean> {
  const key = topicKey(topic);
  if (!key) return true;
  const data = { topic: normalizeTopic(topic), text, at: new Date() };
  try {
    await topicsOf(db, gameId).doc(key).create(data);
  } catch (err) {
    if ((err as { code?: number })?.code === 6) return false; // ALREADY_EXISTS
    console.warn('caption topic claim failed', err);
    return true;
  }
  await recentTopics(db)
    .doc(key)
    .set({ ...data, gameId })
    .catch((err) => console.warn('recent caption topic write failed', err));
  return true;
}

/** Pick the caption to send: the judge's best candidate that repeats nothing and whose topic this
 *  call wins the claim on. When every candidate repeats something, other games' topics are let go
 *  first (better a bit from last game than one from this game), and then the judge's top pick goes
 *  out anyway — a repeat beats a silent turn ping. `fresh` says which happened. */
export async function chooseCandidate(
  db: Db,
  gameId: string,
  verdict: JudgeVerdict,
  candidates: string[],
  used: UsedTopic[]
): Promise<{ index: number; fresh: 'yes' | 'this-game' | 'no' }> {
  const tiers: Array<['yes' | 'this-game', UsedTopic[]]> = [
    ['yes', used],
    ['this-game', used.filter((u) => u.scope !== 'recent')],
  ];
  const tried = new Set<number>();
  for (const [fresh, tier] of tiers) {
    for (const i of eligibleInOrder(verdict, candidates, tier)) {
      if (tried.has(i)) continue;
      tried.add(i);
      if (await claimTopic(db, gameId, verdict.topics[i] || '', candidates[i])) return { index: i, fresh };
    }
  }
  return { index: verdict.ranking[0] ?? 0, fresh: 'no' };
}

/** Captions per labelling call. Asked for all 66 of one game's captions at once, gpt-4o-mini
 *  labelled about 30 and then wrote "pencil" until it ran out of tokens; small batches hold. */
export const BACKFILL_BATCH = 12;

/** Games that started before topics existed have captions but no topic list. Label their
 *  history once, so a joke already told counts from the first caption after this shipped.
 *  A batch that fails or comes back short just leaves those captions unlabelled. */
export async function backfillTopics(
  db: Db,
  gameId: string,
  captions: string[],
  label: (captions: string[]) => Promise<string[]>
): Promise<UsedTopic[]> {
  if (captions.length === 0) return [];
  const batches: string[][] = [];
  for (let i = 0; i < captions.length; i += BACKFILL_BATCH) batches.push(captions.slice(i, i + BACKFILL_BATCH));
  const labelled = await Promise.all(
    batches.map((b) =>
      label(b)
        .then((t) => b.map((_, i) => (typeof t[i] === 'string' ? t[i] : '')))
        .catch((err) => {
          console.warn('caption topic backfill batch failed', err);
          return b.map(() => '');
        })
    )
  );
  const topics = labelled.flat();
  const out: UsedTopic[] = [];
  await Promise.all(
    captions.map(async (text, i) => {
      const topic = topics[i] || '';
      const key = topicKey(topic);
      if (!key) return;
      out.push({ topic: normalizeTopic(topic), keywords: topicKeywords(topic), text, scope: 'game' });
      await topicsOf(db, gameId)
        .doc(key)
        .set({ topic: normalizeTopic(topic), text, at: new Date(), backfilled: true }, { merge: true })
        .catch((err) => console.warn('caption topic backfill write failed', err));
    })
  );
  return out;
}

/** The reply shape to ask the judge for — topics keyed by candidate index, see parseJudgeVerdict. */
export const JUDGE_REPLY_FORMAT =
  `Reply as JSON: {"ranking": [<every candidate index, best first>], ` +
  `"topics": {"<candidate index>": "<that candidate's topic>", ...one entry per candidate}, ` +
  `"score": <0-100, how good your top pick is on its own merits — judge the writing itself, NOT how earlier messages were reacted to>}`;
