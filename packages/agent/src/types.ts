import type { z } from 'zod';
import type { Credentials } from './credentials.js';
import type { FileInput } from './files.js';
import type { SandboxOption } from './sandbox.js';

/**
 * A host-side tool the agent can call. The result is returned to the model.
 */
export interface ToolDefinition<TSchema extends z.ZodType = z.ZodType> {
  description: string;
  schema: TSchema;
  /** May return synchronously or as a promise. */
  execute(input: z.infer<TSchema>): unknown;
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
 * Streaming + lifecycle callbacks. All are optional and best-effort.
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
 * Options for {@link createAgent}.
 */
export interface AgentOptions {
  /** Model identifier, e.g. `anthropic/claude-sonnet-4-5` or `openai/gpt-5.1`. */
  model: string;
  /** System instructions prepended to every run. */
  instructions?: string;
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
}

/**
 * Options for a single {@link Agent.run} call.
 */
export interface RunOptions<TSchema extends z.ZodType> {
  /** The task prompt. */
  prompt: string;
  /** Schema the agent must satisfy via the hidden `submitResult` tool. */
  schema: TSchema;
  /** Files to seed into the workspace before the run starts. */
  files?: FileInput[];
  /** Per-run instructions appended to the agent-level instructions. */
  instructions?: string;
  /** Resume a previous session by id. */
  sessionId?: string;
  /** Abort signal to cancel the run. */
  signal?: AbortSignal;
}

/**
 * The result of an {@link Agent.run} call.
 */
export interface RunResult<TData> {
  /** The validated structured output (authoritative). */
  data: TData;
  /** The model's free-form prose (non-authoritative). */
  text: string;
  /** Files created or modified during the run. */
  files: ChangedFile[];
  /** The session id (for resuming). */
  sessionId: string;
}

/**
 * An agent bound to a model, credentials, tools and event callbacks.
 */
export interface Agent {
  run<TSchema extends z.ZodType>(
    options: RunOptions<TSchema>,
  ): Promise<RunResult<z.infer<TSchema>>>;
}
