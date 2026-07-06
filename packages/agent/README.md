# runcell

Run AI agents in isolated sandbox cells: streamed replies, durable
conversations, validated structured output.

```ts
import { createAgent, createThread } from 'runcell';
import { z } from 'zod';

const agent = createAgent({ model: 'anthropic/claude-sonnet-4-5' });

// A chat turn: no schema, the streamed text is the reply.
const thread = createThread();
const { textStream, result } = agent.stream({ prompt: 'Hi!', thread });
for await (const delta of textStream) process.stdout.write(delta);
await result;

// A structured task: result.data is validated against the schema.
const review = await agent.run({
  prompt: 'Review index.ts and report risks.',
  files: [{ path: 'index.ts', text: source }],
  schema: z.object({ risks: z.array(z.string()) }),
});
```

## What it does

runcell gives an agent a sandbox workspace and gives you back values your
application can rely on:

- **Streaming**: `agent.stream()` returns `{ textStream, result }`; pipe
  deltas to a UI and await the final result.
- **Structured output**: pass any
  [Standard Schema](https://standardschema.dev) validator (Zod 3/4, Valibot,
  ArkType); runcell validates the agent's submission, runs repair turns when
  the model misses, and fails the run when they don't help. Omit
  the schema for plain text turns.
- **Sandboxes**: ephemeral by default. Or create a caller-owned handle:
  reuse it across runs, `exec`/read/write it directly, `snapshot()` it to
  JSON, `restoreSandbox()` anywhere. runcell never destroys a sandbox you own.
- **Threads**: conversation memory as a value. a readable message log plus
  lossless continuation state. `toJSON()` it into your database; resume on
  any sandbox, any machine.
- **Files, tools, events**: seed files in, get changed files back as bytes,
  expose host functions as tools, observe everything through callbacks.

## Install

```bash
npm install runcell        # zod optional — only for structured output
```

## Quick start

```ts
import { createAgent, createVirtualSandbox, createThread } from 'runcell';

// Credentials default to environment variables; use 'local' on a dev machine.
const agent = createAgent({
  model: 'anthropic/claude-sonnet-4-5',
  credentials: 'local',
});

// State is yours: sandboxes and threads are values you hold and persist.
const sandbox = await createVirtualSandbox();
const thread = createThread();

await agent.run({ prompt: 'Scaffold a TypeScript project.', sandbox, thread });
await agent.run({ prompt: 'Now add tests.', sandbox, thread }); // same files, remembers

console.log(await sandbox.readTextFile('package.json'));
await db.save(thread.id, thread.toJSON());
await sandbox.destroy();
```

## Sandbox modes

```ts
await agent.run({ prompt }); // virtual (bundled, default)
await agent.run({
  prompt,
  sandbox: { type: 'host', rootDir, isolation: 'external' },
});
await agent.run({ prompt, sandbox: { type: 'vercel', runtime: 'node24' } });
await agent.run({ prompt, sandbox: { type: 'custom', provider } });
```

`host` is for externally-isolated environments only (CI, containers, VMs).
`vercel` requires Node.js 22+ and the optional `@ai-sdk/sandbox-vercel` peer
dependency.

## Models

`model` accepts an id, a display name, or a provider-qualified id when the
same model exists under several providers:

```ts
createAgent({ model: 'anthropic/claude-sonnet-4-5' });
createAgent({ model: 'openai-codex/gpt-5.5' });
```

## Documentation

Guides (chat agents, sandboxes, threads, streaming, structured output,
credentials, full API reference) live in the repository's `docs/` directory.
