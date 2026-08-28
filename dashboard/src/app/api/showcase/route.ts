import { NextResponse } from 'next/server';
import { getAdminDb, adminAvailable } from '@/lib/firebase-admin';
import { reactionScore, emojiList, type Reactions } from '@/lib/reactions';

// The public gallery: the best notifications Com Tower has actually sent, with every player
// name blacked out. Recomputed at most every 5 minutes — reactions trickle in far slower.
export const revalidate = 300;

const SHOWCASE_SIZE = 5;
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
          // Only posts the bot confirmed it sent — those are the ones a reaction can name.
          const snap = await ref
            .collection('sentCaptions')
            .where('sentTimestamp', '>', 0)
            .orderBy('sentTimestamp', 'desc')
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
      };
      if (!d.text || !d.groupId || !allowedGroups.has(d.groupId)) continue;
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
      });
    }

    // Reactions rank. The judge's score only breaks ties — it saw the reactions when it
    // picked, so leaning on it would count the same signal twice. Before any reactions
    // exist it is the whole ordering, which is what seeds the gallery on day one.
    posts.sort(
      (a, b) => b.score - a.score || (b.judgeScore ?? -1) - (a.judgeScore ?? -1)
    );

    return NextResponse.json({ posts: posts.slice(0, SHOWCASE_SIZE) });
  } catch (err) {
    console.error('showcase failed', err);
    return NextResponse.json({ posts: [] });
  }
}
