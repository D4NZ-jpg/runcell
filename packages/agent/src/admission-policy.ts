import { AdmissionConfigError } from './errors.js';

/**
 * Scheduler policy: pools, workload ceilings, strict reservations,
 * priorities, and bounded queues. The same policy and the same allocation
 * algorithm ({@link selectAdmissionGrants}) drive every RunCell scheduler
 * backend, so in-memory and distributed deployments behave identically.
 */
export interface AdmissionPolicy {
  pools: Readonly<Record<string, AdmissionPoolPolicy>>;
}

export interface AdmissionPoolPolicy {
  /** Maximum valid active permits in the pool. Positive integer. */
  maxConcurrent: number;
  /**
   * Maximum waiting requests across the pool. Requests beyond it fail with
   * `AdmissionQueueFullError`. Omit for an unbounded queue.
   */
  maxQueued?: number;
  /**
   * Workloads keyed by name. Omit for a single implicit `default` workload
   * that may use the whole pool.
   */
  workloads?: Readonly<Record<string, AdmissionWorkloadPolicy>>;
  /**
   * Workload used when a request names none. Defaults to `'default'` when
   * that workload exists; otherwise requests must name a workload.
   */
  defaultWorkload?: string;
}

export interface AdmissionWorkloadPolicy {
  /** Ceiling for this workload's active permits. Defaults to the pool limit. */
  maxConcurrent?: number;
  /**
   * Strictly reserved permits, counted inside the pool limit. Other
   * workloads cannot use them even when this workload is idle. Default 0.
   */
  reserved?: number;
  /** Higher values are granted first among eligible workloads. Default 0. */
  priority?: number;
  /** Maximum admission wait for this workload, in milliseconds. */
  maxWaitMs?: number;
}

export interface NormalizedWorkloadPolicy {
  maxConcurrent: number;
  reserved: number;
  priority: number;
  maxWaitMs: number | undefined;
}

export interface NormalizedPoolPolicy {
  maxConcurrent: number;
  maxQueued: number | undefined;
  defaultWorkload: string | undefined;
  workloads: Readonly<Record<string, NormalizedWorkloadPolicy>>;
}

export interface NormalizedAdmissionPolicy {
  pools: Readonly<Record<string, NormalizedPoolPolicy>>;
}

export const DEFAULT_WORKLOAD = 'default';

