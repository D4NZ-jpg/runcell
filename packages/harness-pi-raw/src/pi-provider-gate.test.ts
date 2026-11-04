import { describe, expect, it, vi } from 'vitest';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { SettingsManager } from '@earendil-works/pi-coding-agent';
import {
  assertGateCompatibleSettings,
  installProviderRequestGate,
  PiProviderRequestDeniedError,
  type PiProviderRequestGate,
  type PiProviderRequestOutcome,
} from './pi-provider-gate';

const model = { id: 'm', provider: 'p', api: 'test-api' };

function assistantMessage(stopReason: 'stop' | 'error' | 'aborted' = 'stop') {
  return {
    role: 'assistant' as const,
    content: [{ type: 'text' as const, text: 'hi' }],
    api: 'test-api',
    provider: 'p',
    model: 'm',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

function recordingGate() {
  const log: string[] = [];
  const outcomes: PiProviderRequestOutcome[] = [];
  const revoke = new AbortController();
  let releases = 0;
  const gate: PiProviderRequestGate = {
    admit: vi.fn(() => {
      log.push('admit');
      return Promise.resolve({
        signal: revoke.signal,
        release(outcome) {
          if (releases++ === 0) {
            outcomes.push(outcome);
            log.push(`release:${outcome}`);
          }
          return Promise.resolve();
        },
      });
    }),
  };
  return { gate, log, outcomes, revoke };
}

type AnyStreamFn = (
  model: unknown,
  context: unknown,
  options?: { signal?: AbortSignal },
) => unknown;

function gatedAgent(inner: AnyStreamFn, gate: PiProviderRequestGate | undefined) {
  const agent = { streamFunction: inner } as unknown as Parameters<
    typeof installProviderRequestGate
  >[0];
  installProviderRequestGate(agent, () => gate);
  return agent.streamFunction as unknown as (
    model: unknown,
    context: unknown,
    options?: { signal?: AbortSignal },
  ) => Promise<AsyncIterable<{ type: string }> & { result(): Promise<unknown> }>;
}

describe('installProviderRequestGate', () => {
  it('admits before the request and releases before the terminal event is delivered', async () => {
    const { gate, log, outcomes } = recordingGate();
    const inner = vi.fn(() => {
      log.push('request');
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: 'start', partial: assistantMessage() } as never);
        stream.push({
          type: 'done',
          reason: 'stop',
          message: assistantMessage(),
        } as never);
      });
      return stream;
    });
    const stream = await gatedAgent(inner, gate)(model, { messages: [] });
    const seen: string[] = [];
    for await (const event of stream) {
      seen.push(event.type);
      log.push(`event:${event.type}`);
    }
    expect(seen).toEqual(['start', 'done']);
    expect(log.indexOf('release:completed')).toBeLessThan(
      log.indexOf('event:done'),
    );
    expect(log.slice(0, 2)).toEqual(['admit', 'request']);
    expect(outcomes).toEqual(['completed']);
    await expect(stream.result()).resolves.toMatchObject({ stopReason: 'stop' });
  });

  it('releases for consumers that only await result()', async () => {
    const { gate, outcomes } = recordingGate();
    const stream = await gatedAgent(() => {
      const s = createAssistantMessageEventStream();
      queueMicrotask(() =>
        s.push({ type: 'done', reason: 'stop', message: assistantMessage() } as never),
      );
      return s;
    }, gate)(model, {});
    await stream.result();
    expect(outcomes).toEqual(['completed']);
  });

  it('never calls the provider when admission is denied', async () => {
    const inner = vi.fn();
    const gate: PiProviderRequestGate = {
      admit: () => Promise.reject(new Error('no capacity')),
    };
    await expect(gatedAgent(inner, gate)(model, {})).rejects.toBeInstanceOf(
      PiProviderRequestDeniedError,
    );
    expect(inner).not.toHaveBeenCalled();
  });

  it('releases as failed when the provider throws or reports an error', async () => {
    const thrower = recordingGate();
    await expect(
      gatedAgent(() => {
        throw new Error('boom');
      }, thrower.gate)(model, {}),
    ).rejects.toThrow('boom');
    expect(thrower.outcomes).toEqual(['failed']);

    const reporter = recordingGate();
    const stream = await gatedAgent(() => {
      const s = createAssistantMessageEventStream();
      queueMicrotask(() =>
        s.push({
          type: 'error',
          reason: 'error',
          error: assistantMessage('error'),
        } as never),
      );
      return s;
    }, reporter.gate)(model, {});
    await stream.result();
    expect(reporter.outcomes).toEqual(['failed']);
  });

  it('aborts the provider request when the permit is revoked', async () => {
    const { gate, revoke, outcomes } = recordingGate();
    let providerSignal: AbortSignal | undefined;
    const stream = await gatedAgent((_m, _c, options) => {
      providerSignal = options?.signal;
      const s = createAssistantMessageEventStream();
      options?.signal?.addEventListener('abort', () =>
        s.push({
          type: 'error',
          reason: 'aborted',
          error: assistantMessage('aborted'),
        } as never),
      );
      return s;
    }, gate)(model, {});
    revoke.abort(new Error('lease lost'));
    expect(providerSignal?.aborted).toBe(true);
    await stream.result();
    expect(outcomes).toEqual(['cancelled']);
  });

  it('releases on caller cancellation even if the provider never settles', async () => {
    const { gate, outcomes } = recordingGate();
    const caller = new AbortController();
    await gatedAgent(() => createAssistantMessageEventStream(), gate)(
      model,
      {},
      { signal: caller.signal },
    );
    caller.abort();
    await Promise.resolve();
    expect(outcomes).toEqual(['cancelled']);
  });

  it('passes through untouched when no gate is configured', async () => {
    const original = createAssistantMessageEventStream();
    const result = await gatedAgent(() => original, undefined)(model, {});
    expect(result).toBe(original);
  });

  it('rejects an agent without a stream function', () => {
    expect(() =>
      installProviderRequestGate(
        {} as Parameters<typeof installProviderRequestGate>[0],
        () => undefined,
      ),
    ).toThrow(/cannot be installed/);
  });
});

describe('assertGateCompatibleSettings', () => {
  it('turns cache warming off for adapter-owned settings', () => {
    const settings = SettingsManager.inMemory();
    expect(settings.getCacheWarmingMode()).not.toBe('off');
    assertGateCompatibleSettings(settings, true);
    expect(settings.getCacheWarmingMode()).toBe('off');
  });

  it('rejects caller-supplied settings that enable cache warming', () => {
    expect(() =>
      assertGateCompatibleSettings(SettingsManager.inMemory(), false),
    ).toThrow(/cache warming/);
    expect(() =>
      assertGateCompatibleSettings(
        SettingsManager.inMemory({ cacheWarming: 'off' }),
        false,
      ),
    ).not.toThrow();
  });
});
