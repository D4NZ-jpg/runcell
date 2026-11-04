import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ConcurrencyEvent,
  ConcurrencyLease,
  ConcurrencyLimiter,
  ConcurrencyRequest,
} from './concurrency.js';
import { createRunConcurrency } from './concurrency-controller.js';
import {
  ConcurrencyConfigError,
  ConcurrencyLeaseLostError,
  ConcurrencyLimiterError,
  ConcurrencyQueueFullError,
  ConcurrencyTimeoutError,
} from './errors.js';
import type { RunContext } from './run-context.js';

const lease = (id = 'lease-1', ttlMs = 10_000): ConcurrencyLease => ({
  id,
  workload: undefined,
  ttlMs,
});

function setup(
  overridesLimiter: Partial<ConcurrencyLimiter>,
  overrides: Partial<RunContext> = {},
) {
  const events: ConcurrencyEvent[] = [];
  const limiter: ConcurrencyLimiter = {
    name: 'claude',
    acquire: () => Promise.resolve(lease()),
    renew: l => Promise.resolve(l),
    release: () => Promise.resolve(),
    ...overridesLimiter,
  };
  const concurrency = createRunConcurrency(
    {
      runId: 'run',
      rootRunId: 'root',
      parentRunId: 'parent',
      signal: undefined,
      deadline: undefined,
      ...overrides,
      concurrency: { limiter, workload: undefined, metadata: { tenant: 't' } },
    },
    event => events.push(event),
  );
  return { run: concurrency, events, limiter };
}

const types = (events: ConcurrencyEvent[]) => events.map(e => e.type);
const admit = (
  run: ReturnType<typeof createRunConcurrency>,
  signal?: AbortSignal,
) => run.gate.admit({ model: { provider: 'x', id: 'y' }, signal });

afterEach(() => {
  vi.useRealTimers();
});

