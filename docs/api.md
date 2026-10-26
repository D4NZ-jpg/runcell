# API reference

The `runcell` entrypoint exports the public API.

## `createAgent(options): Agent`

Creates a stateless agent bound to a model, credentials, tools, and event
callbacks. Create one per process and reuse it across runs.

```ts
const agent = createAgent({
  model: 'anthropic/claude-sonnet-4-5',
  systemPrompt: 'Be concise.',
  credentials: 'local',
  tools: { lookupCustomer },
  events: { onText: d => process.stdout.write(d) },
  maxRepairs: 1,
});
```

| Option         | Type                             | Description                                                                                                                            |
| -------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `model`        | `string`                         | Model id, display name, or provider-qualified id (`openai-codex/gpt-5.5`). Required.                                                   |
| `systemPrompt` | `string`                         | Persistent system prompt: system role, re-applied every turn, survives thread resume.                                                  |
| `credentials`  | `Credentials`                    | Credential source, or an array tried in order as a fallback chain. Defaults to `{ type: 'env' }`. See [Credentials](./credentials.md). |
| `tools`        | `Record<string, ToolDefinition>` | Host functions the agent can call. See [Files, tools, and events](./files-tools-events.md).                                            |
| `events`       | `AgentEvents`                    | Lifecycle callbacks.                                                                                                                   |
| `sandbox`      | `SandboxOption`                  | Agent-level default sandbox mode. Defaults to `'virtual'`.                                                                             |
| `maxRepairs`   | `number`                         | Repair-turn budget for structured runs. Defaults to `1`.                                                                               |
| `pi`           | `PiOptions`                      | Pi engine options. See [Pi options](./pi-extensions.md).                                                                               |

A configured `model` that is not present in Pi's catalog fails at session
startup with `Unknown model "…"` and up to five likely catalog matches. Runcell
does not fall back to the agent directory's configured default model.

### Named credentials and ordered models

The existing `AgentOptions` form above is unchanged. Alternatively, pass
`ModelAgentOptions` with `models` and a named credential map:

```ts
createAgent({
  credentials: {
    subscription: { type: 'shared', key: 'prod', store },
    api: { type: 'env' },
  },
  models: [
    { model: 'anthropic/claude-sonnet-4-5', credentials: 'subscription' },
    { model: 'openai/gpt-5.1', credentials: 'api' },
  ],
});
```

`models` is a non-empty ordered array of `ModelRoute` entries. Each entry's
`credentials` must name an own key in the credential map. References are
checked by TypeScript and at runtime. Map values accept `Credentials`,
including chains; all registered sources are validated at creation.

