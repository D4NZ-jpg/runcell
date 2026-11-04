# Concurrency limits

A concurrency limit caps how many provider requests your agents have in
flight at the same time. The cap applies across every run, retry, and
nested agent. You create a limiter and give it to your agents. RunCell then
does the queueing, slot handling, and cleanup.

Limits are opt-in. Without `concurrency`, runs behave exactly as before.

```ts
import { createAgent, createConcurrencyLimiter } from 'runcell';

const claude = createConcurrencyLimiter({ maxConcurrent: 4 });

const agent = createAgent({
  model: 'anthropic/claude-sonnet-4-5',
  concurrency: { limiter: claude },
});
```

All agents that use the same limiter share its slots. Use one limiter for
each capacity that you must protect, for example one limiter for each
provider account or model.

## What a slot covers

A slot covers **one active provider request**, including response
streaming. It does not cover a whole run, a tool call, or a sandbox.

```text
parent takes slot → model responds → slot released
  → tool starts child
      → child takes slot → model responds → slot released
  → parent takes slot → model resumes
```

RunCell takes a slot before every provider request:

- the first request of a run
- each request after tool results
- repair turns
- Pi's automatic retries
- compaction
- credential-fallback attempts
- requests of agents that a tool starts

RunCell releases the slot when the response completes, fails, or stops
because of cancellation. It always releases the slot before a tool runs.

Thus, you can run more agents than `maxConcurrent`. At most
`maxConcurrent` agents talk to the provider at the same time. The other
agents run tools or wait for a slot.

A parent that waits for a child holds no slot. Thus, a limiter with `maxConcurrent: 1` can run a parent that
calls a child and then continues. Children get no exemption. They wait in
the same queue and obey the same rules.

The limit applies only to provider requests. It does not limit live
agents, tools, sandboxes, request rates, or token rates.

## Workloads

Use workloads to divide one capacity between different types of work:

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

| Option            | Meaning                                                                                                        |
| ----------------- | -------------------------------------------------------------------------------------------------------------- |
| `maxConcurrent`   | Maximum provider requests in flight at the same time.                                                          |
| `maxQueued`       | Maximum requests that wait for a slot. More requests fail with `ConcurrencyQueueFullError`. Omit for no limit. |
| `workloads`       | Named workloads that share the capacity. Omit for one `default` workload.                                      |
| `defaultWorkload` | Workload for requests that select none. Defaults to `default` if it exists, or to the only workload.           |
| `name`            | Name in events and errors. Defaults to `default`.                                                              |
| `leaseTtlMs`      | How long a slot stays valid without renewal. RunCell renews it automatically. Default 30000.                   |

| Workload option | Meaning                                                                                |
| --------------- | -------------------------------------------------------------------------------------- |
| `maxConcurrent` | Ceiling for this workload. Defaults to the limiter's `maxConcurrent`.                  |
| `reserved`      | Slots that only this workload can use, counted inside `maxConcurrent`.                 |
| `priority`      | The limiter serves higher values first among workloads with room. Default 0.           |
| `maxWaitMs`     | Longest time a request can wait for a slot. The run's `timeoutMs` can make it shorter. |

The limiter applies these rules:

- Reservations are strict. In the example, background work never holds
  more than six slots, even when no interactive request waits. Thus, two
  interactive requests can always start immediately. Unused reserved slots
  stay idle. The limiter does not lend them.
- Priority selects between workloads that have room. A tie goes to the
  request that waited longest. Within a workload, the limiter serves
  requests in arrival order. Priority never interrupts a running request.
- A workload at its own ceiling never blocks a different workload.
- Priority alone does not prevent starvation. If a low-priority workload
  must always make progress, give it a reservation.

Invalid settings throw `ConcurrencyConfigError` when you create the
limiter. If a limiter has several workloads and no default, each agent
must select a workload. `createAgent` makes sure of this.

### Typed workload names

Workload names are types, not free-form strings. The limiter gets the
names from the `workloads` keys, and the agent gets them from its limiter.
Thus, a typo fails to compile:

```ts
const claude = createConcurrencyLimiter({
  maxConcurrent: 8,
  workloads: { interactive: { reserved: 2 }, background: {} },
});
// InMemoryConcurrencyLimiter<'interactive' | 'background'>

const agent = createAgent({
  model: 'anthropic/claude-sonnet-4-5',
  concurrency: { limiter: claude, workload: 'background' },
});
// Agent<'interactive' | 'background'>

agent.run({ prompt, concurrency: { workload: 'interactive' } }); // ok
agent.run({ prompt, concurrency: { workload: 'batch' } }); // type error
```

The same types apply to `defaultWorkload`, the agent's `workload`, each
run's `workload`, and `limiter.stats().workloads`. A limiter without
`workloads` has one workload, `'default'`. An agent without a limiter is
`Agent<never>`, so its runs cannot select a workload.

A run selects a workload of its agent's limiter. It cannot change to a
different limiter. To use a different limiter, create an agent that has
it. RunCell does the same checks at runtime for JavaScript callers and for
workload names that come from strings. Event and error fields
(`event.workload`, `error.workload`) stay `string`, because one event
stream can carry events from several limiters.

## Nested runs

An agent that a host tool starts is a child run. It inherits:

- the parent's limiter, even if the child agent has no `concurrency`
  option
- the parent's workload, unless the child run selects one with
  `run({ concurrency: { workload } })`
- the parent's cancellation and remaining time budget

The child agent's own default workload does not replace the parent's
workload. Thus, nesting cannot move work to a different workload by
accident.

