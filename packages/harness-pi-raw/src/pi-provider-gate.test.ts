import { describe, expect, it, vi } from 'vitest';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import {
  SettingsManager,
  type ModelRuntime,
} from '@earendil-works/pi-coding-agent';
import {
  disableCacheWarming,
  installProviderRequestGate,
  PI_PROVIDER_REQUEST_DENIED_MESSAGE,
  type PiProviderRequestGate,
  type PiProviderRequestEvent,
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

type Stream = AsyncIterable<{ type: string }> & {
  result(): Promise<{ stopReason: string; errorMessage?: string }>;
};
type StreamFn = (
  model: { id: string; provider: string; api: string },
  context: unknown,
  options?: { signal?: AbortSignal },
) => unknown;

/** A fake runtime with Pi's method shapes: `complete*` call `stream*`. */
function gatedRuntime(
  streamSimple: StreamFn,
  gate: PiProviderRequestGate | undefined,
  observer?: (event: PiProviderRequestEvent) => void,
) {
  const runtime = {
    streamSimple,
    stream: streamSimple,
    completeSimple(m: unknown, c: unknown, o?: unknown) {
      return (this.streamSimple as (...a: unknown[]) => Stream)(
        m,
        c,
        o,
      ).result();
    },
  };
  installProviderRequestGate(
    runtime as unknown as ModelRuntime,
    () => gate,
    () => observer,
  );
  return runtime as unknown as {
    streamSimple: (...args: Parameters<StreamFn>) => Stream;
    stream: (...args: Parameters<StreamFn>) => Stream;
    completeSimple: (...args: Parameters<StreamFn>) => Promise<unknown>;
  };
}

function replying(
  log?: string[],
  stopReason: 'stop' | 'error' = 'stop',
): StreamFn {
  return () => {
    log?.push('request');
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: 'start', partial: assistantMessage() } as never);
      stream.push(
        (stopReason === 'stop'
          ? { type: 'done', reason: 'stop', message: assistantMessage() }
          : {
              type: 'error',
              reason: 'error',
              error: assistantMessage('error'),
            }) as never,
      );
    });
    return stream;
  };
}

