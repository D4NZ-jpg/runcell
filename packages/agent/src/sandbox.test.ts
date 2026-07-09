import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InvalidOptionError } from './errors.js';
import { createSandboxProvider, resolveSandboxConfig } from './sandbox.js';

afterEach(() => {
  vi.doUnmock('@ai-sdk/sandbox-vercel');
});

describe('resolveSandboxConfig', () => {
  it('defaults to virtual sandbox mode', () => {
    expect(resolveSandboxConfig(undefined)).toEqual({ type: 'virtual' });
    expect(resolveSandboxConfig('virtual')).toEqual({ type: 'virtual' });
    expect(resolveSandboxConfig({ type: 'virtual' })).toEqual({
      type: 'virtual',
    });
  });

  it('accepts custom providers', () => {
    const provider = {
      specificationVersion: 'harness-sandbox-v1' as const,
      providerId: 'custom',
      createSession: () => Promise.reject(new Error('unused')),
    };

    expect(resolveSandboxConfig({ type: 'custom', provider })).toEqual({
      type: 'custom',
      provider,
    });
  });

  it('rejects host mode without explicit external isolation', () => {
    expect(() =>
      resolveSandboxConfig({
        type: 'host',
        rootDir: '/workspace',
        isolation: 'external-ish',
      }),
    ).toThrow(InvalidOptionError);
  });

  it('accepts vercel sandbox settings', () => {
    expect(
      resolveSandboxConfig({
        type: 'vercel',
        runtime: 'node24',
        ports: [3000],
        timeout: 60_000,
      }),
    ).toEqual({
      type: 'vercel',
      runtime: 'node24',
      ports: [3000],
      timeout: 60_000,
    });
  });

  it('rejects pre-created vercel sandboxes', () => {
    expect(() => resolveSandboxConfig({ type: 'vercel', sandbox: {} })).toThrow(
      InvalidOptionError,
    );
  });

  it('rejects invalid custom providers', () => {
    expect(() =>
      resolveSandboxConfig({ type: 'custom', provider: {} }),
    ).toThrow(InvalidOptionError);
  });
});

describe('host sandbox provider', () => {
  it('maps the virtual session workspace to rootDir', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'runcell-host-'));
    const provider = createSandboxProvider({
      type: 'host',
      rootDir,
      isolation: 'external',
    });
    const session = await provider.createSession({ sessionId: 'test-session' });

    await session.writeTextFile({
      path: '/workspace/pi-test-session/input.txt',
      content: 'hello',
    });

    await expect(
      readFile(path.join(rootDir, 'input.txt'), 'utf-8'),
    ).resolves.toBe('hello');
    await expect(
      session.readTextFile({ path: '/workspace/pi-test-session/input.txt' }),
    ).resolves.toBe('hello');
  });

  it('runs commands from the host root and translates visible cwd output', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'runcell-host-'));
    const provider = createSandboxProvider({
      type: 'host',
      rootDir,
      isolation: 'external',
    });
    const session = await provider.createSession({ sessionId: 'test-session' });

    const result = await session.run({
      workingDirectory: '/workspace/pi-test-session',
      command: 'pwd && printf changed > /workspace/pi-test-session/out.txt',
    });

    expect(result).toMatchObject({
      exitCode: 0,
      stdout: '/workspace/pi-test-session\n',
      stderr: '',
    });
    await expect(
      readFile(path.join(rootDir, 'out.txt'), 'utf-8'),
    ).resolves.toBe('changed');
  });

  it('rejects commands when the abort signal is already aborted', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'runcell-host-'));
    const provider = createSandboxProvider({
      type: 'host',
      rootDir,
      isolation: 'external',
    });
    const session = await provider.createSession({ sessionId: 'test-session' });

    await expect(
      session.run({
        command: `printf ran > ${path.join(rootDir, 'ran.txt')}`,
        abortSignal: AbortSignal.abort(),
      }),
    ).rejects.toThrow('aborted');
    await expect(readFile(path.join(rootDir, 'ran.txt'))).rejects.toThrow();
  });

  it('rejects wait() when the shell cannot spawn', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'runcell-host-'));
    const provider = createSandboxProvider({
      type: 'host',
      rootDir,
      isolation: 'external',
    });
    const session = await provider.createSession({ sessionId: 'test-session' });

    const proc = await session.spawn({
      command: 'echo hi',
      workingDirectory: '/workspace/does-not-exist',
    });

    await expect(proc.wait()).rejects.toThrow('ENOENT');
  });

  it('maps signal-terminated commands to 128 + signal number', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'runcell-host-'));
    const provider = createSandboxProvider({
      type: 'host',
      rootDir,
      isolation: 'external',
    });
    const session = await provider.createSession({ sessionId: 'test-session' });

    const result = await session.run({ command: 'kill -TERM $$' });

    expect(result.exitCode).toBe(143);
  });

  it('rejects file access outside rootDir', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'runcell-host-'));
    const provider = createSandboxProvider({
      type: 'host',
      rootDir,
      isolation: 'external',
    });
    const session = await provider.createSession({ sessionId: 'test-session' });

    await expect(
      session.writeTextFile({ path: '/tmp/outside.txt', content: 'nope' }),
    ).rejects.toThrow('escapes rootDir');
  });
});

describe('vercel sandbox provider', () => {
  it('loads the optional provider only when a session starts', async () => {
    const mockSession = { id: 'vercel-session' };
    const createSession = vi.fn().mockResolvedValue(mockSession);
    const resumeSession = vi.fn().mockResolvedValue(mockSession);
    const createVercelSandbox = vi.fn(() => ({
      specificationVersion: 'harness-sandbox-v1',
      providerId: 'vercel-sandbox',
      createSession,
      resumeSession,
    }));
    vi.doMock('@ai-sdk/sandbox-vercel', () => ({ createVercelSandbox }));

    const provider = createSandboxProvider({
      type: 'vercel',
      runtime: 'node24',
      ports: [3000],
      timeout: 60_000,
    });

    expect(createVercelSandbox).not.toHaveBeenCalled();
    await expect(
      provider.createSession({ sessionId: 'test-session' }),
    ).resolves.toBe(mockSession);
    expect(createVercelSandbox).toHaveBeenCalledWith({
      runtime: 'node24',
      ports: [3000],
      timeout: 60_000,
    });
    expect(createSession).toHaveBeenCalledWith({ sessionId: 'test-session' });

    await expect(
      provider.resumeSession?.({ sessionId: 'test-session' }),
    ).resolves.toBe(mockSession);
    expect(resumeSession).toHaveBeenCalledWith({ sessionId: 'test-session' });
  });
});
