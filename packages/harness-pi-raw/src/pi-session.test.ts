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
import {
  createPiSession,
  getPiSessionUsageTotals,
  PI_SILENT_TURN_ABORT_REASON,
  PiExtensionError,
} from './pi-session';
import { toolContent } from './tool-content';

type FakePiTool = Pick<ToolDefinition, 'name' | 'execute'>;

const piMock = vi.hoisted(() => {
  return {
    createAgentSession: vi.fn(),
    modelRuntimeCreate: vi.fn(),
    customTools: [] as FakePiTool[],
    models: [] as { id: string; name: string; provider: string }[],
    session: undefined as AgentSession | undefined,
    extensionErrors: [] as { path: string; error: string }[],
    extensions: [] as { tools: Map<string, unknown> }[],
  };
});

vi.mock('@earendil-works/pi-coding-agent', () => {
  return {
    ModelRuntime: {
      create: piMock.modelRuntimeCreate,
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
    piMock.models = [];
    piMock.session = undefined;
    piMock.extensionErrors = [];
    piMock.extensions = [];
    piMock.createAgentSession.mockReset();
    piMock.modelRuntimeCreate.mockReset();
    piMock.modelRuntimeCreate.mockImplementation(() =>
      Promise.resolve({
        getModels: vi.fn(() => piMock.models),
        registerProvider: vi.fn(),
        setRuntimeApiKey: vi.fn(() => Promise.resolve()),
      }),
    );
    piMock.createAgentSession.mockImplementation(async options => {
      piMock.customTools = options.customTools;
      return { session: piMock.session };
    });
  });

  it('disables model network access for adapter-created runtimes', async () => {
    const session = await createPiSession({
      sessionId: 'session-1',
      sandboxSession: createSandboxSession(),
      sessionWorkDir: '/sandbox/work',
      skills: [],
      settings: {},
      isResume: false,
    });

    expect(piMock.modelRuntimeCreate).toHaveBeenCalledWith(
      expect.objectContaining({ allowModelNetwork: false }),
    );
    await session.doDestroy();
  });

  it('emits per-turn usage and cost deltas on finish', async () => {
    // First call is the turn-start snapshot, second the turn-end snapshot.
    const statsQueue = [
      {
        tokens: { input: 50, output: 10, cacheRead: 100, cacheWrite: 5 },
        cost: 0.25,
      },
      {
        tokens: { input: 80, output: 25, cacheRead: 160, cacheWrite: 9 },
        cost: 0.75,
      },
    ];
    piMock.session = createPiAgentSession({
      getSessionStats: () =>
        statsQueue.length > 1 ? statsQueue.shift() : statsQueue[0],
    });
    const session = await createPiSession({
      sessionId: 'session-usage',
      sandboxSession: createSandboxSession(),
      sessionWorkDir: '/sandbox/work',
      skills: [],
      settings: {},
      isResume: false,
    });
    const emit = vi.fn();
    const control = await session.doPromptTurn({ prompt: 'go', tools: [], emit });
    await control.done;

    const finish = emit.mock.calls
      .map(([part]) => part as { type: string; [key: string]: unknown })
      .find(part => part.type === 'finish');
    expect(finish?.['totalUsage']).toEqual({
      inputTokens: { total: 94, noCache: 30, cacheRead: 60, cacheWrite: 4 },
      outputTokens: { total: 15, text: undefined, reasoning: undefined },
    });
    expect(finish?.['harnessMetadata']).toEqual({ pi: { costUsd: 0.5 } });
    // The same delta lands on this exact session instance, which hosts read
    // to reconcile run usage when stream metadata is lost downstream.
    expect(getPiSessionUsageTotals(session)).toEqual({
      inputTokens: 30,
      outputTokens: 15,
      cacheReadTokens: 60,
      cacheWriteTokens: 4,
      costUsd: 0.5,
    });
    expect(getPiSessionUsageTotals({})).toBeUndefined();
    await session.doDestroy();
    // The opaque source remains a stable snapshot even after teardown.
    expect(getPiSessionUsageTotals(session)).toEqual({
      inputTokens: 30,
      outputTokens: 15,
      cacheReadTokens: 60,
      cacheWriteTokens: 4,
      costUsd: 0.5,
    });
  });

  it('keeps concurrent same-id session totals and deltas independent', async () => {
    const promptA = createDeferred<void>();
    const promptB = createDeferred<void>();
    let statsA = {
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      cost: 0,
    };
    let statsB = {
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      cost: 0,
    };

    const piSessionA = createPiAgentSession({
      prompt: vi.fn(() => promptA.promise),
      getSessionStats: () => statsA,
    });
    const piSessionB = createPiAgentSession({
      prompt: vi.fn(() => promptB.promise),
      getSessionStats: () => statsB,
    });
    piMock.createAgentSession
      .mockResolvedValueOnce({ session: piSessionA })
      .mockResolvedValueOnce({ session: piSessionB });

    const sessionA = await createPiSession({
      sessionId: 'shared-session-id',
      sandboxSession: createSandboxSession(),
      sessionWorkDir: '/sandbox/work-a',
      skills: [],
      settings: {},
      isResume: false,
    });
    const sessionB = await createPiSession({
      sessionId: 'shared-session-id',
      sandboxSession: createSandboxSession(),
      sessionWorkDir: '/sandbox/work-b',
      skills: [],
      settings: {},
      isResume: false,
    });

    const emitA = vi.fn();
    const emitB = vi.fn();
    const controlA = await sessionA.doPromptTurn({
      prompt: 'a',
      tools: [],
      emit: emitA,
    });
    const controlB = await sessionB.doPromptTurn({
      prompt: 'b',
      tools: [],
      emit: emitB,
    });

    statsA = {
      tokens: { input: 11, output: 3, cacheRead: 2, cacheWrite: 1 },
      cost: 0.04,
    };
    statsB = {
      tokens: { input: 101, output: 30, cacheRead: 20, cacheWrite: 10 },
      cost: 0.4,
    };
    // Settle in reverse order so the assertion is independent of completion
    // order as well as the shared public session id.
    promptB.resolve();
    await controlB.done;
    promptA.resolve();
    await controlA.done;

    expect(getPiSessionUsageTotals(sessionA)).toEqual({
      inputTokens: 11,
      outputTokens: 3,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
      costUsd: 0.04,
    });
    expect(getPiSessionUsageTotals(sessionB)).toEqual({
      inputTokens: 101,
      outputTokens: 30,
      cacheReadTokens: 20,
      cacheWriteTokens: 10,
      costUsd: 0.4,
    });

    await sessionA.doDestroy();
    await sessionB.doDestroy();
  });

  it('silently aborts a terminal turn only after Pi prompt settles', async () => {
    const prompt = createDeferred<void>();
    const abort = vi.fn(async () => {});
    piMock.session = createPiAgentSession({
      abort,
      prompt: vi.fn(() => prompt.promise),
    });
    const session = await createPiSession({
      sessionId: 'session-1',
      sandboxSession: createSandboxSession(),
      sessionWorkDir: '/sandbox/work',
      skills: [],
      settings: {},
      isResume: false,
    });
    const controller = new AbortController();
    const emit = vi.fn();
    const control = await session.doPromptTurn({
      prompt: 'go',
      tools: [],
      emit,
      abortSignal: controller.signal,
    });
    let settled = false;
    void control.done.then(() => {
      settled = true;
    });

    controller.abort(PI_SILENT_TURN_ABORT_REASON);
    await vi.waitFor(() => expect(abort).toHaveBeenCalledTimes(1));
    expect(settled).toBe(false);

    prompt.reject(new DOMException('This operation was aborted', 'AbortError'));
    await control.done;
    expect(settled).toBe(true);
    expect(
      emit.mock.calls.some(([part]) => part.type === 'error'),
    ).toBe(false);
    await session.doDestroy();
  });

  it('flushes the turn usage when a silent abort ends the turn', async () => {
    // A structured-result submission aborts the turn with the silent reason;
    // the turn's usage delta must still be reported before the stream closes.
    const statsQueue = [
      {
        tokens: { input: 50, output: 10, cacheRead: 100, cacheWrite: 5 },
        cost: 0.25,
      },
      {
        tokens: { input: 80, output: 25, cacheRead: 160, cacheWrite: 9 },
        cost: 0.75,
      },
    ];
    const prompt = createDeferred<void>();
    const abort = vi.fn(async () => {});
    piMock.session = createPiAgentSession({
      abort,
      prompt: vi.fn(() => prompt.promise),
      getSessionStats: () =>
        statsQueue.length > 1 ? statsQueue.shift() : statsQueue[0],
    });
    const session = await createPiSession({
      sessionId: 'session-silent-usage',
      sandboxSession: createSandboxSession(),
      sessionWorkDir: '/sandbox/work',
      skills: [],
      settings: {},
      isResume: false,
    });
    const controller = new AbortController();
    const emit = vi.fn();
    const control = await session.doPromptTurn({
      prompt: 'go',
      tools: [],
      emit,
      abortSignal: controller.signal,
    });

    controller.abort(PI_SILENT_TURN_ABORT_REASON);
    await vi.waitFor(() => expect(abort).toHaveBeenCalledTimes(1));
    prompt.reject(new DOMException('This operation was aborted', 'AbortError'));
    await control.done;

    const parts = emit.mock.calls.map(
      ([part]) => part as { type: string; [key: string]: unknown },
    );
    expect(parts.some(part => part.type === 'error')).toBe(false);
    expect(parts.some(part => part.type === 'finish-step')).toBe(true);
    const finish = parts.find(part => part.type === 'finish');
    expect(finish?.['totalUsage']).toEqual({
      inputTokens: { total: 94, noCache: 30, cacheRead: 60, cacheWrite: 4 },
      outputTokens: { total: 15, text: undefined, reasoning: undefined },
    });
    expect(finish?.['harnessMetadata']).toEqual({ pi: { costUsd: 0.5 } });
    // The aborted turn's delta is also recorded on this session instance.
    expect(getPiSessionUsageTotals(session)).toEqual({
      inputTokens: 30,
      outputTokens: 15,
      cacheReadTokens: 60,
      cacheWriteTokens: 4,
      costUsd: 0.5,
    });
    await session.doDestroy();
  });

  it('surfaces an ordinary caller abort after Pi prompt settles', async () => {
    const prompt = createDeferred<void>();
    const abort = vi.fn(async () => {});
    piMock.session = createPiAgentSession({
      abort,
      prompt: vi.fn(() => prompt.promise),
    });
    const session = await createPiSession({
      sessionId: 'session-1',
      sandboxSession: createSandboxSession(),
      sessionWorkDir: '/sandbox/work',
      skills: [],
      settings: {},
      isResume: false,
    });
    const controller = new AbortController();
    const emit = vi.fn();
    const control = await session.doPromptTurn({
      prompt: 'go',
      tools: [],
      emit,
      abortSignal: controller.signal,
    });

    controller.abort(new Error('caller cancelled'));
    await vi.waitFor(() => expect(abort).toHaveBeenCalledTimes(1));
    prompt.reject(new DOMException('This operation was aborted', 'AbortError'));
    await control.done;

    expect(
      emit.mock.calls.some(
        ([part]) =>
          part.type === 'error' &&
          (part.error as Error | undefined)?.name === 'AbortError',
      ),
    ).toBe(true);
    await session.doDestroy();
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

  it('routes a toolContent envelope to a multi-part Pi result', async () => {
    const toolStarted = createDeferred<void>();
    let resolvedToolResult: unknown;
    const prompt = vi.fn(async () => {
      const tool = piMock.customTools.find(tool => tool.name === 'render');
      if (!tool) throw new Error('Expected render tool.');
      const toolResultPromise = tool.execute(
        'tool-2',
        {},
        undefined,
        undefined,
        undefined as never,
      );
      toolStarted.resolve();
      resolvedToolResult = await toolResultPromise;
    });
    piMock.session = createPiAgentSession({ prompt });

    const session = await createPiSession({
      sessionId: 'session-tool-content',
      sandboxSession: createSandboxSession(),
      sessionWorkDir: '/sandbox/work-tool-content',
      skills: [],
      settings: {},
      isResume: false,
    });
    const control = await session.doPromptTurn({
      prompt: 'go',
      tools: [{ name: 'render' }] as HarnessV1ToolSpec[],
      emit: vi.fn(),
    });

    await toolStarted.promise;
    const png = new Uint8Array([1, 2, 3]);
    await control.submitToolResult({
      toolCallId: 'tool-2',
      output: toolContent([
        { type: 'text', text: 'Rendered page 1:' },
        { type: 'image', data: png, mediaType: 'image/png' },
      ]),
    });
    await control.done;

    expect(resolvedToolResult).toEqual({
      content: [
        { type: 'text', text: 'Rendered page 1:' },
        {
          type: 'image',
          data: Buffer.from(png).toString('base64'),
          mimeType: 'image/png',
        },
      ],
      details: undefined,
    });
  });

  it('keeps a bare content-look-alike array on the serialized text path', async () => {
    const toolStarted = createDeferred<void>();
    let resolvedToolResult: unknown;
    const prompt = vi.fn(async () => {
      const tool = piMock.customTools.find(tool => tool.name === 'catalog');
      if (!tool) throw new Error('Expected catalog tool.');
      const toolResultPromise = tool.execute(
        'tool-3',
        {},
        undefined,
        undefined,
        undefined as never,
      );
      toolStarted.resolve();
      resolvedToolResult = await toolResultPromise;
    });
    piMock.session = createPiAgentSession({ prompt });

    const session = await createPiSession({
      sessionId: 'session-look-alike',
      sandboxSession: createSandboxSession(),
      sessionWorkDir: '/sandbox/work-look-alike',
      skills: [],
      settings: {},
      isResume: false,
    });
    const control = await session.doPromptTurn({
      prompt: 'go',
      tools: [{ name: 'catalog' }] as HarnessV1ToolSpec[],
      emit: vi.fn(),
    });

    await toolStarted.promise;
    // AI SDK-shaped parts returned as plain data (no envelope) must stay on
    // the legacy stringify path, not be reinterpreted as image content.
    const lookAlike = [{ type: 'image', data: 'AAAA', mediaType: 'image/png' }];
    await control.submitToolResult({ toolCallId: 'tool-3', output: lookAlike });
    await control.done;

    expect(resolvedToolResult).toEqual({
      content: [{ type: 'text', text: JSON.stringify(lookAlike) }],
      details: undefined,
    });
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

  it('rejects a configured model id that resolves to nothing', async () => {
    piMock.models = [
      { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', provider: 'openai' },
      { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', provider: 'openai-codex' },
      { id: 'claude-opus-5', name: 'Claude Opus 5', provider: 'anthropic' },
    ];

    await expect(
      createPiSession({
        sessionId: 'session-bad-model',
        sandboxSession: createSandboxSession(),
        sessionWorkDir: '/sandbox/bad-model',
        skills: [],
        settings: { model: 'openai/gpt-5.6-lunna' },
        isResume: false,
      }),
    ).rejects.toThrow(
      /Unknown model "openai\/gpt-5\.6-lunna".*Did you mean.*openai\/gpt-5\.6-luna/,
    );
  });

  it('omits suggestions when nothing in the catalog is close', async () => {
    piMock.models = [
      { id: 'claude-opus-5', name: 'Claude Opus 5', provider: 'anthropic' },
    ];

    await expect(
      createPiSession({
        sessionId: 'session-bad-model-2',
        sandboxSession: createSandboxSession(),
        sessionWorkDir: '/sandbox/bad-model-2',
        skills: [],
        settings: { model: 'totally/unrelated' },
        isResume: false,
      }),
    ).rejects.toThrow(/Unknown model "totally\/unrelated"[^?]*$/);
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
