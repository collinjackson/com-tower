// /language: a player's choice of language (or style) for the captions on their turn videos.

/** A /language argument: a short language or style, or undefined for English ("off", "english"…). */
export function parseLanguage(arg: string): string | undefined {
  const v = arg.trim().slice(0, 40);
  return !v || /^(off|none|english|en|reset|default)$/i.test(v) ? undefined : v;
}

/** The /language of the player whose turn it is (AWBW names match case-insensitively). */
export function languageOf(players: Record<string, { language?: string }> | undefined, awbwName?: string): string | undefined {
  if (!players || !awbwName) return undefined;
  const key = Object.keys(players).find((k) => k.toLowerCase() === awbwName.toLowerCase());
  return key ? players[key].language : undefined;
}
