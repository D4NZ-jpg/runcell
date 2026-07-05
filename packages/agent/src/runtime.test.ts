import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ResolvedAgentConfig } from './create-agent.js';
import type { AuthBlob, CredentialStore } from './credentials.js';
import type { RuncellRuntime, RuntimeRunInput } from './runtime.js';
import type {
  AgentEvents,
  AgentOptions,
  AgentSchema,
  ChangedFile,
  FinishEvent,
  RepairEvent,
  RunOptions,
  ToolCallEvent,
  ToolDefinition,
  ToolResultEvent,
} from './types.js';

describe('defaultRuntime', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('creates the harness, seeds files and returns submitted data', async () => {
    const state = installRuntimeMocks([
      agent => {
        agent.submit({ ok: true });
        return [{ type: 'text-delta', text: 'done' }];
      },
    ]);
    const runtime = await loadRuntime();
    const schema = z.object({ ok: z.boolean() });
    const bytes = new Uint8Array([1, 2, 3]);

    const result = await runtime.run(
      createRuntimeInput(schema, {
        agentOptions: { instructions: 'Use concise answers.' },
        runOptions: {
          instructions: 'Return the boolean flag.',
          files: [
            { path: 'src/input.txt', text: 'hello' },
            { path: 'assets/blob.bin', bytes },
          ],
        },
      }),
    );

    expect(result).toEqual({
      data: { ok: true },
      text: 'done',
      files: [],
      finishReason: 'stop',
      sessionId: 'test-session',
    });
    expect(state.sandboxSettings).toEqual([undefined]);
    expect(state.piSettings[0]).toMatchObject({
      model: 'anthropic/test',
      auth: { customEnv: { ANTHROPIC_API_KEY: 'test-key' } },
    });
    expect(state.instances[0]?.settings.instructions).toBe(
      'Use concise answers.\n\nReturn the boolean flag.\n\nWhen the task is complete, call submitResult with the structured result.',
    );
    expect(state.sandboxSession.runs.map(run => run.command)).toEqual([
      "mkdir -p '/work/src'",
      "mkdir -p '/work/assets'",
    ]);
    expect(state.sandboxSession.textWrites).toEqual([
      { path: '/work/src/input.txt', content: 'hello' },
    ]);
    expect(state.sandboxSession.binaryWrites).toEqual([
      { path: '/work/assets/blob.bin', content: bytes },
    ]);
    expect(state.instances[0]?.session?.destroyCount).toBe(1);
  });

  it('accepts Standard Schema validators that are not Zod schemas', async () => {
    const schema: AgentSchema<{ ok: boolean }> = {
      '~standard': {
        version: 1,
        vendor: 'test-schema',
        validate(value) {
          if (
            value != null &&
            typeof value === 'object' &&
            (value as { ok?: unknown }).ok === true
          ) {
            return { value: { ok: true } };
          }
          return { issues: [{ message: 'ok must be true' }] };
        },
      },
    };
    installRuntimeMocks([
      agent => {
        agent.submit({ ok: true });
        return [];
      },
    ]);
    const runtime = await loadRuntime();

    const result = await runtime.run(createRuntimeInput(schema));

    expect(result.data).toEqual({ ok: true });
  });

  it('maps environment credentials to Pi auth settings', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'env-anthropic');
    vi.stubEnv('OPENAI_BASE_URL', 'https://openai.example.test/v1');
    vi.stubEnv('VERCEL_OIDC_TOKEN', 'env-oidc');
    vi.stubEnv('IGNORED_TOKEN', 'ignored');
    const state = installRuntimeMocks([
      agent => {
        agent.submit({ ok: true });
        return [];
      },
    ]);
    const runtime = await loadRuntime();

    await runtime.run(
      createRuntimeInput(z.object({ ok: z.boolean() }), {
        config: { credentials: { mode: 'env' } },
      }),
    );

    expect(state.piSettings[0]).toMatchObject({
      auth: {
        customEnv: {
          ANTHROPIC_API_KEY: 'env-anthropic',
          OPENAI_BASE_URL: 'https://openai.example.test/v1',
          VERCEL_OIDC_TOKEN: 'env-oidc',
        },
      },
    });
    expect(state.piSettings[0]).not.toMatchObject({
      auth: { customEnv: { IGNORED_TOKEN: 'ignored' } },
    });
  });

  it('maps API key credentials to provider env vars', async () => {
    const state = installRuntimeMocks([
      agent => {
        agent.submit({ ok: true });
        return [];
      },
    ]);
    const runtime = await loadRuntime();

    await runtime.run(
      createRuntimeInput(z.object({ ok: z.boolean() }), {
        config: {
          credentials: {
            mode: 'apiKeys',
            keys: {
              anthropic: 'anthropic-key',
              openai: 'openai-key',
              'vercel-ai-gateway': 'gateway-key',
            },
          },
        },
      }),
    );

    expect(state.piSettings[0]).toMatchObject({
      auth: {
        customEnv: {
          ANTHROPIC_API_KEY: 'anthropic-key',
          OPENAI_API_KEY: 'openai-key',
          AI_GATEWAY_API_KEY: 'gateway-key',
        },
      },
    });
  });

  it('maps local and agentDir credentials to Pi agent dirs', async () => {
    const state = installRuntimeMocks([
      agent => {
        agent.submit({ ok: true });
        return [];
      },
      agent => {
        agent.submit({ ok: true });
        return [];
      },
    ]);
    const runtime = await loadRuntime();
    const schema = z.object({ ok: z.boolean() });

    await runtime.run(
      createRuntimeInput(schema, {
        config: { credentials: { mode: 'local' } },
      }),
    );
    await runtime.run(
      createRuntimeInput(schema, {
        config: { credentials: { mode: 'agentDir', path: '/custom-agent' } },
      }),
    );

    expect(state.piSettings).toMatchObject([
      { agentDir: '/agent-dir' },
      { agentDir: '/custom-agent' },
    ]);
  });

  it('maps shared credentials to Pi auth storage', async () => {
    const store: CredentialStore = {
      async withLock(_key, fn) {
        const current: AuthBlob = {
          anthropic: { type: 'api_key', key: 'stored-key' },
        };
        const { result } = await fn(current);
        return result;
      },
    };
    const state = installRuntimeMocks([
      agent => {
        agent.submit({ ok: true });
        return [];
      },
    ]);
    const runtime = await loadRuntime();

    await runtime.run(
      createRuntimeInput(z.object({ ok: z.boolean() }), {
        config: { credentials: { mode: 'shared', key: 'tenant-a', store } },
      }),
    );

    expect(state.authStorageBackends).toHaveLength(1);
    expect(state.piSettings[0]).toMatchObject({
      authStorage: { storage: state.authStorageBackends[0] },
    });
  });

  it('forwards visible stream events and collects changed files', async () => {
    const outputBytes = new Uint8Array([4, 5, 6]);
    const textEvents: string[] = [];
    const toolCalls: ToolCallEvent[] = [];
    const toolResults: ToolResultEvent[] = [];
    const fileChanges: ChangedFile[] = [];
    const finishes: FinishEvent[] = [];
    const events: AgentEvents = {
      onText: text => textEvents.push(text),
      onToolCall: call => toolCalls.push(call),
      onToolResult: result => toolResults.push(result),
      onFileChange: file => fileChanges.push(file),
      onFinish: finish => finishes.push(finish),
    };
    const state = installRuntimeMocks([
      agent => {
        agent.submit({ ok: true });
        return [
          { type: 'text-delta', text: 'hello' },
          {
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName: 'lookup',
            input: { id: 'abc' },
          },
          {
            type: 'tool-result',
            toolCallId: 'call-hidden',
            toolName: 'submitResult',
            output: { ok: true },
          },
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: 'lookup',
            output: { value: 42 },
          },
          {
            type: 'tool-result',
            toolCallId: 'file-1',
            toolName: 'fileChange',
            output: { event: 'create', path: 'out.txt' },
          },
          { type: 'finish', finishReason: 'stop' },
        ];
      },
    ]);
    state.sandboxSession.readResults.set('/work/out.txt', outputBytes);
    const runtime = await loadRuntime();
    const schema = z.object({ ok: z.boolean() });

    const result = await runtime.run(
      createRuntimeInput(schema, {
        agentOptions: { events },
      }),
    );

    expect(result.text).toBe('hello');
    expect(result.files).toEqual([
      { path: 'out.txt', change: 'create', bytes: outputBytes },
    ]);
    expect(textEvents).toEqual(['hello']);
    expect(toolCalls).toEqual([
      { id: 'call-1', name: 'lookup', input: { id: 'abc' } },
    ]);
    expect(toolResults).toEqual([
      { id: 'call-1', name: 'lookup', output: { value: 42 } },
    ]);
    expect(fileChanges).toEqual(result.files);
    expect(finishes).toEqual([
      { sessionId: 'test-session', finishReason: 'stop' },
    ]);
  });

  it('wraps host tools', async () => {
    const lookupSchema = z.object({ query: z.string() });
    const lookupInputs: z.infer<typeof lookupSchema>[] = [];
    const lookup = {
      description: 'Lookup a value',
      schema: lookupSchema,
      execute(input) {
        lookupInputs.push(input);
        return { value: input.query.toUpperCase() };
      },
    } satisfies ToolDefinition<typeof lookupSchema>;
    const state = installRuntimeMocks([
      agent => {
        agent.submit({ ok: true });
        return [];
      },
    ]);
    const runtime = await loadRuntime();

    await runtime.run(
      createRuntimeInput(z.object({ ok: z.boolean() }), {
        agentOptions: { tools: { lookup } },
      }),
    );

    const tool = state.instances[0]?.settings.tools['lookup'];
    expect(tool?.execute({ query: 'abc' })).toEqual({ value: 'ABC' });
    expect(lookupInputs).toEqual([{ query: 'abc' }]);
  });

  it('runs without a schema: no submitResult, text is the output', async () => {
    const state = installRuntimeMocks([
      () => [
        { type: 'text-delta', text: 'hello world' },
        { type: 'finish', finishReason: 'stop' },
      ],
    ]);
    const runtime = await loadRuntime();

    const result = await runtime.run({
      agentOptions: { model: 'anthropic/test' },
      config: {
        model: 'anthropic/test',
        instructions: undefined,
        credentials: { mode: 'apiKeys', keys: { anthropic: 'test-key' } },
        toolNames: [],
        sandbox: { type: 'virtual' },
        maxRepairs: 1,
      },
      runOptions: { prompt: 'say hi' },
    });

    expect(result.data).toBeUndefined();
    expect(result.text).toBe('hello world');
    expect(result.finishReason).toBe('stop');
    // No hidden submitResult tool is registered without a schema.
    expect(state.instances[0]?.settings.tools['submitResult']).toBeUndefined();
    // A single turn only.
    expect(state.instances[0]?.streamCalls).toHaveLength(1);
  });

  it('replays prior thread turns and appends new ones', async () => {
    const { createThread, getThreadInternals } = await import('./thread.js');
    const thread = createThread({ id: 'chat' });
    const state = installRuntimeMocks([
      agent => {
        agent.submit({ ok: true });
        return [{ type: 'text-delta', text: 'one' }];
      },
      agent => {
        agent.submit({ ok: true });
        return [{ type: 'text-delta', text: 'two' }];
      },
    ]);
    const runtime = await loadRuntime();
    const schema = z.object({ ok: z.boolean() });

    await runtime.run(
      createRuntimeInput(schema, { runOptions: { prompt: 'first', thread } }),
    );
    await runtime.run(
      createRuntimeInput(schema, { runOptions: { prompt: 'second', thread } }),
    );

    // First run has no prior context.
    expect(state.instances[0]?.streamCalls[0]?.prompt).toBe('first');
    // Second run replays the first turn, then the new prompt.
    const secondPrompt = state.instances[1]?.streamCalls[0]?.prompt ?? '';
    expect(secondPrompt).toContain('Conversation so far:');
    expect(secondPrompt).toContain('User: first');
    expect(secondPrompt).toContain('Assistant: one');
    expect(secondPrompt.endsWith('second')).toBe(true);

    expect(
      getThreadInternals(thread)?.messages.map(
        message => `${message.role}:${message.content}`,
      ),
    ).toEqual(['user:first', 'agent:one', 'user:second', 'agent:two']);
  });

  it('repairs missing or invalid structured results', async () => {
    const repairs: RepairEvent[] = [];
    const state = installRuntimeMocks([
      agent => {
        agent.submit({ ok: 'no' });
        return [{ type: 'text-delta', text: 'first ' }];
      },
      agent => {
        agent.submit({ ok: true });
        return [{ type: 'text-delta', text: 'second' }];
      },
    ]);
    const runtime = await loadRuntime();

    const result = await runtime.run(
      createRuntimeInput(z.object({ ok: z.boolean() }), {
        agentOptions: { events: { onRepair: info => repairs.push(info) } },
        config: { maxRepairs: 1 },
      }),
    );

    expect(result.data).toEqual({ ok: true });
    expect(result.text).toBe('first second');
    expect(state.instances[0]?.streamCalls.map(call => call.prompt)).toEqual([
      'do it',
      'Call submitResult now with a valid structured result for the previous task.',
    ]);
    expect(repairs).toEqual([
      { attempt: 1, reason: 'missing or invalid structured result' },
    ]);
  });

  it('throws when no valid result is submitted after repairs', async () => {
    const errors: unknown[] = [];
    const state = installRuntimeMocks([() => []]);
    const runtime = await loadRuntime();
    const { IncompleteResultError } = await import('./errors.js');

    await expect(
      runtime.run(
        createRuntimeInput(z.object({ ok: z.boolean() }), {
          agentOptions: { events: { onError: error => errors.push(error) } },
          config: { maxRepairs: 0 },
        }),
      ),
    ).rejects.toBeInstanceOf(IncompleteResultError);

    expect(errors[0]).toBeInstanceOf(IncompleteResultError);
    expect(state.instances[0]?.session?.destroyCount).toBe(1);
  });
});

