import { describe, expect, it, vi } from 'vitest';
import { engineObservation, emitObservation } from './pi-telemetry';

describe('engine telemetry', () => {
  it('reports retry metadata without exposing error content', () => {
    expect(
      engineObservation({
        type: 'auto_retry_start',
        attempt: 2,
        maxAttempts: 3,
        delayMs: 100,
        errorMessage: 'secret',
      }),
    ).toEqual({
      type: 'retry',
      phase: 'scheduled',
      source: 'turn',
      attempt: 2,
      maxAttempts: 3,
      delayMs: 100,
    });
    expect(
      engineObservation({ type: 'auto_retry_end', attempt: 2, success: true }),
    ).toEqual({
      type: 'retry',
      phase: 'finished',
      source: 'turn',
      attempt: 2,
      success: true,
    });
    expect(
      engineObservation({
        type: 'summarization_retry_scheduled',
        attempt: 1,
        maxAttempts: 3,
        delayMs: 10,
        errorMessage: 'secret',
      }),
    ).toMatchObject({ type: 'retry', source: 'summary', phase: 'scheduled' });
    expect(engineObservation({ type: 'summarization_retry_finished' })).toEqual(
      { type: 'retry', source: 'summary', phase: 'finished' },
    );
  });

  it('reports compaction lifecycle without exposing the summary', () => {
    expect(
      engineObservation({ type: 'compaction_start', reason: 'overflow' }),
    ).toEqual({ type: 'compaction', phase: 'start', reason: 'overflow' });
    expect(
      engineObservation({
        type: 'compaction_end',
        reason: 'overflow',
        aborted: false,
        willRetry: true,
        result: {
          tokensBefore: 123,
          summary: 'private',
          firstKeptEntryId: 'entry',
        },
      }),
    ).toEqual({
      type: 'compaction',
      phase: 'end',
      reason: 'overflow',
      aborted: false,
      willRetry: true,
      tokensBefore: 123,
    });
    expect(
      engineObservation({ type: 'agent_settled', aborted: false }),
    ).toBeUndefined();
  });

  it('ignores synchronous and async observer failures', async () => {
    expect(() =>
      emitObservation(() => {
        throw new Error('observer');
      }, {}),
    ).not.toThrow();
    const observer = vi.fn(async () => {
      throw new Error('observer');
    });
    emitObservation(observer, {});
    await Promise.resolve();
    expect(observer).toHaveBeenCalledOnce();
  });
});
