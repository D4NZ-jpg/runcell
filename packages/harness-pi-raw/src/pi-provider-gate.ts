import type { AgentSession, SettingsManager } from '@earendil-works/pi-coding-agent';

type PiAgent = AgentSession['agent'];
type PiStreamFn = PiAgent['streamFunction'];
type PiModel = Parameters<PiStreamFn>[0];
type PiStreamOptions = NonNullable<Parameters<PiStreamFn>[2]>;
type PiEventStream = Awaited<ReturnType<PiStreamFn>>;
type PiStreamEvent = PiEventStream extends AsyncIterable<infer E> ? E : never;
type PiAssistantMessage = Awaited<ReturnType<PiEventStream['result']>>;

/** How a gated provider request ended. */
export type PiProviderRequestOutcome = 'completed' | 'failed' | 'cancelled';

/** A permit for one provider request, returned by a {@link PiProviderRequestGate}. */
export interface PiProviderRequestPermit {
  /**
   * Aborted when the permit is revoked (for example, its lease was lost).
   * The adapter aborts the in-flight provider request when it fires.
   */
  readonly signal: AbortSignal;
  /**
   * Return the permit. Idempotent; the first outcome wins. The adapter awaits
   * it before handing the response's terminal event to Pi, so the permit is
   * released before Pi executes any tool.
   */
  release(outcome: PiProviderRequestOutcome): Promise<void>;
}

/**
 * Admission hook for every provider request Pi makes in a session: agent
 * turns, turns after tool results, auto-retries, compaction, and branch
 * summaries. `admit` resolves with a permit once the request may proceed,
 * or rejects to deny it; a denied request is never sent.
 */
export interface PiProviderRequestGate {
  admit(request: {
    model: { provider: string; id: string };
    signal: AbortSignal | undefined;
  }): Promise<PiProviderRequestPermit>;
}

/**
 * Message Pi records when a gate denies a request. Fixed and deliberately
 * free of words Pi's auto-retry treats as transient, so a denial never
 * triggers a retry loop; the gate owner keeps the typed reason.
 */
export const PI_PROVIDER_REQUEST_DENIED_MESSAGE =
  'Provider request was not admitted.';

export class PiProviderRequestDeniedError extends Error {
  constructor(options?: { cause?: unknown }) {
    super(PI_PROVIDER_REQUEST_DENIED_MESSAGE, options);
    this.name = 'PiProviderRequestDeniedError';
  }
}

/**
 * Pi's cache warmer sends background provider requests outside the agent
 * loop, which a gate cannot see. Gated sessions must run with it off: an
 * adapter-owned settings manager is switched off; a caller-supplied one that
 * enables it is rejected rather than silently bypassing admission.
 */
export function assertGateCompatibleSettings(
  settingsManager: SettingsManager,
  owned: boolean,
): void {
  if (settingsManager.getCacheWarmingMode() === 'off') {
    return;
  }
  if (owned) {
    settingsManager.setCacheWarmingMode('off');
    return;
  }
  throw new Error(
    'Concurrency limits require Pi cache warming to be off: the supplied ' +
      'settingsManager enables it, and cache-warming requests cannot be ' +
      'limited.',
  );
}

/**
 * Wrap a Pi agent's stream function so every provider request passes the
 * gate returned by `getGate` (read per request, so a parked session can be
 * handed a new run's gate). Throws when the agent exposes no stream function
 * to wrap, rather than running ungated.
 */
export function installProviderRequestGate(
  agent: PiAgent,
  getGate: () => PiProviderRequestGate | undefined,
): void {
  const inner = agent.streamFunction as PiStreamFn | undefined;
  if (typeof inner !== 'function') {
    throw new Error(
      'Pi agent exposes no stream function; the concurrency limit cannot be installed.',
    );
  }
  agent.streamFunction = (model, context, options) => {
    const gate = getGate();
    if (!gate) {
      return inner(model, context, options);
    }
    return gatedRequest(gate, inner, model, context, options);
  };
}

