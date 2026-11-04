import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AdmissionAdapter,
  AdmissionEvent,
  AdmissionLease,
  AdmissionRequest,
} from './admission.js';
import { createRunAdmission } from './admission-controller.js';
import {
  AdmissionBackendError,
  AdmissionConfigError,
  AdmissionLeaseLostError,
  AdmissionQueueFullError,
  AdmissionTimeoutError,
} from './errors.js';
import type { RunAdmissionContext, RunContext } from './run-context.js';

const lease = (id = 'lease-1', ttlMs = 10_000): AdmissionLease => ({
  id,
  pool: 'p',
  workload: undefined,
  ttlMs,
});

function setup(
  adapter: Partial<AdmissionAdapter>,
  overrides: Partial<RunContext> = {},
  admissionOverrides: Partial<RunAdmissionContext> = {},
) {
  const events: AdmissionEvent[] = [];
  const full: AdmissionAdapter = {
    acquire: () => Promise.resolve(lease()),
    renew: l => Promise.resolve(l),
    release: () => Promise.resolve(),
    ...adapter,
  };
  const admission = createRunAdmission(
    {
      runId: 'run',
      rootRunId: 'root',
      parentRunId: 'parent',
      signal: undefined,
      deadline: undefined,
      ...overrides,
      admission: {
        adapter: full,
        pool: 'p',
        workload: undefined,
        metadata: { tenant: 't' },
        maxWaitMs: undefined,
        cleanupTimeoutMs: 1_000,
        ...admissionOverrides,
      },
    },
    event => events.push(event),
  );
  return { admission, events, adapter: full };
}

const types = (events: AdmissionEvent[]) => events.map(e => e.type);
const admit = (
  admission: ReturnType<typeof createRunAdmission>,
  signal?: AbortSignal,
) => admission.gate.admit({ model: { provider: 'x', id: 'y' }, signal });

afterEach(() => {
  vi.useRealTimers();
});

