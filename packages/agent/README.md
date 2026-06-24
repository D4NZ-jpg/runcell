# runcell

Run AI agents in an isolated sandbox cell and get back validated structured output.

```ts
import { createAgent } from 'runcell';
import { z } from 'zod';

const schema = z.object({
  summary: z.string(),
  nextSteps: z.array(z.string()),
});

const agent = createAgent({
  model: 'anthropic/claude-sonnet-4-5',
  credentials: 'local',
});

const result = await agent.run({
  prompt: 'Summarize this project and suggest next steps.',
  schema,
});

console.log(result.data);
```

## What it does

`runcell` gives an agent a sandbox workspace and a required Zod output contract.
The agent can read/write files, call host-side tools, and stream events. When it
finishes, `runcell` validates the submitted payload and returns typed
`result.data`.

## Highlights

- Zod-validated structured output
- sandbox file inputs and returned file outputs
- virtual, host, Vercel, and custom sandbox modes
- host-side custom tools
- text, tool, file-change, repair, finish, and error events
- local, env, API key, agent directory, and shared credential modes

## Install

```bash
npm install runcell zod
```

For Vercel Sandbox mode, install the optional sandbox provider too:

```bash
npm install runcell zod @ai-sdk/sandbox-vercel
```

## Sandbox modes

The default mode is a virtual workspace:

```ts
const agent = createAgent({
  model: 'anthropic/claude-sonnet-4-5',
  sandbox: 'virtual',
});
```

Use host mode only when the current process already runs inside a CI job,
container, VM, or another external isolation boundary:

```ts
const agent = createAgent({
  model: 'anthropic/claude-sonnet-4-5',
  sandbox: {
    type: 'host',
    rootDir: process.env.GITHUB_WORKSPACE ?? process.cwd(),
    isolation: 'external',
  },
});
```

Use Vercel Sandbox mode for cloud isolation. It requires Node.js 22+ and the
optional `@ai-sdk/sandbox-vercel` peer dependency:

```ts
const agent = createAgent({
  model: 'anthropic/claude-sonnet-4-5',
  sandbox: {
    type: 'vercel',
    runtime: 'node24',
    ports: [3000],
  },
});
```

## Credentials

Application code defaults to environment credentials when `credentials` is
omitted:

```ts
const agent = createAgent({
  model: 'anthropic/claude-sonnet-4-5',
});
```

For local development on a configured machine, opt into local credentials:

```ts
const agent = createAgent({
  model: 'anthropic/claude-sonnet-4-5',
  credentials: 'local',
});
```
