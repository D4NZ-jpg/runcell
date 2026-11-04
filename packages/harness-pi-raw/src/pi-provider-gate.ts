import type {
  ModelRuntime,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';

type PiStreamSimple = ModelRuntime['streamSimple'];
type PiModel = Parameters<PiStreamSimple>[0];
type PiEventStream = ReturnType<PiStreamSimple>;
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
 * Admission hook for every provider request of a session's model runtime:
 * agent turns, turns after tool results, auto-retries, compaction, branch
 * summaries, and runtime calls from extensions. `admit` resolves with a
 * permit once the request may proceed, or rejects to deny it; a denied
 * request is never sent.
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
 * Pi's cache warmer sends background requests through the model runtime.
 * They are gated like any other request, so they would take slots. An
 * adapter-owned settings manager is switched off to keep background
 * requests out of the limit; a caller-supplied one keeps its setting.
 */
export function disableCacheWarming(settingsManager: SettingsManager): void {
  if (settingsManager.getCacheWarmingMode() !== 'off') {
    settingsManager.setCacheWarmingMode('off');
  }
}

/*
 * Pi's `api` id for virtual models (`VIRTUAL_MODEL_API` in pi-coding-agent,
 * not exported). A virtual-model call routes and then calls `streamSimple`
 * again with the physical model; only that inner call reaches a provider.
 * Gating both would take two slots for one request and deadlock a limiter
 * with one slot. Review on every Pi upgrade (docs: Pi upgrade review).
 */
const PI_VIRTUAL_MODEL_API = 'pi-virtual';

/**
 * Gate every provider request of a session's `ModelRuntime`. Wraps the
 * runtime's `streamSimple` and `stream` (and with them `completeSimple` and
 * `complete`, which call them), so the agent's own stream function keeps its
 * identity: Pi decides how compaction and summary requests authenticate by
 * that identity (pi #11520). `getGate` is read per request, so a parked
 * session can be handed a new run's gate.
 *
 * The runtime must belong to one session; a shared runtime would gate other
 * sessions with this session's gate.
 */
export function installProviderRequestGate(
  runtime: ModelRuntime,
  getGate: () => PiProviderRequestGate | undefined,
): void {
  for (const method of ['streamSimple', 'stream'] as const) {
    const inner = (runtime[method] as PiStreamSimple | undefined)?.bind(
      runtime,
    );
    if (typeof inner !== 'function') {
      throw new Error(
        `Pi model runtime has no ${method} method; the concurrency limit cannot be installed.`,
      );
    }
    const gated: PiStreamSimple = (model, context, options) => {
      const gate = getGate();
      if (!gate || model.api === PI_VIRTUAL_MODEL_API) {
        return inner(model, context, options);
      }
      return gatedRequest(gate, inner, model, context, options);
    };
    Object.defineProperty(runtime, method, {
      value: gated,
      configurable: true,
      writable: true,
    });
  }
}

/**
 * Return a stream at once, as `ModelRuntime` callers expect, and forward
 * the provider stream into it once the gate admits the request.
 */
function gatedRequest(
  gate: PiProviderRequestGate,
  inner: PiStreamSimple,
  model: PiModel,
  context: Parameters<PiStreamSimple>[1],
  options: Parameters<PiStreamSimple>[2],
): PiEventStream {
  const forward = new ForwardingStream<PiStreamEvent, PiAssistantMessage>();
  const callerSignal = options?.signal;
  const fail = (error: unknown, aborted: boolean) => {
    const message = failureMessage(model, error, aborted);
    forward.finish(
      {
        type: 'error',
        reason: aborted ? 'aborted' : 'error',
        error: message,
      } as PiStreamEvent,
      message,
    );
  };

  void (async () => {
    let permit: PiProviderRequestPermit;
    try {
      permit = await gate.admit({
        model: { provider: model.provider, id: model.id },
        signal: callerSignal,
      });
    } catch (error) {
      const aborted = callerSignal?.aborted === true;
      // A denied request is never sent. The fixed message keeps Pi's
      // auto-retry from treating the denial as transient.
      fail(
        aborted ? error : new PiProviderRequestDeniedError({ cause: error }),
        aborted,
      );
      return;
    }

    const signal = callerSignal
      ? AbortSignal.any([callerSignal, permit.signal])
      : permit.signal;
    // Cancellation must free capacity even if the provider never settles.
    const onCallerAbort = () => {
      void permit.release('cancelled');
    };
    callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
    try {
      const source = inner(model, context, { ...options, signal });
      for await (const event of source) {
        if (event.type === 'done' || event.type === 'error') {
          await permit.release(
            event.type === 'done'
              ? 'completed'
              : event.reason === 'aborted'
                ? 'cancelled'
                : 'failed',
          );
          forward.finish(
            event,
            event.type === 'done' ? event.message : event.error,
          );
          return;
        }
        forward.push(event);
      }
      // Ended without a terminal event: settle from the source's result.
      await permit.release(signal.aborted ? 'cancelled' : 'completed');
      forward.finish(undefined, await source.result());
    } catch (error) {
      await permit.release(signal.aborted ? 'cancelled' : 'failed');
      fail(error, signal.aborted);
    } finally {
      callerSignal?.removeEventListener('abort', onCallerAbort);
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
