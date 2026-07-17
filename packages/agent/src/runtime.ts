import {
  HarnessAgent,
  type HarnessAgentResumeSessionState,
} from '@ai-sdk/harness/agent';
import type { HarnessV1NetworkSandboxSession } from '@ai-sdk/harness';
import { shellQuote } from './shell.js';
import { gzipSync, gunzipSync } from 'node:zlib';
import {
  asSchema,
  jsonSchema,
  tool,
  type Experimental_SandboxSession,
  type FlexibleSchema,
  type ToolSet,
} from '@ai-sdk/provider-utils';
import type {
  StandardJSONSchemaV1,
  StandardSchemaV1,
} from '@standard-schema/spec';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import {
  createPi,
  PI_SILENT_TURN_ABORT_REASON,
  type PiCredentialStore,
  type PiHarnessSettings,
  type PiThinkingLevel,
} from '@local/harness-pi-raw';
import path from 'node:path';
import type { ResolvedAgentConfig } from './create-agent.js';
import type { AuthBlob, CredentialStore } from './credentials.js';
import { ExtensionError, IncompleteResultError, TurnError } from './errors.js';
import { normalizeFiles, type NormalizedFile } from './files.js';
import { assertSafeWorkspacePath } from './paths.js';
import {
  createSandboxProvider,
  resolveSandboxConfig,
  type SandboxProvider,
} from './sandbox.js';
import {
  createReusedSandboxProvider,
  getSandboxInternals,
} from './sandbox-handle.js';
import {
  appendThreadMessage,
  getThreadInternals,
  renderThreadContext,
  type ThreadContinuation,
} from './thread.js';
import type {
  AgentEvents,
  AgentOptions,
  AgentSchema,
  ChangedFile,
  InferSchemaOutput,
  RunOptionsBase,
  RunResult,
  ToolDefinition,
} from './types.js';

type RuntimeRunOptions = RunOptionsBase & { schema?: AgentSchema };

export interface RuntimeRunInput {
  agentOptions: AgentOptions;
  config: ResolvedAgentConfig;
  runOptions: RuntimeRunOptions;
  /** Optional sink for streamed text deltas (used by `agent.stream`). */
  onTextDelta?: (delta: string) => void;
}

export interface RuncellRuntime {
  run(input: RuntimeRunInput): Promise<RunResult<unknown>>;
}

interface SandboxContext {
  session: Experimental_SandboxSession;
  workDir: string;
}

export const defaultRuntime: RuncellRuntime = {
  async run(input) {
    try {
      return await runWithHarness(input);
    } catch (error) {
      const extensionError = findPiExtensionError(error);
      if (extensionError) {
        throw new ExtensionError(extensionError.message, { cause: error });
      }
      throw error;
    }
  },
};

/**
 * Find a harness `PiExtensionError` anywhere in an error's cause chain. The
 * harness may surface it directly (session init) or wrapped in a turn error
 * (tool-collision check on the first turn).
 */
function findPiExtensionError(error: unknown): Error | undefined {
  let current: unknown = error;
  while (current instanceof Error) {
    if (current.name === 'PiExtensionError') {
      return current;
    }
    current = current.cause;
  }
  return undefined;
}

