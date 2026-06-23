<div align="center">

# runcell

_Run AI agents in an isolated sandbox cell and get back validated structured output._

![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-3c873a?style=flat-square)
![TypeScript](https://img.shields.io/badge/TypeScript-blue?style=flat-square&logo=typescript&logoColor=white)
![Status](https://img.shields.io/badge/status-experimental-blue?style=flat-square)

[Quick start](#quick-start) • [Why runcell](#why-runcell) • [Examples](#examples) • [Docs](#docs) • [Development](#development)

</div>

`runcell` is a TypeScript package for running AI agents inside an isolated
workspace and treating the result like application data, not model prose.

You provide a task, optional files, optional host tools, and a Zod schema. The
agent can inspect and modify the sandbox workspace, then it must submit a
structured result. `runcell` validates that payload and returns typed
`result.data`.

```ts
const result = await agent.run({
  prompt: 'Read feedback.txt, write report.md, and summarize the findings.',
  files: [{ path: 'feedback.txt', text: feedback }],
  schema: z.object({
    title: z.string(),
    reportPath: z.literal('report.md'),
    keyFindings: z.array(z.string()),
  }),
});

console.log(result.data.keyFindings);
console.log(result.files.map(file => file.path));
```

> [!NOTE]
> The package is experimental. The examples in this repository run end-to-end
> with local credentials and are the best way to try the current API.

## Why runcell?

Most agent integrations make you assemble several pieces yourself:

- sandbox setup;
- file input and output handling;
- tool registration;
- progress events;
- schema validation;
- repair turns when the model misses the output contract;
- credential handling for local development and deployed apps.

`runcell` wraps those pieces behind one small API:

```ts
const agent = createAgent({ model, tools, events });
const result = await agent.run({ prompt, files, schema });
```

The important distinction is that `result.data` is authoritative. Free-form text
is still available for logs or UI, but application logic can rely on the
schema-validated result.

## What can you build with it?

`runcell` is useful for workflows where an agent needs both a workspace and a
strict output contract:

- review files and return typed findings;
- generate a report file plus structured metadata;
- triage bug reports into severity, rationale, and fixes;
- call your application tools while preparing an answer;
- run a multi-step file task and stream progress to a UI;
- validate final output before handing it to the rest of your system.

## Quick start

### Install

```bash
npm install runcell zod
```

For this repository, install workspace dependencies first:

```bash
npm install
```

### Run an example

Examples default to local credentials so they are easy to run on a configured
development machine.

```bash
npm run example:01
```

### Use the API

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

For deployed apps, omit `credentials` or pass `{ type: 'env' }` to read provider
credentials from environment variables.

```ts
const agent = createAgent({
  model: 'anthropic/claude-sonnet-4-5',
});
```

## Core capabilities

### Structured results

Every run has a schema. The agent must submit a payload matching that schema,
and `runcell` validates it before returning.

```ts
const schema = z.object({
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  rationale: z.string(),
  recommendedFixes: z.array(z.string()),
});
```

### File inputs and outputs

Pass files into the sandbox and receive files created or modified by the agent.

```ts
const report = result.files.find(file => file.path === 'report.md');
const reportText = report ? new TextDecoder().decode(report.bytes) : '';
```

### Sandbox modes

By default, `runcell` runs in a virtual sandbox workspace:

```ts
const agent = createAgent({
  model: 'anthropic/claude-sonnet-4-5',
  sandbox: 'virtual',
});
```

Use host mode only when the current process is already isolated by something
else, such as a CI job, container, or ephemeral VM:

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

Host mode maps the agent workspace onto `rootDir`; `runcell` does not add an OS
security boundary in this mode.

Advanced users can pass a custom sandbox provider:

```ts
const agent = createAgent({
  model,
  sandbox: { type: 'custom', provider },
});
```

### Host tools

Expose application functions the agent can call.

```ts
tools: {
  lookupCustomer: {
    description: 'Look up customer account details by customer id.',
    schema: z.object({ id: z.string() }),
    execute: ({ id }) => ({ id, name: 'Acme Inc.' }),
  },
}
```

### Events

Stream text, tool calls, file changes, repairs, finishes, and errors into your
UI or logs.

```ts
events: {
  onText: text => process.stdout.write(text),
  onFileChange: file => console.error(`changed ${file.path}`),
  onFinish: finish => console.error(`finish: ${finish.finishReason}`),
}
```

### Credentials

Examples use local credentials by default. Application code defaults to
environment credentials when `credentials` is omitted.

Supported modes include `env`, `local`, explicit API keys, explicit agent
directories, and shared lockable credential stores.

## Examples

The examples in [`examples/`](examples/) are compile-checked and runnable.

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

Run every example:

```bash
RUNCELL_EXAMPLE_CREDENTIALS=local npm run examples:run
```

Example configuration:

```bash
RUNCELL_EXAMPLE_MODEL=anthropic/claude-sonnet-4-5 npm run example:01
RUNCELL_EXAMPLE_CREDENTIALS=env npm run example:01
RUNCELL_EXAMPLE_CREDENTIALS=agentDir:/path/to/agent-dir npm run example:01
```

## Docs

The README is the project overview and quickstart. Detailed docs are split into
focused pages:

- [Getting started](docs/getting-started.md)
- [Examples](docs/examples.md)
- [API](docs/api.md)
- [Files, tools, and events](docs/files-tools-events.md)
- [Credentials](docs/credentials.md)

## Development

```bash
npm run check        # build + format:check + lint + typecheck + test
npm run build        # build packages
npm run lint         # run ESLint
npm run format       # run Prettier
npm run typecheck    # typecheck packages and examples
npm run test         # run unit tests
npm run test:live    # opt-in live smoke test
```

Run the live smoke test with local credentials:

```bash
RUNCELL_LIVE=1 RUNCELL_LIVE_CREDENTIALS=local npm run test:live
```

The CI gate runs the non-live checks on Node.js 20 and 22.
