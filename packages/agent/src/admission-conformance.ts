import { randomUUID } from 'node:crypto';
import type {
  AdmissionAdapter,
  AdmissionLease,
  AdmissionRequest,
} from './admission.js';

/** Configuration the suite asks an adapter factory to honor. */
export interface AdmissionConformanceSetup {
  /** Pool name to use. */
  pool: string;
  /** Pool capacity (maximum valid active leases). */
  capacity: number;
  /** Lease validity without renewal, in milliseconds. */
  leaseTtlMs: number;
}

export interface AdmissionConformanceOptions {
  /**
   * Create a fresh, empty adapter whose `pool` has `capacity` permits for
   * requests with `workload: undefined`, and whose leases expire after
   * `leaseTtlMs` without renewal.
   */
  createAdapter(
    setup: AdmissionConformanceSetup,
  ): AdmissionAdapter | Promise<AdmissionAdapter>;
  /** Dispose an adapter after a case. */
  disposeAdapter?(adapter: AdmissionAdapter): void | Promise<void>;
  /**
   * Lease TTL used by expiry cases, in milliseconds. Raise it for backends
   * with coarse clocks or slow round trips. Defaults to 200.
   */
  leaseTtlMs?: number;
  /** Pool name. Defaults to `'conformance'`. */
  pool?: string;
}

/** One conformance check. Rejects with a descriptive error on violation. */
export interface AdmissionConformanceCase {
  name: string;
  run(): Promise<void>;
}

class ConformanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdmissionConformanceError';
  }
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new ConformanceError(message);
  }
}

const sleep = (ms: number) =>
  new Promise<void>(resolve => setTimeout(resolve, ms));

