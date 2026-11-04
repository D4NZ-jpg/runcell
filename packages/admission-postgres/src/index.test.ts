/**
 * Runs the scheduler against PGlite (in-process PostgreSQL). PGlite has a
 * single connection, so the test pool hands it to one client at a time:
 * transactions from independent scheduler instances ("workers") interleave
 * at transaction granularity, like a real database serializes them on the
 * pool's row lock. True parallel connections are not exercised here.
 */
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AdmissionConfigError,
  AdmissionQueueFullError,
  AdmissionTimeoutError,
  admissionConformanceCases,
  type AdmissionLease,
  type AdmissionPolicy,
  type AdmissionRequest,
  type AdmissionSchedulerEvent,
} from 'runcell';
import {
  createPostgresScheduler,
  postgresAdmissionSchemaSql,
  type PostgresPool,
  type PostgresSchedulerOptions,
} from './index.js';

let db: PGlite;
let prefixCounter = 0;

function pglitePool(instance: PGlite): PostgresPool & { failConnect?: Error } {
  let tail: Promise<void> = Promise.resolve();
  const pool: PostgresPool & { failConnect?: Error } = {
    async connect() {
      if (pool.failConnect) throw pool.failConnect;
      let unlock!: () => void;
      const previous = tail;
      tail = new Promise<void>(resolve => {
        unlock = resolve;
      });
      await previous;
      let released = false;
      return {
        async query(sql, params) {
          const result = await instance.query<Record<string, unknown>>(
            sql,
            params ? [...params] : [],
          );
          return { rows: result.rows };
        },
        release() {
          if (!released) {
            released = true;
            unlock();
          }
        },
      };
    },
  };
  return pool;
}

beforeAll(async () => {
  db = await PGlite.create();
});

afterAll(async () => {
  await db.close();
});

const freshPrefix = () => `adm_${(prefixCounter += 1)}`;

function scheduler(
  policy: AdmissionPolicy,
  extra: Partial<PostgresSchedulerOptions> & { pool?: PostgresPool } = {},
) {
  return createPostgresScheduler({
    pool: pglitePool(db),
    policy,
    pollIntervalMs: 10,
    queueEntryTtlMs: 2_000,
    ...extra,
  });
}

let requestCounter = 0;
function request(
  pool: string,
  workload: string | undefined,
  extra: Partial<AdmissionRequest> = {},
): AdmissionRequest {
  requestCounter += 1;
  return {
    pool,
    workload,
    runId: `run-${requestCounter}`,
    rootRunId: `run-${requestCounter}`,
    parentRunId: undefined,
    requestId: `req-${requestCounter}`,
    metadata: {},
    deadline: undefined,
    timeoutMs: undefined,
    signal: new AbortController().signal,
    ...extra,
  };
}