async function runWithHarness({
  agentOptions,
  config,
  runOptions,
  onTextDelta,
}: RuntimeRunInput): Promise<RunResult<unknown>> {
  const files = normalizeFiles(runOptions.files ?? []);
  const changedFiles = new Map<string, ChangedFile>();
  let text = '';
  let finishReason = 'stop';
  let sandboxContext: SandboxContext | undefined;
  const submission: { hasValue: boolean; data: unknown } = {
    hasValue: false,
    data: undefined,
  };
  let activeTurnAbortController: AbortController | undefined;

  const schema = runOptions.schema;
  const events = mergeEvents(agentOptions.events, runOptions.events);
  const threadInternals = getThreadInternals(runOptions.thread);
  let succeeded = false;

  const tools = createTools({
    tools: agentOptions.tools,
    schema,
    onSubmit: data => {
      // A caller cancellation that wins the race stays authoritative. If the
      // validated submission arrived first, preserve it and stop only the
      // active Pi turn with the adapter's silent terminal reason.
      if (runOptions.signal?.aborted || submission.hasValue) {
        return;
      }
      submission.data = data;
      submission.hasValue = true;
      activeTurnAbortController?.abort(PI_SILENT_TURN_ABORT_REASON);
    },
  });

  const {
    provider: baseProvider,
    sessionId: pinnedSessionId,
    ownsSandbox,
  } = resolveRunSandbox({ config, runOptions });

  // A thread carries its own compressed journal, so it can resume the exact
  // conversation in any sandbox. Without one, fall back to neutral replay.
  const continuation = readPiContinuation(threadInternals?.continuation);
  const resumeFrom = continuation?.resume;
  const threadContext =
    threadInternals && continuation === undefined
      ? renderThreadContext(threadInternals.messages)
      : undefined;

  // Capture the network session so an owned sandbox can be disposed after the
  // journal is flushed on detach.
  let sandboxSession: HarnessV1NetworkSandboxSession | undefined;
  const sandboxProvider = withSessionCapture(baseProvider, captured => {
    sandboxSession = captured;
  });

  const harnessAgent = new HarnessAgent({
    id: 'runcell',
    harness: createPi(createPiSettings(config, runOptions.pi?.thinkingLevel)),
    sandbox: sandboxProvider,
    permissionMode: 'allow-all',
    instructions: schema
      ? 'When the task is complete, call submitResult with the structured result.'
      : '',
    tools,
    sandboxConfig: {
      onSession: async ({ session, sessionWorkDir, abortSignal }) => {
        sandboxContext = { session, workDir: sessionWorkDir };
        // Re-materialize the journal before Pi starts so a fresh sandbox resumes.
        if (continuation) {
          await writeJournal({
            session,
            workDir: sessionWorkDir,
            continuation,
            abortSignal,
          });
        }
        await seedFiles({
          session,
          workDir: sessionWorkDir,
          files,
          abortSignal,
        });
      },
    },
  });

  // A caller-owned sandbox pins the session id so every run shares one
  // workspace directory; the continuation's own id only decides where an
  // ephemeral sandbox resumes.
  const sessionId =
    pinnedSessionId ??
    (continuation ? continuationSessionId(continuation) : undefined);
  const session = await harnessAgent.createSession({
    ...(sessionId ? { sessionId } : {}),
    ...(resumeFrom ? { resumeFrom } : {}),
    ...(runOptions.signal ? { abortSignal: runOptions.signal } : {}),
  });

  try {
    const maxAttempts = schema ? config.maxRepairs : 0;
    for (let attempt = 0; attempt <= maxAttempts; attempt += 1) {
      finishReason = 'stop';
      const turnFinishState = { emitted: false };

      if (attempt > 0) {
        safeEmit(events?.onRepair, {
          attempt,
          reason: 'missing or invalid structured result',
        });
      }

      const turnAbortController = new AbortController();
      const turnAbortSignal = runOptions.signal
        ? AbortSignal.any([runOptions.signal, turnAbortController.signal])
        : turnAbortController.signal;
      activeTurnAbortController = turnAbortController;

      let streamError: { cause: unknown } | undefined;
      let streamThrown: unknown;
      let didStreamThrow = false;
      try {
        const result = await harnessAgent.stream({
          session,
          prompt:
            attempt === 0
              ? joinSections(threadContext, runOptions.prompt)
              : 'Call submitResult now with a valid structured result for the previous task.',
          abortSignal: turnAbortSignal,
        });

        for await (const part of result.stream) {
          await handleStreamPart({
            part,
            events,
            sandboxContext,
            changedFiles,
            abortSignal: runOptions.signal,
            sessionId: session.sessionId,
            appendText(delta) {
              text += delta;
              onTextDelta?.(delta);
            },
            setFinishReason(reason) {
              finishReason = reason;
              turnFinishState.emitted = true;
            },
            setStreamError(cause) {
              streamError ??= { cause };
            },
          });
        }
      } catch (error) {
        streamThrown = error;
        didStreamThrow = true;
      } finally {
        // Do not let a callback from this completed attempt cancel a repair.
        if (activeTurnAbortController === turnAbortController) {
          activeTurnAbortController = undefined;
        }
      }

      // A submission takes precedence over trailing abort, timeout, or
      // transport failures. submitResult.execute already validated and
      // transformed this exact accepted output.
      if (schema !== undefined && submission.hasValue) {
        if (!turnFinishState.emitted) {
          safeEmit(events?.onFinish, {
            sessionId: session.sessionId,
            finishReason,
          });
        }
        recordThreadTurn(
          threadInternals,
          runOptions.prompt,
          text,
          submission.data,
        );
        succeeded = true;
        return {
          data: submission.data,
          text,
          files: [...changedFiles.values()],
          finishReason,
          sessionId: session.sessionId,
        };
      }

      if (didStreamThrow) {
        throw streamThrown;
      }

      // Terminal for the turn: fail the run with the real error instead of
      // dissolving into an empty result. Thrown after the stream drains so
      // the iterator closes cleanly.
      if (streamError) {
        const { cause } = streamError;
        throw new TurnError(
          cause instanceof Error ? cause.message : String(cause),
          { cause },
        );
      }

      // No schema: the turn's text is the output; return after one turn.
      if (schema === undefined) {
        recordThreadTurn(threadInternals, runOptions.prompt, text, undefined);
        succeeded = true;
        return {
          data: undefined,
          text,
          files: [...changedFiles.values()],
          finishReason,
          sessionId: session.sessionId,
        };
      }
    }

    throw new IncompleteResultError(
      'Agent finished without submitting a valid structured result.',
    );
  } catch (error) {
    safeEmit(events?.onError, error);
    throw error;
  } finally {
    const ownedSandbox = ownsSandbox ? sandboxSession : undefined;
    if (succeeded && threadInternals) {
      // Flush Pi's journal into the sandbox (leaves it running) and capture
      // it into the thread. The continuation is cleared up front so a failed
      // capture leaves neutral replay rather than a stale journal, and an
      // owned sandbox is disposed regardless of how the capture went.
      threadInternals.continuation = undefined;
      await bestEffort(async () => {
        const resume = await session.detach();
        const journalGz = await readJournal(sandboxContext, resume);
        if (journalGz) {
          threadInternals.continuation = { engine: 'pi', resume, journalGz };
        }
      });
      if (ownedSandbox) {
        await bestEffort(() => disposeSandbox(ownedSandbox));
      }
    } else {
      await bestEffort(() => session.destroy());
    }
  }
}

