import { describe, expect, it } from 'vitest';
import type { ConcurrencyLimits } from './concurrency.js';
import {
  concurrencyLimitsFingerprint,
  resolveConcurrencyLimits,
  resolveWorkload,
  selectConcurrencyGrants,
  type ConcurrencyWaiter,
} from './concurrency-policy.js';
import { ConcurrencyConfigError } from './errors.js';

const sharedModel: ConcurrencyLimits = {
  maxConcurrent: 8,
  maxQueued: 200,
  workloads: {
    interactive: { reserved: 2, priority: 10, maxWaitMs: 60_000 },
    background: { maxConcurrent: 6, maxWaitMs: 300_000 },
  },
};

const limits = resolveConcurrencyLimits(sharedModel);

const waiters = (...entries: [string, string][]): ConcurrencyWaiter[] =>
  entries.map(([id, workload], seq) => ({ id, workload, seq }));

describe('resolveConcurrencyLimits', () => {
  it('fills defaults and an implicit default workload', () => {
    expect(resolveConcurrencyLimits({ maxConcurrent: 3 })).toEqual({
      maxConcurrent: 3,
      maxQueued: undefined,
      defaultWorkload: 'default',
      workloads: {
        default: {
          maxConcurrent: 3,
          reserved: 0,
          priority: 0,
          maxWaitMs: undefined,
        },
      },
    });
  });

  it.each<[string, ConcurrencyLimits]>([
    ['a negative limit', { maxConcurrent: -1 }],
    ['a zero limit', { maxConcurrent: 0 }],
    ['a fractional limit', { maxConcurrent: 1.5 }],
    ['a negative queue', { maxConcurrent: 1, maxQueued: -1 }],
    [
      'a workload ceiling above the limit',
      { maxConcurrent: 2, workloads: { a: { maxConcurrent: 3 } } },
    ],
    [
      'a reservation above its ceiling',
      { maxConcurrent: 4, workloads: { a: { maxConcurrent: 1, reserved: 2 } } },
    ],
    [
      'reservations above the limit',
      {
        maxConcurrent: 3,
        workloads: { a: { reserved: 2 }, b: { reserved: 2 } },
      },
    ],
    [
      'a negative reservation',
      { maxConcurrent: 3, workloads: { a: { reserved: -1 } } },
    ],
    ['an unknown default workload', { maxConcurrent: 1, defaultWorkload: 'x' }],
    ['no workloads', { maxConcurrent: 1, workloads: {} }],
  ])('rejects %s', (_name, value) => {
    expect(() => resolveConcurrencyLimits(value)).toThrow(
      ConcurrencyConfigError,
    );
  });
});

describe('resolveWorkload', () => {
  it('rejects unknown workloads and inherited object keys', () => {
    expect(() => resolveWorkload(limits, 'batch')).toThrow(/Unknown workload/);
    expect(() => resolveWorkload(limits, 'toString')).toThrow(
      ConcurrencyConfigError,
    );
  });

  it('requires a selection when there is no default', () => {
    expect(() => resolveWorkload(limits, undefined)).toThrow(
      /no default workload; select one of "interactive", "background"/,
    );
  });

  it('uses the only workload as the default', () => {
    const single = resolveConcurrencyLimits({
      maxConcurrent: 2,
      workloads: { batch: {} },
    });
    expect(resolveWorkload(single, undefined).name).toBe('batch');
  });
});

describe('selectConcurrencyGrants', () => {
  it('keeps reserved slots away from other workloads', () => {
    const backlog = waiters(
      ...Array.from(
        { length: 10 },
        (_, i) => [`b${i}`, 'background'] as [string, string],
      ),
    );
    expect(selectConcurrencyGrants(limits, new Map(), backlog)).toEqual([
      'b0',
      'b1',
      'b2',
      'b3',
      'b4',
      'b5',
    ]);
  });

  it('gives interactive work its reserved slots while background is saturated', () => {
    expect(
      selectConcurrencyGrants(
        limits,
        new Map([['background', 6]]),
        waiters(
          ['b6', 'background'],
          ['i0', 'interactive'],
          ['i1', 'interactive'],
        ),
      ),
    ).toEqual(['i0', 'i1']);
  });

  it('does not lend reserved slots when their owner is idle', () => {
    expect(
      selectConcurrencyGrants(
        limits,
        new Map([['background', 5]]),
        waiters(['b5', 'background'], ['b6', 'background']),
      ),
    ).toEqual(['b5']);
  });

  it('prefers higher priority, then the oldest head of queue', () => {
    const prioritized = resolveConcurrencyLimits({
      maxConcurrent: 1,
      workloads: { lo: {}, hi: { priority: 5 } },
    });
    expect(
      selectConcurrencyGrants(
        prioritized,
        new Map(),
        waiters(['lo1', 'lo'], ['hi1', 'hi'], ['hi2', 'hi']),
      ),
    ).toEqual(['hi1']);
    const tie = resolveConcurrencyLimits({
      maxConcurrent: 1,
      workloads: { a: {}, b: {} },
    });
    expect(
      selectConcurrencyGrants(
        tie,
        new Map(),
        waiters(['b1', 'b'], ['a1', 'a']),
      ),
    ).toEqual(['b1']);
  });

  it('does not let a workload at its ceiling block another workload', () => {
    expect(
      selectConcurrencyGrants(
        limits,
        new Map([
          ['background', 6],
          ['interactive', 1],
        ]),
        waiters(['b6', 'background'], ['i1', 'interactive']),
      ),
    ).toEqual(['i1']);
  });

  it('never exceeds maxConcurrent', () => {
    expect(
      selectConcurrencyGrants(
        limits,
        new Map([['interactive', 7]]),
        waiters(['i7', 'interactive'], ['i8', 'interactive']),
      ),
    ).toEqual(['i7']);
  });
});

describe('concurrencyLimitsFingerprint', () => {
  it('ignores key order and changes with the limits', () => {
    const a = resolveConcurrencyLimits({
      maxConcurrent: 4,
      workloads: { x: { reserved: 1 }, y: {} },
    });
    const b = resolveConcurrencyLimits({
      maxConcurrent: 4,
      workloads: { y: {}, x: { reserved: 1 } },
    });
    const c = resolveConcurrencyLimits({
      maxConcurrent: 5,
      workloads: { y: {}, x: { reserved: 1 } },
    });
    expect(concurrencyLimitsFingerprint(a)).toBe(
      concurrencyLimitsFingerprint(b),
    );
    expect(concurrencyLimitsFingerprint(a)).not.toBe(
      concurrencyLimitsFingerprint(c),
    );
  });
});
