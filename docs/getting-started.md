# Getting started

## Install

```bash
npm install runcell
```

If you want structured output, also install a
[Standard Schema](https://standardschema.dev)-compatible validation library.
The examples use Zod (v3 and v4 both work):

```bash
npm install runcell zod
```

Nothing else is required: the default virtual sandbox is bundled. Optional
extras like the Vercel Sandbox provider are separate installs (see
[Sandboxes](./sandboxes.md)).

## Credentials

Application code defaults to environment credentials — omit `credentials` and
provider keys are read from environment variables (`ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, and friends):

```ts
const agent = createAgent({ model: 'anthropic/claude-sonnet-4-5' });
```

On a configured development machine, opt into local credentials:

```ts
const agent = createAgent({
  model: 'anthropic/claude-sonnet-4-5',
  credentials: 'local',
});
```

All modes (API keys, shared stores, custom directories) are covered in
[Credentials](./credentials.md).

## Models

`model` accepts a model id, a display name, or a provider-qualified id. When
the same model id exists under several providers, qualify it to pin the one
you hold credentials for:

```ts
createAgent({ model: 'anthropic/claude-sonnet-4-5' });
createAgent({ model: 'openai-codex/gpt-5.5' }); // provider-qualified
```

## First run: a plain turn

Without a schema, the model's text is the output:

```ts
import { createAgent } from 'runcell';

const agent = createAgent({
  model: 'anthropic/claude-sonnet-4-5',
  credentials: 'local',
});

const reply = await agent.run({ prompt: 'Say hello in one sentence.' });
console.log(reply.text); // the reply
console.log(reply.finishReason); // "stop"
console.log(reply.data); // undefined — no schema was given
```

## First run: a structured task

With a schema, the agent must submit a payload matching it, and `result.data`
is the validated, typed output:

```ts
import { createAgent } from 'runcell';
import { z } from 'zod';

const agent = createAgent({
  model: 'anthropic/claude-sonnet-4-5',
  credentials: 'local',
});

const result = await agent.run({
  prompt: 'Summarize this project and suggest next steps.',
  schema: z.object({
    summary: z.string(),
    nextSteps: z.array(z.string()),
  }),
});

console.log(result.data.summary); // typed
```

## Where to next

- Build something real: [Building a chat agent](./chat-agent.md)
- Give runs a workspace that persists: [Sandboxes](./sandboxes.md)
- Give runs memory: [Threads](./threads.md)
- Stream tokens to a UI: [Streaming](./streaming.md)

## Validating this repository

```bash
npm run check                     # build, lint, typecheck, tests
RUNCELL_LIVE=1 RUNCELL_LIVE_CREDENTIALS=local npm run test:live
```