/** Teardown is best-effort: a failure only degrades the next run. */
async function bestEffort(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch {
    // Intentionally swallowed.
  }
}

/** Combine agent-level and per-run callbacks; each side stays best-effort. */
function mergeEvents(
  agent: AgentEvents | undefined,
  run: AgentEvents | undefined,
): AgentEvents | undefined {
  if (!agent || !run) {
    return agent ?? run;
  }
  // Field list must track AgentEvents; a missing key would silently drop
  // that callback's run-level side.
  const both =
    <TArgs extends unknown[]>(
      a: ((...args: TArgs) => void) | undefined,
      b: ((...args: TArgs) => void) | undefined,
    ) =>
    (...args: TArgs) => {
      safeEmit(a, ...args);
      safeEmit(b, ...args);
    };
  return {
    onText: both(agent.onText, run.onText),
    onToolCall: both(agent.onToolCall, run.onToolCall),
    onToolResult: both(agent.onToolResult, run.onToolResult),
    onFileChange: both(agent.onFileChange, run.onFileChange),
    onRepair: both(agent.onRepair, run.onRepair),
    onFinish: both(agent.onFinish, run.onFinish),
    onError: both(agent.onError, run.onError),
  };
}

/**
 * Invoke an event callback per the {@link AgentEvents} contract: callbacks are
 * best-effort, so a throwing listener never breaks the run.
 */
function safeEmit<TArgs extends unknown[]>(
  listener: ((...args: TArgs) => void) | undefined,
  ...args: TArgs
): void {
  try {
    const result = listener?.(...args) as unknown;
    if (result instanceof Promise) {
      // An async listener is still best-effort: observe its rejection so it
      // cannot surface as an unhandled rejection.
      void result.catch(() => undefined);
    }
  } catch {
    // Intentionally swallowed.
  }
}

interface PiContinuation {
  engine: 'pi';
  resume: HarnessAgentResumeSessionState;
  journalGz: string;
}

/**
 * Read a Pi continuation from a thread's opaque state, or `undefined` when
 * absent or malformed. Exported for testing.
 */
export function readPiContinuation(
  continuation: ThreadContinuation | undefined,
): PiContinuation | undefined {
  if (
    continuation?.engine === 'pi' &&
    typeof continuation.journalGz === 'string' &&
    continuation.resume != null
  ) {
    return {
      engine: 'pi',
      resume: continuation.resume as HarnessAgentResumeSessionState,
      journalGz: continuation.journalGz,
    };
  }
  return undefined;
}

