/**
 * Public admission-control contracts.
 *
 * A permit covers one active provider request, including response
 * streaming. RunCell acquires a permit before every provider request
 * (initial, after tools, children, repairs, retries, compaction) and
 * releases it when the response ends, before any tool runs. RunCell owns
 * the lease lifecycle; an {@link AdmissionAdapter} owns allocation, queue
 * ordering, storage, and scheduling decisions.
 */

/** One request for a permit. */
export interface AdmissionRequest {
  /** Resource pool the permit is drawn from. */
  pool: string;
  /** Workload inside the pool, or `undefined` for the pool's default. */
  workload: string | undefined;
  /** The RunCell run issuing the provider request. */
  runId: string;
  /** Unique id of this provider request. */
  requestId: string;
  /** The top-level run of the lineage (equals `runId` for a root run). */
  rootRunId: string;
  /** The run whose tool started this run, when it is a RunCell-managed child. */
  parentRunId: string | undefined;
  /** Application-defined scheduling metadata. Never contains prompts or credentials. */
  metadata: Readonly<Record<string, unknown>>;
  /**
   * Absolute admission deadline in epoch milliseconds on this worker's
   * clock, or `undefined` when the wait is unbounded.
   */
  deadline: number | undefined;
  /**
   * Remaining wait budget in milliseconds when `acquire` was called, or
   * `undefined` when unbounded. Backends with an authoritative clock (for
   * example a database) should derive their own deadline from this value
   * instead of comparing `deadline` against a different clock.
   */
  timeoutMs: number | undefined;
  /**
   * Aborted when the run is cancelled or the deadline passes. `acquire` must
   * stop waiting, leave no granted permit behind, and reject promptly.
   */
  signal: AbortSignal;
}

/** A granted permit. */
export interface AdmissionLease {
  /**
   * Unique identity of this grant. Never reused: a replacement lease for the
   * same request has a different id, so stale `renew`/`release` calls cannot
   * affect it.
   */
  readonly id: string;
  readonly pool: string;
  readonly workload: string | undefined;
  /**
   * Validity remaining, in milliseconds, when the backend produced this
   * lease. RunCell measures expiry on its own monotonic clock from the
   * moment it received the lease (acquire) or sent the renewal (renew), so
   * remote backends should subtract their expected one-way latency.
   */
  readonly ttlMs: number;
  /** Suggested delay before renewing, in milliseconds. Defaults to `ttlMs / 2`. */
  readonly renewAfterMs?: number;
}

export interface AdmissionRenewOptions {
  /** Aborted when RunCell stops waiting for the renewal. */
  signal: AbortSignal;
}

/** Identifies a pool and workload for eager validation. */
export interface AdmissionTarget {
  pool: string;
  workload: string | undefined;
}

/**
 * Admission backend contract. Implementations must provide:
 *
 * - Atomic capacity checks and allocation (no two callers granted the same
 *   capacity, across every worker sharing the backend).
 * - Expiring leases, reclaimable after `ttlMs` without renewal.
 * - Idempotent `renew` and `release`.
 * - Lease identities that keep stale operations from affecting replacement
 *   leases.
 * - Cancellation-safe `acquire`: when `signal` aborts, remove the queued
 *   request and reject with `signal.reason`; never leave a granted lease
 *   behind for an aborted request.
 * - Documented consistency and failure guarantees.
 *
 * Errors: reject with {@link AdmissionQueueFullError},
 * {@link AdmissionTimeoutError}, or {@link AdmissionConfigError} for those
 * conditions. Any other rejection is treated as a backend failure and the
 * run fails closed with {@link AdmissionBackendError}.
 */
