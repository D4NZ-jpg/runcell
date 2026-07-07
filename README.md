<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/public/logo-dark.svg">
  <img src="docs/public/logo-light.svg" alt="Runcell" height="48">
</picture>

<br><br>

_Build AI agents in TypeScript that return typed, validated data. Every run is
sandboxed, with streaming and durable conversations built in._

![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-3c873a?style=flat-square)
![TypeScript](https://img.shields.io/badge/TypeScript-blue?style=flat-square&logo=typescript&logoColor=white)
![Status](https://img.shields.io/badge/status-experimental-blue?style=flat-square)

[Quick start](#quick-start) • [Why Runcell](#why-runcell) • [Docs](#docs) • [Examples](#examples) • [Development](#development)

</div>

Runcell gives an AI agent a sandbox workspace and gives you back values your
application can rely on: streamed text, changed files, schema-validated data,
and conversation state you can persist anywhere.

```ts
import { createAgent, createThread } from 'runcell';

const agent = createAgent({ model: 'anthropic/claude-sonnet-4-5' });
const thread = createThread();

// A chat turn: stream the reply, keep the memory.
const { textStream, result } = agent.stream({
  prompt: 'Read feedback.txt and summarize the top complaints.',
  files: [{ path: 'feedback.txt', text: feedback }],
  thread,
});
for await (const delta of textStream) process.stdout.write(delta);
await result;

await db.save(thread.id, thread.toJSON()); // the whole conversation, as JSON
```

> [!NOTE]
> Experimental. The examples in this repository run end-to-end with local
> credentials and are the best way to try the current API.

## Why Runcell?

Agent integrations make you assemble the same pieces every time: a sandbox,
file plumbing, tool registration, streaming, schema validation, retries when
the model misses the contract, conversation persistence. Runcell wraps those
behind three primitives and stays out of your architecture:

- **Agent**: a stateless callable. `run()` for a result, `stream()` for a
  live text feed plus the result.
- **Sandbox**: the workspace. Ephemeral by default; create a handle to keep
  one across runs, read/write it directly, `snapshot()` it into your database,
  restore it anywhere. Runcell never destroys a sandbox you own.
- **Thread**: the conversation. A mutable value with a readable message log
  and lossless continuation state. `toJSON()` and store it wherever you want.

There is no built-in store, no workflow engine, no hidden state. Concurrency
is `Promise.all`; persistence is your database; orchestration is your code.

### Structured output you can trust

Give a run a schema: anything
[Standard Schema](https://standardschema.dev)-compatible (Zod 3/4, Valibot,
ArkType). The agent must submit a matching payload. Runcell validates it,
runs repair turns when the model misses, and fails the run when they don't
help. Bad data never reaches your code. `result.data` is authoritative; prose is for logs.

```ts
const result = await agent.run({
  prompt: 'Triage this bug report.',
  files: [{ path: 'report.txt', text: report }],
  schema: z.object({
    severity: z.enum(['low', 'medium', 'high', 'critical']),
    recommendedFixes: z.array(z.string()),
  }),
});
result.data.severity; // typed and validated
```

Omit the schema entirely and the streamed text _is_ the output, which is
exactly what chat replies want.

## Quick start

```bash
npm install runcell        # zod optional — only needed for structured output
```

```ts
import { createAgent } from 'runcell';

// Production: credentials come from environment variables (default).
const agent = createAgent({ model: 'anthropic/claude-sonnet-4-5' });

// Local development: opt into local credentials.
const dev = createAgent({
  model: 'anthropic/claude-sonnet-4-5',
  credentials: 'local',
});

const reply = await agent.run({ prompt: 'Say hello.' });
console.log(reply.text);
```

Model ids can be provider-qualified when one id exists under several providers:
`openai-codex/gpt-5.5`.

## What can you build with it?

- **Chat agents** with streamed replies, durable memory, and an optional
  persistent workspace per conversation —
  [the flagship guide](docs/chat-agent.md).
- **File pipelines**: seed files in, let the agent work, get changed files
  back as bytes.
- **Typed extraction and triage**: reviews, reports, classifications your
  code consumes as data, not prose.
- **Multi-agent workspaces**: share one sandbox handle between agents; they
  see each other's files.
- **Resumable jobs**: snapshot the workspace + serialize the thread, park them
  in your database, pick both up later on another machine.

## Sandboxes

```ts
// Ephemeral (default): fresh workspace per run, destroyed after.
await agent.run({ prompt });

// Caller-owned: persists across runs; yours to destroy.
const sandbox = await createVirtualSandbox();
await agent.run({ prompt: 'Scaffold the project.', sandbox });
await sandbox.exec('npm test');
await db.save(id, await sandbox.snapshot());
await sandbox.destroy();
```

Modes: `virtual` (bundled, default) · `host` (externally-isolated CI/containers)
· `vercel` (cloud, optional `@ai-sdk/sandbox-vercel` peer, Node 22+) ·
`custom` (bring your own provider). Details in [docs/sandboxes.md](docs/sandboxes.md).

## Docs

| Guide                                                  |                                               |
| ------------------------------------------------------ | --------------------------------------------- |
| [Getting started](docs/getting-started.md)             | Install, credentials, models, first runs      |
| [Building a chat agent](docs/chat-agent.md)            | Streaming + threads + persistence, end to end |
| [Sandboxes](docs/sandboxes.md)                         | Handles, ownership, snapshot/restore, modes   |
| [Threads](docs/threads.md)                             | Conversation memory and persistence           |
| [Structured output](docs/structured-output.md)         | Schemas, repair turns, plain turns            |
| [Streaming](docs/streaming.md)                         | `agent.stream()` and SSE                      |
| [Files, tools, and events](docs/files-tools-events.md) | Workspace I/O, host tools, callbacks          |
| [Credentials](docs/credentials.md)                     | env, local, API keys, shared stores           |
| [API reference](docs/api.md)                           | Every export and type                         |

## Examples

The examples in [`examples/`](examples/) are compile-checked and runnable; they
default to local credentials so they're easy to run on a configured machine.

| Command              | Demonstrates                                                |
| -------------------- | ----------------------------------------------------------- |
| `npm run example:01` | Minimal `createAgent()` + `agent.run()`                     |
| `npm run example:02` | Structured output validation and incomplete-result handling |
| `npm run example:03` | Passing files into the sandbox                              |
| `npm run example:04` | Text, tool, file-change, repair, and finish events          |
| `npm run example:05` | Host-side custom tools                                      |
| `npm run example:06` | Credential modes                                            |
| `npm run example:07` | Minimal shared credential store                             |
| `npm run example:08` | Structured output plus returned file validation             |
| `npm run example:09` | Chat agent: streaming, thread persistence, shared sandbox   |

```bash
RUNCELL_EXAMPLE_CREDENTIALS=local npm run examples:run
```

## Development

```bash
npm install
npm run check      # build, format, lint, typecheck, tests
RUNCELL_LIVE=1 RUNCELL_LIVE_CREDENTIALS=local npm run test:live
```

Monorepo layout: the public package lives in `packages/agent/` (published as
`runcell`); `examples/` are compile-checked against it.
