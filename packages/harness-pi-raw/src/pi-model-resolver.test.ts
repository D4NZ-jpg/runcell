import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import {
  createPiModelResolver,
  DEFAULT_PI_GATEWAY_MODEL_ID,
} from './pi-model-resolver';

type PiModel = ReturnType<ModelRuntime['getModels']>[number];

function makeRuntime(models: PiModel[] = []) {
  return { getModels: () => models } as unknown as ModelRuntime;
}

const sampleModel: PiModel = {
  id: 'my/model',
  name: 'My Model',
  api: 'anthropic-messages',
  provider: 'example',
  baseUrl: 'https://example.test',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 4_096,
};

const defaultGatewayModel: PiModel = {
  ...sampleModel,
  id: DEFAULT_PI_GATEWAY_MODEL_ID,
  name: 'Claude Sonnet 4.6',
  provider: 'vercel-ai-gateway',
  baseUrl: 'https://ai-gateway.vercel.sh',
};

describe('createPiModelResolver', () => {
  it('returns matching model by id', () => {
    const resolve = createPiModelResolver(makeRuntime([sampleModel]), {});
    expect(resolve('my/model')).toEqual(sampleModel);
  });

  it('returns matching model by name', () => {
    const resolve = createPiModelResolver(makeRuntime([sampleModel]), {});
    expect(resolve('My Model')).toEqual(sampleModel);
  });

  it('disambiguates by provider-qualified id when an id is shared', () => {
    const azure: PiModel = {
      ...sampleModel,
      id: 'gpt-5.5',
      name: 'GPT-5.5',
      provider: 'azure-openai-responses',
    };
    const codex: PiModel = {
      ...sampleModel,
      id: 'gpt-5.5',
      name: 'GPT-5.5',
      provider: 'openai-codex',
    };
    const resolve = createPiModelResolver(makeRuntime([azure, codex]), {});
    expect(resolve('openai-codex/gpt-5.5')).toEqual(codex);
    // A bare id still resolves to the first catalog entry.
    expect(resolve('gpt-5.5')).toEqual(azure);
  });

  it('looks up the gateway default when no id and AI_GATEWAY_API_KEY is set', () => {
    const resolve = createPiModelResolver(makeRuntime([defaultGatewayModel]), {
      AI_GATEWAY_API_KEY: 'sk-test',
    });
    expect(resolve(undefined)).toEqual(defaultGatewayModel);
  });

  it('looks up the gateway default when VERCEL_OIDC_TOKEN is set', () => {
    const resolve = createPiModelResolver(makeRuntime([defaultGatewayModel]), {
      VERCEL_OIDC_TOKEN: 'oidc-token',
    });
    expect(resolve(undefined)).toEqual(defaultGatewayModel);
  });

  it('returns undefined for unknown model id', () => {
    const resolve = createPiModelResolver(makeRuntime([sampleModel]), {
      AI_GATEWAY_API_KEY: 'sk-test',
    });
    expect(resolve('unknown')).toBeUndefined();
  });

  it('returns undefined when no model id and no gateway creds', () => {
    const resolve = createPiModelResolver(makeRuntime([sampleModel]), {});
    expect(resolve(undefined)).toBeUndefined();
  });

  it('returns undefined when gateway default id is missing from the registry', () => {
    const resolve = createPiModelResolver(makeRuntime([sampleModel]), {
      AI_GATEWAY_API_KEY: 'sk-test',
    });
    expect(resolve(undefined)).toBeUndefined();
  });
});
