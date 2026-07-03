// Ownership: which replica is responsible for a given game's work, and whether this replica
// runs the singleton Signal receive poller. This unifies the three scaling strategies behind a
// single SCALING_MODE env so leader-election and sharding are one code path, not two features.
//
//   SCALING_MODE = singleton | leader | shard
//     singleton  - one replica owns everything (replicas:1). Default; current behavior.
//     shard      - games partitioned by hash across SHARD_COUNT replicas; each owns its slice.
//     leader     - one elected leader owns everything; others are hot standby. (see leader impl)
//
// The rest of the bot consults `owns(gameId)` before opening a socket / doing a game's work, and
// `isReceiver()` before running the single Signal receive poller. `onChange` lets a dynamic
// strategy (leader) tell the bot to re-evaluate which games it should be watching.

export type ScalingMode = 'singleton' | 'leader' | 'shard';

export interface Ownership {
  readonly mode: ScalingMode;
  /** May this replica open a socket / do work for this game? */
  owns(gameId: string): boolean;
  /** May this replica run the singleton Signal receive poller? */
  isReceiver(): boolean;
  /** Register a callback fired when ownership changes (leadership won/lost, shard set changed). */
  onChange(cb: () => void): void;
  /** Start background work (e.g. lease renewal). No-op for static strategies. */
  start(): Promise<void>;
  /** Stop background work. */
  stop(): void;
}

// FNV-1a: cheap, stable, no crypto dependency. Same input -> same shard on every replica.
function hashToInt(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

class SingletonOwnership implements Ownership {
  readonly mode = 'singleton' as const;
  owns(): boolean {
    return true;
  }
  isReceiver(): boolean {
    return true;
  }
  onChange(): void {
    /* never changes */
  }
  async start(): Promise<void> {}
  stop(): void {}
}

class ShardOwnership implements Ownership {
  readonly mode = 'shard' as const;
  constructor(private readonly index: number, private readonly count: number) {
    if (!Number.isInteger(index) || !Number.isInteger(count) || count < 1 || index < 0 || index >= count) {
      throw new Error(`Invalid shard config: SHARD_INDEX=${index} SHARD_COUNT=${count}`);
    }
  }
  owns(gameId: string): boolean {
    return hashToInt(gameId) % this.count === this.index;
  }
  isReceiver(): boolean {
    // The singleton receive poller runs on shard 0 (a later refinement can leader-elect it).
    return this.index === 0;
  }
  onChange(): void {
    /* static: SHARD_COUNT change = a redeploy, not a runtime event */
  }
  async start(): Promise<void> {}
  stop(): void {}
}

// In a StatefulSet the pod name is `<name>-<ordinal>`; derive the shard index from HOSTNAME
// when SHARD_INDEX isn't set explicitly.
function resolveShardIndex(): number {
  if (process.env.SHARD_INDEX !== undefined) return Number(process.env.SHARD_INDEX);
  const m = /-(\d+)$/.exec(process.env.HOSTNAME || '');
  if (m) return Number(m[1]);
  throw new Error('shard mode: set SHARD_INDEX or run as a StatefulSet pod (HOSTNAME=name-N)');
}

export function createOwnership(): Ownership {
  const mode = (process.env.SCALING_MODE || 'singleton') as ScalingMode;
  switch (mode) {
    case 'singleton':
      return new SingletonOwnership();
    case 'shard':
      return new ShardOwnership(resolveShardIndex(), Number(process.env.SHARD_COUNT || '1'));
    case 'leader':
      // Implemented in a follow-up commit (Firestore/k8s-Lease election). Fail loud until then
      // rather than silently behaving like a singleton.
      throw new Error("SCALING_MODE=leader not yet implemented; use 'singleton' or 'shard'");
    default:
      throw new Error(`Unknown SCALING_MODE: ${mode}`);
  }
}
