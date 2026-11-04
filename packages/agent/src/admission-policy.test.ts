import { describe, expect, it } from 'vitest';
import {
  admissionPoolFingerprint,
  normalizeAdmissionPolicy,
  resolveAdmissionTarget,
  selectAdmissionGrants,
  type AdmissionPolicy,
  type AdmissionWaiter,
} from './admission-policy.js';
import { AdmissionConfigError } from './errors.js';

const example: AdmissionPolicy = {
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

function onlyPool(policy: AdmissionPolicy) {
  const [pool] = Object.values(normalizeAdmissionPolicy(policy).pools);
  if (!pool) throw new Error('policy has no pool');
  return pool;
}

const pool = onlyPool(example);

const waiters = (...entries: [string, string][]): AdmissionWaiter[] =>
  entries.map(([id, workload], seq) => ({ id, workload, seq }));

describe('normalizeAdmissionPolicy', () => {
  it('fills defaults and an implicit default workload', () => {
    const policy = normalizeAdmissionPolicy({
      pools: { p: { maxConcurrent: 3 } },
    });
    expect(policy.pools['p']).toEqual({
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

  it.each<[string, AdmissionPolicy]>([
    ['negative pool limit', { pools: { p: { maxConcurrent: -1 } } }],
    ['zero pool limit', { pools: { p: { maxConcurrent: 0 } } }],
    ['fractional limit', { pools: { p: { maxConcurrent: 1.5 } } }],
    ['negative queue', { pools: { p: { maxConcurrent: 1, maxQueued: -1 } } }],
    [
      'workload above pool',
      {
        pools: {
          p: { maxConcurrent: 2, workloads: { a: { maxConcurrent: 3 } } },
        },
      },
    ],
    [
      'reservation above workload',
      {
        pools: {
          p: {
            maxConcurrent: 4,
            workloads: { a: { maxConcurrent: 1, reserved: 2 } },
          },
        },
      },
    ],
    [
      'reservations above pool',
      {
        pools: {
          p: {
            maxConcurrent: 3,
            workloads: { a: { reserved: 2 }, b: { reserved: 2 } },
          },
        },
      },
    ],
    [
      'negative reservation',
      {
        pools: { p: { maxConcurrent: 3, workloads: { a: { reserved: -1 } } } },
      },
    ],
    [
      'unknown default workload',
      { pools: { p: { maxConcurrent: 1, defaultWorkload: 'x' } } },
    ],
    ['no pools', { pools: {} }],
  ])('rejects %s', (_name, policy) => {
    expect(() => normalizeAdmissionPolicy(policy)).toThrow(
      AdmissionConfigError,
    );
  });
});

describe('resolveAdmissionTarget', () => {
  const policy = normalizeAdmissionPolicy(example);

  it('rejects unknown pools and workloads', () => {
    expect(() => resolveAdmissionTarget(policy, 'nope', undefined)).toThrow(
      /Unknown admission pool/,
    );
    expect(() =>
      resolveAdmissionTarget(policy, 'shared-model', 'batch'),
    ).toThrow(/Unknown admission workload/);
  });

  it('requires an explicit workload when the pool has no default', () => {
    expect(() =>
      resolveAdmissionTarget(policy, 'shared-model', undefined),
    ).toThrow(/no default workload/);
  });

  it('does not resolve inherited object keys', () => {
    expect(() => resolveAdmissionTarget(policy, 'toString', undefined)).toThrow(
      AdmissionConfigError,
    );
  });
});

describe('selectAdmissionGrants', () => {
  it('keeps reserved capacity away from other workloads', () => {
    const backlog = waiters(
      ...Array.from(
        { length: 10 },
        (_, i) => [`b${i}`, 'background'] as [string, string],
      ),
    );
    const grants = selectAdmissionGrants(pool, new Map(), backlog);
    expect(grants).toEqual(['b0', 'b1', 'b2', 'b3', 'b4', 'b5']);
  });

  it('grants protected capacity to interactive work while background is saturated', () => {
    const grants = selectAdmissionGrants(
      pool,
      new Map([['background', 6]]),
      waiters(
        ['b6', 'background'],
        ['i0', 'interactive'],
        ['i1', 'interactive'],
      ),
    );
    expect(grants).toEqual(['i0', 'i1']);
  });

  it('does not lend reserved capacity even when the owner is idle', () => {
    const grants = selectAdmissionGrants(
      pool,
      new Map([['background', 5]]),
      waiters(['b5', 'background'], ['b6', 'background']),
    );
    expect(grants).toEqual(['b5']);
  });

  it('prefers higher priority, then FIFO within a workload', () => {
    const grants = selectAdmissionGrants(
      pool,
      new Map([['background', 6]]),
      waiters(
        ['b6', 'background'],
        ['i0', 'interactive'],
        ['i1', 'interactive'],
      ),
    );
    expect(grants[0]).toBe('i0');
    const mixed = selectAdmissionGrants(
      onlyPool({
        pools: {
          p: { maxConcurrent: 1, workloads: { lo: {}, hi: { priority: 5 } } },
        },
      }),
      new Map(),
      waiters(['lo1', 'lo'], ['hi1', 'hi'], ['hi2', 'hi']),
    );
    expect(mixed).toEqual(['hi1']);
  });

  it('breaks priority ties by the oldest head of queue', () => {
    const tie = onlyPool({
      pools: { p: { maxConcurrent: 1, workloads: { a: {}, b: {} } } },
    });
    expect(
      selectAdmissionGrants(tie, new Map(), waiters(['b1', 'b'], ['a1', 'a'])),
    ).toEqual(['b1']);
  });

  it('does not let a workload at its ceiling block another workload', () => {
    const grants = selectAdmissionGrants(
      pool,
      new Map([
        ['background', 6],
        ['interactive', 1],
      ]),
      // Background is first in line but at its ceiling.
      waiters(['b6', 'background'], ['i1', 'interactive']),
    );
    expect(grants).toEqual(['i1']);
  });

  it('never exceeds the pool limit', () => {
    const grants = selectAdmissionGrants(
      pool,
      new Map([['interactive', 7]]),
      waiters(['i7', 'interactive'], ['i8', 'interactive']),
    );
    expect(grants).toEqual(['i7']);
  });
});

describe('admissionPoolFingerprint', () => {
  it('is stable across key order and changes with the policy', () => {
    const a = onlyPool({
      pools: {
        p: { maxConcurrent: 4, workloads: { x: { reserved: 1 }, y: {} } },
      },
    });
    const b = onlyPool({
      pools: {
        p: { maxConcurrent: 4, workloads: { y: {}, x: { reserved: 1 } } },
      },
    });
    const c = onlyPool({
      pools: {
        p: { maxConcurrent: 5, workloads: { y: {}, x: { reserved: 1 } } },
      },
    });
    expect(admissionPoolFingerprint(a)).toBe(admissionPoolFingerprint(b));
    expect(admissionPoolFingerprint(a)).not.toBe(admissionPoolFingerprint(c));
  });
});
