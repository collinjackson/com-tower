/**
 * Optional highlight reel of the turn that just ended, from an external service (REEL_URL, with a
 * bearer token in REEL_TOKEN). When set, a "your turn" notification carries the reel as its image
 * (a GIF) in place of the usual chart. The service is anything that answers
 *   POST {url}  {"gameId": number, "day"?: number, "players"?: number, "recent"?: string[], "language"?: string,
 *                "languages"?: {[awbwName]: string}, "toMove"?: string, "fresh"?: true}
 *     ->  {"gif": base64, "contentType"?: string, "filename"?: string, "captions"?: string[]}
 * `recent` is the caption lines already shown in this game (the service avoids repeating them);
 * `captions` is the lines this reel shows, for the caller to remember. `languages` is every player's
 * /language and `toMove` the player to move (the commentator speaks theirs, each CO its own player's);
 * `language` alone is the player to move's, for services that write every line in one.
 * SELF_HOST.md ("Turn videos") documents the contract for anyone writing their own service.
 * An answer without a gif (e.g. {"error": "no finished turn found"} on day 1, before anyone has
 * moved) returns NO_REEL: there was nothing to record, so the caller sends its usual ping.
 * A real failure (bad status, timeout, exception) returns null, and the caller sends a fail whale.
 * `fresh` asks for a new recording even when the service has this turn cached (/reel, after a fix
 * to the reel).
 * On Cloud Run the call also carries a Google identity token for the service's origin (from the
 * metadata server), so the service can stay private to this worker's account; elsewhere the
 * bearer token alone is sent.
 */
export type Reel = { dataB64: string; contentType: string; filename: string; captions: string[] };

/** The service answered but had no reel to give (nothing to record yet). */
export const NO_REEL = 'none' as const;

/** How many recent caption lines a game remembers and sends with each reel request. */
export const RECENT_CAPTIONS = 60;

/** The remembered lines after a reel: the old ones plus the new, newest last, capped. */
export function rememberCaptions(recent: string[], shown: string[], cap = RECENT_CAPTIONS): string[] {
  return [...recent, ...shown].slice(-cap);
}

/** The text when the reel can't be shown (it failed to record, or the image wouldn't send): a fail
 *  whale aimed at the player to move, not a description of the game; the reel is the description.
 *  The sender puts the player's chat mention in front when they have one. */
export function failWhale(link: string, player?: string): string {
  return `${player ? `${player}: ` : ''}\u{1F433} The newscast got lost on the way. "The image translators work for the `
    + `construct program, but there's way too much information to decode." Raw feed: ${link}`;
}

/** A reel takes about a minute to record, so the ping waits up to REEL_TIMEOUT_MS (100 s). */
export const DEFAULT_REEL_TIMEOUT_MS = 100_000;

export function reelConfig(env: NodeJS.ProcessEnv = process.env): { url: string; token?: string; timeoutMs?: number } | null {
  const url = env.REEL_URL?.trim();
  const t = Number(env.REEL_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(t) && t > 0 ? t : DEFAULT_REEL_TIMEOUT_MS;
  return url ? { url, token: env.REEL_TOKEN?.trim() || undefined, timeoutMs } : null;
}

/** A Google identity token for `audience`, from the metadata server; undefined off Google Cloud. */
export async function identityToken(audience: string, fetchImpl: typeof fetch = fetch): Promise<string | undefined> {
  try {
    const u = `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(audience)}`;
    const res = await fetchImpl(u, { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(2000) });
    return res.ok ? (await res.text()).trim() || undefined : undefined;
  } catch {
    return undefined;
  }
}

export async function fetchReel(
  gameId: string | number,
  opts: { day?: number; players?: number; recent?: string[]; language?: string; languages?: Record<string, string>; toMove?: string; fresh?: boolean },
  config = reelConfig(),
  fetchImpl: typeof fetch = fetch,
  timeoutMs = config?.timeoutMs ?? DEFAULT_REEL_TIMEOUT_MS,
): Promise<Reel | typeof NO_REEL | null> {
  if (!config) return null;
  try {
    // Cloud Run's IAM reads Authorization; the service's own token then rides in X-Reel-Token.
    const id = await identityToken(new URL(config.url).origin, fetchImpl);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (id) headers.Authorization = `Bearer ${id}`;
    if (config.token) {
      headers['X-Reel-Token'] = config.token;
      if (!id) headers.Authorization = `Bearer ${config.token}`;
    }
    const res = await fetchImpl(config.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ gameId: Number(gameId), day: opts.day, players: opts.players, recent: opts.recent?.length ? opts.recent : undefined, language: opts.language || undefined,
        languages: opts.languages, toMove: opts.languages ? opts.toMove : undefined, fresh: opts.fresh || undefined }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      console.warn(`Reel failed for game ${gameId}: ${res.status}`);
      return null;
    }
    const data = (await res.json()) as { gif?: string; contentType?: string; filename?: string; error?: string; captions?: unknown };
    if (typeof data?.gif !== 'string' || !data.gif) {
      if (data?.error) console.warn(`Reel skipped for game ${gameId}: ${data.error}`);
      return NO_REEL;
    }
    const captions = Array.isArray(data.captions) ? data.captions.filter((c): c is string => typeof c === 'string') : [];
    return { dataB64: data.gif, contentType: data.contentType || 'image/gif', filename: data.filename || `reel-${gameId}.gif`, captions };
  } catch (err) {
    console.warn(`Reel failed for game ${gameId}:`, err instanceof Error ? err.message : err);
    return null;
  }
}
