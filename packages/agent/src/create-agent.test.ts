import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAgent, resolveAgentConfig } from './create-agent.js';
import { InvalidOptionError, NotImplementedError } from './errors.js';

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
    const agent = createAgent(
      { model: 'anthropic/claude-sonnet-4-5' },
      { nodeEnv: 'development' },
    );
    await expect(
      agent.run({ prompt: '   ', schema: z.object({}) }),
    ).rejects.toBeInstanceOf(InvalidOptionError);
  });

  it('rejects with NotImplementedError once options are valid', async () => {
    const agent = createAgent(
      { model: 'anthropic/claude-sonnet-4-5' },
      { nodeEnv: 'development' },
    );
    await expect(
      agent.run({
        prompt: 'do a thing',
        schema: z.object({ ok: z.boolean() }),
      }),
    ).rejects.toBeInstanceOf(NotImplementedError);
  });
});
