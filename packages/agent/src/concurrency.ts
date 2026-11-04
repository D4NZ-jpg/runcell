/**
 * Public concurrency-limit contracts.
 *
 * A slot covers one active provider request, including response streaming.
 * RunCell takes a slot before every provider request (initial turns, turns
 * after tools, repairs, retries, compaction, child agents) and gives it back
 * when the response ends, before any tool runs. RunCell owns the slot
 * lifecycle; a {@link ConcurrencyLimiter} owns allocation, queue order, and
 * storage.
 */

/** Settings for one workload of a limiter. */
export interface ConcurrencyWorkload {
  /** Ceiling for this workload's active slots. Defaults to the limiter's `maxConcurrent`. */
  maxConcurrent?: number;
  /**
   * Slots only this workload can use, counted inside the limiter's
   * `maxConcurrent`. They stay idle rather than being lent. Default 0.
   */
  reserved?: number;
  /** Higher values are served first among workloads with room. Default 0. */
  priority?: number;
  /**
   * Longest a request may wait for a slot, in milliseconds. The run's
   * remaining `timeoutMs` bounds it further.
   */
  maxWaitMs?: number;
}

/** Capacity settings shared by the built-in limiters. */
export interface ConcurrencyLimits {
  /** Maximum provider requests in flight at once. Positive integer. */
  maxConcurrent: number;
  /**
   * Maximum requests waiting for a slot. Requests beyond it fail with
   * `ConcurrencyQueueFullError`. Omit for an unbounded queue.
   */
  maxQueued?: number;
  /**
   * Named workloads sharing the capacity. Omit for a single `default`
   * workload that may use every slot.
   */
  workloads?: Readonly<Record<string, ConcurrencyWorkload>>;
  /**
   * Workload for requests that select none. Defaults to `default` when that
   * workload exists, or to the only workload. Otherwise agents and runs must
   * select a workload.
   */
  defaultWorkload?: string;
}

/** Active and queued slot counts, overall and by workload. */
export interface ConcurrencyStats {
  active: number;
  queued: number;
  workloads: Record<string, { active: number; queued: number }>;
}

/** Agent-level concurrency limit. Opt-in. */
export interface ConcurrencyOptions {
  /** The shared capacity, e.g. `createConcurrencyLimiter({ maxConcurrent: 8 })`. */
  limiter: ConcurrencyLimiter;
  /**
   * Workload for this agent's runs. A run started from another run's tool
   * keeps its parent's workload when both use the same limiter.
   */
  workload?: string;
  /**
   * Application-defined data passed to the limiter with every request (for
   * custom limiters). Never put prompts or credentials here.
   */
  metadata?: Readonly<Record<string, unknown>>;
}

/** Per-run concurrency selection. Overrides agent-level and inherited values. */
export interface RunConcurrencyOptions {
  /** Use a different limiter for this run. */
  limiter?: ConcurrencyLimiter;
  /** Workload for this run. */
  workload?: string;
  /** Metadata merged over agent-level and inherited metadata. */
  metadata?: Readonly<Record<string, unknown>>;
}

/** How a slot ended. */
export type ConcurrencyReleaseOutcome =
  'completed' | 'failed' | 'cancelled' | 'lease-lost';

interface ConcurrencyEventBase {
  /** The limiter's `name`. */
  limiter: string;
  workload: string | undefined;
  runId: string;
  rootRunId: string;
  parentRunId: string | undefined;
  /** Unique id of the provider request. */
  requestId: string;
  /** Epoch milliseconds when the event was emitted. */
  timestamp: number;
}

/**
 * Structured slot lifecycle event, delivered to `events.onConcurrency`.
 * Events identify the limiter, workload, run lineage, and request; they
 * never contain prompts or credentials.
 */
