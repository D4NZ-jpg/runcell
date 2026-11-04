/**
 * Runs the limiter against PGlite (in-process PostgreSQL). PGlite has a
 * single connection, so the test pool hands it to one client at a time:
 * transactions from independent limiter instances ("workers") interleave
 * at transaction boundaries, the way a real database serializes them on the
 * limiter's row lock. Parallel connections are not exercised here.
 */
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ConcurrencyConfigError,
  ConcurrencyQueueFullError,
  ConcurrencyTimeoutError,
  type ConcurrencyLease,
  type ConcurrencyLimits,
  type ConcurrencyRequest,
} from 'runcell';
import { concurrencyConformanceCases } from 'runcell/concurrency';
import {
  createPostgresConcurrencyLimiter,
  postgresConcurrencySchemaSql,
  type PostgresConcurrencyLimiterOptions,
  type PostgresPool,
} from './index.js';

let pg: PGlite;
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
  pg = await PGlite.create();
}, 60_000);

afterAll(async () => {
  await pg.close();
});

const freshPrefix = () => `cc_${(prefixCounter += 1)}`;

function limiter(
  limits: ConcurrencyLimits,
  extra: Partial<PostgresConcurrencyLimiterOptions> = {},
) {
  return createPostgresConcurrencyLimiter({
    db: pglitePool(pg),
    name: 'shared',
    pollIntervalMs: 10,
    queueEntryTtlMs: 2_000,
    ...limits,
    ...extra,
  });
}

let requestCounter = 0;
function request(
  workload: string | undefined,
  extra: Partial<ConcurrencyRequest> = {},
): ConcurrencyRequest {
  requestCounter += 1;
  return {
    workload,
    runId: `run-${requestCounter}`,
    rootRunId: `run-${requestCounter}`,
    parentRunId: undefined,
    requestId: `req-${requestCounter}`,
    metadata: {},
    timeoutMs: undefined,
    signal: new AbortController().signal,
    ...extra,
  };
}

const sharedModel: ConcurrencyLimits = {
  maxConcurrent: 8,
  maxQueued: 200,
  workloads: {
    interactive: { reserved: 2, priority: 10, maxWaitMs: 60_000 },
    background: { maxConcurrent: 6, maxWaitMs: 300_000 },
  },
};

describe('postgres limiter conformance', () => {
  for (const testCase of concurrencyConformanceCases({
    leaseTtlMs: 400,
    createLimiter: ({ capacity, leaseTtlMs }) =>
      limiter(
        { maxConcurrent: capacity },
        { tablePrefix: freshPrefix(), leaseTtlMs },
      ),
  })) {
    it(testCase.name, () => testCase.run(), 30_000);
  }
});