async function gatedRequest(
  gate: PiProviderRequestGate,
  inner: PiStreamFn,
  model: PiModel,
  context: Parameters<PiStreamFn>[1],
  options: PiStreamOptions | undefined,
): Promise<PiEventStream> {
  const callerSignal = options?.signal;
  let permit: PiProviderRequestPermit;
  try {
    permit = await gate.admit({
      model: { provider: model.provider, id: model.id },
      signal: callerSignal,
    });
  } catch (error) {
    if (callerSignal?.aborted) {
      throw error;
    }
    throw new PiProviderRequestDeniedError({ cause: error });
  }

  const signal = callerSignal
    ? AbortSignal.any([callerSignal, permit.signal])
    : permit.signal;
  // Cancellation must free capacity even if the provider never settles.
  const onCallerAbort = () => {
    void permit.release('cancelled');
  };
  callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
  const detach = () =>
    callerSignal?.removeEventListener('abort', onCallerAbort);

  let source: PiEventStream;
  try {
    source = await inner(model, context, { ...options, signal });
  } catch (error) {
    detach();
    await permit.release(signal.aborted ? 'cancelled' : 'failed');
    throw error;
  }

  const forward = new ForwardingStream<PiStreamEvent, PiAssistantMessage>();
  void (async () => {
    try {
      for await (const event of source) {
        if (event.type === 'done' || event.type === 'error') {
          await permit.release(
            event.type === 'done'
              ? 'completed'
              : event.reason === 'aborted'
                ? 'cancelled'
                : 'failed',
          );
          forward.finish(event, event.type === 'done' ? event.message : event.error);
          return;
        }
        forward.push(event);
      }
      // Ended without a terminal event: settle from the source's result.
      await permit.release(signal.aborted ? 'cancelled' : 'completed');
      forward.finish(undefined, await source.result());
    } catch (error) {
      await permit.release(signal.aborted ? 'cancelled' : 'failed');
      const message = failureMessage(model, error, signal.aborted);
      forward.finish(
        {
          type: 'error',
          reason: signal.aborted ? 'aborted' : 'error',
          error: message,
        } as PiStreamEvent,
        message,
      );
    } finally {
      detach();
    }
  })();
  return forward as unknown as PiEventStream;
}

function failureMessage(
  model: PiModel,
  error: unknown,
  aborted: boolean,
): PiAssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: aborted ? 'aborted' : 'error',
    errorMessage: error instanceof Error ? error.message : String(error),
    timestamp: Date.now(),
  } as PiAssistantMessage;
}

/**
 * Minimal re-implementation of Pi's event stream surface (`for await` and
 * `result()`). The gate drains the provider stream eagerly so the permit is
 * released when the response ends, even for consumers that only await
 * `result()` (compaction).
 */
class ForwardingStream<E, R> implements AsyncIterable<E> {
  private readonly queue: E[] = [];
  private readonly waiters: ((result: IteratorResult<E>) => void)[] = [];
  private done = false;
  private resolveResult!: (result: R) => void;
  private readonly resultPromise = new Promise<R>(resolve => {
    this.resolveResult = resolve;
  });

  push(event: E): void {
    if (this.done) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: event, done: false });
    } else {
      this.queue.push(event);
    }
  }

  finish(event: E | undefined, result: R): void {
    if (this.done) return;
    if (event !== undefined) {
      this.push(event);
    }
    this.done = true;
    this.resolveResult(result);
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  result(): Promise<R> {
    return this.resultPromise;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<E> {
    while (true) {
      const next = this.queue.shift();
      if (next !== undefined) {
        yield next;
      } else if (this.done) {
        return;
      } else {
        const result = await new Promise<IteratorResult<E>>(resolve =>
          this.waiters.push(resolve),
        );
        if (result.done) return;
        yield result.value;
      }
    }
  }
}
