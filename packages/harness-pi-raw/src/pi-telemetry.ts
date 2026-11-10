import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';

/** Content-free lifecycle observations from Pi (not provider transport retries). */
export type PiEngineEvent =
  | {
      type: 'retry';
      phase: 'scheduled' | 'finished';
      source: 'turn' | 'summary';
      attempt?: number;
      maxAttempts?: number;
      delayMs?: number;
      success?: boolean;
    }
  | {
      type: 'compaction';
      phase: 'start' | 'end';
      reason: 'manual' | 'threshold' | 'overflow';
      aborted?: boolean;
      willRetry?: boolean;
      tokensBefore?: number;
    };

/** Best-effort observers must never affect a provider request or session. */
export function emitObservation<T>(
  listener: ((event: T) => void) | undefined,
  event: T,
): void {
  try {
    const result = listener?.(event) as unknown;
    if (result instanceof Promise) void result.catch(() => undefined);
  } catch {
    // Observers are not part of model execution.
  }
}

export function engineObservation(
  event: AgentSessionEvent,
): PiEngineEvent | undefined {
  switch (event.type) {
    case 'auto_retry_start':
    case 'summarization_retry_scheduled':
      return {
        type: 'retry',
        phase: 'scheduled',
        source: event.type === 'auto_retry_start' ? 'turn' : 'summary',
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
      };
    case 'auto_retry_end':
      return {
        type: 'retry',
        phase: 'finished',
        source: 'turn',
        attempt: event.attempt,
        success: event.success,
      };
    case 'summarization_retry_finished':
      return { type: 'retry', phase: 'finished', source: 'summary' };
    case 'compaction_start':
      return { type: 'compaction', phase: 'start', reason: event.reason };
    case 'compaction_end':
      return {
        type: 'compaction',
        phase: 'end',
        reason: event.reason,
        aborted: event.aborted,
        willRetry: event.willRetry,
        ...(event.result ? { tokensBefore: event.result.tokensBefore } : {}),
      };
    default:
      return undefined;
  }
}
