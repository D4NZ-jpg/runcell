import { describe, expect, it } from 'vitest';
import type { ConcurrencyLease, ConcurrencyRequest } from './concurrency.js';
import { concurrencyConformanceCases } from './concurrency-conformance.js';
import { createConcurrencyLimiter } from './concurrency-limiter.js';
import {
  ConcurrencyConfigError,
  ConcurrencyQueueFullError,
  ConcurrencyTimeoutError,
} from './errors.js';

describe('in-memory limiter conformance', () => {
  for (const testCase of concurrencyConformanceCases({
    createLimiter: ({ capacity, leaseTtlMs }) =>
      createConcurrencyLimiter({ maxConcurrent: capacity, leaseTtlMs }),
  })) {
    it(testCase.name, () => testCase.run(), 20_000);
  }
});

let counter = 0;
function request(
  workload: string | undefined,
  extra: Partial<ConcurrencyRequest> = {},
): ConcurrencyRequest {
  counter += 1;
  return {
    workload,
    runId: `run-${counter}`,
    rootRunId: `run-${counter}`,
    parentRunId: undefined,
    requestId: `req-${counter}`,
    metadata: {},
    timeoutMs: undefined,
    signal: new AbortController().signal,
    ...extra,
  };
}

describe('createConcurrencyLimiter', () => {
  it('gives interactive work its reserved slots under a background backlog', async () => {
    const limiter = createConcurrencyLimiter({
      name: 'shared-model',
      maxConcurrent: 8,
      maxQueued: 200,
      workloads: {
        interactive: { reserved: 2, priority: 10, maxWaitMs: 60_000 },
        background: { maxConcurrent: 6, maxWaitMs: 300_000 },
      },
    });
    const background: Promise<ConcurrencyLease>[] = [];
    for (let i = 0; i < 12; i += 1) {
      background.push(limiter.acquire(request('background')));
    }
    await Promise.resolve();
    expect((await limiter.stats()).workloads['background']).toEqual({
      active: 6,
      queued: 6,
    });

    const interactive = await Promise.all([
      limiter.acquire(request('interactive')),
      limiter.acquire(request('interactive')),
    ]);
    const stats = await limiter.stats();
    expect(stats.active).toBe(8);
    expect(stats.workloads['interactive']?.active).toBe(2);

    for (const lease of interactive) await limiter.release(lease);
    // Background stays at its ceiling; the freed reserved slots stay idle.
    expect((await limiter.stats()).workloads['background']).toEqual({
      active: 6,
      queued: 6,
    });
  });

  it('rejects requests beyond the queue limit', async () => {
    const limiter = createConcurrencyLimiter({
      maxConcurrent: 1,
      maxQueued: 1,
    });
    await limiter.acquire(request(undefined));
    void limiter.acquire(request(undefined)).catch(() => undefined);
    await expect(limiter.acquire(request(undefined))).rejects.toBeInstanceOf(
      ConcurrencyQueueFullError,
    );
  });

  it('removes waiters at the workload wait limit or the run budget', async () => {
    const limiter = createConcurrencyLimiter({
      maxConcurrent: 1,
      workloads: { w: { maxWaitMs: 30 } },
    });
    await limiter.acquire(request('w'));
    await expect(limiter.acquire(request('w'))).rejects.toBeInstanceOf(
      ConcurrencyTimeoutError,
    );
    await expect(
      limiter.acquire(request('w', { timeoutMs: 5 })),
    ).rejects.toBeInstanceOf(ConcurrencyTimeoutError);
    expect((await limiter.stats()).queued).toBe(0);
  });

  it('rejects unknown workloads with the limiter name', async () => {
    const limiter = createConcurrencyLimiter({
      name: 'claude',
      maxConcurrent: 2,
      workloads: { a: {}, b: {} },
    });
    await expect(limiter.acquire(request('c'))).rejects.toMatchObject({
      name: 'ConcurrencyConfigError',
      limiter: 'claude',
    });
    expect(() => {
      limiter.validateWorkload(undefined);
    }).toThrow(ConcurrencyConfigError);
  });

  it('keeps separate limiters independent', async () => {
    const a = createConcurrencyLimiter({ maxConcurrent: 1 });
    const b = createConcurrencyLimiter({ maxConcurrent: 1 });
    await a.acquire(request(undefined));
    await expect(b.acquire(request(undefined))).resolves.toMatchObject({
      workload: 'default',
    });
  });

  it('rejects invalid options', () => {
    expect(() => createConcurrencyLimiter({ maxConcurrent: 0 })).toThrow(
      ConcurrencyConfigError,
    );
    expect(() =>
      createConcurrencyLimiter({ maxConcurrent: 1, name: '' }),
    ).toThrow(ConcurrencyConfigError);
    expect(() =>
      createConcurrencyLimiter({ maxConcurrent: 1, leaseTtlMs: 0 }),
    ).toThrow(ConcurrencyConfigError);
  });
});
