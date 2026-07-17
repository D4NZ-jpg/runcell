import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const harnessMock = vi.hoisted(() => ({
  sessions: [] as { id: string }[],
}));

vi.mock('@ai-sdk/harness/agent', () => ({
  HarnessAgent: class MockHarnessAgent {
    constructor(
      private readonly settings: {
        sandbox: SandboxProvider;
        sandboxConfig?: {
          onSession?: (input: {
            session: Awaited<ReturnType<SandboxProvider['createSession']>>;
            sessionWorkDir: string;
            abortSignal?: AbortSignal;
          }) => void | Promise<void>;
        };
      },
    ) {}

    async createSession(options: {
      sessionId?: string;
      abortSignal?: AbortSignal;
    }) {
      const session = await this.settings.sandbox.createSession(options);
      harnessMock.sessions.push(session);
      await this.settings.sandboxConfig?.onSession?.({
        session,
        sessionWorkDir: `${session.defaultWorkingDirectory}/pi-${options.sessionId ?? 'test'}`,
        ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
      });
      return {
        sessionId: options.sessionId ?? 'test',
        destroy: () => (session.destroy ? session.destroy() : session.stop()),
      };
    }

    stream() {
      return Promise.resolve({
        stream: {
          [Symbol.asyncIterator]() {
            let emitted = false;
            return {
              next: () => {
                if (emitted) {
                  return Promise.resolve({
                    done: true as const,
                    value: undefined,
                  });
                }
                emitted = true;
                return Promise.resolve({
                  done: false as const,
                  value: { type: 'finish', finishReason: 'stop' },
                });
              },
            };
          },
        },
      });
    }
  },
}));

vi.mock('@local/harness-pi-raw', async importOriginal => ({
  ...(await importOriginal<typeof import('@local/harness-pi-raw')>()),
  createPi: () => ({}),
}));
import type { ResolvedAgentConfig } from './create-agent.js';
import { defaultRuntime, resolveRunSandbox } from './runtime.js';
import {
  createSandbox,
  createVirtualSandbox,
  getSandboxInternals,
} from './sandbox-handle.js';
import { createSandboxProvider, type SandboxProvider } from './sandbox.js';

const config: ResolvedAgentConfig = {
  model: 'anthropic/test',
  systemPrompt: undefined,
  credentials: { mode: 'env' },
  toolNames: [],
  sandbox: { type: 'virtual' },
  maxRepairs: 1,
  extensions: [],
  thinkingLevel: undefined,
};

const schema = z.object({ ok: z.boolean() });

describe('resolveRunSandbox', () => {
  it('reuses a live sandbox handle and pins its session token', async () => {
    const sandbox = await createVirtualSandbox();
    try {
      const { provider, sessionId } = resolveRunSandbox({
        config,
        runOptions: { prompt: 'go', schema, sandbox },
      });
      expect(provider.providerId).toBe('runcell-reused-sandbox');
      expect(sessionId).toBe(getSandboxInternals(sandbox)?.sessionToken);
    } finally {
      await sandbox.destroy();
    }
  });

  it('reuses one custom-provider session across two run resolutions', async () => {
    const base = createSandboxProvider({ type: 'virtual' });
    const createSession = vi.fn(() => base.createSession());
    const custom: SandboxProvider = {
      ...base,
      providerId: 'custom-shared',
      createSession,
    };
    const sandbox = await createSandbox({ type: 'custom', provider: custom });
    try {
      for (const prompt of ['worker one', 'worker two']) {
        const resolved = resolveRunSandbox({
          config,
          runOptions: { prompt, schema, sandbox },
        });
        const session = await resolved.provider.createSession({
          sessionId: resolved.sessionId,
        });
        await session.stop();
        await session.destroy?.();
      }

      // createSandbox owns the only provider acquisition. The two run paths
      // receive guarded views of that same live session and cannot destroy it.
      expect(createSession).toHaveBeenCalledTimes(1);
      await expect(sandbox.exec('echo still-alive')).resolves.toMatchObject({
        exitCode: 0,
        stdout: 'still-alive\n',
      });
    } finally {
      await sandbox.destroy();
    }
    await expect(sandbox.exec('true')).rejects.toThrow(/destroyed/);
  });

  it('reuses one custom-provider session across real runtime runs', async () => {
    harnessMock.sessions.length = 0;
    const base = createSandboxProvider({ type: 'virtual' });
    const destroy = vi.fn<() => Promise<void>>(() => Promise.resolve());
    const createSession = vi.fn(
      async (options?: Parameters<SandboxProvider['createSession']>[0]) => {
        const session = await base.createSession(options);
        return new Proxy(session, {
          get(target, property, receiver) {
            if (property === 'destroy') return destroy;
            const value = Reflect.get(target, property, receiver) as unknown;
            return typeof value === 'function'
              ? (value as (...args: unknown[]) => unknown).bind(target)
              : value;
          },
        });
      },
    );
    const custom: SandboxProvider = {
      specificationVersion: 'harness-sandbox-v1',
      providerId: 'custom-runtime-shared',
      createSession,
    };
    const sandbox = await createSandbox({ type: 'custom', provider: custom });

    await sandbox.writeFile('marker.txt', 'shared');
    try {
      for (const prompt of ['worker one', 'worker two']) {
        await defaultRuntime.run({
          agentOptions: { model: 'anthropic/test' },
          config,
          runOptions: { prompt, sandbox },
        });
      }

      expect(createSession).toHaveBeenCalledTimes(1);
      expect(destroy).not.toHaveBeenCalled();
      expect(harnessMock.sessions).toHaveLength(2);
      expect(harnessMock.sessions[0]).toBe(harnessMock.sessions[1]);
      expect(harnessMock.sessions[0]?.id).toBe(sandbox.id);
      await expect(sandbox.readTextFile('marker.txt')).resolves.toBe('shared');
    } finally {
      await sandbox.destroy();
    }
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('creates an ephemeral provider for a sandbox option and forwards the run session id', () => {
    const { provider, sessionId } = resolveRunSandbox({
      config,
      runOptions: { prompt: 'go', schema, sessionId: 'run-123' },
    });
    expect(provider.providerId).not.toBe('runcell-reused-sandbox');
    expect(sessionId).toBe('run-123');
  });

  it('falls back to the agent-level sandbox when no run sandbox is given', () => {
    const { provider } = resolveRunSandbox({
      config,
      runOptions: { prompt: 'go', schema },
    });
    // virtual config maps to the just-bash provider
    expect(provider.providerId).toBe('just-bash-sandbox');
  });
});
