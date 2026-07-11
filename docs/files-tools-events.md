# Files, tools, and events

## Files in

Seed the workspace before a run starts. Text and binary both work:

```ts
await agent.run({
  prompt: 'Read feedback.txt and create report.md.',
  files: [
    { path: 'feedback.txt', text: feedback },
    { path: 'assets/data.bin', bytes: new Uint8Array([...]) },
  ],
  schema,
});
```

Paths must be relative workspace paths; absolute paths, `..` segments,
backslashes, and drive letters are rejected before the run starts.

## Files out

Created and modified files are returned on the result:

```ts
const result = await agent.run({ prompt, schema });

for (const file of result.files) {
  file.path; // workspace-relative
  file.change; // 'create' | 'modify'
  file.bytes; // Uint8Array
}

const report = result.files.find(f => f.path === 'report.md');
const text = report ? new TextDecoder().decode(report.bytes) : undefined;
```

With a caller-owned [sandbox](./sandboxes.md) you can also just read the
workspace directly (`sandbox.readTextFile(...)`) after (or during) runs.

## Host tools

Tools are functions the agent can call in your process, such as application
lookups and internal APIs that the sandbox cannot reach:

```ts
import { z } from 'zod';

const agent = createAgent({
  model,
  tools: {
    lookupCustomer: {
      description: 'Look up customer account details by customer id.',
      schema: z.object({ id: z.string() }),
      execute: ({ id }) => db.customers.find(id), // sync or async
    },
  },
});
```

- `schema` accepts any [Standard Schema](https://standardschema.dev)
  validator. The input is validated before `execute` runs and typed from the
  schema.
- The return value is serialized back to the model.
- Reserved names (used by the runtime): `read`, `write`, `edit`, `bash`,
  `grep`, `glob`, `ls`, `submitResult`, `fileChange`. Registering one throws
  at `createAgent` time.

## Events

Lifecycle callbacks support logging, UIs, and metrics. They are optional and
best-effort: callback errors are swallowed and do not affect the run. Register
callbacks at the agent level for every run or per run via
`agent.run({ ..., events })`. If both are set, both fire.

```ts
const agent = createAgent({
  model,
  events: {
    onText: delta => process.stdout.write(delta),
    onToolCall: call => log('tool call', call.name, call.input),
    onToolResult: result => log('tool result', result.name),
    onFileChange: file => log('changed', file.path, file.change),
    onRepair: info => log('repair attempt', info.attempt, info.reason),
    onFinish: info => log('turn finished', info.finishReason),
    onError: error => log('error', error),
  },
});
```

| Event          | Fires when                                                                   |
| -------------- | ---------------------------------------------------------------------------- |
| `onText`       | a text delta streams from the model                                          |
| `onToolCall`   | the agent invokes one of your tools                                          |
| `onToolResult` | one of your tools returns                                                    |
| `onFileChange` | the agent creates/modifies a workspace file                                  |
| `onRepair`     | a repair turn starts (structured runs only)                                  |
| `onFinish`     | a turn completes, with its finish reason                                     |
| `onError`      | the run fails after the session has started (the run still rejects normally) |

Events fire for `run()` and `stream()` alike. For streaming text to a client,
prefer `agent.stream()`'s `textStream` over `onText`; see
[Streaming](./streaming.md).
