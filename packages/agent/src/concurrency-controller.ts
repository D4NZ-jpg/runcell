import { randomUUID } from 'node:crypto';
import type {
  PiProviderRequestGate,
  PiProviderRequestPermit,
} from '@local/harness-pi-raw';
import type {
  ConcurrencyEvent,
  ConcurrencyLease,
  ConcurrencyReleaseOutcome,
} from './concurrency.js';
import {
  ConcurrencyConfigError,
  ConcurrencyError,
  ConcurrencyLeaseLostError,
  ConcurrencyLimiterError,
  ConcurrencyQueueFullError,
  ConcurrencyTimeoutError,
} from './errors.js';
import type { RunConcurrencyContext, RunContext } from './run-context.js';

/** Renewal retry cadence after a transient failure, in milliseconds. */
const RENEW_RETRY_MAX_MS = 1_000;
/**
 * How long RunCell waits for `release` before moving on. A release that
 * fails or times out emits `release-failed`; lease expiry recovers the slot.
 */
const RELEASE_TIMEOUT_MS = 5_000;

// Distributive over the union so each event keeps its own fields.
type EventInput = ConcurrencyEvent extends infer E
  ? E extends ConcurrencyEvent
    ? Omit<E, keyof ConcurrencyEventIds | 'timestamp'>
    : never
  : never;

interface ConcurrencyEventIds {
  limiter: string;
  workload: string | undefined;
  runId: string;
  rootRunId: string;
  parentRunId: string | undefined;
  requestId: string;
}

export interface RunConcurrency {
  /** Gate handed to the Pi adapter; consulted before every provider request. */
  gate: PiProviderRequestGate;
  /**
   * The run's first concurrency failure (timeout, queue full, limiter,
   * config, lease lost). Once set, every later request is denied with it.
   */
  failure(): ConcurrencyError | undefined;
  /** Release every held slot. Idempotent. */
  dispose(): Promise<void>;
}

/**
 * RunCell-owned slot lifecycle for one run: deadline-bounded,
 * cancellation-safe acquisition; renewal until the request ends; lease-loss
 * abort; idempotent, bounded release; and structured events.
 */