function continuationSessionId(
  continuation: PiContinuation,
): string | undefined {
  const sessionId = (continuation.resume as { sessionId?: unknown }).sessionId;
  return typeof sessionId === 'string' ? sessionId : undefined;
}

function journalPath(
  workDir: string,
  resume: HarnessAgentResumeSessionState,
): string | undefined {
  const sessionFileName = (resume as { data?: { sessionFileName?: unknown } })
    .data?.sessionFileName;
  return typeof sessionFileName === 'string'
    ? `${workDir}/.pi-sessions/${sessionFileName}`
    : undefined;
}

async function writeJournal({
  session,
  workDir,
  continuation,
  abortSignal,
}: {
  session: Experimental_SandboxSession;
  workDir: string;
  continuation: PiContinuation;
  abortSignal?: AbortSignal;
}): Promise<void> {
  const path = journalPath(workDir, continuation.resume);
  if (!path) {
    return;
  }
  await session.writeBinaryFile({
    path,
    content: gunzipFromBase64(continuation.journalGz),
    ...(abortSignal ? { abortSignal } : {}),
  });
}

async function readJournal(
  sandboxContext: SandboxContext | undefined,
  resume: HarnessAgentResumeSessionState,
): Promise<string | undefined> {
  if (!sandboxContext) {
    return undefined;
  }
  const path = journalPath(sandboxContext.workDir, resume);
  if (!path) {
    return undefined;
  }
  const bytes = await sandboxContext.session.readBinaryFile({ path });
  return bytes ? gzipToBase64(bytes) : undefined;
}

async function disposeSandbox(
  session: HarnessV1NetworkSandboxSession,
): Promise<void> {
  if (session.destroy) {
    await session.destroy();
  } else {
    await session.stop();
  }
}

/**
 * Wrap a provider so it exposes `resumeSession` (falling back to a fresh
 * session) and reports each network session it hands out.
 */
function withSessionCapture(
  provider: SandboxProvider,
  onSession: (session: HarnessV1NetworkSandboxSession) => void,
): SandboxProvider {
  return {
    specificationVersion: 'harness-sandbox-v1',
    providerId: provider.providerId,
    createSession: async options => {
      const session = await provider.createSession(options);
      onSession(session);
      return session;
    },
    resumeSession: async options => {
      const session = provider.resumeSession
        ? await provider.resumeSession(options)
        : await provider.createSession(options);
      onSession(session);
      return session;
    },
  };
}

function gzipToBase64(bytes: Uint8Array): string {
  return gzipSync(bytes).toString('base64');
}

function gunzipFromBase64(data: string): Uint8Array {
  return new Uint8Array(gunzipSync(Buffer.from(data, 'base64')));
}

/**
 * Choose the sandbox provider and session id for a run. A live sandbox handle
 * is reused (its lifecycle stays with the caller) and pins a stable session id
 * so repeated runs share the same workspace; otherwise a provider is created
 * from the per-run or agent-level sandbox option.
 */
export function resolveRunSandbox({
  config,
  runOptions,
}: {
  config: ResolvedAgentConfig;
  runOptions: RuntimeRunOptions;
}): {
  provider: SandboxProvider;
  sessionId: string | undefined;
  ownsSandbox: boolean;
} {
  const reused = getSandboxInternals(runOptions.sandbox);
  if (reused) {
    return {
      provider: createReusedSandboxProvider(reused),
      sessionId: reused.sessionToken,
      ownsSandbox: false,
    };
  }

  const sandboxConfig =
    runOptions.sandbox !== undefined
      ? resolveSandboxConfig(runOptions.sandbox)
      : config.sandbox;
  return {
    provider: createSandboxProvider(sandboxConfig),
    sessionId: runOptions.sessionId,
    ownsSandbox: true,
  };
}

function recordThreadTurn(
  threadInternals: ReturnType<typeof getThreadInternals>,
  prompt: string,
  text: string,
  data: unknown,
): void {
  if (!threadInternals) {
    return;
  }
  appendThreadMessage(threadInternals, { role: 'user', content: prompt });
  appendThreadMessage(threadInternals, { role: 'agent', content: text, data });
}

