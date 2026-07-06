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

Two parts with two different jobs:

- **`messages`**: a neutral, readable log of turns
  (`{ role, content, data?, createdAt }`). This is your render surface: loop
  over it to draw a chat UI, inspect it in tests, log it.
- **`continuation`** (inside `toJSON()`): an opaque, compressed capture of the
  engine's exact conversation state, updated after each successful turn. This
  is what makes memory _lossless_: the next run restores the full internal
  state, not a summary. Never inspect or edit it.

If a continuation is ever missing or can't be used (say, after an engine
upgrade), runcell falls back to replaying `messages` as context: degraded but
functional.

## Persistence: threads are plain values

```ts
// save — anywhere that stores JSON
await db.save(thread.id, thread.toJSON());

// load — in this process or another one
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

`clone()` is also how you do "what if" forks: branch a conversation at any
point and let both continue independently.

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

A thread's continuation is portable across sandboxes: resume a conversation
on a brand-new sandbox, a restored snapshot, or a different machine.

## Failed runs

A thread is only updated on success. If a run throws, the thread is unchanged —
retry with the same thread safely.
