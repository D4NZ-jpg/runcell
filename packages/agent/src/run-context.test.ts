import { describe, expect, it, vi } from 'vitest';
import type { AdmissionAdapter } from './admission.js';
import { createAgent } from './create-agent.js';
import { InvalidOptionError } from './errors.js';
import { createRunContext, runInContext } from './run-context.js';

const adapter = (): AdmissionAdapter => ({
  acquire: vi.fn(),
  renew: vi.fn(),
  release: vi.fn(),
});

describe('createRunContext', () => {
  it('starts a root lineage without admission by default', () => {
    const { context } = createRunContext({
      admission: undefined,
      runAdmission: undefined,
      timeoutMs: undefined,
      signal: undefined,
      parent: undefined,
    });
    expect(context.rootRunId).toBe(context.runId);
    expect(context.parentRunId).toBeUndefined();
    expect(context.admission).toBeUndefined();
    expect(context.signal).toBeUndefined();
  });

  it('inherits adapter, pool, workload, metadata, budget, and cancellation', () => {
    const shared = adapter();
    const parentCancel = new AbortController();
    const parent = createRunContext({
      admission: {
        adapter: shared,
        pool: 'p',
        workload: 'background',
        metadata: { a: 1 },
      },
      runAdmission: undefined,
      timeoutMs: 10_000,
      signal: parentCancel.signal,
      parent: undefined,
    });
    const child = runInContext(parent.context, () =>
      createRunContext({
        // A child agent's own defaults do not escape the parent's workload.
        admission: {
          adapter: shared,
          pool: 'p',
          workload: 'interactive',
          metadata: { b: 2 },
        },
        runAdmission: { metadata: { c: 3 } },
        timeoutMs: 60_000,
        signal: undefined,
      }),
    );
    expect(child.context.parentRunId).toBe(parent.context.runId);
    expect(child.context.rootRunId).toBe(parent.context.runId);
    expect(child.context.admission).toMatchObject({
      adapter: shared,
      pool: 'p',
      workload: 'background',
      metadata: { a: 1, b: 2, c: 3 },
    });
    expect(child.context.deadline).toBe(parent.context.deadline);
    parentCancel.abort(new Error('stop'));
    expect(child.context.signal?.aborted).toBe(true);
    parent.dispose();
    child.dispose();
  });

  it('lets a child without admission config inherit the parent adapter', () => {
    const shared = adapter();
    const parent = createRunContext({
      admission: { adapter: shared },
      runAdmission: undefined,
      timeoutMs: undefined,
      signal: undefined,
      parent: undefined,
    });
    const child = createRunContext({
      admission: undefined,
      runAdmission: { workload: 'batch' },
      timeoutMs: undefined,
      signal: undefined,
      parent: parent.context,
    });
    expect(child.context.admission).toMatchObject({
      adapter: shared,
      pool: 'default',
      workload: 'batch',
    });
  });

  it('rejects run admission options without any adapter', () => {
    expect(() =>
      createRunContext({
        admission: undefined,
        runAdmission: { pool: 'p' },
        timeoutMs: undefined,
        signal: undefined,
        parent: undefined,
      }),
    ).toThrow(InvalidOptionError);
  });

  it('aborts the run signal when the budget is spent', async () => {
    const { context, dispose } = createRunContext({
      admission: undefined,
      runAdmission: undefined,
      timeoutMs: 10,
      signal: undefined,
      parent: undefined,
    });
    await vi.waitFor(() => {
      expect(context.signal?.aborted).toBe(true);
    });
    expect((context.signal?.reason as Error).name).toBe('TimeoutError');
    dispose();
  });
});

describe('admission option validation', () => {
  it('rejects an adapter without the full contract', () => {
    expect(() =>
      createAgent({
        model: 'm',
        admission: { adapter: { acquire: vi.fn() } as never },
      }),
    ).toThrow(/acquire, renew, and release/);
  });

  it('validates the pool and workload eagerly through the adapter', () => {
    const validate = vi.fn(() => {
      throw new Error('unknown pool');
    });
    expect(() =>
      createAgent({
        model: 'm',
        admission: { adapter: { ...adapter(), validate } },
      }),
    ).toThrow('unknown pool');
    expect(validate).toHaveBeenCalledWith({
      pool: 'default',
      workload: undefined,
    });
  });

  it('rejects invalid run timeouts and admission selections', async () => {
    const agent = createAgent({
      model: 'm',
      admission: { adapter: adapter() },
    });
    await expect(agent.run({ prompt: 'x', timeoutMs: 0 })).rejects.toThrow(
      /timeoutMs/,
    );
    await expect(
      agent.run({ prompt: 'x', admission: { pool: '' } }),
    ).rejects.toThrow(/pool/);
    await expect(
      agent.run({ prompt: 'x', admission: { maxWaitMs: -5 } }),
    ).rejects.toThrow(/maxWaitMs/);
  });
});
