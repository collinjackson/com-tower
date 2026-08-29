import { NextResponse } from 'next/server';
import { getAdminDb, adminAvailable } from '@/lib/firebase-admin';
import { reactionScore, emojiList, type Reactions } from '@/lib/reactions';

// The public gallery: the best notifications Com Tower has actually sent, with every player
// name blacked out. Recomputed at most every 5 minutes — reactions trickle in far slower.
export const revalidate = 300;

const SHOWCASE_SIZE = 12;
// Six full blocks, fixed width. Not one block per character: bar length would leak name
// length, and with a four-player roster that is often enough to identify someone.
const BLOCK = '█'.repeat(6);
// Per game, how far back to look. Captions are one-per-turn, so this is generous.
const PER_GAME_LIMIT = 100;

type ShowcasePost = {
  text: string;
  emojis: string[];
  score: number;
  judgeScore: number | null;
  day: number | null;
  /** Only for ordering; stripped before the response. */
  at?: number;
  // Who called it in, for the display's overlay. Names of units and COs are public game
  // vocabulary, not player identities, so these are not redacted.
  speaker: string | null;
  army: string | null;
  armyName: string | null;
  spriteUrl: string | null;
};

/** Replace every roster name (and the game's name) with a solid bar.
 *  The real name never leaves the server — the bar is the substituted character, not styling
 *  over the truth, so copy-paste and view-source give up nothing. */
function redact(text: string, names: string[]): string {
  let out = text;
  // Longest first, so a name that contains a shorter one isn't half-redacted.
  const sorted = [...new Set(names.filter((n) => typeof n === 'string' && n.trim().length > 1))].sort(
    (a, b) => b.length - a.length
  );
  for (const name of sorted) {
    const esc = name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Bounded by non-word chars (underscore counts as part of a name, so \b won't do), and
    // eats a trailing possessive so we get a clean bar rather than █'s.
    out = out.replace(
      new RegExp(`(?<![A-Za-z0-9_])${esc}(?![A-Za-z0-9_])(['’]s)?`, 'gi'),
      BLOCK
    );
  }
  // Belt and braces: a caption should never contain a link, but if a model invented one it
  // does not reach the page.
  return out
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export async function GET() {
  if (!adminAvailable) return NextResponse.json({ posts: [] });

  try {
    const db = getAdminDb();

    // Opt-in only. A caption can quote group chatter, so publishing one is the group's call —
    // mods turn it on with /showcase on.
    const groupsSnap = await db.collection('groupGames').where('showcaseEnabled', '==', true).get();
    const allowedGroups = new Set(groupsSnap.docs.map((d) => (d.data() as { groupId?: string }).groupId));
    if (allowedGroups.size === 0) return NextResponse.json({ posts: [] });

    // listDocuments() also returns games that exist only as a parent of their subcollection.
    const gameRefs = await db.collection('games').listDocuments();
    const perGame = await Promise.all(
      gameRefs.map(async (ref) => {
        try {
          // Ordered by recency, not filtered on sentTimestamp: only posts sent since that
          // field existed would qualify, which left almost the whole history invisible. What
          // actually gates publication is the roster check below.
          const snap = await ref
            .collection('sentCaptions')
            .orderBy('createdAt', 'desc')
            .limit(PER_GAME_LIMIT)
            .get();
          return snap.docs;
        } catch {
          return [];
        }
      })
    );

    const posts: ShowcasePost[] = [];
    for (const doc of perGame.flat()) {
      const d = doc.data() as {
        text?: string;
        roster?: string[];
        gameName?: string | null;
        turnPlayer?: string | null;
        groupId?: string;
        reactions?: Reactions;
        judgeScore?: number | null;
        day?: number | null;
        createdAt?: { toMillis?: () => number };
        speakerName?: string | null;
        army?: string | null;
        armyName?: string | null;
        spriteUrl?: string | null;
      };
      // The roster is the safety gate, and it is not optional: without the names that were
      // in this game there is nothing to redact against, so an unrostered caption can never
      // be published no matter which group it came from.
      if (!d.text || !d.groupId || !allowedGroups.has(d.groupId)) continue;
      if (!Array.isArray(d.roster) || d.roster.length === 0) continue;
      const score = reactionScore(d.reactions);
      // Never showcase something the group actively disliked.
      if (score < 0) continue;
      const names = [...(d.roster || []), d.turnPlayer || '', d.gameName || ''];
      posts.push({
        text: redact(d.text, names),
        emojis: emojiList(d.reactions),
        score,
        judgeScore: typeof d.judgeScore === 'number' ? d.judgeScore : null,
        day: typeof d.day === 'number' && d.day > 0 ? d.day : null,
        at: d.createdAt?.toMillis?.() ?? 0,
        speaker: d.speakerName || null,
        army: d.army || null,
        armyName: d.armyName || null,
        spriteUrl: d.spriteUrl || null,
      });
    }

    // Reactions rank. The judge's score only breaks ties — it saw the reactions when it
    // picked, so leaning on it would count the same signal twice. Before any reactions
    // exist it is the whole ordering, which is what seeds the gallery on day one.
    // Reactions rank; the judge's score breaks ties; recency breaks the rest, so a long
    // unreacted history does not order itself arbitrarily.
    posts.sort(
      (a, b) =>
        b.score - a.score ||
        (b.judgeScore ?? -1) - (a.judgeScore ?? -1) ||
        (b.at ?? 0) - (a.at ?? 0)
    );

    return NextResponse.json({
      posts: posts.slice(0, SHOWCASE_SIZE).map(({ at: _at, ...post }) => post),
    });
  } catch (err) {
    console.error('showcase failed', err);
    return NextResponse.json({ posts: [] });
  }
}
