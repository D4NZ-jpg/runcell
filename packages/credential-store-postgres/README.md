# runcell-postgres-credentials

A Postgres-backed `CredentialStore` for [runcell](https://github.com/runcell)'s
`credentials: { type: 'shared' }` mode: whole-blob credential persistence with
row-lock queueing, so concurrent deployments never clobber a rotated refresh
token.

## Usage

```ts
import pg from 'pg';
import { createAgent } from 'runcell';
import { createPostgresCredentialStore } from 'runcell-postgres-credentials';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const store = createPostgresCredentialStore({ pool });

const agent = createAgent({
  model: 'anthropic/claude-sonnet-4-5',
  credentials: { type: 'shared', key: 'prod-agent-default', store },
});
```

The pool is typed structurally, so any pg-compatible pool works and `pg`
itself is not a dependency of this package.

## How it works

Each `withLock` call runs one transaction: upsert the key's row, take
`SELECT ... FOR UPDATE` on it, run the callback with the current blob, write
the updated blob if the callback returns one, commit. Concurrent callers —
across processes and machines — queue on the row lock rather than fail, which
is what the runcell `CredentialStore` contract requires. A refresh in one
deployment always sees the blob committed by the previous lock holder, so a
rotated token is never overwritten with a stale one.

When the database is unreachable, the store serves the last blob this process
successfully read or wrote (per key), so agents keep running through an
outage. Updates made during the outage stay in-process and are never written
back; the next healthy call re-reads the database as the source of truth.
Disable with `cacheFallback: false`.

## Options

| Option          | Default               | Description                                                            |
| --------------- | --------------------- | ---------------------------------------------------------------------- |
| `pool`          | —                     | A `pg.Pool` or structurally compatible pool.                           |
| `table`         | `runcell_credentials` | Table name, optionally schema-qualified.                               |
| `ensureTable`   | `true`                | Create the table on first use. Disable when the role has no DDL right. |
| `lockTimeoutMs` | `0` (wait forever)    | Optional `lock_timeout` guard; on expiry the call rejects (`55P03`).   |
| `cacheFallback` | `true`                | Serve the last-known blob when the database is unreachable.            |
| `encryptionKey` | — (plaintext)         | Encrypt blobs at rest (AES-256-GCM, scrypt-derived key).               |

With `ensureTable: false`, run the migration yourself:

```ts
import { postgresCredentialStoreSql } from 'runcell-postgres-credentials';

console.log(postgresCredentialStoreSql());
// CREATE TABLE IF NOT EXISTS "runcell_credentials" (
//   key text PRIMARY KEY,
//   blob jsonb,
//   updated_at timestamptz NOT NULL DEFAULT now()
// )
```

## Encryption at rest

Pass `encryptionKey` to store blobs encrypted:

```ts
const store = createPostgresCredentialStore({
  pool,
  encryptionKey: process.env.CREDENTIAL_STORE_SECRET,
});
```

Blobs are encrypted with AES-256-GCM using a key derived from the secret via
scrypt, with a random salt and IV per write. The `jsonb` column then holds an
opaque envelope instead of token material. Pre-encryption plaintext rows stay
readable and are encrypted on their next write, so the option can be
introduced on an existing table. Reading an encrypted row without the secret,
or with the wrong one, fails with a clear error.

Losing the secret means losing the stored credentials — there is no recovery
path. Rotating the secret is not built in: read each blob with the old store
and write it back through a store created with the new secret.

## Connection poolers

The lock lives inside a single transaction on a single connection, so the
store works through poolers in transaction mode (pgbouncer, RDS Proxy, Neon,
Supabase pooler). `SET LOCAL` is transaction-scoped and pooler-safe.

## Testing

Unit tests run against an in-memory fake. The integration suite that proves
the locking semantics runs against a real Postgres when
`RUNCELL_PG_TEST_URL` is set:

```bash
RUNCELL_PG_TEST_URL=postgres://user:pass@localhost:5432/db npm test -w runcell-postgres-credentials
```
