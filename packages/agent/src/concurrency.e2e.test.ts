/**
 * End-to-end concurrency-limit tests through the real Pi agent loop. A Pi
 * extension registers a scripted in-process provider, so every provider
 * request goes through the same stream-function path production uses.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import type { ExtensionFactory } from '@local/harness-pi-raw';
import type { ConcurrencyEvent, ConcurrencyLimiter } from './concurrency.js';
import { createConcurrencyLimiter } from './concurrency-limiter.js';
import { createAgent } from './create-agent.js';
import {
  ConcurrencyLeaseLostError,
  ConcurrencyLimiterError,
  ConcurrencyTimeoutError,
  TurnError,
} from './errors.js';

type Reply =
  | { text: string }
  | { toolCall: { name: string; arguments: Record<string, unknown> } }
  | { error: string };

interface ProviderContext {
  /** Number of tool results already in the transcript. */
  toolResults: number;
  /** Zero-based index of this provider request for the agent. */
  index: number;
}

interface ProviderProbe {
  calls: number;
  /** Called synchronously when a request starts; may throw to fail the test. */
  onRequest?: () => void;
}

function message(
  content: unknown[],
  stopReason: string,
  errorMessage?: string,
) {
  return {
    role: 'assistant',
    content,
    api: 'fake-api',
    provider: 'fake',
    model: 'model',
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: Date.now(),
  };
}

/** Register `fake/model`, answering each request with `script`. */
function fakeProvider(
  script: (ctx: ProviderContext) => Reply,
  probe: ProviderProbe = { calls: 0 },
  delayMs = 15,
): ExtensionFactory {
  return pi => {
    pi.registerProvider('fake', {
      baseUrl: 'http://fake.invalid',
      apiKey: 'fake-key',
      api: 'fake-api',
      models: [
        {
          id: 'model',
          name: 'Fake',
          reasoning: false,
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 100_000,
          maxTokens: 1_000,
        },
      ],
      streamSimple: (_model, context, options) => {
        const index = probe.calls++;
        probe.onRequest?.();
        const toolResults = (context.messages as { role: string }[]).filter(
          m => m.role === 'toolResult',
        ).length;
        const reply = script({ toolResults, index });
        const stream = createAssistantMessageEventStream();
        const timer = setTimeout(() => {
          if ('error' in reply) {
            stream.push({
              type: 'error',
              reason: 'error',
              error: message([], 'error', reply.error),
            } as never);
            return;
          }
          if ('text' in reply) {
            const partial = message([{ type: 'text', text: '' }], 'stop');
            stream.push({ type: 'start', partial } as never);
            stream.push({
              type: 'text_delta',
              contentIndex: 0,
              delta: reply.text,
              partial,
            } as never);
            stream.push({
              type: 'done',
              reason: 'stop',
              message: message([{ type: 'text', text: reply.text }], 'stop'),
            } as never);
            return;
          }
          stream.push({
            type: 'done',
            reason: 'toolUse',
            message: message(
              [
                {
                  type: 'toolCall',
                  id: `call-${index}`,
                  name: reply.toolCall.name,
                  arguments: reply.toolCall.arguments,
                },
              ],
              'toolUse',
            ),
          } as never);
        }, delayMs);
        options?.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          stream.push({
            type: 'error',
            reason: 'aborted',
            error: message([], 'aborted', 'Request was aborted'),
          } as never);
        });
        return stream;
      },
    });
  };
}

/** A limiter that counts held slots, so tests can check the limit directly. */
function trackedLimiter(capacity: number) {
  const state = { active: 0, peak: 0 };
  const inner = createConcurrencyLimiter({ maxConcurrent: capacity });
  const limiter: ConcurrencyLimiter<'default'> = {
    name: inner.name,
    workloads: inner.workloads,
    async acquire(request) {
      const lease = await inner.acquire(request);
      state.active += 1;
      state.peak = Math.max(state.peak, state.active);
      return lease;
    },
    renew: (lease, options) => inner.renew(lease, options),
    async release(lease) {
      state.active -= 1;
      await inner.release(lease);
    },
  };
  return { limiter, inner, state };
}

const requirePermit = (state: { active: number }) => () => {
  if (state.active < 1) {
    throw new Error('provider called without a permit');
  }
};

