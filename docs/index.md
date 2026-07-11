---
layout: home

hero:
  text: Give an agent a workspace.<br />Get back validated results.
  tagline: An open-source TypeScript runtime for agents that work with files and tools. Use a catalog or custom model with the bundled workspace or an external sandbox. Runs can stream text, preserve state, validate structured output, and return file changes.
  actions:
    - theme: brand
      text: Run your first agent
      link: /getting-started
    - theme: alt
      text: Build a chat agent
      link: /chat-agent

features:
  - title: Sandbox workspaces
    details: Agents read, write, and run commands in a sandbox workspace. The default virtual sandbox does not write to the host filesystem.
  - title: Schema validation
    details: Use any Standard Schema validator, including Zod, Valibot, or ArkType. Runcell attempts repair turns and rejects the run if validation still fails.
  - title: Sandbox providers
    details: The virtual workspace needs no setup. Vercel Sandbox, a container, or a custom provider can supply an OS security boundary.
  - title: Serializable state
    details: Threads and portable filesystem snapshots serialize to JSON. Store them anywhere and resume on another machine.
  - title: Events and hooks
    details: Lifecycle callbacks report run activity to logs and UIs. Extension hooks can block tool calls before they run.
  - title: Local credentials
    details: credentials 'local' can use supported provider logins from the development machine. Production use requires explicit opt-in.
  - title: Streaming
    details: agent.stream() returns an async iterable of text and a promise for the final result.
  - title: Application-owned orchestration
    details: Runcell has no workflow engine or data store. The application manages orchestration and persistence.
---

## Structured results

Applications often need structured data rather than unvalidated prose. When a
run has a schema, the agent must submit a value that satisfies it, and
`result.data` contains the typed result. Without a schema, the streamed text is
the reply.

```ts
import { createAgent } from 'runcell';
import { z } from 'zod';

const agent = createAgent({ model: 'anthropic/claude-sonnet-4-5' });

const review = await agent.run({
  prompt: 'Review index.ts and report the risks you find.',
  files: [{ path: 'index.ts', text: source }],
  schema: z.object({
    severity: z.enum(['low', 'medium', 'high']),
    risks: z.array(z.string()),
  }),
});

review.data.severity; // 'low' | 'medium' | 'high', validated
review.data.risks; // string[], validated
```

## How it works

1. **Install.** The virtual sandbox is bundled, so there is nothing else to
   set up.

   ```bash
   npm install runcell
   ```

2. **Describe the task.** A prompt, optional files and tools, and a schema
   when you need structured output.

3. **Use the result.** Streamed text, changed files as bytes, validated
   `result.data`, and thread or sandbox state you can serialize into your
   database.

## Common questions

### What does Runcell manage?

Runcell provides an agent, a sandbox, and a thread. It does not provide a
workflow engine or data store. A saved thread contains the conversation state
needed to resume it.

### Which schema libraries work?

Anything implementing [Standard Schema](https://standardschema.dev): Zod 3.24+,
Zod 4, Valibot, ArkType, and others.

### Where does state live?

State lives in storage chosen by the application. `thread.toJSON()` and
`sandbox.snapshot()` return JSON-safe values that can be stored in Postgres,
Redis, or a file and restored on another machine.

### What happens when the model ignores the schema?

Runcell runs repair turns asking the model to correct the submission. If the
budget is exhausted, the run rejects with `IncompleteResultError`. Invalid
structured data is not returned as a successful result.

### Which sandbox should I use in production?

The bundled virtual sandbox is an isolated in-memory workspace. It keeps agent
writes off the host filesystem, but it is not an OS security boundary. Use
Vercel Sandbox, a container or VM, or a custom provider such as Docker, E2B,
or Modal for untrusted or production workloads.

### Can I run it on my existing Claude / ChatGPT subscription?

For personal projects on your own machine: yes. `credentials: 'local'`
picks up the provider logins already configured on your dev machine, so a
side project may not need a separate API key. Provider terms govern
subscription access. Use API credentials for commercial or deployed work.
Runcell refuses local credentials in production unless explicitly enabled.

## Start building

- [Get started in 5 minutes](/getting-started): install, credentials, first run
- [Build a chat agent](/chat-agent): streaming, memory, and persistence, end to end
- [API reference](/api): every export and type
