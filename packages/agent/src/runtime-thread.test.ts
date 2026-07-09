import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { z } from 'zod';
import type { ResolvedAgentConfig } from './create-agent.js';
import type { SandboxOption, SandboxProvider } from './sandbox.js';
import type { AgentOptions, RunOptions } from './types.js';
import type { Thread } from './thread.js';

/**
 * Exercises the thread continuation lifecycle end-to-end with a mocked harness.
 * A fake in-memory sandbox stands in for the provider session so the journal
 * capture (detach + read + gzip) and resume (inject + resumeFrom) paths run
 * exactly as in production.
 */

const JOURNAL_BYTES = new TextEncoder().encode('{"pi":"journal","turn":1}\n');
const JOURNAL_PATH = '/work/.pi-sessions/session.jsonl';

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

class FakeSandbox {
  readonly files = new Map<string, Uint8Array>();

  run(): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
  }
  writeBinaryFile(input: { path: string; content: Uint8Array }): Promise<void> {
    this.files.set(input.path, input.content);
    return Promise.resolve();
  }
  writeTextFile(input: { path: string; content: string }): Promise<void> {
    this.files.set(input.path, new TextEncoder().encode(input.content));
    return Promise.resolve();
  }
  readBinaryFile(input: { path: string }): Promise<Uint8Array | null> {
    return Promise.resolve(this.files.get(input.path) ?? null);
  }
}

