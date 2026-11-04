# Admission control

Admission control limits how many provider requests your agents have in
flight at once, across every run, retry, and nested child agent. You
configure pools and workloads. RunCell queues, schedules, and leases
permits. You do not write a scheduler.

Admission is opt-in. Without an `admission` option, runs behave exactly as
before.

## What a permit covers

A permit covers **one active provider request**, including response
streaming. It does not cover a whole run, a tool call, or a sandbox.

```text
parent acquires permit → model responds → permit released
  → tool starts child
      → child acquires permit → model responds → permit released
  → parent acquires permit → model resumes
```

RunCell acquires a permit before every provider request:

- the first request of a run, and each request after tool results;
- repair turns for structured output;
- Pi's automatic retries, compaction, and branch summaries;
- credential-fallback attempts;
- requests of RunCell agents started from a tool (children).

RunCell releases the permit when the response completes, fails, or is
cancelled, and always before a tool runs. A parent waiting for a child holds
no permit, so a pool with capacity 1 can run a parent that calls a child and
then resumes. Children get no exemption: they wait in the same queue under
the same rules.

Admission limits provider-request concurrency only. It does not limit live
agents, tools, sandboxes, request rates, or token rates.

## Quick start

```ts
import { createAgent, createInMemoryScheduler } from 'runcell';

const scheduler = createInMemoryScheduler({
  policy: { pools: { default: { maxConcurrent: 4 } } },
});

const agent = createAgent({
  model: 'anthropic/claude-sonnet-4-5',
  admission: { adapter: scheduler },
});
```