function createTools({
  tools,
  schema,
  onSubmit,
}: {
  tools: AgentOptions['tools'];
  schema: AgentSchema | undefined;
  onSubmit: (value: unknown) => void;
}): ToolSet {
  const out: ToolSet = {};

  for (const [name, definition] of Object.entries(tools ?? {})) {
    out[name] = createHostTool(definition);
  }

  if (schema) {
    out['submitResult'] = tool({
      description: 'Submit the final structured result for this run.',
      inputSchema: toUnvalidatedToolInputSchema(schema),
      execute(input) {
        // Harness may execute a parsed tool call even when it marked the call
        // invalid, so inputSchema is not an enforcement boundary. Validate
        // here before accepting the terminal submission. Keep synchronous
        // schemas synchronous; async Standard Schema validators are awaited by
        // Harness before their tool result is submitted to Pi.
        const validation = schema['~standard'].validate(input);
        const accept = (result: StandardSchemaV1.Result<unknown>) => {
          if (!('value' in result)) {
            throw new Error(formatStandardSchemaIssues(result.issues));
          }
          onSubmit(result.value);
          return { ok: true };
        };
        return isPromiseLike(validation)
          ? Promise.resolve(validation).then(accept)
          : accept(validation);
      },
    });
  }

  return out;
}

function toUnvalidatedToolInputSchema<TSchema extends AgentSchema>(
  schema: TSchema,
): FlexibleSchema<InferSchemaOutput<TSchema>> {
  // Preserve the model-facing JSON Schema while leaving execute as the sole
  // user-schema validation boundary. Harness executes invalid parsed calls so
  // submitResult can report a tool error and let the model correct itself.
  const projected = asSchema(toToolInputSchema(schema));
  return jsonSchema<InferSchemaOutput<TSchema>>(() => projected.jsonSchema);
}

function isPromiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  if (
    (typeof value !== 'object' || value === null) &&
    typeof value !== 'function'
  ) {
    return false;
  }
  return typeof (value as { then?: unknown }).then === 'function';
}

function createHostTool(definition: ToolDefinition): ToolSet[string] {
  return tool({
    description: definition.description,
    inputSchema: toToolInputSchema(definition.schema),
    execute(input) {
      return definition.execute(input);
    },
  });
}

function toToolInputSchema<TSchema extends AgentSchema>(
  schema: TSchema,
): FlexibleSchema<InferSchemaOutput<TSchema>> {
  if (isZodSchema(schema) || hasStandardJsonSchema(schema)) {
    return schema;
  }

  return jsonSchema<InferSchemaOutput<TSchema>>(
    {},
    {
      validate: async value => {
        const result = await validateAgentSchema(schema, value);
        if (result.success) {
          return { success: true, value: result.data };
        }
        return {
          success: false,
          error: new Error(formatStandardSchemaIssues(result.issues)),
        };
      },
    },
  );
}

async function validateAgentSchema<TSchema extends AgentSchema>(
  schema: TSchema,
  value: unknown,
): Promise<
  | { success: true; data: InferSchemaOutput<TSchema> }
  | { success: false; issues: readonly StandardSchemaV1.Issue[] }
> {
  const result = await schema['~standard'].validate(value);
  if ('value' in result) {
    return { success: true, data: result.value as InferSchemaOutput<TSchema> };
  }
  return { success: false, issues: result.issues };
}

function isZodSchema(schema: AgentSchema): boolean {
  return schema['~standard'].vendor === 'zod';
}

function hasStandardJsonSchema(
  schema: AgentSchema,
): schema is AgentSchema & StandardJSONSchemaV1 {
  const standard = schema['~standard'] as StandardSchemaV1.Props & {
    jsonSchema?: { input?: unknown };
  };
  return typeof standard.jsonSchema?.input === 'function';
}