Use either `model` or `models`, never both. Runs advance only on credential
errors before tools or output, and never after caller cancellation. Credential
chains are exhausted before the next model is tried. `onFallback` receives a
`ModelFallbackEvent` with `from`, `to` (each `{ model, credentials }`), and
`cause`. See [Model and provider fallbacks](./credentials.md#model-and-provider-fallbacks)
for the retry limits and thread behavior.

### `PiOptions`

```ts
type PiThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

interface PiOptions {
  extensions?: readonly ExtensionFactory[];
  thinkingLevel?: PiThinkingLevel;
}
```

`thinkingLevel` sets the agent-level default reasoning effort. Pi maps it to
such provider-native controls as Anthropic's thinking budget and OpenAI's
`reasoning_effort`, then clamps it to what the selected model supports. When
unset, Pi's default for that model applies. Invalid values make
`createAgent()` throw `InvalidOptionError`.

`runcell` exports `PiThinkingLevel`. See
[Pi options](./pi-extensions.md) for examples and extension semantics.

## `agent.run(options)`

Two overloads:

```ts
// with a schema: result.data is validated and typed
run<TSchema extends AgentSchema>(options: RunOptions<TSchema>): Promise<RunResult<InferSchemaOutput<TSchema>>>;

// without: a plain turn, result.data is undefined
run(options: RunOptionsBase): Promise<RunResult<undefined>>;
```

### Run options

| Option               | Type                                  | Description                                                                                                                                                                                |
| -------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `prompt`             | `string`                              | The task prompt. Supply either `prompt` or `messages`.                                                                                                                                     |
| `messages`           | `readonly UIChatMessage[]`            | A UI chat history (AI SDK `UIMessage` shape). Must end with a user message. Earlier turns replay as context. File parts on every user message become workspace files under `attachments/`. |
| `maxAttachmentBytes` | `number`                              | Per-attachment size limit for `file` parts in `messages`. Defaults to 20 MB.                                                                                                               |
| `schema`             | `AgentSchema`                         | Structured output contract ([Standard Schema](https://standardschema.dev)). Omit for a plain turn.                                                                                         |
| `files`              | `FileInput[]`                         | Files seeded into the workspace before the run. Relative paths only.                                                                                                                       |
| `sandbox`            | `Sandbox \| SandboxOption`            | A caller-owned handle that Runcell does not destroy, or an ephemeral mode option.                                                                                                          |
| `thread`             | `Thread`                              | Conversation to continue. A successful run mutates it in place.                                                                                                                            |
| `events`             | `AgentEvents`                         | Per-run lifecycle callbacks, invoked in addition to the agent-level ones.                                                                                                                  |
| `context`            | `RunContext`                          | Optional server-side request/operation attributes included in hooks and execution reports, never automatically sent to the model or UI stream.                                             |
| `pi`                 | `{ thinkingLevel?: PiThinkingLevel }` | Per-run thinking-level override. The only accepted key is `thinkingLevel`. It wins for this run only.                                                                                      |
| `sessionId`          | `string`                              | Resume a previous session by id.                                                                                                                                                           |
| `signal`             | `AbortSignal`                         | Cancels the run.                                                                                                                                                                           |

The per-run `pi` object accepts only `thinkingLevel`. Extensions stay
agent-level. Invalid values make `run()` throw `InvalidOptionError` before the
run starts.

With a schema, the first schema-valid `submitResult` call is terminal: runcell
cancels the active model turn and returns that submission. A trailing stream
timeout or transport error does not discard an already accepted result. Runcell
keeps the text and file changes that it observed before the submission.

### Application correlation

Pass optional application metadata per run, not on the shared agent:

```ts
const result = await agent.run({
  prompt,
  context: {
    requestId: 'req-123',
    operation: 'summarize-feedback',
    tenantId: 'tenant-456',
  },
});
console.log(result.execution?.context);
```

`RunContext` is an exported readonly map of strings, finite numbers, booleans,
or `null`. Only enumerable string-keyed attributes of a plain object are
copied. Nested objects, arrays, `undefined` values, accessors, and custom
instances are rejected with `InvalidOptionError` before execution. Attribute
names are application-defined and have no runtime effect.

The built-in runtime copies and freezes context at dispatch. That snapshot is
shared by run/attempt hooks, correlated tool/repair/finish/fallback events,
and success/failure execution reports. Changing the caller's object afterward
does not alter the report. Concurrent runs and later runs do not inherit it.
Text and file callback payloads remain unchanged.

Context is not included in prompts, thread history, provider headers, or UI
message streams. It is not redacted: use opaque IDs and do not put secrets or
personal content in it. If you serialize the full result yourself, its execution
report includes the context you supplied.

Use the existing callbacks to connect your own logger, tracing library, or
metrics sink. Runcell does not install a telemetry SDK, create tracing spans,
propagate distributed tracing headers, or provide an OpenTelemetry adapter.

### `RunResult<TData>`

| Field          | Type            | Description                                                            |
| -------------- | --------------- | ---------------------------------------------------------------------- |
| `data`         | `TData`         | Validated structured output, or `undefined` for runs without a schema. |
| `text`         | `string`        | The model's prose and the output for plain turns.                      |
| `files`        | `ChangedFile[]` | Files created/modified during this run (`{ path, change, bytes }`).    |
| `finishReason` | `string`        | Why the final turn stopped, e.g. `"stop"`.                             |
| `sessionId`    | `string`        | Identifier of the underlying run session.                              |
| `usage`        | `RunUsage`      | Known token usage and estimated cost across all attempts.              |
| `execution`    | `RunExecution?` | Final execution report. Always supplied by the built-in runtime.       |

### `RunUsage`

Known token usage and estimated cost for one run, accumulated across all
attempts, including failed attempts and repair turns. Successful runs expose
it as `result.usage`; use `getRunUsage(error)` on failure.

Check `result.execution.usage.status` or `getRunExecution(error)?.usage.status`
to distinguish complete measurements from partial or unknown usage. Partial
and unknown counts are lower bounds, not evidence that an unreported request
consumed zero tokens.

| Field              | Type      | Description                                          |
| ------------------ | --------- | ---------------------------------------------------- |
| `inputTokens`      | `number`  | Non-cached input tokens billed at the input rate.    |
| `outputTokens`     | `number`  | Output tokens, including reasoning tokens.           |
| `cacheReadTokens`  | `number`  | Input tokens read from the provider's prompt cache.  |
| `cacheWriteTokens` | `number`  | Input tokens written to the provider's prompt cache. |
| `totalTokens`      | `number`  | Sum of all token buckets.                            |
| `costUsd`          | `number`  | Estimated cost in US dollars at API list price.      |
| `costMeasured`     | `boolean` | Whether `costUsd` is a real measurement.             |

Runcell computes `costUsd` from the [models.dev](https://models.dev)-derived
model catalog, including tiered pricing. It is always the as-if-API price: runs on
subscription (OAuth) credentials report what the same tokens would have cost
through the provider's API. Models the catalog does not price report `0`
with `costMeasured: false`, so a zero can be told apart from genuinely free
usage: when `costMeasured` is `false`, treat `costUsd` as unpriced or
incompletely measured, not free. `costMeasured` describes whether known costs
could be attributed; the execution report's usage status separately describes
coverage. Catalog cost is an estimate, not an invoice or a product-billing record.

```ts
const result = await agent.run({ prompt: 'Summarize feedback.txt.' });
console.log(result.usage);
// {
//   inputTokens: 1204, outputTokens: 380,
//   cacheReadTokens: 8600, cacheWriteTokens: 950,
//   totalTokens: 11134, costUsd: 0.0214,
// }
```

### Execution reports

The built-in runtime attaches an immutable `RunExecution` to every successful
result. On failure, `getRunExecution(error)` returns the same report supplied
to `onRunEnd`, without mutating foreign or frozen errors.

```ts
import { getRunExecution } from 'runcell';

try {
  const result = await agent.run({ prompt });
  console.log(result.execution?.runId, result.execution?.attempts);
} catch (error) {
  const execution = getRunExecution(error);
  console.log(execution?.outcome, execution?.error, execution?.usage);
}
```

A report includes `runId`, ISO `startedAt`/`endedAt`, monotonic `durationMs`,
`outcome` (`succeeded`, `failed`, or `cancelled`), `attempts`, aggregate `usage`,
and structured `error` details on failure. Optional application `context` is
included when supplied to the run.

Each attempt includes:

- `runId`, `attemptId`, and zero-based `index`.
- Configured `model`, named `credentials` (`primary` for the legacy API),
  `credentialSource` mode, `routeIndex`, and `sourceIndex` within its chain.
- Actual `resolvedModel: { id, provider }` and `sessionId` when available.
- Timing, outcome, usage, and error details.
- `fallback: { model, credentials, sourceIndex }` only when the failure advances
  to another attempt. The error's kind explains the transition.

An attempt executes one model route with one concrete credential source.
Tool and repair turns remain inside that attempt. SDK-internal HTTP retries
are not separate attempts. Run and attempt IDs are fresh even when a session
or thread resumes.

`execution.usage` and each attempt's `usage` include the `RunUsage` fields plus
`status: 'complete' | 'partial' | 'unknown'`. Complete means the runtime has
measurements covering its observed execution, not that it can reconcile a
provider invoice or inspect hidden SDK retries. An interrupted request may
have unreported usage; its known counts remain partial or unknown. Setup
failures before a model request have measured zero model usage.

Runtime-generated report fields exclude prompt text, model output, tool
payloads, credential values, and raw error messages. Explicit application
`context` is included unchanged. Names and model IDs are included too, so do
not put secrets in context or credential names. Reports stay server-side;
UI message streams do not include them automatically.

The runtime begins recording after run-option validation and input
normalization. Invalid arguments rejected before dispatch have no report.
Custom runtimes may omit `execution`, which is why the public result field
is optional. `getRunExecution` returns `undefined` for unrelated values.
Reports are associated with thrown-object identity. If custom infrastructure
reuses one setup error object across runs, retain each `onRunEnd` report:
a later lookup on that reused object returns its most recent execution.

## `agent.stream(options): StreamRun`

Same options and overloads as `run`, returned as a live stream plus a promise:

```ts
const { textStream, result } = agent.stream({ prompt, thread });
for await (const delta of textStream) push(delta);
const final = await result; // always await this
```

| Field                                 | Type                            | Description                                                               |
| ------------------------------------- | ------------------------------- | ------------------------------------------------------------------------- |
| `textStream`                          | `AsyncIterable<string>`         | The model's text deltas.                                                  |
| `result`                              | `Promise<RunResult>`            | Final result. Rejects on failure. Always await it.                        |
| `toUIMessageStream(options?)`         | `AsyncIterable<UIMessageChunk>` | The run as AI SDK UI Message Stream chunks.                               |
| `toUIMessageStreamResponse(options?)` | `Response`                      | The run as a UI Message Stream SSE response for `useChat` / assistant-ui. |

Both accept `UIMessageStreamOptions`, mirroring the AI SDK: `sendReasoning`,
`sendTools` (blanket, `'names-only'`, or per-tool), and `onError` (masked by
default so server error details never reach the client).
`toUIMessageStreamResponse` also accepts `ResponseInit` fields. See
[wire-level controls](./streaming.md#wire-level-controls).

The UI message stream carries text and reasoning deltas, tool calls and
results (runcell-internal tools are hidden), one step per model turn
(including repair turns), and a final `finish` chunk whose `messageMetadata`
carries the run's [`usage`](#runusage) and session id. A failed run ends the
stream with an in-band `error` chunk (with usage metadata when measurable)
while `result` still rejects. See [Streaming](./streaming.md#zero-glue-chat-frontends)
for the route-handler pattern.

## Sandboxes

### `createSandbox(option?: SandboxOption): Promise<Sandbox>`

Creates a caller-owned sandbox handle on any backend (`virtual`, `host`,
`vercel`, or `custom`). The option defaults to `{ type: 'virtual' }`. Pass the
same handle to multiple `agent.run()` calls to share one live provider session
and workspace. Runcell does not destroy caller-owned handles.

If provider session creation succeeds but workspace setup fails, runcell
destroys the session before rejecting.

### `createVirtualSandbox(options?): Promise<Sandbox>`

Creates a caller-owned in-memory sandbox. `options.env` sets environment
variables for every command.

### `restoreSandbox(snapshot, options?): Promise<Sandbox>`

Creates a fresh virtual sandbox and writes a snapshot's files back into it.
Runcell validates the snapshot before it creates the sandbox. Escaping paths,
duplicate paths, and malformed base64 throw `InvalidOptionError`.

### `Sandbox`

| Member                  | Description                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------- |
| `id`                    | Stable identifier for the resource.                                                   |
| `capabilities`          | `{ ports, nativeSnapshot, resume }`: what this backend supports.                      |
| `exec(command, opts?)`  | Run a shell command → `{ exitCode, stdout, stderr }`. `opts`: `cwd`, `env`, `signal`. |
| `readFile(path)`        | `Uint8Array \| null`.                                                                 |
| `readTextFile(path)`    | `string \| null`.                                                                     |
| `writeFile(path, data)` | Writes text or bytes, creating parent directories.                                    |
| `remove(path)`          | Removes a file or directory. Does nothing if the path does not exist.                 |
| `snapshot()`            | Portable, JSON-serializable capture of workspace **files** (`SandboxSnapshot`).       |
| `exposeUrl?(port)`      | Public URL for a port. Present only when `capabilities.ports` is `true`.              |
| `lock(key, fn)`         | Opt-in mutex, serialized per key on this handle.                                      |
| `destroy()`             | Dispose the sandbox. Idempotent. Later operations throw. Only the caller does this.   |

File paths passed to `readFile`, `writeFile`, `remove`, and similar methods
must be relative POSIX paths. Absolute paths and `..` throw
`InvalidOptionError`.

### `SandboxOption` (ephemeral modes)

```ts
type SandboxOption =
  | 'virtual'
  | { type: 'virtual' }
  | {
      type: 'host';
      rootDir: string;
      isolation: 'external';
      env?: Record<string, string | undefined>;
      inheritHostEnv?: boolean;
    }
  | {
      type: 'vercel';
      runtime?: string;
      ports?: readonly number[];
      timeout?: number;
      [key: string]: unknown;
    }
  | { type: 'custom'; provider: SandboxProvider };
```

See [Sandboxes](./sandboxes.md) for semantics. `vercel` requires the optional
`@ai-sdk/sandbox-vercel` peer dependency and Node.js 22+.

### `SandboxProvider`

The provider interface accepted by `{ type: 'custom' }`: an object with
`specificationVersion: 'harness-sandbox-v1'`, a `providerId`, a
`createSession({ sessionId, abortSignal })` method, and an optional
`resumeSession({ sessionId, abortSignal })` method. Both methods return a
network sandbox session. runcell owns that session: it disposes the session
after the run, unless the sandbox is a handle from `createSandbox()`.

The `@ai-sdk/sandbox-*` packages deprecate their provider objects in favor of
session factories. Wrap a factory to build a provider:

```ts
import { createVercelNetworkSandboxSession } from '@ai-sdk/sandbox-vercel';

const provider: SandboxProvider = {
  specificationVersion: 'harness-sandbox-v1',
  providerId: 'my-vercel',
  createSession: ({ abortSignal } = {}) =>
    createVercelNetworkSandboxSession({ runtime: 'node24', abortSignal }),
};
```

## Threads

### `createThread(options?): Thread`

New empty conversation. `options.id` sets a stable id (defaults to a UUID).

### `threadFromJSON(state): Thread`

Rebuilds a thread from a persisted `ThreadState`.

### `Thread`

| Member     | Description                                                |
| ---------- | ---------------------------------------------------------- |
| `id`       | Conversation id.                                           |
| `messages` | `readonly ThreadMessage[]`: the readable turn log.         |
| `clone()`  | Deep, independent copy (fork the conversation).            |
| `toJSON()` | `ThreadState`: plain JSON-safe value. Persist it anywhere. |

### `ThreadMessage`

```ts
{ role: 'user' | 'agent'; content: string; data?: unknown; createdAt: string }
```

`ThreadState.continuation` contains opaque engine state required to resume a
thread. Store it without modifying it. See [Threads](./threads.md).

## Tools

```ts
interface ToolDefinition<TSchema extends AgentSchema = AgentSchema> {
  description: string;
  schema: TSchema; // Standard Schema; input validated + typed
  execute(input: InferSchemaOutput<TSchema>): unknown; // sync or async
}
```

Reserved tool names: `read`, `write`, `edit`, `bash`, `grep`, `glob`, `ls`,
`submitResult`, `fileChange`, `readPdfPages`.

### `toolContent(parts): ToolContent`

Builds an explicit multi-part result for a host tool. Return it from `execute()`
to send text verbatim and images as real image blocks instead of JSON-stringified
text.

```ts
const result = toolContent([
  { type: 'text', text: 'Rendered page:' },
  { type: 'image', data: pngBytes, mediaType: 'image/png' },
]);
```

`parts` must be a non-empty array. Image `data` accepts `Uint8Array` or a
base64 string. The helper base64-encodes bytes. A base64 string must be
standard padded canonical base64: no whitespace, no `data:` URL prefix, no
base64url alphabet. Supported media types are `image/png`,
`image/jpeg`, `image/gif`, and `image/webp`. Matching is case-insensitive and
`image/jpg` normalizes to `image/jpeg`. The limit is 5 MB decoded per image.
Invalid inputs throw eagerly. Text-only content is valid.

The returned envelope has
`{ type: 'runcell.tool-content', version: 1, content: [...] }`. It is an explicit
discriminator, not a duck-typed array: returning a bare content-like array from
a tool keeps the ordinary JSON-stringified behavior. Tool-result events and
result projections expose only the normalized `content` array, with base64
image data.

### `isToolContent(value): value is ToolContent`

Returns whether `value` is a valid normalized `ToolContent` envelope. Beyond
the structural shape (discriminator, version, part shapes, supported media
types) it re-checks the data invariants: image `data` must be canonical padded
base64 and at most 5 MB decoded. It returns `false` for a hand-built or
deserialized envelope that violates them.

### Tool content types

```ts
type ToolContentPartInput = ToolContentTextPart | ToolContentImageInput;
type ToolContentPart = ToolContentTextPart | ToolContentImagePart;
type ToolContentImageMediaType =
  'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

interface ToolContentTextPart {
  readonly type: 'text';
  readonly text: string;
}

interface ToolContentImageInput {
  readonly type: 'image';
  readonly data: Uint8Array | string;
  readonly mediaType: string;
}

interface ToolContentImagePart {
  readonly type: 'image';
  readonly data: string;
  readonly mediaType: ToolContentImageMediaType;
}

interface ToolContent {
  readonly type: typeof TOOL_CONTENT_TYPE;
  readonly version: 1;
  readonly content: readonly ToolContentPart[];
}

const TOOL_CONTENT_TYPE = 'runcell.tool-content';
```

`ToolContent`, `ToolContentPart`, `ToolContentPartInput`,
`ToolContentTextPart`, `ToolContentImagePart`, `ToolContentImageInput`,
`ToolContentImageMediaType`, and `TOOL_CONTENT_TYPE` are also exports of
`runcell`.

Runcell does not pre-check model vision support. Provider failures surface
through `onError` like other model errors.

## Events (`AgentEvents`)

Run-level hooks are `onRunStart`, `onAttemptStart`, `onAttemptEnd`, and
`onRunEnd`. Existing callbacks remain `onText`, `onToolCall`, `onToolResult`,
`onFileChange`, `onRepair`, `onFinish`, `onError`, `onCredentialFallback`,
and `onFallback`. `onFinish` still describes a turn, not the entire run.
Callbacks registered at the agent and run levels both fire. See
[Files, tools, and events](./files-tools-events.md).

## Files

```ts
type FileInput =
  { path: string; text: string } | { path: string; bytes: Uint8Array };
```

Paths must be relative workspace paths (no absolute paths, no `..`).

## Errors

All runcell errors extend `RuncellError`:

| Error                   | Thrown when                                                                                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `InvalidOptionError`    | Options are malformed (bad sandbox option, reserved tool name, foreign thread…).                                                                |
| `IncompleteResultError` | A structured run exhausted its repair budget without a valid payload. Its `usage` includes every unsuccessful repair turn.                      |
| `TurnError`             | The engine reported a terminal turn error, such as a provider failure or abort. The original error is `cause`. The reconciled usage is `usage`. |
| `CredentialError`       | Credential configuration is unsafe or malformed (e.g. `local` in production).                                                                   |
| `ExtensionError`        | A supplied Pi extension failed to load or registered a colliding tool. Raised before any model request. The original error is `cause`.          |
| `NotImplementedError`   | Code called a capability that runcell declares but does not implement.                                                                          |

```ts
import { getRunUsage, getRunExecution } from 'runcell';

try {
  await agent.run({ prompt, schema });
} catch (error) {
  const usage = getRunUsage(error);
  const execution = getRunExecution(error);
  if (usage) console.log(usage.totalTokens, usage.costUsd);
  console.log(execution?.error, execution?.usage.status);
}
```

`getRunUsage(value)` returns aggregate usage from a recorded execution when
available. Otherwise it validates a value's `usage` fields before returning
`RunUsage`. For malformed or absent usage, it returns `undefined`.

`getRunExecution(value)` exposes structured errors with `kind`:
`authentication`, `rate_limit`, `provider_unavailable`, `invalid_request`,
`cancelled`, or `unknown`. `origin` distinguishes provider, credential,
sandbox, tool, extension, validation, runtime, and unknown failures. HTTP `statusCode`
and `retryAfterMs` are present only when structured evidence is available.
Recognizable error text can identify a category, but does not manufacture HTTP
metadata. Original causes remain on thrown errors, not in the report. These
categories are descriptive: rate limits and outages do not enable new retries.

Failures after session startup reject with one of Runcell's own error
classes. Runtime-created `TurnError` and `IncompleteResultError` carry the
reconciled usage directly. Runcell wraps every other rejection value (harness
errors, tool errors, caller abort reasons) in a `TurnError` that carries the
usage, with the original value unmodified as `cause`. Runcell never mutates
objects it does not own, so an externally supplied abort reason or a
third-party error (including one with its own `usage` property) is always
recovered exactly via `error.cause`. Runcell gives the same final error to
`onError` and uses it to reject the run.

`TurnError` and `IncompleteResultError` have optional `usage`: runtime-created
failures after session startup carry it, while manually constructed instances
do not receive misleading zero defaults. Option, credential, extension
initialization, and session initialization failures do not necessarily carry a
`usage` property. Once dispatch starts, `getRunExecution` and `getRunUsage`
still expose their execution report and known usage. Object-valued setup
failures keep their identity; primitive setup failures are wrapped in a
`TurnError` with the original value as `cause`. Cancellation uses a fresh
`TurnError` with the caller's abort reason as `cause`, including before session
startup. Invalid options rejected before
dispatch have no execution report.

## Schema typing helpers

```ts
type AgentSchema<TOutput = unknown> = StandardSchemaV1<unknown, TOutput>;
type InferSchemaOutput<TSchema extends AgentSchema> =
  StandardSchemaV1.InferOutput<TSchema>;
```

## Chat attachments

### `uiChatMessageAttachments(messages, options?): UIChatAttachment[]`

Returns the attachments that a run seeds for `messages`, in seeding order.
Each `path` is the same workspace path that the prompt names. Use it in host
code to find the file that a path from the model refers to.

```ts
interface UIChatAttachment {
  path: string; // "attachments/image-2.jpg"
  filename?: string; // original file part name, before sanitizing
  mediaType?: string;
  bytes: Uint8Array;
}
```

`options.maxAttachmentBytes` defaults to 20 MB. Pass the same value as the
run. The function throws the same `InvalidOptionError` as a run for a file
part that is not a data URL or that is over the limit.

## Utility exports

`normalizeFiles`, `normalizeCredentials`, `assertSafeWorkspacePath`,
`resolveSandboxConfig`, and `createSandboxProvider` expose validation and
configuration utilities used by `createAgent`.
