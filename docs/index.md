---
layout: home

hero:
  name: Runcell
  text: Run AI agents in a sandbox. Get back results you can trust.
  tagline: Runcell gives the agent an isolated workspace. You get streamed text, changed files, and output validated against your schema, plus conversation state you can store anywhere.
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
    details: Every run happens in a sandboxed workspace, so file writes and shell commands never touch your machine. The virtual sandbox is bundled; host, Vercel, and custom providers are there when you need them.
  - title: Typed, validated output
    details: Works with any Standard Schema library (Zod, Valibot, ArkType). Runcell checks the agent's submission, asks it to fix mistakes, and fails the run if it can't. Bad data never reaches your code.
  - title: Streaming built in
    details: agent.stream() returns the text as an async iterable plus a promise for the final result. Wiring it to SSE takes about a dozen lines.
  - title: Conversations that fit in a database row
    details: A thread serializes to plain JSON, with a readable message log and the state needed to resume losslessly. Save it to Postgres and pick it up on another machine.
  - title: Workspaces as values
    details: Keep one sandbox across runs, share it between agents, or read its files from your own code. snapshot() turns it into JSON you can restore later.
  - title: Not a framework
    details: There is no workflow engine and no hidden store. Concurrency is Promise.all, persistence is your database, orchestration is your code.
---

## The output is a contract

Most agent output is prose you have to parse and hope about. When a Runcell
run has a schema, the agent must submit a payload that satisfies it, and
`result.data` comes back typed. Skip the schema and the streamed text is the
reply.

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
review.data.risks; // string[], validated

// A chat turn: the streamed text is the output.
const { textStream, result } = agent.stream({ prompt: 'Say hello.' });

// State is yours to hold: sandboxes and threads are values you own.
const sandbox = await createVirtualSandbox();
const thread = createThread();
await agent.run({ prompt: 'Scaffold a project.', sandbox, thread });
await agent.run({ prompt: 'Now add tests.', sandbox, thread }); // same files, remembers
```

## How it works

1. Install. The virtual sandbox is bundled, so there is nothing else to set
   up.

   ```bash
   npm install runcell
   ```

2. Describe the task: a prompt, optional files and tools, and a schema when
   you need structured output.

3. Use the result. Streamed text, changed files as bytes, validated
   `result.data`, and thread or sandbox state you can serialize into your
   database.

## Common questions

**Is this another agent framework?**
No. Runcell hands you three primitives (an agent, a sandbox, a thread) and has
no opinion about how you run them. There is no workflow engine and no hidden
state: if you saved the thread, you have the whole conversation.

**Which schema libraries work?**
Anything implementing [Standard Schema](https://standardschema.dev): Zod 3.24+,
Zod 4, Valibot, ArkType, and others.

**Where does state live?**
Wherever you put it. `thread.toJSON()` and `sandbox.snapshot()` are plain
JSON-safe values, so Postgres, Redis, and a file on disk all work. Resume on
any machine.

**What happens when the model ignores the schema?**
Runcell runs repair turns asking it to correct the submission. If the budget
is exhausted, the run rejects with `IncompleteResultError`. You never receive
unvalidated data.

**Is it safe to run in production?**
Credentials default to environment variables, and local developer credentials
are refused in production unless explicitly allowed. Agent file paths are
validated, and every run is sandboxed by default.

## Start building

- [Get started in 5 minutes](/getting-started): install, credentials, first run
- [Build a chat agent](/chat-agent): streaming, memory, and persistence, end to end
- [API reference](/api): every export and type
