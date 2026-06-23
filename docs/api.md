# API

## `createAgent(options)`

Creates an agent configured with a model, credentials, optional tools, and event
callbacks.

```ts
const agent = createAgent({
  model: 'anthropic/claude-sonnet-4-5',
  instructions: 'Be concise.',
  credentials: 'local',
  maxRepairs: 1,
});
```

| Option         | Description                                      |
| -------------- | ------------------------------------------------ |
| `model`        | Provider/model id                                |
| `instructions` | Agent-level instructions applied to every run    |
| `credentials`  | Credential source; defaults to `{ type: 'env' }` |
| `tools`        | Host functions exposed to the agent              |
| `events`       | Lifecycle callbacks                              |
| `sandbox`      | Sandbox mode; defaults to `virtual`              |
| `maxRepairs`   | Repair turns for missing or invalid data         |

## Sandbox modes

The default mode is a virtual workspace:

```ts
const agent = createAgent({
  model: 'anthropic/claude-sonnet-4-5',
  sandbox: 'virtual',
});
```

Use host mode when the current process already runs inside an external security
boundary, such as a CI job, container, or ephemeral VM:

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

Host mode maps the agent workspace onto `rootDir`. It does not isolate your
machine by itself.

Advanced integrations can provide their own sandbox provider:

```ts
const agent = createAgent({
  model,
  sandbox: { type: 'custom', provider },
});
```

## `agent.run(options)`

Runs a task and resolves with typed, validated output.

```ts
const result = await agent.run({
  prompt: 'Review this source file and return risks.',
  files: [{ path: 'src/index.ts', text: sourceCode }],
  schema: z.object({
    summary: z.string(),
    risks: z.array(z.string()),
  }),
});
```

| Option         | Description                                     |
| -------------- | ----------------------------------------------- |
| `prompt`       | Task prompt                                     |
| `schema`       | Zod schema for the required structured result   |
| `files`        | Text or binary files to seed into the workspace |
| `instructions` | Per-run instructions                            |
| `signal`       | Abort signal                                    |

The result has this shape:

```ts
{
  data: T;
  text: string;
  files: ChangedFile[];
}
```

`result.data` is authoritative. `result.text` is useful for logs or UI, but app
logic should rely on the schema-validated data.

## Structured output

Every run requires a schema:

```ts
const triageSchema = z.object({
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  rationale: z.string(),
  recommendedFixes: z.array(z.string()),
});

const result = await agent.run({
  prompt: 'Triage this bug report.',
  files: [{ path: 'bug-report.txt', text: report }],
  schema: triageSchema,
});
```

If the agent finishes without a valid structured payload, `runcell` can run a
repair turn. Configure that with `maxRepairs`.
