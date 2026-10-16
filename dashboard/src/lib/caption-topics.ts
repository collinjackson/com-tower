// Caption topics: the premise each fun-mode caption hinges on ("ladder", "music school"), kept
// per game so a bit is never reused. Repeat-avoidance used to mean pasting every sent caption
// into the generator's prompt, which taught the model to imitate them instead — with 66 prior
// captions in the prompt, 58 of 60 candidates opened "Cruiser here" (for a CO) and a quarter
// were the same ladder joke. Topics are short enough to list without priming, and the filter
// runs in code rather than relying on the judge to obey a rule.

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
    'commander command orders order advance attack unit units day turn time move new big bring'
  ).split(' ')
);

/** Lowercase letters and spaces only. */
export function normalizeTopic(topic: string): string {
  return topic.toLowerCase().replace(/[^a-z]+/g, ' ').trim();
}

/** The distinctive words of a topic, crudely singular so "ladders" and "ladder" meet. */
export function topicKeywords(topic: string): string[] {
  const words = normalizeTopic(topic)
    .split(' ')
    .filter((w) => w.length >= 3 && !GENERIC.has(w))
    .map(singular);
  return Array.from(new Set(words));
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

/** Candidates in the order to try them: the judge's ranking with used topics skipped. Empty
 *  when every candidate repeats a topic — the caller then sends the judge's top pick anyway,
 *  because a repeat beats a silent turn ping. */
export function eligibleInOrder(verdict: JudgeVerdict, used: Array<{ keywords: string[] }>): number[] {
  return verdict.ranking.filter((i) => !isTopicUsed(verdict.topics[i] || '', used));
}

/** The slice of Firestore this module touches, so tests can pass a fake. */
type Db = {
  collection(name: string): {
    doc(id: string): {
      collection(name: string): {
        doc(id: string): {
          create(data: Record<string, unknown>): Promise<unknown>;
          set(data: Record<string, unknown>, opts?: { merge?: boolean }): Promise<unknown>;
        };
        limit(n: number): { get(): Promise<{ docs: Array<{ data(): Record<string, unknown> }> }> };
      };
    };
  };
};

export type UsedTopic = { topic: string; keywords: string[] };

function topicsOf(db: Db, gameId: string) {
  return db.collection('games').doc(gameId).collection('captionTopics');
}

export async function loadUsedTopics(db: Db, gameId: string): Promise<UsedTopic[]> {
  const snap = await topicsOf(db, gameId).limit(500).get();
  return snap.docs
    .map((d) => d.data())
    .filter((d) => typeof d.topic === 'string')
    .map((d) => ({ topic: d.topic as string, keywords: topicKeywords(d.topic as string) }));
}

/** Claim a topic for this game. Atomic (create fails if it exists), so when two groups watch the
 *  same game and caption the same turn at once, only one of them can send the bit. Returns false
 *  only when someone else already holds it; a storage error must not cost the turn its caption. */
export async function claimTopic(db: Db, gameId: string, topic: string, text: string): Promise<boolean> {
  const key = topicKey(topic);
  if (!key) return true;
  try {
    await topicsOf(db, gameId).doc(key).create({ topic: normalizeTopic(topic), text, at: new Date() });
    return true;
  } catch (err) {
    if ((err as { code?: number })?.code === 6) return false; // ALREADY_EXISTS
    console.warn('caption topic claim failed', err);
    return true;
  }
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
      out.push({ topic: normalizeTopic(topic), keywords: topicKeywords(topic) });
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
