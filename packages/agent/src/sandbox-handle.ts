import { createJustBashSandbox } from '@ai-sdk/sandbox-just-bash';
import type { HarnessV1NetworkSandboxSession } from '@ai-sdk/harness';

/**
 * A live, mutable sandbox resource. Usable directly with no agent: run
 * commands, read/write files, snapshot, and dispose. The same handle can be
 * passed to {@link Agent.run} via the `sandbox` option, in which case the
 * caller owns its lifecycle and runcell never destroys it.
 *
 * Backed by a provider session, so one interface spans the in-memory virtual
 * sandbox, hosted providers, and custom providers. Capabilities that a backend
 * cannot support are reported through {@link Sandbox.capabilities}.
 */
export interface Sandbox {
  /** Stable identifier for the underlying sandbox resource. */
  readonly id: string;
  /** What this backend can do beyond the universal primitives. */
  readonly capabilities: SandboxCapabilities;

  /** Run a shell command and resolve with its result. */
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;

  /** Read a file as raw bytes. Resolves to `null` when it does not exist. */
  readFile(path: string): Promise<Uint8Array | null>;
  /** Read a file as text. Resolves to `null` when it does not exist. */
  readTextFile(path: string): Promise<string | null>;
  /** Write a file, creating parent directories as needed. */
  writeFile(path: string, content: Uint8Array | string): Promise<void>;
  /** Remove a file or directory. No-op when it does not exist. */
  remove(path: string): Promise<void>;

  /**
   * Capture a portable snapshot of the workspace files. This captures files,
   * not running processes. Restore with {@link restoreSandbox}.
   */
  snapshot(): Promise<SandboxSnapshot>;

  /**
   * Resolve a publicly reachable URL for a sandbox-exposed port. Present only
   * when {@link SandboxCapabilities.ports} is `true`.
   */
  exposeUrl?(port: number): Promise<string>;

  /**
   * Run `fn` with exclusive access to `key`, serialized against other `lock`
   * calls for the same key on this handle. An opt-in coordination primitive;
   * runcell never takes this lock on your behalf.
   */
  lock<T>(key: string, fn: () => Promise<T>): Promise<T>;

  /** Dispose the sandbox. Idempotent. */
  destroy(): Promise<void>;
}

/**
 * What a sandbox backend supports beyond the universal primitives. Lets one
 * interface span providers with very different feature sets.
 */
export interface SandboxCapabilities {
  /** Can expose network ports as public URLs. */
  ports: boolean;
  /** Has a native checkpoint that captures processes, not just files. */
  nativeSnapshot: boolean;
  /** Can reattach to a previously created live instance. */
  resume: boolean;
}

export interface ExecOptions {
  /** Working directory for this command. Defaults to the sandbox workspace. */
  cwd?: string;
  /** Extra environment variables, merged over the sandbox defaults. */
  env?: Record<string, string>;
  /** Abort signal that kills the running command. */
  signal?: AbortSignal;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * A portable, serializable snapshot of a sandbox workspace. File bytes are
 * base64-encoded so the whole value round-trips through `JSON.stringify`.
 */
export interface SandboxSnapshot {
  version: 1;
  files: SnapshotFile[];
}

export interface SnapshotFile {
  /** Workspace-relative path. */
  path: string;
  /** Base64-encoded file bytes. */
  data: string;
}

export interface VirtualSandboxOptions {
  /** Environment variables available to every command. */
  env?: Record<string, string>;
}

/**
 * Create an in-memory virtual sandbox. Zero-config and bundled: a bare install
 * runs this with no extra dependencies. Has no ports and no native snapshot,
 * but supports portable file snapshots like every other backend.
 */
export async function createVirtualSandbox(
  options: VirtualSandboxOptions = {},
): Promise<Sandbox> {
  const provider = createJustBashSandbox(
    options.env ? { env: options.env } : {},
  );
  const session = await provider.createSession();
  return new SessionSandbox(session, {
    ports: false,
    nativeSnapshot: false,
    resume: false,
  });
}

/**
 * Rehydrate a {@link SandboxSnapshot} into a fresh virtual sandbox. Writes the
 * snapshot files back into a new workspace; running processes are not restored.
 */
export async function restoreSandbox(
  snapshot: SandboxSnapshot,
  options: VirtualSandboxOptions = {},
): Promise<Sandbox> {
  const sandbox = await createVirtualSandbox(options);
  for (const file of snapshot.files) {
    await sandbox.writeFile(file.path, base64ToBytes(file.data));
  }
  return sandbox;
}

/**
 * Wraps a provider sandbox session as a public {@link Sandbox}. The session
 * interface is implemented by every backend, so the same wrapper serves the
 * virtual sandbox and hosted/custom providers.
 */
class SessionSandbox implements Sandbox {
  readonly id: string;
  readonly capabilities: SandboxCapabilities;

  private readonly session: HarnessV1NetworkSandboxSession;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    session: HarnessV1NetworkSandboxSession,
    capabilities: SandboxCapabilities,
  ) {
    this.session = session;
    this.id = session.id;
    this.capabilities = capabilities;
    if (capabilities.ports) {
      this.exposeUrl = async (port: number) =>
        this.session.getPortUrl({ port });
    }
  }

  exposeUrl?: (port: number) => Promise<string>;

  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    const result = await this.session.run({
      command,
      ...(options.cwd ? { workingDirectory: options.cwd } : {}),
      ...(options.env ? { env: options.env } : {}),
      ...(options.signal ? { abortSignal: options.signal } : {}),
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  async readFile(path: string): Promise<Uint8Array | null> {
    return this.session.readBinaryFile({ path });
  }

  async readTextFile(path: string): Promise<string | null> {
    return this.session.readTextFile({ path });
  }

  async writeFile(path: string, content: Uint8Array | string): Promise<void> {
    if (typeof content === 'string') {
      await this.session.writeTextFile({ path, content });
    } else {
      await this.session.writeBinaryFile({ path, content });
    }
  }

  async remove(path: string): Promise<void> {
    await this.session.run({ command: `rm -rf -- ${shellQuote(path)}` });
  }

  async snapshot(): Promise<SandboxSnapshot> {
    const listing = await this.session.run({
      command: 'find . -type f',
    });
    const paths = listing.stdout
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .map(line => (line.startsWith('./') ? line.slice(2) : line))
      .filter(line => line.length > 0)
      .sort();

    const files: SnapshotFile[] = [];
    for (const path of paths) {
      const bytes = await this.session.readBinaryFile({ path });
      if (bytes != null) {
        files.push({ path, data: bytesToBase64(bytes) });
      }
    }
    return { version: 1, files };
  }

  lock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const result = previous.then(() => fn());
    // Keep the chain alive even if fn rejects, so later lock calls still run.
    this.locks.set(
      key,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  }

  async destroy(): Promise<void> {
    if (this.session.destroy) {
      await this.session.destroy();
    } else {
      await this.session.stop();
    }
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function base64ToBytes(data: string): Uint8Array {
  return new Uint8Array(Buffer.from(data, 'base64'));
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
