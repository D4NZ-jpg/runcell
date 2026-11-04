import { randomUUID } from 'node:crypto';
import type {
  ConcurrencyLease,
  ConcurrencyLimiter,
  ConcurrencyLimits,
  ConcurrencyRequest,
  ConcurrencyStats,
} from './concurrency.js';
import {
  resolveConcurrencyLimits,
  resolveWorkload,
  selectConcurrencyGrants,
  type ResolvedConcurrencyLimits,
} from './concurrency-policy.js';
import {
  ConcurrencyConfigError,
  ConcurrencyQueueFullError,
  ConcurrencyTimeoutError,
} from './errors.js';

export interface ConcurrencyLimiterOptions<
  W extends string = string,
> extends ConcurrencyLimits<W> {
  /** Name used in events and errors. Defaults to `'default'`. */
  name?: string;
  /**
   * How long a slot stays valid without renewal, in milliseconds. RunCell
   * renews automatically while a request runs. Defaults to 30000.
   */
  leaseTtlMs?: number;
}

/**
 * A built-in limiter: the contract plus its resolved limits and live counts.
 * `W` is the union of its workload names.
 */
export interface InMemoryConcurrencyLimiter<
  W extends string = string,
> extends ConcurrencyLimiter<W> {
  readonly workloads: readonly W[];
  readonly limits: ResolvedConcurrencyLimits<W>;
  validateWorkload(workload: W | undefined): void;
  stats(): Promise<ConcurrencyStats<W>>;
}

interface Slot {
  id: string;
  workload: string;
  expiresAt: number;
}

interface Waiter<W extends string> {
  id: string;
  workload: string;
  seq: number;
  settle(result: { lease: ConcurrencyLease<W> } | { error: Error }): void;
}

/**
 * An in-process concurrency limit shared by every agent that uses it:
 * `maxConcurrent` provider requests at once, with optional workloads,
 * strict reservations, priorities, a bounded queue, and wait limits.
 *
 * All state lives in this process and every operation runs synchronously on
 * the event loop, so allocation is atomic. It does not coordinate across
 * processes; use `@runcell/postgres-concurrency` for several workers.
 *
 * ```ts
 * const limiter = createConcurrencyLimiter({ maxConcurrent: 4 });
 * const agent = createAgent({ model, concurrency: { limiter } });
 * ```
 */
