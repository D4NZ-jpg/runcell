import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InvalidOptionError } from './errors.js';
import { createSandboxProvider, resolveSandboxConfig } from './sandbox.js';

afterEach(() => {
  vi.doUnmock('@ai-sdk/sandbox-vercel');
  vi.unstubAllEnvs();
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

  it('rejects invalid inheritHostEnv values', () => {
    expect(() =>
      resolveSandboxConfig({
        type: 'host',
        rootDir: '/tmp/x',
        isolation: 'external',
        inheritHostEnv: 'yes',
      }),
    ).toThrow('"inheritHostEnv" must be a boolean');
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

  it('exposes only system vars and explicit opt-ins by default', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-secret');
    vi.stubEnv('HARMLESS_VAR', 'still-hidden');

    const rootDir = await mkdtemp(path.join(tmpdir(), 'runcell-host-'));
    const provider = createSandboxProvider({
      type: 'host',
      rootDir,
      isolation: 'external',
      env: { OPENAI_API_KEY: 'explicitly-exposed' },
    });
    const session = await provider.createSession({ sessionId: 'test-session' });

    const result = await session.run({
      command:
        'printf "%s|%s|%s" "$ANTHROPIC_API_KEY" "$HARMLESS_VAR" "$OPENAI_API_KEY" && test -n "$PATH" && test -n "$HOME"',
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('||explicitly-exposed');
  });

  it('gives per-command env precedence over opt-in env and baseline', async () => {
    vi.stubEnv('LC_ALL', 'en_US.UTF-8');

    const rootDir = await mkdtemp(path.join(tmpdir(), 'runcell-host-'));
    const provider = createSandboxProvider({
      type: 'host',
      rootDir,
      isolation: 'external',
      env: { FROM_SETTINGS: 'settings', OVERRIDDEN: 'settings' },
    });
    const session = await provider.createSession({ sessionId: 'test-session' });

    const result = await session.run({
      command: 'printf "%s|%s|%s" "$FROM_SETTINGS" "$OVERRIDDEN" "$LC_ALL"',
      env: { OVERRIDDEN: 'per-command' },
    });

    expect(result.stdout).toBe('settings|per-command|en_US.UTF-8');
  });

  it('inherits the full environment when inheritHostEnv is true', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-secret');

    const rootDir = await mkdtemp(path.join(tmpdir(), 'runcell-host-'));
    const provider = createSandboxProvider({
      type: 'host',
      rootDir,
      isolation: 'external',
      inheritHostEnv: true,
    });
    const session = await provider.createSession({ sessionId: 'test-session' });

    const result = await session.run({
      command: 'printf "%s" "$ANTHROPIC_API_KEY"',
    });

    expect(result.stdout).toBe('sk-secret');
  });

  it('drops opt-in env entries whose value is undefined', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'runcell-host-'));
    const provider = createSandboxProvider({
      type: 'host',
      rootDir,
      isolation: 'external',
      env: { NOT_SET_ON_HOST: undefined, PRESENT: 'yes' },
    });
    const session = await provider.createSession({ sessionId: 'test-session' });

    const result = await session.run({
      command: 'printf "%s|%s" "${NOT_SET_ON_HOST-unset}" "$PRESENT"',
    });

    expect(result.stdout).toBe('unset|yes');
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