export function createRunConcurrency(
  context: RunContext & { concurrency: RunConcurrencyContext },
  onEvent: (event: ConcurrencyEvent) => void,
): RunConcurrency {
  const { limiter, workload, metadata } = context.concurrency;
  const limiterName = limiter.name;
  let failure: ConcurrencyError | undefined;
  const permits = new Set<{
    release(o: ConcurrencyReleaseOutcome): Promise<void>;
  }>();

  const ids = (requestId: string): ConcurrencyEventIds => ({
    limiter: limiterName,
    workload,
    runId: context.runId,
    rootRunId: context.rootRunId,
    parentRunId: context.parentRunId,
    requestId,
  });
  const emit = (requestId: string, event: EventInput) => {
    try {
      onEvent({
        ...ids(requestId),
        ...event,
        timestamp: Date.now(),
      });
    } catch {
      // Observers never affect slot handling.
    }
  };
  const fail = (error: ConcurrencyError): ConcurrencyError => {
    failure ??= error;
    return error;
  };

  const releaseQuietly = async (lease: ConcurrencyLease, requestId: string) => {
    try {
      await withTimeout(limiter.release(lease), RELEASE_TIMEOUT_MS);
    } catch (error) {
      emit(requestId, { type: 'release-failed', leaseId: lease.id, error });
    }
  };

  const admit: PiProviderRequestGate['admit'] = async ({ signal }) => {
    if (failure) {
      throw failure;
    }
    const cancelSignals = [context.signal, signal].filter(
      (s): s is AbortSignal => s !== undefined,
    );
    const cancelled = cancelSignals.find(s => s.aborted);
    if (cancelled) {
      throw cancelled.reason;
    }

    const requestId = randomUUID();
    const startedAt = Date.now();
    const deadline = context.deadline;
    emit(requestId, { type: 'wait-started', deadline });

    // Timers may fire a millisecond early against Date.now(); a run-budget
    // abort (TimeoutError) at the deadline is the same event.
    const deadlineReached = () =>
      deadline !== undefined &&
      (Date.now() >= deadline - 5 ||
        cancelSignals.some(
          s =>
            s.aborted &&
            (s.reason as { name?: unknown } | undefined)?.name ===
              'TimeoutError',
        ));
    const timeoutError = (cause?: unknown) =>
      new ConcurrencyTimeoutError(
        `No "${limiterName}" concurrency slot was free within the run's time budget (waited ${Date.now() - startedAt} ms).`,
        { ...ids(requestId), ...(cause !== undefined ? { cause } : {}) },
      );

    const deadlineController = new AbortController();
    const acquireSignal = AbortSignal.any([
      ...cancelSignals,
      deadlineController.signal,
    ]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (deadline !== undefined) {
      timer = setTimeout(
        () => {
          deadlineController.abort(timeoutError());
        },
        Math.max(0, deadline - startedAt),
      );
    }

    // Classify a failed or abandoned acquisition. Deadline wins over a
    // cancellation signal that fired at the same instant (the run budget).
    const classify = (error: unknown): unknown => {
      const waitMs = Date.now() - startedAt;
      if (
        deadlineController.signal.aborted ||
        deadlineReached() ||
        isInstance(error, ConcurrencyTimeoutError)
      ) {
        emit(requestId, { type: 'timed-out', waitMs });
        return fail(
          isInstance(error, ConcurrencyTimeoutError)
            ? new ConcurrencyTimeoutError(messageOf(error), {
                ...ids(requestId),
                cause: error,
              })
            : timeoutError(error),
        );
      }
      const cancel = cancelSignals.find(s => s.aborted);
      if (cancel) {
        emit(requestId, { type: 'wait-cancelled', waitMs });
        return cancel.reason;
      }
      if (isInstance(error, ConcurrencyQueueFullError)) {
        emit(requestId, { type: 'queue-full', waitMs });
        return fail(
          new ConcurrencyQueueFullError(messageOf(error), {
            ...ids(requestId),
            cause: error,
          }),
        );
      }
      if (isInstance(error, ConcurrencyConfigError)) {
        emit(requestId, { type: 'config-error', error });
        return fail(
          new ConcurrencyConfigError(messageOf(error), {
            ...ids(requestId),
            cause: error,
          }),
        );
      }
      emit(requestId, { type: 'limiter-error', waitMs, error });
      return fail(
        new ConcurrencyLimiterError(
          `Concurrency limiter "${limiterName}" failed; the provider request was not sent.`,
          { ...ids(requestId), cause: error },
        ),
      );
    };

    let lease: ConcurrencyLease;
    try {
      if (deadline !== undefined && deadline <= startedAt) {
        throw timeoutError();
      }
      lease = await abandonOnAbort(
        Promise.resolve().then(() =>
          limiter.acquire({
            workload,
            runId: context.runId,
            requestId,
            rootRunId: context.rootRunId,
            parentRunId: context.parentRunId,
            metadata,
            timeoutMs:
              deadline !== undefined
                ? Math.max(0, deadline - startedAt)
                : undefined,
            signal: acquireSignal,
          }),
        ),
        acquireSignal,
        // A grant that lands after we stopped waiting is returned at once.
        late => void releaseQuietly(late, requestId),
      );
    } catch (error) {
      throw classify(error);
    } finally {
      clearTimeout(timer);
    }

    // Granted concurrently with cancellation or the deadline: give it back.
    if (acquireSignal.aborted) {
      await releaseQuietly(lease, requestId);
      throw classify(acquireSignal.reason);
    }
    if (!isValidLease(lease)) {
      const candidate: unknown = lease;
      if (
        candidate != null &&
        typeof (candidate as { id?: unknown }).id === 'string'
      ) {
        await releaseQuietly(candidate as ConcurrencyLease, requestId);
      }
      throw classify(
        new TypeError('Concurrency limiter returned an invalid lease.'),
      );
    }

    emit(requestId, {
      type: 'acquired',
      leaseId: lease.id,
      waitMs: Date.now() - startedAt,
    });
    return createPermit(lease, requestId);
  };

  const createPermit = (
    granted: ConcurrencyLease,
    requestId: string,
  ): PiProviderRequestPermit => {
    const revoke = new AbortController();
    const acquiredAt = performance.now();
    let current = granted;
    let localExpiry = acquiredAt + granted.ttlMs;
    let renewTimer: ReturnType<typeof setTimeout> | undefined;
    const state: { releasing: Promise<void> | undefined } = {
      releasing: undefined,
    };
    // A call, not a property read, so narrowing survives no await.
    const released = () => state.releasing !== undefined;

    const scheduleRenew = (delay: number) => {
      renewTimer = setTimeout(() => void renew(), Math.max(0, delay));
    };

    const lose = () => {
      if (released()) return;
      const error = new ConcurrencyLeaseLostError(
        `Concurrency slot on "${limiterName}" was lost; the provider request was aborted.`,
        ids(requestId),
      );
      fail(error);
      emit(requestId, {
        type: 'lease-lost',
        leaseId: current.id,
        holdMs: Math.round(performance.now() - acquiredAt),
      });
      revoke.abort(error);
      void release('lease-lost');
    };

    const renew = async () => {
      if (released()) return;
      const sentAt = performance.now();
      const remaining = localExpiry - sentAt;
      if (remaining <= 0) {
        lose();
        return;
      }
      const control = new AbortController();
      const timeout = setTimeout(() => {
        control.abort(
          new Error('Renewal did not complete before lease expiry.'),
        );
      }, remaining);
      try {
        const next = await abandonOnAbort(
          Promise.resolve().then(() =>
            limiter.renew(current, { signal: control.signal }),
          ),
          control.signal,
          () => undefined,
        );
        if (released()) return;
        if (next === undefined) {
          lose();
          return;
        }
        if (!isValidLease(next) || next.id !== current.id) {
          throw new TypeError(
            'Concurrency limiter returned an invalid renewal.',
          );
        }
        current = next;
        // Conservative: measured from when the renewal was sent.
        localExpiry = sentAt + next.ttlMs;
        scheduleRenew(next.renewAfterMs ?? next.ttlMs / 2);
      } catch (error) {
        if (released()) return;
        emit(requestId, { type: 'renewal-failed', leaseId: current.id, error });
        const left = localExpiry - performance.now();
        if (left <= 0) {
          lose();
          return;
        }
        scheduleRenew(Math.min(RENEW_RETRY_MAX_MS, left / 2));
      } finally {
        clearTimeout(timeout);
      }
    };

    const release = (outcome: ConcurrencyReleaseOutcome): Promise<void> => {
      if (state.releasing) return state.releasing;
      clearTimeout(renewTimer);
      permits.delete(handle);
      state.releasing = (async () => {
        await releaseQuietly(current, requestId);
        emit(requestId, {
          type: 'released',
          leaseId: current.id,
          holdMs: Math.round(performance.now() - acquiredAt),
          outcome,
        });
      })();
      return state.releasing;
    };

    const handle = { release };
    permits.add(handle);
    scheduleRenew(granted.renewAfterMs ?? granted.ttlMs / 2);
    return {
      signal: revoke.signal,
      release: outcome => release(outcome),
    };
  };

  return {
    gate: { admit },
    failure: () => failure,
    async dispose() {
      await Promise.all([...permits].map(p => p.release('cancelled')));
    },
  };
}

function isValidLease(value: unknown): value is ConcurrencyLease {
  if (value == null || typeof value !== 'object') return false;
  const lease = value as Partial<ConcurrencyLease>;
  return (
    typeof lease.id === 'string' &&
    lease.id.length > 0 &&
    typeof lease.ttlMs === 'number' &&
    Number.isFinite(lease.ttlMs) &&
    lease.ttlMs > 0
  );
}

function isInstance(
  value: unknown,
  ctor: abstract new (...args: never[]) => object,
): boolean {
  try {
    return value instanceof ctor;
  } catch {
    return false;
  }
}

function messageOf(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return 'Concurrency limiter failed.';
  }
}

/**
 * Settle with `promise` unless `signal` aborts first, in which case reject
 * with the abort reason at once and hand any later fulfillment to `onLate`.
 */
function abandonOnAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  onLate: (value: T) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let abandoned = false;
    const onAbort = () => {
      abandoned = true;
      reject(signal.reason as Error);
    };
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }
    promise.then(
      value => {
        signal.removeEventListener('abort', onAbort);
        if (abandoned) {
          if (value !== undefined) onLate(value);
        } else {
          resolve(value);
        }
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        if (!abandoned) reject(error as Error); // eslint-disable-line @typescript-eslint/no-unnecessary-type-assertion
      },
    );
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    Promise.resolve().then(() => promise),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Release did not complete within ${ms} ms.`));
      }, ms);
    }),
  ]).finally(() => {
    clearTimeout(timer);
  });
}