export type ConcurrencyEvent =
  | (ConcurrencyEventBase & {
      type: 'wait-started';
      /** Epoch-ms deadline from the run's `timeoutMs`, when set. */
      deadline: number | undefined;
    })
  | (ConcurrencyEventBase & {
      type: 'acquired';
      leaseId: string;
      waitMs: number;
    })
  | (ConcurrencyEventBase & { type: 'timed-out'; waitMs: number })
  | (ConcurrencyEventBase & { type: 'queue-full'; waitMs: number })
  | (ConcurrencyEventBase & { type: 'wait-cancelled'; waitMs: number })
  | (ConcurrencyEventBase & {
      type: 'limiter-error';
      waitMs: number;
      error: unknown;
    })
  | (ConcurrencyEventBase & { type: 'config-error'; error: unknown })
  | (ConcurrencyEventBase & {
      type: 'released';
      leaseId: string;
      holdMs: number;
      outcome: ConcurrencyReleaseOutcome;
    })
  | (ConcurrencyEventBase & {
      type: 'renewal-failed';
      leaseId: string;
      error: unknown;
    })
  | (ConcurrencyEventBase & {
      type: 'lease-lost';
      leaseId: string;
      holdMs: number;
    })
  | (ConcurrencyEventBase & {
      type: 'release-failed';
      leaseId: string;
      error: unknown;
    });

/** One request for a slot. */
export interface ConcurrencyRequest {
  /** Workload selected by the run, or `undefined` for the limiter's default. */
  workload: string | undefined;
  /** The RunCell run issuing the provider request. */
  runId: string;
  /** Unique id of this provider request. */
  requestId: string;
  /** The top-level run of the lineage (equals `runId` for a root run). */
  rootRunId: string;
  /** The run whose tool started this run, when it is a child. */
  parentRunId: string | undefined;
  /** Application-defined metadata. */
  metadata: Readonly<Record<string, unknown>>;
  /**
   * Remaining run budget in milliseconds when `acquire` was called, or
   * `undefined` when the run has no `timeoutMs`. Limiters should combine it
   * with the workload's own wait limit.
   */
  timeoutMs: number | undefined;
  /**
   * Aborted when the run is cancelled or its budget runs out. `acquire` must
   * stop waiting, leave no slot behind, and reject promptly.
   */
  signal: AbortSignal;
}

/** A granted slot. */
export interface ConcurrencyLease {
  /**
   * Unique identity of this grant. Never reused, so stale `renew` or
   * `release` calls cannot affect a later lease.
   */
  readonly id: string;
  /** The workload the slot was granted to. */
  readonly workload: string | undefined;
  /**
   * Validity remaining, in milliseconds, when the limiter produced the
   * lease. RunCell measures expiry on its own clock from when it received the
   * lease (acquire) or sent the renewal (renew), so remote limiters should
   * subtract their round-trip time.
   */
  readonly ttlMs: number;
  /** Suggested delay before renewing, in milliseconds. Defaults to `ttlMs / 2`. */
  readonly renewAfterMs?: number;
}

/**
 * The limiter contract. Implement it to back concurrency limits with your
 * own coordinator; the built-in `createConcurrencyLimiter` and
 * `@runcell/postgres-concurrency` cover the common cases.
 *
 * An implementation must provide atomic allocation (no two callers get the
 * same slot, across every worker sharing it), expiring leases, idempotent
 * `renew` and `release`, never-reused lease ids, and cancellation-safe
 * `acquire`. Reject with `ConcurrencyQueueFullError`,
 * `ConcurrencyTimeoutError`, or `ConcurrencyConfigError` for those
 * conditions; any other rejection is treated as a limiter failure and the
 * run fails closed. Check conformance with `runcell/concurrency`.
 */
export interface ConcurrencyLimiter {
  /** Name used in events and errors. */
  readonly name: string;
  /** Wait for a slot until one is free or `signal` aborts. */
  acquire(request: ConcurrencyRequest): Promise<ConcurrencyLease>;
  /**
   * Extend a held lease. Resolve with the extended lease, or `undefined`
   * when the lease is no longer held. Reject only for transient failures;
   * RunCell retries until the lease expires.
   */
  renew(
    lease: ConcurrencyLease,
    options: { signal: AbortSignal },
  ): Promise<ConcurrencyLease | undefined>;
  /** Give the slot back. Idempotent; ignores unknown or stale leases. */
  release(lease: ConcurrencyLease): Promise<void>;
  /**
   * Throw `ConcurrencyConfigError` for a workload this limiter cannot serve.
   * Called before a run starts any work.
   */
  validateWorkload?(workload: string | undefined): void;
  /** Current slot counts, when the limiter can report them. */
  stats?(): Promise<ConcurrencyStats>;
}
