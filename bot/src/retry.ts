/**
 * Retrying a turn ping that couldn't be sent. The hourly turn poll catches it eventually, but a
 * messaging daemon that failed once (a full disk, a restart) is often fine minutes later: retry
 * sooner, a few times, then leave it to the poll.
 */
export const SEND_RETRY_DELAYS_MS = [2, 5, 15, 30].map((m) => m * 60 * 1000);

/** Delay before retry number `attempt` (0-based), or null when the retries are used up. */
export function sendRetryDelay(attempt: number, delays: readonly number[] = SEND_RETRY_DELAYS_MS): number | null {
  return attempt >= 0 && attempt < delays.length ? delays[attempt] : null;
}

/** Per-group retry bookkeeping: one pending timer a group, attempts counted until a send lands. */
export class SendRetries {
  private attempts = new Map<string, number>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  private readonly retry: (key: string) => Promise<void>;
  private readonly delays: readonly number[];
  private readonly schedule: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;

  constructor(
    retry: (key: string) => Promise<void>,
    delays: readonly number[] = SEND_RETRY_DELAYS_MS,
    schedule: (fn: () => void, ms: number) => ReturnType<typeof setTimeout> = setTimeout,
  ) {
    this.retry = retry;
    this.delays = delays;
    this.schedule = schedule;
  }

  /** A send for `key` failed: schedule the next retry. Returns the delay, or null if done. */
  failed(key: string): number | null {
    if (this.timers.has(key)) return null;
    const n = this.attempts.get(key) ?? 0;
    const ms = sendRetryDelay(n, this.delays);
    if (ms === null) {
      this.attempts.delete(key);
      return null;
    }
    this.attempts.set(key, n + 1);
    this.timers.set(key, this.schedule(() => {
      this.timers.delete(key);
      void this.retry(key).catch(() => {});
    }, ms));
    return ms;
  }

  /** A send for `key` landed: forget its retries. */
  succeeded(key: string): void {
    this.attempts.delete(key);
    const t = this.timers.get(key);
    if (t) clearTimeout(t);
    this.timers.delete(key);
  }
}
