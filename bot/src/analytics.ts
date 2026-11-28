// Usage counts for the operator (PostHog), off unless POSTHOG_KEY is set (2026-11-27).
//
// What's sent: an event name, a one-way hash of the chat's id (never the id itself), the AWBW game
// id (public), the chat platform (signal, discord, slack…), and small counts or labels (which
// command, whether a turn video came back). Never message text, phone numbers, account ids or
// names. A self-hosted Com Tower
// sends nothing unless its operator sets POSTHOG_KEY. See README.md "Analytics".
//
// Fire and forget: an analytics failure is logged once in a while and never affects a message.
import { createHash } from 'node:crypto';

export type AnalyticsConfig = { key: string; host: string; salt: string };

export function analyticsConfig(env: Record<string, string | undefined> = process.env): AnalyticsConfig | null {
  const key = env.POSTHOG_KEY?.trim();
  if (!key) return null;
  return {
    key,
    host: (env.POSTHOG_HOST?.trim() || 'https://us.i.posthog.com').replace(/\/+$/, ''),
    // The hash's salt: the key itself unless set, so ids can't be matched across deployments.
    salt: env.ANALYTICS_SALT?.trim() || key,
  };
}

/** A stable, anonymous id for a group (or a DM sender): the salted SHA-256, shortened. */
export function anonId(kind: 'group' | 'dm', raw: string, salt: string): string {
  return `${kind}_${createHash('sha256').update(`${salt}:${raw}`).digest('hex').slice(0, 16)}`;
}

// Only these commands are reported by name; anything else is "other" (a typo can't leak text).
const COMMANDS = new Set(['/ping', '/help', '/game', '/language', '/lang', '/iam', '/setplayer', '/unsetplayer', '/forget',
  '/players', '/who', '/addmod', '/removemod', '/fun', '/stats', '/turntime', '/clock', '/thinktime', '/remind', '/status',
  '/sync', '/catchup', '/reel', '/retry', '/recap', '/stop', '/unwatch']);
export const commandName = (cmd: string) => (COMMANDS.has(cmd) ? cmd : 'other');

let failures = 0;

// The platform this worker serves (index.ts sets it at startup); "signal" until then.
let workerPlatform = 'signal';
export function setAnalyticsPlatform(platform: string): void {
  workerPlatform = platform;
}

/** The platform an event is about: the namespace of a Discord or Slack id ("discord:<channel>",
 *  "slack:<team>:<channel>"), else this worker's. */
export function platformOfId(id: string | undefined, fallback = workerPlatform): string {
  const m = id?.match(/^(discord|slack):/);
  return m ? m[1] : fallback;
}

/** Sends one event. who: {group} or {dm} (hashed here) or {game} (a public AWBW game id). */
export function track(
  event: string,
  who: { group?: string; dm?: string; game?: string | number },
  props: Record<string, string | number | boolean | null | undefined> = {},
  config = analyticsConfig(),
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!config) return Promise.resolve();
  const distinct = who.group ? anonId('group', who.group, config.salt)
    : who.dm ? anonId('dm', who.dm, config.salt)
    : `game_${who.game ?? 'unknown'}`;
  const body = {
    api_key: config.key,
    event,
    distinct_id: distinct,
    properties: { ...props, platform: platformOfId(who.group ?? who.dm), source: 'com-tower' },
    timestamp: new Date().toISOString(),
  };
  return fetchImpl(`${config.host}/i/v0/e/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  }).then((res) => {
    if (!res.ok && failures++ % 50 === 0) console.warn(`[analytics] ${event}: HTTP ${res.status}`);
  }).catch((err) => {
    if (failures++ % 50 === 0) console.warn(`[analytics] ${event}:`, err instanceof Error ? err.message : err);
  });
}
