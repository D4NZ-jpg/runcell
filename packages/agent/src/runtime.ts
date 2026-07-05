import {
  HarnessAgent,
  type HarnessAgentResumeSessionState,
} from '@ai-sdk/harness/agent';
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
  type ThreadProviderState,
} from './thread.js';
import type {
  AgentOptions,
  AgentSchema,
  ChangedFile,
  InferSchemaOutput,
  RunOptions,
  RunResult,
  ToolDefinition,
} from './types.js';

export interface RuntimeRunInput<TSchema extends AgentSchema> {
  agentOptions: AgentOptions;
  config: ResolvedAgentConfig;
  runOptions: RunOptions<TSchema>;
}

export interface RuncellRuntime {
  run<TSchema extends AgentSchema>(
    input: RuntimeRunInput<TSchema>,
  ): Promise<RunResult<InferSchemaOutput<TSchema>>>;
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

async function runWithHarness<TSchema extends AgentSchema>({
  agentOptions,
  config,
  runOptions,
}: RuntimeRunInput<TSchema>): Promise<RunResult<InferSchemaOutput<TSchema>>> {
  const files = normalizeFiles(runOptions.files ?? []);
  const changedFiles = new Map<string, ChangedFile>();
  let text = '';
  let sandboxContext: SandboxContext | undefined;
  let submitted: unknown;

  const threadInternals = getThreadInternals(runOptions.thread);
  let ended = false;

  const tools = createTools({
    tools: agentOptions.tools,
    schema: runOptions.schema,
    onSubmit: value => {
      submitted = value;
    },
  });

  const { provider: sandboxProvider, sessionId: pinnedSessionId } =
    resolveRunSandbox({ config, runOptions });

  // Lossless resume is only possible when a caller-owned sandbox still holds the
  // journal we persisted for this thread. Otherwise fall back to neutral replay.
  const reusedSandbox = getSandboxInternals(runOptions.sandbox);
  const resumeToken = readPiResumeToken(threadInternals?.providerState);
  const resumeFrom =
    reusedSandbox && resumeToken?.sandboxToken === reusedSandbox.sessionToken
      ? resumeToken.resume
      : undefined;
  const threadContext =
    threadInternals && resumeFrom === undefined
      ? renderThreadContext(threadInternals.messages)
      : undefined;

  const harnessAgent = new HarnessAgent({
    id: 'runcell',
    harness: createPi(createPiSettings(config.credentials, config.model)),
    sandbox: sandboxProvider,
    permissionMode: 'allow-all',
    instructions: joinSections(
      agentOptions.instructions,
      runOptions.instructions,
      'When the task is complete, call submitResult with the structured result.',
    ),
    tools,
    onSandboxSession: async ({ session, sessionWorkDir, abortSignal }) => {
      sandboxContext = { session, workDir: sessionWorkDir };
      await seedFiles({
        session,
        workDir: sessionWorkDir,
        files,
        abortSignal,
      });
    },
  });

  const session = await harnessAgent.createSession({
    ...(pinnedSessionId ? { sessionId: pinnedSessionId } : {}),
    ...(resumeFrom ? { resumeFrom } : {}),
    ...(runOptions.signal ? { abortSignal: runOptions.signal } : {}),
  });

  try {
    for (let attempt = 0; attempt <= config.maxRepairs; attempt += 1) {
      if (attempt > 0) {
        agentOptions.events?.onRepair?.({
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
          },
        });
      }

      if (submitted !== undefined) {
        const parsed = await validateAgentSchema(runOptions.schema, submitted);
        if (parsed.success) {
          if (threadInternals) {
            appendThreadMessage(threadInternals, {
              role: 'user',
              content: runOptions.prompt,
            });
            appendThreadMessage(threadInternals, {
              role: 'agent',
              content: text,
              data: parsed.data,
            });
            // Persist the journal into the caller-owned sandbox and record an
            // opaque token so the next run can resume this exact conversation.
            if (reusedSandbox) {
              const resume = await session.stop();
              ended = true;
              threadInternals.providerState = createPiResumeToken(
                reusedSandbox.sessionToken,
                resume,
              );
            }
          }
          return {
            data: parsed.data,
            text,
            files: [...changedFiles.values()],
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
    agentOptions.events?.onError?.(error);
    throw error;
  } finally {
    if (!ended) {
      await session.destroy();
    }
  }
}

interface PiResumeToken {
  kind: 'pi';
  sandboxToken: string;
  resume: HarnessAgentResumeSessionState;
}

function createPiResumeToken(
  sandboxToken: string,
  resume: HarnessAgentResumeSessionState,
): ThreadProviderState {
  const token: PiResumeToken = { kind: 'pi', sandboxToken, resume };
  return token as unknown as ThreadProviderState;
}

/**
 * Read a Pi resume token out of a thread's opaque provider state, or
 * `undefined` when absent or malformed. Exported for testing.
 */
export function readPiResumeToken(
  state: ThreadProviderState | undefined,
): PiResumeToken | undefined {
  if (state === undefined) {
    return undefined;
  }
  const kind = (state as { kind?: unknown }).kind;
  const sandboxToken = (state as { sandboxToken?: unknown }).sandboxToken;
  const resume = (state as { resume?: unknown }).resume;
  if (kind === 'pi' && typeof sandboxToken === 'string' && resume != null) {
    return {
      kind: 'pi',
      sandboxToken,
      resume: resume as HarnessAgentResumeSessionState,
    };
  }
  return undefined;
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
  runOptions: RunOptions<AgentSchema>;
}): { provider: SandboxProvider; sessionId: string | undefined } {
  const reused = getSandboxInternals(runOptions.sandbox);
  if (reused) {
    return {
      provider: createReusedSandboxProvider(reused),
      sessionId: reused.sessionToken,
    };
  }

  const sandboxConfig =
    runOptions.sandbox !== undefined
      ? resolveSandboxConfig(runOptions.sandbox)
      : config.sandbox;
  return {
    provider: createSandboxProvider(sandboxConfig),
    sessionId: runOptions.sessionId,
  };
}

function createTools({
  tools,
  schema,
  onSubmit,
}: {
  tools: AgentOptions['tools'];
  schema: AgentSchema;
  onSubmit: (value: unknown) => void;
}): ToolSet {
  const out: ToolSet = {};

  for (const [name, definition] of Object.entries(tools ?? {})) {
    out[name] = createHostTool(definition);
  }

  out['submitResult'] = tool({
    description: 'Submit the final structured result for this run.',
    inputSchema: toToolInputSchema(schema),
    execute(input) {
      onSubmit(input);
      return { ok: true };
    },
  });

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
}: {
  part: { type: string; [key: string]: unknown };
  events: AgentOptions['events'];
  sandboxContext: SandboxContext | undefined;
  changedFiles: Map<string, ChangedFile>;
  abortSignal?: AbortSignal;
  sessionId: string;
  appendText: (delta: string) => void;
}): Promise<void> {
  switch (part.type) {
    case 'text-delta': {
      const delta = typeof part['text'] === 'string' ? part['text'] : '';
      appendText(delta);
      events?.onText?.(delta);
      return;
    }

    case 'tool-call': {
      const name = typeof part['toolName'] === 'string' ? part['toolName'] : '';
      if (name && name !== 'submitResult') {
        events?.onToolCall?.({
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
        events?.onToolResult?.({
          id: typeof part['toolCallId'] === 'string' ? part['toolCallId'] : '',
          name,
          output: part['output'],
        });
      }
      return;
    }

    case 'finish':
      events?.onFinish?.({
        sessionId,
        finishReason:
          typeof part['finishReason'] === 'string'
            ? part['finishReason']
            : 'unknown',
      });
      return;

    case 'error':
      events?.onError?.(part['error']);
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
  onFileChange?.(file);
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

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
