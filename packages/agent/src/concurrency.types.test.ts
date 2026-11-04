/**
 * Compile-time checks for typed workload names. `npm run typecheck` verifies
 * every `@ts-expect-error` below; if typing ever degrades to `string`, the
 * suppression becomes unused and tsc reports TS2578. The bodies are never
 * executed.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import type { Agent, ConcurrencyLimiter, ConcurrencyStats } from './index.js';
import { createAgent, createConcurrencyLimiter } from './index.js';

function typeChecks() {
  const claude = createConcurrencyLimiter({
    maxConcurrent: 8,
    workloads: {
      interactive: { reserved: 2, priority: 10 },
      background: { maxConcurrent: 6 },
    },
    defaultWorkload: 'background',
  });
  expectTypeOf(claude.workloads).toEqualTypeOf<
    readonly ('interactive' | 'background')[]
  >();
  expectTypeOf<Awaited<ReturnType<typeof claude.stats>>>().toEqualTypeOf<
    ConcurrencyStats<'interactive' | 'background'>
  >();

  createConcurrencyLimiter({
    maxConcurrent: 2,
    workloads: { a: {}, b: {} },
    // @ts-expect-error - the default must be a configured workload.
    defaultWorkload: 'c',
  });

  // Without `workloads`, the only workload is 'default'.
  const simple = createConcurrencyLimiter({ maxConcurrent: 4 });
  expectTypeOf(simple.workloads).toEqualTypeOf<readonly 'default'[]>();

  const agent = createAgent({
    model: 'm',
    concurrency: { limiter: claude, workload: 'background' },
  });
  expectTypeOf(agent).toEqualTypeOf<Agent<'interactive' | 'background'>>();

  createAgent({
    model: 'm',
    // @ts-expect-error - not one of the limiter's workloads.
    concurrency: { limiter: claude, workload: 'backgrond' },
  });

  void agent.run({ prompt: 'x', concurrency: { workload: 'interactive' } });
  void agent.stream({ prompt: 'x', concurrency: { workload: 'background' } });
  void agent.run({
    prompt: 'x',
    schema: z.object({ ok: z.boolean() }),
    concurrency: { workload: 'interactive' },
  });
  // @ts-expect-error - not one of the limiter's workloads.
  void agent.run({ prompt: 'x', concurrency: { workload: 'batch' } });
  void agent.run({
    prompt: 'x',
    schema: z.object({ ok: z.boolean() }),
    // @ts-expect-error - schema runs are checked too.
    concurrency: { workload: 'batch' },
  });
  // @ts-expect-error - a run cannot switch limiters; use another agent.
  void agent.run({ prompt: 'x', concurrency: { limiter: simple } });

  // Without a limiter there are no workloads to select.
  const plain = createAgent({ model: 'm' });
  expectTypeOf(plain).toEqualTypeOf<Agent<never>>();
  // @ts-expect-error - this agent has no limiter.
  void plain.run({ prompt: 'x', concurrency: { workload: 'background' } });
  void plain.run({ prompt: 'x', concurrency: { metadata: { step: 1 } } });

  // Typed agents and limiters still fit the untyped defaults.
  expectTypeOf(agent).toExtend<Agent>();
  expectTypeOf(claude).toExtend<ConcurrencyLimiter>();

  // A custom limiter without a `workloads` list accepts any workload name.
  const custom: ConcurrencyLimiter = {
    name: 'custom',
    acquire: () => Promise.reject(new Error('unused')),
    renew: () => Promise.resolve(undefined),
    release: () => Promise.resolve(),
  };
  const open = createAgent({ model: 'm', concurrency: { limiter: custom } });
  void open.run({ prompt: 'x', concurrency: { workload: 'anything' } });
}

describe('typed workloads', () => {
  it('compiles the type checks', () => {
    expect(typeChecks).toBeTypeOf('function');
  });
});
