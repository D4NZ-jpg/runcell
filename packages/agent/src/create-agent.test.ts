import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAgent, resolveAgentConfig } from './create-agent.js';
import { InvalidOptionError } from './errors.js';
import type { RuncellRuntime, RuntimeRunInput } from './runtime.js';

describe('resolveAgentConfig', () => {
  it('resolves a minimal config with defaults', () => {
    const config = resolveAgentConfig(
      { model: 'anthropic/claude-sonnet-4-5' },
      { nodeEnv: 'development' },
    );
    expect(config).toEqual({
      model: 'anthropic/claude-sonnet-4-5',
      systemPrompt: undefined,
      credentials: { mode: 'env' },
      toolNames: [],
      sandbox: { type: 'virtual' },
      maxRepairs: 1,
      extensions: [],
      thinkingLevel: undefined,
    });
  });

  it('rejects an empty model', () => {
    expect(() => resolveAgentConfig({ model: '  ' })).toThrow(
      InvalidOptionError,
    );
  });

  it('rejects a negative maxRepairs', () => {
    expect(() => resolveAgentConfig({ model: 'm', maxRepairs: -1 })).toThrow(
      InvalidOptionError,
    );
  });

  it('rejects a relative host sandbox rootDir', () => {
    expect(() =>
      resolveAgentConfig({
        model: 'm',
        sandbox: {
          type: 'host',
          rootDir: 'workspace',
          isolation: 'external',
        },
      }),
    ).toThrow(InvalidOptionError);
  });

  it('resolves a host sandbox rootDir', () => {
    const config = resolveAgentConfig({
      model: 'm',
      sandbox: {
        type: 'host',
        rootDir: '/tmp/runcell-workspace',
        isolation: 'external',
      },
    });

    expect(config.sandbox).toEqual({
      type: 'host',
      rootDir: '/tmp/runcell-workspace',
      isolation: 'external',
    });
  });

  it('collects tool names', () => {
    const config = resolveAgentConfig(
      {
        model: 'm',
        tools: {
          lookup: {
            description: 'Look something up',
            schema: z.object({ id: z.string() }),
            execute: () => ({ ok: true }),
          },
        },
      },
      { nodeEnv: 'development' },
    );
    expect(config.toolNames).toEqual(['lookup']);
  });

  it.each([
    'read',
    'write',
    'edit',
    'bash',
    'grep',
    'glob',
    'ls',
    'submitResult',
    'fileChange',
  ])('rejects reserved tool name %s', name => {
    expect(() =>
      resolveAgentConfig(
        {
          model: 'm',
          tools: {
            [name]: {
              description: 'Reserved tool',
              schema: z.object({}),
              execute: () => ({ ok: true }),
            },
          },
        },
        { nodeEnv: 'development' },
      ),
    ).toThrow(InvalidOptionError);
  });

  it('passes pi extensions through and rejects non-function entries', () => {
    const extension = () => undefined;
    expect(
      resolveAgentConfig(
        { model: 'm', pi: { extensions: [extension] } },
        { nodeEnv: 'development' },
      ).extensions,
    ).toEqual([extension]);

    expect(() =>
      resolveAgentConfig(
        { model: 'm', pi: { extensions: ['nope' as never] } },
        { nodeEnv: 'development' },
      ),
    ).toThrow(InvalidOptionError);
  });

  it('accepts every valid pi thinking level and rejects unknown ones', () => {
    for (const level of [
      'off',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
    ] as const) {
      expect(
        resolveAgentConfig(
          { model: 'm', pi: { thinkingLevel: level } },
          { nodeEnv: 'development' },
        ).thinkingLevel,
      ).toBe(level);
    }

    expect(
      resolveAgentConfig({ model: 'm' }, { nodeEnv: 'development' })
        .thinkingLevel,
    ).toBeUndefined();

    expect(() =>
      resolveAgentConfig(
        { model: 'm', pi: { thinkingLevel: 'ultra' as never } },
        { nodeEnv: 'development' },
      ),
    ).toThrow(InvalidOptionError);
  });

  it('allows non-runtime tool names', () => {
    const config = resolveAgentConfig(
      {
        model: 'm',
        tools: {
          webSearch: {
            description: 'Search the web',
            schema: z.object({ query: z.string() }),
            execute: () => ({ ok: true }),
          },
        },
      },
      { nodeEnv: 'development' },
    );
    expect(config.toolNames).toEqual(['webSearch']);
  });
});

