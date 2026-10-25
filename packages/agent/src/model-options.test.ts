import { describe, expect, it } from 'vitest';
import { createAgent, resolveAgentConfig } from './create-agent.js';
import { CredentialError, InvalidOptionError } from './errors.js';
import type { ModelAgentOptions } from './index.js';
import type { RuncellRuntime, RuntimeRunInput } from './runtime.js';

const credentials = {
  subscription: { type: 'apiKeys', keys: { anthropic: 'primary-key' } },
  aws: { type: 'env' },
} as const;

const options = {
  credentials,
  models: [
    { model: 'anthropic/test', credentials: 'subscription' },
    { model: 'amazon-bedrock/test', credentials: 'aws' },
  ],
} satisfies ModelAgentOptions<typeof credentials>;

describe('named model options', () => {
  it('normalizes ordered model routes and retains the primary config fields', () => {
    const config = resolveAgentConfig(options);
    expect(config.model).toBe('anthropic/test');
    expect(config.credentials).toEqual({
      mode: 'apiKeys',
      keys: { anthropic: 'primary-key' },
    });
    expect(config.models).toEqual([
      {
        model: 'anthropic/test',
        credential: 'subscription',
        credentials: config.credentials,
      },
      {
        model: 'amazon-bedrock/test',
        credential: 'aws',
        credentials: { mode: 'env' },
      },
    ]);
  });

  it('infers credential names from the registry for inline createAgent calls', () => {
    const agent = createAgent({
      credentials: { oauth: { type: 'env' }, aws: { type: 'env' } },
      models: [
        { model: 'anthropic/test', credentials: 'oauth' },
        { model: 'amazon-bedrock/test', credentials: 'aws' },
      ],
    });
    expect(agent).toHaveProperty('run');

    const typo = () => {
      return createAgent({
        credentials: { oauth: { type: 'env' } },
        // @ts-expect-error Model references cannot introduce new registry keys.
        models: [{ model: 'anthropic/test', credentials: 'oath' }],
      });
    };
    expect(typo).toThrow(/unknown credential source: oath/);
  });

  it('checks references on explicitly typed configurations', () => {
    const invalid: ModelAgentOptions<typeof credentials> = {
      credentials,
      models: [
        {
          model: 'm',
          // @ts-expect-error Only subscription and aws are registered.
          credentials: 'missing',
        },
      ],
    };
    expect(() => createAgent(invalid)).toThrow(/models\[0\].credentials/);
  });

  it('rejects both configuration forms at compile time and runtime', () => {
    const both = () => {
      return createAgent({
        // @ts-expect-error The single-model and routed forms are mutually exclusive.
        model: 'm',
        credentials: { aws: { type: 'env' } },
        models: [{ model: 'b', credentials: 'aws' }],
      });
    };
    expect(both).toThrow(/either "model" or "models"/);
  });

  it.each([
    { models: [] },
    { models: null },
    { models: 'anthropic/test' },
    { credentials: undefined },
    { credentials: null },
    { credentials: [] },
    { credentials: 'local' },
    { models: [null] },
    { models: [undefined] },
    { models: [{ model: '', credentials: 'aws' }] },
    { models: [{ model: ' ', credentials: 'aws' }] },
    { models: [{ model: 42, credentials: 'aws' }] },
    { models: [{ model: 'm' }] },
    { models: [{ model: 'm', credentials: 42 }] },
    { models: [{ model: 'm', credentials: 'missing' }] },
    { models: [{ model: 'm', credentials: 'toString' }] },
    { credentials: { '': { type: 'env' } } },
    { credentials: { aws: undefined } },
  ])('rejects malformed routed options: %j', invalid => {
    expect(() =>
      resolveAgentConfig({ ...options, ...invalid } as never),
    ).toThrow(InvalidOptionError);
  });

  it.each([
    { aws: { type: 'not-a-source' } },
    { aws: { type: 'apiKeys' } },
    { aws: { type: 'shared', key: 'prod' } },
    { aws: { type: 'env' }, unused: { type: 'apiKeys', keys: {} } },
  ])('validates every registered source: %j', invalid => {
    expect(() =>
      resolveAgentConfig({
        credentials: invalid,
        models: [{ model: 'm', credentials: 'aws' }],
      } as never),
    ).toThrow(CredentialError);
  });

  it('applies the production guard to unused named sources too', () => {
    expect(() =>
      createAgent(
        {
          credentials: { aws: { type: 'env' }, unused: 'local' },
          models: [{ model: 'm', credentials: 'aws' }],
        },
        { nodeEnv: 'production' },
      ),
    ).toThrow(/refused in production/);
  });

  it('supports credential chains and shared named sources', () => {
    const config = resolveAgentConfig({
      credentials: {
        auth: [
          { type: 'env' },
          { type: 'apiKeys', keys: { anthropic: 'key' } },
        ],
      },
      models: [
        { model: 'anthropic/one', credentials: 'auth' },
        { model: 'anthropic/two', credentials: 'auth' },
      ],
    });
    expect(config.models).toHaveLength(2);
    expect(config.models?.[0]?.credentials).toEqual({
      mode: 'chain',
      sources: [
        { mode: 'env' },
        { mode: 'apiKeys', keys: { anthropic: 'key' } },
      ],
    });
  });

  it('passes normalized routes through run and stream to custom runtimes', async () => {
    const calls: RuntimeRunInput[] = [];
    const runtime: RuncellRuntime = {
      run: input => {
        calls.push(input);
        return Promise.resolve({
          data: undefined,
          text: 'ok',
          files: [],
          finishReason: 'stop',
          sessionId: 's',
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
    const agent = createAgent(options, { runtime });
    await agent.run({ prompt: 'hello' });
    await agent.stream({ prompt: 'again' }).result;
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.config.models).toHaveLength(2);
      expect(call.agentOptions.model).toBe('anthropic/test');
      expect(call.agentOptions.credentials).toEqual(credentials.subscription);
    }
  });
});