async function loadRuntime(): Promise<RuncellRuntime> {
  const { defaultRuntime } = await import('./runtime.js');
  return defaultRuntime;
}

function createRuntimeInput<TSchema extends AgentSchema>(
  schema: TSchema,
  overrides: {
    agentOptions?: Partial<AgentOptions>;
    config?: Partial<ResolvedAgentConfig>;
    runOptions?: Partial<RunOptions<TSchema>>;
  } = {},
): RuntimeRunInput {
  const agentOptions: AgentOptions = {
    model: 'anthropic/test',
    ...overrides.agentOptions,
  };
  return {
    agentOptions,
    config: {
      model: 'anthropic/test',
      instructions: agentOptions.instructions,
      credentials: { mode: 'apiKeys', keys: { anthropic: 'test-key' } },
      toolNames: Object.keys(agentOptions.tools ?? {}),
      sandbox: { type: 'virtual' },
      maxRepairs: 1,
      ...overrides.config,
    },
    runOptions: {
      prompt: 'do it',
      schema,
      ...overrides.runOptions,
    },
  };
}

function installRuntimeMocks(scripts: StreamScript[] = []): TestState {
  const state: TestState = {
    instances: [],
    piSettings: [],
    authStorageBackends: [],
    sandboxSettings: [],
    sandboxSession: new TestSandboxSession(),
    scripts: [...scripts],
  };

  vi.doMock('@ai-sdk/harness/agent', () => ({
    HarnessAgent: class MockHarnessAgent implements TestHarnessAgent {
      readonly settings: HarnessSettings;
      readonly streamCalls: StreamInput[] = [];
      session: TestHarnessSession | undefined;

      constructor(settings: HarnessSettings) {
        this.settings = settings;
        state.instances.push(this);
      }

      async createSession(
        options: CreateSessionOptions,
      ): Promise<TestHarnessSession> {
        const session = new TestHarnessSession(
          options.sessionId ?? 'test-session',
        );
        this.session = session;
        if (this.settings.onSandboxSession) {
          const request: SandboxSessionRequest = {
            session: state.sandboxSession,
            sessionWorkDir: '/work',
          };
          if (options.abortSignal) {
            request.abortSignal = options.abortSignal;
          }
          await this.settings.onSandboxSession(request);
        }
        return session;
      }

      stream(
        input: StreamInput,
      ): Promise<{ stream: AsyncIterable<StreamPart> }> {
        this.streamCalls.push(input);
        const script = state.scripts.shift();
        const parts = script?.(this) ?? [];
        return Promise.resolve({ stream: toAsyncIterable(parts) });
      }

      submit(input: unknown): void {
        const submitResult = this.settings.tools['submitResult'];
        expect(submitResult).toBeDefined();
        void submitResult?.execute(input);
      }
    },
  }));

  vi.doMock('@ai-sdk/sandbox-just-bash', () => ({
    createJustBashSandbox(settings?: SandboxSettings) {
      state.sandboxSettings.push(settings);
      return { settings };
    },
  }));

  vi.doMock('@local/harness-pi-raw', () => ({
    createPi(settings: unknown) {
      state.piSettings.push(settings);
      return { settings };
    },
  }));

  vi.doMock('@earendil-works/pi-coding-agent', () => ({
    AuthStorage: {
      fromStorage(storage: unknown) {
        state.authStorageBackends.push(storage);
        return { storage };
      },
    },
    getAgentDir() {
      return '/agent-dir';
    },
  }));

  return state;
}

