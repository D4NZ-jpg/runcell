import { beforeEach, describe, expect, it, vi } from 'vitest';

// Only Pi's model client is replaced. The SDK wrapper, adapter, virtual sandbox,
// and runtime are real, so opaque adapter metadata must cross the real boundary.
const state = vi.hoisted(() => ({
  prompts: [] as string[],
  requests: [] as {
    input: number;
    output: number;
    cost: number;
    error?: Error;
  }[],
}));

vi.mock('@earendil-works/pi-coding-agent', () => ({
  getAgentDir: () => '/unused-agent-dir',
  ModelRuntime: {
    create: () =>
      Promise.resolve({
        getModels: () => [
          { id: 'primary-model', name: 'Primary', provider: 'anthropic' },
          { id: 'backup-model', name: 'Backup', provider: 'amazon-bedrock' },
        ],
        registerProvider: vi.fn(),
        setRuntimeApiKey: () => Promise.resolve(),
      }),
  },
  DefaultResourceLoader: class {
    reload() {
      return Promise.resolve();
    }
    getExtensions() {
      return {
        runtime: { pendingProviderRegistrations: [] },
        errors: [],
        extensions: [],
      };
    }
  },
  SettingsManager: { inMemory: () => ({}) },
  SessionManager: { create: () => ({ getSessionFile: () => undefined }) },
  defineTool: (tool: unknown) => tool,
  createAgentSession: () => {
    // Session-lifetime stats deliberately start nonzero; only deltas belong here.
    const stats = {
      tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
      cost: 1,
    };
    return Promise.resolve({
      session: {
        abort: () => Promise.resolve(),
        dispose: vi.fn(),
        extensionRunner: {
          hasHandlers: () => false,
          emit: () => Promise.resolve(),
        },
        getAllTools: () => [],
        getSessionStats: () => ({
          tokens: { ...stats.tokens },
          cost: stats.cost,
        }),
        setActiveToolsByName: vi.fn(),
        subscribe: () => vi.fn(),
        prompt(text: string) {
          state.prompts.push(text);
          const request = state.requests.shift();
          if (!request) throw new Error('Unexpected model request');
          stats.tokens.input += request.input;
          stats.tokens.output += request.output;
          stats.cost += request.cost;
          if (request.error) return Promise.reject(request.error);
          return Promise.resolve();
        },
      },
    });
  },
}));

import { createAgent } from './create-agent.js';
import { getRunExecution } from './execution.js';
import { getRunUsage } from './errors.js';
import type { RunContext } from './types.js';

beforeEach(() => {
  state.requests = [];
  state.prompts = [];
});

describe('application correlation without a telemetry dependency', () => {
  it('snapshots context across lifecycle hooks and reports without adding it to prompts', async () => {
    state.requests = [{ input: 10, output: 2, cost: 0.01 }];
    const context = {
      requestId: 'application-request-123',
      operation: 'application-operation-123',
      tenantId: 'application-tenant-123',
      sampled: true,
    };
    const expected = { ...context };
    const observations: (RunContext | undefined)[] = [];
    const agent = createAgent({
      model: 'Primary',
      events: {
        onRunStart: event => {
          observations.push(event.context);
          context.requestId = 'mutated-by-caller';
        },
        onAttemptStart: event => observations.push(event.context),
        onAttemptEnd: event => observations.push(event.context),
        onFinish: event => observations.push(event.context),
        onRunEnd: event => observations.push(event.context),
      },
    });
    const result = await agent.run({
      prompt: 'go',
      context,
      events: { onRunEnd: event => observations.push(event.context) },
    });
    const snapshot = result.execution?.context;
    expect(snapshot).toEqual(expected);
    expect(snapshot).not.toBe(context);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(context)).toBe(false);
    expect(observations.length).toBeGreaterThanOrEqual(6);
    expect(observations.every(value => value === snapshot)).toBe(true);
    for (const value of [
      expected.requestId,
      expected.operation,
      expected.tenantId,
    ]) {
      expect(state.prompts.join('\n')).not.toContain(value);
    }
  });

  it('carries context through fallback hooks and final error inspection', async () => {
    state.requests = [
      {
        input: 4,
        output: 1,
        cost: 0.005,
        error: new Error('401 Unauthorized'),
      },
      { input: 10, output: 2, cost: 0.01, error: new Error('503 unavailable') },
    ];
    const observations: (RunContext | undefined)[] = [];
    const agent = createAgent({
      credentials: { auth: { type: 'env' }, aws: { type: 'env' } },
      models: [
        { model: 'Primary', credentials: 'auth' },
        { model: 'Backup', credentials: 'aws' },
      ],
      events: {
        onFallback: event => observations.push(event.context),
        onAttemptEnd: event => observations.push(event.context),
        onError: error => observations.push(getRunExecution(error)?.context),
        onRunEnd: event => observations.push(event.context),
      },
    });
    const context = { requestId: 'failed-application-request' };
    const error = await agent
      .run({ prompt: 'go', context })
      .catch((failure: unknown) => failure);
    const execution = getRunExecution(error);
    expect(execution?.context).toEqual(context);
    expect(execution?.attempts).toHaveLength(2);
    expect(
      execution?.attempts.every(
        attempt => attempt.context === execution.context,
      ),
    ).toBe(true);
    expect(observations).toHaveLength(5);
    expect(observations.every(value => value === execution?.context)).toBe(
      true,
    );
    expect(state.prompts.join('\n')).not.toContain(context.requestId);
  });

  it.each(['setup', 'cancelled'] as const)(
    'retains context on %s failure before a model request',
    async mode => {
      const agent = createAgent({
        model: mode === 'setup' ? 'missing-model' : 'Primary',
      });
      const context = { requestId: 'pre-request-failure' };
      const error = await agent
        .run({
          prompt: 'go',
          context,
          signal:
            mode === 'cancelled'
              ? AbortSignal.abort(new Error('stopped'))
              : undefined,
        })
        .catch((failure: unknown) => failure);
      expect(getRunExecution(error)?.context).toEqual(context);
      expect(getRunExecution(error)?.outcome).toBe(
        mode === 'cancelled' ? 'cancelled' : 'failed',
      );
      expect(state.prompts).toEqual([]);
    },
  );

  it('keeps application attributes out of UI streams', async () => {
    state.requests = [{ input: 10, output: 2, cost: 0.01 }];
    const agent = createAgent({ model: 'Primary' });
    const context = {
      requestId: 'server-only-request',
      operation: 'server-only-operation',
    };
    const stream = agent.stream({ prompt: 'go', context });
    const body = await stream.toUIMessageStreamResponse().text();
    const result = await stream.result;
    expect(result.execution?.context).toEqual(context);
    expect(body).not.toContain(context.requestId);
    expect(body).not.toContain(context.operation);
    expect(body).not.toContain('context');
  });

  it('does not share context between concurrent runs or inherit it on later runs', async () => {
    state.requests = [1, 2, 3].map(input => ({ input, output: 1, cost: 0.01 }));
    const agent = createAgent({ model: 'Primary' });
    const [a, b] = await Promise.all([
      agent.run({ prompt: 'a', context: { requestId: 'request-a' } }),
      agent.run({ prompt: 'b', context: { requestId: 'request-b' } }),
    ]);
    const c = await agent.run({ prompt: 'c' });
    expect(a.execution?.context).toEqual({ requestId: 'request-a' });
    expect(b.execution?.context).toEqual({ requestId: 'request-b' });
    expect(c.execution).not.toHaveProperty('context');
    expect(c.execution?.attempts[0]).not.toHaveProperty('context');
  });
});