describe('createAgent', () => {
  it('validates run options before execution', async () => {
    const runtime = createRuntimeMock();
    const agent = createAgent(
      { model: 'anthropic/claude-sonnet-4-5' },
      { nodeEnv: 'development', runtime },
    );

    const runFailure = await agent
      .run({ prompt: '   ', schema: z.object({}) })
      .catch((error: unknown) => error);
    expect(runFailure).toBeInstanceOf(InvalidOptionError);
    expect(runFailure).not.toHaveProperty('usage');

    const streamFailure = await agent
      .stream({ prompt: '   ', schema: z.object({}) })
      .result.catch((error: unknown) => error);
    expect(streamFailure).toBeInstanceOf(InvalidOptionError);
    expect(streamFailure).not.toHaveProperty('usage');
    expect(runtime.calls).toHaveLength(0);
  });

  it('rejects an invalid per-run pi thinking level', async () => {
    const runtime = createRuntimeMock();
    const agent = createAgent(
      { model: 'anthropic/claude-sonnet-4-5' },
      { nodeEnv: 'development', runtime },
    );

    await expect(
      agent.run({
        prompt: 'do a thing',
        pi: { thinkingLevel: 'turbo' as never },
      }),
    ).rejects.toBeInstanceOf(InvalidOptionError);
    expect(runtime.calls).toHaveLength(0);
  });

  it('rejects schemas that do not implement Standard Schema', async () => {
    const runtime = createRuntimeMock();
    const agent = createAgent(
      { model: 'anthropic/claude-sonnet-4-5' },
      { nodeEnv: 'development', runtime },
    );

    await expect(
      agent.run({ prompt: 'do a thing', schema: {} as never }),
    ).rejects.toBeInstanceOf(InvalidOptionError);
    expect(runtime.calls).toHaveLength(0);
  });

  it('delegates valid runs to the runtime', async () => {
    const schema = z.object({ ok: z.boolean() });
    const runtime = createRuntimeMock({ data: { ok: true } });
    const agent = createAgent(
      { model: 'anthropic/claude-sonnet-4-5' },
      { nodeEnv: 'development', runtime },
    );

    await expect(
      agent.run({ prompt: 'do a thing', schema }),
    ).resolves.toMatchObject({ data: { ok: true } });
    expect(runtime.calls).toHaveLength(1);
  });

  it('stream does not leave an unhandled rejection when only textStream is consumed', async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', listener);
    try {
      const agent = createAgent(
        { model: 'anthropic/claude-sonnet-4-5' },
        { nodeEnv: 'development', runtime: createFailingRuntimeMock() },
      );

      const { textStream } = agent.stream({ prompt: 'do a thing' });
      const deltas: string[] = [];
      for await (const delta of textStream) {
        deltas.push(delta);
      }
      await new Promise(resolve => setImmediate(resolve));

      expect(deltas).toEqual([]);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', listener);
    }
  });

  it('stream still rejects result for callers that await it', async () => {
    const agent = createAgent(
      { model: 'anthropic/claude-sonnet-4-5' },
      { nodeEnv: 'development', runtime: createFailingRuntimeMock() },
    );

    const { result } = agent.stream({ prompt: 'do a thing' });
    await expect(result).rejects.toThrow('run failed');
  });
});

