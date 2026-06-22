# Files, tools, and events

## File inputs

Seed files into the sandbox with `files`:

```ts
const result = await agent.run({
  prompt: 'Read feedback.txt and create report.md.',
  files: [{ path: 'feedback.txt', text: feedback }],
  schema,
});
```

Binary inputs are also supported:

```ts
await agent.run({
  prompt: 'Inspect these uploaded bytes.',
  files: [{ path: 'archive.bin', bytes }],
  schema,
});
```

Paths are workspace-relative. Absolute paths, `..` traversal, drive letters,
backslashes, and null bytes are rejected before execution.

## File outputs

Files created or modified by the agent are returned as `result.files`:

```ts
const report = result.files.find(file => file.path === 'report.md');
const reportText = report ? new TextDecoder().decode(report.bytes) : '';
```

See `examples/08-file-output-validation.ts` for an end-to-end pattern that
validates both structured data and returned file bytes.

## Host tools

Expose host-side functions as tools:

```ts
const lookupCustomerSchema = z.object({ id: z.string() });

const agent = createAgent({
  model: 'anthropic/claude-sonnet-4-5',
  credentials: 'local',
  tools: {
    lookupCustomer: {
      description: 'Look up customer account details by customer id.',
      schema: lookupCustomerSchema,
      execute: ({ id }) => ({
        id,
        name: 'Acme Inc.',
        accountStatus: 'active',
      }),
    },
  },
});
```

User tool names cannot collide with sandbox/runtime tools such as `read`,
`write`, `edit`, `bash`, `grep`, `glob`, `ls`, `submitResult`, or `fileChange`.

## Event hooks

Use events to connect a run to a UI, logs, or validation pipeline:

```ts
const agent = createAgent({
  model: 'anthropic/claude-sonnet-4-5',
  credentials: 'local',
  events: {
    onText: text => process.stdout.write(text),
    onToolCall: call => console.error(`calling ${call.name}`),
    onToolResult: result => console.error(`finished ${result.name}`),
    onFileChange: file => console.error(`changed ${file.path}`),
    onRepair: repair => console.error(`repair #${repair.attempt}`),
    onFinish: finish => console.error(`finish: ${finish.finishReason}`),
    onError: error => console.error(error),
  },
});
```
