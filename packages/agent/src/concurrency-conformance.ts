import { randomUUID } from 'node:crypto';
import type {
  ConcurrencyLease,
  ConcurrencyLimiter,
  ConcurrencyRequest,
} from './concurrency.js';

/** Settings the suite asks a limiter factory to honor. */
export interface ConcurrencyConformanceSetup {
  /** `maxConcurrent`: maximum valid active leases. */
  capacity: number;
  /** Lease validity without renewal, in milliseconds. */
  leaseTtlMs: number;
}

export interface ConcurrencyConformanceOptions {
  /**
   * Create a fresh, empty limiter with `capacity` slots for requests with
   * `workload: undefined`, whose leases expire after `leaseTtlMs` without
   * renewal.
   */
  createLimiter(
    setup: ConcurrencyConformanceSetup,
  ): ConcurrencyLimiter | Promise<ConcurrencyLimiter>;
  /** Dispose a limiter after a case. */
  disposeLimiter?(limiter: ConcurrencyLimiter): void | Promise<void>;
  /**
   * Lease TTL used by expiry cases, in milliseconds. Raise it for backends
   * with coarse clocks or slow round trips. Defaults to 200.
   */
  leaseTtlMs?: number;
}

/** One conformance check. Rejects with a descriptive error on violation. */
export interface ConcurrencyConformanceCase {
  name: string;
  run(): Promise<void>;
}

class ConformanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConcurrencyConformanceError';
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
 * Framework-agnostic limiter conformance suite. Register each case with
 * your test runner:
 *
 * ```ts
 * for (const c of concurrencyConformanceCases({ createLimiter })) {
 *   it(c.name, c.run, 20_000);
 * }
 * ```
 *
 * The cases cover atomic capacity, blocking and hand-off, idempotent and
 * stale-safe release and renewal, expiry recovery, and cancellation-safe
 * acquisition.
 */