function formatStandardSchemaIssues(
  issues: readonly StandardSchemaV1.Issue[],
): string {
  if (issues.length === 0) {
    return 'Schema validation failed.';
  }
  return issues
    .map(issue => {
      const path = issue.path?.map(formatPathSegment).join('.') ?? '';
      return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');
}

function formatPathSegment(
  segment: PropertyKey | StandardSchemaV1.PathSegment,
): string {
  if (typeof segment === 'object' && 'key' in segment) {
    return String(segment.key);
  }
  return String(segment);
}

async function seedFiles({
  session,
  workDir,
  files,
  abortSignal,
}: {
  session: SandboxContext['session'];
  workDir: string;
  files: NormalizedFile[];
  abortSignal?: AbortSignal;
}): Promise<void> {
  for (const file of files) {
    const filePath = path.posix.join(workDir, file.path);
    await session.run({
      command: `mkdir -p ${shellQuote(path.posix.dirname(filePath))}`,
      ...(abortSignal ? { abortSignal } : {}),
    });

    if (file.kind === 'text') {
      await session.writeTextFile({
        path: filePath,
        content: file.text,
        ...(abortSignal ? { abortSignal } : {}),
      });
    } else {
      await session.writeBinaryFile({
        path: filePath,
        content: file.bytes,
        ...(abortSignal ? { abortSignal } : {}),
      });
    }
  }
}

async function handleStreamPart({
  part,
  events,
  sandboxContext,
  changedFiles,
  abortSignal,
  sessionId,
  appendText,
  setFinishReason,
  setStreamError,
}: {
  part: { type: string; [key: string]: unknown };
  events: AgentOptions['events'];
  sandboxContext: SandboxContext | undefined;
  changedFiles: Map<string, ChangedFile>;
  abortSignal?: AbortSignal;
  sessionId: string;
  appendText: (delta: string) => void;
  setFinishReason: (reason: string) => void;
  setStreamError: (cause: unknown) => void;
}): Promise<void> {
  switch (part.type) {
    case 'text-delta': {
      const delta = typeof part['text'] === 'string' ? part['text'] : '';
      appendText(delta);
      safeEmit(events?.onText, delta);
      return;
    }

    case 'tool-call': {
      const name = typeof part['toolName'] === 'string' ? part['toolName'] : '';
      if (name && name !== 'submitResult') {
        safeEmit(events?.onToolCall, {
          id: typeof part['toolCallId'] === 'string' ? part['toolCallId'] : '',
          name,
          input: part['input'],
        });
      }
      return;
    }

    case 'tool-result': {
      const name = typeof part['toolName'] === 'string' ? part['toolName'] : '';
      if (name === 'fileChange') {
        await recordFileChange({
          payload: part['output'],
          sandboxContext,
          changedFiles,
          abortSignal,
          onFileChange: events?.onFileChange,
        });
        return;
      }
      if (name && name !== 'submitResult') {
        safeEmit(events?.onToolResult, {
          id: typeof part['toolCallId'] === 'string' ? part['toolCallId'] : '',
          name,
          output: part['output'],
        });
      }
      return;
    }

    case 'finish': {
      const reason =
        typeof part['finishReason'] === 'string'
          ? part['finishReason']
          : 'unknown';
      setFinishReason(reason);
      safeEmit(events?.onFinish, { sessionId, finishReason: reason });
      return;
    }

    case 'error':
      setStreamError(part['error']);
      return;
  }
}

async function recordFileChange({
  payload,
  sandboxContext,
  changedFiles,
  abortSignal,
  onFileChange,
}: {
  payload: unknown;
  sandboxContext: SandboxContext | undefined;
  changedFiles: Map<string, ChangedFile>;
  abortSignal?: AbortSignal;
  onFileChange?: (file: ChangedFile) => void;
}): Promise<void> {
  if (!sandboxContext || !isFileChangePayload(payload)) {
    return;
  }
  if (payload.event === 'delete') {
    changedFiles.delete(payload.path);
    return;
  }

  const safePath = assertSafeWorkspacePath(payload.path);
  const bytes = await sandboxContext.session.readBinaryFile({
    path: path.posix.join(sandboxContext.workDir, safePath),
    ...(abortSignal ? { abortSignal } : {}),
  });
  if (bytes == null) {
    return;
  }

  const previous = changedFiles.get(safePath);
  const file: ChangedFile = {
    path: safePath,
    change: previous?.change === 'create' ? 'create' : payload.event,
    bytes,
  };
  changedFiles.set(safePath, file);
  safeEmit(onFileChange, file);
}

function isFileChangePayload(
  value: unknown,
): value is { event: 'create' | 'modify' | 'delete'; path: string } {
  if (value == null || typeof value !== 'object') {
    return false;
  }
  const event = (value as { event?: unknown }).event;
  const filePath = (value as { path?: unknown }).path;
  return (
    (event === 'create' || event === 'modify' || event === 'delete') &&
    typeof filePath === 'string'
  );
}

function createPiSettings(
  config: ResolvedAgentConfig,
  runThinkingLevel?: PiThinkingLevel,
): PiHarnessSettings {
  const { credentials, model, systemPrompt, extensions } = config;
  const thinkingLevel = runThinkingLevel ?? config.thinkingLevel;
  const base = {
    model,
    ...(thinkingLevel ? { thinkingLevel } : {}),
    ...(systemPrompt
      ? {
          resourceLoaderOptions: {
            appendSystemPromptOverride: (sections: string[]) => [
              ...sections,
              systemPrompt,
            ],
          },
        }
      : {}),
    ...(extensions.length > 0
      ? {
          extensionFactories: extensions,
          // Importing the extension is the trust decision — its tools just
          // work. Discovery from ~/.pi and project dirs stays off.
          activateAllExtensionTools: true,
        }
      : {}),
  } satisfies PiHarnessSettings;

  switch (credentials.mode) {
    case 'env':
      return { ...base, auth: { customEnv: collectProviderEnv(process.env) } };

    case 'apiKeys':
      return { ...base, auth: { customEnv: apiKeysToEnv(credentials.keys) } };

    case 'local':
      return { ...base, agentDir: credentials.agentDir ?? getAgentDir() };

    case 'agentDir':
      return { ...base, agentDir: credentials.path };

    case 'shared':
      return {
        ...base,
        piCredentials: createSharedCredentialStore(
          credentials.key,
          credentials.store,
        ),
      };
  }
}

function collectProviderEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!value) {
      continue;
    }
    if (
      key.endsWith('_API_KEY') ||
      key.endsWith('_BASE_URL') ||
      key === 'ANTHROPIC_AUTH_TOKEN' ||
      key === 'VERCEL_OIDC_TOKEN'
    ) {
      out[key] = value;
    }
  }
  return out;
}

