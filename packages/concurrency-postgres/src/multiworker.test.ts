/**
 * Multi-process integration tests against a real PostgreSQL server. Each
 * worker is a separate Node process with its own `pg.Pool` and limiter, so
 * the processes share nothing but the database, and transactions run on
 * parallel connections.
 *
 * The parent checks the invariants at the source: it samples the granted
 * entries in the database every few milliseconds, independent of what the
 * workers report.
 *
 * Run with:
 *   RUNCELL_PG_TEST_URL=postgres://user:pass@localhost:5432/db npm test
 */
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConcurrencyLimits } from 'runcell';
import type { WorkerConfig } from './multiworker.fixture.js';

const pgUrl = process.env.RUNCELL_PG_TEST_URL;
const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, 'multiworker.fixture.ts');

interface WorkerEvent {
  type: 'ready' | 'acquired' | 'released' | 'rejected' | 'done' | 'fatal';
  pid: number;
  t: number;
  waitMs?: number;
  workload?: string;
  leaseId?: string;
  error?: string;
}

interface Worker {
  proc: ChildProcess;
  events: WorkerEvent[];
  /** Resolves when the process exits; rejects on a fatal event or a nonzero exit. */
  exited: Promise<void>;
  waitFor(
    predicate: (events: WorkerEvent[]) => boolean,
    timeoutMs?: number,
  ): Promise<void>;
}

let prefixCounter = 0;
const prefixes: string[] = [];
function freshPrefix(): string {
  prefixCounter += 1;
  const prefix = `mw_${process.pid}_${prefixCounter}`;
  prefixes.push(prefix);
  return prefix;
}

function startWorker(
  config: Omit<WorkerConfig, 'url'>,
  options: { expectKill?: boolean } = {},
): Worker {
  const proc = spawn(
    process.execPath,
    ['--import', 'tsx', fixture, JSON.stringify({ ...config, url: pgUrl })],
    { cwd: path.join(here, '..'), stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const events: WorkerEvent[] = [];
  const listeners = new Set<() => void>();
  let buffer = '';
  let stderr = '';
  proc.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) events.push(JSON.parse(line) as WorkerEvent);
      index = buffer.indexOf('\n');
    }
    for (const listener of listeners) listener();
  });
  proc.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exited = new Promise<void>((resolve, reject) => {
    // `close` fires after stdout is drained; `exit` can fire before it.
    proc.on('close', (code, signal) => {
      const fatal = events.find(e => e.type === 'fatal');
      if (fatal) {
        reject(new Error(`worker fatal: ${fatal.error ?? ''}`));
      } else if (code === 0 || (options.expectKill && signal === 'SIGKILL')) {
        resolve();
      } else {
        reject(new Error(`worker exited with ${code ?? signal}: ${stderr}`));
      }
    });
  });
  const waitFor: Worker['waitFor'] = (predicate, timeoutMs = 20_000) =>
    new Promise((resolve, reject) => {
      const check = () => {
        if (predicate(events)) {
          listeners.delete(check);
          clearTimeout(timer);
          resolve();
        }
      };
      const timer = setTimeout(() => {
        listeners.delete(check);
        reject(
          new Error(
            `timed out waiting for worker events: ${JSON.stringify(events.slice(-5))} ${stderr}`,
          ),
        );
      }, timeoutMs);
      listeners.add(check);
      check();
    });
  return { proc, events, exited, waitFor };
}

interface Sample {
  active: number;
  queued: number;
  byWorkload: Record<string, number>;
}

