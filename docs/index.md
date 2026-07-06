---
layout: home

hero:
  name: Runcell
  text: Run AI agents in isolated sandbox cells
  tagline: Streamed replies, durable conversations, validated structured output — with state you own.
  image:
    light: /logo-mark-light.svg
    dark: /logo-mark-dark.svg
    alt: Runcell
  actions:
    - theme: brand
      text: Get started
      link: /getting-started
    - theme: alt
      text: Build a chat agent
      link: /chat-agent

features:
  - title: Sandboxed by default
    details: Every run executes in an isolated workspace. Bundled virtual sandbox, host mode for CI, Vercel Sandbox, or bring your own provider.
  - title: Structured output you can trust
    details: Standard Schema contracts (Zod, Valibot, ArkType) with validation and repair turns — result.data is typed, or omit the schema for plain turns.
  - title: Streaming built in
    details: agent.stream() returns a text-delta stream plus the final result. Pipe it straight to SSE or a websocket.
  - title: Conversations as values
    details: Threads carry a readable message log and lossless continuation state. toJSON() into your database, resume anywhere.
  - title: Workspaces you own
    details: Create a sandbox handle, share it across runs and agents, read it directly, snapshot() to JSON and restore later.
  - title: Agents as code
    details: No workflow engine, no hidden store. Concurrency is Promise.all, persistence is your database, orchestration is your code.
---

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
