# Building a chat agent

This is the guide the rest of the docs build toward: a chat endpoint where each
conversation streams its replies, remembers its history, and can keep a working
filesystem between turns — with **you** deciding where every piece of state
lives.

The three primitives:

- **Agent** — stateless. Create one per process and reuse it.
- **Thread** — the conversation. A mutable value you persist wherever you want.
- **Sandbox** — the workspace. Ephemeral by default; pass a handle to keep it.

## Step 1: a minimal chat loop

```ts
import { createAgent, createThread } from 'runcell';
import readline from 'node:readline/promises';

const agent = createAgent({
  model: 'anthropic/claude-sonnet-4-5',
  credentials: 'local',
});
const thread = createThread();
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

for (;;) {
  const prompt = await rl.question('you> ');
  const { textStream, result } = agent.stream({ prompt, thread });
  for await (const delta of textStream) {
    process.stdout.write(delta);
  }
  process.stdout.write('\n');
  await result; // always await: this finalizes the turn and updates the thread
}
```

Two things to notice:

- No `schema` — a chat reply is the streamed text itself, not a structured
  payload. `result.data` is `undefined` on these turns.
- The `thread` is mutated in place: after `await result`, it contains the new
  user + agent turns, and the next call remembers everything so far.

## Step 2: an HTTP endpoint with persistence

An agent server is stateless if you persist the thread between requests.
`thread.toJSON()` is a plain JSON value — store it in Postgres, Redis, a file,
anywhere:

```ts
import {
  createAgent,
  createThread,
  threadFromJSON,
  type ThreadState,
} from 'runcell';

const agent = createAgent({ model: 'anthropic/claude-sonnet-4-5' });

// Works as a Next.js route handler, Hono handler, Bun.serve fetch, etc.
export async function POST(req: Request): Promise<Response> {
  const { conversationId, message } = (await req.json()) as {
    conversationId: string;
    message: string;
  };

  const saved: ThreadState | undefined = await db.loadThread(conversationId);
  const thread = saved
    ? threadFromJSON(saved)
    : createThread({ id: conversationId });

  const { textStream, result } = agent.stream({ prompt: message, thread });

  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for await (const delta of textStream) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(delta)}\n\n`),
        );
      }
      await result;
      await db.saveThread(conversationId, thread.toJSON());
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });

  return new Response(body, {
    headers: { 'content-type': 'text/event-stream' },
  });
}
```

Each request gets a fresh sandbox (created and destroyed by runcell), but the
conversation survives: the thread carries its own continuation state, so the
next turn picks up **exactly** where the last one ended — even on a different
machine.

## Step 3: rendering history

`thread.messages` is the render surface — a neutral log of turns for your UI:

```ts
const thread = threadFromJSON(await db.loadThread(conversationId));

for (const message of thread.messages) {
  render({
    who: message.role, // 'user' | 'agent'
    text: message.content,
    at: message.createdAt,
  });
}
```

Don't render (or touch) `thread.toJSON().continuation` — it's the opaque
engine state that makes lossless resume work. `messages` is for humans;
`continuation` is for the machine.

## Step 4: a workspace that survives the conversation

By default every turn runs in a fresh sandbox. If the conversation _builds_
something — a project, a dataset, a report — keep one sandbox per conversation
and pass the handle:

```ts
import { createVirtualSandbox, restoreSandbox } from 'runcell';

// While the conversation is hot: keep a live handle (e.g. in an in-memory map).
const sandbox =
  liveSandboxes.get(conversationId) ?? (await createVirtualSandbox());
liveSandboxes.set(conversationId, sandbox);

await agent.run({ prompt: message, thread, sandbox });

// Your server can read what the agent built, directly:
const pkg = await sandbox.readTextFile('package.json');

// When the conversation goes cold: snapshot files into your DB and dispose.
await db.saveWorkspace(conversationId, await sandbox.snapshot());
await sandbox.destroy();

// When the user comes back: rehydrate.
const revived = await restoreSandbox(await db.loadWorkspace(conversationId));
```

Ownership rule: **you created the handle, you destroy it.** runcell never
disposes a sandbox you passed in — and a thread's continuation works across
sandboxes, so conversation memory is never tied to workspace lifetime.

## Step 5: mixing in structured turns

A chat conversation sometimes needs a machine-readable answer. Add a `schema`
to just those turns:

```ts
import { z } from 'zod';

const triage = await agent.run({
  prompt: 'Based on our conversation, triage this as a bug report.',
  thread, // same conversation
  schema: z.object({
    severity: z.enum(['low', 'medium', 'high']),
    title: z.string(),
  }),
});

await createTicket(triage.data); // typed and validated
```

Plain turns and structured turns share the same thread freely.

## The whole shape

```txt
one process-wide agent
└── per conversation
    ├── thread    → your DB          (memory: messages + continuation)
    ├── sandbox   → live map or snapshot in your DB (workspace, optional)
    └── per turn: agent.stream({ prompt, thread, sandbox? })
```

runcell owns none of your state. Threads and snapshots are plain JSON-safe
values; where they live — and how conversations scale out — is your
architecture, not the library's.