describe('messages input', () => {
  it('rejects prompt and messages together', async () => {
    const runtime = createRuntimeMock();
    const agent = createAgent(
      { model: 'anthropic/claude-sonnet-4-5' },
      { nodeEnv: 'development', runtime },
    );
    await expect(
      agent.run({
        prompt: 'x',
        messages: [{ role: 'user', parts: [{ type: 'text', text: 'y' }] }],
      }),
    ).rejects.toThrow('either "prompt" or "messages"');
    expect(runtime.calls).toHaveLength(0);
  });

  it('rejects empty or non-user-terminated histories', async () => {
    const runtime = createRuntimeMock();
    const agent = createAgent(
      { model: 'anthropic/claude-sonnet-4-5' },
      { nodeEnv: 'development', runtime },
    );
    await expect(agent.run({ messages: [] })).rejects.toThrow(
      'non-empty array',
    );
    await expect(
      agent.run({
        messages: [
          { role: 'user', parts: [{ type: 'text', text: 'q' }] },
          { role: 'assistant', parts: [{ type: 'text', text: 'a' }] },
        ],
      }),
    ).rejects.toThrow('end with a user message');
    expect(runtime.calls).toHaveLength(0);
  });

  it('folds a history into the runtime prompt', async () => {
    const runtime = createRuntimeMock();
    const agent = createAgent(
      { model: 'anthropic/claude-sonnet-4-5' },
      { nodeEnv: 'development', runtime },
    );
    await agent.run({
      messages: [
        { role: 'user', parts: [{ type: 'text', text: 'hi' }] },
        { role: 'assistant', parts: [{ type: 'text', text: 'hello' }] },
        { role: 'user', parts: [{ type: 'text', text: 'and now?' }] },
      ],
    });
    expect(runtime.calls).toHaveLength(1);
    expect(runtime.calls[0]?.runOptions.prompt).toBe(
      'Conversation so far:\nUser: hi\nAssistant: hello\n\nand now?',
    );
    expect(runtime.calls[0]?.runOptions.messages).toBeUndefined();
  });
});

