/* eslint-disable @typescript-eslint/require-await --
 * `CredentialStore.withLock` callbacks must return a Promise, so async
 * arrows without awaits are inherent to exercising the contract. */
import { describe, expect, it, vi } from 'vitest';
import type { AuthBlob } from 'runcell';
import {
  createPostgresCredentialStore,
  postgresCredentialStoreSql,
  type PostgresClient,
  type PostgresPool,
} from './index.js';

interface FakeDb {
  pool: PostgresPool;
  /** Every query issued, in order, across all clients. */
  queries: { sql: string; params?: readonly unknown[] }[];
  /** Rows persisted per key (parsed blobs). */
  rows: Map<string, AuthBlob | null>;
  /** When set, `pool.connect` rejects with this error. */
  connectError?: Error & { code?: string };
}

function createFakeDb(): FakeDb {
  const db: FakeDb = {
    queries: [],
    rows: new Map(),
    pool: {
      async connect(): Promise<PostgresClient> {
        if (db.connectError) throw db.connectError;
        return {
          async query(sql, params) {
            db.queries.push({ sql, ...(params ? { params } : {}) });
            if (sql.startsWith('INSERT INTO')) {
              const key = params?.[0] as string;
              if (!db.rows.has(key)) db.rows.set(key, null);
              return { rows: [] };
            }
            if (sql.startsWith('SELECT blob')) {
              const key = params?.[0] as string;
              const blob = db.rows.get(key) ?? null;
              return { rows: db.rows.has(key) ? [{ blob }] : [] };
            }
            if (sql.startsWith('UPDATE')) {
              const [key, json] = params as [string, string];
              db.rows.set(key, JSON.parse(json) as AuthBlob);
              return { rows: [] };
            }
            return { rows: [] };
          },
          release() {
            // Fake clients hold no resources.
          },
        };
      },
    },
  };
  return db;
}

const blobA: AuthBlob = {
  anthropic: { type: 'oauth', access: 'a1', refresh: 'r1', expires: 1 },
};
const blobB: AuthBlob = {
  anthropic: { type: 'oauth', access: 'a2', refresh: 'r2', expires: 2 },
};

