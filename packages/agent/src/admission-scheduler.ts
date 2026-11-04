import { randomUUID } from 'node:crypto';
import type {
  AdmissionAdapter,
  AdmissionLease,
  AdmissionRequest,
  AdmissionTarget,
} from './admission.js';
import {
  normalizeAdmissionPolicy,
  resolveAdmissionTarget,
  selectAdmissionGrants,
  workloadPolicy,
  type AdmissionPolicy,
  type NormalizedAdmissionPolicy,
  type NormalizedPoolPolicy,
} from './admission-policy.js';
import {
  AdmissionConfigError,
  AdmissionQueueFullError,
  AdmissionTimeoutError,
} from './errors.js';

/** Active and queued counts for one pool, by workload. */
export interface AdmissionPoolStats {
  pool: string;
  active: number;
  queued: number;
  workloads: Record<string, { active: number; queued: number }>;
}

interface SchedulerEventBase {
  pool: string;
  /** Epoch milliseconds when the event was emitted. */
  timestamp: number;
}

interface SchedulerRequestEventBase extends SchedulerEventBase {
  workload: string;
  requestId: string;
  runId: string;
  rootRunId: string;
}

/**
 * Scheduler-side event. Counting `queue-full` and `wait-expired` events
 * gives queue-full and admission-timeout counts; `granted` and `released`
 * carry the pool's active count after the change.
 */
export type AdmissionSchedulerEvent =
  | (SchedulerRequestEventBase & { type: 'queued'; queued: number })
  | (SchedulerRequestEventBase & {
      type: 'granted';
      leaseId: string;
      waitMs: number;
      active: number;
    })
  | (SchedulerRequestEventBase & { type: 'queue-full'; queued: number })
  | (SchedulerRequestEventBase & { type: 'wait-expired'; waitMs: number })
  | (SchedulerRequestEventBase & { type: 'wait-cancelled'; waitMs: number })
  | (SchedulerEventBase & {
      type: 'lease-expired';
      workload: string;
      leaseId: string;
    })
  | (SchedulerEventBase & {
      type: 'released';
      workload: string;
      leaseId: string;
      active: number;
    })
  | (SchedulerEventBase & {
      type: 'backend-error';
      operation: string;
      error: unknown;
    })
  | (SchedulerEventBase & { type: 'config-conflict'; error: unknown });

/** A RunCell scheduler: an admission adapter driven by an {@link AdmissionPolicy}. */
export interface AdmissionScheduler extends AdmissionAdapter {
  /** The validated policy this scheduler enforces. */
  readonly policy: NormalizedAdmissionPolicy;
  /** Current active and queued counts for a pool. */
  stats(pool: string): Promise<AdmissionPoolStats>;
  validate(target: AdmissionTarget): void;
}

export interface InMemorySchedulerOptions {
  policy: AdmissionPolicy;
  /** Lease validity without renewal, in milliseconds. Defaults to 30000. */
  leaseTtlMs?: number;
  /** Observes scheduler events. A throwing listener is ignored. */
  onEvent?: (event: AdmissionSchedulerEvent) => void;
}

interface MemoryLease {
  id: string;
  workload: string;
  expiresAt: number;
}

interface MemoryWaiter {
  id: string;
  workload: string;
  seq: number;
  request: AdmissionRequest;
  enqueuedAt: number;
  settle(result: { lease: AdmissionLease } | { error: unknown }): void;
}

