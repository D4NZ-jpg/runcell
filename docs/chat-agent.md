# Building a chat agent

This guide builds a chat endpoint that streams replies, preserves conversation
history, and optionally keeps a workspace between turns.

It uses three Runcell primitives:

- An **agent** is stateless and can be reused across runs.
- A **thread** holds conversation state that the application can persist.
- A **sandbox** is the run workspace. Pass a handle to reuse it across turns.

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
  await result; // Finalize the turn and update the thread.
}
```

Two things to notice:

- No `schema`: a chat reply is the streamed text itself, not a structured
  payload. `result.data` is `undefined` on these turns.
- The `thread` is mutated in place: after `await result`, it contains the new
  user and agent turns used as context for the next call.

## Step 2: an HTTP endpoint with persistence

Persisting the thread allows conversation state to survive between requests
and server instances. `thread.toJSON()` returns a JSON value suitable for a
database, cache, or file:

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

Each request gets a fresh sandbox that Runcell creates and destroys. The
thread carries the continuation state, so the next turn can resume on another
machine.

## Step 3: rendering history

Use `thread.messages` as the message history displayed by the UI:

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

Do not render or modify `thread.toJSON().continuation`. It contains opaque
engine state used to resume the conversation.

## Step 4: a workspace that survives the conversation

By default every turn runs in a fresh sandbox. If the conversation _builds_
something (a project, a dataset, a report), keep one sandbox per conversation
and pass the handle:

```ts
import { createVirtualSandbox, restoreSandbox } from 'runcell';

// Keep a live handle while the conversation is active.
const sandbox =
  liveSandboxes.get(conversationId) ?? (await createVirtualSandbox());
liveSandboxes.set(conversationId, sandbox);

await agent.run({ prompt: message, thread, sandbox });

// Read files from the workspace.
const pkg = await sandbox.readTextFile('package.json');

// Snapshot and destroy the sandbox when it is no longer active.
await db.saveWorkspace(conversationId, await sandbox.snapshot());
await sandbox.destroy();

// Restore the workspace later.
const revived = await restoreSandbox(await db.loadWorkspace(conversationId));
```

The caller must destroy sandbox handles it creates. Runcell does not destroy a
sandbox passed to a run. Thread continuation state can be used with another
sandbox.

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

Plain and structured turns can use the same thread.

## The whole shape

```txt
one process-wide agent
└── per conversation
    ├── thread    → your DB          (memory: messages + continuation)
    ├── sandbox   → live map or snapshot in your DB (workspace, optional)
    └── per turn: agent.stream({ prompt, thread, sandbox? })
```

The application stores thread and sandbox snapshots and determines how
conversations are distributed across processes.
