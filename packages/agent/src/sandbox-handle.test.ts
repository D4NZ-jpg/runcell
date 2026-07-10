import { describe, expect, it } from 'vitest';
import { HARNESS_ID } from '@local/harness-pi-raw';
import { InvalidOptionError } from './errors.js';
import {
  createReusedSandboxProvider,
  createVirtualSandbox,
  getSandboxInternals,
  restoreSandbox,
  type Sandbox,
} from './sandbox-handle.js';

async function withSandbox(fn: (sandbox: Sandbox) => Promise<void> | void) {
  const sandbox = await createVirtualSandbox();
  try {
    await fn(sandbox);
  } finally {
    await sandbox.destroy();
  }
}

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