class MockSession {
  detachCount = 0;
  destroyCount = 0;
  constructor(
    readonly sessionId: string,
    private readonly sandbox: FakeSandbox,
  ) {}
  detach(): Promise<unknown> {
    this.detachCount += 1;
    // Simulate Pi flushing its journal into the sandbox on detach.
    this.sandbox.files.set(JOURNAL_PATH, JOURNAL_BYTES);
    return Promise.resolve({
      type: 'resume-session',
      harnessId: 'pi',
      specificationVersion: 'harness-v1',
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
    sandbox?: { createSession(options: object): Promise<unknown> };
    onSandboxSession?: (opts: {
      session: FakeSandbox;
      sessionWorkDir: string;
      abortSignal?: AbortSignal;
    }) => Promise<void>;
  };
  readonly streamCalls: { prompt: string }[] = [];
  readonly createSessionCalls: { sessionId?: string; resumeFrom?: unknown }[] =
    [];
  readonly sandbox = new FakeSandbox();
  session: MockSession | undefined;

  constructor(settings: MockHarnessAgent['settings']) {
    this.settings = settings;
    state.instances.push(this);
  }

  async createSession(options?: {
    sessionId?: string;
    resumeFrom?: unknown;
  }): Promise<MockSession> {
    this.createSessionCalls.push(options ?? {});
    await this.settings.sandbox?.createSession({});
    await this.settings.onSandboxSession?.({
      session: this.sandbox,
      sessionWorkDir: '/work',
    });
    this.session = new MockSession(options?.sessionId ?? 'sess', this.sandbox);
    return this.session;
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

function okScript(text: string): Script {
  return agent => {
    agent.submit({ ok: true });
    return [{ type: 'text-delta', text }];
  };
}

describe('thread continuation lifecycle', () => {
  it('captures a compressed journal on success and detaches (not destroys)', async () => {
    installMocks();
    const { defaultRuntime, readPiContinuation } = await import('./runtime.js');
    const { createThread, getThreadInternals } = await import('./thread.js');

    const thread: Thread = createThread({ id: 'chat' });
    state.scripts = [okScript('one')];

    await defaultRuntime.run(makeInput('first', { thread }));

    const first = state.instances[0];
    expect(first?.session?.detachCount).toBe(1);
    expect(first?.session?.destroyCount).toBe(0);

    const continuation = readPiContinuation(
      getThreadInternals(thread)?.continuation,
    );
    expect(continuation?.engine).toBe('pi');
    // The stored journal round-trips back to the original bytes.
    expect(
      gunzipSync(Buffer.from(continuation?.journalGz ?? '', 'base64')),
    ).toEqual(Buffer.from(JOURNAL_BYTES));
  });

  it('resumes from the thread journal in a fresh sandbox on the next run', async () => {
    installMocks();
    const { defaultRuntime } = await import('./runtime.js');
    const { createThread, getThreadInternals } = await import('./thread.js');

    const thread = createThread({ id: 'chat' });
    state.scripts = [okScript('one'), okScript('two')];

    await defaultRuntime.run(makeInput('first', { thread }));
    const continuation = getThreadInternals(thread)?.continuation;

    await defaultRuntime.run(makeInput('second', { thread }));
    const second = state.instances[1];

    // The second run resumes rather than replaying neutral context.
    expect(second?.createSessionCalls[0]?.resumeFrom).toEqual(
      continuation?.resume,
    );
    expect(second?.createSessionCalls[0]?.sessionId).toBe('sess');
    expect(second?.streamCalls[0]?.prompt).toBe('second');

    // The journal was re-materialized into the fresh sandbox before Pi started.
    expect(second?.sandbox.files.get(JOURNAL_PATH)).toEqual(JOURNAL_BYTES);
  });

  it('clears the continuation and disposes an owned sandbox when journal capture fails', async () => {
    installMocks();
    const { defaultRuntime } = await import('./runtime.js');
    const { createThread, getThreadInternals } = await import('./thread.js');

    const thread = createThread({ id: 'chat' });
    const owned = fakeOwnedSandbox();
    state.scripts = [
      okScript('one'),
      agent => {
        // The journal read during teardown blows up.
        agent.sandbox.readBinaryFile = () =>
          Promise.reject(new Error('read failed'));
        agent.submit({ ok: true });
        return [{ type: 'text-delta', text: 'two' }];
      },
    ];

    await defaultRuntime.run(makeInput('first', { thread }));
    expect(getThreadInternals(thread)?.continuation).toBeDefined();

    await defaultRuntime.run(
      makeInput('second', { thread, sandbox: owned.option }),
    );

    // No stale continuation survives, and the billed sandbox is still gone.
    expect(getThreadInternals(thread)?.continuation).toBeUndefined();
    expect(owned.destroyCount()).toBe(1);
  });

  it('disposes an owned sandbox even when detach fails', async () => {
    installMocks();
    const { defaultRuntime } = await import('./runtime.js');
    const { createThread, getThreadInternals } = await import('./thread.js');

    const thread = createThread({ id: 'chat' });
    const owned = fakeOwnedSandbox();
    state.scripts = [
      agent => {
        if (agent.session) {
          agent.session.detach = () =>
            Promise.reject(new Error('detach failed'));
        }
        agent.submit({ ok: true });
        return [{ type: 'text-delta', text: 'one' }];
      },
    ];

    await defaultRuntime.run(
      makeInput('first', { thread, sandbox: owned.option }),
    );

    expect(getThreadInternals(thread)?.continuation).toBeUndefined();
    expect(owned.destroyCount()).toBe(1);
  });

  it('destroys the session and stores nothing without a thread', async () => {
    installMocks();
    const { defaultRuntime } = await import('./runtime.js');
    state.scripts = [okScript('one')];

    await defaultRuntime.run(makeInput('first', {}));
    const first = state.instances[0];
    expect(first?.session?.destroyCount).toBe(1);
    expect(first?.session?.detachCount).toBe(0);
  });
});

describe('readPiContinuation', () => {
  it('parses a valid Pi continuation', async () => {
    installMocks();
    const { readPiContinuation } = await import('./runtime.js');
    const resume = { type: 'resume-session', data: { sessionFileName: 'x' } };
    expect(
      readPiContinuation({ engine: 'pi', resume, journalGz: 'AAAA' }),
    ).toEqual({ engine: 'pi', resume, journalGz: 'AAAA' });
  });

  it('rejects absent or malformed continuations', async () => {
    installMocks();
    const { readPiContinuation } = await import('./runtime.js');
    expect(readPiContinuation(undefined)).toBeUndefined();
    expect(
      readPiContinuation({ engine: 'other', resume: {}, journalGz: 'x' }),
    ).toBeUndefined();
  });
});

/**
 * A per-run custom sandbox whose network session counts disposals, so tests
 * can assert an owned sandbox is destroyed during teardown.
 */
function fakeOwnedSandbox(): {
  option: SandboxOption;
  destroyCount: () => number;
} {
  let destroyed = 0;
  const session = {
    destroy: () => {
      destroyed += 1;
      return Promise.resolve();
    },
  };
  const option: SandboxOption = {
    type: 'custom',
    provider: {
      specificationVersion: 'harness-sandbox-v1',
      providerId: 'fake-network',
      createSession: () => Promise.resolve(session),
    } as unknown as SandboxProvider,
  };
  return { option, destroyCount: () => destroyed };
}

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
