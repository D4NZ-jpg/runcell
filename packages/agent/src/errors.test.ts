import { describe, expect, it } from 'vitest';
import { getRunUsage, IncompleteResultError, TurnError } from './errors.js';
import type { RunUsage } from './types.js';

const usage: RunUsage = {
  inputTokens: 10,
  outputTokens: 4,
  cacheReadTokens: 3,
  cacheWriteTokens: 1,
  totalTokens: 18,
  costUsd: 0.05,
  costMeasured: true,
};

describe.each([TurnError, IncompleteResultError])('%s', ErrorClass => {
  it('preserves legacy constructors and cause without inventing usage', () => {
    const cause = new Error('original');
    const withoutCause = new ErrorClass('without cause');
    const withCause = new ErrorClass('with cause', { cause });

    expect(withoutCause.cause).toBeUndefined();
    expect(withCause.cause).toBe(cause);
    expect(withoutCause).not.toHaveProperty('usage');
    expect(withCause).not.toHaveProperty('usage');
    expect(withoutCause.usage).toBeUndefined();
  });

  it('exposes explicitly supplied usage unchanged', () => {
    expect(new ErrorClass('failed', { usage }).usage).toBe(usage);
  });
});

describe('getRunUsage', () => {
  it('discovers valid usage on class and identity-preserved native errors', () => {
    expect(getRunUsage(new TurnError('failed', { usage }))).toBe(usage);
    expect(getRunUsage(Object.assign(new TypeError('failed'), { usage }))).toBe(
      usage,
    );
  });

  it.each([
    undefined,
    null,
    'failed',
    {},
    { usage: null },
    { usage: { ...usage, totalTokens: 999 } },
    { usage: { ...usage, inputTokens: 1.5 } },
    { usage: { ...usage, costUsd: Number.NaN } },
    { usage: { ...usage, costMeasured: 'yes' } },
  ])('rejects absent or invalid usage: %j', value => {
    expect(getRunUsage(value)).toBeUndefined();
  });

  it('does not propagate hostile Proxy traps while reading usage', () => {
    const throwingUsage = new Proxy(usage, {
      get() {
        throw new Error('usage field trap');
      },
    });
    const { proxy: revokedUsage, revoke } = Proxy.revocable({}, {});
    revoke();

    expect(
      getRunUsage(
        new Proxy(
          {},
          {
            get() {
              throw new Error('usage property trap');
            },
          },
        ),
      ),
    ).toBeUndefined();
    expect(getRunUsage({ usage: throwingUsage })).toBeUndefined();
    expect(getRunUsage({ usage: revokedUsage })).toBeUndefined();
  });
});
