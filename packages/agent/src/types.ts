import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { ExtensionFactory, PiThinkingLevel } from '@local/harness-pi-raw';
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
  /**
   * May return synchronously or as a promise. Return `toolContent([...])` to
   * send multi-part text and images to the model; other values are serialized
   * as JSON as usual. Images are limited to approximately 5 MB each. If the
   * model does not support vision, the provider error is reported via
   * `onError`.
   */
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
  /**
   * The tool's original output, or for `toolContent` results, the normalized
   * JSON-safe content array with base64 image data.
   */
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
  /**
   * Reasoning/thinking effort for the model. Pi maps this to each provider's
   * native knob (Anthropic thinking budget, OpenAI reasoning_effort) and
   * clamps to what the model supports. Defaults to Pi's default for the
   * model.
   */
  thinkingLevel?: PiThinkingLevel;
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
 * One message of a UI chat history, structurally compatible with the AI SDK
 * `UIMessage` shape. Text is read from `parts` entries of type `text`, with
 * a plain `content` string accepted as a fallback. `file` parts on the last
 * user message are seeded into the run workspace as files under
 * `attachments/`; their `url` must be a data URL.
 */
export interface UIChatMessage {
  role: 'system' | 'user' | 'assistant';
  parts?: readonly {
    type: string;
    text?: string;
    url?: string;
    mediaType?: string;
    filename?: string;
  }[];
  content?: string;
}

/**
 * Options shared by every {@link Agent.run} call. Without a `schema` (see
 * {@link RunOptions}) the run is a plain turn whose output is the model's text.
 */
export interface RunOptionsBase {
  /**
   * The task prompt. Provide either `prompt` or `messages`, not both.
   */
  prompt?: string;
  /**
   * A UI chat history in the AI SDK `UIMessage` shape (as POSTed by
   * `useChat` and assistant-ui's `useChatRuntime`). The last message must be
   * a user message; it becomes the prompt, and earlier user/assistant turns
   * are replayed as conversation context. Provide either `messages` or
   * `prompt`, not both.
   */
  messages?: readonly UIChatMessage[];
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
  /**
   * Per-run Pi engine overrides, merged over the agent-level `pi` options.
   * `extensions` intentionally stays agent-level: extensions are loaded once
   * per agent, not per run.
   */
  pi?: Pick<PiOptions, 'thinkingLevel'>;
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
 * Token usage and estimated cost for a single {@link Agent.run} call,
 * accumulated across every model turn in the run (including repair turns).
 * Available on successful results and measurable failures after a session
 * starts.
 */
export interface RunUsage {
  /** Non-cached input (prompt) tokens billed at the input rate. */
  inputTokens: number;
  /** Output (completion) tokens, including reasoning tokens. */
  outputTokens: number;
  /** Input tokens read from the provider's prompt cache. */
  cacheReadTokens: number;
  /** Input tokens written to the provider's prompt cache. */
  cacheWriteTokens: number;
  /** Sum of all token buckets above. */
  totalTokens: number;
  /**
   * Estimated cost in US dollars at the model's published API list price
   * (sourced from the models.dev-derived catalog, including tiered pricing).
   * This is the as-if-API price even when the run used subscription (OAuth)
   * credentials. `0` when the catalog has no pricing for the model — check
   * {@link RunUsage.costMeasured} to distinguish that case from genuinely
   * free usage.
   */
  costUsd: number;
  /**
   * Whether `costUsd` is a real measurement. `false` when the run consumed
   * tokens but no cost could be attributed — in practice, when the catalog
   * has no (nonzero) pricing for the model — so a `costUsd` of `0` should
   * be treated as “unpriced”, not “free”. Always `true` when `costUsd > 0`
   * or the run consumed no tokens.
   */
  costMeasured: boolean;
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
  /** Token usage and estimated cost for this run. */
  usage: RunUsage;
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
  /**
   * The run as AI SDK UI Message Stream chunks: text and reasoning deltas,
   * tool calls and results, step boundaries per model turn, and a final
   * `finish` chunk carrying {@link RunUsage} in `messageMetadata`. Failures
   * end the stream with an `error` chunk instead of throwing here. Consume
   * the UI message stream at most once per run, through either this method
   * or {@link StreamRun.toUIMessageStreamResponse}.
   */
  toUIMessageStream(
    options?: UIMessageStreamOptions,
  ): AsyncIterable<UIMessageChunk>;
  /**
   * The run as a UI Message Stream SSE `Response` — the wire format consumed
   * by AI SDK's `useChat` and assistant-ui's `useChatRuntime`. Return it
   * directly from a route handler.
   */
  toUIMessageStreamResponse(
    options?: UIMessageStreamOptions & ResponseInit,
  ): Response;
}

/**
 * Wire-level controls for the UI message stream, mirroring the AI SDK's
 * `toUIMessageStreamResponse` options. These decide what leaves the server;
 * hiding data in the frontend is not redaction — anything sent is visible in
 * the browser's network inspector.
 */
export interface UIMessageStreamOptions {
  /** Stream the model's reasoning to the client. Defaults to `true`. */
  sendReasoning?: boolean;
  /**
   * What tool activity crosses the wire. `true` (default) sends names,
   * inputs, and outputs; `'names-only'` sends the chunks with `null`
   * payloads, so the UI shows which tool ran but not its data; `false`
   * hides tool activity entirely. A record applies a policy per tool name
   * (`true`, `'names-only'`, or `false`); unlisted tools default to `true`.
   */
  sendTools?: boolean | 'names-only' | Record<string, boolean | 'names-only'>;
  /**
   * Map a failed run to the `error` chunk's text. Defaults to a constant
   * `"An error occurred."` so server error details never reach the client
   * unless explicitly opted into — the same default as the AI SDK.
   */
  onError?: (error: unknown) => string;
}

/**
 * A chunk of the AI SDK UI Message Stream protocol, the wire format consumed
 * by AI SDK's `useChat` and assistant-ui's `useChatRuntime`. Runcell emits
 * the subset below; the type is structural, so no `ai` dependency is needed.
 */
export type UIMessageChunk =
  | { type: 'start'; messageId?: string }
  | { type: 'start-step' }
  | { type: 'finish-step' }
  | { type: 'text-start'; id: string }
  | { type: 'text-delta'; id: string; delta: string }
  | { type: 'text-end'; id: string }
  | { type: 'reasoning-start'; id: string }
  | { type: 'reasoning-delta'; id: string; delta: string }
  | { type: 'reasoning-end'; id: string }
  | {
      type: 'tool-input-available';
      toolCallId: string;
      toolName: string;
      input: unknown;
    }
  | { type: 'tool-output-available'; toolCallId: string; output: unknown }
  | {
      type: 'finish';
      messageMetadata?: { usage: RunUsage; sessionId: string };
    }
  | { type: 'message-metadata'; messageMetadata: { usage: RunUsage } }
  | { type: 'error'; errorText: string };

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
