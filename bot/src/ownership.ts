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

// Backend for leader-election. Kept abstract so leader mode works over a Firestore doc lock now
// (local + prod) and can swap to a k8s coordination.k8s.io/Lease later without touching the
// strategy. tryAcquire renews-or-acquires and returns the current holder after the attempt.
export interface LeaseStore {
  // `key` names the role being contended (e.g. 'leader', 'receiver') so one backend can hold
  // several independent elections. Returns the current holder after the attempt.
  tryAcquire(key: string, holderId: string, ttlMs: number): Promise<string | null>;
  release(key: string, holderId: string): Promise<void>;
}

export interface OwnershipDeps {
  leaseStore?: LeaseStore;
  holderId?: string;
}

// Minimal shape of a Firestore query/collection ref — lets ownership narrow the listener without
// importing firebase-admin. Both CollectionReference and Query satisfy it.
export interface Shardable {
  where(field: string, op: any, value: any): Shardable;
}

// Extend the interface with a way to narrow the collection listener to just this replica's slice.
export interface Ownership {
  /** Narrow a groupGames query to only the docs this replica should watch. Passthrough unless
   *  sharding (leader/singleton must see all docs — a leader owns them all when elected). */
  narrowSnapshotQuery<Q extends Shardable>(q: Q): Q;
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

// Stable shard key in [0, 1) for a game. Stored on each groupGames doc so the listener can be
// range-partitioned per replica; also computed live for owns(). Range partitioning means rescaling
// SHARD_COUNT just moves boundaries — no doc re-bucketing, and no Firestore `in`/bucket limits.
export function shardKeyFor(gameId: string): number {
  return hashToInt(gameId) / 4294967296; // 2**32
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
  narrowSnapshotQuery<Q extends Shardable>(q: Q): Q {
    return q; // singleton watches everything
  }
  async start(): Promise<void> {}
  stop(): void {}
}

interface ShardOpts { store?: LeaseStore; holderId?: string; ttlMs?: number; renewMs?: number }

class ShardOwnership implements Ownership {
  readonly mode = 'shard' as const;
  private readonly lo: number;
  private readonly hi: number;
  // The Signal receiver is one role across ALL shards. Elect it (HA) when a lease backend is
  // available, so if the current receiver's pod dies another shard picks it up — instead of a
  // static shard-0 receiver that's a single point of failure. Falls back to shard-0 with no lease.
  private readonly receiverElection: LeaseElection | null;
  constructor(private readonly index: number, private readonly count: number, opts: ShardOpts = {}) {
    if (!Number.isInteger(index) || !Number.isInteger(count) || count < 1 || index < 0 || index >= count) {
      throw new Error(`Invalid shard config: SHARD_INDEX=${index} SHARD_COUNT=${count}`);
    }
    // This replica owns the half-open shardKey range [index/count, (index+1)/count).
    this.lo = index / count;
    this.hi = (index + 1) / count;
    this.receiverElection = opts.store
      ? new LeaseElection(opts.store, 'receiver', opts.holderId || `shard-${index}`, opts.ttlMs ?? 10000, opts.renewMs ?? 3000)
      : null;
  }
  owns(gameId: string): boolean {
    const k = shardKeyFor(gameId);
    return k >= this.lo && k < this.hi;
  }
  isReceiver(): boolean {
    return this.receiverElection ? this.receiverElection.isLeader() : this.index === 0;
  }
  onChange(cb: () => void): void {
    // Game ownership is static (SHARD_COUNT change = redeploy), but the receiver role can move —
    // fire so main() can start/stop the receiver on this replica.
    this.receiverElection?.onChange(cb);
  }
  narrowSnapshotQuery<Q extends Shardable>(q: Q): Q {
    // Only subscribe to our slice — so listener memory + Firestore read load scale with replicas
    // instead of every replica streaming the whole collection. shardKey<1 always, so `< hi` at
    // hi=1.0 still captures the top shard. Single-field range: no composite index needed.
    return q.where('shardKey', '>=', this.lo).where('shardKey', '<', this.hi) as Q;
  }
  async start(): Promise<void> {
    if (this.receiverElection) await this.receiverElection.start();
  }
  stop(): void {
    this.receiverElection?.stop();
  }
}

// Reusable "elect one holder among N for a role" primitive over a LeaseStore. Both leader mode
// (role = all the work) and shard mode (role = the singleton Signal receiver) use it, keyed by role.
class LeaseElection {
  private leader = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private cbs: Array<() => void> = [];
  constructor(
    private readonly store: LeaseStore,
    private readonly key: string,
    private readonly holderId: string,
    private readonly ttlMs: number,
    private readonly renewMs: number
  ) {}
  isLeader(): boolean {
    return this.leader;
  }
  onChange(cb: () => void): void {
    this.cbs.push(cb);
  }
  private async renew(): Promise<void> {
    let holder: string | null = null;
    try {
      holder = await this.store.tryAcquire(this.key, this.holderId, this.ttlMs);
    } catch (err) {
      // Fail safe: drop the role rather than risk two holders (split brain).
      console.error(`[ownership] lease '${this.key}' renew failed`, err);
      holder = null;
    }
    const now = holder === this.holderId;
    if (now !== this.leader) {
      this.leader = now;
      console.log(`[ownership] role '${this.key}' ${now ? 'ACQUIRED' : 'LOST'} by ${this.holderId}`);
      for (const cb of this.cbs) {
        try { cb(); } catch (e) { console.error('[ownership] onChange cb failed', e); }
      }
    }
  }
  async start(): Promise<void> {
    await this.renew(); // resolve the role before the caller wires up work
    this.timer = setInterval(() => { this.renew().catch(() => {}); }, this.renewMs);
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.leader) this.store.release(this.key, this.holderId).catch(() => {});
  }
}

