<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/public/logo-dark.svg">
  <img src="docs/public/logo-light.svg" alt="Runcell" height="48">
</picture>

<br><br>

_**Give an agent a workspace. Get back validated results.**_

![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22-3c873a?style=flat-square)
![TypeScript](https://img.shields.io/badge/TypeScript-blue?style=flat-square&logo=typescript&logoColor=white)
![Status](https://img.shields.io/badge/status-experimental-blue?style=flat-square)

[Quick start](#quick-start) • [Why Runcell](#why-runcell) • [Docs](https://runcell.run/) • [Examples](#examples) • [Development](#development)

</div>

Runcell is an open-source TypeScript runtime for agents that work with files
and tools. Choose a catalog model or register a provider, then run it in a
workspace. A run can return:

- changed files as bytes;
- schema-validated data, with invalid results repaired or rejected;
- streamed text through `agent.stream()`;
- threads and sandbox snapshots that you can store as JSON.

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

Runcell exposes three primitives:

- An **agent** is a stateless callable.
- A **sandbox** is the agent's workspace.
- A **thread** stores conversation state.

Agents read, write, and run commands through the sandbox. The bundled virtual
sandbox works without additional setup. Vercel Sandbox, containers, and custom
providers can supply an OS security boundary when the workload requires one.

Pass any [Standard Schema](https://standardschema.dev) validator, including
Zod, Valibot, or ArkType. Runcell validates the submitted value and attempts
repair turns when validation fails. If repair fails, the run rejects instead
of returning the invalid value.

Threads and portable filesystem snapshots serialize to JSON. The application
chooses where to store them and can resume them on another machine or sandbox
provider.

The built-in model catalog includes Anthropic, OpenAI, Google, and other
providers. Extensions can register additional providers before Runcell resolves
the configured model. Lifecycle callbacks report run activity, and extension
hooks can block tool calls.

For local personal projects, `credentials: 'local'` can reuse supported
provider logins from the development machine. Provider terms govern this use;
commercial and deployed applications should use API credentials. Runcell
refuses local credentials in production unless explicitly enabled.

Runcell does not include a database or workflow engine. The application owns
persistence, concurrency, and orchestration.

### Structured output

When a schema is present, `result.data` contains the validated value. Model
prose remains available for logs.

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

Omit the schema and the streamed text becomes the output, which suits chat
replies.

## Quick start

```bash
npm install runcell        # zod is optional and used for structured output
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

- **Chat agents** with streamed replies, persisted conversation state, and an
  optional workspace per conversation. See the
  [chat-agent guide](https://runcell.run/chat-agent).
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
`custom` (bring your own provider). Details in the
[sandboxes guide](https://runcell.run/sandboxes).

## Docs

Read the [full documentation](https://runcell.run/).

| Guide                                                              |                                               |
| ------------------------------------------------------------------ | --------------------------------------------- |
| [Getting started](https://runcell.run/getting-started)             | Install, credentials, models, first runs      |
| [Building a chat agent](https://runcell.run/chat-agent)            | Streaming + threads + persistence, end to end |
| [Sandboxes](https://runcell.run/sandboxes)                         | Handles, ownership, snapshot/restore, modes   |
| [Threads](https://runcell.run/threads)                             | Conversation memory and persistence           |
| [Structured output](https://runcell.run/structured-output)         | Schemas, repair turns, plain turns            |
| [Streaming](https://runcell.run/streaming)                         | `agent.stream()` and SSE                      |
| [Files, tools, and events](https://runcell.run/files-tools-events) | Workspace I/O, host tools, callbacks          |
| [Credentials](https://runcell.run/credentials)                     | env, local, API keys, shared stores           |
| [Pi extensions](https://runcell.run/pi-extensions)                 | Custom providers, auth extensions, hooks      |
| [API reference](https://runcell.run/api)                           | Every export and type                         |

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
| `npm run example:10` | Multi-phase runs sharing one sandbox and thread             |

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
