# @runcell/postgres-concurrency

A PostgreSQL concurrency limiter for [runcell](https://github.com/D4NZ-jpg/runcell).
Every worker connected to the same database shares the limit: maximum
provider requests in flight, workload ceilings, strict reservations,
priorities, a bounded queue, and wait limits.

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

Workers that create a limiter with the same `name` share its slots.
Workload names are typed exactly as with `createConcurrencyLimiter`: the
agent's and runs' `workload` options only accept configured names. The
`db` pool is typed structurally, so any pg-compatible pool works and `pg`
is not a dependency of this package.

## Options

Takes the same limits as `createConcurrencyLimiter` (`maxConcurrent`,
`maxQueued`, `workloads`, `defaultWorkload`), plus:

| Option            | Default               | Description                                                                |
| ----------------- | --------------------- | -------------------------------------------------------------------------- |
| `db`              | required              | A `pg.Pool` or compatible pool.                                            |
| `name`            | required              | Identifies the shared limit. Workers with the same name share slots.       |
| `tablePrefix`     | `runcell_concurrency` | Table prefix; may be schema-qualified.                                     |
| `ensureSchema`    | `true`                | Create the tables on first use.                                            |
| `leaseTtlMs`      | `30000`               | How long a slot stays valid without renewal.                               |
| `pollIntervalMs`  | `100`                 | How often a waiting request checks for a slot.                             |
| `queueEntryTtlMs` | `15000`               | How long a waiting request survives without checking in.                   |
| `onConflict`      | `'reject'`            | `'replace'` overwrites different stored limits (for a coordinated change). |

## How it works

- Each allocation is one short transaction that holds the limiter's row
  lock and uses RunCell's shared allocation algorithm. Two workers can
  never grant the same slot.
- No transaction or connection is held while a request waits or while a
  provider request runs. Only one worker at a time allocates; the others
  use `SKIP LOCKED` and just check their own entry.
- Slot expiry and wait deadlines use database time.
- A crashed worker's slots come back after `leaseTtlMs`, and its queue
  entries are removed after `queueEntryTtlMs`.
- No session state is used, so transaction-mode poolers (PgBouncer) work.
- A database error rejects the operation, and RunCell fails the run closed
  with `ConcurrencyLimiterError`.

## Migrations

If the database role cannot run DDL, set `ensureSchema: false` and apply the
idempotent statements from `postgresConcurrencySchemaSql(tablePrefix)` in
your migration tool.

## Changing limits

The first worker stores the limits for a `name`. A worker with different
limits fails with `ConcurrencyConfigError` rather than enforcing
inconsistent rules. Use a new `name`, or roll out with
`onConflict: 'replace'` in a coordinated deployment.

## Guarantees

Valid slots never exceed the configured limit. Lease expiry cannot stop a
request already running at the provider, so strict physical concurrency
during a network partition needs provider-side fencing.

The test suite runs against PGlite (in-process PostgreSQL) with several
limiter instances sharing one database. PGlite has a single connection, so
transactions from different workers interleave at transaction boundaries;
parallel connections against a server are not exercised.

See the [concurrency guide](https://runcell.run/concurrency).
