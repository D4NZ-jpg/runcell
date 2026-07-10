import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentSession,
  ResourceLoader,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type {
  HarnessV1NetworkSandboxSession,
  HarnessV1Session,
  HarnessV1ToolSpec,
} from '@ai-sdk/harness';
import { createPiSession, PiExtensionError } from './pi-session';

type FakePiTool = Pick<ToolDefinition, 'name' | 'execute'>;

const piMock = vi.hoisted(() => {
  return {
    createAgentSession: vi.fn(),
    customTools: [] as FakePiTool[],
    session: undefined as AgentSession | undefined,
    extensionErrors: [] as { path: string; error: string }[],
    extensions: [] as { tools: Map<string, unknown> }[],
  };
});

vi.mock('@earendil-works/pi-coding-agent', () => {
  return {
    AuthStorage: {
      create: vi.fn(() => ({
        setRuntimeApiKey: vi.fn(),
      })),
    },
    createAgentSession: piMock.createAgentSession,
    DefaultResourceLoader: class {
      getExtensions() {
        return {
          runtime: { pendingProviderRegistrations: [] },
          errors: piMock.extensionErrors,
          extensions: piMock.extensions,
        };
      }
      async reload() {}
    },
    defineTool: vi.fn(tool => tool),
    ModelRegistry: {
      create: vi.fn(() => ({
        getAll: vi.fn(() => []),
        registerProvider: vi.fn(),
      })),
    },
    SessionManager: {
      create: vi.fn(() => ({
        getSessionFile: () => undefined,
      })),
      open: vi.fn(() => ({
        getSessionFile: () => undefined,
      })),
    },
    SettingsManager: {
      inMemory: vi.fn(() => ({})),
    },
  };
});