function apiKeysToEnv(keys: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [provider, key] of Object.entries(keys)) {
    out[providerToEnvPrefix(provider)] = key;
  }
  return out;
}

function providerToEnvPrefix(provider: string): string {
  const normalized = provider.toUpperCase().replace(/[- ]/g, '_');
  if (normalized === 'VERCEL_AI_GATEWAY') {
    return 'AI_GATEWAY_API_KEY';
  }
  return `${normalized}_API_KEY`;
}

/*
 * Adapt runcell's shared {@link CredentialStore} (a whole-blob store with a
 * distributed lock) to pi-ai's per-provider `CredentialStore` contract, which
 * is what Pi 0.80's `ModelRuntime` consumes.
 *
 * Blob compatibility: runcell's `AuthBlob` is `Record<providerId,
 * StoredCredential>` and `StoredCredential` is assignable to pi-ai's
 * `Credential` (`{ type: 'api_key', key?, env? }` / `{ type: 'oauth', access,
 * refresh, expires, ... }`), which is also the on-disk shape of Pi's `auth.json`.
 * Blobs written by runcell ≤ 1.1.x (through Pi 0.79's AuthStorage) therefore
 * keep working unchanged — no migration step.
 *
 * Every operation runs under the store's lock on the whole blob, so
 * `modify`'s read-modify-write is atomic across processes exactly as pi-ai
 * requires (an OAuth refresh in one deployment cannot clobber a rotation in
 * another).
 */
function createSharedCredentialStore(
  key: string,
  store: CredentialStore,
): PiCredentialStore {
  return {
    async read(providerId) {
      return store.withLock(key, current => {
        return Promise.resolve({
          result: current?.[providerId],
        });
      });
    },

    async list() {
      return store.withLock(key, current => {
        return Promise.resolve({
          result: Object.entries(current ?? {}).map(
            ([providerId, credential]) => ({
              providerId,
              type: credential.type,
            }),
          ),
        });
      });
    },

    async modify(providerId, fn) {
      return store.withLock(key, async current => {
        const existing = current?.[providerId];
        const updated = await fn(existing);
        // `undefined` means "leave the entry unchanged" per the pi-ai contract.
        if (updated === undefined) {
          return { result: existing };
        }
        const next: AuthBlob = {
          ...current,
          [providerId]: updated,
        };
        return { result: updated, next };
      });
    },

    async delete(providerId) {
      await store.withLock(key, current => {
        if (!current || !(providerId in current)) {
          return Promise.resolve({ result: undefined });
        }
        const { [providerId]: _removed, ...rest } = current;
        return Promise.resolve({ result: undefined, next: rest });
      });
    },
  };
}

function joinSections(...sections: (string | undefined)[]): string {
  return sections
    .map(section => section?.trim())
    .filter((section): section is string => Boolean(section))
    .join('\n\n');
}