function toAsyncIterable(
  parts: readonly StreamPart[],
): AsyncIterable<StreamPart> {
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        next(): Promise<IteratorResult<StreamPart>> {
          const value = parts[index];
          index += 1;
          return Promise.resolve(
            value === undefined
              ? { done: true, value: undefined }
              : { done: false, value },
          );
        },
      };
    },
  };
}

type StreamScript = (agent: TestHarnessAgent) => StreamPart[];

interface StreamPart {
  type: string;
  [key: string]: unknown;
}

interface TestState {
  instances: TestHarnessAgent[];
  piSettings: unknown[];
  authStorageBackends: unknown[];
  sandboxSettings: (SandboxSettings | undefined)[];
  sandboxSession: TestSandboxSession;
  scripts: StreamScript[];
}

interface TestHarnessAgent {
  settings: HarnessSettings;
  streamCalls: StreamInput[];
  session: TestHarnessSession | undefined;
  submit(input: unknown): void;
}

interface HarnessSettings {
  instructions: string;
  tools: Record<string, ToolLike>;
  onSandboxSession?: (request: SandboxSessionRequest) => void | Promise<void>;
}

interface ToolLike {
  execute(input: unknown): unknown;
}

interface CreateSessionOptions {
  sessionId?: string;
  abortSignal?: AbortSignal;
}

