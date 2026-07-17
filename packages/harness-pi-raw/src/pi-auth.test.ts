import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { resolvePiAuth } from './pi-auth';

function makeRuntime() {
  const setRuntimeApiKey = vi.fn().mockResolvedValue(undefined);
  const registerProvider = vi.fn();
  const modelRuntime = {
    setRuntimeApiKey,
    registerProvider,
  } as unknown as ModelRuntime;
  return { modelRuntime, setRuntimeApiKey, registerProvider };
}

describe('resolvePiAuth', () => {
  it('uses explicit gateway settings when configured', async () => {
    const r = makeRuntime();
    const env = await resolvePiAuth(
      { gateway: { apiKey: 'gw-key', baseUrl: 'https://gw.example' } },
      {},
      r.modelRuntime,
    );
    expect(env).toEqual({
      AI_GATEWAY_API_KEY: 'gw-key',
      AI_GATEWAY_BASE_URL: 'https://gw.example',
    });
    expect(r.setRuntimeApiKey).toHaveBeenCalledWith(
      'vercel-ai-gateway',
      'gw-key',
    );
    expect(r.registerProvider).toHaveBeenCalledWith('vercel-ai-gateway', {
      apiKey: 'gw-key',
      baseUrl: 'https://gw.example',
      authHeader: true,
    });
  });

  it('uses env gateway auth when explicit gateway only sets base URL', async () => {
    const r = makeRuntime();
    const env = await resolvePiAuth(
      { gateway: { baseUrl: 'https://gw.example' } },
      { VERCEL_OIDC_TOKEN: 'oidc-env' },
      r.modelRuntime,
    );
    expect(env).toEqual({
      AI_GATEWAY_API_KEY: 'oidc-env',
      AI_GATEWAY_BASE_URL: 'https://gw.example',
    });
    expect(r.registerProvider).toHaveBeenCalledWith('vercel-ai-gateway', {
      apiKey: 'oidc-env',
      baseUrl: 'https://gw.example',
      authHeader: true,
    });
  });

  it('uses customEnv when provided and registers all known providers', async () => {
    const r = makeRuntime();
    const env = await resolvePiAuth(
      {
        customEnv: {
          AI_GATEWAY_API_KEY: 'gw',
          OPENAI_API_KEY: 'oai',
          ANTHROPIC_API_KEY: 'ant',
          ANTHROPIC_AUTH_TOKEN: 'tok',
        },
      },
      {},
      r.modelRuntime,
    );
    expect(env.AI_GATEWAY_API_KEY).toBe('gw');
    const registeredProviders = r.registerProvider.mock.calls
      .map(call => call[0])
      .sort();
    expect(registeredProviders).toEqual([
      'anthropic',
      'openai',
      'vercel-ai-gateway',
    ]);
    const anthropicCall = r.registerProvider.mock.calls.find(
      call => call[0] === 'anthropic',
    );
    expect(anthropicCall?.[1].headers).toEqual({
      authorization: 'Bearer tok',
    });
  });

  it('registers arbitrary <PREFIX>_API_KEY + <PREFIX>_BASE_URL via customEnv', async () => {
    const r = makeRuntime();
    await resolvePiAuth(
      {
        customEnv: {
          MISTRAL_API_KEY: 'mk',
          MISTRAL_BASE_URL: 'https://api.mistral.example',
        },
      },
      {},
      r.modelRuntime,
    );
    expect(r.setRuntimeApiKey).toHaveBeenCalledWith('mistral', 'mk');
    expect(r.registerProvider).toHaveBeenCalledWith('mistral', {
      apiKey: 'mk',
      baseUrl: 'https://api.mistral.example',
      authHeader: true,
    });
  });

  it('falls back to ambient AI_GATEWAY_API_KEY when no options', async () => {
    const r = makeRuntime();
    const env = await resolvePiAuth(
      undefined,
      { AI_GATEWAY_API_KEY: 'ambient', AI_GATEWAY_BASE_URL: 'https://amb' },
      r.modelRuntime,
    );
    expect(env).toEqual({
      AI_GATEWAY_API_KEY: 'ambient',
      AI_GATEWAY_BASE_URL: 'https://amb',
    });
  });

  it('falls back to ambient VERCEL_OIDC_TOKEN when AI_GATEWAY_API_KEY is missing', async () => {
    const r = makeRuntime();
    const env = await resolvePiAuth(
      undefined,
      { VERCEL_OIDC_TOKEN: 'oidc' },
      r.modelRuntime,
    );
    expect(env.AI_GATEWAY_API_KEY).toBe('oidc');
  });

  it('returns {} when no auth is configured anywhere', async () => {
    const r = makeRuntime();
    const env = await resolvePiAuth(undefined, {}, r.modelRuntime);
    expect(env).toEqual({});
    expect(r.setRuntimeApiKey).not.toHaveBeenCalled();
    expect(r.registerProvider).not.toHaveBeenCalled();
  });
});