describe('createRunAdmission', () => {
  it('passes lineage, metadata, and deadline to the adapter and releases once', async () => {
    const acquire = vi.fn((_: AdmissionRequest) => Promise.resolve(lease()));
    const release = vi.fn(() => Promise.resolve());
    const { admission, events } = setup(
      { acquire, release },
      { deadline: Date.now() + 5_000 },
    );
    const permit = await admit(admission);
    const [request] = acquire.mock.calls[0] ?? [];
    if (!request) throw new Error('acquire was not called');
    expect(request).toMatchObject({
      pool: 'p',
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
      ({ signal }: AdmissionRequest) =>
        new Promise<AdmissionLease>((_, reject) => {
          signal.addEventListener('abort', () => {
            reject(signal.reason as Error);
          });
        }),
    );
    const { admission, events } = setup({ acquire }, {}, { maxWaitMs: 20 });
    const error = await admit(admission).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AdmissionTimeoutError);
    expect(error).toMatchObject({ runId: 'run', pool: 'p' });
    expect(types(events)).toEqual(['wait-started', 'timed-out']);
    // The run is poisoned: later requests are denied with the same error.
    await expect(admit(admission)).rejects.toBe(error);
    expect(acquire).toHaveBeenCalledTimes(1);
  });

  it('times out at once when the run budget is already spent', async () => {
    const acquire = vi.fn();
    const { admission } = setup({ acquire }, { deadline: Date.now() - 1 });
    await expect(admit(admission)).rejects.toBeInstanceOf(
      AdmissionTimeoutError,
    );
    expect(acquire).not.toHaveBeenCalled();
  });

  it('treats adapter rejections as backend failures and fails closed', async () => {
    const cause = new Error('connection refused');
    const { admission, events } = setup({
      acquire: () => Promise.reject(cause),
    });
    const error = await admit(admission).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AdmissionBackendError);
    expect((error as Error).cause).toBe(cause);
    expect(types(events)).toEqual(['wait-started', 'backend-failed']);
  });

  it('keeps queue-full and config errors typed', async () => {
    const full = setup({
      acquire: () => Promise.reject(new AdmissionQueueFullError('full')),
    });
    await expect(admit(full.admission)).rejects.toBeInstanceOf(
      AdmissionQueueFullError,
    );
    expect(types(full.events)).toContain('queue-full');
    const config = setup({
      acquire: () => Promise.reject(new AdmissionConfigError('unknown pool')),
    });
    await expect(admit(config.admission)).rejects.toBeInstanceOf(
      AdmissionConfigError,
    );
  });

  it('stops waiting on cancellation and returns a late grant', async () => {
    let grant!: (l: AdmissionLease) => void;
    const release = vi.fn(() => Promise.resolve());
    const { admission, events } = setup({
      // Ignores the signal, as a misbehaving backend might.
      acquire: () => new Promise<AdmissionLease>(resolve => (grant = resolve)),
      release,
    });
    const controller = new AbortController();
    const reason = new Error('cancelled');
    const pending = admit(admission, controller.signal);
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(admission.failure()).toBeUndefined();
    grant(lease('late'));
    await vi.waitFor(() => {
      expect(release).toHaveBeenCalledWith(lease('late'));
    });
    expect(types(events)).toEqual(['wait-started', 'wait-cancelled']);
  });

  it('releases a permit granted concurrently with cancellation', async () => {
    const controller = new AbortController();
    const release = vi.fn(() => Promise.resolve());
    const { admission } = setup({
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
    await admit(admission, controller.signal).then(
      permit => permit.release('completed'),
      () => undefined,
    );
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('renews before expiry and stops renewing after release', async () => {
    vi.useFakeTimers();
    const renew = vi.fn((l: AdmissionLease) => Promise.resolve(l));
    const { admission } = setup({
      acquire: () => Promise.resolve(lease('l', 100)),
      renew,
    });
    const permit = await admit(admission);
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
    const { admission, events } = setup({
      acquire: () => Promise.resolve(lease('l', 40)),
      renew: () => Promise.resolve(undefined),
      release,
    });
    const permit = await admit(admission);
    await vi.waitFor(() => {
      expect(permit.signal.aborted).toBe(true);
    });
    expect(permit.signal.reason).toBeInstanceOf(AdmissionLeaseLostError);
    expect(admission.failure()).toBeInstanceOf(AdmissionLeaseLostError);
    await vi.waitFor(() => {
      expect(release).toHaveBeenCalledTimes(1);
    });
    expect(types(events)).toContain('lease-lost');
    expect(events.at(-1)).toMatchObject({
      type: 'released',
      outcome: 'lease-lost',
    });
    await expect(admit(admission)).rejects.toBeInstanceOf(
      AdmissionLeaseLostError,
    );
  });

  it('retries failed renewals until expiry, then loses the lease', async () => {
    vi.useFakeTimers();
    const renew = vi.fn(() => Promise.reject(new Error('blip')));
    const { admission, events } = setup({
      acquire: () => Promise.resolve(lease('l', 200)),
      renew,
    });
    const permit = await admit(admission);
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
    const { admission } = setup({
      acquire: () => Promise.resolve(lease('l', 200)),
      renew: l =>
        ++calls === 1 ? Promise.reject(new Error('blip')) : Promise.resolve(l),
    });
    const permit = await admit(admission);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(permit.signal.aborted).toBe(false);
    await permit.release('completed');
  });

  it('emits cleanup-failed when release fails or hangs', async () => {
    const { admission, events } = setup({
      release: () => Promise.reject(new Error('db down')),
    });
    const permit = await admit(admission);
    await permit.release('completed');
    expect(types(events)).toEqual([
      'wait-started',
      'acquired',
      'cleanup-failed',
      'released',
    ]);

    const hanging = setup(
      { release: () => new Promise<void>(() => undefined) },
      {},
      { cleanupTimeoutMs: 20 },
    );
    const second = await admit(hanging.admission);
    await second.release('completed');
    expect(types(hanging.events)).toContain('cleanup-failed');
  });

  it('dispose releases outstanding permits', async () => {
    const release = vi.fn(() => Promise.resolve());
    const { admission, events } = setup({ release });
    await admit(admission);
    await admission.dispose();
    await admission.dispose();
    expect(release).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toMatchObject({
      type: 'released',
      outcome: 'cancelled',
    });
  });

  it('rejects an invalid lease from the adapter', async () => {
    const { admission } = setup({
      acquire: () => Promise.resolve({ id: 'x', ttlMs: 0 } as AdmissionLease),
    });
    await expect(admit(admission)).rejects.toBeInstanceOf(
      AdmissionBackendError,
    );
  });
});
