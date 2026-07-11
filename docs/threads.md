# Threads

A `Thread` is a conversation: a mutable value that gives runs memory. Pass the
same thread to consecutive runs and each one continues where the last ended.

```ts
import { createAgent, createThread } from 'runcell';

const agent = createAgent({ model: 'anthropic/claude-sonnet-4-5' });
const thread = createThread();

await agent.run({ prompt: 'Remember: the codename is Falcon.', thread });
const r = await agent.run({ prompt: 'What is the codename?', thread });
// r.text mentions Falcon
```

## What a thread contains

A thread has two parts:

- `messages` is a readable log of turns
  (`{ role, content, data?, createdAt }`). Use it to render a chat UI, inspect
  turns in tests, or write logs.
- `continuation`, included in `toJSON()`, is an opaque, compressed capture of
  the engine's conversation state. It is updated after each successful turn,
  allowing the next run to restore the internal state rather than a summary.
  Do not inspect or edit it.

If a continuation is missing or unusable, such as after an engine upgrade,
runcell falls back to replaying `messages` as context. Some conversation state
may be lost, but the thread remains usable.

## Persistence: threads are plain values

```ts
// Save to any JSON store.
await db.save(thread.id, thread.toJSON());

// Load in this process or another one.
import { threadFromJSON } from 'runcell';
const revived = threadFromJSON(await db.load(id));
await agent.run({ prompt: 'Continue.', thread: revived });
```

`toJSON()` output is fully JSON-serializable (the continuation is base64
inside). There is no built-in store and no hidden state: if you saved the
thread, you have the whole conversation.

## Mutation and forking

Threads mutate in place. After a successful run, the new user + agent turns
have been appended to the thread you passed. The rule that follows:

> **One thread = one logical actor.** Don't hand the same thread to two
> concurrent runs; `clone()` it instead.

```ts
const branch = thread.clone(); // deep, independent copy

await Promise.all([
  agent.run({ prompt: 'Explore approach A.', thread }),
  agent.run({ prompt: 'Explore approach B.', thread: branch }),
]);
```

Use `clone()` to branch a conversation at any point and continue both branches
independently.

## Threads and sandboxes are independent

A thread remembers the **conversation**; a sandbox holds the **files**. They
compose freely:

```ts
// Conversation memory on ephemeral sandboxes: remembers what was said,
// fresh filesystem each turn.
await agent.run({ prompt, thread });

// Conversation memory + persistent workspace: remembers what was said
// AND what was built.
await agent.run({ prompt, thread, sandbox });
```

A thread's continuation is portable across sandboxes. You can resume a
conversation in a new sandbox, from a restored snapshot, or on another
machine.

## Failed runs

A thread is updated only after a successful run. If a run throws, the thread
remains unchanged and can be reused for a retry.
