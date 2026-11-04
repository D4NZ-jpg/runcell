# @runcell/postgres-admission

A PostgreSQL scheduler backend for [runcell](https://github.com/D4NZ-jpg/runcell)
admission control. It enforces one policy (pool limits, workload limits,
strict reservations, priorities, bounded queues, and wait limits) across
every worker connected to the same database.

## Usage

```ts
import pg from 'pg';
import { createAgent } from 'runcell';
import { createPostgresScheduler } from '@runcell/postgres-admission';

const scheduler = createPostgresScheduler({
  pool: new pg.Pool({ connectionString: process.env.DATABASE_URL }),
  policy: {
    pools: {
      'shared-model': {
        maxConcurrent: 8,
        maxQueued: 200,
        workloads: {
          interactive: { reserved: 2, priority: 10, maxWaitMs: 60_000 },
          background: { maxConcurrent: 6, maxWaitMs: 300_000 },
        },
      },
    },
  },
});

const agent = createAgent({
  model: 'anthropic/claude-sonnet-4-5',
  admission: {
    adapter: scheduler,
    pool: 'shared-model',
    workload: 'background',
  },
});
```

The pool is typed structurally, so any pg-compatible pool works and `pg`
itself is not a dependency of this package.

## How it works

- Each allocation is one short transaction holding the pool's row lock. It
  removes expired leases and stale queue entries, checks pool, workload,
  and reservation limits with RunCell's shared allocator, and grants
  leases. Two workers can never grant the same capacity.
- No transaction or connection is held while a request waits or while a
  provider request runs. Queued requests poll every `pollIntervalMs`
  (default 100 ms). Only one worker at a time runs the allocator; the
  others use `SKIP LOCKED` and just check their own entry.
- Lease expiry and queue deadlines use database time.
- A crashed worker's leases are reclaimed after `leaseTtlMs` (default 30 s)
  and its queue entries after `queueEntryTtlMs` (default 15 s).
- No session state is used, so transaction-mode poolers (PgBouncer) work.
- A database error rejects the operation, and RunCell fails the run closed
  with `AdmissionBackendError`.

## Options

| Option             | Default             | Description                                                            |
| ------------------ | ------------------- | ---------------------------------------------------------------------- |
| `pool`             | required            | A `pg.Pool` or compatible pool.                                        |
| `policy`           | required            | Pools and workloads. Must match on every worker sharing a pool.        |
| `tablePrefix`      | `runcell_admission` | Table prefix; may be schema-qualified.                                 |
| `ensureSchema`     | `true`              | Create the tables on first use.                                        |
| `leaseTtlMs`       | `30000`             | Lease validity without renewal.                                        |
| `pollIntervalMs`   | `100`               | How often a queued request checks for a grant.                         |
| `queueEntryTtlMs`  | `15000`             | How long a queue entry survives without a poll.                        |
| `onPolicyConflict` | `'reject'`          | `'replace'` overwrites a different stored policy (coordinated change). |
| `onEvent`          | none                | Scheduler events: grants, releases, expiries, conflicts, errors.       |

## Migrations

If the database role cannot run DDL, set `ensureSchema: false` and apply
the idempotent statements from `postgresAdmissionSchemaSql(tablePrefix)`
in your migration tool.

## Policy conflicts

The first worker stores each pool's policy fingerprint. A worker with a
different policy for that pool fails admission with `AdmissionConfigError`
and emits `config-conflict`. To change a policy, deploy it with
`onPolicyConflict: 'replace'` in a coordinated rollout, or use a new pool
name.

## Guarantees

Valid leases never exceed the configured capacity. Lease expiry cannot
stop a request that is already running at the provider, so strict physical
concurrency during a network partition is not guaranteed without
provider-side fencing.

The test suite runs against PGlite (in-process PostgreSQL) with several
scheduler instances sharing one database. PGlite has a single connection,
so transactions from different workers interleave at transaction
boundaries; parallel connections against a server are not exercised.

See the [admission control guide](https://runcell.run/admission).