describe('concurrency limits (end to end)', { timeout: 30_000 }, () => {
  it('runs a capacity-one parent/child without deadlock; tools hold no permit', async () => {
    const { limiter, state } = trackedLimiter(1);
    const events: ConcurrencyEvent[] = [];
    const childProbe: ProviderProbe = {
      calls: 0,
      onRequest: requirePermit(state),
    };
    const parentProbe: ProviderProbe = {
      calls: 0,
      onRequest: requirePermit(state),
    };
    const permitsDuringTool: number[] = [];

    const child = createAgent({
      model: 'fake/model',
      pi: {
        extensions: [fakeProvider(() => ({ text: 'child done' }), childProbe)],
      },
      // No concurrency config: the child inherits the parent's limiter.
    });
    const parent = createAgent({
      model: 'fake/model',
      concurrency: { limiter, metadata: { tenant: 't1' } },
      events: { onConcurrency: event => events.push(event) },
      tools: {
        spawnChild: {
          description: 'Run a child agent.',
          schema: z.object({}),
          async execute() {
            permitsDuringTool.push(state.active);
            const result = await child.run({
              prompt: 'child task',
              concurrency: { metadata: { step: 'child' } },
              events: { onConcurrency: event => events.push(event) },
            });
            return result.text;
          },
        },
      },
      pi: {
        extensions: [
          fakeProvider(
            ({ toolResults }) =>
              toolResults === 0
                ? { toolCall: { name: 'spawnChild', arguments: {} } }
                : { text: 'parent done' },
            parentProbe,
          ),
        ],
      },
    });

    const result = await parent.run({ prompt: 'parent task' });

    expect(result.text).toBe('parent done');
    expect(parentProbe.calls).toBe(2);
    expect(childProbe.calls).toBe(1);
    expect(permitsDuringTool).toEqual([0]);
    expect(state.peak).toBe(1);
    expect(state.active).toBe(0);

    const acquired = events.filter(e => e.type === 'acquired');
    expect(acquired).toHaveLength(3);
    const [parentRun, childRun, resumed] = acquired;
    if (!parentRun || !childRun || !resumed) throw new Error('missing events');
    expect(parentRun.parentRunId).toBeUndefined();
    expect(parentRun.rootRunId).toBe(parentRun.runId);
    expect(childRun.parentRunId).toBe(parentRun.runId);
    expect(childRun.rootRunId).toBe(parentRun.runId);
    expect(childRun.limiter).toBe('default');
    expect(resumed.runId).toBe(parentRun.runId);
    expect(
      events.flatMap(e => (e.type === 'released' ? [e.outcome] : [])),
    ).toEqual(['completed', 'completed', 'completed']);
    // Lineage and metadata reach the limiter, never prompt text.
    expect(JSON.stringify(events)).not.toContain('task');
  });

  it('keeps nested work progressing under contention', async () => {
    const { limiter, state } = trackedLimiter(2);
    const child = createAgent({
      model: 'fake/model',
      pi: { extensions: [fakeProvider(() => ({ text: 'leaf' }))] },
    });
    const makeParent = () =>
      createAgent({
        model: 'fake/model',
        concurrency: { limiter },
        tools: {
          spawnChild: {
            description: 'Run a child agent.',
            schema: z.object({}),
            execute: async () => (await child.run({ prompt: 'x' })).text,
          },
        },
        pi: {
          extensions: [
            fakeProvider(({ toolResults }) =>
              toolResults === 0
                ? { toolCall: { name: 'spawnChild', arguments: {} } }
                : { text: 'ok' },
            ),
          ],
        },
      });
    const results = await Promise.all(
      Array.from({ length: 5 }, () => makeParent().run({ prompt: 'p' })),
    );
    expect(results.map(r => r.text)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
    expect(state.peak).toBeLessThanOrEqual(2);
    expect(state.active).toBe(0);
  });

  it('holds the permit for the whole streamed response', async () => {
    const { limiter, state } = trackedLimiter(1);
    const agent = createAgent({
      model: 'fake/model',
      concurrency: { limiter },
      pi: {
        extensions: [fakeProvider(() => ({ text: 'streamed' }), undefined, 30)],
      },
    });
    const run = agent.stream({ prompt: 'go' });
    const activeDuringDeltas: number[] = [];
    for await (const _delta of run.textStream) {
      activeDuringDeltas.push(state.active);
    }
    const result = await run.result;
    expect(result.text).toBe('streamed');
    expect(activeDuringDeltas.length).toBeGreaterThan(0);
    expect(state.active).toBe(0);
  });

  it('admits repair requests separately', async () => {
    const { limiter } = trackedLimiter(1);
    const acquired: ConcurrencyEvent[] = [];
    const agent = createAgent({
      model: 'fake/model',
      concurrency: { limiter },
      events: { onConcurrency: e => e.type === 'acquired' && acquired.push(e) },
      pi: {
        extensions: [
          fakeProvider(({ index }) =>
            index === 0
              ? { text: 'forgot to submit' }
              : { toolCall: { name: 'submitResult', arguments: { ok: true } } },
          ),
        ],
      },
    });
    const result = await agent.run({
      prompt: 'go',
      schema: z.object({ ok: z.boolean() }),
    });
    expect(result.data).toEqual({ ok: true });
    expect(acquired).toHaveLength(2);
  });

  it('releases the permit and preserves the provider error on failure', async () => {
    const { limiter, state } = trackedLimiter(1);
    const agent = createAgent({
      model: 'fake/model',
      concurrency: { limiter },
      pi: {
        extensions: [
          fakeProvider(() => ({ error: 'bad request: invalid model input' })),
        ],
      },
    });
    const error = await agent.run({ prompt: 'go' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TurnError);
    expect((error as Error).message).toContain('invalid model input');
    expect(state.active).toBe(0);
  });

  it('fails with a concurrency timeout within the run budget and never calls the provider', async () => {
    const { limiter, inner } = trackedLimiter(1);
    const blocker = new AbortController();
    const held = await inner.acquire({
      workload: undefined,
      runId: 'other',
      rootRunId: 'other',
      parentRunId: undefined,
      requestId: 'r',
      metadata: {},
      timeoutMs: undefined,
      signal: blocker.signal,
    });
    const probe: ProviderProbe = { calls: 0 };
    const agent = createAgent({
      model: 'fake/model',
      concurrency: { limiter },
      pi: { extensions: [fakeProvider(() => ({ text: 'never' }), probe)] },
    });
    const startedAt = Date.now();
    const error = await agent
      .run({ prompt: 'go', timeoutMs: 1_500 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConcurrencyTimeoutError);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(probe.calls).toBe(0);
    await inner.release(held);
    expect((await inner.stats()).queued).toBe(0);
  });

  it('fails closed when the backend is unavailable', async () => {
    const probe: ProviderProbe = { calls: 0 };
    const broken: ConcurrencyLimiter = {
      name: 'broken',
      acquire: () => Promise.reject(new Error('ECONNREFUSED')),
      renew: () => Promise.resolve(undefined),
      release: () => Promise.resolve(),
    };
    const agent = createAgent({
      model: 'fake/model',
      concurrency: { limiter: broken },
      pi: { extensions: [fakeProvider(() => ({ text: 'never' }), probe)] },
    });
    const error = await agent.run({ prompt: 'go' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConcurrencyLimiterError);
    expect((error as Error).cause).toMatchObject({ message: 'ECONNREFUSED' });
    expect(probe.calls).toBe(0);
  });

  it('aborts the request and fails the run when the lease is lost', async () => {
    let aborted = false;
    let leases = 0;
    const losing: ConcurrencyLimiter = {
      name: 'losing',
      acquire: () =>
        Promise.resolve({
          id: `lease-${++leases}`,
          workload: undefined,
          ttlMs: 60,
        }),
      // The coordinator no longer knows the lease.
      renew: () => Promise.resolve(undefined),
      release: () => Promise.resolve(),
    };
    const probe: ProviderProbe = { calls: 0 };
    const slowProvider: ExtensionFactory = pi => {
      void fakeProvider(() => ({ text: 'too slow' }), probe, 2_000)(pi);
    };
    const agent = createAgent({
      model: 'fake/model',
      concurrency: { limiter: losing },
      events: {
        onConcurrency: e => {
          if (e.type === 'lease-lost') aborted = true;
        },
      },
      pi: { extensions: [slowProvider] },
    });
    const startedAt = Date.now();
    const error = await agent.run({ prompt: 'go' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConcurrencyLeaseLostError);
    expect(aborted).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(1_900);
    // No retry or further request continued under the lost lease.
    expect(probe.calls).toBe(1);
  });

  it("keeps a child on its parent's workload unless the run selects one", async () => {
    const limiter = createConcurrencyLimiter({
      maxConcurrent: 2,
      workloads: { interactive: {}, background: {} },
    });
    const seen: string[] = [];
    const record = (e: ConcurrencyEvent) => {
      if (e.type === 'acquired')
        seen.push(`${e.parentRunId ? 'child' : 'parent'}:${e.workload ?? ''}`);
    };
    const child = createAgent({
      model: 'fake/model',
      // The child's own default does not move inherited work.
      concurrency: { limiter, workload: 'interactive' },
      events: { onConcurrency: record },
      pi: { extensions: [fakeProvider(() => ({ text: 'leaf' }))] },
    });
    const parent = createAgent({
      model: 'fake/model',
      concurrency: { limiter, workload: 'background' },
      events: { onConcurrency: record },
      tools: {
        inherit: {
          description: 'Child on the inherited workload.',
          schema: z.object({}),
          execute: async () => (await child.run({ prompt: 'x' })).text,
        },
        select: {
          description: 'Child on an explicit workload.',
          schema: z.object({}),
          execute: async () =>
            (
              await child.run({
                prompt: 'x',
                concurrency: { workload: 'interactive' },
              })
            ).text,
        },
      },
      pi: {
        extensions: [
          fakeProvider(({ toolResults }) =>
            toolResults === 0
              ? { toolCall: { name: 'inherit', arguments: {} } }
              : toolResults === 1
                ? { toolCall: { name: 'select', arguments: {} } }
                : { text: 'done' },
          ),
        ],
      },
    });
    await parent.run({ prompt: 'go' });
    expect(seen).toEqual([
      'parent:background',
      'child:background',
      'parent:background',
      'child:interactive',
      'parent:background',
    ]);
  });

  it('runs unchanged without a limiter', async () => {
    const agent = createAgent({
      model: 'fake/model',
      pi: { extensions: [fakeProvider(() => ({ text: 'plain' }))] },
    });
    expect((await agent.run({ prompt: 'go' })).text).toBe('plain');
  });
});
