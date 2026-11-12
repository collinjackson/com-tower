/**
 * Optional highlight reel of the turn that just ended, from an external service (REEL_URL, with a
 * bearer token in REEL_TOKEN). When set, a "your turn" notification carries the reel as its image
 * (a GIF) in place of the usual chart. The service is anything that answers
 *   POST {url}  {"gameId": number, "day"?: number, "players"?: number}
 *     ->  {"gif": base64, "contentType"?: string, "filename"?: string}
 * Any failure, timeout or missing gif returns null, and the caller keeps its usual image.
 */
export type Reel = { dataB64: string; contentType: string; filename: string };

export function reelConfig(env: NodeJS.ProcessEnv = process.env): { url: string; token?: string } | null {
  const url = env.REEL_URL?.trim();
  return url ? { url, token: env.REEL_TOKEN?.trim() || undefined } : null;
}

export async function fetchReel(
  gameId: string | number,
  opts: { day?: number; players?: number },
  config = reelConfig(),
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 60000,
): Promise<Reel | null> {
  if (!config) return null;
  try {
    const res = await fetchImpl(config.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}) },
      body: JSON.stringify({ gameId: Number(gameId), day: opts.day, players: opts.players }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      console.warn(`Reel failed for game ${gameId}: ${res.status}`);
      return null;
    }
    const data = (await res.json()) as { gif?: string; contentType?: string; filename?: string; error?: string };
    if (typeof data?.gif !== 'string' || !data.gif) {
      if (data?.error) console.warn(`Reel skipped for game ${gameId}: ${data.error}`);
      return null;
    }
    return { dataB64: data.gif, contentType: data.contentType || 'image/gif', filename: data.filename || `reel-${gameId}.gif` };
  } catch (err) {
    console.warn(`Reel failed for game ${gameId}:`, err instanceof Error ? err.message : err);
    return null;
  }
}