/** Resolve to `'pending'` if the promise has not settled within `ms`. */
async function settledWithin<T>(
  promise: Promise<T>,
  ms: number,
): Promise<{ value: T } | { error: unknown } | 'pending'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'pending'>(resolve => {
    timer = setTimeout(() => {
      resolve('pending');
    }, ms);
  });
  try {
    return await Promise.race([
      promise.then(
        value => ({ value }),
        (error: unknown) => ({ error }),
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Framework-agnostic adapter conformance suite. Register each case with
 * your test runner:
 *
 * ```ts
 * for (const c of admissionConformanceCases({ createAdapter })) {
 *   it(c.name, c.run, 20_000);
 * }
 * ```
 *
 * The cases cover atomic capacity, blocking and hand-off, idempotent and
 * stale-safe release and renewal, expiry recovery, and cancellation-safe
 * acquisition.
 */
export function admissionConformanceCases(
  options: AdmissionConformanceOptions,
): AdmissionConformanceCase[] {
  const pool = options.pool ?? 'conformance';
  const ttl = options.leaseTtlMs ?? 200;
  const settle = Math.max(50, Math.round(ttl / 2));

  const withAdapter =
    (
      capacity: number,
      leaseTtlMs: number,
      body: (a: AdmissionAdapter) => Promise<void>,
    ) =>
    async () => {
      const adapter = await options.createAdapter({
        pool,
        capacity,
        leaseTtlMs,
      });
      try {
        await body(adapter);
      } finally {
        await options.disposeAdapter?.(adapter);
      }
    };

  const request = (
    signal: AbortSignal,
    overrides: Partial<AdmissionRequest> = {},
  ): AdmissionRequest => {
    const runId = randomUUID();
    return {
      pool,
      workload: undefined,
      runId,
      rootRunId: runId,
      parentRunId: undefined,
      requestId: randomUUID(),
      metadata: {},
      deadline: undefined,
      timeoutMs: undefined,
      signal,
      ...overrides,
    };
  };
  const acquire = (adapter: AdmissionAdapter, signal?: AbortSignal) =>
    adapter.acquire(request(signal ?? new AbortController().signal));
  const renew = (adapter: AdmissionAdapter, lease: AdmissionLease) =>
    adapter.renew(lease, { signal: new AbortController().signal });

  // Long TTL for cases that must not observe expiry.
  const longTtl = Math.max(ttl * 50, 10_000);

  return [
    {
      name: 'grants a lease with a unique id, the pool, and a positive ttl',
      run: withAdapter(2, longTtl, async adapter => {
        const a = await acquire(adapter);
        const b = await acquire(adapter);
        check(typeof a.id === 'string' && a.id.length > 0, 'lease id is empty');
        check(a.id !== b.id, 'two grants share a lease id');
        check(a.pool === pool, `lease pool is "${a.pool}", expected "${pool}"`);
        check(a.ttlMs > 0, `lease ttlMs is ${a.ttlMs}`);
        await adapter.release(a);
        await adapter.release(b);
      }),
    },
    {
      name: 'never exceeds capacity under concurrent acquisition',
      run: withAdapter(2, longTtl, async adapter => {
        let active = 0;
        let peak = 0;
        const worker = async () => {
          for (let i = 0; i < 3; i += 1) {
            const lease = await acquire(adapter);
            active += 1;
            peak = Math.max(peak, active);
            await sleep(5);
            active -= 1;
            await adapter.release(lease);
          }
        };
        await Promise.all(Array.from({ length: 6 }, worker));
        check(peak <= 2, `observed ${peak} concurrent leases with capacity 2`);
        check(peak === 2, `capacity was never fully used (peak ${peak})`);
      }),
    },
    {
      name: 'blocks when full and grants after release',
      run: withAdapter(1, longTtl, async adapter => {
        const first = await acquire(adapter);
        const second = acquire(adapter);
        check(
          (await settledWithin(second, settle)) === 'pending',
          'second acquire was granted while the pool was full',
        );
        await adapter.release(first);
        const granted = await settledWithin(second, longTtl);
        check(
          granted !== 'pending' && 'value' in granted,
          'waiting acquire was not granted after release',
        );
        await adapter.release(granted.value);
      }),
    },
    {
      name: 'release is idempotent',
      run: withAdapter(1, longTtl, async adapter => {
        const first = await acquire(adapter);
        await adapter.release(first);
        await adapter.release(first);
        const second = await acquire(adapter);
        // A duplicate release of `first` must not free `second`'s slot.
        await adapter.release(first);
        const third = acquire(adapter);
        check(
          (await settledWithin(third, settle)) === 'pending',
          'duplicate release freed capacity held by another lease',
        );
        await adapter.release(second);
        const granted = await settledWithin(third, longTtl);
        check(
          granted !== 'pending' && 'value' in granted,
          'third acquire not granted',
        );
        await adapter.release(granted.value);
      }),
    },
    {
      name: 'renewal extends a held lease past its original expiry',
      run: withAdapter(1, ttl, async adapter => {
        const lease = await acquire(adapter);
        let current: AdmissionLease = lease;
        const end = Date.now() + ttl * 3;
        while (Date.now() < end) {
          await sleep(Math.max(10, Math.round(ttl / 4)));
          const renewed = await renew(adapter, current);
          check(
            renewed !== undefined,
            'renewal of a held lease returned undefined',
          );
          check(renewed.id === lease.id, 'renewal changed the lease id');
          current = renewed;
        }
        const other = acquire(adapter);
        check(
          (await settledWithin(other, settle)) === 'pending',
          'a renewed lease lost its capacity',
        );
        await adapter.release(current);
        const granted = await settledWithin(other, longTtl);
        check(
          granted !== 'pending' && 'value' in granted,
          'acquire not granted after release',
        );
        await adapter.release(granted.value);
      }),
    },
    {
      name: 'expired leases become reclaimable',
      run: withAdapter(1, ttl, async adapter => {
        await acquire(adapter);
        // Never renewed or released, as if the worker crashed.
        const next = await settledWithin(acquire(adapter), ttl * 10);
        check(
          next !== 'pending' && 'value' in next,
          'capacity of an expired lease was not reclaimed',
        );
        await adapter.release(next.value);
      }),
    },
    {
      name: 'stale renew and release cannot affect a replacement lease',
      run: withAdapter(1, ttl, async adapter => {
        const stale = await acquire(adapter);
        const replacement = await settledWithin(acquire(adapter), ttl * 10);
        check(
          replacement !== 'pending' && 'value' in replacement,
          'replacement lease was not granted after expiry',
        );
        const fresh = replacement.value;
        check(fresh.id !== stale.id, 'replacement lease reused the stale id');
        check(
          (await renew(adapter, stale)) === undefined,
          'renewing an expired lease succeeded',
        );
        await adapter.release(stale);
        const contender = acquire(adapter);
        check(
          (await settledWithin(contender, Math.min(settle, ttl / 2))) ===
            'pending',
          'a stale release freed the replacement lease',
        );
        const renewed = await renew(adapter, fresh);
        check(
          renewed !== undefined,
          'replacement lease was lost after stale operations',
        );
        await adapter.release(fresh);
        const granted = await settledWithin(contender, longTtl);
        check(
          granted !== 'pending' && 'value' in granted,
          'contender not granted',
        );
        await adapter.release(granted.value);
      }),
    },
    {
      name: 'renew and release of an unknown lease are harmless',
      run: withAdapter(1, longTtl, async adapter => {
        const unknown: AdmissionLease = {
          id: randomUUID(),
          pool,
          workload: undefined,
          ttlMs: 1000,
        };
        check(
          (await renew(adapter, unknown)) === undefined,
          'renewing an unknown lease returned a lease',
        );
        await adapter.release(unknown);
        const lease = await acquire(adapter);
        await adapter.release(lease);
      }),
    },
    {
      name: 'an already-aborted acquisition rejects without granting',
      run: withAdapter(1, longTtl, async adapter => {
        const controller = new AbortController();
        controller.abort(new Error('cancelled'));
        const result = await settledWithin(
          acquire(adapter, controller.signal),
          longTtl,
        );
        check(
          result !== 'pending' && 'error' in result,
          'aborted acquisition did not reject',
        );
        const lease = await settledWithin(acquire(adapter), settle * 4);
        check(
          lease !== 'pending' && 'value' in lease,
          'an aborted acquisition consumed capacity',
        );
        await adapter.release(lease.value);
      }),
    },
    {
      name: 'cancelling a queued acquisition removes it and leaks no permit',
      run: withAdapter(1, longTtl, async adapter => {
        const holder = await acquire(adapter);
        const controller = new AbortController();
        const reason = new Error('cancelled while queued');
        const cancelled = acquire(adapter, controller.signal);
        const behind = acquire(adapter);
        check(
          (await settledWithin(cancelled, settle)) === 'pending',
          'queued acquisition was granted while the pool was full',
        );
        controller.abort(reason);
        const outcome = await settledWithin(cancelled, longTtl);
        check(
          outcome !== 'pending' && 'error' in outcome,
          'cancelled acquisition did not reject',
        );
        await adapter.release(holder);
        const granted = await settledWithin(behind, longTtl);
        check(
          granted !== 'pending' && 'value' in granted,
          'request queued behind a cancelled one was not granted',
        );
        await adapter.release(granted.value);
        const after = await settledWithin(acquire(adapter), longTtl);
        check(
          after !== 'pending' && 'value' in after,
          'capacity leaked after cancellation',
        );
        await adapter.release(after.value);
      }),
    },
  ];
}