A child agent that has a **different** limiter uses that limiter and its
own workload. An example is a child that calls a different model.

Events and limiter requests include `runId`, `rootRunId`, and
`parentRunId`. RunCell does not control work that a tool detaches from its
run, for example a promise that the tool does not await.

## Time budget and cancellation

`timeoutMs` sets a total time budget for a run. Time spent waiting for a
slot counts against that budget. The wait never restarts or extends the
budget. A child stays within its parent's remaining budget.

```ts
await agent.run({ prompt, timeoutMs: 120_000 });
```

A request waits until the workload's `maxWaitMs` or the end of the run's
budget, whichever comes first. Then the request leaves the queue, and the
run fails with `ConcurrencyTimeoutError`. RunCell does not call the
provider.

Cancellation can come from `signal`, from the parent, or from the end of
the run's budget. On cancellation, RunCell:

1. Stops waiting for a slot.
2. Returns a slot that the limiter granted at the same moment.
3. Aborts the active provider request.
4. Releases that request's slot.

Cleanup is idempotent.

## Failures

| Failure                                     | Run rejects with            | Provider called?               |
| ------------------------------------------- | --------------------------- | ------------------------------ |
| No slot before the deadline                 | `ConcurrencyTimeoutError`   | No                             |
| Queue full                                  | `ConcurrencyQueueFullError` | No                             |
| Limiter or database fails                   | `ConcurrencyLimiterError`   | No (fails closed)              |
| Unknown workload, conflicting limits        | `ConcurrencyConfigError`    | No                             |
| RunCell cannot renew the slot before expiry | `ConcurrencyLeaseLostError` | RunCell aborts the request     |
| Provider error                              | `TurnError`                 | Yes. RunCell releases the slot |
| Slot release fails                          | (run continues)             | `release-failed` event         |

All of these errors extend `ConcurrencyError`. They include `limiter`,
`workload`, `runId`, `rootRunId`, `parentRunId`, and `requestId`. After a
concurrency failure, the run stops. Pi's retries cannot send a request
without a slot.

::: warning Limitation
Internally, a slot is a lease that expires unless RunCell renews it. Lease
expiry cannot prove that a remote provider stopped work on a request.
RunCell guarantees that the number of **valid slots** never goes above the
limit. During a network partition, a request can continue at the provider
after its worker lost the slot. Strict physical concurrency needs fencing
at the provider.
:::

## Monitoring

`events.onConcurrency` receives structured events. Each event identifies
the limiter, workload, run lineage, and request. Events never contain
prompts or credentials.

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

`limiter.stats()` returns active and queued counts, in total and for each
workload. RunCell emits the events. Your application sends them to alerts.

## Several workers: PostgreSQL

`@runcell/postgres-concurrency` shares a limiter across independent workers
through a database. It takes the same limits, plus a database and a name:

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

All workers that create a limiter with the same `name` share its slots.

- Each allocation is one short transaction that holds the limiter's row
  lock. Thus, two workers cannot grant the same slot.
- The limiter holds no transaction or connection while a request waits or
  while a provider request runs. Each waiting request checks for a slot
  every `pollIntervalMs` (default 100 ms).
- Slot expiry and wait deadlines use database time.
- After a worker crashes, its slots come back after `leaseTtlMs` (default
  30 s). The limiter removes its queue entries after `queueEntryTtlMs`
  (default 15 s).
- The limiter uses no session state. Thus, transaction-mode poolers such
  as PgBouncer work.

Each waiting request runs one short transaction at each poll. Thus, the
database load is approximately the number of waiting requests divided by
`pollIntervalMs`. A test had 200 waiting requests in four processes. The database
committed about 1,800 transactions per second at the default 100 ms, and
about 400 per second at 500 ms. If you expect long queues,
increase `pollIntervalMs`. A longer interval adds up to that much delay
before a waiting request gets a free slot.

The limiter creates its tables on first use. Workers that start at the same
time on a new database do not conflict. If the database role cannot
run DDL, apply `postgresConcurrencySchemaSql()` as a migration and pass
`ensureSchema: false`.

### Change the limits

All workers that share a name must use the same limits. The first worker
stores the limits in the database. A worker with different limits fails
with `ConcurrencyConfigError`, so workers never apply inconsistent rules.
To change the limits, use a new `name`. Alternatively, deploy all workers
together with `onConflict: 'replace'`.

## Custom limiters

Any object that implements `ConcurrencyLimiter` can back a limit. The
object has `name`, `acquire`, `renew`, and `release`, and optionally
`validateWorkload` and `stats`. RunCell owns the slot lifecycle. The
limiter owns allocation, queue order, and storage.

A custom limiter must:

- allocate slots atomically
- give leases that expire
- make renewal and release idempotent
- never use a lease id again
- make `acquire` safe to cancel

`renew` resolves `undefined` when the limiter no longer holds the lease.
It rejects only for transient failures.

`runcell/concurrency` exports the allocation algorithm that the built-in
limiters share, and a conformance suite:

```ts
import { concurrencyConformanceCases } from 'runcell/concurrency';

for (const c of concurrencyConformanceCases({ createLimiter })) {
  it(c.name, () => c.run(), 20_000);
}
```

## Engine notes

- Pi's cache warmer sends background requests. They would take slots, so
  RunCell turns off cache warming when you configure a limit.
- Provider SDK retries inside one request, for example an HTTP retry after
  a dropped connection, use that request's slot. Pi-level retries are new
  requests and take new slots.
- Requests that a Pi extension sends through the session's model runtime
  take slots. RunCell cannot limit requests that an extension sends by
  other means, for example with its own HTTP client.