/** Samples granted, unexpired entries straight from the database. */
function startSampler(db: import('pg').Pool, prefix: string) {
  const samples: Sample[] = [];
  const state = { running: true };
  const table = `"${prefix}_entries"`;
  const loop = (async () => {
    while (state.running) {
      try {
        const { rows } = await db.query<{
          workload: string;
          state: string;
          n: number;
        }>(
          `SELECT workload, state, count(*)::int AS n FROM ${table}
           WHERE (state = 'granted' AND lease_expires_at > now()) OR state = 'waiting'
           GROUP BY workload, state`,
        );
        const sample: Sample = { active: 0, queued: 0, byWorkload: {} };
        for (const row of rows) {
          if (row.state === 'granted') {
            sample.active += row.n;
            sample.byWorkload[row.workload] =
              (sample.byWorkload[row.workload] ?? 0) + row.n;
          } else {
            sample.queued += row.n;
          }
        }
        samples.push(sample);
      } catch {
        // The table does not exist until the first worker creates it.
      }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  })();
  return {
    samples,
    max: (pick: (s: Sample) => number) => Math.max(0, ...samples.map(pick)),
    latest: () => samples.at(-1),
    async stop() {
      state.running = false;
      await loop;
    },
  };
}

/** Peak overlap of the intervals that workers reported holding a slot. */
function peakOverlap(workers: Worker[], workload?: string): number {
  const points: [number, number][] = [];
  for (const worker of workers) {
    const open = new Map<string, WorkerEvent>();
    for (const event of worker.events) {
      if (event.type === 'acquired' && event.leaseId) {
        if (workload === undefined || event.workload === workload) {
          open.set(event.leaseId, event);
          points.push([event.t, 1]);
        }
      } else if (
        event.type === 'released' &&
        event.leaseId &&
        open.has(event.leaseId)
      ) {
        points.push([event.t, -1]);
      }
    }
  }
  // At equal timestamps, count releases first, so touching intervals do not overlap.
  points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let current = 0;
  let peak = 0;
  for (const [, delta] of points) {
    current += delta;
    peak = Math.max(peak, current);
  }
  return peak;
}

const count = (workers: Worker[], type: WorkerEvent['type']) =>
  workers.reduce((n, w) => n + w.events.filter(e => e.type === type).length, 0);

describe.runIf(Boolean(pgUrl))('postgres limiter across processes', () => {
  let db: import('pg').Pool;

  beforeAll(async () => {
    const { default: pg } = await import('pg');
    db = new pg.Pool({ connectionString: pgUrl, max: 4 });
  });

  afterAll(async () => {
    for (const prefix of prefixes) {
      await db.query(
        `DROP TABLE IF EXISTS "${prefix}_entries", "${prefix}_limiters"`,
      );
    }
    await db.end();
  });

  const base = {
    name: 'shared-model',
    leaseTtlMs: 30_000,
    pollIntervalMs: 20,
    queueEntryTtlMs: 5_000,
  };

  it('keeps the limit and the workload ceiling across four processes', async () => {
    const tablePrefix = freshPrefix();
    const limits: ConcurrencyLimits = {
      maxConcurrent: 8,
      maxQueued: 200,
      workloads: {
        interactive: { maxConcurrent: 8, reserved: 2, priority: 10 },
        background: { maxConcurrent: 6 },
      },
    };
    const sampler = startSampler(db, tablePrefix);
    const workers = [0, 1, 2, 3].map(i =>
      startWorker({
        ...base,
        tablePrefix,
        limits,
        workload: i % 2 === 0 ? 'background' : 'interactive',
        mode: 'cycle',
        count: 15,
        parallel: 6,
        holdMs: 40,
      }),
    );
    await Promise.all(workers.map(w => w.exited));
    await sampler.stop();

    expect(count(workers, 'acquired')).toBe(60);
    expect(count(workers, 'rejected')).toBe(0);
    expect(sampler.max(s => s.active)).toBeLessThanOrEqual(8);
    expect(sampler.max(s => s.byWorkload.background ?? 0)).toBeLessThanOrEqual(
      6,
    );
    expect(peakOverlap(workers)).toBeLessThanOrEqual(8);
    expect(peakOverlap(workers, 'background')).toBeLessThanOrEqual(6);
    // The limit is reached, so the test exercises real contention.
    expect(sampler.max(s => s.active)).toBe(8);
    expect(sampler.latest()).toMatchObject({ active: 0, queued: 0 });
  }, 60_000);

  it('gives interactive requests their reserved slots under a background backlog', async () => {
    const tablePrefix = freshPrefix();
    // No background ceiling: only the reservation keeps two slots free.
    const limits: ConcurrencyLimits = {
      maxConcurrent: 8,
      workloads: {
        interactive: { reserved: 2, priority: 10 },
        background: {},
      },
    };
    const sampler = startSampler(db, tablePrefix);
    const backlog = [0, 1, 2].map(() =>
      startWorker({
        ...base,
        tablePrefix,
        limits,
        workload: 'background',
        mode: 'cycle',
        count: 6,
        parallel: 6,
        holdMs: 1_500,
      }),
    );
    // Wait for a saturated background backlog.
    await expect
      .poll(
        () => {
          const s = sampler.latest();
          return (
            s !== undefined &&
            (s.byWorkload.background ?? 0) === 6 &&
            s.queued >= 6
          );
        },
        { timeout: 20_000, interval: 20 },
      )
      .toBe(true)
      .catch((error: unknown) => {
        throw new Error(
          `backlog never saturated; last samples ${JSON.stringify(sampler.samples.slice(-3))}, max background ${sampler.max(s => s.byWorkload.background ?? 0)}, max active ${sampler.max(s => s.active)}, events ${JSON.stringify(backlog.map(w => w.events.slice(-3)))}`,
          { cause: error },
        );
      });

    const interactive = startWorker({
      ...base,
      tablePrefix,
      limits,
      workload: 'interactive',
      mode: 'cycle',
      count: 2,
      parallel: 2,
      holdMs: 50,
    });
    await interactive.exited;
    const waits = interactive.events
      .filter(e => e.type === 'acquired')
      .map(e => e.waitMs ?? Infinity);
    expect(waits).toHaveLength(2);
    // Far below the 1.5 s background hold: they did not wait for a release.
    for (const wait of waits) expect(wait).toBeLessThan(1_000);

    await Promise.all(backlog.map(w => w.exited));
    await sampler.stop();
    expect(sampler.max(s => s.byWorkload.background ?? 0)).toBeLessThanOrEqual(
      6,
    );
    expect(sampler.max(s => s.active)).toBeLessThanOrEqual(8);
    expect(count(backlog, 'acquired')).toBe(18);
  }, 60_000);

  it('reclaims slots and queue entries of killed workers', async () => {
    const tablePrefix = freshPrefix();
    const limits: ConcurrencyLimits = { maxConcurrent: 1 };
    const crash = { ...base, leaseTtlMs: 1_500, queueEntryTtlMs: 1_000 };
    const sampler = startSampler(db, tablePrefix);

    // A worker takes the only slot and dies without releasing it.
    const holder = startWorker(
      {
        ...crash,
        tablePrefix,
        limits,
        workload: undefined,
        mode: 'hold',
        count: 1,
        parallel: 1,
        holdMs: 0,
      },
      { expectKill: true },
    );
    await holder.waitFor(events => events.some(e => e.type === 'acquired'));
    // A second worker queues behind it and also dies.
    const waiter = startWorker(
      {
        ...crash,
        tablePrefix,
        limits,
        workload: undefined,
        mode: 'hold',
        count: 1,
        parallel: 1,
        holdMs: 0,
      },
      { expectKill: true },
    );
    await expect
      .poll(() => sampler.latest()?.queued, { timeout: 20_000, interval: 20 })
      .toBe(1);
    const killedAt = Date.now();
    holder.proc.kill('SIGKILL');
    waiter.proc.kill('SIGKILL');
    await Promise.all([holder.exited, waiter.exited]);

    // A healthy worker gets the slot once the dead lease expires.
    const survivor = startWorker({
      ...crash,
      tablePrefix,
      limits,
      workload: undefined,
      mode: 'cycle',
      count: 1,
      parallel: 1,
      holdMs: 10,
    });
    await survivor.exited;
    const acquired = survivor.events.find(e => e.type === 'acquired');
    expect(acquired).toBeDefined();
    const recoveredAfter = (acquired?.t ?? Infinity) - killedAt;
    expect(recoveredAfter).toBeLessThan(1_500 + 3_000);

    // The dead waiter's queue entry is gone.
    const rows = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM "${tablePrefix}_entries" WHERE state <> 'granted'`,
    );
    expect(rows.rows[0]?.n).toBe(0);
    await sampler.stop();
    expect(sampler.max(s => s.active)).toBeLessThanOrEqual(1);
  }, 60_000);

  it('leaks no slot when grants race cancellation in several processes', async () => {
    const tablePrefix = freshPrefix();
    const limits: ConcurrencyLimits = { maxConcurrent: 3 };
    const sampler = startSampler(db, tablePrefix);
    const workers = [0, 1, 2].map(() =>
      startWorker({
        ...base,
        tablePrefix,
        limits,
        workload: undefined,
        mode: 'cycle',
        count: 30,
        parallel: 8,
        // 24 requests share 3 slots, so each waits up to ~160 ms. Aborts
        // spread over 300 ms land both while waiting and after the grant,
        // on fast and slow machines.
        holdMs: 20,
        abortWithinMs: 300,
      }),
    );
    await Promise.all(workers.map(w => w.exited));
    await sampler.stop();
    expect(sampler.max(s => s.active)).toBeLessThanOrEqual(3);
    expect(count(workers, 'acquired') + count(workers, 'rejected')).toBe(90);
    // Both outcomes happened, so the race was exercised.
    expect(count(workers, 'rejected')).toBeGreaterThan(0);
    expect(count(workers, 'acquired')).toBeGreaterThan(0);
    const rows = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM "${tablePrefix}_entries"`,
    );
    expect(rows.rows[0]?.n).toBe(0);

    // Full capacity is still available afterwards.
    const check = startWorker({
      ...base,
      tablePrefix,
      limits,
      workload: undefined,
      mode: 'cycle',
      count: 3,
      parallel: 3,
      holdMs: 200,
    });
    await check.exited;
    expect(count([check], 'acquired')).toBe(3);
    expect(
      Math.max(
        ...check.events
          .filter(e => e.type === 'acquired')
          .map(e => e.waitMs ?? 0),
      ),
    ).toBeLessThan(1_000);
  }, 60_000);
});