describe('createPostgresConcurrencyLimiter', () => {
  it('enforces the limit and workload ceilings across independent workers', async () => {
    const tablePrefix = freshPrefix();
    const workers = [1, 2, 3].map(() => limiter(sharedModel, { tablePrefix }));
    let active = 0;
    let peak = 0;
    let background = 0;
    let peakBackground = 0;
    const run = async (
      index: number,
      workload: 'interactive' | 'background',
    ) => {
      const worker = workers[index % workers.length];
      if (!worker) throw new Error('no worker');
      const lease = await worker.acquire(request(workload));
      active += 1;
      if (workload === 'background') background += 1;
      peak = Math.max(peak, active);
      peakBackground = Math.max(peakBackground, background);
      await new Promise(resolve => setTimeout(resolve, 15));
      active -= 1;
      if (workload === 'background') background -= 1;
      await worker.release(lease);
    };
    await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        run(i, i % 3 === 0 ? 'interactive' : 'background'),
      ),
    );
    expect(peak).toBeLessThanOrEqual(8);
    expect(peakBackground).toBeLessThanOrEqual(6);
    expect(await workers[0]?.stats()).toMatchObject({ active: 0, queued: 0 });
  }, 30_000);

  it('serves interactive requests from reserved slots under a background backlog', async () => {
    const tablePrefix = freshPrefix();
    const a = limiter(sharedModel, { tablePrefix });
    const b = limiter(sharedModel, { tablePrefix });
    const backlog: Promise<ConcurrencyLease>[] = [];
    for (let i = 0; i < 10; i += 1) {
      backlog.push((i % 2 ? a : b).acquire(request('background')));
    }
    await expect
      .poll(async () => (await a.stats()).workloads.background)
      .toEqual({ active: 6, queued: 4 });

    const startedAt = Date.now();
    const interactive = await Promise.all([
      a.acquire(request('interactive')),
      b.acquire(request('interactive')),
    ]);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    const stats = await a.stats();
    expect(stats.active).toBe(8);
    expect(stats.workloads.background?.active).toBe(6);

    for (const lease of interactive) await a.release(lease);
    for (const lease of await Promise.all(backlog.slice(0, 6))) {
      await b.release(lease);
    }
    for (const lease of await Promise.all(backlog.slice(6))) {
      await a.release(lease);
    }
  }, 30_000);

  it('grants by priority across workloads and FIFO within one', async () => {
    const worker = limiter(
      { maxConcurrent: 1, workloads: { lo: {}, hi: { priority: 5 } } },
      { tablePrefix: freshPrefix() },
    );
    const holder = await worker.acquire(request('lo'));
    const order: string[] = [];
    const track = (label: string, workload: string) =>
      worker.acquire(request(workload)).then(async lease => {
        order.push(label);
        await worker.release(lease);
      });
    const pending = [track('lo-1', 'lo')];
    await expect.poll(async () => (await worker.stats()).queued).toBe(1);
    pending.push(track('hi-1', 'hi'));
    await expect.poll(async () => (await worker.stats()).queued).toBe(2);
    pending.push(track('hi-2', 'hi'));
    await expect.poll(async () => (await worker.stats()).queued).toBe(3);
    await worker.release(holder);
    await Promise.all(pending);
    expect(order).toEqual(['hi-1', 'hi-2', 'lo-1']);
  }, 30_000);

  it('rejects requests beyond the queue limit', async () => {
    const worker = limiter(
      { maxConcurrent: 1, maxQueued: 1 },
      { tablePrefix: freshPrefix() },
    );
    const holder = await worker.acquire(request(undefined));
    const controller = new AbortController();
    const queued = worker.acquire(
      request(undefined, { signal: controller.signal }),
    );
    await expect.poll(async () => (await worker.stats()).queued).toBe(1);
    await expect(worker.acquire(request(undefined))).rejects.toBeInstanceOf(
      ConcurrencyQueueFullError,
    );
    controller.abort(new Error('done'));
    await expect(queued).rejects.toThrow('done');
    await worker.release(holder);
    expect(await worker.stats()).toMatchObject({ active: 0, queued: 0 });
  });

  it('removes a waiting request at its database-time deadline', async () => {
    const worker = limiter(
      { maxConcurrent: 1 },
      { tablePrefix: freshPrefix() },
    );
    const holder = await worker.acquire(request(undefined));
    await expect(
      worker.acquire(request(undefined, { timeoutMs: 50 })),
    ).rejects.toBeInstanceOf(ConcurrencyTimeoutError);
    expect((await worker.stats()).queued).toBe(0);
    await worker.release(holder);
  });

  it('leaks no slot when grants race cancellation', async () => {
    const worker = limiter(
      { maxConcurrent: 2 },
      { tablePrefix: freshPrefix() },
    );
    await Promise.all(
      Array.from({ length: 20 }, async (_, i) => {
        const controller = new AbortController();
        const pending = worker.acquire(
          request(undefined, { signal: controller.signal }),
        );
        setTimeout(() => {
          controller.abort(new Error('cancel'));
        }, i % 5);
        try {
          await worker.release(await pending);
        } catch {
          // Cancelled before or after the grant.
        }
      }),
    );
    expect(await worker.stats()).toMatchObject({ active: 0, queued: 0 });
    const a = await worker.acquire(request(undefined));
    const b = await worker.acquire(request(undefined));
    await worker.release(a);
    await worker.release(b);
  }, 30_000);

  it('reclaims a crashed worker’s queue entries and slots', async () => {
    const tablePrefix = freshPrefix();
    const worker = limiter(
      { maxConcurrent: 1 },
      { tablePrefix, leaseTtlMs: 200 },
    );
    // A slot whose worker died without releasing it.
    await worker.acquire(request(undefined));
    // A queued entry at the head whose worker died: no more heartbeats.
    const entries = `"${tablePrefix}_entries"`;
    await pg.query(
      `INSERT INTO ${entries} (id, limiter, workload, state, heartbeat_expires_at, request_id, run_id, root_run_id)
       VALUES ('ghost', 'shared', 'default', 'waiting', now() + interval '100 milliseconds', 'r', 'r', 'r')`,
    );
    const lease = await worker.acquire(request(undefined));
    expect(lease.id).not.toBe('ghost');
    const { rows } = await pg.query(
      `SELECT id FROM ${entries} WHERE id = 'ghost'`,
    );
    expect(rows).toHaveLength(0);
    await worker.release(lease);
  }, 30_000);

  it('rejects workers that share a name with different limits', async () => {
    const tablePrefix = freshPrefix();
    const a = limiter({ maxConcurrent: 2 }, { tablePrefix });
    const b = limiter({ maxConcurrent: 3 }, { tablePrefix });
    await a.release(await a.acquire(request(undefined)));
    await expect(b.acquire(request(undefined))).rejects.toBeInstanceOf(
      ConcurrencyConfigError,
    );
    const c = limiter(
      { maxConcurrent: 3 },
      { tablePrefix, onConflict: 'replace' },
    );
    await c.release(await c.acquire(request(undefined)));
    await expect(a.acquire(request(undefined))).rejects.toBeInstanceOf(
      ConcurrencyConfigError,
    );
    // Different names are independent capacities.
    const other = limiter({ maxConcurrent: 5 }, { tablePrefix, name: 'other' });
    await other.release(await other.acquire(request(undefined)));
  });

  it('surfaces database failures', async () => {
    const db = pglitePool(pg);
    db.failConnect = new Error('connection refused');
    const worker = limiter(
      { maxConcurrent: 1 },
      { db, tablePrefix: freshPrefix() },
    );
    await expect(worker.acquire(request(undefined))).rejects.toThrow(
      'connection refused',
    );
  });

  it('rejects unknown workloads and invalid options', async () => {
    const worker = limiter(sharedModel, { tablePrefix: freshPrefix() });
    await expect(worker.acquire(request('batch'))).rejects.toBeInstanceOf(
      ConcurrencyConfigError,
    );
    expect(() => {
      worker.validateWorkload(undefined);
    }).toThrow(/no default workload/);
    expect(() =>
      limiter({ maxConcurrent: 1 }, { tablePrefix: 'bad-name' }),
    ).toThrow(ConcurrencyConfigError);
    expect(() => limiter({ maxConcurrent: 1 }, { name: '' })).toThrow(
      ConcurrencyConfigError,
    );
    expect(() =>
      limiter(
        { maxConcurrent: 1 },
        { pollIntervalMs: 1_000, queueEntryTtlMs: 1_500 },
      ),
    ).toThrow(ConcurrencyConfigError);
  });

  it('exposes an idempotent schema migration', async () => {
    const statements = postgresConcurrencySchemaSql('migrated.concurrency');
    await pg.query('CREATE SCHEMA IF NOT EXISTS migrated');
    for (const statement of [...statements, ...statements]) {
      await pg.query(statement);
    }
    const worker = limiter(
      { maxConcurrent: 1 },
      { tablePrefix: 'migrated.concurrency', ensureSchema: false },
    );
    await worker.release(await worker.acquire(request(undefined)));
  });
});
