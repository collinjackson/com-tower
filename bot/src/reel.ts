/**
 * Optional highlight reel of the turn that just ended, from an external service (REEL_URL, with a
 * bearer token in REEL_TOKEN). When set, a "your turn" notification carries the reel as its image
 * (a GIF) in place of the usual chart. The service is anything that answers
 *   POST {url}  {"gameId": number, "day"?: number, "players"?: number}
 *     ->  {"gif": base64, "contentType"?: string, "filename"?: string}
 * Any failure, timeout or missing gif returns null, and the caller keeps its usual image.
 * On Cloud Run the call also carries a Google identity token for the service's origin (from the
 * metadata server), so the service can stay private to this worker's account; elsewhere the
 * bearer token alone is sent.
 */
export type Reel = { dataB64: string; contentType: string; filename: string };

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
  opts: { day?: number; players?: number },
  config = reelConfig(),
  fetchImpl: typeof fetch = fetch,
  timeoutMs = config?.timeoutMs ?? DEFAULT_REEL_TIMEOUT_MS,
): Promise<Reel | null> {
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