describe('createPostgresCredentialStore', () => {
  it('reads the current blob under a row lock and returns the result', async () => {
    const db = createFakeDb();
    db.rows.set('agent-1', blobA);
    const store = createPostgresCredentialStore({ pool: db.pool });

    const seen: (AuthBlob | undefined)[] = [];
    const result = await store.withLock('agent-1', async current => {
      seen.push(current);
      return { result: 'ok' };
    });

    expect(result).toBe('ok');
    expect(seen).toEqual([blobA]);
    const sql = db.queries.map(q => q.sql);
    expect(sql[0]).toContain('CREATE TABLE IF NOT EXISTS');
    expect(sql[1]).toBe('BEGIN');
    expect(sql[2]).toContain('ON CONFLICT (key) DO NOTHING');
    expect(sql[3]).toContain('FOR UPDATE');
    expect(sql[4]).toBe('COMMIT');
  });

  it('persists next inside the transaction and skips the write otherwise', async () => {
    const db = createFakeDb();
    const store = createPostgresCredentialStore({ pool: db.pool });

    await store.withLock('agent-1', async () => ({
      result: undefined,
      next: blobA,
    }));
    expect(db.rows.get('agent-1')).toEqual(blobA);

    const writesBefore = db.queries.filter(q =>
      q.sql.startsWith('UPDATE'),
    ).length;
    await store.withLock('agent-1', async () => ({ result: undefined }));
    const writesAfter = db.queries.filter(q =>
      q.sql.startsWith('UPDATE'),
    ).length;
    expect(writesAfter).toBe(writesBefore);
  });

  it('a later lock holder sees the previous holder\u2019s committed rotation', async () => {
    const db = createFakeDb();
    const store = createPostgresCredentialStore({ pool: db.pool });

    await store.withLock('agent-1', async () => ({ result: 0, next: blobA }));
    const seen = await store.withLock('agent-1', async current => ({
      result: current,
      next: blobB,
    }));

    expect(seen).toEqual(blobA);
    expect(db.rows.get('agent-1')).toEqual(blobB);
  });

  it('rolls back and rethrows when fn fails', async () => {
    const db = createFakeDb();
    db.rows.set('agent-1', blobA);
    const store = createPostgresCredentialStore({ pool: db.pool });

    await expect(
      store.withLock('agent-1', async () => {
        throw new Error('refresh failed');
      }),
    ).rejects.toThrow('refresh failed');

    const sql = db.queries.map(q => q.sql);
    expect(sql).toContain('ROLLBACK');
    expect(sql).not.toContain('COMMIT');
  });

  it('creates the table once across calls', async () => {
    const db = createFakeDb();
    const store = createPostgresCredentialStore({ pool: db.pool });

    await store.withLock('a', async () => ({ result: 0 }));
    await store.withLock('b', async () => ({ result: 0 }));

    const creates = db.queries.filter(q =>
      q.sql.startsWith('CREATE TABLE'),
    ).length;
    expect(creates).toBe(1);
  });

  it('skips DDL when ensureTable is false', async () => {
    const db = createFakeDb();
    const store = createPostgresCredentialStore({
      pool: db.pool,
      ensureTable: false,
    });

    await store.withLock('a', async () => ({ result: 0 }));
    expect(db.queries.some(q => q.sql.startsWith('CREATE TABLE'))).toBe(false);
  });

  it('applies a positive lockTimeoutMs via SET LOCAL', async () => {
    const db = createFakeDb();
    const store = createPostgresCredentialStore({
      pool: db.pool,
      lockTimeoutMs: 5000,
    });

    await store.withLock('a', async () => ({ result: 0 }));
    expect(
      db.queries.some(q => q.sql === "SET LOCAL lock_timeout = '5000ms'"),
    ).toBe(true);
  });

  it('serves the last-known blob when the store is unreachable', async () => {
    const db = createFakeDb();
    const store = createPostgresCredentialStore({ pool: db.pool });

    await store.withLock('agent-1', async () => ({ result: 0, next: blobA }));

    db.connectError = Object.assign(new Error('connect ECONNREFUSED'), {
      code: 'ECONNREFUSED',
    });
    const seen = await store.withLock('agent-1', async current => ({
      result: current,
      next: blobB,
    }));
    expect(seen).toEqual(blobA);

    // The outage rotation stays visible in-process...
    const seenNext = await store.withLock('agent-1', async current => ({
      result: current,
    }));
    expect(seenNext).toEqual(blobB);

    // ...but is never written back: the database still holds blobA.
    db.connectError = undefined;
    expect(db.rows.get('agent-1')).toEqual(blobA);
  });

  it('rethrows unavailable errors when there is no cached blob', async () => {
    const db = createFakeDb();
    db.connectError = Object.assign(new Error('down'), {
      code: 'ECONNREFUSED',
    });
    const store = createPostgresCredentialStore({ pool: db.pool });

    await expect(
      store.withLock('agent-1', async () => ({ result: 0 })),
    ).rejects.toThrow('down');
  });

  it('rethrows non-connection errors even with a cached blob', async () => {
    const db = createFakeDb();
    const store = createPostgresCredentialStore({ pool: db.pool });
    await store.withLock('agent-1', async () => ({ result: 0, next: blobA }));

    db.connectError = Object.assign(new Error('permission denied'), {
      code: '42501',
    });
    await expect(
      store.withLock('agent-1', async () => ({ result: 0 })),
    ).rejects.toThrow('permission denied');
  });

  it('honors cacheFallback: false', async () => {
    const db = createFakeDb();
    const store = createPostgresCredentialStore({
      pool: db.pool,
      cacheFallback: false,
    });
    await store.withLock('agent-1', async () => ({ result: 0, next: blobA }));

    db.connectError = Object.assign(new Error('down'), {
      code: 'ECONNREFUSED',
    });
    await expect(
      store.withLock('agent-1', async () => ({ result: 0 })),
    ).rejects.toThrow('down');
  });

  it('rejects unsafe table names', () => {
    expect(() =>
      createPostgresCredentialStore({
        pool: createFakeDb().pool,
        table: 'creds; DROP TABLE users',
      }),
    ).toThrow('Invalid table name');
  });

  it('accepts a schema-qualified table name', async () => {
    const db = createFakeDb();
    const store = createPostgresCredentialStore({
      pool: db.pool,
      table: 'auth.runcell_credentials',
    });

    await store.withLock('a', async () => ({ result: 0 }));
    expect(
      db.queries.some(q => q.sql.includes('"auth"."runcell_credentials"')),
    ).toBe(true);
  });
});

