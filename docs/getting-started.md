# Getting started

## Install

```bash
npm install runcell zod
```

For Vercel Sandbox mode, also install the optional provider:

```bash
npm install @ai-sdk/sandbox-vercel
```

For this repository, install workspace dependencies first:

```bash
npm install
```

## Run the basic example

Examples default to local credentials so they are easy to run on a configured
development machine.

```bash
npm run example:01
```

Override the model or credential mode when needed:

```bash
RUNCELL_EXAMPLE_MODEL=anthropic/claude-sonnet-4-5 npm run example:01
RUNCELL_EXAMPLE_CREDENTIALS=env npm run example:01
RUNCELL_EXAMPLE_CREDENTIALS=agentDir:/path/to/agent-dir npm run example:01
```

## Minimal app

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

console.log(result.data.summary);
```

## Production default

Application code can omit `credentials`. The default is `{ type: 'env' }`, so
provider keys can come from the deployment environment.

```ts
const agent = createAgent({
  model: 'anthropic/claude-sonnet-4-5',
});
```

## Validation

Run the non-live project gate:

```bash
npm run check
```

Run the opt-in live smoke test:

```bash
RUNCELL_LIVE=1 RUNCELL_LIVE_CREDENTIALS=local npm run test:live
```