describe('createRunConcurrency', () => {
  it('passes lineage, metadata, and deadline to the adapter and releases once', async () => {
    const acquire = vi.fn((_: ConcurrencyRequest) => Promise.resolve(lease()));
    const release = vi.fn(() => Promise.resolve());
    const { run, events } = setup(
      { acquire, release },
      { deadline: Date.now() + 5_000 },
    );
    const permit = await admit(run);
    const [request] = acquire.mock.calls[0] ?? [];
    if (!request) throw new Error('acquire was not called');
    expect(request).toMatchObject({
      runId: 'run',
      rootRunId: 'root',
      parentRunId: 'parent',
      metadata: { tenant: 't' },
    });
    expect(request.timeoutMs).toBeGreaterThan(4_000);
    expect(request.timeoutMs).toBeLessThanOrEqual(5_000);
    await Promise.all([permit.release('completed'), permit.release('failed')]);
    await permit.release('cancelled');
    expect(release).toHaveBeenCalledTimes(1);
    expect(types(events)).toEqual(['wait-started', 'acquired', 'released']);
    expect(events[2]).toMatchObject({
      outcome: 'completed',
      requestId: request.requestId,
    });
  });

  it('times out at the effective deadline without granting', async () => {
    const acquire = vi.fn(
      ({ signal }: ConcurrencyRequest) =>
        new Promise<ConcurrencyLease>((_, reject) => {
          signal.addEventListener('abort', () => {
            reject(signal.reason as Error);
          });
        }),
    );
    const { run, events } = setup({ acquire }, { deadline: Date.now() + 20 });
    const error = await admit(run).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConcurrencyTimeoutError);
    expect(error).toMatchObject({ runId: 'run', limiter: 'claude' });
    expect(types(events)).toEqual(['wait-started', 'timed-out']);
    // The run is poisoned: later requests are denied with the same error.
    await expect(admit(run)).rejects.toBe(error);
    expect(acquire).toHaveBeenCalledTimes(1);
  });

  it('times out at once when the run budget is already spent', async () => {
    const acquire = vi.fn();
    const { run } = setup({ acquire }, { deadline: Date.now() - 1 });
    await expect(admit(run)).rejects.toBeInstanceOf(ConcurrencyTimeoutError);
    expect(acquire).not.toHaveBeenCalled();
  });

  it('treats adapter rejections as backend failures and fails closed', async () => {
    const cause = new Error('connection refused');
    const { run, events } = setup({
      acquire: () => Promise.reject(cause),
    });
    const error = await admit(run).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConcurrencyLimiterError);
    expect((error as Error).cause).toBe(cause);
    expect(types(events)).toEqual(['wait-started', 'limiter-error']);
  });

  it('keeps queue-full and config errors typed', async () => {
    const full = setup({
      acquire: () => Promise.reject(new ConcurrencyQueueFullError('full')),
    });
    await expect(admit(full.run)).rejects.toBeInstanceOf(
      ConcurrencyQueueFullError,
    );
    expect(types(full.events)).toContain('queue-full');
    const config = setup({
      acquire: () => Promise.reject(new ConcurrencyConfigError('unknown pool')),
    });
    await expect(admit(config.run)).rejects.toBeInstanceOf(
      ConcurrencyConfigError,
    );
    expect(types(config.events)).toContain('config-error');
  });

  it('stops waiting on cancellation and returns a late grant', async () => {
    let grant!: (l: ConcurrencyLease) => void;
    const release = vi.fn(() => Promise.resolve());
    const { run, events } = setup({
      // Ignores the signal, as a misbehaving backend might.
      acquire: () =>
        new Promise<ConcurrencyLease>(resolve => (grant = resolve)),
      release,
    });
    const controller = new AbortController();
    const reason = new Error('cancelled');
    const pending = admit(run, controller.signal);
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(run.failure()).toBeUndefined();
    grant(lease('late'));
    await vi.waitFor(() => {
      expect(release).toHaveBeenCalledWith(lease('late'));
    });
    expect(types(events)).toEqual(['wait-started', 'wait-cancelled']);
  });

  it('releases a permit granted concurrently with cancellation', async () => {
    const controller = new AbortController();
    const release = vi.fn(() => Promise.resolve());
    const { run } = setup({
      acquire: () => {
        // Grant and cancellation land in the same tick.
        const granted = Promise.resolve(lease('raced'));
        void granted.then(() => {
          controller.abort(new Error('cancelled'));
        });
        return granted;
      },
      release,
    });
    await admit(run, controller.signal).then(
      permit => permit.release('completed'),
      () => undefined,
    );
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('renews before expiry and stops renewing after release', async () => {
    vi.useFakeTimers();
    const renew = vi.fn((l: ConcurrencyLease) => Promise.resolve(l));
    const { run } = setup({
      acquire: () => Promise.resolve(lease('l', 100)),
      renew,
    });
    const permit = await admit(run);
    await vi.advanceTimersByTimeAsync(260);
    expect(renew.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(permit.signal.aborted).toBe(false);
    await permit.release('completed');
    const count = renew.mock.calls.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(renew.mock.calls.length).toBe(count);
  });

  it('treats a lease the backend no longer holds as lost', async () => {
    const release = vi.fn(() => Promise.resolve());
    const { run, events } = setup({
      acquire: () => Promise.resolve(lease('l', 40)),
      renew: () => Promise.resolve(undefined),
      release,
    });
    const permit = await admit(run);
    await vi.waitFor(() => {
      expect(permit.signal.aborted).toBe(true);
    });
    expect(permit.signal.reason).toBeInstanceOf(ConcurrencyLeaseLostError);
    expect(run.failure()).toBeInstanceOf(ConcurrencyLeaseLostError);
    await vi.waitFor(() => {
      expect(release).toHaveBeenCalledTimes(1);
    });
    expect(types(events)).toContain('lease-lost');
    expect(events.at(-1)).toMatchObject({
      type: 'released',
      outcome: 'lease-lost',
    });
    await expect(admit(run)).rejects.toBeInstanceOf(ConcurrencyLeaseLostError);
  });

  it('retries failed renewals until expiry, then loses the lease', async () => {
    vi.useFakeTimers();
    const renew = vi.fn(() => Promise.reject(new Error('blip')));
    const { run, events } = setup({
      acquire: () => Promise.resolve(lease('l', 200)),
      renew,
    });
    const permit = await admit(run);
    await vi.advanceTimersByTimeAsync(150);
    expect(permit.signal.aborted).toBe(false);
    expect(types(events)).toContain('renewal-failed');
    await vi.advanceTimersByTimeAsync(100);
    expect(permit.signal.aborted).toBe(true);
    expect(renew.mock.calls.length).toBeGreaterThan(1);
  });

  it('survives a transient renewal failure', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const { run } = setup({
      acquire: () => Promise.resolve(lease('l', 200)),
      renew: l =>
        ++calls === 1 ? Promise.reject(new Error('blip')) : Promise.resolve(l),
    });
    const permit = await admit(run);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(permit.signal.aborted).toBe(false);
    await permit.release('completed');
  });

  it('emits release-failed when release fails or hangs', async () => {
    const { run, events } = setup({
      release: () => Promise.reject(new Error('db down')),
    });
    const permit = await admit(run);
    await permit.release('completed');
    expect(types(events)).toEqual([
      'wait-started',
      'acquired',
      'release-failed',
      'released',
    ]);

    vi.useFakeTimers();
    const hanging = setup({
      release: () => new Promise<void>(() => undefined),
    });
    const second = await admit(hanging.run);
    const released = second.release('completed');
    await vi.advanceTimersByTimeAsync(5_000);
    await released;
    expect(types(hanging.events)).toContain('release-failed');
  });

  it('dispose releases outstanding permits', async () => {
    const release = vi.fn(() => Promise.resolve());
    const { run, events } = setup({ release });
    await admit(run);
    await run.dispose();
    await run.dispose();
    expect(release).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toMatchObject({
      type: 'released',
      outcome: 'cancelled',
    });
  });

  it('rejects an invalid lease from the adapter', async () => {
    const { run } = setup({
      acquire: () => Promise.resolve({ id: 'x', ttlMs: 0 } as ConcurrencyLease),
    });
    await expect(admit(run)).rejects.toBeInstanceOf(ConcurrencyLimiterError);
  });
});
