/**
 * Live smoke tests for concurrency limits against a real model. Run with:
 *   RUNCELL_LIVE=1 RUNCELL_LIVE_CREDENTIALS=local npm run test:live
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createAgent,
  createConcurrencyLimiter,
  type ConcurrencyEvent,
  type ConcurrencyLimiter,
  type Credentials,
} from './index.js';

const live = process.env['RUNCELL_LIVE'] === '1' ? it : it.skip;
const timeoutMs = Number(process.env['RUNCELL_LIVE_TIMEOUT_MS'] ?? 180_000);
const model =
  process.env['RUNCELL_LIVE_MODEL'] ?? 'anthropic/claude-sonnet-4-5';

function credentials(): Credentials {
  const value = process.env['RUNCELL_LIVE_CREDENTIALS'] ?? 'local';
  if (value === 'local') return 'local';
  if (value === 'env') return { type: 'env' };
  return { type: 'agentDir', path: value.replace(/^agentDir:/, '') };
}

/** A capacity-1 limiter that counts held slots, so tests can check the limit. */
function countedLimiter() {
  const inner = createConcurrencyLimiter({ maxConcurrent: 1 });
  const state = { active: 0, peak: 0, grants: 0 };
  const limiter: ConcurrencyLimiter<'default'> = {
    name: 'live',
    workloads: inner.workloads,
    async acquire(request) {
      const lease = await inner.acquire(request);
      state.active += 1;
      state.grants += 1;
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

describe('live concurrency limits', () => {
  live(
    'runs a parent that calls a child agent with one slot',
    async () => {
      const { limiter, inner, state } = countedLimiter();
      const events: ConcurrencyEvent[] = [];
      const activeDuringTool: number[] = [];
      const child = createAgent({ model, credentials: credentials() });
      const parent = createAgent({
        model,
        credentials: credentials(),
        concurrency: { limiter },
        events: { onConcurrency: e => events.push(e) },
        tools: {
          askChild: {
            description: 'Ask a helper agent a question. Returns its answer.',
            schema: z.object({ question: z.string() }),
            async execute(input) {
              activeDuringTool.push(state.active);
              const { question } = input as { question: string };
              const result = await child.run({
                prompt: question,
                events: { onConcurrency: e => events.push(e) },
              });
              return result.text;
            },
          },
        },
      });

      const result = await parent.run({
        prompt:
          'Call the askChild tool exactly once with the question "What is 17 + 25? ' +
          'Reply with only the number." Then reply with only the number it returned.',
        schema: z.object({ answer: z.number() }),
        timeoutMs,
      });

      expect(result.data.answer).toBe(42);
      // The parent held no slot while its tool ran the child.
      expect(activeDuringTool.length).toBeGreaterThan(0);
      expect(activeDuringTool.every(n => n === 0)).toBe(true);
      expect(state.peak).toBe(1);
      expect(state.active).toBe(0);
      expect((await inner.stats()).active).toBe(0);

      const acquired = events.filter(e => e.type === 'acquired');
      const released = events.filter(e => e.type === 'released');
      // Parent before the tool, the child, and the parent after the tool.
      expect(acquired.length).toBeGreaterThanOrEqual(3);
      expect(released).toHaveLength(acquired.length);
      expect(released.every(e => e.outcome === 'completed')).toBe(true);
      const rootId = acquired[0]?.runId;
      const childEvents = acquired.filter(e => e.parentRunId !== undefined);
      expect(childEvents.length).toBeGreaterThan(0);
      expect(
        childEvents.every(
          e => e.parentRunId === rootId && e.rootRunId === rootId,
        ),
      ).toBe(true);
      expect(JSON.stringify(events)).not.toContain('17 + 25');
    },
    timeoutMs,
  );

  live(
    'holds the slot for the whole streamed response',
    async () => {
      const { limiter, state } = countedLimiter();
      const agent = createAgent({
        model,
        credentials: credentials(),
        concurrency: { limiter },
      });
      const run = agent.stream({
        prompt: 'Count from 1 to 20, one number per line.',
        timeoutMs,
      });
      const activeDuringDeltas: number[] = [];
      for await (const _delta of run.textStream) {
        activeDuringDeltas.push(state.active);
      }
      const result = await run.result;
      expect(result.text).toContain('20');
      expect(activeDuringDeltas.length).toBeGreaterThan(1);
      expect(activeDuringDeltas.every(n => n === 1)).toBe(true);
      expect(state.active).toBe(0);
    },
    timeoutMs,
  );

  live(
    'makes a second run wait for the only slot',
    async () => {
      const { limiter, state } = countedLimiter();
      const waits: number[] = [];
      const agent = createAgent({
        model,
        credentials: credentials(),
        concurrency: { limiter },
        events: {
          onConcurrency: e => {
            if (e.type === 'acquired') waits.push(e.waitMs);
          },
        },
      });
      const results = await Promise.all([
        agent.run({ prompt: 'Reply with only the word alpha.', timeoutMs }),
        agent.run({ prompt: 'Reply with only the word beta.', timeoutMs }),
      ]);
      expect(results[0].text.toLowerCase()).toContain('alpha');
      expect(results[1].text.toLowerCase()).toContain('beta');
      expect(state.peak).toBe(1);
      expect(state.grants).toBe(2);
      // One run waited for the other's response to finish.
      expect(Math.max(...waits)).toBeGreaterThan(200);
    },
    timeoutMs,
  );
});
