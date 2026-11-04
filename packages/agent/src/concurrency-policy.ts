import type { ConcurrencyLimits } from './concurrency.js';
import { ConcurrencyConfigError } from './errors.js';

/**
 * Validated limiter settings and the allocation algorithm every built-in
 * limiter shares, so in-memory and distributed limiters behave identically.
 * Exported from `runcell/concurrency` for custom limiter authors.
 */

export interface ResolvedWorkload {
  maxConcurrent: number;
  reserved: number;
  priority: number;
  maxWaitMs: number | undefined;
}

export interface ResolvedConcurrencyLimits<W extends string = string> {
  maxConcurrent: number;
  maxQueued: number | undefined;
  defaultWorkload: W | undefined;
  workloads: Readonly<Record<W, ResolvedWorkload>>;
}

/** The workload of a limiter configured without `workloads`. */
export const DEFAULT_WORKLOAD = 'default';

function fail(message: string, workload?: string): never {
  throw new ConcurrencyConfigError(
    message,
    workload !== undefined ? { workload } : {},
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function describe(value: unknown): string {
  // `JSON.stringify` returns undefined for undefined and functions.
  const text = JSON.stringify(value) as string | undefined;
  return text ?? typeof value;
}

function positiveInt(value: unknown, label: string, workload?: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fail(
      `${label} must be a positive integer, received: ${describe(value)}`,
      workload,
    );
  }
  return value as number;
}

function nonNegativeInt(
  value: unknown,
  label: string,
  workload?: string,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail(
      `${label} must be a non-negative integer, received: ${describe(value)}`,
      workload,
    );
  }
  return value as number;
}

/**
 * Validate limiter settings and fill defaults. Throws
 * `ConcurrencyConfigError` for non-integer or out-of-range limits, a
 * workload ceiling above `maxConcurrent`, a reservation above its workload
 * ceiling, reservations that add up to more than `maxConcurrent`, and an
 * unknown `defaultWorkload`.
 */
export function resolveConcurrencyLimits<W extends string>(
  limits: ConcurrencyLimits<W>,
): ResolvedConcurrencyLimits<W> {
  if (!isRecord(limits)) {
    fail('Concurrency limiter options must be an object.');
  }
  const maxConcurrent = positiveInt(limits.maxConcurrent, '"maxConcurrent"');
  const maxQueued =
    limits.maxQueued === undefined
      ? undefined
      : nonNegativeInt(limits.maxQueued, '"maxQueued"');

  const rawWorkloads: unknown = limits.workloads;
  const entries: [string, unknown][] =
    rawWorkloads === undefined
      ? [[DEFAULT_WORKLOAD, {}]]
      : isRecord(rawWorkloads)
        ? Object.entries(rawWorkloads)
        : fail('"workloads" must be an object.');
  if (entries.length === 0) {
    fail('"workloads" must define at least one workload.');
  }

  const workloads: Record<string, ResolvedWorkload> = {};
  let totalReserved = 0;
  for (const [name, raw] of entries) {
    const label = `Workload "${name}"`;
    if (name.length === 0) {
      fail('Workload names must be non-empty.');
    }
    if (!isRecord(raw)) {
      fail(`${label} must be an object.`, name);
    }
    const wMax =
      raw['maxConcurrent'] === undefined
        ? maxConcurrent
        : positiveInt(raw['maxConcurrent'], `${label} maxConcurrent`, name);
    if (wMax > maxConcurrent) {
      fail(
        `${label} maxConcurrent (${wMax}) exceeds the limiter's maxConcurrent (${maxConcurrent}).`,
        name,
      );
    }
    const reserved =
      raw['reserved'] === undefined
        ? 0
        : nonNegativeInt(raw['reserved'], `${label} reserved`, name);
    if (reserved > wMax) {
      fail(
        `${label} reserved (${reserved}) exceeds its maxConcurrent (${wMax}).`,
        name,
      );
    }
    totalReserved += reserved;
    const priority = raw['priority'] ?? 0;
    if (!Number.isSafeInteger(priority)) {
      fail(
        `${label} priority must be an integer, received: ${describe(priority)}`,
        name,
      );
    }
    const maxWaitMs =
      raw['maxWaitMs'] === undefined
        ? undefined
        : positiveInt(raw['maxWaitMs'], `${label} maxWaitMs`, name);
    workloads[name] = {
      maxConcurrent: wMax,
      reserved,
      priority: priority as number,
      maxWaitMs,
    };
  }
  if (totalReserved > maxConcurrent) {
    fail(
      `Reservations (${totalReserved}) exceed the limiter's maxConcurrent (${maxConcurrent}).`,
    );
  }

  const rawDefault: unknown = limits.defaultWorkload;
  let defaultWorkload: string | undefined;
  if (rawDefault !== undefined) {
    if (
      typeof rawDefault !== 'string' ||
      !Object.hasOwn(workloads, rawDefault)
    ) {
      fail(
        `"defaultWorkload" ${describe(rawDefault)} is not a configured workload.`,
      );
    }
    defaultWorkload = rawDefault;
  } else if (Object.hasOwn(workloads, DEFAULT_WORKLOAD)) {
    defaultWorkload = DEFAULT_WORKLOAD;
  } else if (entries.length === 1) {
    defaultWorkload = entries[0]?.[0];
  }

  // Validated above: the keys are exactly the configured workload names.
  return {
    maxConcurrent,
    maxQueued,
    defaultWorkload: defaultWorkload as W | undefined,
    workloads: workloads as Record<W, ResolvedWorkload>,
  };
}

