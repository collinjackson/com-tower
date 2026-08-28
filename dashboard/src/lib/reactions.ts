// Emoji reaction weighting — the single source of truth for "did this message land?".
// Used by the showcase ranking AND by the caption judge's prompt, so the two can never
// drift into disagreeing about what a 👎 means.

/** Reactions as stored on a sentCaptions doc: reactor ACI -> emoji. One per person
 *  (Signal replaces a person's reaction rather than stacking), so removes are idempotent. */
export type Reactions = Record<string, string>;

// Unambiguous "this landed" reactions.
export const STRONG_POSITIVE = ['😂', '🤣', '❤️', '🔥', '💯', '👏', '🎉', '😍', '🙌'];
// Unambiguous "this flopped" reactions. A message drawing these must never outrank a
// message drawing nothing — the whole point of weighting instead of counting.
export const NEGATIVE = ['👎', '💩', '🤮', '🙄', '🥱', '😐', '❌', '😴'];

const STRONG_POSITIVE_WEIGHT = 1;
const NEGATIVE_WEIGHT = -1;
// Anything we don't recognize. Bothering to react at all is engagement, so it counts —
// but weakly, so one novel emoji can't outrank a genuine 😂. Flip this to 0 if an
// unrecognized negative emoji ever sneaks something onto the front page.
const UNKNOWN_WEIGHT = 0.25;

/** Strip variation selectors / ZWJ padding so '❤️' and '❤' compare equal. */
function canon(emoji: string): string {
  return emoji.replace(/[︎️]/g, '').trim();
}

const POSITIVE_SET = new Set(STRONG_POSITIVE.map(canon));
const NEGATIVE_SET = new Set(NEGATIVE.map(canon));

export function emojiWeight(emoji: string): number {
  const e = canon(emoji);
  if (!e) return 0;
  if (NEGATIVE_SET.has(e)) return NEGATIVE_WEIGHT;
  if (POSITIVE_SET.has(e)) return STRONG_POSITIVE_WEIGHT;
  return UNKNOWN_WEIGHT;
}

/** Net weight of every reaction on one post. Can go negative. */
export function reactionScore(reactions?: Reactions | null): number {
  if (!reactions) return 0;
  return Object.values(reactions).reduce(
    (sum, e) => sum + (typeof e === 'string' ? emojiWeight(e) : 0),
    0
  );
}

/** The emoji themselves, most-common first — for display under a showcased post. */
export function emojiList(reactions?: Reactions | null): string[] {
  if (!reactions) return [];
  const counts = new Map<string, number>();
  for (const e of Object.values(reactions)) {
    if (typeof e !== 'string' || !e.trim()) continue;
    counts.set(e, (counts.get(e) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).flatMap(([e, n]) => Array(n).fill(e));
}

/** One line the judge can read, e.g. "😂 🔥 mean it landed; 👎 🙄 mean it fell flat". */
export const JUDGE_EMOJI_LEGEND =
  `${STRONG_POSITIVE.join(' ')} mean it landed; ${NEGATIVE.join(' ')} mean it fell flat`;
