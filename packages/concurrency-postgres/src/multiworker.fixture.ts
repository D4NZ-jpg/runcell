/**
 * One worker process for the multi-process tests. It creates its own
 * `pg.Pool` and limiter, so workers share nothing but the database.
 *
 * Input: one JSON argument (see `WorkerConfig`). Output: one JSON line per
 * event on stdout. `acquired` is printed after `acquire` resolves and
 * `released` before `release` is called, so each printed interval lies
 * inside the lease's real interval.
 */
import pg from 'pg';
import type { ConcurrencyLimits, ConcurrencyRequest } from 'runcell';
import { createPostgresConcurrencyLimiter } from './index.js';

export interface WorkerConfig {
  url: string;
  tablePrefix: string;
  name: string;
  limits: ConcurrencyLimits;
  workload: string | undefined;
  /** `cycle`: acquire, hold, release `count` times. `hold`: acquire once and never release. */
  mode: 'cycle' | 'hold';
  count: number;
  /** Requests in flight at once in `cycle` mode. */
  parallel: number;
  holdMs: number;
  leaseTtlMs: number;
  pollIntervalMs: number;
  queueEntryTtlMs: number;
  /** Abort each request after a random delay up to this many ms (cancellation races). */
  abortWithinMs?: number;
}

const config = JSON.parse(process.argv[2] ?? '{}') as WorkerConfig;
const emit = (event: Record<string, unknown>) => {
  process.stdout.write(`${JSON.stringify({ ...event, pid: process.pid })}\n`);
};

const db = new pg.Pool({ connectionString: config.url, max: 10 });
const limiter = createPostgresConcurrencyLimiter({
  db,
  name: config.name,
  tablePrefix: config.tablePrefix,
  leaseTtlMs: config.leaseTtlMs,
  pollIntervalMs: config.pollIntervalMs,
  queueEntryTtlMs: config.queueEntryTtlMs,
  ...config.limits,
});

let counter = 0;
function request(signal: AbortSignal): ConcurrencyRequest {
  counter += 1;
  const id = `${process.pid}-${counter}`;
  return {
    workload: config.workload,
    runId: id,
    rootRunId: id,
    parentRunId: undefined,
    requestId: id,
    metadata: {},
    timeoutMs: undefined,
    signal,
  };
}

async function one(): Promise<void> {
  const controller = new AbortController();
  if (config.abortWithinMs !== undefined) {
    setTimeout(() => {
      controller.abort(new Error('cancelled'));
    }, Math.random() * config.abortWithinMs);
  }
  const requestedAt = Date.now();
  let lease;
  try {
    lease = await limiter.acquire(request(controller.signal));
  } catch (error) {
    emit({
      type: 'rejected',
      t: Date.now(),
      waitMs: Date.now() - requestedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  emit({
    type: 'acquired',
    t: Date.now(),
    waitMs: Date.now() - requestedAt,
    workload: lease.workload,
    leaseId: lease.id,
  });
  if (config.mode === 'hold') {
    return;
  }
  await new Promise(resolve => setTimeout(resolve, config.holdMs));
  emit({ type: 'released', t: Date.now(), leaseId: lease.id });
  await limiter.release(lease);
}

async function main(): Promise<void> {
  emit({ type: 'ready', t: Date.now() });
  if (config.mode === 'hold') {
    await one();
    // Hold the slot until the parent kills this process.
    setInterval(() => undefined, 1_000);
    return;
  }
  let remaining = config.count;
  await Promise.all(
    Array.from(
      { length: Math.min(config.parallel, config.count) },
      async () => {
        while (remaining > 0) {
          remaining -= 1;
          await one();
        }
      },
    ),
  );
  emit({ type: 'done', t: Date.now() });
  await db.end();
}

main().catch((error: unknown) => {
  emit({
    type: 'fatal',
    error: error instanceof Error ? error.stack : String(error),
  });
  process.exit(1);
});
