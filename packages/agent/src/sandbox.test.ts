import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { InvalidOptionError } from './errors.js';
import { createSandboxProvider, resolveSandboxConfig } from './sandbox.js';

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