export function concurrencyConformanceCases(
  options: ConcurrencyConformanceOptions,
): ConcurrencyConformanceCase[] {
  const ttl = options.leaseTtlMs ?? 200;
  const settle = Math.max(50, Math.round(ttl / 2));

  const withLimiter =
    (
      capacity: number,
      leaseTtlMs: number,
      body: (a: ConcurrencyLimiter) => Promise<void>,
    ) =>
    async () => {
      const limiter = await options.createLimiter({
        capacity,
        leaseTtlMs,
      });
      try {
        await body(limiter);
      } finally {
        await options.disposeLimiter?.(limiter);
      }
    };

  const request = (
    signal: AbortSignal,
    overrides: Partial<ConcurrencyRequest> = {},
  ): ConcurrencyRequest => {
    const runId = randomUUID();
    return {
      workload: undefined,
      runId,
      rootRunId: runId,
      parentRunId: undefined,
      requestId: randomUUID(),
      metadata: {},
      timeoutMs: undefined,
      signal,
      ...overrides,
    };
  };
  const acquire = (limiter: ConcurrencyLimiter, signal?: AbortSignal) =>
    limiter.acquire(request(signal ?? new AbortController().signal));
  const renew = (limiter: ConcurrencyLimiter, lease: ConcurrencyLease) =>
    limiter.renew(lease, { signal: new AbortController().signal });

  // Long TTL for cases that must not observe expiry.
  const longTtl = Math.max(ttl * 50, 10_000);

  return [
    {
      name: 'grants a lease with a unique id and a positive ttl',
      run: withLimiter(2, longTtl, async limiter => {
        const a = await acquire(limiter);
        const b = await acquire(limiter);
        check(typeof a.id === 'string' && a.id.length > 0, 'lease id is empty');
        check(a.id !== b.id, 'two grants share a lease id');
        check(a.ttlMs > 0, `lease ttlMs is ${a.ttlMs}`);
        await limiter.release(a);
        await limiter.release(b);
      }),
    },
    {
      name: 'never exceeds capacity under concurrent acquisition',
      run: withLimiter(2, longTtl, async limiter => {
        let active = 0;
        let peak = 0;
        const worker = async () => {
          for (let i = 0; i < 3; i += 1) {
            const lease = await acquire(limiter);
            active += 1;
            peak = Math.max(peak, active);
            await sleep(5);
            active -= 1;
            await limiter.release(lease);
          }
        };
        await Promise.all(Array.from({ length: 6 }, worker));
        check(peak <= 2, `observed ${peak} concurrent leases with capacity 2`);
        check(peak === 2, `capacity was never fully used (peak ${peak})`);
      }),
    },
    {
      name: 'blocks when full and grants after release',
      run: withLimiter(1, longTtl, async limiter => {
        const first = await acquire(limiter);
        const second = acquire(limiter);
        check(
          (await settledWithin(second, settle)) === 'pending',
          'second acquire was granted while the limiter was full',
        );
        await limiter.release(first);
        const granted = await settledWithin(second, longTtl);
        check(
          granted !== 'pending' && 'value' in granted,
          'waiting acquire was not granted after release',
        );
        await limiter.release(granted.value);
      }),
    },
    {
      name: 'release is idempotent',
      run: withLimiter(1, longTtl, async limiter => {
        const first = await acquire(limiter);
        await limiter.release(first);
        await limiter.release(first);
        const second = await acquire(limiter);
        // A duplicate release of `first` must not free `second`'s slot.
        await limiter.release(first);
        const third = acquire(limiter);
        check(
          (await settledWithin(third, settle)) === 'pending',
          'duplicate release freed capacity held by another lease',
        );
        await limiter.release(second);
        const granted = await settledWithin(third, longTtl);
        check(
          granted !== 'pending' && 'value' in granted,
          'third acquire not granted',
        );
        await limiter.release(granted.value);
      }),
    },
    {
      name: 'renewal extends a held lease past its original expiry',
      run: withLimiter(1, ttl, async limiter => {
        const lease = await acquire(limiter);
        let current: ConcurrencyLease = lease;
        const end = Date.now() + ttl * 3;
        while (Date.now() < end) {
          await sleep(Math.max(10, Math.round(ttl / 4)));
          const renewed = await renew(limiter, current);
          check(
            renewed !== undefined,
            'renewal of a held lease returned undefined',
          );
          check(renewed.id === lease.id, 'renewal changed the lease id');
          current = renewed;
        }
        const other = acquire(limiter);
        check(
          (await settledWithin(other, settle)) === 'pending',
          'a renewed lease lost its capacity',
        );
        await limiter.release(current);
        const granted = await settledWithin(other, longTtl);
        check(
          granted !== 'pending' && 'value' in granted,
          'acquire not granted after release',
        );
        await limiter.release(granted.value);
      }),
    },
    {
      name: 'expired leases become reclaimable',
      run: withLimiter(1, ttl, async limiter => {
        await acquire(limiter);
        // Never renewed or released, as if the worker crashed.
        const next = await settledWithin(acquire(limiter), ttl * 10);
        check(
          next !== 'pending' && 'value' in next,
          'capacity of an expired lease was not reclaimed',
        );
        await limiter.release(next.value);
      }),
    },
    {
      name: 'stale renew and release cannot affect a replacement lease',
      run: withLimiter(1, ttl, async limiter => {
        const stale = await acquire(limiter);
        const replacement = await settledWithin(acquire(limiter), ttl * 10);
        check(
          replacement !== 'pending' && 'value' in replacement,
          'replacement lease was not granted after expiry',
        );
        const fresh = replacement.value;
        check(fresh.id !== stale.id, 'replacement lease reused the stale id');
        check(
          (await renew(limiter, stale)) === undefined,
          'renewing an expired lease succeeded',
        );
        await limiter.release(stale);
        const contender = acquire(limiter);
        check(
          (await settledWithin(contender, Math.min(settle, ttl / 2))) ===
            'pending',
          'a stale release freed the replacement lease',
        );
        const renewed = await renew(limiter, fresh);
        check(
          renewed !== undefined,
          'replacement lease was lost after stale operations',
        );
        await limiter.release(fresh);
        const granted = await settledWithin(contender, longTtl);
        check(
          granted !== 'pending' && 'value' in granted,
          'contender not granted',
        );
        await limiter.release(granted.value);
      }),
    },
    {
      name: 'renew and release of an unknown lease are harmless',
      run: withLimiter(1, longTtl, async limiter => {
        const unknown: ConcurrencyLease = {
          id: randomUUID(),
          workload: undefined,
          ttlMs: 1000,
        };
        check(
          (await renew(limiter, unknown)) === undefined,
          'renewing an unknown lease returned a lease',
        );
        await limiter.release(unknown);
        const lease = await acquire(limiter);
        await limiter.release(lease);
      }),
    },
    {
      name: 'an already-aborted acquisition rejects without granting',
      run: withLimiter(1, longTtl, async limiter => {
        const controller = new AbortController();
        controller.abort(new Error('cancelled'));
        const result = await settledWithin(
          acquire(limiter, controller.signal),
          longTtl,
        );
        check(
          result !== 'pending' && 'error' in result,
          'aborted acquisition did not reject',
        );
        const lease = await settledWithin(acquire(limiter), settle * 4);
        check(
          lease !== 'pending' && 'value' in lease,
          'an aborted acquisition consumed capacity',
        );
        await limiter.release(lease.value);
      }),
    },
    {
      name: 'cancelling a queued acquisition removes it and leaks no permit',
      run: withLimiter(1, longTtl, async limiter => {
        const holder = await acquire(limiter);
        const controller = new AbortController();
        const reason = new Error('cancelled while queued');
        const cancelled = acquire(limiter, controller.signal);
        const behind = acquire(limiter);
        check(
          (await settledWithin(cancelled, settle)) === 'pending',
          'queued acquisition was granted while the limiter was full',
        );
        controller.abort(reason);
        const outcome = await settledWithin(cancelled, longTtl);
        check(
          outcome !== 'pending' && 'error' in outcome,
          'cancelled acquisition did not reject',
        );
        await limiter.release(holder);
        const granted = await settledWithin(behind, longTtl);
        check(
          granted !== 'pending' && 'value' in granted,
          'request queued behind a cancelled one was not granted',
        );
        await limiter.release(granted.value);
        const after = await settledWithin(acquire(limiter), longTtl);
        check(
          after !== 'pending' && 'value' in after,
          'capacity leaked after cancellation',
        );
        await limiter.release(after.value);
      }),
    },
  ];
}
