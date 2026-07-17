import { afterEach, describe, expect, it, vi } from 'vitest';
import { HARNESS_ID } from '@local/harness-pi-raw';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { InvalidOptionError } from './errors.js';
import {
  createReusedSandboxProvider,
  createSandbox,
  createVirtualSandbox,
  getSandboxInternals,
  restoreSandbox,
  type Sandbox,
} from './sandbox-handle.js';
import { createSandboxProvider, type SandboxProvider } from './sandbox.js';

const vercelMock = vi.hoisted(() => ({
  createProvider: vi.fn(),
}));

vi.mock('@ai-sdk/sandbox-vercel', () => ({
  createVercelSandbox: vercelMock.createProvider,
}));

afterEach(() => {
  vercelMock.createProvider.mockReset();
});

async function withSandbox(fn: (sandbox: Sandbox) => Promise<void> | void) {
  const sandbox = await createVirtualSandbox();
  try {
    await fn(sandbox);
  } finally {
    await sandbox.destroy();
  }
}

describe('createSandbox', () => {
  it('defaults to a caller-owned virtual sandbox', async () => {
    const sandbox = await createSandbox();
    try {
      expect(sandbox.capabilities).toEqual({
        ports: false,
        nativeSnapshot: false,
        resume: false,
      });
      await sandbox.writeFile('input.txt', 'hello');
      expect(await sandbox.readTextFile('input.txt')).toBe('hello');
      expect((await sandbox.exec('cat input.txt')).stdout).toBe('hello');
      expect(await sandbox.snapshot()).toEqual({
        version: 1,
        files: [{ path: 'input.txt', data: 'aGVsbG8=' }],
      });
    } finally {
      await sandbox.destroy();
    }
    await expect(sandbox.exec('true')).rejects.toThrow(/destroyed/);
  });

  it('creates a caller-owned host sandbox', async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), 'runcell-handle-host-'));
    try {
      const sandbox = await createSandbox({
        type: 'host',
        rootDir,
        isolation: 'external',
      });
      try {
        expect(sandbox.capabilities).toEqual({
          ports: false,
          nativeSnapshot: false,
          resume: true,
        });
        await sandbox.writeFile('marker.txt', 'host workspace');
        expect(await sandbox.readTextFile('marker.txt')).toBe('host workspace');
        // The handle and agent workspace both map directly to rootDir. A
        // mismatched provider session id would leave this under rootDir/pi-*.
        await expect(
          readFile(path.join(rootDir, 'marker.txt'), 'utf8'),
        ).resolves.toBe('host workspace');
      } finally {
        await sandbox.destroy();
      }
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it('creates one custom-provider session and reports conservative capabilities', async () => {
    const base = createSandboxProvider({ type: 'virtual' });
    const createSession = vi.fn(
      (options?: Parameters<SandboxProvider['createSession']>[0]) =>
        base.createSession(options),
    );
    const provider: SandboxProvider = {
      ...base,
      providerId: 'test-custom',
      createSession,
      resumeSession: options => base.createSession(options),
    };

    const sandbox = await createSandbox({ type: 'custom', provider });
    try {
      expect(createSession).toHaveBeenCalledTimes(1);
      expect(sandbox.capabilities).toEqual({
        ports: false,
        nativeSnapshot: false,
        resume: true,
      });
      await sandbox.writeFile('shared.txt', 'same vm');
      expect(await sandbox.readTextFile('shared.txt')).toBe('same vm');
    } finally {
      await sandbox.destroy();
    }
  });

  it('uses the harness workdir composition for root-based custom providers', async () => {
    const base = createSandboxProvider({ type: 'virtual' });
    const created = await base.createSession();
    const writeTextFile = vi.fn(created.writeTextFile.bind(created));
    const createSession = vi.fn(() =>
      Promise.resolve(
        new Proxy(created, {
          get(target, property, receiver) {
            if (property === 'defaultWorkingDirectory') return '/';
            if (property === 'writeTextFile') return writeTextFile;
            const value = Reflect.get(target, property, receiver) as unknown;
            return typeof value === 'function'
              ? (value as (...args: unknown[]) => unknown).bind(target)
              : value;
          },
        }),
      ),
    );
    const provider: SandboxProvider = {
      specificationVersion: 'harness-sandbox-v1',
      providerId: 'root-custom',
      createSession,
    };

    const sandbox = await createSandbox({ type: 'custom', provider });
    try {
      const token = getSandboxInternals(sandbox)?.sessionToken;
      expect(token).toBeDefined();
      expect(createSession).toHaveBeenCalledWith({ sessionId: token });
      await sandbox.writeFile('marker.txt', 'root workspace');
      expect(writeTextFile).toHaveBeenCalledWith({
        path: path.posix.join('/', `${HARNESS_ID}-${token}`, 'marker.txt'),
        content: 'root workspace',
      });
      expect(
        (writeTextFile.mock.calls[0]?.[0] as { path: string }).path,
      ).not.toContain('//');
    } finally {
      await sandbox.destroy();
    }
  });

  it('loads the Vercel provider lazily and exposes configured ports', async () => {
    const base = createSandboxProvider({ type: 'virtual' });
    vercelMock.createProvider.mockImplementation(
      () =>
        ({
          specificationVersion: 'harness-sandbox-v1',
          providerId: 'mock-vercel',
          createSession: async options => {
            const session = await base.createSession(options);
            return new Proxy(session, {
              get(target, property, receiver) {
                if (property === 'getPortUrl') {
                  return ({ port }: { port: number }) =>
                    Promise.resolve(`https://sandbox.test:${port}`);
                }
                const value = Reflect.get(
                  target,
                  property,
                  receiver,
                ) as unknown;
                return typeof value === 'function'
                  ? (value as (...args: unknown[]) => unknown).bind(target)
                  : value;
              },
            });
          },
          resumeSession: options => base.createSession(options),
        }) satisfies SandboxProvider,
    );

    const sandbox = await createSandbox({
      type: 'vercel',
      runtime: 'node24',
      ports: [3000],
    });
    try {
      expect(vercelMock.createProvider).toHaveBeenCalledWith({
        runtime: 'node24',
        ports: [3000],
      });
      expect(sandbox.capabilities).toEqual({
        ports: true,
        nativeSnapshot: false,
        resume: true,
      });
      await expect(sandbox.exposeUrl?.(3000)).resolves.toBe(
        'https://sandbox.test:3000',
      );
    } finally {
      await sandbox.destroy();
    }
  });

  it('propagates Vercel session creation failures', async () => {
    vercelMock.createProvider.mockReturnValue({
      specificationVersion: 'harness-sandbox-v1',
      providerId: 'mock-vercel',
      createSession: () => Promise.reject(new Error('create failed')),
    });

    await expect(createSandbox({ type: 'vercel' })).rejects.toThrow(
      'create failed',
    );
  });

  it('destroys an acquired session when workspace setup fails', async () => {
    const base = createSandboxProvider({ type: 'virtual' });
    const session = await base.createSession();
    const destroy = vi.fn(() => session.destroy?.());
    const provider: SandboxProvider = {
      specificationVersion: 'harness-sandbox-v1',
      providerId: 'failing-custom',
      createSession: () =>
        Promise.resolve(
          new Proxy(session, {
            get(target, property, receiver) {
              if (property === 'run') {
                return () => Promise.reject(new Error('mkdir failed'));
              }
              if (property === 'destroy') return destroy;
              const value = Reflect.get(target, property, receiver) as unknown;
              return typeof value === 'function'
                ? (value as (...args: unknown[]) => unknown).bind(target)
                : value;
            },
          }),
        ),
    };

    await expect(createSandbox({ type: 'custom', provider })).rejects.toThrow(
      'mkdir failed',
    );
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('destroys an acquired session when workspace setup exits nonzero', async () => {
    const base = createSandboxProvider({ type: 'virtual' });
    const session = await base.createSession();
    const destroy = vi.fn(() => session.destroy?.());
    const provider: SandboxProvider = {
      specificationVersion: 'harness-sandbox-v1',
      providerId: 'nonzero-custom',
      createSession: () =>
        Promise.resolve(
          new Proxy(session, {
            get(target, property, receiver) {
              if (property === 'run') {
                return () =>
                  Promise.resolve({
                    exitCode: 13,
                    stdout: '',
                    stderr: 'permission denied',
                  });
              }
              if (property === 'destroy') return destroy;
              const value = Reflect.get(target, property, receiver) as unknown;
              return typeof value === 'function'
                ? (value as (...args: unknown[]) => unknown).bind(target)
                : value;
            },
          }),
        ),
    };

    await expect(createSandbox({ type: 'custom', provider })).rejects.toThrow(
      /exit code 13.*permission denied/,
    );
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('uses existing sandbox option validation', async () => {
    await expect(
      createSandbox({ type: 'host', isolation: 'external' } as never),
    ).rejects.toThrow(InvalidOptionError);
  });
});

describe('createVirtualSandbox', () => {
  it('reports virtual capabilities and a stable id', async () => {
    await withSandbox(sandbox => {
      expect(sandbox.id.length).toBeGreaterThan(0);
      expect(sandbox.capabilities).toEqual({
        ports: false,
        nativeSnapshot: false,
        resume: false,
      });
      expect(sandbox.exposeUrl === undefined).toBe(true);
    });
  });

  it('runs commands and returns exit code, stdout, and stderr', async () => {
    await withSandbox(async sandbox => {
      const ok = await sandbox.exec('echo hello');
      expect(ok.exitCode).toBe(0);
      expect(ok.stdout.trim()).toBe('hello');

      const fail = await sandbox.exec('echo oops >&2; exit 3');
      expect(fail.exitCode).toBe(3);
      expect(fail.stderr.trim()).toBe('oops');
    });
  });

  it('writes and reads text and binary files', async () => {
    await withSandbox(async sandbox => {
      await sandbox.writeFile('notes/hello.txt', 'hi there');
      expect(await sandbox.readTextFile('notes/hello.txt')).toBe('hi there');

      const bytes = new Uint8Array([0, 1, 2, 250, 255]);
      await sandbox.writeFile('assets/blob.bin', bytes);
      expect(await sandbox.readFile('assets/blob.bin')).toEqual(bytes);
    });
  });

  it('returns null for missing files', async () => {
    await withSandbox(async sandbox => {
      expect(await sandbox.readFile('nope.bin')).toBeNull();
      expect(await sandbox.readTextFile('nope.txt')).toBeNull();
    });
  });

  it('removes files and directories', async () => {
    await withSandbox(async sandbox => {
      await sandbox.writeFile('dir/a.txt', 'a');
      await sandbox.remove('dir/a.txt');
      expect(await sandbox.readTextFile('dir/a.txt')).toBeNull();

      await sandbox.writeFile('tree/nested/b.txt', 'b');
      await sandbox.remove('tree');
      expect(await sandbox.readTextFile('tree/nested/b.txt')).toBeNull();

      // removing a missing path is a no-op
      await expect(sandbox.remove('gone')).resolves.toBeUndefined();
    });
  });

  it('exposes lock as an opt-in mutex that serializes by key', async () => {
    await withSandbox(async sandbox => {
      const order: string[] = [];
      const first = sandbox.lock('k', async () => {
        order.push('a-start');
        await new Promise(resolve => setTimeout(resolve, 20));
        order.push('a-end');
      });
      const second = sandbox.lock('k', () => {
        order.push('b-start');
        order.push('b-end');
        return Promise.resolve();
      });
      await Promise.all([first, second]);
      expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end']);
    });
  });

  it('keeps the lock chain alive after a rejection', async () => {
    await withSandbox(async sandbox => {
      await expect(
        sandbox.lock('k', () => Promise.reject(new Error('boom'))),
      ).rejects.toThrow('boom');
      await expect(
        sandbox.lock('k', () => Promise.resolve('recovered')),
      ).resolves.toBe('recovered');
    });
  });
});

describe('agent reuse', () => {
  it('places the workspace where the harness composes the session dir', async () => {
    await withSandbox(async sandbox => {
      const internals = getSandboxInternals(sandbox);
      if (!internals) throw new Error('expected sandbox internals');
      const pwd = await sandbox.exec('pwd');
      // sessionWorkDir = `${defaultWorkingDirectory}/${harnessId}-${sessionId}`
      expect(
        pwd.stdout.trim().endsWith(`/${HARNESS_ID}-${internals.sessionToken}`),
      ).toBe(true);
    });
  });

  it('reuses the session without stopping or destroying it', async () => {
    await withSandbox(async sandbox => {
      const internals = getSandboxInternals(sandbox);
      if (!internals) throw new Error('expected sandbox internals');
      const provider = createReusedSandboxProvider(internals);
      const guarded = await provider.createSession();

      // The guarded session shares the underlying workspace: a write into the
      // handle's workdir is visible through the handle's relative-path API...
      await guarded.writeTextFile({
        path: `${guarded.defaultWorkingDirectory}/pi-${internals.sessionToken}/shared.txt`,
        content: 'from agent',
      });
      // ...and cleanup calls are no-ops, so the caller keeps ownership.
      await guarded.stop();
      await guarded.destroy?.();

      const alive = await sandbox.exec('echo alive');
      expect(alive.exitCode).toBe(0);
      expect(alive.stdout.trim()).toBe('alive');
      expect(await sandbox.readTextFile('shared.txt')).toBe('from agent');
    });
  });

  it('does not expose reuse state for foreign objects', () => {
    expect(getSandboxInternals(undefined)).toBeUndefined();
    expect(getSandboxInternals({ id: 'x' })).toBeUndefined();
    expect(getSandboxInternals('virtual')).toBeUndefined();
  });
});

describe('snapshot and restoreSandbox', () => {
  it('captures workspace files as a serializable snapshot', async () => {
    await withSandbox(async sandbox => {
      await sandbox.writeFile('a.txt', 'alpha');
      await sandbox.writeFile('nested/b.bin', new Uint8Array([1, 2, 3]));

      // Internal agent journal files must never leak into snapshots.
      await sandbox.writeFile('.pi-sessions/journal.jsonl', 'internal');

      const snapshot = await sandbox.snapshot();
      expect(snapshot.version).toBe(1);
      expect(snapshot.files.map(file => file.path)).toEqual([
        'a.txt',
        'nested/b.bin',
      ]);
      // round-trips through JSON without loss
      expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
    });
  });

  it('restores a snapshot into a fresh sandbox', async () => {
    const source = await createVirtualSandbox();
    let snapshot;
    try {
      await source.writeFile('src/index.ts', 'export const x = 1;\n');
      await source.writeFile(
        'data/blob.bin',
        new Uint8Array([9, 8, 7, 0, 255]),
      );
      snapshot = await source.snapshot();
    } finally {
      await source.destroy();
    }

    const restored = await restoreSandbox(snapshot);
    try {
      expect(await restored.readTextFile('src/index.ts')).toBe(
        'export const x = 1;\n',
      );
      expect(await restored.readFile('data/blob.bin')).toEqual(
        new Uint8Array([9, 8, 7, 0, 255]),
      );
    } finally {
      await restored.destroy();
    }
  });

  it('rejects hostile or malformed snapshots before creating anything', async () => {
    const data = Buffer.from('x').toString('base64');
    await expect(
      restoreSandbox({ version: 1, files: [{ path: '../escape.txt', data }] }),
    ).rejects.toThrow(InvalidOptionError);
    await expect(
      restoreSandbox({ version: 1, files: [{ path: '/etc/passwd', data }] }),
    ).rejects.toThrow(InvalidOptionError);
    await expect(
      restoreSandbox({
        version: 1,
        files: [
          { path: 'a.txt', data },
          { path: './a.txt', data },
        ],
      }),
    ).rejects.toThrow(/duplicate path/);
    await expect(
      restoreSandbox({
        version: 1,
        files: [{ path: 'a.txt', data: 'not base64!!' }],
      }),
    ).rejects.toThrow(/invalid base64/);
    await expect(
      restoreSandbox({ version: 2, files: [] } as never),
    ).rejects.toThrow(/version 1/);
  });
});

describe('path containment', () => {
  it('rejects paths that escape the workspace', async () => {
    await withSandbox(async sandbox => {
      await expect(sandbox.readFile('../outside.txt')).rejects.toThrow(
        InvalidOptionError,
      );
      await expect(sandbox.readTextFile('/etc/passwd')).rejects.toThrow(
        InvalidOptionError,
      );
      await expect(sandbox.writeFile('../../evil.sh', 'x')).rejects.toThrow(
        InvalidOptionError,
      );
      await expect(sandbox.remove('..')).rejects.toThrow(InvalidOptionError);
      await expect(sandbox.remove('a/../../b')).rejects.toThrow(
        InvalidOptionError,
      );
    });
  });
});

describe('destroyed lifecycle', () => {
  it('rejects operations on a destroyed handle and stays idempotent', async () => {
    const sandbox = await createVirtualSandbox();
    await sandbox.writeFile('a.txt', 'alpha');

    await Promise.all([sandbox.destroy(), sandbox.destroy()]);
    await sandbox.destroy();

    await expect(sandbox.exec('echo hi')).rejects.toThrow(/destroyed/);
    await expect(sandbox.readFile('a.txt')).rejects.toThrow(/destroyed/);
    await expect(sandbox.writeFile('b.txt', 'x')).rejects.toThrow(/destroyed/);
    await expect(sandbox.snapshot()).rejects.toThrow(/destroyed/);
    await expect(sandbox.lock('k', () => Promise.resolve())).rejects.toThrow(
      /destroyed/,
    );
    expect(getSandboxInternals(sandbox)).toBeUndefined();
  });

  it('fails lock callbacks queued before destroy', async () => {
    const sandbox = await createVirtualSandbox();
    let entered = false;
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    let started!: () => void;
    const firstStarted = new Promise<void>(resolve => (started = resolve));

    const first = sandbox.lock('k', () => {
      started();
      return gate;
    });
    const second = sandbox.lock('k', () => {
      entered = true;
      return Promise.resolve();
    });

    await firstStarted;
    const destroyed = sandbox.destroy();
    release();
    await first;
    await expect(second).rejects.toThrow(/destroyed/);
    expect(entered).toBe(false);
    await destroyed;
  });
});
