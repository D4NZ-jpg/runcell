# Changelog

All notable changes to `runcell` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Fixed

- Fixed Next.js/Turbopack (and webpack) builds failing with
  `Module not found: Can't resolve '@ai-sdk/sandbox-vercel'` when the
  optional Vercel sandbox is not installed: the optional-provider import is
  now opaque to static analysis and only resolved at runtime. Also documented
  `serverExternalPackages: ['runcell']` for Next.js consumers.

## 1.1.0 - 2026-07-16

### Added

- Added `toolContent()` for host tools that return multi-part text and image
  results. Image bytes are validated and normalized to base64 before Pi sends
  real image blocks to the model; tool-result events expose the normalized,
  JSON-safe content array.
- Added configurable model reasoning effort through `pi.thinkingLevel`, with a
  per-run override that takes precedence over the agent-level default.

### Fixed

- Fixed virtual-sandbox runs failing at session startup (`cd: no such file or
directory`): just-bash ignores the per-run `env` option, so the harness's
  workspace bootstrap silently no-oped. Env vars are now inlined into the
  command as `export` prefixes.

## 1.0.1 - 2026-07-15

### Changed

- Upgraded the AI SDK harness and sandbox integrations from beta releases to
  the stable `1.0.33` line.

## 1.0.0 - 2026-07-14

Initial stable public release.

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
