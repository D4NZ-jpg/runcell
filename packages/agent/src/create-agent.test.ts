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

    await expect(
      agent.run({ prompt: '   ', schema: z.object({}) }),
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
      });
    },
  };
}