describe('UI message stream', () => {
  it('streams a run as UI message stream SSE via toUIMessageStreamResponse', async () => {
    const runtime: RuncellRuntime = {
      run(input: RuntimeRunInput) {
        input.onStreamPart?.({ type: 'text-start', id: 't1' });
        input.onStreamPart?.({ type: 'text-delta', id: 't1', text: 'hi' });
        input.onStreamPart?.({ type: 'text-end', id: 't1' });
        input.onStreamPart?.({ type: 'finish', finishReason: 'stop' });
        input.onTextDelta?.('hi');
        return Promise.resolve({
          data: undefined,
          text: 'hi',
          files: [],
          finishReason: 'stop',
          sessionId: 'session-ui',
          usage: {
            inputTokens: 3,
            outputTokens: 2,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 5,
            costUsd: 0.001,
            costMeasured: true,
          },
        });
      },
    };
    const agent = createAgent(
      { model: 'anthropic/claude-sonnet-4-5' },
      { nodeEnv: 'development', runtime },
    );

    const stream = agent.stream({ prompt: 'say hi' });
    const response = stream.toUIMessageStreamResponse();
    await stream.result;

    const body = await response.text();
    const events = body
      .trim()
      .split('\n\n')
      .map(line => line.replace(/^data: /, ''));
    expect(events.at(-1)).toBe('[DONE]');
    const chunks = events
      .slice(0, -1)
      .map(e => JSON.parse(e) as { type: string });
    expect(chunks.map(chunk => chunk.type)).toEqual([
      'start',
      'start-step',
      'text-start',
      'text-delta',
      'text-end',
      'finish-step',
      'finish',
    ]);
    expect(chunks.at(-1)).toEqual({
      type: 'finish',
      messageMetadata: {
        usage: {
          inputTokens: 3,
          outputTokens: 2,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 5,
          costUsd: 0.001,
          costMeasured: true,
        },
        sessionId: 'session-ui',
      },
    });
  });

  it('reports a failed run in-band with a masked message by default', async () => {
    const agent = createAgent(
      { model: 'anthropic/claude-sonnet-4-5' },
      { nodeEnv: 'development', runtime: createFailingRuntimeMock() },
    );

    const stream = agent.stream({ prompt: 'do a thing' });
    const response = stream.toUIMessageStreamResponse();
    await expect(stream.result).rejects.toThrow('run failed');

    const body = await response.text();
    expect(body).toContain('"type":"error"');
    // Server error details never reach the client unless opted into.
    expect(body).not.toContain('run failed');
    expect(body).toContain('An error occurred.');
    expect(body.trim().endsWith('data: [DONE]')).toBe(true);
  });

  it('exposes failure details only through an explicit onError', async () => {
    const agent = createAgent(
      { model: 'anthropic/claude-sonnet-4-5' },
      { nodeEnv: 'development', runtime: createFailingRuntimeMock() },
    );

    const stream = agent.stream({ prompt: 'do a thing' });
    const response = stream.toUIMessageStreamResponse({
      onError: error => (error instanceof Error ? error.message : 'unknown'),
    });
    await expect(stream.result).rejects.toThrow('run failed');

    const body = await response.text();
    expect(body).toContain('run failed');
  });

  it('applies sendTools and sendReasoning wire controls', async () => {
    const runtime: RuncellRuntime = {
      run(input: RuntimeRunInput) {
        input.onStreamPart?.({ type: 'reasoning-start', id: 'r1' });
        input.onStreamPart?.({
          type: 'reasoning-delta',
          id: 'r1',
          text: 'secret thoughts',
        });
        input.onStreamPart?.({ type: 'reasoning-end', id: 'r1' });
        input.onStreamPart?.({
          type: 'tool-call',
          toolCallId: 'c1',
          toolName: 'queryBilling',
          input: { customer: 'acme' },
        });
        input.onStreamPart?.({
          type: 'tool-result',
          toolCallId: 'c1',
          toolName: 'queryBilling',
          output: { balance: 42 },
        });
        input.onStreamPart?.({
          type: 'tool-call',
          toolCallId: 'c2',
          toolName: 'weather',
          input: { city: 'lima' },
        });
        input.onStreamPart?.({
          type: 'tool-result',
          toolCallId: 'c2',
          toolName: 'weather',
          output: { tempC: 18 },
        });
        input.onStreamPart?.({ type: 'finish', finishReason: 'stop' });
        return Promise.resolve({
          data: undefined,
          text: '',
          files: [],
          finishReason: 'stop',
          sessionId: 's',
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 2,
            costUsd: 0,
            costMeasured: false,
          },
        });
      },
    };
    const agent = createAgent(
      { model: 'anthropic/claude-sonnet-4-5' },
      { nodeEnv: 'development', runtime },
    );

    const stream = agent.stream({ prompt: 'go' });
    const body = await stream
      .toUIMessageStreamResponse({
        sendReasoning: false,
        sendTools: { queryBilling: false, weather: 'names-only' },
      })
      .text();
    await stream.result;

    expect(body).not.toContain('secret thoughts');
    expect(body).not.toContain('reasoning');
    expect(body).not.toContain('queryBilling');
    expect(body).not.toContain('acme');
    expect(body).toContain('"toolName":"weather"');
    expect(body).not.toContain('lima');
    expect(body).not.toContain('tempC');
    expect(body).toContain('"input":null');
    expect(body).toContain('"output":null');
  });
});

function createFailingRuntimeMock(): RuncellRuntime {
  return { run: () => Promise.reject(new Error('run failed')) };
}

function createRuntimeMock(
  result: { data: unknown } = { data: {} },
): RuncellRuntime & { calls: RuntimeRunInput[] } {
  const calls: RuntimeRunInput[] = [];
  return {
    calls,
    run(input: RuntimeRunInput) {
      calls.push(input);
      return Promise.resolve({
        data: result.data,
        text: '',
        files: [],
        finishReason: 'stop',
        sessionId: input.runOptions.sessionId ?? 'test-session',
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
    },
  };
}
