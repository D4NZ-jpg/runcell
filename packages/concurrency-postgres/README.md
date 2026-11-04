# @runcell/postgres-concurrency

A PostgreSQL concurrency limiter for [runcell](https://github.com/D4NZ-jpg/runcell).
All workers that connect to the same database share the limit. The limit
has these parts: maximum provider requests in flight, workload ceilings,
strict reservations, priorities, a bounded queue, and wait limits.

## Usage

```ts
import pg from 'pg';
import { createAgent } from 'runcell';
import { createPostgresConcurrencyLimiter } from '@runcell/postgres-concurrency';

const claude = createPostgresConcurrencyLimiter({
  db: new pg.Pool({ connectionString: process.env.DATABASE_URL }),
  name: 'claude',
  maxConcurrent: 8,
  maxQueued: 200,
  workloads: {
    interactive: { reserved: 2, priority: 10, maxWaitMs: 60_000 },
    background: { maxConcurrent: 6, maxWaitMs: 300_000 },
  },
});

const agent = createAgent({
  model: 'anthropic/claude-sonnet-4-5',
  concurrency: { limiter: claude, workload: 'background' },
});
```

All workers that create a limiter with the same `name` share its slots.

Workload names have the same types as with `createConcurrencyLimiter`. The
`workload` options of the agent and its runs accept only configured names.

The `db` option has a structural type. Thus, any pool that is compatible
with `pg` works, and this package does not depend on `pg`.

## Options

The limiter takes the same limits as `createConcurrencyLimiter`
(`maxConcurrent`, `maxQueued`, `workloads`, `defaultWorkload`). It also
takes these options:

| Option            | Default               | Description                                                                |
| ----------------- | --------------------- | -------------------------------------------------------------------------- |
| `db`              | required              | A `pg.Pool` or compatible pool.                                            |
| `name`            | required              | Identifies the shared limit. Workers with the same name share slots.       |
| `tablePrefix`     | `runcell_concurrency` | Table prefix. It can include a schema name.                                |
| `ensureSchema`    | `true`                | Create the tables on first use.                                            |
| `leaseTtlMs`      | `30000`               | How long a slot stays valid without renewal.                               |
| `pollIntervalMs`  | `100`                 | How often a waiting request checks for a slot.                             |
| `queueEntryTtlMs` | `15000`               | How long a waiting request stays in the queue without a check.             |
| `onConflict`      | `'reject'`            | `'replace'` writes over different stored limits, for a coordinated change. |

## How it works

- Each allocation is one short transaction that holds the limiter's row
  lock. The transaction uses the allocation algorithm that all RunCell
  limiters share. Two workers can never grant the same slot.
- The limiter holds no transaction or connection while a request waits or
  while a provider request runs.
- Only one worker at a time allocates. The other workers use `SKIP LOCKED`
  and examine only their own queue entry.
- Slot expiry and wait deadlines use database time.
- After a worker crashes, its slots come back after `leaseTtlMs`. The
  limiter removes its queue entries after `queueEntryTtlMs`.
- The limiter uses no session state. Thus, transaction-mode poolers such
  as PgBouncer work.
- A database error rejects the operation. RunCell then fails the run
  closed with `ConcurrencyLimiterError`.

## Migrations

If the database role cannot run DDL, do these steps:

1. Apply the statements from `postgresConcurrencySchemaSql(tablePrefix)`
   with your migration tool. The statements are idempotent.
2. Set `ensureSchema: false`.

## Change the limits

The first worker stores the limits for a `name`. A worker with different
limits fails with `ConcurrencyConfigError`, so workers never apply
inconsistent rules. To change the limits, use a new `name`. Alternatively,
deploy all workers together with `onConflict: 'replace'`.

## Guarantees

The number of valid slots never goes above the configured limit. Lease
expiry cannot stop a request that already runs at the provider. Thus,
strict physical concurrency during a network partition needs fencing at
the provider.

The tests run against PGlite, an in-process PostgreSQL, with several
limiter instances that share one database. PGlite has a single
connection. Thus, transactions from different workers interleave at
transaction boundaries. The tests do not use parallel connections to a
database server.

See the [concurrency guide](https://runcell.run/concurrency).
