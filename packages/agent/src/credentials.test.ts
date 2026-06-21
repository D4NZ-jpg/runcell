import { describe, expect, it, vi } from 'vitest';
import { normalizeCredentials, type CredentialStore } from './credentials.js';
import { CredentialError } from './errors.js';

describe('normalizeCredentials', () => {
  it('defaults to env credentials', () => {
    expect(normalizeCredentials(undefined, { nodeEnv: 'development' })).toEqual(
      {
        mode: 'env',
      },
    );
    expect(normalizeCredentials(undefined, { nodeEnv: 'production' })).toEqual({
      mode: 'env',
    });
  });

  it('refuses local in production by default', () => {
    expect(() =>
      normalizeCredentials('local', { nodeEnv: 'production' }),
    ).toThrow(CredentialError);
  });

  it('allows local in production when opted in', () => {
    expect(
      normalizeCredentials(
        { type: 'local', allowInProduction: true, agentDir: '/secrets/pi' },
        { nodeEnv: 'production' },
      ),
    ).toEqual({ mode: 'local', agentDir: '/secrets/pi' });
  });

  it('resolves env credentials', () => {
    expect(normalizeCredentials({ type: 'env' })).toEqual({ mode: 'env' });
  });

  it('resolves and copies apiKeys', () => {
    const keys = { anthropic: 'sk-ant' };
    const plan = normalizeCredentials({ type: 'apiKeys', keys });
    expect(plan).toEqual({ mode: 'apiKeys', keys: { anthropic: 'sk-ant' } });
    if (plan.mode === 'apiKeys') {
      expect(plan.keys).not.toBe(keys);
    }
  });

  it('rejects empty apiKeys', () => {
    expect(() => normalizeCredentials({ type: 'apiKeys', keys: {} })).toThrow(
      CredentialError,
    );
  });

  it('rejects empty api key values', () => {
    expect(() =>
      normalizeCredentials({ type: 'apiKeys', keys: { openai: '' } }),
    ).toThrow(CredentialError);
  });

  it('resolves agentDir credentials', () => {
    expect(normalizeCredentials({ type: 'agentDir', path: '/opt/pi' })).toEqual(
      {
        mode: 'agentDir',
        path: '/opt/pi',
      },
    );
  });

  it('resolves shared credentials with a store', () => {
    const store: CredentialStore = { withLock: vi.fn() };
    const plan = normalizeCredentials({
      type: 'shared',
      key: 'prod-agent',
      store,
    });
    expect(plan).toEqual({ mode: 'shared', key: 'prod-agent', store });
  });
});
