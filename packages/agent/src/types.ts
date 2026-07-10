import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { ExtensionFactory } from '@local/harness-pi-raw';
import type { Credentials } from './credentials.js';
import type { FileInput } from './files.js';
import type { SandboxOption } from './sandbox.js';
import type { Sandbox } from './sandbox-handle.js';
import type { Thread } from './thread.js';

/**
 * A host-side tool the agent can call. The result is returned to the model.
 */
export type AgentSchema<TOutput = unknown> = StandardSchemaV1<unknown, TOutput>;
export type InferSchemaOutput<TSchema extends AgentSchema> =
  StandardSchemaV1.InferOutput<TSchema>;

export interface ToolDefinition<TSchema extends AgentSchema = AgentSchema> {
  description: string;
  schema: TSchema;
  /** May return synchronously or as a promise. */
  execute(input: InferSchemaOutput<TSchema>): unknown;
}

/**
 * A file created or modified by the agent inside the sandbox workspace.
 */
export interface ChangedFile {
  path: string;
  /** `create` for new files, `modify` for edits to pre-existing files. */
  change: 'create' | 'modify';
  bytes: Uint8Array;
}

export interface ToolCallEvent {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultEvent {
  id: string;
  name: string;
  output: unknown;
}

export interface RepairEvent {
  attempt: number;
  reason: string;
}

export interface FinishEvent {
  sessionId: string;
  finishReason: string;
}

/**
 * Streaming + lifecycle callbacks. All are optional and best-effort: a
 * throwing callback is swallowed and never affects the run.
 */
export interface AgentEvents {
  onText?: (text: string) => void;
  onToolCall?: (call: ToolCallEvent) => void;
  onToolResult?: (result: ToolResultEvent) => void;
  onFileChange?: (file: ChangedFile) => void;
  onRepair?: (info: RepairEvent) => void;
  onFinish?: (info: FinishEvent) => void;
  onError?: (error: unknown) => void;
}

/**
 * Pi engine escape hatch. Everything here is engine-specific surface that
 * tracks Pi's own versioning rather than runcell's core stability promise.
 */
export interface PiOptions {
  /**
   * Explicit, trusted Pi SDK extensions, loaded in array order before the
   * model is resolved. Extensions run in the host process with full
   * application permissions — the import is the trust decision. Tools they
   * register are activated automatically. A factory that fails to load
   * rejects the run with {@link ExtensionError}.
   */
  extensions?: readonly ExtensionFactory[];
}

/**
 * Options for {@link createAgent}.
 */
export interface AgentOptions {
  /** Model identifier, e.g. `anthropic/claude-sonnet-4-5` or `openai/gpt-5.1`. */
  model: string;
  /**
   * Persistent system prompt for this agent. Appended to the engine's
   * system prompt in the system role, re-applied on every turn, and preserved
   * across thread resumes.
   */
  systemPrompt?: string;
  /** How to obtain provider credentials. Defaults to `{ type: 'env' }`. */
  credentials?: Credentials;
  /** Host-side tools, keyed by tool name. */
  tools?: Record<string, ToolDefinition>;
  /** Lifecycle callbacks. */
  events?: AgentEvents;
  /** Where the agent runs. Defaults to `{ type: 'virtual' }`. */
  sandbox?: SandboxOption;
  /**
   * Maximum number of repair turns allowed when the agent finishes without a
   * valid `submitResult` payload. Defaults to `1`.
   */
  maxRepairs?: number;
  /** Pi engine escape hatch: extensions and other Pi-specific options. */
  pi?: PiOptions;
}

/**
 * Options shared by every {@link Agent.run} call. Without a `schema` (see
 * {@link RunOptions}) the run is a plain turn whose output is the model's text.
 */
export interface RunOptionsBase {
  /** The task prompt. */
  prompt: string;
  /** Files to seed into the workspace before the run starts. */
  files?: FileInput[];
  /**
   * Where this run executes. Pass a live {@link Sandbox} handle to reuse an
   * existing workspace you own (runcell will not destroy it), or a sandbox
   * option for an ephemeral, runcell-managed sandbox. Defaults to the
   * agent-level sandbox.
   */
  sandbox?: Sandbox | SandboxOption;
  /**
   * Conversation to continue. When provided, prior turns are replayed as
   * context and the new user + agent turns are appended to it in place.
   */
  thread?: Thread;
  /** Per-run lifecycle callbacks, invoked in addition to the agent-level ones. */
  events?: AgentEvents;
  /** Resume a previous session by id. */
  sessionId?: string;
  /** Abort signal to cancel the run. */
  signal?: AbortSignal;
}

/**
 * Options for a run with a structured output contract. The agent must satisfy
 * `schema` via the hidden `submitResult` tool, and {@link RunResult.data} is the
 * validated payload.
 */
export interface RunOptions<
  TSchema extends AgentSchema,
> extends RunOptionsBase {
  /** Schema the agent must satisfy via the hidden `submitResult` tool. */
  schema: TSchema;
}

/**
 * The result of an {@link Agent.run} call.
 */
export interface RunResult<TData> {
  /**
   * The validated structured output when a `schema` was given, otherwise
   * `undefined` (the turn's output is {@link RunResult.text}).
   */
  data: TData;
  /** The model's free-form prose. Authoritative when there is no `schema`. */
  text: string;
  /** Files created or modified during the run. */
  files: ChangedFile[];
  /** Why the final turn stopped, e.g. `"stop"`. */
  finishReason: string;
  /** The session id (for resuming). */
  sessionId: string;
}

/**
 * A streaming run. Iterate {@link StreamRun.textStream} to receive the model's
 * text as it is generated, and await {@link StreamRun.result} for the final
 * outcome. Tool calls, file changes, and other events are delivered through
 * the agent-level and per-run `events` callbacks.
 */
export interface StreamRun<TData> {
  /** The model's text output, streamed delta by delta. */
  textStream: AsyncIterable<string>;
  /** Resolves with the final result once the run completes. Always await this. */
  result: Promise<RunResult<TData>>;
}

/**
 * An agent bound to a model, credentials, tools and event callbacks.
 */
export interface Agent {
  /** Run with a structured output contract; `result.data` is validated. */
  run<TSchema extends AgentSchema>(
    options: RunOptions<TSchema>,
  ): Promise<RunResult<InferSchemaOutput<TSchema>>>;
  /** Run a plain turn; `result.text` is the output and `result.data` is undefined. */
  run(options: RunOptionsBase): Promise<RunResult<undefined>>;
  /** Stream a run with a structured output contract. */
  stream<TSchema extends AgentSchema>(
    options: RunOptions<TSchema>,
  ): StreamRun<InferSchemaOutput<TSchema>>;
  /** Stream a plain turn; `result.data` is undefined. */
  stream(options: RunOptionsBase): StreamRun<undefined>;
}