describe('createPiSession', () => {
  beforeEach(() => {
    piMock.customTools = [];
    piMock.session = undefined;
    piMock.extensionErrors = [];
    piMock.extensions = [];
    piMock.createAgentSession.mockReset();
    piMock.createAgentSession.mockImplementation(async options => {
      piMock.customTools = options.customTools;
      return { session: piMock.session };
    });
  });

  it('parks a pending tool turn on suspend and resumes it in-process', async () => {
    const toolStarted = createDeferred<void>();
    let resolvedToolResult: unknown;
    const prompt = vi.fn(async () => {
      const tool = piMock.customTools.find(tool => tool.name === 'weather');
      if (!tool) throw new Error('Expected weather tool.');
      const toolResultPromise = tool.execute(
        'tool-1',
        {},
        undefined,
        undefined,
        undefined as never,
      );
      toolStarted.resolve();
      resolvedToolResult = await toolResultPromise;
    });
    const abort = vi.fn(async () => {});
    piMock.session = createPiAgentSession({ abort, prompt });

    const sandboxSession = createSandboxSession();
    const session = await createPiSession({
      sessionId: 'session-1',
      sandboxSession,
      sessionWorkDir: '/sandbox/work',
      skills: [],
      settings: {},
      isResume: false,
    });
    const toolSpecs: HarnessV1ToolSpec[] = [{ name: 'weather' }];
    const control = await session.doPromptTurn({
      prompt: 'go',
      tools: toolSpecs,
      emit: vi.fn(),
    });

    await toolStarted.promise;
    await expect(session.doSuspendTurn()).resolves.toEqual({
      type: 'continue-turn',
      harnessId: 'pi',
      specificationVersion: 'harness-v1',
      data: {},
    });
    expect(abort).not.toHaveBeenCalled();

    const resumedSession = await createPiSession({
      sessionId: 'session-1',
      sandboxSession,
      sessionWorkDir: '/sandbox/work',
      skills: [],
      settings: {},
      isResume: true,
    });
    const resumedControl = await resumedSession.doContinueTurn({
      tools: toolSpecs,
      emit: vi.fn(),
    });

    await resumedControl.submitToolResult({
      toolCallId: 'tool-1',
      output: { weather: 'sunny' },
    });
    await resumedControl.done;
    await control.done;

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(resolvedToolResult).toMatchInlineSnapshot(
      {
        content: [{ type: 'text', text: '{"weather":"sunny"}' }],
        details: undefined,
      },
      `
      {
        "content": [
          {
            "text": "{"weather":"sunny"}",
            "type": "text",
          },
        ],
        "details": undefined,
      }
    `,
    );
  });

  it('unwinds the VFS mount and host tmpdir when initialization fails', async () => {
    const sessionWorkDir = '/sandbox/work-init-fail';
    const hostRoot = path.join(
      tmpdir(),
      'ai-sdk-harness',
      'pi',
      'session-init-fail',
    );
    const reload = vi.fn(async () => {
      throw new Error('resource loader boom');
    });
    const failingLoader = { reload } as unknown as ResourceLoader;

    await expect(
      createPiSession({
        sessionId: 'session-init-fail',
        sandboxSession: createSandboxSession(),
        sessionWorkDir,
        skills: [],
        settings: { resourceLoader: failingLoader },
        isResume: false,
      }),
    ).rejects.toThrow('resource loader boom');

    expect(reload).toHaveBeenCalledTimes(1);
    // The host tmpdir mirror was removed.
    expect(fs.existsSync(hostRoot)).toBe(false);
    // The process-global VFS mapping was unmounted: even with the backing
    // directory recreated, the sandbox mount point no longer resolves to it.
    fs.mkdirSync(path.join(hostRoot, 'workspace'), { recursive: true });
    expect(fs.existsSync(sessionWorkDir)).toBe(false);
    fs.rmSync(hostRoot, { recursive: true, force: true });
  });

  it('rejects when a supplied extension fails to load', async () => {
    piMock.extensionErrors = [
      { path: '<inline:1>', error: 'keychain unavailable' },
    ];

    await expect(
      createPiSession({
        sessionId: 'session-ext-fail',
        sandboxSession: createSandboxSession(),
        sessionWorkDir: '/sandbox/ext-fail',
        skills: [],
        settings: {},
        isResume: false,
      }),
    ).rejects.toThrow(PiExtensionError);
    await expect(
      createPiSession({
        sessionId: 'session-ext-fail-2',
        sandboxSession: createSandboxSession(),
        sessionWorkDir: '/sandbox/ext-fail-2',
        skills: [],
        settings: {},
        isResume: false,
      }),
    ).rejects.toThrow(/<inline:1>: keychain unavailable/);
  });

  it('rejects an extension tool that collides with an adapter tool', async () => {
    piMock.extensions = [{ tools: new Map([['weather', {}]]) }];
    piMock.session = createPiAgentSession();

    const session = await createPiSession({
      sessionId: 'session-collision',
      sandboxSession: createSandboxSession(),
      sessionWorkDir: '/sandbox/collision',
      skills: [],
      settings: {},
      isResume: false,
    });

    await expect(
      session.doPromptTurn({
        prompt: 'go',
        tools: [{ name: 'weather' }],
        emit: vi.fn(),
      }),
    ).rejects.toThrow(/"weather" collides/);

    await session.doDestroy();
  });

  it('emits session_shutdown to extensions before disposing', async () => {
    const events: unknown[] = [];
    const dispose = vi.fn(() => {
      events.push('dispose');
    });
    piMock.session = createPiAgentSession({
      dispose,
      extensionRunner: {
        hasHandlers: vi.fn((name: string) => name === 'session_shutdown'),
        emit: vi.fn(async (event: unknown) => {
          events.push(event);
        }),
      },
    });

    const session = await createPiSession({
      sessionId: 'session-shutdown',
      sandboxSession: createSandboxSession(),
      sessionWorkDir: '/sandbox/shutdown',
      skills: [],
      settings: {},
      isResume: false,
    });
    const control = await session.doPromptTurn({
      prompt: 'go',
      tools: [],
      emit: vi.fn(),
    });
    await control.done;

    await session.doStop();

    expect(events).toEqual([
      { type: 'session_shutdown', reason: 'quit' },
      'dispose',
    ]);
  });

  it('caps parked sessions and destroys the oldest on overflow', async () => {
    const disposes: ReturnType<typeof vi.fn>[] = [];
    const sessions: HarnessV1Session[] = [];

    // Park cap + 1 sessions, each with a live turn (never-resolving prompt).
    for (let i = 0; i < 9; i++) {
      const dispose = vi.fn();
      disposes.push(dispose);
      piMock.session = createPiAgentSession({
        dispose,
        prompt: vi.fn(() => new Promise(() => {})),
      });

      const session = await createPiSession({
        sessionId: `park-${i}`,
        sandboxSession: createSandboxSession(),
        sessionWorkDir: `/sandbox/park-${i}`,
        skills: [],
        settings: {},
        isResume: false,
      });
      sessions.push(session);
      await session.doPromptTurn({ prompt: 'go', tools: [], emit: vi.fn() });
      await session.doDetach();
    }

    // The 9th park evicts and destroys the oldest parked session (cap = 8).
    await vi.waitFor(() => expect(disposes[0]).toHaveBeenCalledTimes(1));
    expect(disposes[1]).not.toHaveBeenCalled();
    expect(disposes[8]).not.toHaveBeenCalled();

    // A still-parked session still resumes in-process (same live closures).
    const resumed = await createPiSession({
      sessionId: 'park-1',
      sandboxSession: createSandboxSession(),
      sessionWorkDir: '/sandbox/park-1',
      skills: [],
      settings: {},
      isResume: true,
    });
    expect(resumed.doStop).toBe(sessions[1]!.doStop);

    // Cleanup: release everything this test parked.
    for (const session of sessions.slice(1)) {
      await session.doDestroy();
    }
  });
});

function createPiAgentSession(
  overrides: Record<string, unknown> = {},
): AgentSession {
  return {
    abort: vi.fn(async () => {}),
    compact: vi.fn(async () => {}),
    dispose: vi.fn(),
    extensionRunner: {
      hasHandlers: vi.fn(() => false),
      emit: vi.fn(async () => {}),
    },
    getAllTools: vi.fn(() => []),
    getSessionStats: () => ({
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }),
    prompt: vi.fn(async () => {}),
    setActiveToolsByName: vi.fn(),
    steer: vi.fn(async () => {}),
    subscribe: vi.fn(() => () => {}),
    ...overrides,
  } as unknown as AgentSession;
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createSandboxSession(): HarnessV1NetworkSandboxSession {
  const sandbox = {
    defaultWorkingDirectory: '/sandbox',
    destroy: vi.fn(async () => {}),
    getPortUrl: vi.fn(),
    readBinaryFile: vi.fn(async () => undefined),
    restricted: vi.fn(() => sandbox),
    run: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
    stop: vi.fn(async () => {}),
    writeBinaryFile: vi.fn(async () => {}),
    writeTextFile: vi.fn(async () => {}),
  };
  return sandbox as unknown as HarnessV1NetworkSandboxSession;
}