class LeaderOwnership implements Ownership {
  readonly mode = 'leader' as const;
  private readonly election: LeaseElection;
  constructor(store: LeaseStore, holderId: string, ttlMs: number, renewMs: number) {
    this.election = new LeaseElection(store, 'leader', holderId, ttlMs, renewMs);
  }
  owns(): boolean {
    return this.election.isLeader();
  }
  isReceiver(): boolean {
    return this.election.isLeader(); // the single receiver runs on the leader
  }
  onChange(cb: () => void): void {
    this.election.onChange(cb);
  }
  narrowSnapshotQuery<Q extends Shardable>(q: Q): Q {
    return q; // every replica watches all docs so a standby can take over instantly on failover
  }
  async start(): Promise<void> {
    return this.election.start();
  }
  stop(): void {
    this.election.stop();
  }
}

// In a StatefulSet the pod name is `<name>-<ordinal>`; derive the shard index from HOSTNAME
// when SHARD_INDEX isn't set explicitly.
function resolveShardIndex(): number {
  if (process.env.SHARD_INDEX !== undefined) return Number(process.env.SHARD_INDEX);
  const m = /-(\d+)$/.exec(process.env.HOSTNAME || '');
  if (m) return Number(m[1]);
  throw new Error('shard mode: set SHARD_INDEX or run as a StatefulSet pod (HOSTNAME=name-N)');
}

export function createOwnership(deps: OwnershipDeps = {}): Ownership {
  const mode = (process.env.SCALING_MODE || 'singleton') as ScalingMode;
  switch (mode) {
    case 'singleton':
      return new SingletonOwnership();
    case 'shard':
      return new ShardOwnership(resolveShardIndex(), Number(process.env.SHARD_COUNT || '1'), {
        store: deps.leaseStore, // present => receiver is lease-elected (HA); absent => static shard-0
        holderId: deps.holderId || process.env.LEADER_ID || `${process.env.HOSTNAME || 'local'}-${process.pid}`,
        ttlMs: Number(process.env.LEADER_TTL_MS || '10000'),
        renewMs: Number(process.env.LEADER_RENEW_MS || '3000'),
      });
    case 'leader': {
      if (!deps.leaseStore) throw new Error('SCALING_MODE=leader requires a LeaseStore');
      const holderId = deps.holderId || process.env.LEADER_ID || `${process.env.HOSTNAME || 'local'}-${process.pid}`;
      const ttlMs = Number(process.env.LEADER_TTL_MS || '10000');
      const renewMs = Number(process.env.LEADER_RENEW_MS || '3000');
      return new LeaderOwnership(deps.leaseStore, holderId, ttlMs, renewMs);
    }
    default:
      throw new Error(`Unknown SCALING_MODE: ${mode}`);
  }
}