describe('execution metadata through the real HarnessAgentSession wrapper', () => {
  it('reads actual model identity and usage from the adapter, excluding lifetime totals', async () => {
    state.requests = [{ input: 10, output: 2, cost: 0.01 }];
    const agent = createAgent({
      model: 'Primary',
      credentials: { type: 'env' },
    });
    const result = await agent.run({ prompt: 'go' });
    expect(result.usage).toMatchObject({
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
      costMeasured: true,
    });
    expect(result.usage.costUsd).toBeCloseTo(0.01);
    expect(result.execution?.attempts[0]).toMatchObject({
      model: 'Primary',
      resolvedModel: { id: 'primary-model', provider: 'anthropic' },
      usage: { status: 'complete', totalTokens: 12 },
    });
  });

  it('retains cost from a failed request when a backup route succeeds', async () => {
    state.requests = [
      {
        input: 4,
        output: 1,
        cost: 0.005,
        error: new Error('401 Unauthorized'),
      },
      { input: 10, output: 2, cost: 0.01 },
    ];
    const agent = createAgent({
      credentials: { auth: { type: 'env' }, aws: { type: 'env' } },
      models: [
        { model: 'Primary', credentials: 'auth' },
        { model: 'Backup', credentials: 'aws' },
      ],
    });
    const result = await agent.run({ prompt: 'go' });
    expect(result.usage.totalTokens).toBe(17);
    expect(result.usage.costUsd).toBeCloseTo(0.015);
    expect(result.execution?.attempts).toMatchObject([
      {
        resolvedModel: { provider: 'anthropic' },
        usage: { totalTokens: 5, status: 'partial' },
      },
      {
        resolvedModel: { provider: 'amazon-bedrock' },
        usage: { totalTokens: 12, status: 'complete' },
      },
    ]);
  });

  it('reconciles failed request usage before notifying observers', async () => {
    state.requests = [
      { input: 7, output: 1, cost: 0.02, error: new Error('503 unavailable') },
    ];
    let observed: unknown;
    const agent = createAgent({
      model: 'Primary',
      events: {
        onError: error => {
          observed = getRunExecution(error);
        },
      },
    });
    const error = await agent
      .run({ prompt: 'go' })
      .catch((failure: unknown) => failure);
    expect(getRunUsage(error)?.totalTokens).toBe(8);
    expect(getRunUsage(error)?.costUsd).toBeCloseTo(0.02);
    expect(getRunExecution(error)).toBe(observed);
    expect(getRunExecution(error)).toMatchObject({
      outcome: 'failed',
      usage: { status: 'partial' },
      error: { kind: 'provider_unavailable' },
    });
  });
});
