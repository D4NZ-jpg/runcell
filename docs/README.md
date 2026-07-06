# Runcell docs

Runcell runs AI agents inside isolated sandbox cells: you give an agent a task,
optional files, optional tools, and optionally a schema — it works inside a
sandbox workspace and comes back with streamed text, changed files, and (when
you asked for one) a validated structured result.

## Guides

| Page                                                | What it covers                                               |
| --------------------------------------------------- | ------------------------------------------------------------ |
| [Getting started](./getting-started.md)             | Install, credentials, models, first runs                     |
| [Building a chat agent](./chat-agent.md)            | Streaming + threads + persistence — the flagship guide       |
| [Sandboxes](./sandboxes.md)                         | Ephemeral vs caller-owned sandboxes, snapshot/restore, modes |
| [Threads](./threads.md)                             | Conversation memory: messages, continuation, persistence     |
| [Structured output](./structured-output.md)         | Schemas, validation, repair turns, plain text turns          |
| [Streaming](./streaming.md)                         | `agent.stream()`, piping text to a client                    |
| [Files, tools, and events](./files-tools-events.md) | Workspace files in/out, host tools, lifecycle events         |
| [Credentials](./credentials.md)                     | env, local, API keys, shared stores                          |
| [API reference](./api.md)                           | Every export, option, and type                               |
| [Examples](./examples.md)                           | The runnable examples in `examples/`                         |

## The 30-second picture

```ts
import { createAgent, createVirtualSandbox, createThread } from 'runcell';
import { z } from 'zod';

const agent = createAgent({ model: 'anthropic/claude-sonnet-4-5' });

// A plain turn: the streamed text is the output.
const { textStream, result } = agent.stream({ prompt: 'Say hello.' });

// A structured task: result.data is validated against the schema.
const review = await agent.run({
  prompt: 'Review index.ts and report risks.',
  files: [{ path: 'index.ts', text: source }],
  schema: z.object({ risks: z.array(z.string()) }),
});

// State is yours to hold: sandboxes and threads are values you own.
const sandbox = await createVirtualSandbox();
const thread = createThread();
await agent.run({ prompt: 'Scaffold a project.', sandbox, thread });
await agent.run({ prompt: 'Now add tests.', sandbox, thread }); // same files, remembers
```
