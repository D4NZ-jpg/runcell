import { describe, expect, it, vi } from 'vitest';
import type { ConcurrencyLimiter } from './concurrency.js';
import { createConcurrencyLimiter } from './concurrency-limiter.js';
import { createAgent } from './create-agent.js';
import { ConcurrencyConfigError, InvalidOptionError } from './errors.js';
import { createRunContext, runInContext } from './run-context.js';

const stubLimiter = (name = 'stub'): ConcurrencyLimiter => ({
  name,
  acquire: vi.fn(),
  renew: vi.fn(),
  release: vi.fn(),
});

const root = (options: Partial<Parameters<typeof createRunContext>[0]> = {}) =>
  createRunContext({
    concurrency: undefined,
    runConcurrency: undefined,
    timeoutMs: undefined,
    signal: undefined,
    parent: undefined,
    ...options,
  });

describe('createRunContext', () => {
  it('starts a root lineage without a limit by default', () => {
    const { context } = root();
    expect(context.rootRunId).toBe(context.runId);
    expect(context.parentRunId).toBeUndefined();
    expect(context.concurrency).toBeUndefined();
    expect(context.signal).toBeUndefined();
  });

  it('inherits limiter, workload, metadata, budget, and cancellation', () => {
    const limiter = stubLimiter();
    const cancel = new AbortController();
    const parent = root({
      concurrency: { limiter, workload: 'background', metadata: { a: 1 } },
      timeoutMs: 10_000,
      signal: cancel.signal,
    });
    const child = runInContext(parent.context, () =>
      createRunContext({
        // The child's own default cannot move work off the parent's workload.
        concurrency: { limiter, workload: 'interactive', metadata: { b: 2 } },
        runConcurrency: { metadata: { c: 3 } },
        timeoutMs: 60_000,
        signal: undefined,
      }),
    );
    expect(child.context.parentRunId).toBe(parent.context.runId);
    expect(child.context.rootRunId).toBe(parent.context.runId);
    expect(child.context.concurrency).toEqual({
      limiter,
      workload: 'background',
      metadata: { a: 1, b: 2, c: 3 },
    });
    expect(child.context.deadline).toBe(parent.context.deadline);
    cancel.abort(new Error('stop'));
    expect(child.context.signal?.aborted).toBe(true);
    parent.dispose();
    child.dispose();
  });

  it('gives a child without concurrency config the parent limiter', () => {
    const limiter = stubLimiter();
    const parent = root({ concurrency: { limiter } });
    const child = root({
      runConcurrency: { workload: 'batch' },
      parent: parent.context,
    });
    expect(child.context.concurrency).toMatchObject({
      limiter,
      workload: 'batch',
    });
  });

  it("uses a child agent's own limiter with its own workload", () => {
    const parentLimiter = stubLimiter('parent');
    const childLimiter = stubLimiter('child');
    const parent = root({
      concurrency: { limiter: parentLimiter, workload: 'background' },
    });
    const child = root({
      concurrency: { limiter: childLimiter, workload: 'fast' },
      parent: parent.context,
    });
    expect(child.context.concurrency).toMatchObject({
      limiter: childLimiter,
      workload: 'fast',
    });
  });

  it('rejects run options without any limiter', () => {
    expect(() => root({ runConcurrency: { workload: 'w' } })).toThrow(
      InvalidOptionError,
    );
  });

  it('validates the selected workload against the limiter', () => {
    const limiter = createConcurrencyLimiter({
      maxConcurrent: 2,
      workloads: { a: {}, b: {} },
    });
    expect(() =>
      root({ concurrency: { limiter }, runConcurrency: { workload: 'c' } }),
    ).toThrow(ConcurrencyConfigError);
  });

  it('aborts the run signal when the budget is spent', async () => {
    const { context, dispose } = root({ timeoutMs: 10 });
    await vi.waitFor(() => {
      expect(context.signal?.aborted).toBe(true);
    });
    expect((context.signal?.reason as Error).name).toBe('TimeoutError');
    dispose();
  });
});

describe('concurrency option validation', () => {
  it('requires a limiter that implements the contract', () => {
    expect(() => createAgent({ model: 'm', concurrency: {} as never })).toThrow(
      /"concurrency.limiter" is required/,
    );
    expect(() =>
      createAgent({
        model: 'm',
        concurrency: { limiter: { acquire: vi.fn() } as never },
      }),
    ).toThrow(/must be a concurrency limiter/);
  });

  it('rejects unknown keys with a hint', () => {
    expect(() =>
      createAgent({
        model: 'm',
        concurrency: { limiter: stubLimiter(), maxWaitMs: 5 } as never,
      }),
    ).toThrow(/does not accept "maxWaitMs"/);
  });

  it('validates the agent workload eagerly', () => {
    const limiter = createConcurrencyLimiter({
      maxConcurrent: 2,
      workloads: { a: {}, b: {} },
    });
    expect(() => createAgent({ model: 'm', concurrency: { limiter } })).toThrow(
      /no default workload/,
    );
    expect(() =>
      createAgent({ model: 'm', concurrency: { limiter, workload: 'z' } }),
    ).toThrow(/Unknown workload "z"/);
  });

  it('rejects invalid run timeouts and selections', async () => {
    const agent = createAgent({
      model: 'm',
      concurrency: { limiter: stubLimiter() },
    });
    await expect(agent.run({ prompt: 'x', timeoutMs: 0 })).rejects.toThrow(
      /timeoutMs/,
    );
    await expect(
      agent.run({ prompt: 'x', concurrency: { workload: '' } }),
    ).rejects.toThrow(/workload/);
  });
});
