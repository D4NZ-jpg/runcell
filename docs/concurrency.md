# Concurrency limits

A concurrency limit caps how many provider requests your agents have in
flight at once, across every run, retry, and nested agent. You create a
limiter and give it to your agents. RunCell handles the queueing, slots, and
cleanup.

Limits are opt-in. Without `concurrency`, runs behave exactly as before.

```ts
import { createAgent, createConcurrencyLimiter } from 'runcell';

const claude = createConcurrencyLimiter({ maxConcurrent: 4 });

const agent = createAgent({
  model: 'anthropic/claude-sonnet-4-5',
  concurrency: { limiter: claude },
});
```

Every agent that uses the same limiter shares its slots. Use one limiter
per capacity you need to protect, for example one per provider account or
model.

## What a slot covers

A slot covers **one active provider request**, including response
streaming. It does not cover a whole run, a tool call, or a sandbox.

```text
parent takes slot → model responds → slot released
  → tool starts child
      → child takes slot → model responds → slot released
  → parent takes slot → model resumes
```

RunCell takes a slot before every provider request: the first request of a
run, each request after tool results, repair turns, Pi's automatic
retries, compaction, credential-fallback attempts, and requests of agents
started from a tool. It releases the slot when the response completes,
fails, or is cancelled, and always before a tool runs.

So you can run more agents than `maxConcurrent`: at most `maxConcurrent` of
them talk to the provider at the same time, while the rest run tools or
wait their turn. A parent waiting for a child holds no slot, so even
`maxConcurrent: 1` can run a parent that calls a child and then resumes.
Children get no exemption: they wait in the same queue under the same rules.

The limit applies to provider requests only. It does not limit live agents,
tools, sandboxes, request rates, or token rates.

## Workloads

Split one capacity between kinds of work with workloads:

```ts
const claude = createConcurrencyLimiter({
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

// One run on a different workload.
await agent.run({ prompt, concurrency: { workload: 'interactive' } });
```

| Option            | Meaning                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------- |
| `maxConcurrent`   | Maximum provider requests in flight at once.                                                                  |
| `maxQueued`       | Maximum requests waiting for a slot. Later requests fail with `ConcurrencyQueueFullError`. Omit for no limit. |
| `workloads`       | Named workloads sharing the capacity. Omit for one `default` workload.                                        |
| `defaultWorkload` | Workload for requests that select none. Defaults to `default` if it exists, or to the only workload.          |
| `name`            | Name shown in events and errors. Defaults to `default`.                                                       |
| `leaseTtlMs`      | How long a slot stays valid without renewal. RunCell renews automatically. Default 30000.                     |

| Workload option | Meaning                                                                      |
| --------------- | ---------------------------------------------------------------------------- |
| `maxConcurrent` | Ceiling for this workload. Defaults to the limiter's `maxConcurrent`.        |
| `reserved`      | Slots only this workload can use, counted inside `maxConcurrent`.            |
| `priority`      | Higher values are served first among workloads with room. Default 0.         |
| `maxWaitMs`     | Longest a request may wait for a slot. The run's `timeoutMs` can shorten it. |

Rules:

- **Reservations are strict.** In the example, background work never holds
  more than six slots, even when no interactive request is waiting, so two
  interactive requests can always start right away. Unused reserved slots
  stay idle; they are not lent.
- **Priority** picks between workloads that have room; ties go to the
  request that has waited longest. Within a workload, requests are served
  first in, first out. Priority never interrupts a running request.
- **A workload at its own ceiling never blocks another workload.**
- **Priority alone does not prevent starvation.** Give a low-priority
  workload a reservation if it must always make progress.

Invalid settings throw `ConcurrencyConfigError` when you create the
limiter. If a limiter has several workloads and no default, agents must
select one; an unknown workload is rejected when the agent is created or
the run starts.

## Nested runs

An agent started from a host tool is a child run. It inherits:

- the parent's limiter, even if the child agent has no `concurrency`
  option;
- the parent's workload, unless the child run selects one with
  `run({ concurrency: { workload } })`. A child agent's own default
  workload does not override the parent's, so nesting cannot move work to
  a different workload by accident;
- the parent's cancellation and remaining time budget.

A child agent configured with a **different** limiter uses that limiter
and its own workload, for example a child that calls a different model.

Event and limiter requests carry `runId`, `rootRunId`, and `parentRunId`.
RunCell does not control work a tool detaches from its run, such as a
promise it does not await.

## Time budget and cancellation

`timeoutMs` sets a total time budget for a run. Waiting for a slot uses
that budget; it never restarts or extends it. A child stays within its
parent's remaining budget.

```ts
await agent.run({ prompt, timeoutMs: 120_000 });
```

A request waits until the earlier of the workload's `maxWaitMs` and the
end of the run's budget. Then it leaves the queue and the run fails with
`ConcurrencyTimeoutError`. The provider is never called.

On cancellation (`signal`, parent cancellation, or the run budget), RunCell
stops waiting, returns any slot granted at the same moment, aborts the
active provider request, and releases its slot. Cleanup is idempotent.