interface StreamInput {
  session: TestHarnessSession;
  prompt: string;
  abortSignal?: AbortSignal;
}

interface SandboxSessionRequest {
  session: TestSandboxSession;
  sessionWorkDir: string;
  abortSignal?: AbortSignal;
}

interface SandboxSettings {
  cwd?: string;
}

interface RunCommand {
  command: string;
  abortSignal?: AbortSignal;
}

interface TextWrite {
  path: string;
  content: string;
  abortSignal?: AbortSignal;
}

interface BinaryWrite {
  path: string;
  content: Uint8Array;
  abortSignal?: AbortSignal;
}

interface BinaryRead {
  path: string;
  abortSignal?: AbortSignal;
}

class TestHarnessSession {
  destroyCount = 0;

  constructor(readonly sessionId: string) {}

  destroy(): Promise<void> {
    this.destroyCount += 1;
    return Promise.resolve();
  }
}

class TestSandboxSession {
  readonly runs: RunCommand[] = [];
  readonly textWrites: TextWrite[] = [];
  readonly binaryWrites: BinaryWrite[] = [];
  readonly binaryReads: BinaryRead[] = [];
  readonly readResults = new Map<string, Uint8Array | null>();

  run(
    input: RunCommand,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    this.runs.push(input);
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
  }

  writeTextFile(input: TextWrite): Promise<void> {
    this.textWrites.push(input);
    return Promise.resolve();
  }

  writeBinaryFile(input: BinaryWrite): Promise<void> {
    this.binaryWrites.push(input);
    return Promise.resolve();
  }

  readBinaryFile(input: BinaryRead): Promise<Uint8Array | null> {
    this.binaryReads.push(input);
    return Promise.resolve(this.readResults.get(input.path) ?? null);
  }
}
