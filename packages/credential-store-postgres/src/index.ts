import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt as scryptCallback,
} from 'node:crypto';
import { promisify } from 'node:util';
import type { AuthBlob, CredentialStore } from 'runcell';

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

/**
 * The subset of a Postgres client this store needs. `pg.PoolClient`
 * satisfies it structurally.
 */
export interface PostgresClient {
  query(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
  release(): void;
}

/**
 * The subset of a Postgres pool this store needs. `pg.Pool` satisfies it
 * structurally, so `pg` is not a runtime dependency of this package.
 */
export interface PostgresPool {
  connect(): Promise<PostgresClient>;
}

export interface PostgresCredentialStoreOptions {
  /** A `pg.Pool` (or structurally compatible pool). */
  pool: PostgresPool;

  /**
   * Table that holds the credential blobs. Optionally schema-qualified
   * (`myschema.runcell_credentials`). Defaults to `runcell_credentials`.
   */
  table?: string;

  /**
   * Create the table on first use with `CREATE TABLE IF NOT EXISTS`.
   * Defaults to `true`. Set to `false` when the database role has no DDL
   * permission and run {@link postgresCredentialStoreSql} as a migration
   * instead.
   */
  ensureTable?: boolean;

  /**
   * Per-transaction `lock_timeout` in milliseconds. `0` (the default)
   * waits indefinitely: concurrent `withLock` calls queue on the row lock,
   * which is what the `CredentialStore` contract requires. Set a positive
   * value only as a last-resort guard against a wedged holder; on expiry
   * the call rejects with Postgres error `55P03`.
   */
  lockTimeoutMs?: number;

  /**
   * When set, blobs are encrypted at rest with AES-256-GCM using a key
   * derived from this secret (scrypt, random salt per write). Existing
   * plaintext rows stay readable and are encrypted on their next write.
   * Reading an encrypted row without the secret — or with the wrong one —
   * fails with a clear error. Losing the secret means losing the stored
   * credentials; there is no recovery path.
   */
  encryptionKey?: string;

  /**
   * When the database is unreachable, serve the last blob this process
   * successfully read or wrote for the key, so agents keep running through
   * a store outage. Updates made during the outage stay in-process and are
   * never written back (the next healthy call re-reads the database as the
   * source of truth and refreshes tokens again if needed). Defaults to
   * `true`.
   */
  cacheFallback?: boolean;
}

/**
 * The store's table definition, for use as a manual migration when
 * `ensureTable` is disabled.
 */
export function postgresCredentialStoreSql(
  table = 'runcell_credentials',
): string {
  return `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(table)} (
  key text PRIMARY KEY,
  blob jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
)`;
}

/**
 * A Postgres-backed {@link CredentialStore} for `credentials: { type:
 * 'shared' }`.
 *
 * Locking: each `withLock` call runs in a transaction that upserts the
 * key's row and takes `SELECT ... FOR UPDATE` on it. Concurrent callers —
 * across processes and machines — queue on the row lock rather than fail,
 * so a token refresh in one deployment can never clobber a rotation
 * committed by another: whoever wins the lock sees the loser's committed
 * blob before deciding to refresh.
 */
export function createPostgresCredentialStore(
  options: PostgresCredentialStoreOptions,
): CredentialStore {
  const {
    pool,
    table = 'runcell_credentials',
    ensureTable = true,
    lockTimeoutMs = 0,
    cacheFallback = true,
    encryptionKey,
  } = options;

  const quotedTable = quoteIdentifier(table);
  const cipher =
    encryptionKey !== undefined ? createBlobCipher(encryptionKey) : undefined;
  const cache = new Map<string, AuthBlob | undefined>();
  let ensured: Promise<void> | undefined;

  const ensure = async (): Promise<void> => {
    if (!ensureTable) return;
    // Memoize success; reset on failure so a transient outage during
    // startup does not permanently disable the store.
    ensured ??= (async () => {
      const client = await pool.connect();
      try {
        await client.query(postgresCredentialStoreSql(table));
      } finally {
        client.release();
      }
    })().catch((err: unknown) => {
      ensured = undefined;
      throw err;
    });
    return ensured;
  };

  const locked = async <T>(
    key: string,
    fn: (
      current: AuthBlob | undefined,
    ) => Promise<{ result: T; next?: AuthBlob }>,
  ): Promise<T> => {
    await ensure();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (lockTimeoutMs > 0) {
        // `SET LOCAL` cannot take a parameter; the value is a validated
        // integer.
        await client.query(
          `SET LOCAL lock_timeout = '${Math.floor(lockTimeoutMs)}ms'`,
        );
      }
      // Ensure the row exists so FOR UPDATE has something to lock. A
      // concurrent first insert for the same key serializes here as well.
      await client.query(
        `INSERT INTO ${quotedTable} (key) VALUES ($1) ON CONFLICT (key) DO NOTHING`,
        [key],
      );
      const selected = await client.query(
        `SELECT blob FROM ${quotedTable} WHERE key = $1 FOR UPDATE`,
        [key],
      );
      const stored = selected.rows[0]?.blob ?? undefined;
      const current = await readStoredBlob(stored, cipher);

      const { result, next } = await fn(current);

      if (next !== undefined) {
        const payload = cipher ? await cipher.encrypt(next) : next;
        await client.query(
          `UPDATE ${quotedTable} SET blob = $2::jsonb, updated_at = now() WHERE key = $1`,
          [key, JSON.stringify(payload)],
        );
      }
      await client.query('COMMIT');
      cache.set(key, next ?? current);
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  };

  return {
    async withLock(key, fn) {
      try {
        return await locked(key, fn);
      } catch (err) {
        if (cacheFallback && isUnavailableError(err) && cache.has(key)) {
          const { result, next } = await fn(cache.get(key));
          if (next !== undefined) {
            // Keep the rotation visible to this process so subsequent turns
            // use the fresh token, but never persist state produced without
            // the lock: the database stays the source of truth.
            cache.set(key, next);
          }
          return result;
        }
        throw err;
      }
    },
  };
}

/** Marker property of an encrypted blob envelope. */
const ENCRYPTED_MARKER = '__runcell_encrypted';

interface EncryptedEnvelope {
  [ENCRYPTED_MARKER]: 1;
  v: 1;
  kdf: 'scrypt';
  salt: string;
  iv: string;
  tag: string;
  data: string;
}

function isEncryptedEnvelope(value: unknown): value is EncryptedEnvelope {
  return (
    value != null &&
    typeof value === 'object' &&
    (value as Record<string, unknown>)[ENCRYPTED_MARKER] === 1
  );
}

interface BlobCipher {
  encrypt(blob: AuthBlob): Promise<EncryptedEnvelope>;
  decrypt(envelope: EncryptedEnvelope): Promise<AuthBlob>;
}

function createBlobCipher(secret: string): BlobCipher {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new Error('encryptionKey must be a non-empty string.');
  }
  // scrypt is deliberately slow; cache derivations per salt so reads of a
  // row pay the cost once per process, not once per credential access.
  const derivedKeys = new Map<string, Promise<Buffer>>();
  const keyFor = (saltBase64: string): Promise<Buffer> => {
    let derived = derivedKeys.get(saltBase64);
    if (derived === undefined) {
      derived = scrypt(secret, Buffer.from(saltBase64, 'base64'), 32);
      derivedKeys.set(saltBase64, derived);
    }
    return derived;
  };