## Failures

| Failure                                 | Run rejects with            | Provider called?       |
| --------------------------------------- | --------------------------- | ---------------------- |
| No slot before the deadline             | `ConcurrencyTimeoutError`   | No                     |
| Queue full                              | `ConcurrencyQueueFullError` | No                     |
| Limiter or database failing             | `ConcurrencyLimiterError`   | No (fails closed)      |
| Unknown workload, conflicting limits    | `ConcurrencyConfigError`    | No                     |
| Slot could not be renewed before expiry | `ConcurrencyLeaseLostError` | Request aborted        |
| Provider error                          | `TurnError`                 | Yes; slot is released  |
| Releasing a slot fails                  | (run unaffected)            | `release-failed` event |

All of these extend `ConcurrencyError` and carry `limiter`, `workload`,
`runId`, `rootRunId`, `parentRunId`, and `requestId`. After a concurrency
failure the run stops, and Pi's retries cannot send a request without a
slot.

::: warning Limitation
Lease expiry cannot prove that a remote provider stopped processing a
request. RunCell guarantees that **valid slots** never exceed the limit.
During a network partition, a request can keep running at the provider
after its worker lost the slot, so strict physical concurrency needs
provider-side fencing.
:::

## Monitoring

`events.onConcurrency` receives structured events. They identify the
limiter, workload, run lineage, and request, and never contain prompts or
credentials.

| Event            | Extra fields                   |
| ---------------- | ------------------------------ |
| `wait-started`   | `deadline`                     |
| `acquired`       | `leaseId`, `waitMs`            |
| `timed-out`      | `waitMs`                       |
| `queue-full`     | `waitMs`                       |
| `wait-cancelled` | `waitMs`                       |
| `limiter-error`  | `waitMs`, `error`              |
| `config-error`   | `error`                        |
| `released`       | `leaseId`, `holdMs`, `outcome` |
| `renewal-failed` | `leaseId`, `error`             |
| `lease-lost`     | `leaseId`, `holdMs`            |
| `release-failed` | `leaseId`, `error`             |

`limiter.stats()` returns active and queued counts, overall and per
workload. RunCell emits events; routing them to alerts is up to you.

## Several workers: PostgreSQL

`@runcell/postgres-concurrency` shares a limiter across independent
workers through a database. It takes the same limits plus a database and a
name:

```ts
import pg from 'pg';
import { createPostgresConcurrencyLimiter } from '@runcell/postgres-concurrency';

const claude = createPostgresConcurrencyLimiter({
  db: new pg.Pool({ connectionString: process.env.DATABASE_URL }),
  name: 'claude',
  maxConcurrent: 8,
  workloads: {
    interactive: { reserved: 2, priority: 10 },
    background: { maxConcurrent: 6 },
  },
});
```

Every worker that creates a limiter with the same `name` shares its slots.

- Each allocation is one short transaction that holds the limiter's row
  lock, so no two workers grant the same slot.
- No transaction or connection is held while a request waits or while a
  provider request runs. Waiting requests check in every `pollIntervalMs`
  (default 100 ms).
- Slot expiry and wait deadlines use database time.
- A crashed worker's slots come back after `leaseTtlMs` (default 30 s) and
  its queue entries are removed after `queueEntryTtlMs` (default 15 s).
- No session state is used, so transaction-mode poolers such as PgBouncer
  work.

The tables are created on first use. If the database role cannot run DDL,
apply `postgresConcurrencySchemaSql()` as a migration and pass
`ensureSchema: false`.

**Changing limits.** Workers sharing a name must use the same limits. The
first worker stores them; a worker with different limits fails with
`ConcurrencyConfigError` instead of enforcing inconsistent rules. For a
change, either use a new `name` or roll out with `onConflict: 'replace'` in
a coordinated deployment.

## Custom limiters

Any object that implements `ConcurrencyLimiter` (`name`, `acquire`,
`renew`, `release`, and optionally `validateWorkload` and `stats`) can back
a limit. RunCell owns the slot lifecycle; the limiter owns allocation,
queue order, and storage. It must provide atomic allocation, expiring
leases, idempotent renewal and release, never-reused lease ids, and
cancellation-safe `acquire`. `renew` resolves `undefined` when the lease is
no longer held and rejects only for transient failures.

`runcell/concurrency` exports the allocation algorithm the built-in
limiters share and a conformance suite:

```ts
import { concurrencyConformanceCases } from 'runcell/concurrency';

for (const c of concurrencyConformanceCases({ createLimiter })) {
  it(c.name, () => c.run(), 20_000);
}
```

## Engine notes

- Pi's cache warmer sends background requests that cannot be limited, so
  RunCell turns it off when a limit is configured.
- Provider SDK retries inside one request (for example, an HTTP retry on a
  dropped connection) run under that request's slot. Pi-level retries are
  new requests and take new slots.
- Requests a Pi extension sends on its own, outside the model stream, are
  not limited.