const sharedModel: AdmissionPolicy = {
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

describe('postgres scheduler conformance', () => {
  for (const testCase of admissionConformanceCases({
    leaseTtlMs: 400,
    createAdapter: ({ pool, capacity, leaseTtlMs }) =>
      scheduler(
        { pools: { [pool]: { maxConcurrent: capacity } } },
        { tablePrefix: freshPrefix(), leaseTtlMs },
      ),
  })) {
    it(testCase.name, () => testCase.run(), 30_000);
  }
});

describe('createPostgresScheduler', () => {
  it('enforces pool and workload limits across independent workers', async () => {
    const tablePrefix = freshPrefix();
    const workers = [1, 2, 3].map(() =>
      scheduler(sharedModel, { tablePrefix }),
    );
    let active = 0;
    let peak = 0;
    const byWorkload = { interactive: 0, background: 0 };
    const peakBackground = { value: 0 };
    const run = async (
      index: number,
      workload: 'interactive' | 'background',
    ) => {
      const worker = workers[index % workers.length];
      if (!worker) throw new Error('no worker');
      const lease = await worker.acquire(request('shared-model', workload));
      active += 1;
      byWorkload[workload] += 1;
      peak = Math.max(peak, active);
      peakBackground.value = Math.max(
        peakBackground.value,
        byWorkload.background,
      );
      await new Promise(resolve => setTimeout(resolve, 15));
      active -= 1;
      byWorkload[workload] -= 1;
      await worker.release(lease);
    };
    await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        run(i, i % 3 === 0 ? 'interactive' : 'background'),
      ),
    );
    expect(peak).toBeLessThanOrEqual(8);
    expect(peakBackground.value).toBeLessThanOrEqual(6);
    const stats = await workers[0]?.stats('shared-model');
    expect(stats).toMatchObject({ active: 0, queued: 0 });
  }, 30_000);

  it('serves interactive requests from protected capacity under a background backlog', async () => {
    const tablePrefix = freshPrefix();
    const [a, b] = [
      scheduler(sharedModel, { tablePrefix }),
      scheduler(sharedModel, { tablePrefix }),
    ];
    const backlog: Promise<AdmissionLease>[] = [];
    for (let i = 0; i < 10; i += 1) {
      backlog.push(
        (i % 2 ? a : b).acquire(request('shared-model', 'background')),
      );
    }
    // Let the first six grants land.
    await expect
      .poll(async () => (await a.stats('shared-model')).workloads.background)
      .toEqual({ active: 6, queued: 4 });

    const startedAt = Date.now();
    const interactive = await Promise.all([
      a.acquire(request('shared-model', 'interactive')),
      b.acquire(request('shared-model', 'interactive')),
    ]);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    const stats = await a.stats('shared-model');
    expect(stats.active).toBe(8);
    expect(stats.workloads.background?.active).toBe(6);

    for (const lease of interactive) await a.release(lease);
    const granted = await Promise.all(backlog.slice(0, 6));
    for (const lease of granted) await b.release(lease);
    for (const lease of await Promise.all(backlog.slice(6)))
      await a.release(lease);
  }, 30_000);

  it('grants by priority across workloads and FIFO within one', async () => {
    const tablePrefix = freshPrefix();
    const policy: AdmissionPolicy = {
      pools: {
        p: { maxConcurrent: 1, workloads: { lo: {}, hi: { priority: 5 } } },
      },
    };
    const worker = scheduler(policy, { tablePrefix });
    const holder = await worker.acquire(request('p', 'lo'));
    const order: string[] = [];
    const track = (name: string, workload: string) =>
      worker.acquire(request('p', workload)).then(async lease => {
        order.push(name);
        await worker.release(lease);
      });
    const pending = [track('lo-1', 'lo')];
    await expect.poll(async () => (await worker.stats('p')).queued).toBe(1);
    pending.push(track('hi-1', 'hi'));
    await expect.poll(async () => (await worker.stats('p')).queued).toBe(2);
    pending.push(track('hi-2', 'hi'));
    await expect.poll(async () => (await worker.stats('p')).queued).toBe(3);
    await worker.release(holder);
    await Promise.all(pending);
    expect(order).toEqual(['hi-1', 'hi-2', 'lo-1']);
  }, 30_000);

  it('rejects requests beyond the queue limit', async () => {
    const events: AdmissionSchedulerEvent[] = [];
    const worker = scheduler(
      { pools: { p: { maxConcurrent: 1, maxQueued: 1 } } },
      { tablePrefix: freshPrefix(), onEvent: e => events.push(e) },
    );
    const holder = await worker.acquire(request('p', undefined));
    const controller = new AbortController();
    const queued = worker.acquire(
      request('p', undefined, { signal: controller.signal }),
    );
    await expect.poll(async () => (await worker.stats('p')).queued).toBe(1);
    await expect(
      worker.acquire(request('p', undefined)),
    ).rejects.toBeInstanceOf(AdmissionQueueFullError);
    expect(events.some(e => e.type === 'queue-full')).toBe(true);
    controller.abort(new Error('done'));
    await expect(queued).rejects.toThrow('done');
    await worker.release(holder);
    expect(await worker.stats('p')).toMatchObject({ active: 0, queued: 0 });
  });

  it('removes a queued request at its database-time deadline', async () => {
    const worker = scheduler(
      { pools: { p: { maxConcurrent: 1 } } },
      { tablePrefix: freshPrefix() },
    );
    const holder = await worker.acquire(request('p', undefined));
    await expect(
      worker.acquire(request('p', undefined, { timeoutMs: 50 })),
    ).rejects.toBeInstanceOf(AdmissionTimeoutError);
    expect((await worker.stats('p')).queued).toBe(0);
    await worker.release(holder);
  });

  it('leaks no permit when grants race cancellation', async () => {
    const worker = scheduler(
      { pools: { p: { maxConcurrent: 2 } } },
      { tablePrefix: freshPrefix() },
    );
    const attempts = Array.from({ length: 20 }, async (_, i) => {
      const controller = new AbortController();
      const pending = worker.acquire(
        request('p', undefined, { signal: controller.signal }),
      );
      setTimeout(() => {
        controller.abort(new Error('cancel'));
      }, i % 5);
      try {
        const lease = await pending;
        await worker.release(lease);
      } catch {
        // Cancelled before or after the grant.
      }
    });
    await Promise.all(attempts);
    expect(await worker.stats('p')).toMatchObject({ active: 0, queued: 0 });
    const a = await worker.acquire(request('p', undefined));
    const b = await worker.acquire(request('p', undefined));
    await worker.release(a);
    await worker.release(b);
  }, 30_000);

  it('reclaims a crashed worker’s queue entries and leases', async () => {
    const tablePrefix = freshPrefix();
    const worker = scheduler(
      { pools: { p: { maxConcurrent: 1 } } },
      { tablePrefix, leaseTtlMs: 200 },
    );
    // A lease whose worker died without releasing it.
    await worker.acquire(request('p', undefined));
    // A queued entry at the head whose worker died: no more heartbeats.
    const entries = `"${tablePrefix}_entries"`;
    await db.query(
      `INSERT INTO ${entries} (id, pool, workload, state, heartbeat_expires_at, request_id, run_id, root_run_id)
       VALUES ('ghost', 'p', 'default', 'waiting', now() + interval '100 milliseconds', 'r', 'r', 'r')`,
    );
    const lease = await worker.acquire(request('p', undefined));
    expect(lease.id).not.toBe('ghost');
    const { rows } = await db.query(
      `SELECT id FROM ${entries} WHERE id = 'ghost'`,
    );
    expect(rows).toHaveLength(0);
    await worker.release(lease);
  }, 30_000);

  it('rejects conflicting policies for a shared pool', async () => {
    const tablePrefix = freshPrefix();
    const events: AdmissionSchedulerEvent[] = [];
    const a = scheduler(
      { pools: { p: { maxConcurrent: 2 } } },
      { tablePrefix },
    );
    const b = scheduler(
      { pools: { p: { maxConcurrent: 3 } } },
      { tablePrefix, onEvent: e => events.push(e) },
    );
    await a.release(await a.acquire(request('p', undefined)));
    await expect(b.acquire(request('p', undefined))).rejects.toBeInstanceOf(
      AdmissionConfigError,
    );
    expect(events.map(e => e.type)).toContain('config-conflict');
    const c = scheduler(
      { pools: { p: { maxConcurrent: 3 } } },
      { tablePrefix, onPolicyConflict: 'replace' },
    );
    await c.release(await c.acquire(request('p', undefined)));
    await expect(a.acquire(request('p', undefined))).rejects.toBeInstanceOf(
      AdmissionConfigError,
    );
  });

  it('surfaces database failures and emits backend-error', async () => {
    const pool = pglitePool(db);
    pool.failConnect = new Error('connection refused');
    const events: AdmissionSchedulerEvent[] = [];
    const worker = scheduler(
      { pools: { p: { maxConcurrent: 1 } } },
      { pool, tablePrefix: freshPrefix(), onEvent: e => events.push(e) },
    );
    await expect(worker.acquire(request('p', undefined))).rejects.toThrow(
      'connection refused',
    );
    expect(events.map(e => e.type)).toContain('backend-error');
  });

  it('rejects unknown pools and invalid options', async () => {
    const worker = scheduler(
      { pools: { p: { maxConcurrent: 1 } } },
      { tablePrefix: freshPrefix() },
    );
    await expect(
      worker.acquire(request('nope', undefined)),
    ).rejects.toBeInstanceOf(AdmissionConfigError);
    expect(() =>
      scheduler(
        { pools: { p: { maxConcurrent: 1 } } },
        { tablePrefix: 'bad-name' },
      ),
    ).toThrow(AdmissionConfigError);
    expect(() =>
      scheduler(
        { pools: { p: { maxConcurrent: 1 } } },
        { pollIntervalMs: 1_000, queueEntryTtlMs: 1_500 },
      ),
    ).toThrow(AdmissionConfigError);
  });

  it('exposes an idempotent schema migration', async () => {
    const statements = postgresAdmissionSchemaSql('migrated.admission');
    await db.query('CREATE SCHEMA IF NOT EXISTS migrated');
    for (const statement of [...statements, ...statements]) {
      await db.query(statement);
    }
    const worker = scheduler(
      { pools: { p: { maxConcurrent: 1 } } },
      { tablePrefix: 'migrated.admission', ensureSchema: false },
    );
    await worker.release(await worker.acquire(request('p', undefined)));
  });
});
