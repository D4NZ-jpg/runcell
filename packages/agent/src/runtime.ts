import { HarnessAgent } from '@ai-sdk/harness/agent';
import { createJustBashSandbox } from '@ai-sdk/sandbox-just-bash';
import {
  tool,
  type Experimental_SandboxSession,
  type ToolSet,
} from '@ai-sdk/provider-utils';
import { AuthStorage, getAgentDir } from '@earendil-works/pi-coding-agent';
import { createPi, type PiHarnessSettings } from '@local/harness-pi-raw';
import path from 'node:path';
import { z, type ZodTypeAny } from 'zod';
import type { ResolvedAgentConfig } from './create-agent.js';
import type {
  AuthBlob,
  CredentialPlan,
  CredentialStore,
} from './credentials.js';
import { IncompleteResultError } from './errors.js';
import { normalizeFiles, type NormalizedFile } from './files.js';
import { assertSafeWorkspacePath } from './paths.js';
import type {
  AgentOptions,
  ChangedFile,
  RunOptions,
  RunResult,
  ToolDefinition,
} from './types.js';

export interface RuntimeRunInput<TSchema extends ZodTypeAny> {
  agentOptions: AgentOptions;
  config: ResolvedAgentConfig;
  runOptions: RunOptions<TSchema>;
}

export interface RuncellRuntime {
  run<TSchema extends ZodTypeAny>(
    input: RuntimeRunInput<TSchema>,
  ): Promise<RunResult<z.infer<TSchema>>>;
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

async function runWithHarness<TSchema extends ZodTypeAny>({
  agentOptions,
  config,
  runOptions,
}: RuntimeRunInput<TSchema>): Promise<RunResult<z.infer<TSchema>>> {
  const files = normalizeFiles(runOptions.files ?? []);
  const changedFiles = new Map<string, ChangedFile>();
  let text = '';
  let sandboxContext: SandboxContext | undefined;
  let submitted: unknown;

  const tools = createTools({
    tools: agentOptions.tools,
    schema: runOptions.schema,
    onSubmit: value => {
      submitted = value;
    },
  });

  const harnessAgent = new HarnessAgent({
    id: 'runcell',
    harness: createPi(createPiSettings(config.credentials, config.model)),
    sandbox: createJustBashSandbox({ cwd: config.workspaceDir }),
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
    ...(runOptions.sessionId ? { sessionId: runOptions.sessionId } : {}),
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
            ? runOptions.prompt
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
        const data: unknown = runOptions.schema.parse(submitted);
        return {
          data,
          text,
          files: [...changedFiles.values()],
          sessionId: session.sessionId,
        };
      }
    }

    throw new IncompleteResultError(
      'Agent finished without submitting a valid structured result.',
    );
  } catch (error) {
    agentOptions.events?.onError?.(error);
    throw error;
  } finally {
    await session.destroy();
  }
}

function createTools({
  tools,
  schema,
  onSubmit,
}: {
  tools: AgentOptions['tools'];
  schema: ZodTypeAny;
  onSubmit: (value: unknown) => void;
}): ToolSet {
  const out: ToolSet = {};

  for (const [name, definition] of Object.entries(tools ?? {})) {
    out[name] = createHostTool(definition);
  }

  out['submitResult'] = tool({
    description: 'Submit the final structured result for this run.',
    inputSchema: schema,
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
    inputSchema: definition.schema,
    execute(input) {
      return definition.execute(input);
    },
  });
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
