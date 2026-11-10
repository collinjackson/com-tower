/**
 * Optional strategy notes from an external service (STRATEGY_NOTE_URL, with a bearer token in
 * STRATEGY_NOTE_TOKEN). When set, a "your turn" notification carries the service's note about the
 * position instead of the usual caption. The service is anything that answers
 *   POST {url}  {"gameId": number, "playerName"?: string, "audience"?: "all" | "team"}  ->  {"text": string}
 * audience "all" (default): the chat holds every side, so the note must not coach one of them.
 * Any failure, timeout or empty text returns null, and the caller sends its usual message.
 */
export type StrategyNote = { text: string; send?: boolean; why?: string[] };

export function strategyNoteConfig(env: NodeJS.ProcessEnv = process.env): { url: string; token?: string } | null {
  const url = env.STRATEGY_NOTE_URL?.trim();
  return url ? { url, token: env.STRATEGY_NOTE_TOKEN?.trim() || undefined } : null;
}

export async function fetchStrategyNote(
  gameId: string | number,
  playerName: string | undefined,
  config = strategyNoteConfig(),
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 8000,
): Promise<StrategyNote | null> {
  if (!config) return null;
  try {
    const res = await fetchImpl(config.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
      },
      body: JSON.stringify({ gameId: Number(gameId), playerName, audience: 'all' }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      console.warn(`Strategy note failed for game ${gameId}: ${res.status}`);
      return null;
    }
    const data = (await res.json()) as Partial<StrategyNote>;
    return typeof data?.text === 'string' && data.text.trim() ? { text: data.text.trim(), send: data.send, why: data.why } : null;
  } catch (err) {
    console.warn(`Strategy note failed for game ${gameId}:`, err instanceof Error ? err.message : err);
    return null;
  }
}