  return {
    async encrypt(blob) {
      const salt = randomBytes(16).toString('base64');
      const iv = randomBytes(12);
      const key = await keyFor(salt);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([
        cipher.update(JSON.stringify(blob), 'utf8'),
        cipher.final(),
      ]);
      return {
        [ENCRYPTED_MARKER]: 1,
        v: 1,
        kdf: 'scrypt',
        salt,
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        data: data.toString('base64'),
      };
    },
    async decrypt(envelope) {
      const key = await keyFor(envelope.salt);
      try {
        const decipher = createDecipheriv(
          'aes-256-gcm',
          key,
          Buffer.from(envelope.iv, 'base64'),
        );
        decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
        const plain = Buffer.concat([
          decipher.update(Buffer.from(envelope.data, 'base64')),
          decipher.final(),
        ]).toString('utf8');
        return JSON.parse(plain) as AuthBlob;
      } catch {
        throw new Error(
          'Failed to decrypt the stored credential blob: wrong ' +
            '"encryptionKey" or corrupted data.',
        );
      }
    },
  };
}

/**
 * Interpret a stored blob value: `undefined` for an empty row, a decrypted
 * `AuthBlob` for an envelope, and a plaintext blob as-is (pre-encryption
 * rows stay readable when an `encryptionKey` is introduced later).
 */
async function readStoredBlob(
  stored: unknown,
  cipher: BlobCipher | undefined,
): Promise<AuthBlob | undefined> {
  if (stored === undefined || stored === null) {
    return undefined;
  }
  if (isEncryptedEnvelope(stored)) {
    if (cipher === undefined) {
      throw new Error(
        'The stored credential blob is encrypted; pass "encryptionKey" to ' +
          'createPostgresCredentialStore.',
      );
    }
    return cipher.decrypt(stored);
  }
  return stored as AuthBlob;
}

/** Postgres error classes 08 (connection exception) and 57 (operator
 * intervention, e.g. shutdown), plus common socket-level errno codes. */
const UNAVAILABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  '57P01',
  '57P02',
  '57P03',
  '53300',
]);

function isUnavailableError(err: unknown): boolean {
  if (err == null || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code !== 'string') return false;
  return UNAVAILABLE_CODES.has(code) || code.startsWith('08');
}

function quoteIdentifier(table: string): string {
  const parts = table.split('.');
  if (
    parts.length > 2 ||
    parts.some(part => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(part))
  ) {
    throw new Error(
      `Invalid table name ${JSON.stringify(table)}: expected an identifier ` +
        'such as "runcell_credentials" or "myschema.runcell_credentials".',
    );
  }
  return parts.map(part => `"${part}"`).join('.');
}
