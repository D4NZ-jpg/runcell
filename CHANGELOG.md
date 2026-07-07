# Changelog

All notable changes to `runcell` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.1.0

Initial public release.

### Requirements

- Node.js 22 or newer.

### Agent

- `createAgent({ model, credentials, instructions, tools, events, sandbox, maxRepairs })`
  returns a stateless agent.
- `agent.run(options)` runs a task to completion. With a `schema`, `result.data`
  is validated and typed; without one, the run is a plain turn whose output is
  `result.text`.
- `agent.stream(options)` returns `{ textStream, result }` for streaming the
  model's text while awaiting the final result.
- `RunResult` carries `data`, `text`, `files`, and `finishReason`.

### Structured output

- Schemas use [Standard Schema](https://standardschema.dev), so Zod 3.24+,
  Zod 4, Valibot, ArkType, and others all work with no version lock-in.
- The agent must submit a payload satisfying the schema; runcell validates it,
  runs repair turns when the model misses (`maxRepairs`), and rejects with
  `IncompleteResultError` rather than returning unvalidated data.

### Sandboxes

- Every run executes in an isolated workspace. The virtual sandbox is bundled;
  `host`, `vercel` (optional `@ai-sdk/sandbox-vercel` peer), and `custom`
  providers are also supported.
- `createVirtualSandbox()` returns a caller-owned `Sandbox` handle with
  `exec`, `readFile`/`readTextFile`, `writeFile`, `remove`, `snapshot`, `lock`,
  and `destroy`. A handle passed to `run` is reused and never destroyed by
  runcell.
- `restoreSandbox(snapshot)` rehydrates a portable file snapshot into a fresh
  sandbox.

### Threads

- `createThread()` / `threadFromJSON(state)` give runs conversation memory as a
  plain, serializable value.
- A thread carries a readable `messages` log plus opaque continuation state, so
  a conversation resumes in any sandbox, in any process, on any machine.
- `thread.clone()` forks a conversation; `thread.toJSON()` persists it.

### Files, tools, and events

- Seed text or binary files into the workspace; receive changed files back as
  bytes on `result.files`.
- Register host-side tools the agent can call, validated by a Standard Schema.
- Lifecycle callbacks: `onText`, `onToolCall`, `onToolResult`, `onFileChange`,
  `onRepair`, `onFinish`, `onError`.

### Credentials

- Modes: `env` (default), `local`, explicit API keys, agent directory, and a
  shared lockable credential store. Local credentials are refused in production
  unless explicitly allowed.

### Models

- `model` accepts an id, a display name, or a provider-qualified id
  (e.g. `openai-codex/gpt-5.5`) to disambiguate an id offered by several
  providers.
