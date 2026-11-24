// /language: a player's choice of language (or style) for the captions on turn videos. The
// commentator speaks the language of the player the ping is for (the one to move); a CO speaks
// its own player's, so one player's choice never puts another player's CO in it.

/** A /language argument: a short language or style name, or undefined for English ("off", "english"…).
 *  Letters, digits, spaces, - and ' only, at most 24 characters: it goes into the caption prompt
 *  (the reel service cleans it the same way). Emoji alone ("/language 😀") means emoji. */
export function parseLanguage(arg: string): string | undefined {
  const raw = arg.trim();
  const v = raw.replace(/[^\p{L}\p{N} \-'’]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 24).trim();
  if (!v && /\p{Extended_Pictographic}/u.test(raw)) return 'emoji';
  return !v || /^(off|none|english|en|reset|default)$/i.test(v) ? undefined : v;
}

/** The /language of a player (AWBW names match case-insensitively). */
export function languageOf(players: Record<string, { language?: string }> | undefined, awbwName?: string): string | undefined {
  if (!players || !awbwName) return undefined;
  const key = Object.keys(players).find((k) => k.toLowerCase() === awbwName.toLowerCase());
  return key ? players[key].language : undefined;
}

/** Every claimed player's /language that isn't English, {AWBW name: language}, or undefined if none. */
export function languagesOf(players: Record<string, { language?: string }> | undefined): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const [k, p] of Object.entries(players || {})) if (p?.language) out[k] = p.language;
  return Object.keys(out).length ? out : undefined;
}
