import { describe, expect, it } from 'vitest';
import { z, type ZodTypeAny } from 'zod';
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
      instructions: undefined,
      credentials: { mode: 'env' },
      toolNames: [],
      workspaceDir: '/workspace',
      maxRepairs: 1,
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

  it('rejects a relative workspaceDir', () => {
    expect(() =>
      resolveAgentConfig({ model: 'm', workspaceDir: 'workspace' }),
    ).toThrow(InvalidOptionError);
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
});

function createRuntimeMock(
  result: { data: unknown } = { data: {} },
): RuncellRuntime & { calls: RuntimeRunInput<ZodTypeAny>[] } {
  const calls: RuntimeRunInput<ZodTypeAny>[] = [];
  return {
    calls,
    run<TSchema extends ZodTypeAny>(input: RuntimeRunInput<TSchema>) {
      calls.push(input as RuntimeRunInput<ZodTypeAny>);
      return Promise.resolve({
        data: result.data as z.infer<TSchema>,
        text: '',
        files: [],
        sessionId: input.runOptions.sessionId ?? 'test-session',
      });
    },
  };
}