describe('postgresCredentialStoreSql', () => {
  it('emits the table definition for manual migrations', () => {
    expect(postgresCredentialStoreSql()).toContain(
      'CREATE TABLE IF NOT EXISTS "runcell_credentials"',
    );
    expect(postgresCredentialStoreSql('auth.creds')).toContain(
      '"auth"."creds"',
    );
  });
});

/**
 * Integration suite against a real Postgres. Opt in with:
 *
 *   RUNCELL_PG_TEST_URL=postgres://user:pass@localhost:5432/db npm test
 *
 * This is the suite that actually proves the queueing/refresh-race
 * semantics; the fake above only pins the SQL protocol.
 */
const pgUrl = process.env.RUNCELL_PG_TEST_URL;
describe.runIf(Boolean(pgUrl))('postgres integration', () => {
  it('serializes concurrent refreshes so no rotation is clobbered', async () => {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: pgUrl, max: 10 });
    const table = `runcell_credentials_test_${Date.now()}`;
    const store = createPostgresCredentialStore({ pool, table });
    const key = 'race-key';

    try {
      // 20 concurrent "refreshes" each increment a counter stored in the
      // token. With correct locking every increment survives.
      await store.withLock(key, async () => ({
        result: 0,
        next: {
          anthropic: { type: 'oauth', access: '0', refresh: 'r', expires: 0 },
        },
      }));

      await Promise.all(
        Array.from({ length: 20 }, () =>
          store.withLock(key, async current => {
            const access = Number(
              (current?.anthropic as { access: string }).access,
            );
            // Yield mid-critical-section to invite interleaving.
            await new Promise(resolve => setTimeout(resolve, 5));
            return {
              result: undefined,
              next: {
                anthropic: {
                  type: 'oauth',
                  access: String(access + 1),
                  refresh: 'r',
                  expires: 0,
                },
              },
            };
          }),
        ),
      );

      const final = await store.withLock(key, async current => ({
        result: (current?.anthropic as { access: string }).access,
      }));
      expect(final).toBe('20');
    } finally {
      await pool.query(`DROP TABLE IF EXISTS "${table}"`);
      await pool.end();
    }
  });

  it('queues waiters instead of rejecting while the lock is held', async () => {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: pgUrl, max: 10 });
    const table = `runcell_credentials_test_q_${Date.now()}`;
    const store = createPostgresCredentialStore({ pool, table });

    try {
      const order: string[] = [];
      const holdRelease = vi.fn();
      const held = store.withLock('k', async () => {
        order.push('holder-in');
        await new Promise(resolve => setTimeout(resolve, 200));
        order.push('holder-out');
        holdRelease();
        return { result: 0 };
      });
      // Give the holder time to take the lock before the waiter arrives.
      await new Promise(resolve => setTimeout(resolve, 50));
      const waited = store.withLock('k', async () => {
        order.push('waiter-in');
        return { result: 0 };
      });

      await Promise.all([held, waited]);
      expect(order).toEqual(['holder-in', 'holder-out', 'waiter-in']);
      expect(holdRelease).toHaveBeenCalled();
    } finally {
      await pool.query(`DROP TABLE IF EXISTS "${table}"`);
      await pool.end();
    }
  });
});
