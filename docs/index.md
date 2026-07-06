---
layout: home

hero:
  name: Runcell
  text: Run AI agents in a sandbox. Get back results you can trust.
  tagline: Give an agent a task, files, and a schema. Runcell streams the reply, validates the output, and hands you the changed files — with conversation state you persist anywhere.
  image:
    light: /logo-mark-light.svg
    dark: /logo-mark-dark.svg
    alt: Runcell
  actions:
    - theme: brand
      text: Get started in 5 minutes
      link: /getting-started
    - theme: alt
      text: Build a chat agent
      link: /chat-agent

features:
  - title: Isolated by default
    details: Every run gets a sandboxed workspace — file writes and shell commands never touch your machine. Bundled virtual sandbox, host mode for CI, Vercel Sandbox, or bring your own.
  - title: Typed, validated output
    details: Pass any Standard Schema (Zod, Valibot, ArkType). The agent must satisfy it — Runcell validates, runs repair turns when the model misses, and rejects rather than returning junk.
  - title: Streaming built in
    details: agent.stream() returns a text-delta stream plus the final result. Wiring it to SSE takes a dozen lines.
  - title: Conversations that fit in a database row
    details: Threads serialize to plain JSON — a readable message log plus lossless continuation state. Save to Postgres, resume on another machine.
  - title: Workspaces as values
    details: Keep one sandbox across runs, share it between agents, read its files directly, snapshot() it to JSON and restore it later.
  - title: Not a framework
    details: No workflow engine, no hidden store, no lock-in. Concurrency is Promise.all, persistence is your database, orchestration is your code.
---

## Agents that return data, not walls of text

Most agent output is prose you have to parse and hope about. Runcell inverts
that: give a run a schema and `result.data` is validated, typed output your
application can consume directly — or omit the schema and the streamed text is
the reply.

```ts
import { createAgent, createVirtualSandbox, createThread } from 'runcell';
import { z } from 'zod';

const agent = createAgent({ model: 'anthropic/claude-sonnet-4-5' });

// A structured task: result.data is validated against the schema.
const review = await agent.run({
  prompt: 'Review index.ts and report risks.',
  files: [{ path: 'index.ts', text: source }],
  schema: z.object({ risks: z.array(z.string()) }),
});
review.data.risks; // string[] — typed, validated, safe to consume

// A chat turn: the streamed text is the output.
const { textStream, result } = agent.stream({ prompt: 'Say hello.' });

// State is yours to hold: sandboxes and threads are values you own.
const sandbox = await createVirtualSandbox();
const thread = createThread();
await agent.run({ prompt: 'Scaffold a project.', sandbox, thread });
await agent.run({ prompt: 'Now add tests.', sandbox, thread }); // same files, remembers
```

## How it works

**1. Install** — the virtual sandbox is bundled; nothing else to set up.

```bash
npm install runcell
```

**2. Describe the task** — a prompt, optional files, optional tools, and a
schema when you need structured output.

**3. Consume the result** — streamed text, changed files as bytes, validated
`result.data`, and thread/sandbox state you can serialize into your database.

## Common questions

**Is this another agent framework?**
No. Runcell hands you three primitives — an agent, a sandbox, a thread — and
has no opinion about how you run them. There's no workflow engine and no
hidden state: if you saved the thread, you have the whole conversation.

**Which schema libraries work?**
Anything implementing [Standard Schema](https://standardschema.dev): Zod 3.24+,
Zod 4, Valibot, ArkType, and others. No version lock-in.

**Where does state live?**
Wherever you put it. `thread.toJSON()` and `sandbox.snapshot()` are plain
JSON-safe values — Postgres, Redis, a file on disk. Resume on any machine.

**What happens when the model ignores the schema?**
Runcell runs repair turns asking it to correct the submission. If the budget
is exhausted, the run rejects with `IncompleteResultError` — you never receive
unvalidated data.

**Is it safe to run in production?**
Credentials default to environment variables; local developer credentials are
refused in production unless explicitly allowed. Agent file paths are
validated, and every run is sandboxed by default.

## Start building

- [Get started in 5 minutes](/getting-started) — install, credentials, first run
- [Build a chat agent](/chat-agent) — streaming, memory, and persistence, end to end
- [API reference](/api) — every export and type