describe('installProviderRequestGate', () => {
  it('observes every runtime entry point once without changing content, usage, or options', async () => {
    const observer = vi.fn();
    const message = assistantMessage();
    message.usage = {
      input: 10,
      output: 20,
      cacheRead: 30,
      cacheWrite: 40,
      totalTokens: 100,
      cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
    };
    const inner = vi.fn(() => {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() =>
        stream.push({ type: 'done', reason: 'stop', message } as never),
      );
      return stream;
    });
    const runtime = gatedRuntime(inner, undefined, observer);
    const context = { messages: [{ role: 'user', content: 'all input' }] };
    const options = { reasoning: 'high', sessionId: 'stable-key' };
    for (const method of [
      'streamSimple',
      'stream',
      'completeSimple',
    ] as const) {
      const response = runtime[method](model, context, options);
      expect(
        await (method === 'completeSimple'
          ? response
          : (response as Stream).result()),
      ).toBe(message);
    }
    expect(inner).toHaveBeenCalledTimes(3);
    expect(inner).toHaveBeenLastCalledWith(model, context, {
      ...options,
      signal: undefined,
    });
    expect(observer).toHaveBeenCalledTimes(3);
    expect(observer.mock.calls[0]?.[0]).toMatchObject({
      model: { provider: 'p', id: 'm' },
      outcome: 'completed',
      usage: message.usage,
    });
    const ids = observer.mock.calls.map(([event]) => event.requestId);
    expect(new Set(ids).size).toBe(3);
    expect(observer.mock.calls[0]?.[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(observer.mock.calls[0]?.[0].usage).not.toBe(message.usage);
    expect(JSON.stringify(observer.mock.calls)).not.toContain('all input');
  });

  it.each(['error', 'aborted'] as const)(
    'observes partial %s usage',
    async stopReason => {
      const observer = vi.fn();
      const message = assistantMessage(stopReason);
      message.usage.output = 17;
      const runtime = gatedRuntime(
        () => {
          const stream = createAssistantMessageEventStream();
          queueMicrotask(() =>
            stream.push({
              type: 'error',
              reason: stopReason,
              error: message,
            } as never),
          );
          return stream;
        },
        undefined,
        observer,
      );
      await runtime.streamSimple(model, {}).result();
      expect(observer).toHaveBeenCalledOnce();
      expect(observer).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: stopReason === 'aborted' ? 'cancelled' : 'failed',
          usage: expect.objectContaining({ output: 17 }),
        }),
      );
    },
  );

  it('reports unknown usage on a thrown request and ignores throwing observers', async () => {
    const observer = vi.fn(() => {
      throw new Error('observer');
    });
    const result = await gatedRuntime(
      () => {
        throw new Error('provider');
      },
      undefined,
      observer,
    )
      .streamSimple(model, {})
      .result();
    expect(result).toMatchObject({ errorMessage: 'provider' });
    expect(observer).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'failed' }),
    );
    expect(observer.mock.calls[0]?.[0]).not.toHaveProperty('usage');
    const rejectedObserver = vi.fn(async () => {
      throw new Error('observer');
    });
    await gatedRuntime(replying(), undefined, rejectedObserver)
      .streamSimple(model, {})
      .result();
  });

  it('returns a stream at once, admits first, and releases before the terminal event', async () => {
    const { gate, log, outcomes } = recordingGate();
    const runtime = gatedRuntime(replying(log), gate);
    const stream = runtime.streamSimple(model, { messages: [] });
    expect(typeof stream.result).toBe('function');
    const seen: string[] = [];
    for await (const event of stream) {
      seen.push(event.type);
      log.push(`event:${event.type}`);
    }
    expect(seen).toEqual(['start', 'done']);
    expect(log.slice(0, 2)).toEqual(['admit', 'request']);
    expect(log.indexOf('release:completed')).toBeLessThan(
      log.indexOf('event:done'),
    );
    expect(outcomes).toEqual(['completed']);
    await expect(stream.result()).resolves.toMatchObject({
      stopReason: 'stop',
    });
  });

  it('gates completeSimple and stream too', async () => {
    const simple = recordingGate();
    await gatedRuntime(replying(), simple.gate).completeSimple(model, {});
    expect(simple.outcomes).toEqual(['completed']);

    const plain = recordingGate();
    await gatedRuntime(replying(), plain.gate).stream(model, {}).result();
    expect(plain.outcomes).toEqual(['completed']);
  });

  it('never calls the provider when admission is denied', async () => {
    const inner = vi.fn();
    const gate: PiProviderRequestGate = {
      admit: () => Promise.reject(new Error('no capacity')),
    };
    const observer = vi.fn();
    const result = await gatedRuntime(inner, gate, observer)
      .streamSimple(model, {})
      .result();
    expect(result).toMatchObject({
      stopReason: 'error',
      errorMessage: PI_PROVIDER_REQUEST_DENIED_MESSAGE,
    });
    expect(inner).not.toHaveBeenCalled();
    expect(observer).not.toHaveBeenCalled();
  });

  it('passes virtual-model calls through and gates the routed request once', async () => {
    const { gate } = recordingGate();
    const admit = vi.mocked(gate.admit);
    const physical = replying();
    const observer = vi.fn();
    // Pi routes a virtual model and then calls streamSimple again.
    const runtime = gatedRuntime(
      function (this: unknown, m, c, o) {
        if (m.api === 'pi-virtual') {
          return (runtime.streamSimple as StreamFn)(
            { ...model, id: 'routed' },
            c,
            o,
          );
        }
        return physical(m, c, o);
      },
      gate,
      observer,
    );
    await runtime
      .streamSimple({ id: 'auto', provider: 'p', api: 'pi-virtual' }, {})
      .result();
    expect(admit).toHaveBeenCalledTimes(1);
    expect(observer).toHaveBeenCalledOnce();
    expect(observer).toHaveBeenCalledWith(
      expect.objectContaining({ model: { provider: 'p', id: 'routed' } }),
    );
    expect(admit.mock.calls[0]?.[0]).toMatchObject({ model: { id: 'routed' } });
  });

  it('releases as failed when the provider throws or reports an error', async () => {
    const thrower = recordingGate();
    const result = await gatedRuntime(() => {
      throw new Error('boom');
    }, thrower.gate)
      .streamSimple(model, {})
      .result();
    expect(result).toMatchObject({ stopReason: 'error', errorMessage: 'boom' });
    expect(thrower.outcomes).toEqual(['failed']);

    const reporter = recordingGate();
    await gatedRuntime(replying(undefined, 'error'), reporter.gate)
      .streamSimple(model, {})
      .result();
    expect(reporter.outcomes).toEqual(['failed']);
  });

  it('aborts the provider request when the permit is revoked', async () => {
    const { gate, revoke, outcomes } = recordingGate();
    let providerSignal: AbortSignal | undefined;
    const stream = gatedRuntime((_m, _c, options) => {
      providerSignal = options?.signal;
      const s = createAssistantMessageEventStream();
      options?.signal?.addEventListener('abort', () => {
        s.push({
          type: 'error',
          reason: 'aborted',
          error: assistantMessage('aborted'),
        } as never);
      });
      return s;
    }, gate).streamSimple(model, {});
    await vi.waitFor(() => {
      expect(providerSignal).toBeDefined();
    });
    revoke.abort(new Error('lease lost'));
    expect(providerSignal?.aborted).toBe(true);
    await stream.result();
    expect(outcomes).toEqual(['cancelled']);
  });

  it('releases on caller cancellation even if the provider never settles', async () => {
    const { gate, outcomes } = recordingGate();
    const caller = new AbortController();
    let started = false;
    gatedRuntime(() => {
      started = true;
      return createAssistantMessageEventStream();
    }, gate).streamSimple(model, {}, { signal: caller.signal });
    await vi.waitFor(() => {
      expect(started).toBe(true);
    });
    caller.abort();
    await vi.waitFor(() => {
      expect(outcomes).toEqual(['cancelled']);
    });
  });

  it('passes through untouched when no gate is configured', () => {
    const original = createAssistantMessageEventStream();
    expect(
      gatedRuntime(() => original, undefined).streamSimple(model, {}),
    ).toBe(original);
  });

  it('rejects a runtime without the stream methods', () => {
    expect(() => {
      installProviderRequestGate({} as ModelRuntime, () => undefined);
    }).toThrow(/cannot be installed/);
  });
});

describe('disableCacheWarming', () => {
  it('turns cache warming off', () => {
    const settings = SettingsManager.inMemory();
    expect(settings.getCacheWarmingMode()).not.toBe('off');
    disableCacheWarming(settings);
    expect(settings.getCacheWarmingMode()).toBe('off');
  });
});