export interface AdmissionAdapter {
  /** Obtain a permit, waiting until capacity is available or `signal` aborts. */
  acquire(request: AdmissionRequest): Promise<AdmissionLease>;
  /**
   * Extend a held lease. Resolve with the extended lease, or `undefined`
   * when the lease is no longer held (expired, released, or unknown). Reject
   * only for transient failures; RunCell retries until the lease expires.
   */
  renew(
    lease: AdmissionLease,
    options: AdmissionRenewOptions,
  ): Promise<AdmissionLease | undefined>;
  /** Return the permit. Must be idempotent and ignore unknown or stale leases. */
  release(lease: AdmissionLease): Promise<void>;
  /**
   * Optional eager validation of a pool/workload. Throw
   * {@link AdmissionConfigError} for an unknown target. Called before a run
   * starts any work.
   */
  validate?(target: AdmissionTarget): void;
}

/** Agent-level admission configuration. Admission is opt-in. */
export interface AdmissionOptions {
  /** The backend that grants permits, e.g. `createInMemoryScheduler(...)`. */
  adapter: AdmissionAdapter;
  /**
   * Pool for root runs of this agent. Defaults to `'default'`. A child run
   * started from a tool inherits its parent's pool and workload instead,
   * unless the child run selects one explicitly.
   */
  pool?: string;
  /** Workload for root runs of this agent. Defaults to the pool's default workload. */
  workload?: string;
  /** Scheduling metadata for root runs; merged under inherited and per-run metadata. */
  metadata?: Readonly<Record<string, unknown>>;
  /**
   * Maximum wait for one permit, in milliseconds. The effective deadline is
   * the earlier of this and the remaining run budget (`timeoutMs`).
   */
  maxWaitMs?: number;
  /**
   * How long RunCell waits for `release` before moving on, in milliseconds.
   * A release that fails or times out emits `cleanup-failed`; the lease's
   * expiry then recovers the capacity. Defaults to 5000.
   */
  cleanupTimeoutMs?: number;
}

/** Per-run admission overrides. */
export interface RunAdmissionOptions {
  /** Select a pool explicitly instead of inheriting it. */
  pool?: string;
  /** Select a workload explicitly instead of inheriting it. */
  workload?: string;
  /** Metadata merged over agent-level and inherited metadata. */
  metadata?: Readonly<Record<string, unknown>>;
  /** Overrides the agent-level `maxWaitMs` for this run. */
  maxWaitMs?: number;
}

interface AdmissionEventBase {
  pool: string;
  workload: string | undefined;
  runId: string;
  rootRunId: string;
  parentRunId: string | undefined;
  requestId: string;
  /** Epoch milliseconds when the event was emitted. */
  timestamp: number;
}

/** How a permit ended. */
export type AdmissionReleaseOutcome =
  'completed' | 'failed' | 'cancelled' | 'lease-lost';

/**
 * Structured admission lifecycle event. Events identify the pool, run
 * lineage, and request; they never contain prompts or credentials.
 */
export type AdmissionEvent =
  | (AdmissionEventBase & {
      type: 'wait-started';
      /** Epoch-ms deadline, when bounded. */
      deadline: number | undefined;
    })
  | (AdmissionEventBase & { type: 'acquired'; leaseId: string; waitMs: number })
  | (AdmissionEventBase & { type: 'timed-out'; waitMs: number })
  | (AdmissionEventBase & { type: 'queue-full'; waitMs: number })
  | (AdmissionEventBase & {
      type: 'backend-failed';
      waitMs: number;
      error: unknown;
    })
  | (AdmissionEventBase & { type: 'wait-cancelled'; waitMs: number })
  | (AdmissionEventBase & {
      type: 'released';
      leaseId: string;
      holdMs: number;
      outcome: AdmissionReleaseOutcome;
    })
  | (AdmissionEventBase & {
      type: 'renewal-failed';
      leaseId: string;
      error: unknown;
    })
  | (AdmissionEventBase & {
      type: 'lease-lost';
      leaseId: string;
      holdMs: number;
    })
  | (AdmissionEventBase & {
      type: 'cleanup-failed';
      leaseId: string;
      error: unknown;
    });
