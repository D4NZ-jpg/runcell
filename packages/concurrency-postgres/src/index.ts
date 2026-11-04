import { randomUUID } from 'node:crypto';
import {
  ConcurrencyConfigError,
  ConcurrencyError,
  ConcurrencyQueueFullError,
  ConcurrencyTimeoutError,
  concurrencyLimitsFingerprint,
  resolveConcurrencyLimits,
  resolveWorkload,
  selectConcurrencyGrants,
  type ConcurrencyLease,
  type ConcurrencyLimiter,
  type ConcurrencyLimits,
  type ConcurrencyRequest,
  type ConcurrencyStats,
  type ResolvedConcurrencyLimits,
} from 'runcell/concurrency';

/**
 * The subset of a Postgres client this limiter needs. `pg.PoolClient`
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
 * The subset of a Postgres pool this limiter needs. `pg.Pool` satisfies it
 * structurally, so `pg` is not a runtime dependency of this package.
 */
export interface PostgresPool {
  connect(): Promise<PostgresClient>;
}

export interface PostgresConcurrencyLimiterOptions extends ConcurrencyLimits {
  /** A `pg.Pool` (or structurally compatible pool). */
  db: PostgresPool;
  /**
   * Identifies the shared capacity in the database. Every worker that
   * creates a limiter with this name shares its slots, so they must all use
   * the same limits.
   */
  name: string;
  /**
   * Prefix for the limiter's two tables (`<prefix>_limiters`,
   * `<prefix>_entries`). May be schema-qualified. Defaults to
   * `runcell_concurrency`.
   */
  tablePrefix?: string;
  /**
   * Create the tables on first use with `CREATE TABLE IF NOT EXISTS`.
   * Defaults to `true`. Set to `false` when the role has no DDL permission
   * and apply {@link postgresConcurrencySchemaSql} as a migration instead.
   */
  ensureSchema?: boolean;
  /**
   * How long a slot stays valid without renewal, in milliseconds. A crashed
   * worker's slots come back after this. RunCell renews automatically while
   * a request runs. Defaults to 30000.
   */
  leaseTtlMs?: number;
  /** How often a waiting request checks for a slot, in milliseconds. Defaults to 100. */
  pollIntervalMs?: number;
  /**
   * How long a waiting request survives without checking in, in
   * milliseconds. A crashed worker's queue entries are removed after this.
   * Defaults to 15000; must exceed twice `pollIntervalMs`.
   */
  queueEntryTtlMs?: number;
  /**
   * What to do when the database holds different limits for this `name`.
   * `'reject'` (default) fails requests with `ConcurrencyConfigError`, so
   * workers never enforce inconsistent limits. `'replace'` overwrites the
   * stored limits; use it only for a coordinated change.
   */
  onConflict?: 'reject' | 'replace';
}

/** A PostgreSQL limiter: the contract plus its resolved limits and live counts. */
export interface PostgresConcurrencyLimiter extends ConcurrencyLimiter {
  readonly limits: ResolvedConcurrencyLimits;
  validateWorkload(workload: string | undefined): void;
  stats(): Promise<ConcurrencyStats>;
}

interface Tables {
  limiters: string;
  entries: string;
  entriesIndex: string;
}

function tables(prefix: string): Tables {
  const parts = prefix.split('.');
  if (
    parts.length > 2 ||
    parts.some(part => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(part))
  ) {
    throw new ConcurrencyConfigError(
      `Invalid table prefix ${JSON.stringify(prefix)}: expected an identifier ` +
        'such as "runcell_concurrency" or "myschema.runcell_concurrency".',
    );
  }
  const name = parts.pop() ?? prefix;
  const schema = parts.length > 0 ? `"${parts.join('')}".` : '';
  return {
    limiters: `${schema}"${name}_limiters"`,
    entries: `${schema}"${name}_entries"`,
    entriesIndex: `"${name}_entries_limiter_state_seq"`,
  };
}

const DEFAULT_PREFIX = 'runcell_concurrency';

/**
 * The limiter's schema, as statements to apply in order. Use it as a
 * migration when `ensureSchema` is `false`. Every statement is idempotent.
 */
