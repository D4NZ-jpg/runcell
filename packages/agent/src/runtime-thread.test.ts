import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ResolvedAgentConfig } from './create-agent.js';
import type { AgentOptions, RunOptions } from './types.js';
import type { Sandbox } from './sandbox-handle.js';
import type { Thread } from './thread.js';

/**
 * These tests exercise the thread resume lifecycle end-to-end. The harness and
 * Pi adapter are mocked, but the virtual sandbox is real so a caller-owned
 * handle flows through `resolveRunSandbox` exactly as in production.
 */

interface StreamPart {
  type: string;
  [key: string]: unknown;
}
type Script = (agent: MockHarnessAgent) => StreamPart[];

interface TestState {
  instances: MockHarnessAgent[];
  scripts: Script[];
}

let state: TestState;

class MockSession {
  stopCount = 0;
  destroyCount = 0;
  constructor(readonly sessionId: string) {}
  stop(): Promise<unknown> {
    this.stopCount += 1;
    return Promise.resolve({
      type: 'resume-session',
      harnessId: 'pi',
      sessionId: this.sessionId,
      data: { sessionFileName: 'session.jsonl' },
    });
  }
  destroy(): Promise<void> {
    this.destroyCount += 1;
    return Promise.resolve();
  }
}

class MockHarnessAgent {
  readonly settings: {
    tools: Record<string, { execute(input: unknown): unknown }>;
  };
  readonly streamCalls: { prompt: string }[] = [];
  readonly createSessionCalls: { sessionId?: string; resumeFrom?: unknown }[] =
    [];
  session: MockSession | undefined;

  constructor(settings: {
    tools: Record<string, { execute(input: unknown): unknown }>;
  }) {
    this.settings = settings;
    state.instances.push(this);
  }

  createSession(options?: {
    sessionId?: string;
    resumeFrom?: unknown;
  }): Promise<MockSession> {
    this.createSessionCalls.push(options ?? {});
    this.session = new MockSession(options?.sessionId ?? 'sess');
    return Promise.resolve(this.session);
  }

  stream(input: {
    prompt: string;
  }): Promise<{ stream: AsyncIterable<StreamPart> }> {
    this.streamCalls.push({ prompt: input.prompt });
    const script = state.scripts.shift();
    const parts = script ? script(this) : [];
    return Promise.resolve({ stream: toAsyncIterable(parts) });
  }

  submit(value: unknown): void {
    this.settings.tools['submitResult']?.execute(value);
  }
}

function installMocks(): void {
  vi.doMock('@ai-sdk/harness/agent', () => ({
    HarnessAgent: MockHarnessAgent,
  }));
  vi.doMock('@local/harness-pi-raw', () => ({
    HARNESS_ID: 'pi',
    createPi: (settings: unknown) => ({ settings }),
  }));
  vi.doMock('@earendil-works/pi-coding-agent', () => ({
    AuthStorage: { fromStorage: (s: unknown) => ({ storage: s }) },
    getAgentDir: () => '/agent-dir',
  }));
  // '@ai-sdk/sandbox-just-bash' is intentionally left real.
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  state = { instances: [], scripts: [] };
});

const schema = z.object({ ok: z.boolean() });

const config: ResolvedAgentConfig = {
  model: 'anthropic/test',
  instructions: undefined,
  credentials: { mode: 'env' },
  toolNames: [],
  sandbox: { type: 'virtual' },
  maxRepairs: 1,
};

function makeInput(
  prompt: string,
  runOptions: Partial<RunOptions<typeof schema>>,
) {
  const agentOptions: AgentOptions = { model: 'anthropic/test' };
  return {
    agentOptions,
    config,
    runOptions: { prompt, schema, ...runOptions },
  };
}

describe('thread resume lifecycle', () => {
  it('persists a resume token and resumes on the next run', async () => {
    installMocks();
    const { defaultRuntime, readPiResumeToken } = await import('./runtime.js');
    const { createVirtualSandbox, getSandboxInternals } =
      await import('./sandbox-handle.js');
    const { createThread, getThreadInternals } = await import('./thread.js');

    const sandbox: Sandbox = await createVirtualSandbox();
    const thread: Thread = createThread({ id: 'chat' });
    state.scripts = [
      agent => {
        agent.submit({ ok: true });
        return [{ type: 'text-delta', text: 'one' }];
      },
      agent => {
        agent.submit({ ok: true });
        return [{ type: 'text-delta', text: 'two' }];
      },
    ];

    try {
      await defaultRuntime.run(makeInput('first', { sandbox, thread }));

      const first = state.instances[0];
      expect(first?.session?.stopCount).toBe(1);
      expect(first?.session?.destroyCount).toBe(0);

      const token = readPiResumeToken(
        getThreadInternals(thread)?.providerState,
      );
      expect(token?.sandboxToken).toBe(
        getSandboxInternals(sandbox)?.sessionToken,
      );

      await defaultRuntime.run(makeInput('second', { sandbox, thread }));

      const second = state.instances[1];
      // Second run resumes the Pi session instead of replaying neutral context.
      expect(second?.createSessionCalls[0]?.resumeFrom).toEqual(token?.resume);
      expect(second?.streamCalls[0]?.prompt).toBe('second');
    } finally {
      await sandbox.destroy();
    }
  });

  it('replays neutral context and keeps no token for an ephemeral sandbox', async () => {
    installMocks();
    const { defaultRuntime } = await import('./runtime.js');
    const { createThread, getThreadInternals } = await import('./thread.js');

    const thread = createThread({ id: 'chat' });
    state.scripts = [
      agent => {
        agent.submit({ ok: true });
        return [{ type: 'text-delta', text: 'one' }];
      },
      agent => {
        agent.submit({ ok: true });
        return [{ type: 'text-delta', text: 'two' }];
      },
    ];

    await defaultRuntime.run(makeInput('first', { thread }));
    const first = state.instances[0];
    expect(first?.session?.destroyCount).toBe(1);
    expect(first?.session?.stopCount).toBe(0);
    expect(getThreadInternals(thread)?.providerState).toBeUndefined();

    await defaultRuntime.run(makeInput('second', { thread }));
    const second = state.instances[1];
    expect(second?.streamCalls[0]?.prompt).toContain('Conversation so far:');
    expect(second?.streamCalls[0]?.prompt.endsWith('second')).toBe(true);
  });
});

describe('readPiResumeToken', () => {
  it('parses a valid Pi token', async () => {
    installMocks();
    const { readPiResumeToken } = await import('./runtime.js');
    const resume = { type: 'resume-session', data: { sessionFileName: 'x' } };
    expect(
      readPiResumeToken({ kind: 'pi', sandboxToken: 'tok', resume }),
    ).toEqual({ kind: 'pi', sandboxToken: 'tok', resume });
  });

  it('rejects absent or malformed tokens', async () => {
    installMocks();
    const { readPiResumeToken } = await import('./runtime.js');
    expect(readPiResumeToken(undefined)).toBeUndefined();
    expect(readPiResumeToken({ kind: 'other' })).toBeUndefined();
    expect(
      readPiResumeToken({ kind: 'pi', sandboxToken: 42, resume: {} }),
    ).toBeUndefined();
  });
});

function toAsyncIterable(
  parts: readonly StreamPart[],
): AsyncIterable<StreamPart> {
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        next(): Promise<IteratorResult<StreamPart>> {
          const value = parts[index];
          index += 1;
          return Promise.resolve(
            value === undefined
              ? { done: true, value: undefined }
              : { done: false, value },
          );
        },
      };
    },
  };
}