function fail(message: string, pool?: string, workload?: string): never {
  throw new AdmissionConfigError(message, {
    ...(pool !== undefined ? { pool } : {}),
    ...(workload !== undefined ? { workload } : {}),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function positiveInt(value: unknown, label: string, pool: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fail(
      `${label} must be a positive integer, received: ${String(value)}`,
      pool,
    );
  }
  return value as number;
}

function nonNegativeInt(value: unknown, label: string, pool: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail(
      `${label} must be a non-negative integer, received: ${String(value)}`,
      pool,
    );
  }
  return value as number;
}

/**
 * Validate a policy and fill defaults. Throws {@link AdmissionConfigError}
 * for negative or non-integer limits, workload ceilings above the pool
 * limit, reservations above their workload ceiling, total reservations
 * above the pool limit, and unknown default workloads.
 */
export function normalizeAdmissionPolicy(
  policy: AdmissionPolicy,
): NormalizedAdmissionPolicy {
  if (!isRecord(policy) || !isRecord(policy.pools)) {
    fail('Admission policy must have a "pools" object.');
  }
  const poolNames = Object.keys(policy.pools);
  if (poolNames.length === 0) {
    fail('Admission policy must define at least one pool.');
  }
  const pools: Record<string, NormalizedPoolPolicy> = {};
  for (const name of poolNames) {
    if (name.length === 0) {
      fail('Admission pool names must be non-empty.');
    }
    const raw: unknown = policy.pools[name];
    if (!isRecord(raw)) {
      fail(`Admission pool "${name}" must be an object.`, name);
    }
    const label = `Admission pool "${name}"`;
    const maxConcurrent = positiveInt(
      raw['maxConcurrent'],
      `${label} maxConcurrent`,
      name,
    );
    const maxQueued =
      raw['maxQueued'] === undefined
        ? undefined
        : nonNegativeInt(raw['maxQueued'], `${label} maxQueued`, name);

    const rawWorkloads: unknown = raw['workloads'];
    const workloadEntries: [string, unknown][] =
      rawWorkloads === undefined
        ? [[DEFAULT_WORKLOAD, {}]]
        : isRecord(rawWorkloads)
          ? Object.entries(rawWorkloads)
          : fail(`${label} workloads must be an object.`, name);
    if (workloadEntries.length === 0) {
      fail(`${label} must define at least one workload.`, name);
    }

    const workloads: Record<string, NormalizedWorkloadPolicy> = {};
    let totalReserved = 0;
    for (const [workloadName, rawWorkload] of workloadEntries) {
      const wLabel = `${label} workload "${workloadName}"`;
      if (workloadName.length === 0) {
        fail(`${label} workload names must be non-empty.`, name);
      }
      if (!isRecord(rawWorkload)) {
        fail(`${wLabel} must be an object.`, name, workloadName);
      }
      const wMax =
        rawWorkload['maxConcurrent'] === undefined
          ? maxConcurrent
          : positiveInt(
              rawWorkload['maxConcurrent'],
              `${wLabel} maxConcurrent`,
              name,
            );
      if (wMax > maxConcurrent) {
        fail(
          `${wLabel} maxConcurrent (${wMax}) exceeds the pool limit (${maxConcurrent}).`,
          name,
          workloadName,
        );
      }
      const reserved =
        rawWorkload['reserved'] === undefined
          ? 0
          : nonNegativeInt(rawWorkload['reserved'], `${wLabel} reserved`, name);
      if (reserved > wMax) {
        fail(
          `${wLabel} reserved (${reserved}) exceeds its maxConcurrent (${wMax}).`,
          name,
          workloadName,
        );
      }
      totalReserved += reserved;
      const priority = rawWorkload['priority'] ?? 0;
      if (!Number.isSafeInteger(priority)) {
        fail(
          `${wLabel} priority must be an integer, received: ${JSON.stringify(priority)}`,
          name,
          workloadName,
        );
      }
      const maxWaitMs =
        rawWorkload['maxWaitMs'] === undefined
          ? undefined
          : positiveInt(rawWorkload['maxWaitMs'], `${wLabel} maxWaitMs`, name);
      workloads[workloadName] = {
        maxConcurrent: wMax,
        reserved,
        priority: priority as number,
        maxWaitMs,
      };
    }
    if (totalReserved > maxConcurrent) {
      fail(
        `${label} reservations (${totalReserved}) exceed the pool limit (${maxConcurrent}).`,
        name,
      );
    }

    const rawDefault: unknown = raw['defaultWorkload'];
    let defaultWorkload: string | undefined;
    if (rawDefault !== undefined) {
      if (typeof rawDefault !== 'string' || !(rawDefault in workloads)) {
        fail(
          `${label} defaultWorkload ${JSON.stringify(rawDefault)} is not a configured workload.`,
          name,
        );
      }
      defaultWorkload = rawDefault;
    } else if (DEFAULT_WORKLOAD in workloads) {
      defaultWorkload = DEFAULT_WORKLOAD;
    } else if (workloadEntries.length === 1) {
      defaultWorkload = workloadEntries[0]?.[0];
    }

    pools[name] = { maxConcurrent, maxQueued, defaultWorkload, workloads };
  }
  return { pools };
}

/**
 * Resolve a request's pool and workload against a policy. Throws
 * {@link AdmissionConfigError} for an unknown pool or workload, or when the
 * request names no workload and the pool has no default.
 */
export function resolveAdmissionTarget(
  policy: NormalizedAdmissionPolicy,
  pool: string,
  workload: string | undefined,
): { pool: NormalizedPoolPolicy; workload: string } {
  const poolPolicy = Object.hasOwn(policy.pools, pool)
    ? policy.pools[pool]
    : undefined;
  if (!poolPolicy) {
    fail(`Unknown admission pool "${pool}".`, pool, workload);
  }
  const resolved = workload ?? poolPolicy.defaultWorkload;
  if (resolved === undefined) {
    fail(
      `Admission pool "${pool}" has no default workload; select one explicitly.`,
      pool,
    );
  }
  if (!Object.hasOwn(poolPolicy.workloads, resolved)) {
    fail(
      `Unknown admission workload "${resolved}" in pool "${pool}".`,
      pool,
      resolved,
    );
  }
  return { pool: poolPolicy, workload: resolved };
}

/** A workload's policy; throws for a name the pool does not define. */
export function workloadPolicy(
  pool: NormalizedPoolPolicy,
  workload: string,
): NormalizedWorkloadPolicy {
  const policy = Object.hasOwn(pool.workloads, workload)
    ? pool.workloads[workload]
    : undefined;
  if (!policy) {
    throw new AdmissionConfigError(
      `Unknown admission workload "${workload}".`,
      {
        workload,
      },
    );
  }
  return policy;
}

/**
 * Canonical JSON for one pool's effective policy. Workers sharing a pool
 * must produce the same fingerprint; distributed backends compare it to
 * detect conflicting configurations.
 */
export function admissionPoolFingerprint(pool: NormalizedPoolPolicy): string {
  const workloads = Object.keys(pool.workloads)
    .sort()
    .map(name => {
      const w = workloadPolicy(pool, name);
      return [
        name,
        w.maxConcurrent,
        w.reserved,
        w.priority,
        w.maxWaitMs ?? null,
      ];
    });
  return JSON.stringify({
    v: 1,
    maxConcurrent: pool.maxConcurrent,
    maxQueued: pool.maxQueued ?? null,
    defaultWorkload: pool.defaultWorkload ?? null,
    workloads,
  });
}

/** A waiting request, as seen by the allocator. */
export interface AdmissionWaiter {
  id: string;
  workload: string;
  /** Monotonic enqueue order; lower is older. */
  seq: number;
}

/**
 * Choose which waiting requests to grant now. Pure and deterministic:
 * callers run it inside their atomic section with the pool's valid active
 * leases (expired leases already removed) and live waiters.
 *
 * Rules:
 * - Pool limit: total active never exceeds `maxConcurrent`.
 * - Workload limit: a workload's active never exceeds its `maxConcurrent`.
 * - Strict reservations: a grant to workload W is allowed only if the
 *   unmet reservations of every other workload still fit in the remaining
 *   pool capacity. Reserved capacity stays idle rather than being lent.
 * - Priority between eligible workloads (higher first), ties broken by the
 *   oldest head-of-queue; FIFO within a workload.
 * - A workload blocked by its own ceiling or by reservations never blocks
 *   another eligible workload.
 */
export function selectAdmissionGrants(
  pool: NormalizedPoolPolicy,
  activeByWorkload: ReadonlyMap<string, number>,
  waiters: readonly AdmissionWaiter[],
): string[] {
  const active = new Map<string, number>();
  let total = 0;
  for (const [workload, count] of activeByWorkload) {
    active.set(workload, count);
    total += count;
  }
  const queues = new Map<string, AdmissionWaiter[]>();
  for (const waiter of [...waiters].sort((a, b) => a.seq - b.seq)) {
    if (!Object.hasOwn(pool.workloads, waiter.workload)) {
      continue;
    }
    const queue = queues.get(waiter.workload);
    if (queue) {
      queue.push(waiter);
    } else {
      queues.set(waiter.workload, [waiter]);
    }
  }

  const unmetReservations = (except: string): number => {
    let sum = 0;
    for (const [name, policy] of Object.entries(pool.workloads)) {
      if (name !== except) {
        sum += Math.max(0, policy.reserved - (active.get(name) ?? 0));
      }
    }
    return sum;
  };

  const grants: string[] = [];
  while (total < pool.maxConcurrent) {
    let best:
      | {
          workload: string;
          head: AdmissionWaiter;
          priority: number;
          queue: AdmissionWaiter[];
        }
      | undefined;
    for (const [workload, queue] of queues) {
      const head = queue[0];
      if (!head) {
        continue;
      }
      const policy = workloadPolicy(pool, workload);
      const current = active.get(workload) ?? 0;
      if (current >= policy.maxConcurrent) {
        continue;
      }
      if (total + 1 + unmetReservations(workload) > pool.maxConcurrent) {
        continue;
      }
      if (
        !best ||
        policy.priority > best.priority ||
        (policy.priority === best.priority && head.seq < best.head.seq)
      ) {
        best = { workload, head, priority: policy.priority, queue };
      }
    }
    if (!best) {
      break;
    }
    best.queue.shift();
    active.set(best.workload, (active.get(best.workload) ?? 0) + 1);
    total += 1;
    grants.push(best.head.id);
  }
  return grants;
}
