# API reference

The public API is exported from the `runcell` entrypoint.

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

| Option         | Type                             | Description                                                                                 |
| -------------- | -------------------------------- | ------------------------------------------------------------------------------------------- |
| `model`        | `string`                         | Model id, display name, or provider-qualified id (`openai-codex/gpt-5.5`). Required.        |
| `systemPrompt` | `string`                         | Persistent system prompt: system role, re-applied every turn, survives thread resume.       |
| `credentials`  | `Credentials`                    | Credential source. Defaults to `{ type: 'env' }`. See [Credentials](./credentials.md).      |
| `tools`        | `Record<string, ToolDefinition>` | Host functions the agent can call. See [Files, tools, and events](./files-tools-events.md). |
| `events`       | `AgentEvents`                    | Lifecycle callbacks.                                                                        |
| `sandbox`      | `SandboxOption`                  | Agent-level default sandbox mode. Defaults to `'virtual'`.                                  |
| `maxRepairs`   | `number`                         | Repair-turn budget for structured runs. Defaults to `1`.                                    |
| `pi`           | `PiOptions`                      | Pi engine escape hatch. See [Pi extensions](./pi-extensions.md).                            |

## `agent.run(options)`

Two overloads:

```ts
// with a schema: result.data is validated and typed
run<TSchema extends AgentSchema>(options: RunOptions<TSchema>): Promise<RunResult<InferSchemaOutput<TSchema>>>;

// without: a plain turn, result.data is undefined
run(options: RunOptionsBase): Promise<RunResult<undefined>>;
```

### Run options

| Option      | Type                       | Description                                                                                        |
| ----------- | -------------------------- | -------------------------------------------------------------------------------------------------- |
| `prompt`    | `string`                   | The task prompt. Required.                                                                         |
| `schema`    | `AgentSchema`              | Structured output contract ([Standard Schema](https://standardschema.dev)). Omit for a plain turn. |
| `files`     | `FileInput[]`              | Files seeded into the workspace before the run. Relative paths only.                               |
| `sandbox`   | `Sandbox \| SandboxOption` | A caller-owned handle that Runcell does not destroy, or an ephemeral mode option.                  |
| `thread`    | `Thread`                   | Conversation to continue; mutated in place on success.                                             |
| `events`    | `AgentEvents`              | Per-run lifecycle callbacks, invoked in addition to the agent-level ones.                          |
| `sessionId` | `string`                   | Resume a previous session by id.                                                                   |
| `signal`    | `AbortSignal`              | Cancels the run.                                                                                   |

### `RunResult<TData>`

| Field          | Type            | Description                                                           |
| -------------- | --------------- | --------------------------------------------------------------------- |
| `data`         | `TData`         | Validated structured output, or `undefined` when no schema was given. |
| `text`         | `string`        | The model's prose and the output for plain turns.                     |
| `files`        | `ChangedFile[]` | Files created/modified during this run (`{ path, change, bytes }`).   |
| `finishReason` | `string`        | Why the final turn stopped, e.g. `"stop"`.                            |
| `sessionId`    | `string`        | Identifier of the underlying run session.                             |

## `agent.stream(options): StreamRun`

Same options and overloads as `run`, returned as a live stream plus a promise:

```ts
const { textStream, result } = agent.stream({ prompt, thread });
for await (const delta of textStream) push(delta);
const final = await result; // always await this
```

| Field        | Type                    | Description                                        |
| ------------ | ----------------------- | -------------------------------------------------- |
| `textStream` | `AsyncIterable<string>` | The model's text deltas.                           |
| `result`     | `Promise<RunResult>`    | Final result; rejects on failure. Always await it. |

## Sandboxes

### `createVirtualSandbox(options?): Promise<Sandbox>`

Creates a caller-owned in-memory sandbox. `options.env` sets environment
variables for every command.

### `restoreSandbox(snapshot, options?): Promise<Sandbox>`

Creates a fresh virtual sandbox and writes a snapshot's files back into it.
The snapshot is validated before the sandbox is created. Escaping paths,
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
| `remove(path)`          | Removes a file or directory; no-op when missing.                                      |
| `snapshot()`            | Portable, JSON-serializable capture of workspace **files** (`SandboxSnapshot`).       |
| `exposeUrl?(port)`      | Public URL for a port. Present only when `capabilities.ports` is `true`.              |
| `lock(key, fn)`         | Opt-in mutex, serialized per key on this handle.                                      |
| `destroy()`             | Dispose the sandbox. Idempotent; later operations throw. Only the caller does this.   |

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

See [Sandboxes](./sandboxes.md) for semantics; `vercel` requires the optional
`@ai-sdk/sandbox-vercel` peer dependency and Node.js 22+.

### `SandboxProvider`

The provider interface accepted by `{ type: 'custom' }`: an object with
`specificationVersion: 'harness-sandbox-v1'`, a `providerId`, and a
`createSession()` method. Existing providers from the `@ai-sdk/sandbox-*`
family satisfy it directly.

## Threads

### `createThread(options?): Thread`

New empty conversation. `options.id` sets a stable id (defaults to a UUID).

### `threadFromJSON(state): Thread`

Rebuilds a thread from a persisted `ThreadState`.

### `Thread`

| Member     | Description                                             |
| ---------- | ------------------------------------------------------- |
| `id`       | Conversation id.                                        |
| `messages` | `readonly ThreadMessage[]`: the readable turn log.      |
| `clone()`  | Deep, independent copy (fork the conversation).         |
| `toJSON()` | `ThreadState`: plain JSON-safe value; persist anywhere. |

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
`submitResult`, `fileChange`.

## Events (`AgentEvents`)

The optional callbacks are `onText`, `onToolCall`, `onToolResult`,
`onFileChange`, `onRepair`, `onFinish`, and `onError`. Callbacks registered at
the agent and run levels both fire. See
[Files, tools, and events](./files-tools-events.md).

## Files

```ts
type FileInput =
  | { path: string; text: string }
  | { path: string; bytes: Uint8Array };
```

Paths must be relative workspace paths (no absolute paths, no `..`).

## Errors

All runcell errors extend `RuncellError`:

| Error                   | Thrown when                                                                                                                            |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `InvalidOptionError`    | Options are malformed (bad sandbox option, reserved tool name, foreign thread…).                                                       |
| `IncompleteResultError` | A structured run exhausted its repair budget without a valid payload.                                                                  |
| `TurnError`             | The engine reported a terminal turn error, such as a provider failure or abort. The original error is available as `cause`.            |
| `CredentialError`       | Credential configuration is unsafe or malformed (e.g. `local` in production).                                                          |
| `ExtensionError`        | A supplied Pi extension failed to load or registered a colliding tool. Raised before any model request; the original error is `cause`. |
| `NotImplementedError`   | A declared-but-unavailable capability was invoked.                                                                                     |

## Schema typing helpers

```ts
type AgentSchema<TOutput = unknown> = StandardSchemaV1<unknown, TOutput>;
type InferSchemaOutput<TSchema extends AgentSchema> =
  StandardSchemaV1.InferOutput<TSchema>;
```

## Utility exports

`normalizeFiles`, `normalizeCredentials`, `assertSafeWorkspacePath`,
`resolveSandboxConfig`, and `createSandboxProvider` expose validation and
configuration utilities used by `createAgent`.