The in-memory scheduler coordinates the agents in one process. For several
workers, use the [PostgreSQL backend](#distributed-scheduling-with-postgresql).

## Pools and workloads

```ts
const policy = {
  pools: {
    'shared-model': {
      maxConcurrent: 8,
      maxQueued: 200,
      workloads: {
        interactive: {
          maxConcurrent: 8,
          reserved: 2,
          priority: 10,
          maxWaitMs: 60_000,
        },
        background: {
          maxConcurrent: 6,
          reserved: 0,
          priority: 0,
          maxWaitMs: 300_000,
        },
      },
    },
  },
};

const agent = createAgent({
  model: 'anthropic/claude-sonnet-4-5',
  admission: {
    adapter: createInMemoryScheduler({ policy }),
    pool: 'shared-model',
    workload: 'background',
  },
});

// Select a different workload for one run.
await agent.run({ prompt, admission: { workload: 'interactive' } });
```

| Setting                  | Meaning                                                                                                                    |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| pool `maxConcurrent`     | Maximum valid active permits in the pool.                                                                                  |
| pool `maxQueued`         | Maximum waiting requests across the pool. Later requests fail with `AdmissionQueueFullError`. Omit for an unbounded queue. |
| pool `defaultWorkload`   | Workload for requests that select none. Defaults to `default` when that workload exists, or to the only workload.          |
| workload `maxConcurrent` | Maximum valid active permits for the workload. Defaults to the pool limit.                                                 |
| workload `reserved`      | Permits other workloads can never use, counted inside the pool limit.                                                      |
| workload `priority`      | Higher values are granted first among eligible workloads. Default `0`.                                                     |
| workload `maxWaitMs`     | Maximum admission wait for the workload, bounded by the remaining run budget.                                              |

A pool without `workloads` has one implicit `default` workload that can use
the whole pool.

Scheduling rules:

- **Reservations are strict.** In the example, background work never holds
  more than six permits, even when no interactive request is waiting. Two
  interactive requests can always start without waiting for background
  requests to finish. Unused reserved capacity stays idle; it is not lent.
- **Priority** picks between eligible workloads; ties go to the oldest
  waiting request. Requests within a workload are granted first in, first
  out. Priority never interrupts an active request.
- **A workload at its own ceiling never blocks another workload.**
- **Priority alone does not prevent starvation.** Give a lower-priority
  workload a reservation if it needs guaranteed progress.

Invalid policies throw `AdmissionConfigError` when the scheduler is
created: negative or non-integer limits, a workload limit above the pool
limit, a reservation above its workload limit, or reservations that add up
to more than the pool limit. An unknown pool or workload is rejected when
the agent is created or the run starts.

## Nested runs

A RunCell agent started from a host tool is a child run. It inherits:

- the parent's admission adapter, even if the child agent has no
  `admission` option;
- the parent's pool and workload, unless the child run selects one with
  `run({ admission: { pool, workload } })`; the agent-level `pool` and
  `workload` apply to root runs only;
- the parent's scheduling metadata, merged as agent defaults, then
  inherited values, then per-run values (later wins);
- the parent's cancellation and remaining time budget.

Every admission request carries `runId`, `rootRunId`, and `parentRunId`, so
backends and event consumers can see the lineage. RunCell does not control
work a tool detaches from its run (for example, a promise it does not
await).

## Deadlines and cancellation

`timeoutMs` sets a total time budget for a run. Admission waits consume
that budget; they never restart or extend it. A child stays within its
parent's remaining budget.

```ts
await agent.run({ prompt, timeoutMs: 120_000 });
```

The deadline for one permit is the earliest of the run budget, the
agent-level or per-run `maxWaitMs`, and the workload's `maxWaitMs`. At the
deadline the queued request is removed and the run fails with
`AdmissionTimeoutError`. The provider is never called.

On cancellation (`signal`, parent cancellation, or the run budget), RunCell
stops a queued acquisition, returns any permit granted at the same moment,
aborts the active provider request, and releases its permit. Cleanup is
idempotent: completion, cancellation, and timeout can race without
releasing twice.

## Failures

| Failure                                   | Run rejects with          | Provider called?        |
| ----------------------------------------- | ------------------------- | ----------------------- |
| Admission deadline reached                | `AdmissionTimeoutError`   | No                      |
| Queue full                                | `AdmissionQueueFullError` | No                      |
| Backend unavailable or failing            | `AdmissionBackendError`   | No (fails closed)       |
| Unknown pool/workload, conflicting policy | `AdmissionConfigError`    | No                      |
| Lease could not be renewed before expiry  | `AdmissionLeaseLostError` | Request aborted         |
| Provider error                            | `TurnError`               | Yes; permit is released |
| Release fails                             | (run is unaffected)       | `cleanup-failed` event  |

All admission errors extend `AdmissionError` and carry `pool`, `workload`,
`runId`, `rootRunId`, `parentRunId`, and `requestId`. After an admission
failure the run stops: Pi's retries cannot send an unadmitted request.

RunCell renews a lease while its request is active (by default after half
its TTL). Transient renewal failures are retried until the lease expires.
Then the lease is lost: RunCell aborts the request and the run fails.

::: warning Limitation
Lease expiry cannot prove that a remote provider stopped processing a
request. RunCell enforces that **valid leases** never exceed capacity. It
cannot guarantee strict physical concurrency during a network partition,
because a request can keep running at the provider after its worker lost
the lease. Strict physical limits need provider-side fencing.
:::

## Events

`events.onAdmission` receives structured events. Events identify the pool,
workload, run lineage, and request. They never contain prompts or
credentials.

| Event            | Extra fields                   |
| ---------------- | ------------------------------ |
| `wait-started`   | `deadline`                     |
| `acquired`       | `leaseId`, `waitMs`            |
| `timed-out`      | `waitMs`                       |
| `queue-full`     | `waitMs`                       |
| `backend-failed` | `waitMs`, `error`              |
| `wait-cancelled` | `waitMs`                       |
| `released`       | `leaseId`, `holdMs`, `outcome` |
| `renewal-failed` | `leaseId`, `error`             |
| `lease-lost`     | `leaseId`, `holdMs`            |
| `cleanup-failed` | `leaseId`, `error`             |

Schedulers also accept `onEvent` for pool-level events (`queued`,
`granted` and `released` with the active count, `queue-full`,
`wait-expired`, `wait-cancelled`, `lease-expired`, `backend-error`,
`config-conflict`). `scheduler.stats(pool)` returns active and queued counts
per workload. Count `queue-full` and `wait-expired` events for queue-full and
admission-timeout totals. RunCell emits events; routing them to alerts is
up to you.

## Distributed scheduling with PostgreSQL

`@runcell/postgres-admission` enforces the same policy across independent
workers that share a database.

```ts
import pg from 'pg';
import { createAgent } from 'runcell';
import { createPostgresScheduler } from '@runcell/postgres-admission';

const scheduler = createPostgresScheduler({
  pool: new pg.Pool({ connectionString: process.env.DATABASE_URL }),
  policy,
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

How it works:

- Each allocation runs in one short transaction that holds the pool's row
  lock: remove expired leases and stale queue entries, check the pool,
  workload, and reservation limits, choose waiters, and create their
  leases. No two workers can grant the same capacity.
- No transaction or connection is held while a request waits or while a
  provider request runs. Queued requests poll (`pollIntervalMs`, default
  100 ms); only one worker at a time runs the allocator, the others skip
  it.
- Lease expiry and queue deadlines use database time, so worker clock
  differences do not matter.
- A crashed worker's leases are reclaimed after `leaseTtlMs` (default 30 s)
  and its queue entries after `queueEntryTtlMs` (default 15 s).
- The backend uses no session state (no `LISTEN`, no session advisory
  locks), so transaction-mode poolers such as PgBouncer work.

### Schema

By default the backend creates its two tables on first use. If the
database role cannot run DDL, apply the statements from
`postgresAdmissionSchemaSql()` as a migration and pass
`ensureSchema: false`. `tablePrefix` (default `runcell_admission`) may be
schema-qualified.

### Policy changes

Every worker sharing a pool must use the same policy for it. The first
worker stores the pool's policy fingerprint; a worker with a different
policy fails admission with `AdmissionConfigError` and emits
`config-conflict`, rather than enforcing inconsistent limits. To change a
policy, roll it out with `onPolicyConflict: 'replace'` on a coordinated
deployment, or use a new pool name.

## Custom adapters

Any object that implements `AdmissionAdapter` (`acquire`, `renew`,
`release`, optional `validate`) can back admission. RunCell owns the lease
lifecycle; the adapter owns allocation, queue order, and storage. An adapter
must provide atomic allocation, expiring leases, idempotent renewal and
release, never-reused lease ids (so stale calls cannot touch a replacement
lease), and cancellation-safe acquisition. `renew` resolves `undefined`
when the lease is no longer held and rejects only for transient failures.

Run the conformance suite with your test runner:

```ts
import { admissionConformanceCases } from 'runcell';

for (const c of admissionConformanceCases({ createAdapter })) {
  it(c.name, () => c.run(), 20_000);
}
```

## Engine notes

- Pi's cache warmer sends background requests that cannot be admitted, so
  RunCell turns it off when admission is configured.
- Provider SDK retries inside a single request (for example, an HTTP retry
  on a dropped connection) run under that request's permit. Pi-level
  retries are new requests and acquire new permits.
- Requests that a Pi extension sends on its own, outside the model stream,
  are not admitted.