export function createConcurrencyLimiter<W extends string = 'default'>(
  options: ConcurrencyLimiterOptions<W>,
): InMemoryConcurrencyLimiter<W> {
  const limits = resolveConcurrencyLimits(options);
  const workloadNames = Object.keys(limits.workloads) as W[];
  const name = options.name ?? 'default';
  if (typeof name !== 'string' || name.length === 0) {
    throw new ConcurrencyConfigError('"name" must be a non-empty string.');
  }
  const leaseTtlMs = options.leaseTtlMs ?? 30_000;
  if (!Number.isSafeInteger(leaseTtlMs) || leaseTtlMs < 1) {
    throw new ConcurrencyConfigError(
      '"leaseTtlMs" must be a positive integer.',
      {
        limiter: name,
      },
    );
  }

  const slots = new Map<string, Slot>();
  const waiters = new Map<string, Waiter<W>>();
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let seq = 0;

  const purgeExpired = (now: number) => {
    for (const slot of slots.values()) {
      if (slot.expiresAt <= now) {
        slots.delete(slot.id);
      }
    }
  };

  const toLease = (slot: Slot): ConcurrencyLease<W> => ({
    id: slot.id,
    // Slots are only created for resolved workload names.
    workload: slot.workload as W,
    ttlMs: Math.max(1, slot.expiresAt - Date.now()),
  });

  // Wake waiters when the earliest held lease expires unrenewed.
  const armExpiryTimer = () => {
    clearTimeout(expiryTimer);
    expiryTimer = undefined;
    if (waiters.size === 0 || slots.size === 0) {
      return;
    }
    let next = Infinity;
    for (const slot of slots.values()) {
      next = Math.min(next, slot.expiresAt);
    }
    expiryTimer = setTimeout(
      () => {
        expiryTimer = undefined;
        schedule();
      },
      Math.max(0, next - Date.now()),
    );
  };

  const schedule = () => {
    const now = Date.now();
    purgeExpired(now);
    const active = new Map<string, number>();
    for (const slot of slots.values()) {
      active.set(slot.workload, (active.get(slot.workload) ?? 0) + 1);
    }
    for (const id of selectConcurrencyGrants(limits, active, [
      ...waiters.values(),
    ])) {
      const waiter = waiters.get(id);
      if (!waiter) continue;
      waiters.delete(id);
      const slot: Slot = {
        id: randomUUID(),
        workload: waiter.workload,
        expiresAt: now + leaseTtlMs,
      };
      slots.set(slot.id, slot);
      waiter.settle({ lease: toLease(slot) });
    }
    armExpiryTimer();
  };

  const configError = (error: unknown): Error =>
    error instanceof ConcurrencyConfigError
      ? new ConcurrencyConfigError(error.message, {
          limiter: name,
          ...(error.workload !== undefined ? { workload: error.workload } : {}),
        })
      : (error as Error);

  return {
    name,
    workloads: workloadNames,
    limits,

    validateWorkload(workload) {
      try {
        resolveWorkload(limits, workload);
      } catch (error) {
        throw configError(error);
      }
    },

    acquire(request: ConcurrencyRequest<W>) {
      return new Promise<ConcurrencyLease<W>>((resolve, reject) => {
        let workload: ReturnType<typeof resolveWorkload>;
        try {
          workload = resolveWorkload(limits, request.workload);
        } catch (error) {
          reject(configError(error));
          return;
        }
        const { signal } = request;
        if (signal.aborted) {
          reject(signal.reason as Error);
          return;
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        const onAbort = () => {
          if (waiters.delete(waiter.id)) {
            // Abort reasons are rejected unchanged, whatever their type.
            waiter.settle({ error: signal.reason as Error });
            armExpiryTimer();
          }
        };
        const waiter: Waiter<W> = {
          id: randomUUID(),
          workload: workload.name,
          seq: (seq += 1),
          settle(result) {
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
            if ('lease' in result) {
              resolve(result.lease);
            } else {
              reject(result.error);
            }
          },
        };
        waiters.set(waiter.id, waiter);
        signal.addEventListener('abort', onAbort, { once: true });
        schedule();
        if (!waiters.has(waiter.id)) {
          return;
        }

        if (limits.maxQueued !== undefined && waiters.size > limits.maxQueued) {
          waiters.delete(waiter.id);
          waiter.settle({
            error: new ConcurrencyQueueFullError(
              `Concurrency queue "${name}" is full (${limits.maxQueued} waiting).`,
              { limiter: name, workload: workload.name },
            ),
          });
          armExpiryTimer();
          return;
        }

        const waitMs = minDefined(
          request.timeoutMs,
          workload.settings.maxWaitMs,
        );
        if (waitMs !== undefined) {
          const enqueuedAt = Date.now();
          timer = setTimeout(
            () => {
              if (!waiters.delete(waiter.id)) {
                return;
              }
              waiter.settle({
                error: new ConcurrencyTimeoutError(
                  `No "${name}" concurrency slot was free after ${Date.now() - enqueuedAt} ms.`,
                  { limiter: name, workload: workload.name },
                ),
              });
              armExpiryTimer();
            },
            Math.max(0, waitMs),
          );
        }
      });
    },

    renew(lease) {
      const slot = slots.get(lease.id);
      if (!slot || slot.expiresAt <= Date.now()) {
        // Its expiry may have freed a slot for waiters.
        schedule();
        return Promise.resolve(undefined);
      }
      slot.expiresAt = Date.now() + leaseTtlMs;
      armExpiryTimer();
      return Promise.resolve(toLease(slot));
    },

    release(lease) {
      slots.delete(lease.id);
      schedule();
      return Promise.resolve();
    },

    stats() {
      purgeExpired(Date.now());
      const workloads = {} as ConcurrencyStats<W>['workloads'];
      const entry = (workload: string) =>
        ((workloads as Record<string, { active: number; queued: number }>)[
          workload
        ] ??= { active: 0, queued: 0 });
      for (const workload of Object.keys(limits.workloads)) {
        entry(workload);
      }
      for (const slot of slots.values()) {
        entry(slot.workload).active += 1;
      }
      for (const waiter of waiters.values()) {
        entry(waiter.workload).queued += 1;
      }
      return Promise.resolve({
        active: slots.size,
        queued: waiters.size,
        workloads,
      });
    },
  };
}

function minDefined(
  a: number | undefined,
  b: number | undefined,
): number | undefined {
  if (a === undefined) return b;
  return b === undefined ? a : Math.min(a, b);
}
