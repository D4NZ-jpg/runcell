import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  StandardJSONSchemaV1,
  StandardSchemaV1,
} from '@standard-schema/spec';
import { asSchema, type FlexibleSchema } from '@ai-sdk/provider-utils';
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
        agentOptions: { systemPrompt: 'Use concise answers.' },
        runOptions: {
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
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        costMeasured: true,
      },
    });
    expect(state.sandboxSettings).toEqual([undefined]);
    expect(state.piSettings[0]).toMatchObject({
      model: 'anthropic/test',
      auth: { customEnv: { ANTHROPIC_API_KEY: 'test-key' } },
    });
    expect(state.instances[0]?.settings.instructions).toBe(
      'When the task is complete, call submitResult with the structured result.',
    );
    const appendSystemPrompt = (
      state.piSettings[0] as {
        resourceLoaderOptions?: {
          appendSystemPromptOverride?: (sections: string[]) => string[];
        };
      }
    ).resourceLoaderOptions?.appendSystemPromptOverride;
    expect(appendSystemPrompt?.(['base'])).toEqual([
      'base',
      'Use concise answers.',
    ]);
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

  it('terminates the active turn immediately after a valid submission', async () => {
    let turnSignal: AbortSignal | undefined;
    let consumedAfterSubmission = false;
    const finishes: FinishEvent[] = [];
    const state = installRuntimeMocks([
      (agent, input) => ({
        async *[Symbol.asyncIterator]() {
          turnSignal = input.abortSignal;
          yield { type: 'text-delta', text: 'before' };
          agent.submit({ ok: true });
          if (!input.abortSignal?.aborted) {
            await new Promise<void>(resolve => {
              input.abortSignal?.addEventListener(
                'abort',
                () => {
                  resolve();
                },
                { once: true },
              );
            });
          }
          if (input.abortSignal?.aborted) {
            return;
          }
          consumedAfterSubmission = true;
          yield { type: 'text-delta', text: 'after' };
        },
      }),
    ]);
    const runtime = await loadRuntime();

    const result = await Promise.race([
      runtime.run(
        createRuntimeInput(z.object({ ok: z.boolean() }), {
          agentOptions: {
            events: { onFinish: event => finishes.push(event) },
          },
        }),
      ),
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error('run did not terminate'));
        }, 250);
      }),
    ]);

    expect(result.data).toEqual({ ok: true });
    expect(result.text).toBe('before');
    expect(turnSignal?.aborted).toBe(true);
    expect(turnSignal?.reason).toBe(Symbol.for('runcell.pi.silent-turn-abort'));
    expect(consumedAfterSubmission).toBe(false);
    expect(finishes).toEqual([
      { sessionId: 'test-session', finishReason: 'stop' },
    ]);
    expect(state.instances[0]?.session?.destroyCount).toBe(1);
  });

  it('does not duplicate onFinish when a finish part follows submission', async () => {
    const finishes: FinishEvent[] = [];
    const errors: unknown[] = [];
    installRuntimeMocks([
      agent => ({
        async *[Symbol.asyncIterator]() {
          await agent.submitAsync({ ok: true });
          yield { type: 'finish', finishReason: 'tool-calls' };
        },
      }),
    ]);
    const runtime = await loadRuntime();

    const result = await runtime.run(
      createRuntimeInput(z.object({ ok: z.boolean() }), {
        agentOptions: {
          events: {
            onFinish: event => finishes.push(event),
            onError: error => errors.push(error),
          },
        },
      }),
    );

    expect(result.data).toEqual({ ok: true });
    expect(result.finishReason).toBe('tool-calls');
    expect(finishes).toEqual([
      { sessionId: 'test-session', finishReason: 'tool-calls' },
    ]);
    expect(errors).toEqual([]);
  });

  it('keeps an invalid Zod submission in the same turn, then accepts a valid one', async () => {
    let signal: AbortSignal | undefined;
    const state = installRuntimeMocks([
      (agent, input) => ({
        async *[Symbol.asyncIterator]() {
          signal = input.abortSignal;
          await agent.submitAsync({ ok: 'invalid' });
          expect(signal?.aborted).toBe(false);
          yield { type: 'text-delta', text: 'correcting' };
          await agent.submitAsync({ ok: true });
          expect(signal?.aborted).toBe(true);
        },
      }),
    ]);
    const runtime = await loadRuntime();

    const result = await runtime.run(
      createRuntimeInput(z.object({ ok: z.boolean() }), {
        config: { maxRepairs: 0 },
      }),
    );

    expect(result.data).toEqual({ ok: true });
    expect(result.text).toBe('correcting');
    expect(state.instances[0]?.streamCalls).toHaveLength(1);
  });

  it('validates an async Standard JSON Schema submission inside execute', async () => {
    const schema = createStandardSchema({ withJsonSchema: true, async: true });
    let signal: AbortSignal | undefined;
    const state = installRuntimeMocks([
      (agent, input) => ({
        async *[Symbol.asyncIterator]() {
          signal = input.abortSignal;
          yield { type: 'text-delta', text: '' };
          await agent.submitAsync({ count: 'invalid' });
          expect(signal?.aborted).toBe(false);
          await agent.submitAsync({ count: 3 });
          expect(signal?.aborted).toBe(true);
        },
      }),
    ]);
    const runtime = await loadRuntime();

    const result = await runtime.run(
      createRuntimeInput(schema, { config: { maxRepairs: 0 } }),
    );

    expect(result.data).toEqual({ doubled: 6 });
    expect(state.instances[0]?.streamCalls).toHaveLength(1);
  });

  it('accepts a cross-realm Promise returned by Standard Schema validation', async () => {
    interface Output {
      source: string;
    }
    let crossRealmPromise: Promise<StandardSchemaV1.Result<Output>> | undefined;
    const schema: AgentSchema<Output> = {
      '~standard': {
        version: 1,
        vendor: 'cross-realm-test',
        validate() {
          crossRealmPromise = runInNewContext(
            `Promise.resolve({ value: { source: 'cross-realm' } })`,
          ) as Promise<StandardSchemaV1.Result<Output>>;
          return crossRealmPromise;
        },
      },
    };
    installRuntimeMocks([
      agent => ({
        async *[Symbol.asyncIterator]() {
          yield { type: 'text-delta', text: '' };
          await agent.submitAsync({ source: 'input' });
        },
      }),
    ]);
    const runtime = await loadRuntime();

    const result = await runtime.run(
      createRuntimeInput(schema, { config: { maxRepairs: 0 } }),
    );

    expect(crossRealmPromise).toBeDefined();
    expect(crossRealmPromise).not.toBeInstanceOf(Promise);
    expect(result.data).toEqual({ source: 'cross-realm' });
  });

  it('keeps model schema projection unvalidated and invokes the user validator once', async () => {
    interface Output {
      transformed: number;
    }
    let validationCount = 0;
    const schema: AgentSchema<Output> & StandardJSONSchemaV1 = {
      '~standard': {
        version: 1,
        vendor: 'single-validation-test',
        jsonSchema: {
          input: () => ({
            type: 'object',
            properties: { count: { type: 'number' } },
            required: ['count'],
          }),
          output: () => ({ type: 'object' }),
        },
        validate(value) {
          validationCount += 1;
          return {
            value: {
              transformed: (value as { count: number }).count * 3,
            },
          };
        },
      },
    };
    installRuntimeMocks([
      agent => ({
        async *[Symbol.asyncIterator]() {
          yield { type: 'text-delta', text: '' };
          const submitResult = agent.settings.tools['submitResult'];
          expect(submitResult).toBeDefined();
          const parseSchema = asSchema(submitResult?.inputSchema);
          expect(parseSchema.validate).toBeUndefined();
          await expect(
            Promise.resolve(parseSchema.jsonSchema),
          ).resolves.toMatchObject({
            type: 'object',
            properties: { count: { type: 'number' } },
            required: ['count'],
          });
          expect(validationCount).toBe(0);

          await agent.submitAsync({ count: 7 });
        },
      }),
    ]);
    const runtime = await loadRuntime();

    const result = await runtime.run(
      createRuntimeInput(schema, { config: { maxRepairs: 0 } }),
    );

    expect(validationCount).toBe(1);
    expect(result.data).toEqual({ transformed: 21 });
  });

  it('validates and transforms a stateful async submission exactly once', async () => {
    interface Output {
      transformed: number;
    }
    let validationCount = 0;
    const schema: AgentSchema<Output> = {
      '~standard': {
        version: 1,
        vendor: 'stateful-test',
        async validate(value) {
          validationCount += 1;
          await Promise.resolve();
          return {
            value: {
              transformed: (value as { count: number }).count * 3,
            },
          };
        },
      },
    };
    installRuntimeMocks([
      agent => ({
        async *[Symbol.asyncIterator]() {
          yield { type: 'text-delta', text: '' };
          await agent.submitAsync({ count: 7 });
        },
      }),
    ]);
    const runtime = await loadRuntime();

    const result = await runtime.run(
      createRuntimeInput(schema, { config: { maxRepairs: 0 } }),
    );

    expect(validationCount).toBe(1);
    expect(result.data).toEqual({ transformed: 21 });
  });

  it('validates a wrapped Standard Schema submission inside execute', async () => {
    const schema = createStandardSchema({
      withJsonSchema: false,
      async: false,
    });
    let signal: AbortSignal | undefined;
    const state = installRuntimeMocks([
      (agent, input) => ({
        async *[Symbol.asyncIterator]() {
          signal = input.abortSignal;
          yield { type: 'text-delta', text: '' };
          await agent.submitAsync({ count: null });
          expect(signal?.aborted).toBe(false);
          await agent.submitAsync({ count: 4 });
          expect(signal?.aborted).toBe(true);
        },
      }),
    ]);
    const runtime = await loadRuntime();

    const result = await runtime.run(
      createRuntimeInput(schema, { config: { maxRepairs: 0 } }),
    );

    expect(result.data).toEqual({ doubled: 8 });
    expect(state.instances[0]?.streamCalls).toHaveLength(1);
  });

  it('wraps an object caller reason with reconciled usage and exact cause', async () => {
    const callerAbort = new AbortController();
    const callerError = { code: 'caller-cancelled' };
    const schema = createStandardSchema({ withJsonSchema: true, async: true });
    const errors: unknown[] = [];
    let turnSignal: AbortSignal | undefined;
    const state = installRuntimeMocks([
      (agent, input) => ({
        async *[Symbol.asyncIterator]() {
          turnSignal = input.abortSignal;
          yield { type: 'text-delta', text: '' };
          const submission = agent.submitAsync({ count: 2 });
          state.sessionUsageTotals.set(getTestSession(agent), {
            inputTokens: 12,
            outputTokens: 3,
            cacheReadTokens: 4,
            cacheWriteTokens: 1,
            costUsd: 0.02,
          });
          callerAbort.abort(callerError);
          await submission;
          expect(input.abortSignal?.reason).toBe(callerError);
          throw new Error('harness abort failed');
        },
      }),
    ]);
    const runtime = await loadRuntime();

    await expect(
      runtime.run(
        createRuntimeInput(schema, {
          agentOptions: { events: { onError: error => errors.push(error) } },
          config: { maxRepairs: 0 },
          runOptions: { signal: callerAbort.signal },
        }),
      ),
    ).rejects.toSatisfy((failure: unknown) => {
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).name).toBe('TurnError');
      expect((failure as Error).cause).toBe(callerError);
      expect((failure as Error & { usage: unknown }).usage).toEqual({
        inputTokens: 12,
        outputTokens: 3,
        cacheReadTokens: 4,
        cacheWriteTokens: 1,
        totalTokens: 20,
        costUsd: 0.02,
        costMeasured: true,
      });
      expect(errors).toEqual([failure]);
      return true;
    });
    expect(turnSignal?.reason).toBe(callerError);
    // The caller-owned reason object is never mutated.
    expect('usage' in callerError).toBe(false);
  });

  it('wraps a primitive caller reason with reconciled usage and exact cause', async () => {
    const callerAbort = new AbortController();
    const errors: unknown[] = [];
    const state = installRuntimeMocks([
      (agent, input) => ({
        async *[Symbol.asyncIterator]() {
          await Promise.resolve();
          yield { type: 'text-delta', text: 'partial' };
          state.sessionUsageTotals.set(getTestSession(agent), {
            inputTokens: 7,
            outputTokens: 2,
            cacheReadTokens: 1,
            cacheWriteTokens: 0,
            costUsd: 0.01,
          });
          callerAbort.abort('caller stopped');
          expect(input.abortSignal?.reason).toBe('caller stopped');
          throw new Error('harness abort failed');
        },
      }),
    ]);
    const runtime = await loadRuntime();
    const { TurnError } = await import('./errors.js');

    const failure = await runtime
      .run(
        createRuntimeInput(z.object({ ok: z.boolean() }), {
          agentOptions: { events: { onError: error => errors.push(error) } },
          config: { maxRepairs: 0 },
          runOptions: { signal: callerAbort.signal },
        }),
      )
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(TurnError);
    expect((failure as Error).cause).toBe('caller stopped');
    expect((failure as InstanceType<typeof TurnError>).usage).toEqual({
      inputTokens: 7,
      outputTokens: 2,
      cacheReadTokens: 1,
      cacheWriteTokens: 0,
      totalTokens: 10,
      costUsd: 0.01,
      costMeasured: true,
    });
    expect(errors).toEqual([failure]);
  });

  it('returns the submission when caller cancellation happens afterward', async () => {
    const callerAbort = new AbortController();
    const callerError = new Error('late caller cancellation');
    let turnSignal: AbortSignal | undefined;
    installRuntimeMocks([
      (agent, input) => ({
        async *[Symbol.asyncIterator]() {
          turnSignal = input.abortSignal;
          yield { type: 'text-delta', text: '' };
          await agent.submitAsync({ ok: true });
          callerAbort.abort(callerError);
        },
      }),
    ]);
    const runtime = await loadRuntime();

    const result = await runtime.run(
      createRuntimeInput(z.object({ ok: z.boolean() }), {
        config: { maxRepairs: 0 },
        runOptions: { signal: callerAbort.signal },
      }),
    );

    expect(result.data).toEqual({ ok: true });
    // Both the submission's silent abort and the late caller abort reach
    // the composite turn signal. Which reason it reports is a Node
    // implementation detail (it differs between 22 and 24); the contract is
    // that the turn was aborted and the submission still won.
    expect(turnSignal?.aborted).toBe(true);
  });

  it('returns the first valid submission despite a trailing stream error', async () => {
    const errors: unknown[] = [];
    installRuntimeMocks([
      agent => {
        agent.submit({ ok: true });
        agent.submit({ ok: false });
        return [{ type: 'error', error: new Error('model stream timeout') }];
      },
    ]);
    const runtime = await loadRuntime();

    const result = await runtime.run(
      createRuntimeInput(z.object({ ok: z.boolean() }), {
        agentOptions: { events: { onError: error => errors.push(error) } },
      }),
    );

    expect(result.data).toEqual({ ok: true });
    expect(errors).toEqual([]);
  });

  it('returns a valid submission despite a trailing iterator failure', async () => {
    const errors: unknown[] = [];
    installRuntimeMocks([
      agent => ({
        [Symbol.asyncIterator]() {
          return {
            next(): Promise<IteratorResult<StreamPart>> {
              agent.submit({ ok: true });
              return Promise.reject(new Error('model stream timeout'));
            },
          };
        },
      }),
    ]);
    const runtime = await loadRuntime();

    const result = await runtime.run(
      createRuntimeInput(z.object({ ok: z.boolean() }), {
        agentOptions: { events: { onError: error => errors.push(error) } },
      }),
    );

    expect(result.data).toEqual({ ok: true });
    expect(errors).toEqual([]);
  });

  it('wires pi extensions into the harness settings', async () => {
    const extension = () => undefined;
    const state = installRuntimeMocks([
      agent => {
        agent.submit({ ok: true });
        return [];
      },
    ]);
    const runtime = await loadRuntime();

    await runtime.run(
      createRuntimeInput(z.object({ ok: z.boolean() }), {
        agentOptions: { pi: { extensions: [extension] } },
      }),
    );

    expect(state.piSettings[0]).toMatchObject({
      extensionFactories: [extension],
      activateAllExtensionTools: true,
    });
  });

  it('wires the agent-level thinking level into the harness settings', async () => {
    const state = installRuntimeMocks([
      agent => {
        agent.submit({ ok: true });
        return [];
      },
    ]);
    const runtime = await loadRuntime();

    await runtime.run(
      createRuntimeInput(z.object({ ok: z.boolean() }), {
        agentOptions: { pi: { thinkingLevel: 'high' } },
      }),
    );

    expect(state.piSettings[0]).toMatchObject({ thinkingLevel: 'high' });
  });

  it('lets a per-run thinking level override the agent-level one', async () => {
    const state = installRuntimeMocks([
      agent => {
        agent.submit({ ok: true });
        return [];
      },
    ]);
    const runtime = await loadRuntime();

    await runtime.run(
      createRuntimeInput(z.object({ ok: z.boolean() }), {
        agentOptions: { pi: { thinkingLevel: 'low' } },
        runOptions: { pi: { thinkingLevel: 'xhigh' } },
      }),
    );

    expect(state.piSettings[0]).toMatchObject({ thinkingLevel: 'xhigh' });
  });

  it('lets a per-run "off" override a non-off agent-level default', async () => {
    // The most regression-prone combination: an explicit 'off' must survive
    // both the `??` merge with the agent default and the truthy spread.
    const state = installRuntimeMocks([
      agent => {
        agent.submit({ ok: true });
        return [];
      },
    ]);
    const runtime = await loadRuntime();

    await runtime.run(
      createRuntimeInput(z.object({ ok: z.boolean() }), {
        agentOptions: { pi: { thinkingLevel: 'high' } },
        runOptions: { pi: { thinkingLevel: 'off' } },
      }),
    );

    expect(state.piSettings[0]).toMatchObject({ thinkingLevel: 'off' });
  });

  it('omits thinkingLevel from the settings when no level is set', async () => {
    const state = installRuntimeMocks([
      agent => {
        agent.submit({ ok: true });
        return [];
      },
    ]);
    const runtime = await loadRuntime();

    await runtime.run(createRuntimeInput(z.object({ ok: z.boolean() })));

    const settings = state.piSettings[0] as Record<string, unknown>;
    expect('thinkingLevel' in settings).toBe(false);
  });

  it('omits extension settings when no pi option is given', async () => {
    const state = installRuntimeMocks([
      agent => {
        agent.submit({ ok: true });
        return [];
      },
    ]);
    const runtime = await loadRuntime();

    await runtime.run(createRuntimeInput(z.object({ ok: z.boolean() })));

    const settings = state.piSettings[0] as Record<string, unknown>;
    expect('extensionFactories' in settings).toBe(false);
    expect('activateAllExtensionTools' in settings).toBe(false);
  });

  it('maps harness extension failures to ExtensionError', async () => {
    const errors: unknown[] = [];
    installRuntimeMocks([
      () => {
        throw Object.assign(new Error('keychain unavailable'), {
          name: 'PiExtensionError',
        });
      },
    ]);
    const runtime = await loadRuntime();
    const { ExtensionError } = await import('./errors.js');

    const failure = await runtime
      .run(
        createRuntimeInput(z.object({ ok: z.boolean() }), {
          agentOptions: { events: { onError: error => errors.push(error) } },
        }),
      )
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ExtensionError);
    expect(failure).not.toHaveProperty('usage');
    expect(errors).toEqual([failure]);
  });

  it('does not add usage to session-initialization failures', async () => {
    const errors: unknown[] = [];
    const initializationError = new Error('sandbox initialization failed');
    const state = installRuntimeMocks();
    state.createSessionError = initializationError;
    const runtime = await loadRuntime();

    const failure = await runtime
      .run(
        createRuntimeInput(z.object({ ok: z.boolean() }), {
          agentOptions: { events: { onError: error => errors.push(error) } },
        }),
      )
      .catch((error: unknown) => error);

    expect(failure).toBe(initializationError);
    expect(failure).not.toHaveProperty('usage');
    expect(errors).toEqual([]);
  });

  it('preserves an uninspectable Proxy rejected during session initialization', async () => {
    const target = new Error('sandbox initialization failed');
    const initializationError = new Proxy(target, {
      getPrototypeOf() {
        throw new Error('getPrototypeOf trap');
      },
    });
    const errors: unknown[] = [];
    const state = installRuntimeMocks();
    state.createSessionError = initializationError;
    const runtime = await loadRuntime();

    const failure = await runtime
      .run(
        createRuntimeInput(z.object({ ok: z.boolean() }), {
          agentOptions: { events: { onError: error => errors.push(error) } },
        }),
      )
      .catch((error: unknown) => error);

    expect(failure).toBe(initializationError);
    expect(Object.hasOwn(target, 'usage')).toBe(false);
    expect(errors).toEqual([]);
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

  it('maps shared credentials to a pi-ai credential store', async () => {
    let blob: AuthBlob = {
      anthropic: { type: 'api_key', key: 'stored-key' },
    };
    let writes = 0;
    const store: CredentialStore = {
      async withLock(_key, fn) {
        const { result, next } = await fn(blob);
        if (next !== undefined) {
          blob = next;
          writes += 1;
        }
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

    const settings = state.piSettings[0] as {
      piCredentials?: {
        read(providerId: string): Promise<unknown>;
        modify(
          providerId: string,
          fn: (current: unknown) => Promise<unknown>,
        ): Promise<unknown>;
        list(): Promise<readonly unknown[]>;
        delete(providerId: string): Promise<void>;
      };
    };
    const piCredentials = settings.piCredentials;
    if (!piCredentials) {
      throw new Error('expected piCredentials in the Pi settings');
    }
    // The adapter round-trips runcell's blob store through pi-ai's
    // per-provider CredentialStore contract: pre-seeded blob entries are
    // readable, writes persist through the lock, deletes drop the key.
    await expect(piCredentials.read('anthropic')).resolves.toEqual({
      type: 'api_key',
      key: 'stored-key',
    });
    const originalBlob = structuredClone(blob);
    await expect(
      piCredentials.modify('anthropic', () => Promise.resolve(undefined)),
    ).resolves.toEqual(blob['anthropic']);
    expect(blob).toEqual(originalBlob);
    expect(writes).toBe(0);

    const rotated = { type: 'api_key' as const, key: 'sk-tenant-a' };
    await piCredentials.modify('anthropic', () => Promise.resolve(rotated));
    await expect(piCredentials.read('anthropic')).resolves.toEqual(rotated);

    const keyless = { type: 'api_key' as const };
    await piCredentials.modify('amazon-bedrock', () =>
      Promise.resolve(keyless),
    );
    await expect(piCredentials.read('amazon-bedrock')).resolves.toEqual(
      keyless,
    );

    const oauth = {
      type: 'oauth' as const,
      access: 'access-token',
      refresh: 'refresh-token',
      expires: 123,
      accountId: 'account-1',
    };
    await piCredentials.modify('openai-codex', () => Promise.resolve(oauth));
    await expect(piCredentials.read('openai-codex')).resolves.toEqual(oauth);

    await expect(piCredentials.list()).resolves.toEqual([
      { providerId: 'anthropic', type: 'api_key' },
      { providerId: 'amazon-bedrock', type: 'api_key' },
      { providerId: 'openai-codex', type: 'oauth' },
    ]);
    await piCredentials.delete('anthropic');
    await expect(piCredentials.read('anthropic')).resolves.toBeUndefined();
  });

  it('supports concurrent shared credential reads through a queueing store', async () => {
    const blob: AuthBlob = {
      anthropic: { type: 'api_key', key: 'stored-key' },
    };
    let tail = Promise.resolve();
    const store: CredentialStore = {
      async withLock(_key, fn) {
        const previous = tail;
        let release!: () => void;
        tail = new Promise<void>(resolve => {
          release = resolve;
        });
        await previous;
        try {
          await new Promise(resolve => setTimeout(resolve, 1));
          return await fn(blob).then(({ result }) => result);
        } finally {
          release();
        }
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

    const piCredentials = (
      state.piSettings[0] as {
        piCredentials?: { read(providerId: string): Promise<unknown> };
      }
    ).piCredentials;
    if (!piCredentials) {
      throw new Error('expected piCredentials in the Pi settings');
    }

    await expect(
      Promise.all(
        Array.from({ length: 5 }, () => piCredentials.read('anthropic')),
      ),
    ).resolves.toEqual(
      Array.from({ length: 5 }, () => ({
        type: 'api_key',
        key: 'stored-key',
      })),
    );
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

  it('never lets throwing event callbacks break the run', async () => {
    installRuntimeMocks([
      agent => {
        agent.submit({ ok: true });
        return [
          { type: 'text-delta', text: 'hello' },
          { type: 'finish', finishReason: 'stop' },
        ];
      },
    ]);
    const runtime = await loadRuntime();

    const result = await runtime.run(
      createRuntimeInput(z.object({ ok: z.boolean() }), {
        agentOptions: {
          events: {
            onText: () => {
              throw new Error('onText boom');
            },
            onFinish: () => {
              throw new Error('onFinish boom');
            },
          },
        },
      }),
    );

    expect(result.data).toEqual({ ok: true });
    expect(result.text).toBe('hello');
    expect(result.finishReason).toBe('stop');
  });

  it('adds reconciled session usage to TurnError and emits that same error', async () => {
    const agentErrors: unknown[] = [];
    const runErrors: unknown[] = [];
    const state = installRuntimeMocks([
      agent => {
        state.sessionUsageTotals.set(getTestSession(agent), {
          inputTokens: 100,
          outputTokens: 40,
          cacheReadTokens: 30,
          cacheWriteTokens: 10,
          costUsd: 0.42,
        });
        return [
          { type: 'text-delta', text: 'partial' },
          {
            type: 'finish',
            finishReason: 'error',
            totalUsage: { inputTokens: 1, outputTokens: 1 },
            providerMetadata: { pi: { costUsd: 9 } },
          },
          { type: 'error', error: new Error('400 provider says no') },
        ];
      },
    ]);
    const runtime = await loadRuntime();
    const { TurnError } = await import('./errors.js');

    const failure = await runtime
      .run(
        createRuntimeInput(z.object({ ok: z.boolean() }), {
          agentOptions: {
            events: { onError: error => agentErrors.push(error) },
          },
          runOptions: {
            events: { onError: error => runErrors.push(error) },
          },
        }),
      )
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(TurnError);
    expect((failure as Error).message).toBe('400 provider says no');
    expect((failure as Error).cause).toBeInstanceOf(Error);
    expect((failure as InstanceType<typeof TurnError>).usage).toEqual({
      inputTokens: 100,
      outputTokens: 40,
      cacheReadTokens: 30,
      cacheWriteTokens: 10,
      totalTokens: 180,
      costUsd: 0.42,
      costMeasured: true,
    });
    expect(agentErrors).toEqual([failure]);
    expect(runErrors).toEqual([failure]);
  });

  it('fails a plain turn on a terminal stream error instead of returning empty text', async () => {
    installRuntimeMocks([() => [{ type: 'error', error: 'quota exhausted' }]]);
    const runtime = await loadRuntime();
    const { TurnError } = await import('./errors.js');

    await expect(
      runtime.run({
        agentOptions: { model: 'anthropic/test' },
        config: {
          model: 'anthropic/test',
          systemPrompt: undefined,
          credentials: { mode: 'apiKeys', keys: { anthropic: 'test-key' } },
          toolNames: [],
          sandbox: { type: 'virtual' },
          maxRepairs: 1,
          extensions: [],
          thinkingLevel: undefined,
        },
        runOptions: { prompt: 'say hi' },
      }),
    ).rejects.toBeInstanceOf(TurnError);
  });

  it('wraps an unexpected post-session iterator error with reconciled usage', async () => {
    const original = new Error('iterator failed');
    const errors: unknown[] = [];
    const state = installRuntimeMocks([
      agent => ({
        [Symbol.asyncIterator]() {
          return {
            next(): Promise<IteratorResult<StreamPart>> {
              state.sessionUsageTotals.set(getTestSession(agent), {
                inputTokens: 8,
                outputTokens: 2,
                cacheReadTokens: 1,
                cacheWriteTokens: 0,
                costUsd: 0.03,
              });
              return Promise.reject(original);
            },
          };
        },
      }),
    ]);
    const runtime = await loadRuntime();

    const failure = await runtime
      .run(
        createRuntimeInput(z.object({ ok: z.boolean() }), {
          agentOptions: { events: { onError: error => errors.push(error) } },
        }),
      )
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).name).toBe('TurnError');
    expect((failure as Error).message).toBe('iterator failed');
    expect((failure as Error).cause).toBe(original);
    expect((failure as Error & { usage: unknown }).usage).toEqual({
      inputTokens: 8,
      outputTokens: 2,
      cacheReadTokens: 1,
      cacheWriteTokens: 0,
      totalTokens: 11,
      costUsd: 0.03,
      costMeasured: true,
    });
    // The original error object is never mutated.
    expect('usage' in original).toBe(false);
    expect(errors).toEqual([failure]);
  });

  it('wraps without overwriting an existing third-party usage property', async () => {
    const thirdPartyUsage = { requests: 1 };
    const original = Object.assign(new Error('iterator failed'), {
      usage: thirdPartyUsage,
    });
    const errors: unknown[] = [];
    const state = installRuntimeMocks([
      agent => ({
        [Symbol.asyncIterator]() {
          return {
            next(): Promise<IteratorResult<StreamPart>> {
              state.sessionUsageTotals.set(getTestSession(agent), {
                inputTokens: 9,
                outputTokens: 3,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                costUsd: 0.03,
              });
              return Promise.reject(original);
            },
          };
        },
      }),
    ]);
    const runtime = await loadRuntime();
    const { TurnError } = await import('./errors.js');

    const failure = await runtime
      .run(
        createRuntimeInput(z.object({ ok: z.boolean() }), {
          agentOptions: { events: { onError: error => errors.push(error) } },
        }),
      )
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(TurnError);
    expect((failure as Error).cause).toBe(original);
    expect(original.usage).toBe(thirdPartyUsage);
    expect((failure as InstanceType<typeof TurnError>).usage).toEqual({
      inputTokens: 9,
      outputTokens: 3,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 12,
      costUsd: 0.03,
      costMeasured: true,
    });
    expect(errors).toEqual([failure]);
  });

  it('wraps a non-enrichable post-session rejection in TurnError', async () => {
    const original = 'iterator failed';
    const errors: unknown[] = [];
    const state = installRuntimeMocks([
      agent => ({
        [Symbol.asyncIterator]() {
          return {
            next(): Promise<IteratorResult<StreamPart>> {
              state.sessionUsageTotals.set(getTestSession(agent), {
                inputTokens: 5,
                outputTokens: 2,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                costUsd: 0,
              });
              // Deliberately exercise normalization of a primitive rejection.
              // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
              return Promise.reject(original);
            },
          };
        },
      }),
    ]);
    const runtime = await loadRuntime();
    const { TurnError } = await import('./errors.js');

    const failure = await runtime
      .run(
        createRuntimeInput(z.object({ ok: z.boolean() }), {
          agentOptions: { events: { onError: error => errors.push(error) } },
        }),
      )
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(TurnError);
    expect((failure as Error).cause).toBe(original);
    expect((failure as InstanceType<typeof TurnError>).usage).toEqual({
      inputTokens: 5,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 7,
      costUsd: 0,
      costMeasured: false,
    });
    expect(errors).toEqual([failure]);
  });

  it('normalizes hostile Proxy rejections without leaking inspection traps', async () => {
    const existingUsage = { requests: 1 };
    // Traps that fire during inspection (instanceof, message) degrade the
    // wrapper's message to the generic fallback; traps on properties the
    // wrap policy never touches leave the original message readable.
    const cases: {
      label: string;
      original: unknown;
      expectedMessage: string;
    }[] = [
      {
        label: 'instanceof',
        expectedMessage: 'Agent turn failed.',
        original: new Proxy(new Error('hidden'), {
          getPrototypeOf() {
            throw new Error('getPrototypeOf trap');
          },
        }),
      },
      {
        label: 'name',
        expectedMessage: 'hidden',
        original: new Proxy(new Error('hidden'), {
          get(target, property, receiver) {
            if (property === 'name') throw new Error('name trap');
            return Reflect.get(target, property, receiver) as unknown;
          },
        }),
      },
      {
        label: 'cause',
        expectedMessage: 'hidden',
        original: new Proxy(new Error('hidden'), {
          get(target, property, receiver) {
            if (property === 'cause') throw new Error('cause trap');
            return Reflect.get(target, property, receiver) as unknown;
          },
        }),
      },
      {
        label: 'message',
        expectedMessage: 'Agent turn failed.',
        original: new Proxy(
          Object.assign(new Error('hidden'), { usage: existingUsage }),
          {
            get(target, property, receiver) {
              if (property === 'message') throw new Error('message trap');
              return Reflect.get(target, property, receiver) as unknown;
            },
          },
        ),
      },
      {
        label: 'property check',
        expectedMessage: 'hidden',
        original: new Proxy(new Error('hidden'), {
          has() {
            throw new Error('has trap');
          },
        }),
      },
      {
        label: 'definition',
        expectedMessage: 'hidden',
        original: new Proxy(new Error('hidden'), {
          defineProperty() {
            throw new Error('defineProperty trap');
          },
        }),
      },
      {
        label: 'descriptor',
        expectedMessage: 'hidden',
        original: new Proxy(new Error('hidden'), {
          getOwnPropertyDescriptor() {
            throw new Error('getOwnPropertyDescriptor trap');
          },
        }),
      },
      {
        label: 'usage access',
        expectedMessage: 'hidden',
        original: new Proxy(new Error('hidden'), {
          get(target, property, receiver) {
            if (property === 'usage') throw new Error('usage trap');
            return Reflect.get(target, property, receiver) as unknown;
          },
        }),
      },
    ];
    const errors: unknown[] = [];
    const state = installRuntimeMocks(
      cases.map(({ original }) => agent => ({
        [Symbol.asyncIterator]() {
          return {
            next(): Promise<IteratorResult<StreamPart>> {
              state.sessionUsageTotals.set(getTestSession(agent), {
                inputTokens: 6,
                outputTokens: 2,
                cacheReadTokens: 1,
                cacheWriteTokens: 0,
                costUsd: 0.04,
              });
              // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
              return Promise.reject(original);
            },
          };
        },
      })),
    );
    const runtime = await loadRuntime();
    const { TurnError } = await import('./errors.js');

    for (const [index, testCase] of cases.entries()) {
      const failure = await runtime
        .run(
          createRuntimeInput(z.object({ ok: z.boolean() }), {
            agentOptions: { events: { onError: error => errors.push(error) } },
          }),
        )
        .catch((error: unknown) => error);

      expect(failure, testCase.label).toBeInstanceOf(TurnError);
      expect((failure as Error).message, testCase.label).toBe(
        testCase.expectedMessage,
      );
      expect((failure as Error).cause, testCase.label).toBe(testCase.original);
      expect(
        (failure as InstanceType<typeof TurnError>).usage,
        testCase.label,
      ).toEqual({
        inputTokens: 6,
        outputTokens: 2,
        cacheReadTokens: 1,
        cacheWriteTokens: 0,
        totalTokens: 9,
        costUsd: 0.04,
        costMeasured: true,
      });
      expect(errors[index], testCase.label).toBe(failure);
    }
    expect(errors).toHaveLength(cases.length);
  });

  it('guards String conversion of a hostile terminal error cause', async () => {
    const original = new Proxy(
      {},
      {
        get(target, property, receiver) {
          if (
            property === Symbol.toPrimitive ||
            property === 'valueOf' ||
            property === 'toString'
          ) {
            throw new Error('String trap');
          }
          return Reflect.get(target, property, receiver) as unknown;
        },
      },
    );
    const errors: unknown[] = [];
    const state = installRuntimeMocks([
      agent => {
        state.sessionUsageTotals.set(getTestSession(agent), {
          inputTokens: 4,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: 0.01,
        });
        return [{ type: 'error', error: original }];
      },
    ]);
    const runtime = await loadRuntime();
    const { TurnError } = await import('./errors.js');

    const failure = await runtime
      .run(
        createRuntimeInput(z.object({ ok: z.boolean() }), {
          agentOptions: { events: { onError: error => errors.push(error) } },
        }),
      )
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(TurnError);
    expect((failure as Error).message).toBe('Agent turn failed.');
    expect((failure as Error).cause).toBe(original);
    expect((failure as InstanceType<typeof TurnError>).usage).toEqual({
      inputTokens: 4,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 5,
      costUsd: 0.01,
      costMeasured: true,
    });
    expect(errors).toEqual([failure]);
  });

  it('falls back to finish-part usage when session totals are unavailable on failure', async () => {
    const original = new Error('failed after finish');
    installRuntimeMocks([
      () => ({
        async *[Symbol.asyncIterator]() {
          await Promise.resolve();
          yield {
            type: 'finish',
            finishReason: 'error',
            totalUsage: {
              inputTokens: 14,
              inputTokenDetails: {
                noCacheTokens: 10,
                cacheReadTokens: 3,
                cacheWriteTokens: 1,
              },
              outputTokens: 4,
              totalTokens: 18,
            },
            providerMetadata: { pi: { costUsd: 0.05 } },
          };
          throw original;
        },
      }),
    ]);
    const runtime = await loadRuntime();

    const failure = await runtime
      .run(createRuntimeInput(z.object({ ok: z.boolean() })))
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).name).toBe('TurnError');
    expect((failure as Error).cause).toBe(original);
    expect((failure as Error & { usage: unknown }).usage).toEqual({
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 3,
      cacheWriteTokens: 1,
      totalTokens: 18,
      costUsd: 0.05,
      costMeasured: true,
    });
    // The original error object is never mutated.
    expect('usage' in original).toBe(false);
  });

  it('invokes both agent-level and per-run event callbacks', async () => {
    const agentTexts: string[] = [];
    const runTexts: string[] = [];
    let runFinishes = 0;
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    installRuntimeMocks([
      agent => {
        agent.submit({ ok: true });
        return [
          { type: 'text-delta', text: 'hi' },
          { type: 'finish', finishReason: 'stop' },
        ];
      },
    ]);
    const runtime = await loadRuntime();

    try {
      await runtime.run(
        createRuntimeInput(z.object({ ok: z.boolean() }), {
          agentOptions: {
            events: {
              // An async rejecting listener (as a JS consumer would pass
              // despite the void signature) is still best-effort.
              // eslint-disable-next-line @typescript-eslint/no-misused-promises
              onText: delta => {
                agentTexts.push(delta);
                return Promise.reject(new Error('async boom'));
              },
              // A throwing agent-level listener must not starve the run-level one.
              onFinish: () => {
                throw new Error('agent onFinish boom');
              },
            },
          },
          runOptions: {
            events: {
              onText: delta => runTexts.push(delta),
              onFinish: () => {
                runFinishes += 1;
              },
            },
          },
        }),
      );
      await new Promise(resolve => setImmediate(resolve));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }

    expect(agentTexts).toEqual(['hi']);
    expect(runTexts).toEqual(['hi']);
    expect(runFinishes).toBe(1);
    expect(unhandled).toEqual([]);
  });

  it('propagates the original error when onError itself throws', async () => {
    installRuntimeMocks([() => []]);
    const runtime = await loadRuntime();
    const { IncompleteResultError } = await import('./errors.js');

    await expect(
      runtime.run(
        createRuntimeInput(z.object({ ok: z.boolean() }), {
          agentOptions: {
            events: {
              onError: () => {
                throw new Error('onError boom');
              },
            },
          },
          config: { maxRepairs: 0 },
        }),
      ),
    ).rejects.toBeInstanceOf(IncompleteResultError);
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

  it('streams text deltas and resolves the final result', async () => {
    installRuntimeMocks([
      () => [
        { type: 'text-delta', text: 'hel' },
        { type: 'text-delta', text: 'lo' },
        { type: 'finish', finishReason: 'stop' },
      ],
    ]);
    const { createAgent } = await import('./create-agent.js');
    const runtime = await loadRuntime();
    const agent = createAgent(
      { model: 'anthropic/test' },
      {
        nodeEnv: 'development',
        runtime,
        // apiKeys so the mocked Pi settings path is exercised
      },
    );

    const { textStream, result } = agent.stream({ prompt: 'say hi' });
    const deltas: string[] = [];
    for await (const delta of textStream) {
      deltas.push(delta);
    }
    const final = await result;

    expect(deltas).toEqual(['hel', 'lo']);
    expect(final.text).toBe('hello');
    expect(final.data).toBeUndefined();
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
        systemPrompt: undefined,
        credentials: { mode: 'apiKeys', keys: { anthropic: 'test-key' } },
        toolNames: [],
        sandbox: { type: 'virtual' },
        maxRepairs: 1,
        extensions: [],
        thinkingLevel: undefined,
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

  it('accumulates per-turn usage and cost across repair turns', async () => {
    const finishPart = (input: number, output: number, costUsd: number) => ({
      type: 'finish',
      finishReason: 'stop',
      // Mirrors the harness's normalized (flat) stream shape: `asLanguageModelUsage`
      // flattens the adapter's V4 usage and `harnessMetadata` arrives renamed
      // to `providerMetadata`.
      totalUsage: {
        inputTokens: input + 30 + 10,
        inputTokenDetails: {
          noCacheTokens: input,
          cacheReadTokens: 30,
          cacheWriteTokens: 10,
        },
        outputTokens: output,
        outputTokenDetails: {
          textTokens: undefined,
          reasoningTokens: undefined,
        },
        totalTokens: input + 30 + 10 + output,
      },
      providerMetadata: { pi: { costUsd } },
    });
    installRuntimeMocks([
      () => [{ type: 'text-delta', text: 'first ' }, finishPart(100, 20, 0.5)],
      agent => {
        agent.submit({ ok: true });
        return [
          { type: 'text-delta', text: 'second' },
          finishPart(200, 40, 0.25),
        ];
      },
    ]);
    const runtime = await loadRuntime();

    const result = await runtime.run(
      createRuntimeInput(z.object({ ok: z.boolean() }), {
        config: { maxRepairs: 1 },
      }),
    );

    expect(result.data).toEqual({ ok: true });
    expect(result.usage).toEqual({
      inputTokens: 300,
      outputTokens: 60,
      cacheReadTokens: 60,
      cacheWriteTokens: 20,
      totalTokens: 440,
      costUsd: 0.75,
      costMeasured: true,
    });
  });

  it('reconciles usage from adapter session totals when stream metadata is lost', async () => {
    // Simulates a synthetic harness completion path: the finish part carries
    // no usage or cost metadata, but the adapter's per-session totals — fed
    // by Pi's own stats — recorded the turn. The run must report the totals
    // delta, not zeros.
    const state = installRuntimeMocks([
      agent => {
        state.sessionUsageTotals.set(getTestSession(agent), {
          inputTokens: 100,
          outputTokens: 40,
          cacheReadTokens: 30,
          cacheWriteTokens: 10,
          costUsd: 0.42,
        });
        agent.submit({ ok: true });
        return [
          { type: 'text-delta', text: 'done' },
          // Metadata-free synthetic finish.
          { type: 'finish', finishReason: 'stop' },
        ];
      },
    ]);
    const runtime = await loadRuntime();

    const result = await runtime.run(
      createRuntimeInput(z.object({ ok: z.boolean() })),
    );

    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 40,
      cacheReadTokens: 30,
      cacheWriteTokens: 10,
      totalTokens: 180,
      costUsd: 0.42,
      costMeasured: true,
    });
  });

  it('reports costMeasured: false for token usage without attributable cost', async () => {
    const state = installRuntimeMocks([
      agent => {
        state.sessionUsageTotals.set(getTestSession(agent), {
          inputTokens: 500,
          outputTokens: 200,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: 0,
        });
        agent.submit({ ok: true });
        return [{ type: 'finish', finishReason: 'stop' }];
      },
    ]);
    const runtime = await loadRuntime();

    const result = await runtime.run(
      createRuntimeInput(z.object({ ok: z.boolean() })),
    );

    expect(result.usage.totalTokens).toBe(700);
    expect(result.usage.costUsd).toBe(0);
    expect(result.usage.costMeasured).toBe(false);
  });

  it('diffs adapter totals against the run-start baseline on resumed sessions', async () => {
    const state = installRuntimeMocks([
      agent => {
        // Totals already carry a prior run's usage at run start; the stream
        // script bumps them by this run's consumption.
        const prior = state.sessionUsageTotals.get(getTestSession(agent));
        state.sessionUsageTotals.set(getTestSession(agent), {
          inputTokens: (prior?.inputTokens ?? 0) + 10,
          outputTokens: (prior?.outputTokens ?? 0) + 5,
          cacheReadTokens: prior?.cacheReadTokens ?? 0,
          cacheWriteTokens: prior?.cacheWriteTokens ?? 0,
          costUsd: (prior?.costUsd ?? 0) + 0.01,
        });
        agent.submit({ ok: true });
        return [{ type: 'finish', finishReason: 'stop' }];
      },
    ]);
    state.sessionUsageTotals.set('test-session', {
      inputTokens: 1000,
      outputTokens: 400,
      cacheReadTokens: 50,
      cacheWriteTokens: 20,
      costUsd: 9.99,
    });
    const runtime = await loadRuntime();

    const result = await runtime.run(
      createRuntimeInput(z.object({ ok: z.boolean() })),
    );

    expect(result.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 15,
      costUsd: expect.closeTo(0.01, 6) as number,
      costMeasured: true,
    });
  });

  it('registers the built-in readPdfPages tool when a PDF is seeded', async () => {
    const { tinyPdf } = await import('./pdf-pages.test.js');
    const state = installRuntimeMocks([
      agent => {
        agent.submit({ ok: true });
        return [{ type: 'finish', finishReason: 'stop' }];
      },
    ]);
    const runtime = await loadRuntime();

    await runtime.run(
      createRuntimeInput(z.object({ ok: z.boolean() }), {
        runOptions: {
          prompt: 'read the invoice',
          files: [
            {
              path: 'attachments/factura.pdf',
              bytes: tinyPdf(),
              mediaType: 'application/pdf',
            },
          ],
        },
      }),
    );

    const tool = state.instances[0]?.settings.tools['readPdfPages'];
    expect(tool).toBeDefined();
    expect(tool?.description).toContain('attachments/factura.pdf');
  });

  it('does not register readPdfPages without a seeded PDF', async () => {
    const state = installRuntimeMocks([
      agent => {
        agent.submit({ ok: true });
        return [{ type: 'finish', finishReason: 'stop' }];
      },
    ]);
    const runtime = await loadRuntime();

    await runtime.run(createRuntimeInput(z.object({ ok: z.boolean() })));
    expect(state.instances[0]?.settings.tools['readPdfPages']).toBeUndefined();
  });

  it('resets finish reason before a terminal repair submission', async () => {
    const finishes: FinishEvent[] = [];
    installRuntimeMocks([
      () => [{ type: 'finish', finishReason: 'length' }],
      agent => ({
        async *[Symbol.asyncIterator]() {
          yield { type: 'text-delta', text: '' };
          await agent.submitAsync({ ok: true });
        },
      }),
    ]);
    const runtime = await loadRuntime();

    const result = await runtime.run(
      createRuntimeInput(z.object({ ok: z.boolean() }), {
        agentOptions: {
          events: { onFinish: event => finishes.push(event) },
        },
        config: { maxRepairs: 1 },
      }),
    );

    expect(result.data).toEqual({ ok: true });
    expect(result.finishReason).toBe('stop');
    expect(finishes).toEqual([
      { sessionId: 'test-session', finishReason: 'length' },
      { sessionId: 'test-session', finishReason: 'stop' },
    ]);
  });

  it('adds reconciled usage across repair turns to IncompleteResultError', async () => {
    const errors: unknown[] = [];
    const state = installRuntimeMocks([
      agent => {
        state.sessionUsageTotals.set(getTestSession(agent), {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 2,
          cacheWriteTokens: 1,
          costUsd: 0.02,
        });
        return [];
      },
      agent => {
        state.sessionUsageTotals.set(getTestSession(agent), {
          inputTokens: 30,
          outputTokens: 12,
          cacheReadTokens: 5,
          cacheWriteTokens: 3,
          costUsd: 0.07,
        });
        return [];
      },
    ]);
    const runtime = await loadRuntime();
    const { IncompleteResultError } = await import('./errors.js');

    const failure = await runtime
      .run(
        createRuntimeInput(z.object({ ok: z.boolean() }), {
          agentOptions: { events: { onError: error => errors.push(error) } },
          config: { maxRepairs: 1 },
        }),
      )
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(IncompleteResultError);
    expect(
      (failure as InstanceType<typeof IncompleteResultError>).usage,
    ).toEqual({
      inputTokens: 30,
      outputTokens: 12,
      cacheReadTokens: 5,
      cacheWriteTokens: 3,
      totalTokens: 50,
      costUsd: 0.07,
      costMeasured: true,
    });
    expect(errors).toEqual([failure]);
  });

  it('throws when no valid result is submitted after repairs', async () => {
    const errors: unknown[] = [];
    const state = installRuntimeMocks([() => []]);
    const runtime = await loadRuntime();
    const { IncompleteResultError } = await import('./errors.js');

    const failure = await runtime
      .run(
        createRuntimeInput(z.object({ ok: z.boolean() }), {
          agentOptions: { events: { onError: error => errors.push(error) } },
          config: { maxRepairs: 0 },
        }),
      )
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(IncompleteResultError);
    expect(
      (failure as InstanceType<typeof IncompleteResultError>).usage,
    ).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      costMeasured: true,
    });
    expect(errors).toEqual([failure]);
    expect(state.instances[0]?.session?.destroyCount).toBe(1);
  });
});

async function loadRuntime(): Promise<RuncellRuntime> {
  const { defaultRuntime } = await import('./runtime.js');
  return defaultRuntime;
}

type CountSchema = StandardSchemaV1<{ count: number }, { doubled: number }>;

function createStandardSchema(options: {
  withJsonSchema: true;
  async: boolean;
}): CountSchema & StandardJSONSchemaV1;
function createStandardSchema(options: {
  withJsonSchema: false;
  async: boolean;
}): CountSchema;
function createStandardSchema(options: {
  withJsonSchema: boolean;
  async: boolean;
}): CountSchema {
  const validate = (
    value: unknown,
  ): StandardSchemaV1.Result<{
    doubled: number;
  }> => {
    if (
      typeof value !== 'object' ||
      value === null ||
      typeof (value as { count?: unknown }).count !== 'number'
    ) {
      return { issues: [{ message: 'count must be a number' }] };
    }
    return { value: { doubled: (value as { count: number }).count * 2 } };
  };
  const standard = {
    version: 1 as const,
    vendor: 'runtime-test',
    validate: options.async
      ? async (value: unknown) => {
          await Promise.resolve();
          return validate(value);
        }
      : validate,
  };
  if (!options.withJsonSchema) {
    return { '~standard': standard };
  }
  return {
    '~standard': {
      ...standard,
      jsonSchema: {
        input: () => ({ type: 'object' }),
        output: () => ({ type: 'object' }),
      },
    },
  } as CountSchema & StandardJSONSchemaV1;
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
      systemPrompt: agentOptions.systemPrompt,
      credentials: { mode: 'apiKeys', keys: { anthropic: 'test-key' } },
      toolNames: Object.keys(agentOptions.tools ?? {}),
      sandbox: { type: 'virtual' },
      maxRepairs: 1,
      extensions: agentOptions.pi?.extensions ?? [],
      thinkingLevel: agentOptions.pi?.thinkingLevel,
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

    sandboxSettings: [],
    sandboxSession: new TestSandboxSession(),
    scripts: [...scripts],
    sessionUsageTotals: new Map(),
    createSessionError: undefined,
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
        if (state.createSessionError !== undefined) {
          // Deliberately support arbitrary harness initialization rejections.
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          return Promise.reject(state.createSessionError);
        }
        const session = new TestHarnessSession(
          options.sessionId ?? 'test-session',
        );
        const seededTotals = state.sessionUsageTotals.get(session.sessionId);
        if (seededTotals) {
          state.sessionUsageTotals.delete(session.sessionId);
          state.sessionUsageTotals.set(session, seededTotals);
        }
        this.session = session;
        if (this.settings.sandboxConfig?.onSession) {
          const request: SandboxSessionRequest = {
            session: state.sandboxSession,
            sessionWorkDir: '/work',
          };
          if (options.abortSignal) {
            request.abortSignal = options.abortSignal;
          }
          await this.settings.sandboxConfig.onSession(request);
        }
        return session;
      }

      stream(
        input: StreamInput,
      ): Promise<{ stream: AsyncIterable<StreamPart> }> {
        this.streamCalls.push(input);
        const script = state.scripts.shift();
        const output = script?.(this, input) ?? [];
        const stream = isAsyncIterable(output)
          ? output
          : toAsyncIterable(output);
        return Promise.resolve({ stream });
      }

      submit(input: unknown): void {
        void this.submitAsync(input);
      }

      async submitAsync(input: unknown): Promise<void> {
        const submitResult = this.settings.tools['submitResult'];
        expect(submitResult).toBeDefined();
        try {
          await submitResult?.execute(input);
        } catch {
          // Harness turns tool execution failures into tool-error results so
          // the model can correct the call in the same turn.
        }
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
    PI_SILENT_TURN_ABORT_REASON: Symbol.for('runcell.pi.silent-turn-abort'),
    createPi(settings: unknown) {
      state.piSettings.push(settings);
      return { settings };
    },
    getPiSessionUsageTotals(session: TestHarnessSession) {
      return state.sessionUsageTotals.get(session);
    },
  }));

  vi.doMock('@earendil-works/pi-coding-agent', () => ({
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

function getTestSession(agent: TestHarnessAgent): TestHarnessSession {
  if (!agent.session) throw new Error('Expected a created harness session.');
  return agent.session;
}

type StreamScript = (
  agent: TestHarnessAgent,
  input: StreamInput,
) => StreamPart[] | AsyncIterable<StreamPart>;

function isAsyncIterable(
  value: StreamPart[] | AsyncIterable<StreamPart>,
): value is AsyncIterable<StreamPart> {
  return Symbol.asyncIterator in value;
}

interface StreamPart {
  type: string;
  [key: string]: unknown;
}

interface TestState {
  instances: TestHarnessAgent[];
  piSettings: unknown[];

  sandboxSettings: (SandboxSettings | undefined)[];
  sandboxSession: TestSandboxSession;
  scripts: StreamScript[];
  /** Mocked adapter usage totals, keyed by exact session object after init. */
  sessionUsageTotals: Map<TestHarnessSession | string, SessionUsageTotals>;
  createSessionError: unknown;
}

interface SessionUsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

interface TestHarnessAgent {
  settings: HarnessSettings;
  streamCalls: StreamInput[];
  session: TestHarnessSession | undefined;
  submit(input: unknown): void;
  submitAsync(input: unknown): Promise<void>;
}

interface HarnessSettings {
  instructions: string;
  tools: Record<string, ToolLike>;
  sandboxConfig?: {
    onSession?: (request: SandboxSessionRequest) => void | Promise<void>;
  };
}

interface ToolLike {
  description?: string;
  inputSchema: FlexibleSchema;
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
