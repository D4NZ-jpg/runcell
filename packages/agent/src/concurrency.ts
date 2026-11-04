/**
 * Public concurrency-limit contracts.
 *
 * A slot covers one active provider request, including response streaming.
 * RunCell takes a slot before every provider request: initial turns, turns
 * after tools, repairs, retries, compaction, and child agents. It gives the
 * slot back when the response ends, before any tool runs. RunCell owns the
 * slot lifecycle. A {@link ConcurrencyLimiter} owns allocation, queue order,
 * and storage.
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
  /** The limiter serves higher values first among workloads with room. Default 0. */
  priority?: number;
  /**
   * Longest a request may wait for a slot, in milliseconds. The run's
   * remaining `timeoutMs` bounds it further.
   */
  maxWaitMs?: number;
}

/**
 * Capacity settings shared by the built-in limiters. `W` is the union of
 * workload names, inferred from the `workloads` keys.
 */
export interface ConcurrencyLimits<W extends string = string> {
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
  workloads?: Readonly<Record<W, ConcurrencyWorkload>>;
  /**
   * Workload for requests that select none. Defaults to `default` when that
   * workload exists, or to the only workload. Otherwise agents and runs must
   * select a workload.
   */
  defaultWorkload?: NoInfer<W>;
}

/** Active and queued slot counts, overall and by workload. */
export interface ConcurrencyStats<W extends string = string> {
  active: number;
  queued: number;
  workloads: Record<W, { active: number; queued: number }>;
}

/**
 * Agent-level concurrency limit. Opt-in. TypeScript gets `W` from the
 * limiter, so `workload` accepts only that limiter's workload names.
 */
export interface ConcurrencyOptions<W extends string = string> {
  /** The shared capacity, e.g. `createConcurrencyLimiter({ maxConcurrent: 8 })`. */
  limiter: ConcurrencyLimiter<W>;
  /**
   * Workload for this agent's runs. A run started from another run's tool
   * keeps its parent's workload when both use the same limiter.
   */
  workload?: NoInfer<W>;
  /**
   * Application-defined data passed to the limiter with every request (for
   * custom limiters). Never put prompts or credentials here.
   */
  metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Per-run concurrency selection. Overrides agent-level and inherited values.
 * To use a different limiter, create an agent configured with it.
 */
export interface RunConcurrencyOptions<W extends string = string> {
  /** Workload for this run: one of the agent limiter's workload names. */
  workload?: W;
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
  /** Epoch milliseconds when RunCell emitted the event. */
  timestamp: number;
}

/**
 * Structured slot lifecycle event, delivered to `events.onConcurrency`.
 * Events identify the limiter, workload, run lineage, and request. They
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
export interface ConcurrencyRequest<W extends string = string> {
  /** Workload selected by the run, or `undefined` for the limiter's default. */
  workload: W | undefined;
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
   * Remaining run budget in milliseconds at the call to `acquire`, or
   * `undefined` when the run has no `timeoutMs`. A limiter must apply the
   * earlier of this value and the workload's own wait limit.
   */
  timeoutMs: number | undefined;
  /**
   * Aborts on run cancellation or at the end of the run's budget. Then
   * `acquire` must stop waiting, leave no slot behind, and reject promptly.
   */
  signal: AbortSignal;
}

/** A granted slot. */
export interface ConcurrencyLease<W extends string = string> {
  /**
   * Unique identity of this grant. Never reused, so stale `renew` or
   * `release` calls cannot affect a later lease.
   */
  readonly id: string;
  /** The workload that holds the slot. */
  readonly workload: W | undefined;
  /**
   * Validity remaining, in milliseconds, when the limiter made the lease.
   * RunCell measures expiry on its own clock. It starts when RunCell gets
   * the lease from `acquire`, or when it sends the `renew` call. Thus, a
   * remote limiter must subtract its round-trip time.
   */
  readonly ttlMs: number;
  /** Suggested delay before renewing, in milliseconds. Defaults to `ttlMs / 2`. */
  readonly renewAfterMs?: number;
}

/**
 * The limiter contract. Implement it to back concurrency limits with your
 * own coordinator. The built-in `createConcurrencyLimiter` and
 * `@runcell/postgres-concurrency` cover the common cases.
 *
 * An implementation must:
 * - allocate atomically, so that no two callers get the same slot across
 *   all workers that share the limiter
 * - give leases that expire
 * - make `renew` and `release` idempotent
 * - never use a lease id again
 * - make `acquire` safe to cancel
 *
 * For those conditions, reject with `ConcurrencyQueueFullError`,
 * `ConcurrencyTimeoutError`, or `ConcurrencyConfigError`. RunCell treats
 * any other rejection as a limiter failure, and the run fails closed. Use
 * `runcell/concurrency` to examine conformance.
 */
export interface ConcurrencyLimiter<W extends string = string> {
  /** Name used in events and errors. */
  readonly name: string;
  /**
   * The workload names this limiter serves. Built-in limiters always set
   * it. Agents use it to get the valid `workload` values. Omit it in a
   * custom limiter that accepts any workload name.
   */
  readonly workloads?: readonly W[];
  /** Wait for a slot until one is free or `signal` aborts. */
  acquire(request: ConcurrencyRequest<W>): Promise<ConcurrencyLease<W>>;
  /**
   * Extend a held lease. Resolve with the extended lease, or `undefined`
   * when the limiter no longer holds the lease. Reject only for transient
   * failures. RunCell tries again until the lease expires.
   */
  renew(
    lease: ConcurrencyLease<W>,
    options: { signal: AbortSignal },
  ): Promise<ConcurrencyLease<W> | undefined>;
  /** Give the slot back. Idempotent. Ignore unknown or stale leases. */
  release(lease: ConcurrencyLease<W>): Promise<void>;
  /**
   * Throw `ConcurrencyConfigError` for a workload this limiter cannot serve.
   * RunCell calls this before a run starts any work.
   */
  validateWorkload?(workload: W | undefined): void;
  /** Current slot counts, when the limiter can report them. */
  stats?(): Promise<ConcurrencyStats<W>>;
}