/**
 * Resolve a request's workload. Throws `ConcurrencyConfigError` for an
 * unknown workload, or when none is selected and there is no default.
 */
export function resolveWorkload(
  limits: ResolvedConcurrencyLimits,
  workload: string | undefined,
): { name: string; settings: ResolvedWorkload } {
  const name = workload ?? limits.defaultWorkload;
  if (name === undefined) {
    fail(
      `This limiter has no default workload; select one of ${Object.keys(
        limits.workloads,
      )
        .map(w => `"${w}"`)
        .join(', ')}.`,
    );
  }
  const settings = Object.hasOwn(limits.workloads, name)
    ? limits.workloads[name]
    : undefined;
  if (!settings) {
    fail(`Unknown workload "${name}".`, name);
  }
  return { name, settings };
}

/**
 * Canonical JSON of resolved limits. Workers sharing a distributed limiter
 * must produce the same fingerprint; backends compare it to detect
 * conflicting settings.
 */
export function concurrencyLimitsFingerprint(
  limits: ResolvedConcurrencyLimits,
): string {
  const workloads = Object.keys(limits.workloads)
    .sort()
    .map(name => {
      const w = resolveWorkload(limits, name).settings;
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
    maxConcurrent: limits.maxConcurrent,
    maxQueued: limits.maxQueued ?? null,
    defaultWorkload: limits.defaultWorkload ?? null,
    workloads,
  });
}

/** A waiting request, as seen by the allocator. */
export interface ConcurrencyWaiter {
  id: string;
  workload: string;
  /** Enqueue order; lower is older. */
  seq: number;
}

/**
 * Choose which waiting requests to grant now. Pure and deterministic:
 * callers run it inside their atomic section with the valid active slot
 * counts (expired leases already removed) and live waiters.
 *
 * - Total active never exceeds `maxConcurrent`; a workload's active never
 *   exceeds its `maxConcurrent`.
 * - Strict reservations: a grant to workload W is allowed only if every
 *   other workload's unmet reservation still fits in the remaining
 *   capacity. Reserved slots stay idle rather than being lent.
 * - Higher priority first among workloads with room; ties go to the oldest
 *   head of queue; FIFO within a workload.
 * - A workload blocked by its own ceiling or by reservations never blocks
 *   another workload.
 */
export function selectConcurrencyGrants(
  limits: ResolvedConcurrencyLimits,
  activeByWorkload: ReadonlyMap<string, number>,
  waiters: readonly ConcurrencyWaiter[],
): string[] {
  const active = new Map<string, number>();
  let total = 0;
  for (const [workload, count] of activeByWorkload) {
    active.set(workload, count);
    total += count;
  }
  const queues = new Map<string, ConcurrencyWaiter[]>();
  for (const waiter of [...waiters].sort((a, b) => a.seq - b.seq)) {
    if (!Object.hasOwn(limits.workloads, waiter.workload)) {
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
    for (const [name, settings] of Object.entries(limits.workloads)) {
      if (name !== except) {
        sum += Math.max(0, settings.reserved - (active.get(name) ?? 0));
      }
    }
    return sum;
  };

  const grants: string[] = [];
  while (total < limits.maxConcurrent) {
    let best:
      | {
          workload: string;
          head: ConcurrencyWaiter;
          priority: number;
          queue: ConcurrencyWaiter[];
        }
      | undefined;
    for (const [workload, queue] of queues) {
      const head = queue[0];
      const settings = limits.workloads[workload];
      if (!head || !settings) {
        continue;
      }
      if ((active.get(workload) ?? 0) >= settings.maxConcurrent) {
        continue;
      }
      if (total + 1 + unmetReservations(workload) > limits.maxConcurrent) {
        continue;
      }
      if (
        !best ||
        settings.priority > best.priority ||
        (settings.priority === best.priority && head.seq < best.head.seq)
      ) {
        best = { workload, head, priority: settings.priority, queue };
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
