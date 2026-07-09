import {
  HarnessAgent,
  type HarnessAgentResumeSessionState,
} from '@ai-sdk/harness/agent';
import type { HarnessV1NetworkSandboxSession } from '@ai-sdk/harness';
import { shellQuote } from './shell.js';
import { gzipSync, gunzipSync } from 'node:zlib';
import {
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
import { AuthStorage, getAgentDir } from '@earendil-works/pi-coding-agent';
import { createPi, type PiHarnessSettings } from '@local/harness-pi-raw';
import path from 'node:path';
import type { ResolvedAgentConfig } from './create-agent.js';
import type {
  AuthBlob,
  CredentialPlan,
  CredentialStore,
} from './credentials.js';
import { IncompleteResultError } from './errors.js';
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
    return runWithHarness(input);
  },
};

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
  let submitted: unknown;

  const schema = runOptions.schema;
  const threadInternals = getThreadInternals(runOptions.thread);
  let succeeded = false;

  const tools = createTools({
    tools: agentOptions.tools,
    schema,
    onSubmit: value => {
      submitted = value;
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
    harness: createPi(createPiSettings(config.credentials, config.model)),
    sandbox: sandboxProvider,
    permissionMode: 'allow-all',
    instructions: joinSections(
      agentOptions.instructions,
      runOptions.instructions,
      schema
        ? 'When the task is complete, call submitResult with the structured result.'
        : undefined,
    ),
    tools,
    onSandboxSession: async ({ session, sessionWorkDir, abortSignal }) => {
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
  });

  const sessionId = continuation
    ? continuationSessionId(continuation)
    : pinnedSessionId;
  const session = await harnessAgent.createSession({
    ...(sessionId ? { sessionId } : {}),
    ...(resumeFrom ? { resumeFrom } : {}),
    ...(runOptions.signal ? { abortSignal: runOptions.signal } : {}),
  });

  try {
    const maxAttempts = schema ? config.maxRepairs : 0;
    for (let attempt = 0; attempt <= maxAttempts; attempt += 1) {
      if (attempt > 0) {
        safeEmit(agentOptions.events?.onRepair, {
          attempt,
          reason: 'missing or invalid structured result',
        });
      }

      const result = await harnessAgent.stream({
        session,
        prompt:
          attempt === 0
            ? joinSections(threadContext, runOptions.prompt)
            : 'Call submitResult now with a valid structured result for the previous task.',
        ...(runOptions.signal ? { abortSignal: runOptions.signal } : {}),
      });

      for await (const part of result.stream) {
        await handleStreamPart({
          part,
          events: agentOptions.events,
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
          },
        });
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

      if (submitted !== undefined) {
        const parsed = await validateAgentSchema(schema, submitted);
        if (parsed.success) {
          recordThreadTurn(
            threadInternals,
            runOptions.prompt,
            text,
            parsed.data,
          );
          succeeded = true;
          return {
            data: parsed.data,
            text,
            files: [...changedFiles.values()],
            finishReason,
            sessionId: session.sessionId,
          };
        }
        submitted = undefined;
      }
    }

    throw new IncompleteResultError(
      'Agent finished without submitting a valid structured result.',
    );
  } catch (error) {
    safeEmit(agentOptions.events?.onError, error);
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

/**
 * Invoke an event callback per the {@link AgentEvents} contract: callbacks are
 * best-effort, so a throwing listener never breaks the run.
 */
function safeEmit<TArgs extends unknown[]>(
  listener: ((...args: TArgs) => void) | undefined,
  ...args: TArgs
): void {
  try {
    listener?.(...args);
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
      inputSchema: toToolInputSchema(schema),
      execute(input) {
        onSubmit(input);
        return { ok: true };
      },
    });
  }

  return out;
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
    return schema as unknown as FlexibleSchema<InferSchemaOutput<TSchema>>;
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
}: {
  part: { type: string; [key: string]: unknown };
  events: AgentOptions['events'];
  sandboxContext: SandboxContext | undefined;
  changedFiles: Map<string, ChangedFile>;
  abortSignal?: AbortSignal;
  sessionId: string;
  appendText: (delta: string) => void;
  setFinishReason: (reason: string) => void;
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
      safeEmit(events?.onError, part['error']);
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
  credentials: CredentialPlan,
  model: string,
): PiHarnessSettings {
  const base = { model } satisfies PiHarnessSettings;

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
        authStorage: AuthStorage.fromStorage(
          createSharedAuthBackend(credentials.key, credentials.store),
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

function createSharedAuthBackend(key: string, store: CredentialStore) {
  let cached: AuthBlob | undefined;

  return {
    withLock<T>(
      fn: (current: string | undefined) => {
        result: T;
        next?: string | undefined;
      },
    ): T {
      const { result, next } = fn(serializeAuthBlob(cached));
      if (next !== undefined) {
        cached = parseAuthBlob(next);
      }
      return result;
    },
    async withLockAsync<T>(
      fn: (
        current: string | undefined,
      ) => Promise<{ result: T; next?: string | undefined }>,
    ): Promise<T> {
      return store.withLock(key, async current => {
        cached = current;
        const { result, next } = await fn(serializeAuthBlob(current));
        const parsed = next === undefined ? undefined : parseAuthBlob(next);
        if (parsed !== undefined) {
          cached = parsed;
          return { result, next: parsed };
        }
        return { result };
      });
    },
  };
}

function serializeAuthBlob(blob: AuthBlob | undefined): string | undefined {
  return blob === undefined ? undefined : JSON.stringify(blob, null, 2);
}

function parseAuthBlob(value: string): AuthBlob {
  return JSON.parse(value) as AuthBlob;
}

function joinSections(...sections: (string | undefined)[]): string {
  return sections
    .map(section => section?.trim())
    .filter((section): section is string => Boolean(section))
    .join('\n\n');
}
