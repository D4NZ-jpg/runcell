import { randomUUID } from 'node:crypto';
import {
  AdmissionConfigError,
  AdmissionError,
  AdmissionQueueFullError,
  AdmissionTimeoutError,
  admissionPoolFingerprint,
  normalizeAdmissionPolicy,
  resolveAdmissionTarget,
  selectAdmissionGrants,
  type AdmissionLease,
  type AdmissionPolicy,
  type AdmissionPoolStats,
  type AdmissionRequest,
  type AdmissionScheduler,
  type AdmissionSchedulerEvent,
  type NormalizedPoolPolicy,
} from 'runcell';

/**
 * The subset of a Postgres client this backend needs. `pg.PoolClient`
 * satisfies it structurally.
 */
export interface PostgresClient {
  query(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
  /** Return the client to its pool; a truthy argument discards it. */
  release(error?: Error): void;
}

/**
 * The subset of a Postgres pool this backend needs. `pg.Pool` satisfies it
 * structurally, so `pg` is not a runtime dependency of this package.
 */
export interface PostgresPool {
  connect(): Promise<PostgresClient>;
}

export interface PostgresSchedulerOptions {
  /** A `pg.Pool` (or structurally compatible pool). */
  pool: PostgresPool;
  /** Pools and workloads to enforce. Every worker sharing a pool must use the same policy for it. */
  policy: AdmissionPolicy;
  /**
   * Prefix for the backend's two tables (`<prefix>_pools`,
   * `<prefix>_entries`). May be schema-qualified (`myschema.admission`).
   * Defaults to `runcell_admission`.
   */
  tablePrefix?: string;
  /**
   * Create the tables on first use with `CREATE TABLE IF NOT EXISTS`.
   * Defaults to `true`. Set to `false` when the role has no DDL permission
   * and apply {@link postgresAdmissionSchemaSql} as a migration instead.
   */
  ensureSchema?: boolean;
  /** Lease validity without renewal, in milliseconds. Defaults to 30000. */
  leaseTtlMs?: number;
  /** How often a queued request checks for a grant, in milliseconds. Defaults to 100. */
  pollIntervalMs?: number;
  /**
   * How long a queue entry survives without a poll, in milliseconds. Entries
   * of a crashed worker are removed after this. Defaults to 15000; must
   * exceed `pollIntervalMs` by a wide margin.
   */
  queueEntryTtlMs?: number;
  /**
   * What to do when the database already holds a different policy for a
   * pool. `'reject'` (default) fails admission with `AdmissionConfigError`
   * so workers never enforce inconsistent rules. `'replace'` overwrites the
   * stored policy; use it only for a deliberate, coordinated policy change.
   */
  onPolicyConflict?: 'reject' | 'replace';
  /** Observes scheduler events. A throwing listener is ignored. */
  onEvent?: (event: AdmissionSchedulerEvent) => void;
}

interface Tables {
  pools: string;
  entries: string;
  entriesIndex: string;
}

function tables(prefix: string): Tables {
  const parts = prefix.split('.');
  if (
    parts.length > 2 ||
    parts.some(part => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(part))
  ) {
    throw new AdmissionConfigError(
      `Invalid table prefix ${JSON.stringify(prefix)}: expected an identifier ` +
        'such as "runcell_admission" or "myschema.runcell_admission".',
    );
  }
  const name = parts.pop() ?? prefix;
  const schema = parts.length > 0 ? `"${parts.join('')}".` : '';
  return {
    pools: `${schema}"${name}_pools"`,
    entries: `${schema}"${name}_entries"`,
    entriesIndex: `"${name}_entries_pool_state_seq"`,
  };
}

/**
 * The backend's schema, as statements to apply in order. Use it as a
 * migration when `ensureSchema` is disabled. Every statement is
 * idempotent.
 */
export function postgresAdmissionSchemaSql(
  tablePrefix = 'runcell_admission',
): string[] {
  const t = tables(tablePrefix);
  return [
    `CREATE TABLE IF NOT EXISTS ${t.pools} (
  pool text PRIMARY KEY,
  fingerprint text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
)`,
    `CREATE TABLE IF NOT EXISTS ${t.entries} (
  id text PRIMARY KEY,
  pool text NOT NULL,
  workload text NOT NULL,
  state text NOT NULL CHECK (state IN ('waiting', 'granted', 'expired')),
  seq bigint GENERATED ALWAYS AS IDENTITY,
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  wait_deadline timestamptz,
  heartbeat_expires_at timestamptz NOT NULL,
  lease_expires_at timestamptz,
  request_id text NOT NULL,
  run_id text NOT NULL,
  root_run_id text NOT NULL
)`,
    `CREATE INDEX IF NOT EXISTS ${t.entriesIndex} ON ${t.entries} (pool, state, seq)`,
  ];
}

const ms = (param: string) => `(${param}::float8 * interval '1 millisecond')`;
const WAIT_MS = `(extract(epoch from (now() - enqueued_at)) * 1000)::float8`;

interface EntryRow {
  id: string;
  workload: string;
  request_id: string;
  run_id: string;
  root_run_id: string;
  wait_ms: unknown;
}

/**
 * A PostgreSQL-backed RunCell scheduler. Enforces pool and workload limits,
 * strict reservations, priority, FIFO, bounded queues, and wait deadlines
 * across every worker connected to the same database.
 *
 * Consistency: every allocation decision runs in one short transaction that
 * holds the pool's row lock, so no two workers grant the same capacity.
 * Lease expiry and queue deadlines use database time. No transaction or
 * connection is held while waiting for capacity or while a provider request
 * runs, and no session state is used, so transaction-mode connection
 * poolers (PgBouncer) are supported.
 *
 * Failure: a database error rejects the operation; RunCell then fails the
 * run closed with `AdmissionBackendError`. A crashed worker's leases are
 * reclaimed after `leaseTtlMs` and its queue entries after
 * `queueEntryTtlMs`.
 */
export function createPostgresScheduler(
  options: PostgresSchedulerOptions,
): AdmissionScheduler {
  const policy = normalizeAdmissionPolicy(options.policy);
  const t = tables(options.tablePrefix ?? 'runcell_admission');
  const leaseTtlMs = positive(options.leaseTtlMs ?? 30_000, 'leaseTtlMs');
  const pollIntervalMs = positive(
    options.pollIntervalMs ?? 100,
    'pollIntervalMs',
  );
  const queueEntryTtlMs = positive(
    options.queueEntryTtlMs ?? 15_000,
    'queueEntryTtlMs',
  );
  if (queueEntryTtlMs <= pollIntervalMs * 2) {
    throw new AdmissionConfigError(
      '"queueEntryTtlMs" must be more than twice "pollIntervalMs".',
    );
  }
  const onConflict = options.onPolicyConflict ?? 'reject';
  const fingerprints = new Map(
    Object.entries(policy.pools).map(([name, pool]) => [
      name,
      admissionPoolFingerprint(pool),
    ]),
  );
  const emit = (event: AdmissionSchedulerEvent) => {
    try {
      options.onEvent?.(event);
    } catch {
      // Observers never affect scheduling.
    }
  };

  let schemaReady: Promise<void> | undefined;
  const ready = (): Promise<void> => {
    if (options.ensureSchema === false) {
      return Promise.resolve();
    }
    schemaReady ??= (async () => {
      const client = await options.pool.connect();
      try {
        for (const statement of postgresAdmissionSchemaSql(
          options.tablePrefix ?? 'runcell_admission',
        )) {
          await client.query(statement);
        }
      } finally {
        client.release();
      }
    })().catch((error: unknown) => {
      schemaReady = undefined;
      throw error;
    });
    return schemaReady;
  };

  /** Run `fn` in one transaction; database errors emit `backend-error`. */
  const transaction = async <T>(
    pool: string,
    operation: string,
    fn: (client: PostgresClient) => Promise<T>,
  ): Promise<T> => {
    try {
      await ready();
      const client = await options.pool.connect();
      let discard: Error | undefined;
      try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          discard = asError(rollbackError);
        }
        throw error;
      } finally {
        client.release(discard);
      }
    } catch (error) {
      if (!(error instanceof AdmissionError)) {
        emit({
          type: 'backend-error',
          pool,
          operation,
          error,
          timestamp: Date.now(),
        });
      }
      throw error;
    }
  };

  /**
   * Take the pool's row lock and verify the stored policy. With
   * `skipLocked`, returns false instead of waiting when another worker is
   * already scheduling the pool.
   */
  const lockPool = async (
    client: PostgresClient,
    pool: string,
    skipLocked = false,
  ): Promise<boolean> => {
    const fingerprint = fingerprints.get(pool) ?? '';
    await client.query(
      `INSERT INTO ${t.pools} (pool, fingerprint) VALUES ($1, $2) ON CONFLICT (pool) DO NOTHING`,
      [pool, fingerprint],
    );
    const { rows } = await client.query(
      `SELECT fingerprint FROM ${t.pools} WHERE pool = $1 FOR UPDATE${
        skipLocked ? ' SKIP LOCKED' : ''
      }`,
      [pool],
    );
    const row = rows[0];
    if (!row) {
      return false;
    }
    if (row.fingerprint !== fingerprint) {
      if (onConflict === 'replace') {
        await client.query(
          `UPDATE ${t.pools} SET fingerprint = $2, updated_at = now() WHERE pool = $1`,
          [pool, fingerprint],
        );
        return true;
      }
      const error = new AdmissionConfigError(
        `Admission policy for pool "${pool}" conflicts with the policy other ` +
          'workers registered in the database. All workers sharing a pool ' +
          'must use the same policy.',
        { pool },
      );
      emit({ type: 'config-conflict', pool, error, timestamp: Date.now() });
      throw error;
    }
    return true;
  };

  /** Purge, expire, and grant for a pool. Requires the pool's row lock. */
  const scheduleLocked = async (
    client: PostgresClient,
    pool: string,
    poolPolicy: NormalizedPoolPolicy,
  ): Promise<string[]> => {
    const now = Date.now();
    const expired = await client.query(
      `DELETE FROM ${t.entries} WHERE pool = $1 AND state = 'granted' AND lease_expires_at <= now() RETURNING id, workload`,
      [pool],
    );
    for (const row of expired.rows) {
      emit({
        type: 'lease-expired',
        pool,
        workload: String(row.workload),
        leaseId: String(row.id),
        timestamp: now,
      });
    }
    // Queue entries of crashed or departed workers.
    await client.query(
      `DELETE FROM ${t.entries} WHERE pool = $1 AND state IN ('waiting', 'expired') AND heartbeat_expires_at <= now()`,
      [pool],
    );
    const deadlines = await client.query(
      `UPDATE ${t.entries} SET state = 'expired' WHERE pool = $1 AND state = 'waiting' AND wait_deadline <= now()
       RETURNING id, workload, request_id, run_id, root_run_id, ${WAIT_MS} AS wait_ms`,
      [pool],
    );
    for (const row of deadlines.rows as unknown as EntryRow[]) {
      emit({
        type: 'wait-expired',
        pool,
        workload: row.workload,
        requestId: row.request_id,
        runId: row.run_id,
        rootRunId: row.root_run_id,
        waitMs: Number(row.wait_ms),
        timestamp: now,
      });
    }

    const counts = await client.query(
      `SELECT workload, count(*)::int AS n FROM ${t.entries} WHERE pool = $1 AND state = 'granted' GROUP BY workload`,
      [pool],
    );
    const active = new Map<string, number>();
    let total = 0;
    for (const row of counts.rows) {
      const n = Number(row.n);
      active.set(String(row.workload), n);
      total += n;
    }
    if (total >= poolPolicy.maxConcurrent) {
      return [];
    }
    // The allocator grants at most maxConcurrent per pass, so the first
    // maxConcurrent waiters of each workload are all it can need.
    const waiting = await client.query(
      `SELECT id, workload, seq::float8 AS seq FROM (
         SELECT id, workload, seq, row_number() OVER (PARTITION BY workload ORDER BY seq) AS rn
         FROM ${t.entries} WHERE pool = $1 AND state = 'waiting'
       ) w WHERE rn <= $2 ORDER BY seq`,
      [pool, poolPolicy.maxConcurrent],
    );
    const grants = selectAdmissionGrants(
      poolPolicy,
      active,
      waiting.rows.map(row => ({
        id: String(row.id),
        workload: String(row.workload),
        seq: Number(row.seq),
      })),
    );
    if (grants.length === 0) {
      return [];
    }
    const placeholders = grants.map((_, i) => `$${i + 2}`).join(', ');
    const granted = await client.query(
      `UPDATE ${t.entries}
       SET state = 'granted', lease_expires_at = now() + ${ms('$1')}, wait_deadline = NULL
       WHERE state = 'waiting' AND id IN (${placeholders})
       RETURNING id, workload, request_id, run_id, root_run_id, ${WAIT_MS} AS wait_ms`,
      [leaseTtlMs, ...grants],
    );
    let after = total;
    for (const row of granted.rows as unknown as EntryRow[]) {
      after += 1;
      emit({
        type: 'granted',
        pool,
        workload: row.workload,
        requestId: row.request_id,
        runId: row.run_id,
        rootRunId: row.root_run_id,
        leaseId: row.id,
        waitMs: Number(row.wait_ms),
        active: after,
        timestamp: now,
      });
    }
    return granted.rows.map(row => String(row.id));
  };

  const lease = (
    id: string,
    pool: string,
    workload: string,
    ttlMs: number,
    roundTripMs: number,
  ): AdmissionLease => ({
    id,
    pool,
    workload,
    // Subtract the round trip so RunCell's local expiry never outlives the
    // database's.
    ttlMs: Math.max(1, Math.floor(ttlMs - roundTripMs)),
  });

  const cancelEntry = (
    id: string,
    pool: string,
    poolPolicy: NormalizedPoolPolicy,
  ) =>
    transaction(pool, 'cancel', async client => {
      await lockPool(client, pool);
      const { rows } = await client.query(
        `DELETE FROM ${t.entries} WHERE id = $1 RETURNING state`,
        [id],
      );
      // A grant that raced the cancellation is returned to the pool here.
      if (rows[0]?.state === 'granted') {
        await scheduleLocked(client, pool, poolPolicy);
      }
    });

  const acquire = async (
    request: AdmissionRequest,
  ): Promise<AdmissionLease> => {
    const target = resolveAdmissionTarget(
      policy,
      request.pool,
      request.workload,
    );
    const { signal } = request;
    if (signal.aborted) {
      throw signal.reason;
    }
    const poolName = request.pool;
    const workload = target.workload;
    const poolPolicy = target.pool;
    const workloadWait = poolPolicy.workloads[workload]?.maxWaitMs;
    const waitMs = minDefined(request.timeoutMs, workloadWait);
    const id = randomUUID();
    const baseEvent = {
      pool: poolName,
      workload,
      requestId: request.requestId,
      runId: request.runId,
      rootRunId: request.rootRunId,
    };

    const enqueuedAt = Date.now();
    let started = performance.now();
    const first = await transaction(poolName, 'acquire', async client => {
      await lockPool(client, poolName);
      await client.query(
        `INSERT INTO ${t.entries}
           (id, pool, workload, state, wait_deadline, heartbeat_expires_at, request_id, run_id, root_run_id)
         VALUES ($1, $2, $3, 'waiting',
           CASE WHEN $4::float8 IS NULL THEN NULL ELSE now() + ${ms('$4')} END,
           now() + ${ms('$5')}, $6, $7, $8)`,
        [
          id,
          poolName,
          workload,
          waitMs ?? null,
          queueEntryTtlMs,
          request.requestId,
          request.runId,
          request.rootRunId,
        ],
      );
      const granted = await scheduleLocked(client, poolName, poolPolicy);
      if (granted.includes(id)) {
        return { state: 'granted' as const };
      }
      const { rows } = await client.query(
        `SELECT count(*)::int AS n FROM ${t.entries} WHERE pool = $1 AND state = 'waiting'`,
        [poolName],
      );
      const queued = Number(rows[0]?.n ?? 0);
      if (poolPolicy.maxQueued !== undefined && queued > poolPolicy.maxQueued) {
        await client.query(`DELETE FROM ${t.entries} WHERE id = $1`, [id]);
        return { state: 'full' as const, queued: queued - 1 };
      }
      return { state: 'waiting' as const, queued };
    });

    if (first.state === 'granted') {
      const result = lease(
        id,
        poolName,
        workload,
        leaseTtlMs,
        performance.now() - started,
      );
      if (isAborted(signal)) {
        await cancelEntry(id, poolName, poolPolicy);
        throw signal.reason;
      }
      return result;
    }
    if (first.state === 'full') {
      emit({
        type: 'queue-full',
        ...baseEvent,
        queued: first.queued,
        timestamp: Date.now(),
      });
      throw new AdmissionQueueFullError(
        `Admission queue for pool "${poolName}" is full (${poolPolicy.maxQueued ?? 0} waiting).`,
        { pool: poolName, workload },
      );
    }
    emit({
      type: 'queued',
      ...baseEvent,
      queued: first.queued,
      timestamp: Date.now(),
    });

    try {
      for (;;) {
        await sleep(jitter(pollIntervalMs), signal);
        started = performance.now();
        const status = await transaction(poolName, 'poll', async client => {
          // One worker schedules at a time; the rest only check their entry.
          if (await lockPool(client, poolName, true)) {
            await scheduleLocked(client, poolName, poolPolicy);
          }
          const { rows } = await client.query(
            `UPDATE ${t.entries} SET heartbeat_expires_at = now() + ${ms('$2')}
             WHERE id = $1
             RETURNING state, (extract(epoch from (lease_expires_at - now())) * 1000)::float8 AS ttl_ms, ${WAIT_MS} AS wait_ms`,
            [id, queueEntryTtlMs],
          );
          const row = rows[0];
          if (row?.state === 'expired') {
            await client.query(`DELETE FROM ${t.entries} WHERE id = $1`, [id]);
          }
          return row;
        });
        const state = status?.state;
        if (state === 'granted') {
          const result = lease(
            id,
            poolName,
            workload,
            Number(status?.ttl_ms),
            performance.now() - started,
          );
          if (isAborted(signal)) {
            throw signal.reason;
          }
          return result;
        }
        if (state === 'expired') {
          throw new AdmissionTimeoutError(
            `Admission wait limit reached for pool "${poolName}" after ${Math.round(
              Number(status?.wait_ms),
            )} ms.`,
            { pool: poolName, workload },
          );
        }
        if (state !== 'waiting') {
          throw new Error(
            `Admission queue entry for pool "${poolName}" disappeared (expired without heartbeat).`,
          );
        }
      }
    } catch (error) {
      if (isAborted(signal)) {
        emit({
          type: 'wait-cancelled',
          ...baseEvent,
          waitMs: Date.now() - enqueuedAt,
          timestamp: Date.now(),
        });
        // Remove the entry, or return a grant that raced the cancellation.
        await cancelEntry(id, poolName, poolPolicy).catch(() => undefined);
        throw signal.reason;
      }
      throw error;
    }
  };

  return {
    policy,

    validate(target) {
      resolveAdmissionTarget(policy, target.pool, target.workload);
    },

    acquire,

    async renew(current) {
      if (!fingerprints.has(current.pool)) {
        return undefined;
      }
      const started = performance.now();
      const rows = await transaction(current.pool, 'renew', async client => {
        const result = await client.query(
          `UPDATE ${t.entries} SET lease_expires_at = now() + ${ms('$2')}
           WHERE id = $1 AND state = 'granted' AND lease_expires_at > now()
           RETURNING workload`,
          [current.id, leaseTtlMs],
        );
        return result.rows;
      });
      const row = rows[0];
      if (!row) {
        return undefined;
      }
      return lease(
        current.id,
        current.pool,
        String(row.workload),
        leaseTtlMs,
        performance.now() - started,
      );
    },

    async release(current) {
      const poolPolicy = Object.hasOwn(policy.pools, current.pool)
        ? policy.pools[current.pool]
        : undefined;
      if (!poolPolicy) {
        return;
      }
      await transaction(current.pool, 'release', async client => {
        await lockPool(client, current.pool);
        const { rows } = await client.query(
          `DELETE FROM ${t.entries} WHERE id = $1 AND state = 'granted' RETURNING workload`,
          [current.id],
        );
        const row = rows[0];
        if (row) {
          const count = await client.query(
            `SELECT count(*)::int AS n FROM ${t.entries} WHERE pool = $1 AND state = 'granted'`,
            [current.pool],
          );
          emit({
            type: 'released',
            pool: current.pool,
            workload: String(row.workload),
            leaseId: current.id,
            active: Number(count.rows[0]?.n ?? 0),
            timestamp: Date.now(),
          });
        }
        await scheduleLocked(client, current.pool, poolPolicy);
      });
    },

    async stats(pool) {
      const poolPolicy = Object.hasOwn(policy.pools, pool)
        ? policy.pools[pool]
        : undefined;
      if (!poolPolicy) {
        throw new AdmissionConfigError(`Unknown admission pool "${pool}".`, {
          pool,
        });
      }
      const rows = await transaction(pool, 'stats', async client => {
        const result = await client.query(
          `SELECT workload, state, count(*)::int AS n FROM ${t.entries}
           WHERE pool = $1 AND (
             (state = 'granted' AND lease_expires_at > now()) OR
             (state = 'waiting' AND heartbeat_expires_at > now() AND (wait_deadline IS NULL OR wait_deadline > now()))
           )
           GROUP BY workload, state`,
          [pool],
        );
        return result.rows;
      });
      const stats: AdmissionPoolStats = {
        pool,
        active: 0,
        queued: 0,
        workloads: {},
      };
      for (const workload of Object.keys(poolPolicy.workloads)) {
        stats.workloads[workload] = { active: 0, queued: 0 };
      }
      for (const row of rows) {
        const workload = String(row.workload);
        const n = Number(row.n);
        const entry = (stats.workloads[workload] ??= { active: 0, queued: 0 });
        if (row.state === 'granted') {
          entry.active += n;
          stats.active += n;
        } else {
          entry.queued += n;
          stats.queued += n;
        }
      }
      return stats;
    },
  };
}

/** A call, so control-flow narrowing does not survive awaits. */
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

function positive(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new AdmissionConfigError(`"${label}" must be a positive integer.`);
  }
  return value;
}

function minDefined(
  a: number | undefined,
  b: number | undefined,
): number | undefined {
  if (a === undefined) return b;
  return b === undefined ? a : Math.min(a, b);
}

function jitter(base: number): number {
  return Math.round(base * (0.75 + Math.random() * 0.5));
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function sleep(delay: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason as Error);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason as Error);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delay);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
