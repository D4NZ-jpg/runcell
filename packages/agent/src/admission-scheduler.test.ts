import { describe, expect, it } from 'vitest';
import type { AdmissionLease, AdmissionRequest } from './admission.js';
import { admissionConformanceCases } from './admission-conformance.js';
import {
  createInMemoryScheduler,
  type AdmissionSchedulerEvent,
} from './admission-scheduler.js';
import {
  AdmissionConfigError,
  AdmissionQueueFullError,
  AdmissionTimeoutError,
} from './errors.js';

describe('in-memory scheduler conformance', () => {
  for (const testCase of admissionConformanceCases({
    createAdapter: ({ pool, capacity, leaseTtlMs }) =>
      createInMemoryScheduler({
        policy: { pools: { [pool]: { maxConcurrent: capacity } } },
        leaseTtlMs,
      }),
  })) {
    it(testCase.name, () => testCase.run(), 20_000);
  }
});

let counter = 0;
function request(
  pool: string,
  workload: string | undefined,
  extra: Partial<AdmissionRequest> = {},
): AdmissionRequest {
  counter += 1;
  return {
    pool,
    workload,
    runId: `run-${counter}`,
    rootRunId: `run-${counter}`,
    parentRunId: undefined,
    requestId: `req-${counter}`,
    metadata: {},
    deadline: undefined,
    timeoutMs: undefined,
    signal: new AbortController().signal,
    ...extra,
  };
}

const sharedModel = {
  pools: {
    'shared-model': {
      maxConcurrent: 8,
      maxQueued: 200,
      workloads: {
        interactive: {
          maxConcurrent: 8,
          reserved: 2,
          priority: 10,
          maxWaitMs: 60_000,
        },
        background: {
          maxConcurrent: 6,
          reserved: 0,
          priority: 0,
          maxWaitMs: 300_000,
        },
      },
    },
  },
};

describe('createInMemoryScheduler', () => {
  it('gives interactive work its protected capacity under a background backlog', async () => {
    const scheduler = createInMemoryScheduler({ policy: sharedModel });
    const background: Promise<AdmissionLease>[] = [];
    for (let i = 0; i < 12; i += 1) {
      background.push(scheduler.acquire(request('shared-model', 'background')));
    }
    await Promise.resolve();
    let stats = await scheduler.stats('shared-model');
    expect(stats.workloads['background']).toEqual({ active: 6, queued: 6 });

    const interactive = await Promise.all([
      scheduler.acquire(request('shared-model', 'interactive')),
      scheduler.acquire(request('shared-model', 'interactive')),
    ]);
    stats = await scheduler.stats('shared-model');
    expect(stats.active).toBe(8);
    expect(stats.workloads['interactive']?.active).toBe(2);

    for (const lease of interactive) await scheduler.release(lease);
    // Background stays at its ceiling; the freed reserved permits stay idle.
    stats = await scheduler.stats('shared-model');
    expect(stats.workloads['background']).toEqual({ active: 6, queued: 6 });
  });

  it('rejects requests beyond the queue limit with a typed error', async () => {
    const events: AdmissionSchedulerEvent[] = [];
    const scheduler = createInMemoryScheduler({
      policy: { pools: { p: { maxConcurrent: 1, maxQueued: 1 } } },
      onEvent: e => events.push(e),
    });
    await scheduler.acquire(request('p', undefined));
    void scheduler.acquire(request('p', undefined)).catch(() => undefined);
    await expect(
      scheduler.acquire(request('p', undefined)),
    ).rejects.toBeInstanceOf(AdmissionQueueFullError);
    expect(events.filter(e => e.type === 'queue-full')).toHaveLength(1);
  });

  it('removes waiters at their workload wait limit or request deadline', async () => {
    const scheduler = createInMemoryScheduler({
      policy: {
        pools: { p: { maxConcurrent: 1, workloads: { w: { maxWaitMs: 30 } } } },
      },
    });
    await scheduler.acquire(request('p', 'w'));
    await expect(scheduler.acquire(request('p', 'w'))).rejects.toBeInstanceOf(
      AdmissionTimeoutError,
    );
    await expect(
      scheduler.acquire(request('p', 'w', { timeoutMs: 5 })),
    ).rejects.toBeInstanceOf(AdmissionTimeoutError);
    expect((await scheduler.stats('p')).queued).toBe(0);
  });

  it('rejects unknown pools and workloads', async () => {
    const scheduler = createInMemoryScheduler({ policy: sharedModel });
    await expect(
      scheduler.acquire(request('nope', undefined)),
    ).rejects.toBeInstanceOf(AdmissionConfigError);
    expect(() => {
      scheduler.validate({ pool: 'shared-model', workload: 'batch' });
    }).toThrow(AdmissionConfigError);
  });

  it('isolates pools', async () => {
    const scheduler = createInMemoryScheduler({
      policy: { pools: { a: { maxConcurrent: 1 }, b: { maxConcurrent: 1 } } },
    });
    await scheduler.acquire(request('a', undefined));
    await expect(
      scheduler.acquire(request('b', undefined)),
    ).resolves.toMatchObject({
      pool: 'b',
    });
  });
});
