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

Paths must be relative workspace paths. Runcell rejects absolute paths, `..`
segments, backslashes, and drive letters before the run starts.

## Files out

The result returns created and modified files:

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
  validator. Runcell validates the input before `execute` runs, and the schema
  sets the input type.
- Runcell serializes the return value back to the model.
- Reserved names (used by the runtime): `read`, `write`, `edit`, `bash`,
  `grep`, `glob`, `ls`, `submitResult`, `fileChange`, `readPdfPages`.
  Registering one throws
  at `createAgent` time.

### Built-in PDF tool

When a run seeds a PDF and the optional peers `pdfjs-dist` and
`@napi-rs/canvas` are installed, runcell registers `readPdfPages`. This tool
renders pages as images that the model can view. See
[Streaming](./streaming.md) for the limits. You do not need to write your own
renderer for this case.

### Multi-part and image results

Use `toolContent()` when a host tool needs to return real content blocks to the
model, such as a rendered PDF page:

```ts
import { createAgent, toolContent } from 'runcell';
import { z } from 'zod';

const agent = createAgent({
  model,
  tools: {
    renderPdfPage: {
      description: 'Render one page of a PDF for visual inspection.',
      schema: z.object({ page: z.number().int().positive() }),
      execute: async ({ page }) => {
        const png: Uint8Array = await renderPage(page);
        return toolContent([
          { type: 'text', text: `Rendered PDF page ${page}:` },
          { type: 'image', data: png, mediaType: 'image/png' },
        ]);
      },
    },
  },
});
```

| Tool return value    | What the model receives                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `toolContent([...])` | Verbatim text parts and real image blocks                                                                          |
| A string             | The string verbatim, unchanged from ordinary tool results                                                          |
| Anything else        | `JSON.stringify` text (values that serialize to `undefined` become `'null'`), unchanged from ordinary tool results |

`toolContent()` accepts a non-empty array of text and image parts. Image data
can be a `Uint8Array` or a base64 string. A base64 string must be standard
padded canonical base64: no whitespace, no `data:` URL prefix, no base64url
alphabet. The helper base64-encodes raw bytes once. It matches media types
case-insensitively and normalizes `image/jpg` to `image/jpeg`. Supported types are `image/png`, `image/jpeg`, `image/gif`, and
`image/webp`, with a 5 MB decoded limit per image. Invalid input throws eagerly
from `toolContent()`.

The helper is an explicit opt-in. Returning a bare array that looks like content
parts still follows the ordinary JSON-stringified path. Text-only
`toolContent([...])` is also valid. For these results, `onToolResult` and result
tool projections expose the normalized, JSON-safe content array with base64
image data. Runcell does not pre-check whether a model supports vision. A
provider rejection surfaces through `onError` like other model errors.

See the runnable `examples/11-image-tool-results.ts` with
`npm run example:11`.

## Events

Lifecycle callbacks support logging, UIs, and metrics. They are optional and
best-effort: runcell ignores callback errors, and they do not affect the run. Register
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

| Event                  | Fires when                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `onText`               | a text delta streams from the model                                                                                 |
| `onToolCall`           | the agent invokes one of your tools                                                                                 |
| `onToolResult`         | one of your tools returns                                                                                           |
| `onFileChange`         | the agent creates/modifies a workspace file                                                                         |
| `onRepair`             | a repair turn starts (structured runs only)                                                                         |
| `onFinish`             | a turn completes, with its finish reason                                                                            |
| `onError`              | the run fails after the session starts. Runcell attaches usage before the callback. The same object rejects the run |
| `onModelRequest`       | one provider-runtime call settles, with model, outcome, duration, and reported usage                                |
| `onEngineEvent`        | Pi schedules/finishes a retry or starts/ends compaction                                                             |
| `onCredentialFallback` | a credentials chain moves to its next source after a credential error, with `from`, `to`, and `cause`               |

### Request usage and recovery telemetry

```ts
const agent = createAgent({
  model: 'openai-codex/gpt-5.5',
  credentials: 'local',
  events: {
    onModelRequest: event => console.log(event),
    onEngineEvent: event => console.log(event),
  },
});
```

`onModelRequest` receives a `ModelRequestEvent`:

- `requestId`: a unique id for this call.
- `model`: `{ provider, id }`.
- `outcome`: `completed`, `failed`, or `cancelled`.
- `durationMs`: provider duration, excluding concurrency admission wait.
- `usage`: the same token buckets and API-price estimate as `RunUsage`, including
  output/reasoning and cache reads/writes. Absent if no provider message was
  received; error responses can report partial usage.

It observes calls through the session's model runtime, including tool follow-up
turns, repairs, Pi retries, compaction, and cache warming when enabled and
supported by the model. Admission denials send no request and emit no request
observation. Provider-internal HTTP retries are not separate runtime calls and
are not counted separately. Direct provider calls made by extensions bypass
this boundary.

`onEngineEvent` reports content-free lifecycle data:

- `type: 'retry'`: `phase` (`scheduled` or `finished`), `source` (`turn` or
  `summary`), and available `attempt`, `maxAttempts`, `delayMs`, and `success`.
- `type: 'compaction'`: `phase` (`start` or `end`), `reason` (`manual`,
  `threshold`, or `overflow`), and available `aborted`, `willRetry`, and
  `tokensBefore`.

These callbacks contain no prompt, tool content, credentials, or error text.
They do not change retry, compaction, cache-warming, or reasoning settings.
Request observations are diagnostic, not additional charges to add to
`result.usage`; that total still comes from session accounting. Neither the
API-price estimate nor token counts measure a subscription's remaining quota.

Runcell ignores callback exceptions. In particular, an exception from `onError`
does not replace the enriched failure object used to reject the run.

Events fire for `run()` and `stream()` alike. For streaming text to a client,
prefer `agent.stream()`'s `textStream` over `onText`. See
[Streaming](./streaming.md).