export function postgresConcurrencySchemaSql(
  tablePrefix = DEFAULT_PREFIX,
): string[] {
  const t = tables(tablePrefix);
  return [
    `CREATE TABLE IF NOT EXISTS ${t.limiters} (
  limiter text PRIMARY KEY,
  fingerprint text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
)`,
    `CREATE TABLE IF NOT EXISTS ${t.entries} (
  id text PRIMARY KEY,
  limiter text NOT NULL,
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
    `CREATE INDEX IF NOT EXISTS ${t.entriesIndex} ON ${t.entries} (limiter, state, seq)`,
  ];
}

const ms = (param: string) => `(${param}::float8 * interval '1 millisecond')`;
const WAIT_MS = `(extract(epoch from (now() - enqueued_at)) * 1000)::float8`;

/**
 * A concurrency limiter shared by every worker connected to the same
 * PostgreSQL database: pool and workload limits, strict reservations,
 * priorities, a bounded queue, and wait limits.
 *
 * ```ts
 * const limiter = createPostgresConcurrencyLimiter({
 *   db: new pg.Pool({ connectionString: process.env.DATABASE_URL }),
 *   name: 'claude',
 *   maxConcurrent: 8,
 * });
 * const agent = createAgent({ model, concurrency: { limiter } });
 * ```
 *
 * Each allocation runs in one short transaction that holds the limiter's
 * row lock, so no two workers grant the same slot. Lease expiry and queue
 * deadlines use database time. No transaction or connection is held while a
 * request waits or while a provider request runs, and no session state is
 * used, so transaction-mode poolers (PgBouncer) work. A database error
 * rejects the operation; RunCell then fails the run closed.
 */
export function createPostgresConcurrencyLimiter(
  options: PostgresConcurrencyLimiterOptions,
): PostgresConcurrencyLimiter {
  const limits = resolveConcurrencyLimits(options);
  const name = options.name;
  if (typeof name !== 'string' || name.length === 0) {
    throw new ConcurrencyConfigError('"name" must be a non-empty string.');
  }
  const prefix = options.tablePrefix ?? DEFAULT_PREFIX;
  const t = tables(prefix);
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
    throw new ConcurrencyConfigError(
      '"queueEntryTtlMs" must be more than twice "pollIntervalMs".',
    );
  }
  const onConflict = options.onConflict ?? 'reject';
  const fingerprint = concurrencyLimitsFingerprint(limits);
  const { db } = options;

  let schemaReady: Promise<void> | undefined;
  const ready = (): Promise<void> => {
    if (options.ensureSchema === false) {
      return Promise.resolve();
    }
    schemaReady ??= (async () => {
      const client = await db.connect();
      try {
        for (const statement of postgresConcurrencySchemaSql(prefix)) {
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

  const transaction = async <T>(
    fn: (client: PostgresClient) => Promise<T>,
  ): Promise<T> => {
    await ready();
    const client = await db.connect();
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
  };

  /**
   * Take the limiter's row lock and verify the stored limits. With
   * `skipLocked`, returns false instead of waiting when another worker is
   * already allocating.
   */
  const lockLimiter = async (
    client: PostgresClient,
    skipLocked = false,
  ): Promise<boolean> => {
    await client.query(
      `INSERT INTO ${t.limiters} (limiter, fingerprint) VALUES ($1, $2) ON CONFLICT (limiter) DO NOTHING`,
      [name, fingerprint],
    );
    const { rows } = await client.query(
      `SELECT fingerprint FROM ${t.limiters} WHERE limiter = $1 FOR UPDATE${
        skipLocked ? ' SKIP LOCKED' : ''
      }`,
      [name],
    );
    const row = rows[0];
    if (!row) {
      return false;
    }
    if (row.fingerprint !== fingerprint) {
      if (onConflict === 'replace') {
        await client.query(
          `UPDATE ${t.limiters} SET fingerprint = $2, updated_at = now() WHERE limiter = $1`,
          [name, fingerprint],
        );
        return true;
      }
      throw new ConcurrencyConfigError(
        `Concurrency limiter "${name}" is registered in the database with ` +
          'different limits. Every worker sharing a limiter name must use ' +
          'the same limits; use a new name or onConflict: "replace" for a ' +
          'coordinated change.',
        { limiter: name },
      );
    }
    return true;
  };

  /** Purge, expire, and grant. Requires the limiter's row lock. */
  const allocate = async (client: PostgresClient): Promise<string[]> => {
    await client.query(
      `DELETE FROM ${t.entries} WHERE limiter = $1 AND state = 'granted' AND lease_expires_at <= now()`,
      [name],
    );
    // Queue entries of crashed or departed workers.
    await client.query(
      `DELETE FROM ${t.entries} WHERE limiter = $1 AND state IN ('waiting', 'expired') AND heartbeat_expires_at <= now()`,
      [name],
    );
    await client.query(
      `UPDATE ${t.entries} SET state = 'expired' WHERE limiter = $1 AND state = 'waiting' AND wait_deadline <= now()`,
      [name],
    );

    const counts = await client.query(
      `SELECT workload, count(*)::int AS n FROM ${t.entries} WHERE limiter = $1 AND state = 'granted' GROUP BY workload`,
      [name],
    );
    const active = new Map<string, number>();
    let total = 0;
    for (const row of counts.rows) {
      const n = Number(row.n);
      active.set(String(row.workload), n);
      total += n;
    }
    if (total >= limits.maxConcurrent) {
      return [];
    }
    // One pass grants at most maxConcurrent, so the first maxConcurrent
    // waiters of each workload are all the allocator can need.
    const waiting = await client.query(
      `SELECT id, workload, seq::float8 AS seq FROM (
         SELECT id, workload, seq, row_number() OVER (PARTITION BY workload ORDER BY seq) AS rn
         FROM ${t.entries} WHERE limiter = $1 AND state = 'waiting'
       ) w WHERE rn <= $2 ORDER BY seq`,
      [name, limits.maxConcurrent],
    );
    const grants = selectConcurrencyGrants(
      limits,
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
       RETURNING id`,
      [leaseTtlMs, ...grants],
    );
    return granted.rows.map(row => String(row.id));
  };

  // Subtract the round trip so RunCell's local expiry never outlives the
  // database's.
  const lease = (
    id: string,
    workload: string,
    ttlMs: number,
    roundTripMs: number,
  ): ConcurrencyLease => ({
    id,
    workload,
    ttlMs: Math.max(1, Math.floor(ttlMs - roundTripMs)),
  });

  // Remove a queue entry, or return a grant that raced the cancellation.
  const cancelEntry = (id: string) =>
    transaction(async client => {
      await lockLimiter(client);
      const { rows } = await client.query(
        `DELETE FROM ${t.entries} WHERE id = $1 RETURNING state`,
        [id],
      );
      if (rows[0]?.state === 'granted') {
        await allocate(client);
      }
    });

  const workloadError = (error: unknown) =>
    error instanceof ConcurrencyConfigError
      ? new ConcurrencyConfigError(error.message, {
          limiter: name,
          ...(error.workload !== undefined ? { workload: error.workload } : {}),
        })
      : error;

  const acquire = async (
    request: ConcurrencyRequest,
  ): Promise<ConcurrencyLease> => {
    let target: ReturnType<typeof resolveWorkload>;
    try {
      target = resolveWorkload(limits, request.workload);
    } catch (error) {
      throw workloadError(error);
    }
    const { signal } = request;
    if (signal.aborted) {
      throw signal.reason;
    }
    const workload = target.name;
    const waitMs = minDefined(request.timeoutMs, target.settings.maxWaitMs);
    const id = randomUUID();

    let started = performance.now();
    const first = await transaction(async client => {
      await lockLimiter(client);
      await client.query(
        `INSERT INTO ${t.entries}
           (id, limiter, workload, state, wait_deadline, heartbeat_expires_at, request_id, run_id, root_run_id)
         VALUES ($1, $2, $3, 'waiting',
           CASE WHEN $4::float8 IS NULL THEN NULL ELSE now() + ${ms('$4')} END,
           now() + ${ms('$5')}, $6, $7, $8)`,
        [
          id,
          name,
          workload,
          waitMs ?? null,
          queueEntryTtlMs,
          request.requestId,
          request.runId,
          request.rootRunId,
        ],
      );
      if ((await allocate(client)).includes(id)) {
        return 'granted' as const;
      }
      const { rows } = await client.query(
        `SELECT count(*)::int AS n FROM ${t.entries} WHERE limiter = $1 AND state = 'waiting'`,
        [name],
      );
      const queued = Number(rows[0]?.n ?? 0);
      if (limits.maxQueued !== undefined && queued > limits.maxQueued) {
        await client.query(`DELETE FROM ${t.entries} WHERE id = $1`, [id]);
        return 'full' as const;
      }
      return 'waiting' as const;
    });

    if (first === 'granted') {
      const result = lease(
        id,
        workload,
        leaseTtlMs,
        performance.now() - started,
      );
      if (isAborted(signal)) {
        await cancelEntry(id);
        throw signal.reason;
      }
      return result;
    }
    if (first === 'full') {
      throw new ConcurrencyQueueFullError(
        `Concurrency queue "${name}" is full (${limits.maxQueued ?? 0} waiting).`,
        { limiter: name, workload },
      );
    }

    try {
      for (;;) {
        await sleep(jitter(pollIntervalMs), signal);
        started = performance.now();
        const status = await transaction(async client => {
          // One worker allocates at a time; the rest only check their entry.
          if (await lockLimiter(client, true)) {
            await allocate(client);
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
          throw new ConcurrencyTimeoutError(
            `No "${name}" concurrency slot was free after ${Math.round(
              Number(status?.wait_ms),
            )} ms.`,
            { limiter: name, workload },
          );
        }
        if (state !== 'waiting') {
          throw new Error(
            `Queue entry on concurrency limiter "${name}" disappeared (expired without a heartbeat).`,
          );
        }
      }
    } catch (error) {
      if (isAborted(signal)) {
        await cancelEntry(id).catch(() => undefined);
        throw signal.reason;
      }
      if (!(error instanceof ConcurrencyError)) {
        // Best effort: do not leave a queue entry behind on a database error.
        await cancelEntry(id).catch(() => undefined);
      }
      throw error;
    }
  };

  return {
    name,
    limits,

    validateWorkload(workload) {
      try {
        resolveWorkload(limits, workload);
      } catch (error) {
        throw workloadError(error);
      }
    },

    acquire,

    async renew(current) {
      const started = performance.now();
      const rows = await transaction(async client => {
        const result = await client.query(
          `UPDATE ${t.entries} SET lease_expires_at = now() + ${ms('$3')}
           WHERE id = $1 AND limiter = $2 AND state = 'granted' AND lease_expires_at > now()
           RETURNING workload`,
          [current.id, name, leaseTtlMs],
        );
        return result.rows;
      });
      const row = rows[0];
      if (!row) {
        return undefined;
      }
      return lease(
        current.id,
        String(row.workload),
        leaseTtlMs,
        performance.now() - started,
      );
    },

    async release(current) {
      await transaction(async client => {
        await lockLimiter(client);
        await client.query(
          `DELETE FROM ${t.entries} WHERE id = $1 AND limiter = $2 AND state = 'granted'`,
          [current.id, name],
        );
        await allocate(client);
      });
    },

    async stats() {
      const rows = await transaction(async client => {
        const result = await client.query(
          `SELECT workload, state, count(*)::int AS n FROM ${t.entries}
           WHERE limiter = $1 AND (
             (state = 'granted' AND lease_expires_at > now()) OR
             (state = 'waiting' AND heartbeat_expires_at > now() AND (wait_deadline IS NULL OR wait_deadline > now()))
           )
           GROUP BY workload, state`,
          [name],
        );
        return result.rows;
      });
      const stats: ConcurrencyStats = { active: 0, queued: 0, workloads: {} };
      for (const workload of Object.keys(limits.workloads)) {
        stats.workloads[workload] = { active: 0, queued: 0 };
      }
      for (const row of rows) {
        const n = Number(row.n);
        const entry = (stats.workloads[String(row.workload)] ??= {
          active: 0,
          queued: 0,
        });
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
    throw new ConcurrencyConfigError(`"${label}" must be a positive integer.`);
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