interface MemoryPool {
  name: string;
  policy: NormalizedPoolPolicy;
  leases: Map<string, MemoryLease>;
  waiters: Map<string, MemoryWaiter>;
  expiryTimer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * In-process scheduler and reference admission adapter. Enforces the full
 * policy (pool and workload limits, strict reservations, priority, FIFO,
 * bounded queue, wait deadlines) for every agent in this process.
 *
 * Consistency: all state lives in this process and every operation runs
 * synchronously on the event loop, so allocation is atomic. It does not
 * coordinate across processes; use `@runcell/postgres-admission` for that.
 * State is lost when the process exits, which also ends every request it
 * admitted.
 */
export function createInMemoryScheduler(
  options: InMemorySchedulerOptions,
): AdmissionScheduler {
  const policy = normalizeAdmissionPolicy(options.policy);
  const leaseTtlMs = options.leaseTtlMs ?? 30_000;
  if (!Number.isSafeInteger(leaseTtlMs) || leaseTtlMs < 1) {
    throw new AdmissionConfigError('"leaseTtlMs" must be a positive integer.');
  }
  const emit = (event: AdmissionSchedulerEvent) => {
    try {
      options.onEvent?.(event);
    } catch {
      // Observers never affect scheduling.
    }
  };
  const pools = new Map<string, MemoryPool>();
  let seq = 0;

  const getPool = (
    name: string,
    poolPolicy: NormalizedPoolPolicy,
  ): MemoryPool => {
    let pool = pools.get(name);
    if (!pool) {
      pool = {
        name,
        policy: poolPolicy,
        leases: new Map(),
        waiters: new Map(),
        expiryTimer: undefined,
      };
      pools.set(name, pool);
    }
    return pool;
  };

  const purgeExpired = (pool: MemoryPool, now: number) => {
    for (const lease of pool.leases.values()) {
      if (lease.expiresAt <= now) {
        pool.leases.delete(lease.id);
        emit({
          type: 'lease-expired',
          pool: pool.name,
          workload: lease.workload,
          leaseId: lease.id,
          timestamp: now,
        });
      }
    }
  };

  const toLease = (pool: MemoryPool, lease: MemoryLease): AdmissionLease => ({
    id: lease.id,
    pool: pool.name,
    workload: lease.workload,
    ttlMs: Math.max(0, lease.expiresAt - Date.now()),
  });

  const armExpiryTimer = (pool: MemoryPool) => {
    if (pool.expiryTimer) {
      clearTimeout(pool.expiryTimer);
      pool.expiryTimer = undefined;
    }
    if (pool.waiters.size === 0 || pool.leases.size === 0) {
      return;
    }
    let next = Infinity;
    for (const lease of pool.leases.values()) {
      next = Math.min(next, lease.expiresAt);
    }
    pool.expiryTimer = setTimeout(
      () => {
        pool.expiryTimer = undefined;
        schedule(pool);
      },
      Math.max(0, next - Date.now()),
    );
  };

  const schedule = (pool: MemoryPool) => {
    const now = Date.now();
    purgeExpired(pool, now);
    const active = new Map<string, number>();
    for (const lease of pool.leases.values()) {
      active.set(lease.workload, (active.get(lease.workload) ?? 0) + 1);
    }
    const grants = selectAdmissionGrants(pool.policy, active, [
      ...pool.waiters.values(),
    ]);
    for (const id of grants) {
      const waiter = pool.waiters.get(id);
      if (!waiter) continue;
      pool.waiters.delete(id);
      const lease: MemoryLease = {
        id: randomUUID(),
        workload: waiter.workload,
        expiresAt: now + leaseTtlMs,
      };
      pool.leases.set(lease.id, lease);
      emit({
        type: 'granted',
        ...requestEventBase(pool, waiter, now),
        leaseId: lease.id,
        waitMs: now - waiter.enqueuedAt,
        active: pool.leases.size,
      });
      waiter.settle({ lease: toLease(pool, lease) });
    }
    armExpiryTimer(pool);
  };

  const requestEventBase = (
    pool: MemoryPool,
    waiter: MemoryWaiter,
    now: number,
  ) => ({
    pool: pool.name,
    workload: waiter.workload,
    requestId: waiter.request.requestId,
    runId: waiter.request.runId,
    rootRunId: waiter.request.rootRunId,
    timestamp: now,
  });

  return {
    policy,

    validate(target) {
      resolveAdmissionTarget(policy, target.pool, target.workload);
    },

    acquire(request) {
      return new Promise<AdmissionLease>((resolve, reject) => {
        const target = resolveAdmissionTarget(
          policy,
          request.pool,
          request.workload,
        );
        const { signal } = request;
        if (signal.aborted) {
          reject(abortReason(signal));
          return;
        }
        const pool = getPool(request.pool, target.pool);
        const enqueuedAt = Date.now();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const onAbort = () => {
          if (!pool.waiters.delete(waiter.id)) {
            return;
          }
          const now = Date.now();
          emit({
            type: 'wait-cancelled',
            ...requestEventBase(pool, waiter, now),
            waitMs: now - enqueuedAt,
          });
          waiter.settle({ error: abortReason(signal) });
          armExpiryTimer(pool);
        };
        const waiter: MemoryWaiter = {
          id: randomUUID(),
          workload: target.workload,
          seq: (seq += 1),
          request,
          enqueuedAt,
          settle(result) {
            if (timer) {
              clearTimeout(timer);
            }
            signal.removeEventListener('abort', onAbort);
            if ('lease' in result) {
              resolve(result.lease);
            } else {
              reject(toError(result.error));
            }
          },
        };
        pool.waiters.set(waiter.id, waiter);
        signal.addEventListener('abort', onAbort, { once: true });
        schedule(pool);
        if (!pool.waiters.has(waiter.id)) {
          return;
        }

        const now = Date.now();
        const maxQueued = target.pool.maxQueued;
        if (maxQueued !== undefined && pool.waiters.size > maxQueued) {
          pool.waiters.delete(waiter.id);
          emit({
            type: 'queue-full',
            ...requestEventBase(pool, waiter, now),
            queued: pool.waiters.size,
          });
          waiter.settle({
            error: new AdmissionQueueFullError(
              `Admission queue for pool "${request.pool}" is full (${maxQueued} waiting).`,
              { pool: request.pool, workload: target.workload },
            ),
          });
          armExpiryTimer(pool);
          return;
        }
        emit({
          type: 'queued',
          ...requestEventBase(pool, waiter, now),
          queued: pool.waiters.size,
        });

        const workloadWait = workloadPolicy(
          target.pool,
          target.workload,
        ).maxWaitMs;
        const waitMs = minDefined(request.timeoutMs, workloadWait);
        if (waitMs !== undefined) {
          timer = setTimeout(
            () => {
              if (!pool.waiters.delete(waiter.id)) {
                return;
              }
              const expiredAt = Date.now();
              emit({
                type: 'wait-expired',
                ...requestEventBase(pool, waiter, expiredAt),
                waitMs: expiredAt - enqueuedAt,
              });
              waiter.settle({
                error: new AdmissionTimeoutError(
                  `Admission wait limit reached for pool "${request.pool}" after ${expiredAt - enqueuedAt} ms.`,
                  { pool: request.pool, workload: target.workload },
                ),
              });
              armExpiryTimer(pool);
            },
            Math.max(0, waitMs),
          );
        }
      });
    },

    renew(lease) {
      const pool = pools.get(lease.pool);
      if (!pool) {
        return Promise.resolve(undefined);
      }
      const now = Date.now();
      const held = pool.leases.get(lease.id);
      if (!held || held.expiresAt <= now) {
        // Expiry may have freed capacity for waiters.
        schedule(pool);
        return Promise.resolve(undefined);
      }
      held.expiresAt = now + leaseTtlMs;
      armExpiryTimer(pool);
      return Promise.resolve(toLease(pool, held));
    },

    release(lease) {
      const pool = pools.get(lease.pool);
      if (!pool) {
        return Promise.resolve();
      }
      const held = pool.leases.get(lease.id);
      if (held) {
        pool.leases.delete(lease.id);
        emit({
          type: 'released',
          pool: pool.name,
          workload: held.workload,
          leaseId: held.id,
          active: pool.leases.size,
          timestamp: Date.now(),
        });
      }
      schedule(pool);
      return Promise.resolve();
    },

    stats(name) {
      const poolPolicy = Object.hasOwn(policy.pools, name)
        ? policy.pools[name]
        : undefined;
      if (!poolPolicy) {
        return Promise.reject(
          new AdmissionConfigError(`Unknown admission pool "${name}".`, {
            pool: name,
          }),
        );
      }
      const pool = pools.get(name);
      if (pool) {
        purgeExpired(pool, Date.now());
      }
      const workloads: AdmissionPoolStats['workloads'] = {};
      const entry = (name: string) =>
        (workloads[name] ??= { active: 0, queued: 0 });
      for (const workload of Object.keys(poolPolicy.workloads)) {
        entry(workload);
      }
      for (const lease of pool?.leases.values() ?? []) {
        entry(lease.workload).active += 1;
      }
      for (const waiter of pool?.waiters.values() ?? []) {
        entry(waiter.workload).queued += 1;
      }
      return Promise.resolve({
        pool: name,
        active: pool?.leases.size ?? 0,
        queued: pool?.waiters.size ?? 0,
        workloads,
      });
    },
  };
}

/** Abort reasons are arbitrary values; reject with them unchanged. */
function abortReason(signal: AbortSignal): Error {
  return signal.reason as Error;
}

function toError(value: unknown): Error {
  return value as Error;
}

function minDefined(
  a: number | undefined,
  b: number | undefined,
): number | undefined {
  if (a === undefined) {
    return b;
  }
  return b === undefined ? a : Math.min(a, b);
}
