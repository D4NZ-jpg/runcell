import { describe, expect, it } from 'vitest';
import {
  executionError,
  emptyExecutionUsage,
  totalExecutionUsage,
  getRunExecution,
} from './execution.js';

describe('execution error evidence', () => {
  it.each([
    [401, 'authentication'],
    [429, 'rate_limit'],
    [503, 'provider_unavailable'],
    [529, 'provider_unavailable'],
    [400, 'invalid_request'],
    [422, 'invalid_request'],
    [403, 'unknown'],
  ])('classifies provider HTTP %s as %s', (statusCode, kind) => {
    const cause = Object.assign(new Error('provider failure'), { statusCode });
    expect(
      executionError(new Error('wrapped', { cause }), 'provider', false),
    ).toEqual({ kind, origin: 'provider', statusCode });
  });

  it('preserves retry timing without interpreting it as a retry policy', () => {
    const error = Object.assign(new Error('throttled'), {
      statusCode: 429,
      responseHeaders: { 'Retry-After': '2.5' },
    });
    expect(executionError(error, 'provider', false)).toMatchObject({
      statusCode: 429,
      retryAfterMs: 2500,
    });
    const date = new Date('2026-01-01T00:00:00Z');
    const response = new Response(null, {
      status: 503,
      headers: { 'retry-after': 'Thu, 01 Jan 2026 00:00:05 GMT' },
    });
    expect(
      executionError({ response }, 'provider', false, date.getTime()),
    ).toMatchObject({ statusCode: 503, retryAfterMs: 5000 });
  });

  it('does not make provider failures out of infrastructure errors', () => {
    const error = Object.assign(new Error('AWS throttled'), {
      statusCode: 429,
    });
    expect(executionError(error, 'sandbox', false)).toEqual({
      kind: 'unknown',
      origin: 'sandbox',
      statusCode: 429,
    });
    expect(
      executionError(
        Object.assign(new Error('503'), { name: 'AI_ToolExecutionError' }),
        'provider',
        false,
      ),
    ).toEqual({ kind: 'unknown', origin: 'tool' });
    expect(
      executionError(
        Object.assign(new Error('failed'), { name: 'PiExtensionError' }),
        'provider',
        false,
      ),
    ).toEqual({ kind: 'unknown', origin: 'extension' });
  });

  it('uses cancellation as the outcome even when a concurrent provider error occurs', () => {
    expect(executionError({ status: 503 }, 'provider', true)).toEqual({
      kind: 'cancelled',
      origin: 'provider',
      statusCode: 503,
    });
  });

  it('uses recognizable text only for classification, never inventing HTTP metadata', () => {
    expect(
      executionError(
        new Error('OAuth refresh failed: sensitive token'),
        'provider',
        false,
      ),
    ).toEqual({ kind: 'authentication', origin: 'provider' });
    expect(
      executionError(new Error('model overloaded (529)'), 'provider', false),
    ).toEqual({ kind: 'provider_unavailable', origin: 'provider' });
    expect(
      executionError(new Error('request failed'), 'provider', false),
    ).toEqual({ kind: 'unknown', origin: 'provider' });
  });

  it('tolerates arbitrary throws, cyclic causes and uninspectable metadata', () => {
    const cyclic = new Error('failed');
    cyclic.cause = cyclic;
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    for (const error of [
      cyclic,
      proxy,
      null,
      'failed',
      new Proxy(
        {},
        {
          get() {
            throw new Error('trap');
          },
        },
      ),
    ]) {
      expect(executionError(error, 'runtime', false).kind).toBe('unknown');
      expect(getRunExecution(error)).toBeUndefined();
    }
  });
});

describe('execution usage completeness', () => {
  it('does not describe unmeasured requests as measured zero', () => {
    const unknown = emptyExecutionUsage('unknown');
    expect(totalExecutionUsage([{ usage: unknown }])).toEqual(unknown);
    expect(
      totalExecutionUsage([
        { usage: emptyExecutionUsage() },
        { usage: unknown },
      ]).status,
    ).toBe('partial');
    expect(
      totalExecutionUsage([
        {
          usage: {
            ...unknown,
            inputTokens: 10,
            totalTokens: 10,
            status: 'partial',
          },
        },
      ]).status,
    ).toBe('partial');
  });
});
